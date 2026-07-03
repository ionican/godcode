// author-loop — the v1-lite /godcode UPSTREAM stage above fanoutSelect.
//
// The thin author wave: fan an INJECTED list of oracle-blind author functions out over
// one shared task context, collect their candidate patches, and hand the cohort to the
// EXISTING fanoutSelect unchanged. This module adds NO gating, NO ranking, NO scoring —
// fanoutSelect (and the gate-runner beneath it) own correctness. The author loop's only
// jobs are the three the gate+select core cannot do for itself:
//
//   1. ANTI-DIVE (layer 1, STRUCTURAL): always run ALL N UNIQUE-id authors. A green appearing
//      early can never short-circuit the cohort — fanoutSelect only ever sees the full set, so it
//      cannot "dive" onto the first correct solution. (Duplicate-id authors are a config error and
//      are rejected without invoking their fn. Layer 2, keep-exploring across waves, is the
//      CALLER's, driven by the surfaced exploreSignal — kept out of this deterministic, unit-
//      testable lib, which spawns no model.)
//   2. ORACLE-BLINDNESS (a BOUNDARY guarantee, not an absolute): authorLoop passes authors ONLY a
//      fixed allowlist context — {repoDir, baseRef, task, authorId, forbidApproachOf} — and routes
//      the verifier (oracleFiles / verify / probeNames) ONLY into the gate path. The lib controls
//      what it PASSES; full blindness additionally requires the CALLER to honour three preconditions
//      the lib cannot enforce: (a) authors run as SEPARATE agents (production) so they cannot close
//      over caller state — an in-process fn can always capture its lexical scope; (b) the repo at
//      baseRef does NOT contain the verifier on disk (SWE-bench shape: tests absent at base, supplied
//      via oracleFiles) — otherwise an author handed repoDir can just read the tracked test files;
//      (c) the caller does not embed the verifier in `task` (the one field authors are MEANT to see).
//      The false-green BACKSTOP (job 3) holds regardless of blindness — even a verifier-aware author
//      cannot grade itself.
//   3. FALSE-GREEN BACKSTOP: forward gate.protectedPaths = caller's set UNION keys(oracleFiles),
//      so a candidate that writes a verifier path is PRUNED for touching a protected path and
//      cannot replace the harness oracle with a trivially-passing test to self-certify GREEN.
//      (gate-runner canonicalizes paths, so `test/./x` cannot dodge the match.)
//
// The real agent fan-out lives in the Workflow/Skill layer that supplies the authorFns; tests
// inject deterministic fakes. Candidate generation is the only model seam, and it is injected.

import { fanoutSelect } from './fanout-select.mjs';
import { stopDecision } from './stopRule.mjs';

async function boundedPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

// Race an author's promise against an optional wall-clock guard. A timeout rejects with a
// marked error so it is recorded as reason 'timeout', distinct from a thrown error.
function withTimeout(promise, ms) {
  if (!ms) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const e = new Error('author timeout');
      e.isTimeout = true;
      reject(e);
    }, ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

const uniq = (xs) => [...new Set(xs)];

// Deterministic baseline: the designated isBaseline author IF it produced a candidate,
// else the first author (in declaration order) that produced one, else the first author id.
function pickBaseline(authors, authoredIds) {
  const designated = authors.find((a) => a.isBaseline && authoredIds.has(a.id));
  if (designated) return designated.id;
  const firstAuthored = authors.find((a) => authoredIds.has(a.id));
  return firstAuthored ? firstAuthored.id : (authors[0] ? authors[0].id : undefined);
}

/**
 * Run one author wave -> fanoutSelect -> ShipContract + authoring envelope + stop signal.
 *
 * @param {object} opts
 * @param {string} opts.repoDir
 * @param {string} [opts.baseRef='HEAD']               given to authors AND injected into gate.baseRef
 * @param {{id:string, spec:string}} opts.task         ORACLE-BLIND task surface authors see (no verifier!)
 * @param {Array<{id:string, fn:Function, isBaseline?:boolean, forbidApproachOf?:string[]}>} opts.authors
 *        each fn: async ({repoDir, baseRef, task, authorId, forbidApproachOf}) =>
 *                 { files: Record<string,string>, approachTag?: string, note?: string }
 * @param {Record<string,string>} [opts.oracleFiles={}] verifier; forwarded ONLY into gate.oracleFiles
 * @param {string[]} opts.probeNames                    G1 probe names (fanoutSelect passthrough; never on author ctx)
 * @param {object} [opts.gate={}]                       gate-runner opts; oracleFiles/baseRef/protectedPaths are OVERRIDDEN
 * @param {number} [opts.targetK=3]
 * @param {number} [opts.concurrency=4]                 author pool width AND fanoutSelect gate pool (v1 conflation)
 * @param {Function} [opts.rankKey]                     fanoutSelect passthrough (receives the RAW gate result)
 * @param {number} [opts.authorTimeoutMs]              optional per-author wall-clock guard
 * @returns {Promise<object>} AuthorLoopResult = {...ShipContract, authored, authorErrors, baselineId, nAuthors, nAuthored, exploreSignal}
 */
export async function authorLoop(opts) {
  const {
    repoDir,
    baseRef = 'HEAD',
    task,
    authors,
    oracleFiles = {},
    probeNames,
    gate = {},
    targetK = 3,
    concurrency = 4,
    rankKey,
    authorTimeoutMs,
    // Held-out mutation probes (piece D, code path) — the diversity signal that drives keep-exploring.
    // Passed THROUGH to fanoutSelect (measurement-only there); read back here to drive the stop reason.
    mutationProbes,
    runProbes,
    // Keep-exploring loop state, threaded by the caller (runWaves): the union of signature keys seen in
    // all PRIOR waves (for plateau detection) and the coverage-deficit epsilon.
    prevSignatureKeys,
    coverageEpsilon,
    // PINNED baseline id from the caller (runWaves). When set, it OVERRIDES the per-wave pickBaseline so a
    // baseline that FAILED its gate in an earlier wave stays the baseline (⇒ fanoutSelect keeps reporting
    // `baseline-not-green` ⇒ human-gate) instead of being silently re-baselined to a later green. null ⇒
    // compute the baseline from this wave's authors (wave-1 behaviour, unchanged).
    baselineId: pinnedBaselineId,
  } = opts;

  // FALSE-GREEN BACKSTOP: the verifier paths are immutable to candidates.
  const protectedUnion = uniq([...(gate.protectedPaths || []), ...Object.keys(oracleFiles)]);

  // 1) Fan ALL authors out over the ORACLE-BLIND allowlist context. No early exit on green.
  const seenIds = new Set();
  const settled = await boundedPool(authors, concurrency, async (a) => {
    if (seenIds.has(a.id)) return { err: { id: a.id, reason: 'duplicate-id' } };
    seenIds.add(a.id);
    const ctx = { repoDir, baseRef, task, authorId: a.id, forbidApproachOf: (a.forbidApproachOf || []).slice() };
    try {
      const out = await withTimeout(a.fn(ctx), authorTimeoutMs);
      if (!out || !out.files || typeof out.files !== 'object') return { err: { id: a.id, reason: 'empty' } };
      // SNAPSHOT + VALIDATE author output: read each value ONCE into a plain object (defeats a
      // stateful/getter files object showing the gate something other than what was vetted), and
      // reject non-string contents as 'invalid-files' rather than letting gateRunner's writeFile
      // throw and crash the whole cohort (Codex AR #6/#9).
      const files = {};
      for (const k of Object.keys(out.files)) {
        const v = out.files[k];
        if (typeof v !== 'string') return { err: { id: a.id, reason: 'invalid-files' } };
        files[k] = v;
      }
      if (Object.keys(files).length === 0) return { err: { id: a.id, reason: 'empty' } };
      return { cand: { id: a.id, files }, approachTag: typeof out.approachTag === 'string' ? out.approachTag : null };
    } catch (e) {
      return { err: { id: a.id, reason: e && e.isTimeout ? 'timeout' : 'threw', message: e ? String(e.message || e) : undefined } };
    }
  });

  const authored = settled.filter((r) => r.cand);
  const authorErrors = settled.filter((r) => r.err).map((r) => r.err);
  const candidates = authored.map((r) => r.cand);
  const tagOf = new Map(authored.map((r) => [r.cand.id, r.approachTag]));
  const baselineId = pinnedBaselineId != null ? pinnedBaselineId : pickBaseline(authors, new Set(authored.map((r) => r.cand.id)));

  // 2) ONE call to the EXISTING fanoutSelect over the full cohort. It owns gate -> dispersion
  //    -> select. baseRef lives INSIDE gate; oracleFiles + protectedPaths overridden here.
  const ship = await fanoutSelect({
    repoDir,
    candidates,
    baselineId,
    probeNames,
    gate: { ...gate, baseRef, oracleFiles, protectedPaths: protectedUnion },
    targetK,
    concurrency,
    rankKey,
    mutationProbes,
    runProbes,
  });

  // 3) Hoist the caller's STOP CONTRACT. `ship` (decision/winner/confidence) is ALREADY finalised
  //    above — the stop reason is derived strictly AFTER it and can never change the pick.
  const forbidApproachTags = uniq(ship.greens.map((g) => tagOf.get(g.id)).filter(Boolean));
  const nonDiscriminating = !ship.dispersion.discriminating;

  // The OLD in-suite stop reason — the byte-identical fallback when no held-out signal is measurable.
  const inSuiteReason = ship.greens.length === 0 ? 'no-green'
    : ship.dispersion.sufficient ? 'sufficient-dispersion'
    : nonDiscriminating ? 'non-discriminating-probes'
    : 'keep-exploring';

  // Drive keep-exploring off the HELD-OUT mutation-probe dispersion when it is measurable; otherwise
  // the in-suite signal is only a FLOOR. stopDecision is handed ONLY a dispersion object — never the
  // winner/decision/greens — so the diversity probes structurally cannot re-couple to the gate.
  const md = ship.mutationDispersion;
  const mutationMeasured = !!(md && md.measurable);
  const disp = mutationMeasured ? md.dispersion : ship.dispersion;
  const { reason: stopReason, metrics } = stopDecision(disp, prevSignatureKeys || new Set(), {
    targetK, epsilon: coverageEpsilon ?? 0.15, measurable: mutationMeasured,
  });
  // 'floor-only' ⇒ no trustworthy held-out signal ⇒ defer to the EXISTING in-suite reason (byte-identical
  // to pre-change behaviour on unmeasurable runs). Otherwise the held-out stop reason stands.
  const reason = stopReason === 'floor-only' ? inSuiteReason : stopReason;

  return {
    ...ship,
    authored: authored.map((r) => ({ id: r.cand.id, approachTag: r.approachTag, fileCount: Object.keys(r.cand.files).length, ok: true })),
    authorErrors,
    baselineId,
    nAuthors: authors.length,
    nAuthored: authored.length,
    exploreSignal: { keepExploring: ship.keepExploring, nonDiscriminating, forbidApproachTags, reason, mutationMeasured, metrics, classKeys: metrics.classKeys },
  };
}
