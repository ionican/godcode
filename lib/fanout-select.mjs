// fanout-select — the v1-lite /godcode control loop.
//
// Consumes the two primitives: gate every candidate OUT-OF-BAND (gate-runner),
// then SELECT among the GREEN survivors using only the external suite + G1
// dispersion. No model-authored oracle, no model-judged scoring, no Q panel,
// no deepen — those are the v2/v3 research bet.
//
// Selection discipline (the anti-dive + honesty floor made concrete):
//   - rank greens by EXTERNAL-suite coverage (probe-pass count proxy; true branch
//     coverage via c8 is a v1 follow-on), tie-break by smaller change (Occam);
//   - the simplest-correct BASELINE always ships unless a winner strictly beats it
//     on the measured axis ("search found no improvement over baseline" otherwise);
//   - dispersion across greens decides confidence: greens that DISAGREE on probe
//     behaviour mean the acceptance suite under-specifies -> human-gate, never a
//     confident silent pick; greens that CONVERGE -> external-suite-verified;
//   - keepExploring = !dispersion.sufficient surfaces the anti-dive signal to the
//     upstream author loop (we have not yet seen K behaviourally-distinct solutions).
//
// The candidate set is an INPUT here: authoring agents are upstream. This module is
// the deterministic gate+select core, fully testable without any model call.

import { gateRunner } from './gate-runner.mjs';
import { dispersion, signatureFromResults } from './dispersion.mjs';
import { runMutationProbes } from './mutation-probes.mjs';

async function pool(items, concurrency, worker) {
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

const diffSize = (candidate) =>
  Object.values(candidate.files || {}).reduce((n, c) => n + (typeof c === 'string' ? c.length : 0), 0);

/**
 * Run the v1-lite fan-out -> gate -> select loop.
 *
 * @param {object} opts
 * @param {string} opts.repoDir
 * @param {{id:string, files:Record<string,string>}[]} opts.candidates
 * @param {string} opts.baselineId  the simplest-correct baseline (must be among candidates)
 * @param {string[]} opts.probeNames ordered probe test names for G1 signatures
 * @param {object} opts.gate         gate-runner opts shared by every candidate
 *                                   (verify, acceptanceFilter, protectedPaths, attempts, perStepTimeoutMs, baseRef)
 * @param {number} [opts.targetK=3]
 * @param {number} [opts.concurrency=4]
 * @param {(green)=>number} [opts.rankKey]  override the coverage rank key
 * @param {{id:string}[]} [opts.mutationProbes]  OPT-IN, HELD-OUT, MEASUREMENT-ONLY probes (see
 *        mutation-probes.mjs). Run over the GREEN survivors ONLY to attach a `mutationDispersion`
 *        label. NEVER feeds the gate/rank/decision/confidence — a held-out probe input was never a
 *        requirement, so a green that "fails" one is still verified. Must be disjoint from the gate
 *        test names and `probeNames`. Requires `opts.runProbes`.
 * @param {(greens, probes)=>Promise<any[]>} [opts.runProbes]  the executable seam that runs each
 *        green against each mutation probe and returns [{id, perProbe:{probeId:'pass'|'fail'}}].
 * @returns {Promise<object>} ShipContract
 */
export async function fanoutSelect(opts) {
  const {
    repoDir, candidates, baselineId, probeNames,
    gate = {}, targetK = 3, concurrency = 4,
    rankKey, mutationProbes, runProbes,
  } = opts;

  // 1) Gate every candidate out-of-band, isolated worktrees, bounded concurrency.
  const gated = await pool(candidates, concurrency, (candidate) =>
    gateRunner({ repoDir, candidate, ...gate }));

  const greenResults = gated.filter((g) => g.gate === 'green');
  const pruned = gated.filter((g) => g.gate === 'pruned').map((g) => ({ id: g.candidateId, failStep: g.failStep }));
  const incomplete = gated.filter((g) => g.gate === 'incomplete').map((g) => ({ id: g.candidateId, failStep: g.failStep }));

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const coverageOf = (g) => signatureFromResults(g.perTest, probeNames).filter(Boolean).length;
  const greens = greenResults.map((g) => ({
    id: g.candidateId,
    signature: signatureFromResults(g.perTest, probeNames),
    coverage: rankKey ? rankKey(g) : coverageOf(g),
    diffSize: diffSize(byId.get(g.candidateId) || {}),
    evidencePath: g.evidencePath,
  }));

  // 2) Dispersion across the green survivors (G1).
  const disp = dispersion(greens.map((g) => ({ id: g.id, signature: g.signature })), { targetK });
  const converged = disp.effectiveN <= 1 + 1e-9; // greens agree on probe behaviour
  const keepExploring = !disp.sufficient;          // anti-dive: < K distinct behaviours seen

  // 3) Rank greens: coverage desc, then smaller change, then id (deterministic).
  const ranked = [...greens].sort((a, b) => b.coverage - a.coverage || a.diffSize - b.diffSize || a.id.localeCompare(b.id));

  const flags = [];
  if (greens.length >= 2 && !disp.discriminating) flags.push('probe-set-non-discriminating');

  // 4) Decide.
  let decision; let winner = null; let confidence; let beatsBaseline = null;
  const baselineGreen = greens.find((g) => g.id === baselineId) || null;
  if (greens.length === 0) {
    decision = 'no-green';
    confidence = 'none';
  } else if (!baselineGreen) {
    // The simplest-correct baseline failed its own gate — the floor is gone.
    flags.push('baseline-not-green');
    decision = 'ship';
    winner = ranked[0];
    confidence = 'human-gate';
  } else {
    winner = ranked[0];
    beatsBaseline = winner.coverage > baselineGreen.coverage;
    if (!beatsBaseline) {
      // Nothing beats boring on the measured axis -> ship the baseline, labelled.
      decision = 'ship-baseline';
      winner = baselineGreen;
      confidence = 'external-suite-verified';
    } else {
      decision = 'ship';
      if (!converged) {
        // Greens disagree on probe behaviour the acceptance suite does not pin.
        flags.push('greens-disagree-on-probes');
        confidence = 'human-gate';
      } else {
        confidence = 'external-suite-verified';
      }
    }
  }

  // 5) OPT-IN held-out mutation probes — MEASUREMENT-ONLY. Runs strictly AFTER the decision is
  // finalized and attaches a separate `mutationDispersion` LABEL. It reads `ranked` (the admitted
  // greens) but mutates NONE of decision/winner/confidence/converged/keepExploring/flags — a
  // held-out probe input was never a requirement, so it can never gate, prune, or re-pick. Absent
  // opts => null (byte-for-byte backward-compatible with the no-probes path).
  let mutationDispersion = null;
  if (mutationProbes !== undefined || typeof runProbes === 'function') {
    // Opt-in = `mutationProbes` SUPPLIED (any value) or a runner present. A non-array `mutationProbes` is a
    // STRUCTURAL caller bug, not "absent capability" (AR-MED) — pass the raw value so runMutationProbes throws
    // rather than silently degrading to no-probes/null.
    const verifySteps = gate.verify || [];
    for (const v of verifySteps) {
      // Disjointness depends on the COMPLETE acceptance id set; a nameless gate step would silently drop out
      // of `acceptanceIds`, letting a probe collide with a real acceptance test undetected (AR-LOW).
      if (!v || typeof v.name !== 'string' || v.name.trim() === '') {
        throw new Error('fanoutSelect: every gate.verify step needs a non-empty string name when mutation probes are active (held-out disjointness depends on the full acceptance id set)');
      }
    }
    mutationDispersion = await runMutationProbes({
      // Pass CLONED, id-only descriptors — NEVER the live `ranked` objects (winner === ranked[0]). A buggy
      // or adversarial probe runner that mutates the greens it receives must not be able to corrupt the
      // already-finalised winner/greens by reference (AR-HIGH).
      greens: ranked.map((g) => ({ id: g.id })),
      probes: mutationProbes !== undefined ? mutationProbes : [],
      runner: runProbes,
      acceptanceIds: [...(probeNames || []), ...verifySteps.map((v) => v.name)],
      targetK,
    });
  }

  return {
    decision,                 // 'ship' | 'ship-baseline' | 'no-green'
    winner,                   // {id, coverage, signature, ...} | null
    baseline: baselineGreen ? { id: baselineGreen.id, coverage: baselineGreen.coverage, green: true } : { id: baselineId, green: false },
    beatsBaseline,
    confidence,               // 'external-suite-verified' | 'human-gate' | 'none'
    converged,
    keepExploring,
    dispersion: disp,
    flags,
    greens: ranked,
    pruned,
    incomplete,
    mutationDispersion,       // held-out MEASUREMENT-ONLY label | null — never gates/ranks (see step 5)
  };
}
