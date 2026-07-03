import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCmd } from './gate-runner.mjs';
import { fanoutSelect } from './fanout-select.mjs';

const SUITE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/impl.mjs';
test('acc: mid', () => assert.equal(classify(5), 'mid'));
test('acc: high', () => assert.equal(classify(50), 'high'));
test('probe: zero', () => assert.equal(classify(0), 'mid'));
test('probe: neg', () => assert.equal(classify(-5), 'low'));
test('probe: big', () => assert.equal(classify(1000), 'high'));
`;
const IMPL = {
  A: `export function classify(n){ return n <= 0 ? 'low' : n < 10 ? 'mid' : 'high'; }`,    // probes [F,P,P] coverage 2
  B: `export function classify(n){ return n <= 0 ? 'low' : n < 10 ? 'mid' : 'high'; }`,    // identical to A
  C: `export function classify(n){ return n < 0 ? 'low' : n < 10 ? 'mid' : 'high'; }`,     // [P,P,P] coverage 3 (correct)
  D: `export function classify(n){ return n < -10 ? 'low' : n < 10 ? 'mid' : 'high'; }`,   // [P,F,P] coverage 2
  BAD: `export function classify(){ return 'low'; }`,                                       // fails acceptance
};
const PROBE_NAMES = ['probe: zero', 'probe: neg', 'probe: big'];
const VERIFY = [
  { name: 'build', cmd: ['node', '--check', 'src/impl.mjs'], type: 'check' },
  { name: 'test', cmd: ['node', '--test', '--test-reporter=tap', 'test/suite.test.mjs'], type: 'test' },
];
const gateOpts = { verify: VERIFY, acceptanceFilter: (n) => n.startsWith('acc'), protectedPaths: ['test'], attempts: 2, perStepTimeoutMs: 12000 };

const dirs = [];
async function makeRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fs-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries({ 'src/impl.mjs': IMPL.C, 'test/suite.test.mjs': SUITE })) {
    const dest = path.join(dir, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content);
  }
  await runCmd('git', ['init', '-q'], { cwd: dir });
  await runCmd('git', ['add', '-A'], { cwd: dir });
  await runCmd('git', ['-c', 'user.email=ci@local', '-c', 'user.name=ci', 'commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}
const cand = (id) => ({ id, files: { 'src/impl.mjs': IMPL[id] } });
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {}); });

test('SHIP: a higher-coverage winner beats baseline, but dispersed greens => human-gate', async () => {
  const repo = await makeRepo();
  const r = await fanoutSelect({
    repoDir: repo, candidates: ['A', 'B', 'C', 'D'].map(cand), baselineId: 'A',
    probeNames: PROBE_NAMES, gate: gateOpts, targetK: 3, concurrency: 4,
  });
  assert.equal(r.decision, 'ship');
  assert.equal(r.winner.id, 'C', 'C has the broadest external-suite coverage');
  assert.equal(r.winner.coverage, 3);
  assert.equal(r.beatsBaseline, true);
  assert.equal(r.greens.length, 4);
  assert.equal(r.dispersion.distinctCount, 3);
  assert.equal(r.converged, false);
  assert.equal(r.confidence, 'human-gate', 'greens disagree on probes the suite does not pin');
  assert.ok(r.flags.includes('greens-disagree-on-probes'));
  assert.equal(r.keepExploring, true, 'effectiveN ~2.83 < targetK 3 -> keep exploring for more distinct behaviours');
});

test('SHIP-BASELINE: converged greens, none beat baseline => ship boring, externally verified', async () => {
  const repo = await makeRepo();
  const r = await fanoutSelect({
    repoDir: repo, candidates: ['A', 'B'].map(cand), baselineId: 'A',
    probeNames: PROBE_NAMES, gate: gateOpts, concurrency: 2,
  });
  assert.equal(r.decision, 'ship-baseline');
  assert.equal(r.winner.id, 'A');
  assert.equal(r.beatsBaseline, false);
  assert.equal(r.confidence, 'external-suite-verified');
  assert.equal(r.converged, true);
  assert.ok(r.flags.includes('probe-set-non-discriminating'));
  assert.equal(r.keepExploring, true, 'one behaviour only -> keep exploring');
});

test('NO-GREEN: all candidates fail acceptance => human-gate, nothing shipped', async () => {
  const repo = await makeRepo();
  const r = await fanoutSelect({
    repoDir: repo, candidates: [{ id: 'bad1', files: { 'src/impl.mjs': IMPL.BAD } }, { id: 'bad2', files: { 'src/impl.mjs': IMPL.BAD } }],
    baselineId: 'bad1', probeNames: PROBE_NAMES, gate: gateOpts, concurrency: 2,
  });
  assert.equal(r.decision, 'no-green');
  assert.equal(r.winner, null);
  assert.equal(r.confidence, 'none');
  assert.equal(r.pruned.length, 2);
  assert.equal(r.greens.length, 0);
});

test('BASELINE-NOT-GREEN: floor is lost => ship best green but human-gate + flagged', async () => {
  const repo = await makeRepo();
  const r = await fanoutSelect({
    repoDir: repo,
    candidates: [{ id: 'base', files: { 'src/impl.mjs': IMPL.BAD } }, cand('C')],
    baselineId: 'base', probeNames: PROBE_NAMES, gate: gateOpts, concurrency: 2,
  });
  assert.equal(r.decision, 'ship');
  assert.equal(r.winner.id, 'C');
  assert.equal(r.baseline.green, false);
  assert.ok(r.flags.includes('baseline-not-green'));
  assert.equal(r.confidence, 'human-gate');
});

// ---------------------------------------------------------------------------
// Held-out mutation probes (opt-in, MEASUREMENT-ONLY). The load-bearing invariant: attaching them
// must NOT change ANY acceptance-derived field — they only add a `mutationDispersion` label.
// ---------------------------------------------------------------------------

// Real behaviour of each candidate, used by the differential runner below (ref = first green id).
const CLASSIFY = {
  A: (n) => (n <= 0 ? 'low' : n < 10 ? 'mid' : 'high'),
  B: (n) => (n <= 0 ? 'low' : n < 10 ? 'mid' : 'high'),
  C: (n) => (n < 0 ? 'low' : n < 10 ? 'mid' : 'high'),
  D: (n) => (n < -10 ? 'low' : n < 10 ? 'mid' : 'high'),
};
// HELD-OUT inputs (ids disjoint from PROBE_NAMES + gate verify names 'build'/'test').
const MUT = [{ id: 'mut:neg20', input: -20 }, { id: 'mut:zero', input: 0 }, { id: 'mut:neg5', input: -5 }];
// Differential runner: pass = candidate agrees with the lexicographically-first green on the probe input.
const diffRunner = (gs, ps) => {
  const ref = [...gs].map((g) => g.id).sort()[0];
  return gs.map((g) => ({
    id: g.id,
    perProbe: Object.fromEntries(ps.map((p) => [p.id, CLASSIFY[g.id](p.input) === CLASSIFY[ref](p.input) ? 'pass' : 'fail'])),
  }));
};
const ACCEPTANCE_FIELDS = (r) => ({
  decision: r.decision, winnerId: r.winner && r.winner.id, confidence: r.confidence,
  converged: r.converged, keepExploring: r.keepExploring, flags: [...r.flags].sort(),
  greenOrder: r.greens.map((g) => g.id), beatsBaseline: r.beatsBaseline,
});

test('MUT: probes attach a diverse label WITHOUT changing any acceptance-derived field', async () => {
  const repo = await makeRepo();
  const args = { repoDir: repo, candidates: ['A', 'B', 'C', 'D'].map(cand), baselineId: 'A', probeNames: PROBE_NAMES, gate: gateOpts, targetK: 3, concurrency: 4 };
  const bare = await fanoutSelect(args);
  const probed = await fanoutSelect({ ...args, mutationProbes: MUT, runProbes: diffRunner });

  assert.equal(bare.mutationDispersion, null, 'no opts => null (backward-compatible)');
  assert.equal(probed.mutationDispersion.measurable, true);
  assert.equal(probed.mutationDispersion.dispersionState, 'diverse', 'C and D diverge from A on held-out inputs');
  // The honesty floor: every acceptance-derived field is identical with and without the probes.
  assert.deepEqual(ACCEPTANCE_FIELDS(probed), ACCEPTANCE_FIELDS(bare));
});

test('MUT: a green that FAILS every held-out probe is never pruned or re-picked', async () => {
  const repo = await makeRepo();
  // Adversarial runner: mark the eventual winner (C, broadest coverage) fail on EVERY probe.
  const sabotageWinner = (gs, ps) => gs.map((g) => ({
    id: g.id, perProbe: Object.fromEntries(ps.map((p) => [p.id, g.id === 'C' ? 'fail' : 'pass'])),
  }));
  const r = await fanoutSelect({
    repoDir: repo, candidates: ['A', 'B', 'C', 'D'].map(cand), baselineId: 'A',
    probeNames: PROBE_NAMES, gate: gateOpts, targetK: 3, concurrency: 4,
    mutationProbes: MUT, runProbes: sabotageWinner,
  });
  assert.equal(r.winner.id, 'C', 'winner is decided by the gate+coverage, never by a held-out probe');
  assert.ok(r.greens.some((g) => g.id === 'C'), 'C still admitted despite failing every probe');
  assert.equal(r.decision, 'ship');
  assert.equal(r.mutationDispersion.dispersionState, 'diverse');
  assert.deepEqual(r.mutationDispersion.perGreen.find((p) => p.id === 'C').signature, [false, false, false]);
});

test('MUT: converged label when greens agree on the held-out probes', async () => {
  const repo = await makeRepo();
  const r = await fanoutSelect({
    repoDir: repo, candidates: ['A', 'B'].map(cand), baselineId: 'A',
    probeNames: PROBE_NAMES, gate: gateOpts, concurrency: 2,
    mutationProbes: MUT, runProbes: diffRunner,   // A and B are identical impls
  });
  assert.equal(r.mutationDispersion.measurable, true);
  assert.equal(r.mutationDispersion.dispersionState, 'converged');
});

test('MUT: probes supplied but no runner => unmeasurable/no-runner (acceptance path untouched)', async () => {
  const repo = await makeRepo();
  const r = await fanoutSelect({
    repoDir: repo, candidates: ['A', 'B', 'C'].map(cand), baselineId: 'A',
    probeNames: PROBE_NAMES, gate: gateOpts, concurrency: 3, mutationProbes: MUT,
  });
  assert.equal(r.mutationDispersion.measurable, false);
  assert.equal(r.mutationDispersion.dispersionState, 'unmeasurable');
  assert.equal(r.mutationDispersion.reason, 'no-runner');
});

test('MUT: a probe id colliding with a gate/probe acceptance id throws (HELD-OUT invariant)', async () => {
  const repo = await makeRepo();
  await assert.rejects(fanoutSelect({
    repoDir: repo, candidates: ['A', 'B'].map(cand), baselineId: 'A',
    probeNames: PROBE_NAMES, gate: gateOpts, concurrency: 2,
    mutationProbes: [{ id: 'probe: zero', input: 0 }], runProbes: diffRunner,
  }), /must be HELD-OUT/);
  await assert.rejects(fanoutSelect({
    repoDir: repo, candidates: ['A', 'B'].map(cand), baselineId: 'A',
    probeNames: PROBE_NAMES, gate: gateOpts, concurrency: 2,
    mutationProbes: [{ id: 'test', input: 0 }], runProbes: diffRunner,   // 'test' is a gate verify step name
  }), /must be HELD-OUT/);
});

test('AR-MED1: a non-array mutationProbes is a STRUCTURAL bug (throws), not "absent capability"', async () => {
  const repo = await makeRepo();
  // supplied-but-malformed must throw whether or not a runner is present — never silently null / no-probes
  await assert.rejects(fanoutSelect({
    repoDir: repo, candidates: ['A', 'B'].map(cand), baselineId: 'A',
    probeNames: PROBE_NAMES, gate: gateOpts, concurrency: 2, mutationProbes: 'bad', runProbes: diffRunner,
  }), /probes must be an array/);
  await assert.rejects(fanoutSelect({
    repoDir: repo, candidates: ['A', 'B'].map(cand), baselineId: 'A',
    probeNames: PROBE_NAMES, gate: gateOpts, concurrency: 2, mutationProbes: { id: 'x' },  // object, no runner
  }), /probes must be an array/);
});

test('AR-LOW3: a gate.verify step missing a name throws when mutation probes are active (disjointness depends on it)', async () => {
  const repo = await makeRepo();
  const namelessGate = { ...gateOpts, verify: [{ cmd: ['node', '--check', 'src/impl.mjs'], type: 'check' }, ...VERIFY.slice(1)] };
  await assert.rejects(fanoutSelect({
    repoDir: repo, candidates: ['A', 'B'].map(cand), baselineId: 'A',
    probeNames: PROBE_NAMES, gate: namelessGate, concurrency: 2,
    mutationProbes: [{ id: 'mut:zero', input: 0 }], runProbes: diffRunner,
  }), /non-empty string name/);
});

test('AR-HIGH: a runProbes runner that MUTATES its received greens cannot corrupt winner/greens (probe input is cloned)', async () => {
  const repo = await makeRepo();
  // Adversarial runner: capture rows under the ORIGINAL ids, THEN mutate the received green objects.
  // If fanoutSelect passed the live `ranked` (winner === ranked[0]), the winner id would be corrupted.
  const evil = (gs, ps) => {
    const rows = gs.map((g) => ({ id: g.id, perProbe: Object.fromEntries(ps.map((p) => [p.id, 'pass'])) }));
    gs.forEach((g) => { g.id = 'HACKED'; });
    return rows;
  };
  const r = await fanoutSelect({
    repoDir: repo, candidates: ['A', 'B', 'C', 'D'].map(cand), baselineId: 'A',
    probeNames: PROBE_NAMES, gate: gateOpts, targetK: 3, mutationProbes: MUT, runProbes: evil,
  });
  assert.equal(r.winner.id, 'C', 'winner unaffected by a mutating probe runner');
  assert.ok(!r.greens.some((g) => g.id === 'HACKED'), 'green identities not corrupted');
});
