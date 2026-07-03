// author-loop.test.mjs — the v1-lite author wave above fanoutSelect.
// Test plan synthesized by the design panel (godcode-author-loop-design workflow):
// zero-drift passthrough, structural anti-dive, oracle-blindness (ctx allowlist + gate routing),
// the protectedPaths-union false-green fix, the hoisted stop contract, author-failure isolation,
// baseline fallback, gate-override integrity, and determinism.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCmd } from './gate-runner.mjs';
import { fanoutSelect } from './fanout-select.mjs';
import { authorLoop } from './author-loop.mjs';

// ---- fixtures (mirror fanout-select.test.mjs) ----
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
  A: `export function classify(n){ return n <= 0 ? 'low' : n < 10 ? 'mid' : 'high'; }`,   // [F,P,P]
  B: `export function classify(n){ return n <= 0 ? 'low' : n < 10 ? 'mid' : 'high'; }`,   // identical to A
  C: `export function classify(n){ return n < 0 ? 'low' : n < 10 ? 'mid' : 'high'; }`,    // [P,P,P] correct
  D: `export function classify(n){ return n < -10 ? 'low' : n < 10 ? 'mid' : 'high'; }`,  // [P,F,P]
  BAD: `export function classify(){ return 'low'; }`,                                      // fails acceptance
};
const PROBE_NAMES = ['probe: zero', 'probe: neg', 'probe: big'];
const VERIFY = [
  { name: 'build', cmd: ['node', '--check', 'src/impl.mjs'], type: 'check' },
  { name: 'test', cmd: ['node', '--test', '--test-reporter=tap', 'test/suite.test.mjs'], type: 'test' },
];
const gateOpts = { verify: VERIFY, acceptanceFilter: (n) => n.startsWith('acc'), protectedPaths: ['test'], attempts: 2, perStepTimeoutMs: 12000 };
const TASK = { id: 'classify', spec: 'Implement classify(n): low for negatives, mid for 0..9, high for >=10.' };

const dirs = [];
async function makeRepo(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'al-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(dir, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content);
  }
  await runCmd('git', ['init', '-q'], { cwd: dir });
  await runCmd('git', ['add', '-A'], { cwd: dir });
  await runCmd('git', ['-c', 'user.email=ci@local', '-c', 'user.name=ci', 'commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}
const repoWithSuite = () => makeRepo({ 'src/impl.mjs': IMPL.C, 'test/suite.test.mjs': SUITE });
// SWE-bench shape: source committed, verifier ABSENT (materialized via oracleFiles).
const repoNoTest = (impl) => makeRepo({ 'src/impl.mjs': impl });
const author = (id, impl, extra = {}) => ({ id, fn: async () => ({ files: { 'src/impl.mjs': impl }, ...extra }) });
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {}); });

test('ZERO DRIFT: authorLoop adds no selection behaviour vs calling fanoutSelect directly', async () => {
  const repo = await repoWithSuite();
  const authors = [
    { ...author('A', IMPL.A), isBaseline: true },
    author('B', IMPL.B), author('C', IMPL.C), author('D', IMPL.D),
  ];
  const r = await authorLoop({ repoDir: repo, task: TASK, authors, probeNames: PROBE_NAMES, gate: gateOpts, targetK: 3, concurrency: 4 });
  const direct = await fanoutSelect({
    repoDir: repo, candidates: ['A', 'B', 'C', 'D'].map((id) => ({ id, files: { 'src/impl.mjs': IMPL[id] } })),
    baselineId: 'A', probeNames: PROBE_NAMES, gate: gateOpts, targetK: 3, concurrency: 4,
  });
  assert.equal(r.decision, direct.decision);
  assert.equal(r.winner.id, direct.winner.id);
  assert.equal(r.confidence, direct.confidence);
  assert.equal(r.keepExploring, direct.keepExploring);
  assert.equal(r.dispersion.distinctCount, direct.dispersion.distinctCount);
  // and the documented expected values
  assert.equal(r.decision, 'ship');
  assert.equal(r.winner.id, 'C');
  assert.equal(r.confidence, 'human-gate');
});

test('ANTI-DIVE: ALL N authors run even though author[0] is already a correct green', async () => {
  const repo = await repoWithSuite();
  const ran = {};
  const spy = (id, impl) => ({ id, fn: async () => { ran[id] = true; return { files: { 'src/impl.mjs': impl } }; } });
  const authors = [spy('C', IMPL.C), spy('A', IMPL.A), spy('D', IMPL.D), { ...spy('B', IMPL.B), isBaseline: true }];
  const r = await authorLoop({ repoDir: repo, task: TASK, authors, probeNames: PROBE_NAMES, gate: gateOpts, targetK: 3 });
  assert.deepEqual(Object.keys(ran).sort(), ['A', 'B', 'C', 'D'], 'no early-exit on first green');
  assert.equal(r.greens.length, 4, 'fanoutSelect saw the full cohort');
});

test('ORACLE-BLINDNESS: author ctx is a fixed allowlist with no verifier inside', async () => {
  const repo = await repoNoTest(IMPL.C);
  let seenKeys = null; let seenJson = null;
  const spy = {
    id: 'spy',
    fn: async (ctx) => { seenKeys = Object.keys(ctx).sort(); seenJson = JSON.stringify(ctx); return { files: { 'src/impl.mjs': IMPL.C } }; },
  };
  const ORACLE = SUITE.replace("test('acc: mid'", "test('acc: mid SENTINEL_ORACLE_TOKEN'");
  await authorLoop({
    repoDir: repo, task: TASK, authors: [{ ...spy, isBaseline: true }],
    oracleFiles: { 'test/suite.test.mjs': ORACLE }, probeNames: PROBE_NAMES, gate: gateOpts, targetK: 1,
  });
  assert.deepEqual(seenKeys, ['authorId', 'baseRef', 'forbidApproachOf', 'repoDir', 'task']);
  assert.ok(!seenJson.includes('SENTINEL_ORACLE_TOKEN'), 'oracle content never reaches the author');
  assert.ok(!seenJson.includes('probe: zero'), 'probe names never reach the author');
  assert.ok(!seenJson.includes('--test-reporter'), 'verify commands never reach the author');
});

test('ORACLE REACHES THE GATE: harness-installed verifier makes the fix GREEN, no-op pruned', async () => {
  const repo = await repoNoTest(IMPL.BAD); // base is wrong; verifier absent at base
  const r = await authorLoop({
    repoDir: repo, task: TASK,
    authors: [{ ...author('fix', IMPL.C), isBaseline: true }, author('noop', IMPL.BAD)],
    oracleFiles: { 'test/suite.test.mjs': SUITE }, probeNames: PROBE_NAMES, gate: gateOpts, targetK: 1,
  });
  assert.ok(r.greens.some((g) => g.id === 'fix'), 'fix is GREEN only because the harness installed the oracle');
  assert.ok(r.pruned.some((p) => p.id === 'noop'), 'no-op fails the materialized verifier');
});

test('FALSE-GREEN FIX: an author writing the verifier path is PRUNED (protectedPaths union)', async () => {
  const repo = await repoNoTest(IMPL.C);
  const TRIVIAL = `import { test } from 'node:test';\ntest('acc: rigged', () => {});\n`;
  const cheat = { id: 'cheat', fn: async () => ({ files: { 'test/suite.test.mjs': TRIVIAL } }) };
  const r = await authorLoop({
    repoDir: repo, task: TASK, authors: [cheat],
    oracleFiles: { 'test/suite.test.mjs': SUITE },
    probeNames: PROBE_NAMES,
    gate: { ...gateOpts, protectedPaths: [] }, // caller FORGOT to protect the verifier
    targetK: 1,
  });
  const p = r.pruned.find((x) => x.id === 'cheat');
  assert.ok(p, `cheat must be pruned, got ${JSON.stringify(r.pruned)}`);
  assert.equal(p.failStep, 'immutability-violation', 'union(oracleFiles keys) into protectedPaths blocks self-certification');
});

// Codex AR #4 (critical): a candidate path with an INTERNAL `./` segment (test/./suite.test.mjs)
// normalizes to the oracle path on write but dodged matchProtected (which stripped only a LEADING
// `./`). That bypassed the immutability guard and overwrote the oracle -> false GREEN.
test('FALSE-GREEN FIX: a dotted verifier path (test/./x) still cannot dodge the immutability guard', async () => {
  const repo = await repoNoTest(IMPL.C);
  const TRIVIAL = `import { test } from 'node:test';\ntest('acc: rigged', () => {});\n`;
  const cheat = { id: 'cheat', fn: async () => ({ files: { 'test/./suite.test.mjs': TRIVIAL } }) };
  const r = await authorLoop({
    repoDir: repo, task: TASK, authors: [cheat],
    oracleFiles: { 'test/suite.test.mjs': SUITE },
    probeNames: PROBE_NAMES, gate: { ...gateOpts, protectedPaths: [] }, targetK: 1,
  });
  const p = r.pruned.find((x) => x.id === 'cheat');
  assert.ok(p, `dotted-path cheat must be pruned, got ${JSON.stringify(r.pruned)}`);
  assert.equal(p.failStep, 'immutability-violation');
});

test('STOP CONTRACT: non-discriminating probes surface a terminal signal (caller must not loop)', async () => {
  const repo = await repoWithSuite();
  const authors = [{ ...author('A', IMPL.A), isBaseline: true }, author('B', IMPL.B)]; // two clones
  const r = await authorLoop({ repoDir: repo, task: TASK, authors, probeNames: PROBE_NAMES, gate: gateOpts, targetK: 1 });
  assert.equal(r.exploreSignal.nonDiscriminating, true);
  assert.equal(r.exploreSignal.reason, 'non-discriminating-probes');
  assert.equal(r.keepExploring, true, 'raw keepExploring still relayed');
  assert.equal(r.exploreSignal.keepExploring, true);
});

test('STOP CONTRACT: keep-exploring unions ALL green approach tags for the next wave', async () => {
  const repo = await repoWithSuite();
  const authors = [
    { ...author('A', IMPL.A, { approachTag: 'tagA' }), isBaseline: true },
    author('B', IMPL.B, { approachTag: 'tagB' }),
    author('C', IMPL.C, { approachTag: 'tagC' }),
    author('D', IMPL.D, { approachTag: 'tagD' }),
  ];
  const r = await authorLoop({ repoDir: repo, task: TASK, authors, probeNames: PROBE_NAMES, gate: gateOpts, targetK: 3 });
  assert.equal(r.exploreSignal.keepExploring, true);
  assert.equal(r.exploreSignal.reason, 'keep-exploring');
  assert.deepEqual(r.exploreSignal.forbidApproachTags.sort(), ['tagA', 'tagB', 'tagC', 'tagD']);
});

test('EARNED STOP: >=targetK behaviourally-distinct greens => sufficient-dispersion', async () => {
  const repo = await repoWithSuite();
  const authors = [
    { ...author('A', IMPL.A), isBaseline: true }, // [F,P,P]
    author('C', IMPL.C),                          // [P,P,P]
    author('D', IMPL.D),                          // [P,F,P]
  ];
  const r = await authorLoop({ repoDir: repo, task: TASK, authors, probeNames: PROBE_NAMES, gate: gateOpts, targetK: 3 });
  assert.equal(r.dispersion.sufficient, true, JSON.stringify(r.dispersion));
  assert.equal(r.exploreSignal.reason, 'sufficient-dispersion');
});

test('FAILURE ISOLATION: throw / timeout / empty / duplicate-id are recorded, cohort still ships', async () => {
  const repo = await repoWithSuite();
  const authors = [
    { ...author('C', IMPL.C), isBaseline: true },
    { id: 'boom', fn: async () => { throw new Error('author crashed'); } },
    { id: 'slow', fn: () => new Promise((res) => setTimeout(() => res({ files: { 'src/impl.mjs': IMPL.A } }), 300)) },
    { id: 'empty', fn: async () => ({ files: {} }) },
    author('C', IMPL.D), // duplicate id
  ];
  const r = await authorLoop({ repoDir: repo, task: TASK, authors, probeNames: PROBE_NAMES, gate: gateOpts, targetK: 1, concurrency: 4, authorTimeoutMs: 80 });
  const byReason = Object.fromEntries(r.authorErrors.map((e) => [e.id + ':' + e.reason, true]));
  assert.ok(byReason['boom:threw']);
  assert.ok(byReason['slow:timeout']);
  assert.ok(byReason['empty:empty']);
  assert.ok(r.authorErrors.some((e) => e.reason === 'duplicate-id'));
  assert.equal(r.nAuthors, 5);
  assert.equal(r.nAuthored, 1);
  assert.ok(r.greens.some((g) => g.id === 'C'), 'survivor still gated + shipped');
});

// Codex AR #6/#9 (high): a non-string file VALUE passed the emptiness check but made gateRunner's
// writeFile throw uncaught -> fanoutSelect's pool rejected -> the WHOLE cohort crashed. authorLoop
// must snapshot+validate author output so one malformed author is isolated, never fatal.
test('FAILURE ISOLATION: a non-string file value is isolated (invalid-files), never crashes the cohort', async () => {
  const repo = await repoWithSuite();
  const authors = [
    { ...author('C', IMPL.C), isBaseline: true },
    { id: 'bad', fn: async () => ({ files: { 'src/impl.mjs': { not: 'a string' } } }) },
  ];
  const r = await authorLoop({ repoDir: repo, task: TASK, authors, probeNames: PROBE_NAMES, gate: gateOpts, targetK: 1 });
  assert.ok(r.authorErrors.some((e) => e.id === 'bad' && e.reason === 'invalid-files'), JSON.stringify(r.authorErrors));
  assert.equal(r.nAuthored, 1);
  assert.ok(r.greens.some((g) => g.id === 'C'), 'cohort still ships from the valid survivor');
});

test('BASELINE FALLBACK: a throwing designated baseline falls back to first surviving author', async () => {
  const repo = await repoWithSuite();
  const authors = [
    { id: 'base', isBaseline: true, fn: async () => { throw new Error('boom'); } },
    author('C', IMPL.C),
  ];
  const r = await authorLoop({ repoDir: repo, task: TASK, authors, probeNames: PROBE_NAMES, gate: gateOpts, targetK: 1 });
  assert.equal(r.baselineId, 'C', 'deterministic fallback to first authored');
  assert.ok(['ship', 'ship-baseline'].includes(r.decision));
  assert.ok(r.authorErrors.some((e) => e.id === 'base' && e.reason === 'threw'));
});

test('GATE OVERRIDE INTEGRITY: bogus gate.oracleFiles / mismatched gate.baseRef are overridden', async () => {
  const repo = await repoNoTest(IMPL.C);
  const r = await authorLoop({
    repoDir: repo, baseRef: 'HEAD', task: TASK,
    authors: [{ ...author('C', IMPL.C), isBaseline: true }],
    oracleFiles: { 'test/suite.test.mjs': SUITE },                 // the REAL verifier
    probeNames: PROBE_NAMES, targetK: 1,
    gate: { ...gateOpts, oracleFiles: { 'x.test.mjs': 'garbage' }, baseRef: 'deadbeef' }, // bogus, must be overridden
  });
  // If authorLoop did NOT override, the bad baseRef would fail worktree-setup -> incomplete, not green.
  assert.ok(r.greens.some((g) => g.id === 'C'), `override must use opts.oracleFiles + opts.baseRef: ${JSON.stringify(r)}`);
});

test('DETERMINISM: identical fake authors produce an identical result (modulo evidence paths)', async () => {
  const repo = await repoWithSuite();
  const mk = () => authorLoop({
    repoDir: repo, task: TASK,
    authors: [{ ...author('A', IMPL.A), isBaseline: true }, author('C', IMPL.C), author('D', IMPL.D)],
    probeNames: PROBE_NAMES, gate: gateOpts, targetK: 3,
  });
  const scrub = (o) => JSON.parse(JSON.stringify(o), (k, v) => (k === 'evidencePath' ? null : v));
  const a = scrub(await mk());
  const b = scrub(await mk());
  assert.deepEqual(a, b);
});

// ---- held-out mutation probes drive keep-exploring (D / code path) ----
// Real behaviour of each candidate (for the differential held-out runner; ref = lex/first green id).
const CLASSIFY = {
  A: (n) => (n <= 0 ? 'low' : n < 10 ? 'mid' : 'high'),
  C: (n) => (n < 0 ? 'low' : n < 10 ? 'mid' : 'high'),
  D: (n) => (n < -10 ? 'low' : n < 10 ? 'mid' : 'high'),
};
const MUT = [{ id: 'mut:neg20', input: -20 }, { id: 'mut:zero', input: 0 }, { id: 'mut:neg5', input: -5 }];
const diffRunner = (gs, ps) => {
  const ref = [...gs].map((g) => g.id).sort()[0];
  return gs.map((g) => ({ id: g.id, perProbe: Object.fromEntries(ps.map((p) => [p.id, CLASSIFY[g.id](p.input) === CLASSIFY[ref](p.input) ? 'pass' : 'fail'])) }));
};
const acdAuthors = () => [author('A', IMPL.A), author('C', IMPL.C), author('D', IMPL.D)];

test('held-out probes GOLDEN: winner/decision/confidence/greens BYTE-IDENTICAL with vs without probes', async () => {
  const repo = await repoWithSuite();
  const base = { repoDir: repo, task: TASK, authors: acdAuthors(), probeNames: PROBE_NAMES, gate: gateOpts, targetK: 3 };
  const bare = await authorLoop(base);
  const probed = await authorLoop({ ...base, authors: acdAuthors(), mutationProbes: MUT, runProbes: diffRunner });
  assert.equal(probed.winner.id, bare.winner.id, 'held-out probes never change the pick');
  assert.equal(probed.decision, bare.decision);
  assert.equal(probed.confidence, bare.confidence);
  assert.deepEqual(probed.greens.map((g) => g.id), bare.greens.map((g) => g.id));
});

test('held-out probes ABSENT: mutationMeasured false, reason == the in-suite value (byte-identical fallback)', async () => {
  const repo = await repoWithSuite();
  const r = await authorLoop({ repoDir: repo, task: TASK, authors: acdAuthors(), probeNames: PROBE_NAMES, gate: gateOpts, targetK: 3 });
  assert.equal(r.exploreSignal.mutationMeasured, false);
  assert.equal(r.exploreSignal.reason, 'sufficient-dispersion', 'A,C,D = 3 distinct in-suite signatures, effectiveN 3 >= targetK 3');
});

test('held-out probes DIVERSE: the stop reason is computed off the HELD-OUT signal (sufficient-floor)', async () => {
  const repo = await repoWithSuite();
  const r = await authorLoop({ repoDir: repo, task: TASK, authors: acdAuthors(), probeNames: PROBE_NAMES, gate: gateOpts, targetK: 3, mutationProbes: MUT, runProbes: diffRunner });
  assert.equal(r.exploreSignal.mutationMeasured, true);
  assert.equal(r.exploreSignal.reason, 'sufficient-floor', 'held-out path uses sufficient-FLOOR, not the in-suite sufficient-dispersion');
  assert.equal(typeof r.exploreSignal.metrics.coverage, 'number', 'held-out coverage metric surfaced for the dossier');
});

test('held-out probes measurable but CONVERGED => floor-only => defers to the in-suite floor (never lowers it)', async () => {
  const repo = await repoWithSuite();
  const allAgree = (gs, ps) => gs.map((g) => ({ id: g.id, perProbe: Object.fromEntries(ps.map((p) => [p.id, 'pass'])) }));
  const r = await authorLoop({ repoDir: repo, task: TASK, authors: acdAuthors(), probeNames: PROBE_NAMES, gate: gateOpts, targetK: 3, mutationProbes: MUT, runProbes: allAgree });
  assert.equal(r.exploreSignal.mutationMeasured, true);
  assert.equal(r.exploreSignal.reason, 'sufficient-dispersion', 'non-discriminating held-out signal defers to in-suite, which is sufficient');
});
