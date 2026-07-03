// runner — the multi-wave keep-exploring loop ABOVE authorLoop (the "caller" the lib design
// deferred to). Made deterministic by INJECTING the author factory: the loop logic lives here
// (testable with fakes), the real Opus-author fan-out is the injected seam (the Workflow/Skill
// layer supplies it). This is what turns the primitives into a runnable harness.
//
// Each wave:
//   1. authorFactory({wave, forbidApproachTags, realizedIds}) -> fresh authors (real agents / fakes).
//   2. Re-gate the ACCUMULATED cohort via authorLoop: prior wave survivors are replayed as fixed
//      authors (re-gating is token-free — gates are OS processes — so v1 re-gates the full pool;
//      a per-id GateResult cache is a v2 latency optimization), plus this wave's fresh authors.
//   3. Thread exploreSignal.forbidApproachTags into the next wave's reserved slot (all-green-forbid).
//   4. Stop or continue on exploreSignal.reason:
//        'sufficient-dispersion'     -> STOP (earned: >=K behaviourally-distinct greens).
//        'non-discriminating-probes' -> STOP (probes can't measure diversity; more waves can't help —
//                                       the honest outcome on an acceptance-only suite).
//        'keep-exploring'            -> CONTINUE while budget (greens exist, < K distinct behaviours).
//        'no-green'                  -> CONTINUE while budget (nothing correct yet; author harder).
//
// Budget is deterministic (maxWaves) plus an optional injected shouldContinue (token/cost lives
// with the caller, never in this lib). Anti-dive layer 2 (keep-exploring) is realized HERE;
// layer 1 (always-run-all-N, no early-exit on first green) is guaranteed by authorLoop beneath.

import { authorLoop } from './author-loop.mjs';

function waveSummary(wave, ship) {
  const d = ship.dispersion || {};
  const es = ship.exploreSignal || {};
  const m = es.metrics || {};
  return {
    wave,
    decision: ship.decision,
    confidence: ship.confidence,
    nAuthors: ship.nAuthors,        // candidates GATED this wave (replay greens-only + fresh) — for the dossier
    nGreen: ship.greens.length,
    distinctCount: d.distinctCount,
    effectiveN: d.effectiveN,
    sufficient: d.sufficient,
    discriminating: d.discriminating,
    reason: es.reason,
    mutationMeasured: !!es.mutationMeasured,
    // The DRIVING saturation metrics (held-out probes when measurable, else in-suite) — for the dossier.
    // chao1/completeness are diagnostic-only and NEVER gate (the stop rule reads coverage/f1, not these).
    coverage: m.coverage,
    f1: m.f1,
    chao1: m.chao1,
    completeness: m.completeness,
    forbidApproachTags: es.forbidApproachTags,
    winner: ship.winner ? ship.winner.id : null,
  };
}

/**
 * Drive author waves until an earned stop, an unmeasurable suite, or budget exhaustion.
 *
 * @param {object} opts  — everything authorLoop takes (repoDir, baseRef, task, oracleFiles,
 *                          probeNames, gate, targetK, concurrency, rankKey) EXCEPT `authors`, PLUS:
 * @param {(ctx:{wave:number, forbidApproachTags:string[], realizedIds:string[]}) => Promise<Array>} opts.authorFactory
 *        produces this wave's fresh authors (the injected model seam). Mark exactly one isBaseline in wave 1.
 * @param {number} [opts.maxWaves=4]
 * @param {(ctx:{wave:number, waves:object[]}) => boolean} [opts.shouldContinue]  optional budget guard (token/cost)
 * @param {(wave:number, ship:object) => void} [opts.onWave]  progress callback
 * @returns {Promise<object>} { ...finalShipContract, waves, nWaves, stoppedBecause }
 */
export async function runWaves(opts) {
  const { authorFactory, maxWaves = 4, shouldContinue, onWave, seedSpecs = [], reviewCap, ...base } = opts;
  // HARD reviewable-slate cap (the practitioner guardrail): stop once the accumulated GREEN slate is big
  // enough to review, REGARDLESS of dispersion — so the loop can never run up un-reviewable cost chasing
  // diversity. OPT-IN: default = no slate cap (Infinity), because `maxWaves` already bounds default cost
  // and the CALLER (the skill) is what knows the reviewable-slate size, so it sets reviewCap explicitly.
  // Injected as a CONSTANT, never derived from the dispersion measure. NOTE: deliberately NOT defaulted to
  // targetK — that conflates slate-size with the distinct-behaviour target and would kill a legitimately
  // long keep-exploring run; earned `sufficient` is reported before the cap below.
  const cap = reviewCap ?? Infinity;
  // The cap, when set, must be a real count — a garbage cap (negative / fractional / NaN) would silently
  // mis-bound the slate (AR-HIGH).
  if (cap !== Infinity && !(Number.isInteger(cap) && cap >= 0)) {
    throw new Error(`runWaves: reviewCap must be a non-negative integer or Infinity, got ${reviewCap}`);
  }
  const realized = new Map();   // id -> { files, approachTag }  accumulated across waves
  const prevSigKeys = new Set(); // union of behavioural signature keys seen in ALL prior waves (plateau detector)
  let priorGreens = 0;          // cumulative reviewable-slate size BEFORE this wave (for the draw budget)
  let priorGreenIds = new Set(); // ids of the prior wave's GREEN survivors — ONLY these are replayed
  let droppedToCap = 0;         // fresh authors truncated to keep the slate within reviewCap (surfaced, not silent)
  const waves = [];
  let forbidApproachTags = [];
  let baselineId = null;        // pinned after wave 1 to keep the floor stable across waves
  let ship = null;
  let stoppedBecause = 'max-waves';

  for (let wave = 1; wave <= maxWaves; wave++) {
    if (wave > 1 && shouldContinue && !shouldContinue({ wave, waves })) { stoppedBecause = 'budget'; break; }

    // seedSpecs (the proactive sideways-look seed) is a WAVE-1-only inject-variation-up-front request,
    // passed VERBATIM to the injected factory (the lib never inspects it). Waves 2+ steer reactively via
    // forbidApproachTags instead. The descriptor is opaque here — the hint lives in the skill-layer closure.
    // The remaining DRAW BUDGET — passed so a cooperating factory caps its own fresh-author count. Infinity
    // when no cap is set.
    const reviewRemaining = cap === Infinity ? Infinity : Math.max(0, cap - priorGreens);
    const fresh = await authorFactory({ wave, forbidApproachTags, realizedIds: [...realized.keys()], seedSpecs: wave === 1 ? seedSpecs : [], reviewRemaining });
    let freshList = Array.isArray(fresh) ? fresh : [];
    // ENFORCE the budget IN THE LIB (AR-HIGH confirm): a non-cooperating factory that returns more than
    // reviewRemaining fresh authors is TRUNCATED here, so a single wave can never push the accumulated slate
    // past reviewCap — the cap holds regardless of factory cooperation. The baseline is kept (sorted first)
    // so truncation never drops the simplest-correct floor. Dropped authors are surfaced (no silent cap).
    if (reviewRemaining !== Infinity && freshList.length > reviewRemaining) {
      const ordered = [...freshList].sort((a, b) => (b.isBaseline ? 1 : 0) - (a.isBaseline ? 1 : 0));
      droppedToCap += freshList.length - reviewRemaining;
      freshList = ordered.slice(0, reviewRemaining);
    }
    const freshIds = new Set(freshList.map((a) => a.id));
    // Cross-wave id UNIQUENESS: a fresh author must not reuse a prior wave's id. The factory is given
    // realizedIds precisely to avoid this; a collision would suppress that id's greens-only replay (via
    // freshIds) and let a fresh patch IMPERSONATE a prior candidate — e.g. resurrect a FAILED baseline as a
    // green and clear the `baseline-not-green` floor signal (AR-HIGH). Reject loudly.
    for (const id of freshIds) {
      if (realized.has(id)) {
        throw new Error(`runWaves: fresh author id ${JSON.stringify(id)} reuses a prior wave's id — author ids must be unique across waves`);
      }
    }

    // Capture each fresh author's realized patch (for accumulation + replay in later waves).
    const wrapped = freshList.map((a) => ({
      ...a,
      fn: async (ctx) => {
        const out = await a.fn(ctx);
        if (out && out.files) realized.set(a.id, { files: out.files, approachTag: out.approachTag });
        return out;
      },
    }));
    // Replay prior GREEN survivors ONLY as deterministic fixed authors (keep the baseline flag on the pinned
    // id). Replaying prior NON-greens would (a) waste gate work re-confirming known failures and (b) let a
    // prior INCOMPLETE/flaky patch flip GREEN on re-gate and push the slate past reviewCap, which the
    // greens-only budget didn't count (AR-HIGH confirm). `realized` still tracks every authored id (for
    // realizedIds / no-re-author), but only greens re-enter the gated cohort.
    const replay = [...realized.entries()]
      .filter(([id]) => !freshIds.has(id) && priorGreenIds.has(id))
      .map(([id, patch]) => ({
        id,
        isBaseline: id === baselineId,
        fn: async () => ({ files: patch.files, approachTag: patch.approachTag }),
      }));

    const authors = [...replay, ...wrapped];
    if (authors.length === 0) { stoppedBecause = 'no-authors'; break; }

    // Thread the prior-wave signature-key union (for plateau) AND the pinned baselineId (so a baseline that
    // failed in an earlier wave stays pinned and keeps producing baseline-not-green, even though its
    // non-green patch is no longer replayed into the cohort — AR-HIGH). null on wave 1 ⇒ authorLoop computes it.
    ship = await authorLoop({ ...base, authors, prevSignatureKeys: prevSigKeys, baselineId });
    // Defensive backstop for the reviewable-slate cap: by construction (greens-only replay + truncated
    // fresh) the slate can't exceed reviewCap; if it ever does, that's an internal invariant violation —
    // fail loud rather than silently hand back an over-cap slate.
    if (cap !== Infinity && ship.greens.length > cap) {
      throw new Error(`runWaves: internal invariant violated — slate ${ship.greens.length} exceeds reviewCap ${cap}`);
    }
    if (baselineId === null) baselineId = ship.baselineId;
    forbidApproachTags = ship.exploreSignal.forbidApproachTags;
    waves.push(waveSummary(wave, ship));
    if (onWave) onWave(wave, ship);

    const reason = ship.exploreSignal.reason;
    // EARNED success is reported first — if we've reached the ≥K-distinct floor we stop as 'sufficient'
    // even if we're also at the review cap (more informative, and cost is bounded either way).
    if (reason === 'sufficient-dispersion' || reason === 'sufficient-floor') { stoppedBecause = 'sufficient'; break; }
    // Then the HARD cap — dominates the remaining (advisory) stop signals so a non-sufficient cohort can
    // never run up un-reviewable cost.
    if (ship.greens.length >= cap) { stoppedBecause = 'review-cap'; break; }
    if (reason === 'non-discriminating-probes') { stoppedBecause = 'non-discriminating'; break; }
    if (reason === 'plateau-no-new-signature') { stoppedBecause = 'plateau'; break; }
    if (reason === 'coverage-saturated') { stoppedBecause = 'coverage-saturated'; break; }
    // 'keep-exploring' / 'no-green' -> continue to the next wave (bounded by maxWaves / shouldContinue)

    // Accumulate THIS wave's signatures into the plateau baseline, and the slate size into the draw budget,
    // for the next wave.
    for (const k of (ship.exploreSignal.classKeys || [])) prevSigKeys.add(k);
    priorGreens = ship.greens.length;
    priorGreenIds = new Set(ship.greens.map((g) => g.id));
  }

  return { ...(ship || {}), waves, nWaves: waves.length, stoppedBecause, droppedToCap };
}
