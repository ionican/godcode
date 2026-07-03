// mutation-probes — held-out, MEASUREMENT-ONLY discriminating probes for the CODE path (Path A).
//
// The prose analogue is orchestrate.mjs `discriminatingProbes`; this is the same honesty
// discipline made concrete for code candidates. Two fixes can BOTH pass the acceptance gate
// (settled `green`) yet diverge on inputs the suite never pinned — e.g. dedupe-stable vs
// dedupe-sorted both pass `[1,1,2]->[1,2]` but differ on `[3,1,3,1]`. A mutation probe is a
// HELD-OUT input — manufactured cheaply by mutating the acceptance inputs (boundary, off-by-one,
// sign flip, null-a-field, reorder, duplicate) — run over the GREEN survivors to SURFACE that
// divergence as a measurable dispersion label.
//
// HARD INVARIANT (mirrors piece D): a mutation probe is MEASUREMENT-ONLY. It NEVER enters the
// gate, NEVER prunes a green, and NEVER changes the winner / decision / confidence. A green that
// "fails" a held-out probe is still verified-correct — the probe input was never a requirement.
// `runMutationProbes` returns ONLY a dispersion label (no rank, no winner, no pick), so there is
// nothing it CAN feed back into the floor. Letting a probe gate would re-couple the floor to the
// diversity probes and break no-false-green.
//
// The classic OTHER sense of "mutation testing" — mutate the code-under-test to score how strong
// the gate is ("kill the mutant") — is a SEPARATE concern (verify-the-verifier), not this module.

import { dispersion, signatureFromResults } from './dispersion.mjs';

// ---------------------------------------------------------------------------
// Probe generation — deterministic, type-directed input mutation.
//
// No RNG, no Date: same base inputs -> identical probes, every run. Each operator is a pure
// transform of one base value; a mutation that reproduces the original (deep-equal) is dropped
// (it could not discriminate). Probes are descriptors {id, input, op, derivedFrom}; the id is the
// only field `runMutationProbes` inspects (for disjointness + matrix validation). The `input` is
// opaque to the core — the injected runner decides how to feed it to a candidate — so a caller may
// equally supply hand-authored or code-mutation probes with their own descriptors.
// ---------------------------------------------------------------------------

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // 'number' | 'boolean' | 'string' | 'object' | 'undefined' | ...
}

// Canonical structural key for dedup. Object keys sorted (key ORDER is not identity); array order
// preserved (order IS identity — a 'reverse' mutation must not dedup against the original).
function stableKey(v) {
  const t = typeOf(v);
  if (t === 'array') return `[${v.map(stableKey).join(',')}]`;
  if (t === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableKey(v[k])}`).join(',')}}`;
  }
  if (t === 'number') return Number.isNaN(v) ? 'NaN' : `n:${Object.is(v, -0) ? '0' : String(v)}`;
  // TOTAL on unsupported primitives (AR-LOW): JSON.stringify(bigint) THROWS, so tag them deterministically
  // rather than crash. These types produce no mutations (mutateValue returns []), but stableKey still runs
  // on the base to compute its dedup origin key.
  if (t === 'bigint') return `bigint:${v.toString()}`;
  if (t === 'symbol') return `symbol:${String(v)}`;
  if (t === 'function') return `function:${String(v)}`;
  if (t === 'undefined') return 'undefined';
  return `${t}:${JSON.stringify(v)}`;
}

// Return [{op, value}] candidate mutations for one base value. Shallow (one level): scalars are
// perturbed; containers get container-level edits plus one-level field edits. Deep recursion would
// explode the probe count for no extra discriminating power at this layer.
function mutateValue(v) {
  const t = typeOf(v);
  const out = [];
  if (t === 'number') {
    out.push({ op: 'zero', value: 0 });
    out.push({ op: 'negate', value: -v });
    out.push({ op: 'inc', value: v + 1 });
    out.push({ op: 'dec', value: v - 1 });
  } else if (t === 'boolean') {
    out.push({ op: 'flip', value: !v });
  } else if (t === 'string') {
    out.push({ op: 'empty', value: '' });
    out.push({ op: 'double', value: v + v });
    out.push({ op: 'reverse', value: [...v].reverse().join('') });
  } else if (t === 'array') {
    out.push({ op: 'empty', value: [] });
    out.push({ op: 'reverse', value: [...v].reverse() });
    out.push({ op: 'dropFirst', value: v.slice(1) });
    out.push({ op: 'duplicate', value: [...v, ...v] });
  } else if (t === 'object') {
    for (const k of Object.keys(v)) out.push({ op: `null:${k}`, value: { ...v, [k]: null } });
    for (const k of Object.keys(v)) { const c = { ...v }; delete c[k]; out.push({ op: `drop:${k}`, value: c }); }
  }
  // null / undefined / other: no mutation (nothing meaningful to perturb deterministically).
  return out;
}

/**
 * Generate held-out mutation probes from a set of base inputs.
 *
 * @param {Array<{id?:string, input:any}>|any[]} baseInputs  base acceptance inputs to mutate. Each
 *        entry may be {id, input} or a raw value (then indexed by position).
 * @param {object} [opts]
 * @param {string} [opts.prefix='mut']  probe-id namespace.
 * @returns {{id:string, input:any, op:string, derivedFrom:string}[]}  deterministic, deduped.
 */
export function generateMutationProbes(baseInputs, opts = {}) {
  if (!Array.isArray(baseInputs)) throw new Error('generateMutationProbes: baseInputs must be an array');
  const prefix = opts.prefix ?? 'mut';
  const probes = [];
  const idSet = new Set();
  baseInputs.forEach((raw, i) => {
    const hasWrapper = raw && typeof raw === 'object' && !Array.isArray(raw) && 'input' in raw;
    const baseId = hasWrapper && typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id : String(i);
    const input = hasWrapper ? raw.input : raw;
    const origKey = stableKey(input);
    const seenForBase = new Set([origKey]); // drop mutations equal to the original (cannot discriminate)
    for (const m of mutateValue(input)) {
      const key = stableKey(m.value);
      if (seenForBase.has(key)) continue; // also dedup colliding mutations within a base
      seenForBase.add(key);
      let id = `${prefix}:${baseId}:${m.op}`;
      let seq = 1;
      while (idSet.has(id)) { id = `${prefix}:${baseId}:${m.op}#${seq++}`; } // disambiguate id collisions across bases
      idSet.add(id);
      probes.push({ id, input: m.value, op: m.op, derivedFrom: baseId });
    }
  });
  return probes;
}

// ---------------------------------------------------------------------------
// Runner-output validation — guards the injected runner before it touches the dispersion measure.
// ---------------------------------------------------------------------------

/**
 * Validate a mutation-probe runner's output. Requires EXACTLY one row per green id (no missing, no
 * extra/non-green, no duplicate) and every probe id present with a value of EXACTLY 'pass'|'fail'. A
 * violation THROWS (surfaces the runner bug) rather than coercing a missing result into a fake
 * signature. Returns Map<id, perProbe>. Guards ONLY the dispersion LABEL — never admission or pick.
 *
 * @param {{id:string, perProbe:Record<string,'pass'|'fail'>}[]} rows
 * @param {string[]} greenIds
 * @param {string[]} probeIds
 * @returns {Map<string, Record<string,'pass'|'fail'>>}
 */
export function validateMutationRows(rows, greenIds, probeIds) {
  if (!Array.isArray(rows)) throw new Error('mutationProbes: runner must return an array of {id, perProbe} rows');
  const expected = new Set(greenIds);
  const byId = new Map();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !expected.has(row.id)) {
      throw new Error(`mutationProbes: runner returned a row for an unexpected / non-green id ${JSON.stringify(row && row.id)}`);
    }
    if (byId.has(row.id)) throw new Error(`mutationProbes: runner returned a DUPLICATE row for id ${JSON.stringify(row.id)}`);
    const pp = (row.perProbe && typeof row.perProbe === 'object') ? row.perProbe : {};
    // OWN props only (AR-MED): an INHERITED verdict (a polluted prototype) must not be read as a real result
    // — that could manufacture a complete fake signature with no own data. Copy validated verdicts into a
    // null-prototype object so nothing downstream can pick up an inherited value either.
    const clean = Object.create(null);
    for (const pid of probeIds) {
      if (!Object.hasOwn(pp, pid) || (pp[pid] !== 'pass' && pp[pid] !== 'fail')) {
        throw new Error(`mutationProbes: runner row ${JSON.stringify(row.id)} has an invalid/missing result for probe ${JSON.stringify(pid)} (must be 'pass'|'fail', got ${JSON.stringify(pp[pid])})`);
      }
      clean[pid] = pp[pid];
    }
    byId.set(row.id, clean);
  }
  if (byId.size !== expected.size) {
    throw new Error(`mutationProbes: runner returned ${byId.size} row(s) for ${expected.size} green candidate(s) — exactly one row per green id is required`);
  }
  return byId;
}

// ---------------------------------------------------------------------------
// Measurement-only run.
// ---------------------------------------------------------------------------

/**
 * Run held-out mutation probes over the GREEN survivors, MEASUREMENT-ONLY, and return a dispersion
 * label. This function has no rank, no winner, no decision in its return — by construction it cannot
 * feed the floor.
 *
 * Structural setup errors (probes not an array, empty/non-string/duplicate probe id, a probe id that
 * collides with an acceptance/gate id) THROW — they are caller bugs that must be fixed, not silently
 * downgraded. A merely ABSENT capability (no probes, no runner, <2 greens) degrades gracefully to an
 * `unmeasurable` label with a reason.
 *
 * @param {object} o
 * @param {{id:string}[]} o.greens          admitted green survivors (never re-filtered here).
 * @param {{id:string}[]} o.probes          held-out probe descriptors (id used for validation; rest opaque).
 * @param {(greens, probes)=>Promise<any[]>|any[]} o.runner  executes each green against each probe
 *        and returns [{id, perProbe:{probeId:'pass'|'fail'}}] — the environment-specific seam.
 * @param {string[]} [o.acceptanceIds=[]]   ids that ARE part of the executed acceptance run (gate test
 *        names + in-suite probe names); probes must be disjoint from these to be provably HELD-OUT.
 * @param {number} [o.targetK=3]
 * @returns {Promise<{
 *   measurable:boolean,
 *   dispersionState:'unmeasurable'|'converged'|'diverse',
 *   reason:'no-green'|'single-green'|'no-probes'|'no-runner'|null,
 *   dispersion:object|null,
 *   perGreen:{id:string, signature:boolean[]}[]|null
 * }>}
 */
export async function runMutationProbes(o = {}) {
  const greens = Array.isArray(o.greens) ? o.greens : [];
  const probes = o.probes;
  const runner = o.runner;
  const acceptanceIds = Array.isArray(o.acceptanceIds) ? o.acceptanceIds : [];
  const targetK = o.targetK ?? 3;

  // 1) Validate the probe SET first — a structural error is a caller bug regardless of green count.
  if (!Array.isArray(probes)) throw new Error('mutationProbes: probes must be an array of {id} descriptors');
  const acc = new Set(acceptanceIds);
  const seen = new Set();
  for (const p of probes) {
    if (!p || typeof p.id !== 'string' || p.id.trim() === '') throw new Error('mutationProbes: every probe needs a non-empty string id');
    if (seen.has(p.id)) throw new Error(`mutationProbes: duplicate probe id ${JSON.stringify(p.id)}`);
    if (acc.has(p.id)) throw new Error(`mutationProbes: probe id ${JSON.stringify(p.id)} collides with an acceptance/gate id — mutation probes must be HELD-OUT (measurement-only), never a gate check.`);
    seen.add(p.id);
  }
  const probeIds = probes.map((p) => p.id);
  const greenIds = greens.map((g) => g.id);

  // 2) Graceful degrade — capability simply absent (NOT a bug). Order: greens, probes, runner.
  const unmeasurable = (reason) => ({ measurable: false, dispersionState: 'unmeasurable', reason, dispersion: null, perGreen: null });
  if (greenIds.length === 0) return unmeasurable('no-green');
  if (greenIds.length < 2) return unmeasurable('single-green'); // one survivor: nothing to disperse over
  if (probes.length === 0) return unmeasurable('no-probes');
  if (typeof runner !== 'function') return unmeasurable('no-runner');

  // 3) Measure. The runner output is untrusted -> validate before it can shape the label. Build perGreen
  // from the green ids captured BEFORE the runner ran — never re-read greens[i].id, which a runner that
  // mutates its input could have corrupted (AR-HIGH).
  const rows = await runner(greens, probes);
  const byId = validateMutationRows(rows, greenIds, probeIds);
  const perGreen = greenIds.map((id) => ({ id, signature: signatureFromResults(byId.get(id), probeIds) }));
  const disp = dispersion(perGreen, { targetK });
  // CONVERGED = probes ran but greens are identical ON THEM (no measured diversity on the supplied
  // probes — NOT broad equivalence). DIVERSE = at least one probe column splits the greens.
  return {
    measurable: true,
    dispersionState: disp.discriminating ? 'diverse' : 'converged',
    reason: null,
    dispersion: disp,
    perGreen,
  };
}
