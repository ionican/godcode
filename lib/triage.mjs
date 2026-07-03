// triage — the v1 gate->fan-out ESCALATION policy: "when is paying N x worth it?"
//
// The benchmark's hard-won finding (benchmark/README.md): you CANNOT know a bug's reliability
// regime from its spec — regime is a property of the bug, not the prose, and only ~2/9 items
// land in the informative band where fan-out converts. The corollary: you have to SAMPLE the
// regime. triage does exactly that — a SEQUENTIAL draw-and-gate allocator that infers pSingle
// on the fly (Wilson interval over decisive draws) and spends the expensive N x ONLY where it
// converts. With a gate in the loop a failed draw is KNOWN-wrong (pruned), so sequential-draw-
// until-green + gate is cost-optimal (expected 1/p draws, ~100% verified for any p>0) and
// strictly beats both single-shot (no gate -> ships wrong at rate 1-p) and fixed fan-out-N
// (always spends N). triage adds the two early-stops a fixed-N fan-out can't:
//
//   too-easy   first draw greens          -> decision 'gate-only'  costX=1   (N x NOT paid; == v0)
//   informative greens after retries      -> decision 'fanned-out' costX=n   (N x paid; converted)
//   too-hard   confidently pSingle ~ 0     -> decision 'declined'   early     (N x NOT thrown good-
//                                                                              after-bad; never false-greens)
//
// The Wilson band defaults (0.2 / 0.8) ARE the informative-band edges the ablation measured.
// Calling 'too-hard' needs ~16 consecutive fails at the default threshold — this deliberately
// ENCODES the benchmark lesson that the fleet's "0/6 => too-hard" was wrong (a verifier-coupling
// artifact): a cheap too-hard verdict is how the artifact fooled the fleet, so triage refuses to
// declare it cheaply (tune hardThreshold up for a cheaper, less-confident decline).
//
// gateRunner / runWaves style: the model is an INJECTED seam (drawAndGate), so the loop logic is
// unit-tested with fakes; the real Opus-author + gate fan-out is supplied by the Workflow/Skill
// layer. Diversity/dispersion confidence (K behaviourally-distinct greens) is a SEPARATE axis —
// that is runWaves; triage is the CORRECTNESS+COST front-end. Set targetGreens>1 to make triage
// collect a cohort for fanoutSelect instead of stopping at the first green.

/**
 * Wilson score interval for a binomial proportion. Zero-dep, no special functions, and
 * well-behaved at the boundaries (g=0 and g=n) where the normal approximation degenerates.
 * @returns {{point:number, lo:number, hi:number}}
 */
export function wilsonInterval(greens, draws, z = 1.96) {
  if (draws <= 0) return { point: 0, lo: 0, hi: 1 };
  const n = draws;
  const phat = greens / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  return { point: phat, lo: Math.max(0, center - margin), hi: Math.min(1, center + margin) };
}

/**
 * Classify the reliability regime from decisive draws (greens + prunes), using the Wilson interval.
 * A regime is only named when the interval is CONFIDENTLY in it; otherwise 'uncertain' (the honest
 * early-draws state — too few samples to commit). incomplete draws must be excluded by the caller.
 *
 * @returns {{regime:'too-easy'|'too-hard'|'informative'|'uncertain', p:{point,lo,hi,greens,draws}}}
 */
export function classifyRegime(greens, decisiveDraws, opts = {}) {
  const { easyThreshold = 0.8, hardThreshold = 0.2, z = 1.96 } = opts;
  const w = wilsonInterval(greens, decisiveDraws, z);
  const p = { point: w.point, lo: w.lo, hi: w.hi, greens, draws: decisiveDraws };
  let regime;
  if (decisiveDraws === 0) regime = 'uncertain';
  else if (w.hi <= hardThreshold) regime = 'too-hard';      // confidently low pSingle -> fan-out futile
  else if (w.lo >= easyThreshold) regime = 'too-easy';      // confidently high pSingle -> fan-out wasted
  else if (w.lo > hardThreshold && w.hi < easyThreshold) regime = 'informative'; // confidently mid-band
  else regime = 'uncertain';                                // interval straddles a boundary
  return { regime, p };
}

/**
 * Sequentially draw + gate candidates, allocating the expensive N x only where it converts.
 *
 * @param {object} opts
 * @param {(drawId:string, ctx:{draw:number, greens:string[], regime:string}) => Promise<object>} opts.drawAndGate
 *        INJECTED seam: author one candidate and gate it out-of-band. Returns a GateResult-shaped
 *        object — at minimum { gate:'green'|'pruned'|'incomplete', candidateId }. (Real = an Opus
 *        author writes into a fresh worktree, then gateRunner gates it; fake in tests.)
 * @param {number} [opts.maxDraws=16]       hard ceiling on total draws (incl. incompletes). Default
 *                                          16 = the draws needed to confidently call too-hard at the
 *                                          default threshold; raise for more headroom, lower to cap cost.
 * @param {number} [opts.targetGreens=1]    stop once this many GREEN candidates are collected. >1 to
 *                                          gather a cohort for fanoutSelect/dispersion (diversity axis).
 * @param {number} [opts.easyThreshold=0.8] Wilson lo >= this -> confidently too-easy (diagnostic).
 * @param {number} [opts.hardThreshold=0.2] Wilson hi <= this -> confidently too-hard -> DECLINE early.
 * @param {number} [opts.z=1.96]            Wilson z (1.96 = 95%).
 * @param {(draw:number, r:object, state:object) => void} [opts.onDraw]  progress callback.
 * @returns {Promise<object>} TriageResult — see fields assembled at return.
 */
export async function triage(opts) {
  const {
    drawAndGate,
    maxDraws = 16,
    targetGreens = 1,
    easyThreshold = 0.8,
    hardThreshold = 0.2,
    z = 1.96,
    onDraw,
  } = opts;
  if (typeof drawAndGate !== 'function') throw new TypeError('triage: drawAndGate must be a function');

  const greens = [];           // candidateIds that gated GREEN
  let prunes = 0;              // decisive non-green (gate KNOWS it wrong)
  let incompletes = 0;        // flaky / hang / no-acceptance — NO evidence, excluded from pSingle
  const history = [];
  let regime = 'uncertain';
  let p = { point: 0, lo: 0, hi: 1, greens: 0, draws: 0 };
  let stoppedBecause = 'budget';

  for (let draw = 1; draw <= maxDraws; draw++) {
    let r;
    try {
      r = await drawAndGate(`triage-draw-${draw}`, { draw, greens: [...greens], regime });
    } catch (err) {
      // a thrown/rejected draw is isolated as evidence-free (consistent with the lib's cohort-crash
      // hardening) — it must not abort the run or move the posterior, so accumulated greens survive.
      r = { gate: 'incomplete', candidateId: `triage-draw-${draw}`, error: String((err && err.message) || err) };
    }
    const gate = r && r.gate;
    const rawId = r && r.candidateId;
    const validId = typeof rawId === 'string' && rawId.length > 0;  // a GREEN must carry a resolvable candidate id
    const id = validId ? rawId : `triage-draw-${draw}`;
    if (gate === 'green' && validId) {
      if (!greens.includes(id)) greens.push(id);             // DISTINCT cohort: duplicate ids (retry/cache) must
                                                             // not inflate targetGreens / dispersion
    } else if (gate === 'pruned') {
      prunes += 1;                                           // ONLY a clean 'pruned' is decisive evidence-of-wrong
    } else {
      incompletes += 1;                                      // 'incomplete', a malformed/unknown/missing verdict, OR a
                                                             // 'green' with no resolvable id = NO evidence (a degraded
                                                             // gate must never read as too-hard or ship a phantom)
    }

    const decisive = greens.length + prunes;
    ({ regime, p } = classifyRegime(greens.length, decisive, { easyThreshold, hardThreshold, z }));
    const state = { draws: draw, greens: [...greens], prunes, incompletes, regime, p: { ...p } };
    history.push({ drawId: id, gate: gate || 'incomplete', regime, p });
    // onDraw is FIRE-AND-FORGET observability: isolate a sync throw (try/catch) AND swallow any async rejection
    // (.catch on the returned thenable) WITHOUT awaiting — a slow/never-settling telemetry hook must not abort,
    // corrupt, OR wedge the policy. State is copied above so a mutating hook can't touch the live posterior/cohort.
    if (onDraw) {
      try {
        const ret = onDraw(draw, r, state);
        if (ret && typeof ret.then === 'function') ret.catch(() => {});  // isolate async rejection, do NOT await
      } catch { /* sync throw isolated */ }
    }

    if (greens.length >= targetGreens) { stoppedBecause = 'got-greens'; break; }
    if (regime === 'too-hard') { stoppedBecause = 'too-hard'; break; }
    // 'too-easy' / 'informative' / 'uncertain' with no green yet -> keep drawing within budget
  }

  const draws = history.length;
  const shipped = greens.length > 0 ? greens[0] : null;
  const targetGreensMet = greens.length >= targetGreens;     // did we collect the requested green cohort?
  // decision encodes "was paying N x worth it?" — readable straight off the regime outcome.
  let decision;
  if (!shipped) decision = 'declined';                        // no green: honest decline, never ships
  else if (!targetGreensMet) decision = 'fanned-out-partial'; // a verified green ships, but the run stopped
                                                              // (budget/too-hard) before the targetGreens cohort —
                                                              // checked BEFORE gate-only so an unmet cohort at
                                                              // maxDraws=1 can't masquerade as the v0 path
  else if (draws === 1) decision = 'gate-only';              // too-easy: first (and only needed) draw greened, N x NOT paid
  else decision = 'fanned-out';                              // informative/retry: N x paid, requested cohort met

  return {
    decision,                  // 'gate-only' | 'fanned-out' | 'fanned-out-partial' | 'declined'
    shipped,                   // candidateId of the first GREEN, or null (null IFF decision==='declined')
    greens: [...greens],       // all GREEN candidateIds (>=1 when targetGreens>1 and reached)
    targetGreens,              // the requested green-cohort size
    targetGreensMet,           // greens.length >= targetGreens — false on a 'fanned-out-partial'
    regime,                    // reliability regime inferred at stop
    p,                         // Wilson posterior over decisive draws at stop {point,lo,hi,greens,draws}
    draws,                     // total draws spent (incl. incompletes)
    costX: draws,              // realized N x vs a naive fixed fan-out-N
    incompletes,               // draws that produced no evidence (excluded from p)
    stoppedBecause,            // 'got-greens' | 'too-hard' | 'budget'
    escalateForDispersion: greens.length >= 2,  // hint: hand greens[] to fanoutSelect for the diversity pick
    history,                   // [{drawId, gate, regime, p}] — the sampling trace
  };
}
