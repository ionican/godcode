// run — /godcode end-to-end on a benchmark item: materialize the item, fan authors out over the
// ORACLE-BLIND task, gate each in an isolated real-repo worktree, select, and keep exploring across
// waves until an earned/honest stop. This is the runnable harness — runWaves(authorLoop(fanoutSelect(
// gateRunner))) wired to a real item.
//
// Author modes (the injected model seam):
//   --replay  (default)  deterministic: replay the item's real fix (GREEN) + a base-revert (RED).
//                        Proves the whole pipeline on a real repo with no model.
//   --patches <dir>      gate REAL author-written patches: each <dir>/<id>.json = {files, approachTag}.
//                        This is how the live Opus-author fan-out hands its candidates to the gate.
//
// Usage: node run.mjs <itemId> [--replay | --patches <dir>] [--waves N]

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeItem } from './materialize.mjs';
import { runWaves } from '../runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH = JSON.parse(readFileSync(path.join(HERE, 'benchmark.json'), 'utf8'));

const argv = process.argv.slice(2);
const patchesDir = argv.includes('--patches') ? argv[argv.indexOf('--patches') + 1] : null;
const wavesArg = argv.includes('--waves') ? Number(argv[argv.indexOf('--waves') + 1]) : 2;
const itemId = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--patches' && argv[i - 1] !== '--waves');

const item = BENCH.items.find((i) => i.id === itemId) || BENCH.items.find((i) => i.kind === 'search-shaped');
const m = materializeItem(item);
if (!m.supported) { console.log(`SKIP ${item.id}: framework ${m.framework} not supported by v1 runner`); process.exit(2); }

// --replay: deterministic authors reconstructed from the item (no model).
function replayFactory() {
  return async ({ wave }) => (wave !== 1 ? [] : [
    { id: 'fix-replay', isBaseline: true, fn: async () => ({ files: m.fixSource, approachTag: 'fix' }) },
    { id: 'base-revert', fn: async () => ({ files: m.baseSource, approachTag: 'revert' }) },
  ]);
}

// --patches: gate REAL author-written candidates from disk (the live fan-out's output).
function patchesFactory(dir) {
  return async ({ wave }) => {
    if (wave !== 1) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f, i) => {
      const { files, approachTag } = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      return { id: f.replace(/\.json$/, ''), isBaseline: i === 0, fn: async () => ({ files, approachTag }) };
    });
  };
}

const authorFactory = patchesDir ? patchesFactory(patchesDir) : replayFactory();

const ship = await runWaves({
  repoDir: m.root,
  baseRef: m.base,
  task: { id: item.id, spec: item.spec },        // ORACLE-BLIND: spec only, never the verifier
  oracleFiles: m.oracleFiles,                     // routed only into the gate
  probeNames: [],                                 // no discriminating probes yet (mutation/property = v2)
  gate: { verify: m.verify, acceptanceFilter: () => true, protectedPaths: m.protectedPaths, provision: m.provision, runSubdir: m.runSubdir, attempts: 1, perStepTimeoutMs: 180000 },
  targetK: 3, concurrency: 2, maxWaves: wavesArg,
  authorFactory,
});

if (argv.includes('--json')) {
  const greens = ship.greens.map((g) => g.id);
  const pruned = ship.pruned.map((p) => ({ id: p.id, failStep: p.failStep }));
  const incomplete = ship.incomplete.map((p) => ({ id: p.id, failStep: p.failStep }));
  const n = greens.length + pruned.length + incomplete.length;
  console.log(JSON.stringify({
    item: item.id, mode: patchesDir ? 'patches' : 'replay',
    decision: ship.decision, confidence: ship.confidence, winner: ship.winner ? ship.winner.id : null,
    greens, pruned, incomplete, n,
    pSingle: n ? greens.length / n : 0,          // estimate: fraction of independent authors that were correct
    anyGreen: greens.length > 0,                 // best-of-N: did the cohort yield a verified-correct answer?
    dispersion: { distinctCount: ship.dispersion.distinctCount, effectiveN: ship.dispersion.effectiveN, discriminating: ship.dispersion.discriminating },
    exploreSignal: ship.exploreSignal, nWaves: ship.nWaves, stoppedBecause: ship.stoppedBecause,
    authorErrors: ship.authorErrors,
  }));
  process.exit(0);
}

console.log(`\n=== /godcode run: ${item.id} (${patchesDir ? 'patches' : 'replay'}) ===`);
console.log(`base ${m.base.slice(0, 8)} -> oracle ${Object.keys(m.oracleFiles).length} file(s), runSubdir ${m.runSubdir}`);
console.log(`decision:    ${ship.decision}`);
console.log(`confidence:  ${ship.confidence}`);
console.log(`winner:      ${ship.winner ? ship.winner.id : '(none)'}`);
console.log(`greens:      [${ship.greens.map((g) => g.id).join(', ')}]`);
console.log(`pruned:      [${ship.pruned.map((p) => `${p.id}:${p.failStep}`).join(', ')}]`);
console.log(`dispersion:  distinctCount ${ship.dispersion.distinctCount}, effectiveN ${ship.dispersion.effectiveN}, discriminating ${ship.dispersion.discriminating}`);
console.log(`exploreSignal: reason=${ship.exploreSignal.reason}, nonDiscriminating=${ship.exploreSignal.nonDiscriminating}`);
console.log(`waves:       ${ship.nWaves}, stopped: ${ship.stoppedBecause}`);
console.log(`authorErrors: ${JSON.stringify(ship.authorErrors)}`);
