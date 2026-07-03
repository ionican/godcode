// runner.test.mjs — the multi-wave keep-exploring loop, exercised deterministically with FAKE
// author factories over a synthetic discriminating suite (probe/acc split, so dispersion is
// measurable). Covers: earned stop, keep-exploring across waves with accumulation + forbid-tag
// threading, the non-discriminating immediate stop, the maxWaves ceiling, no-green persistence,
// and the injected budget guard.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCmd } from './gate-runner.mjs';
import { runWaves } from './runner.mjs';

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
  C: `export function classify(n){ return n < 0 ? 'low' : n < 10 ? 'mid' : 'high'; }`,    // [P,P,P]
  D: `export function classify(n){ return n < -10 ? 'low' : n < 10 ? 'mid' : 'high'; }`,  // [P,F,P]
  BAD: `export function classify(){ return 'low'; }`,                                      // fails acceptance
};
const PROBE_NAMES = ['probe: zero', 'probe: neg', 'probe: big'];
const VERIFY = [
  { name: 'build', cmd: ['node', '--check', 'src/impl.mjs'], type: 'check' },
  { name: 'test', cmd: ['node', '--test', '--test-reporter=tap', 'test/suite.test.mjs'], type: 'test' },
];
const gateOpts = { verify: VERIFY, acceptanceFilter: (n) => n.startsWith('acc'), protectedPaths: ['test'], attempts: 2, perStepTimeoutMs: 12000 };
const TASK = { id: 'classify', spec: 'classify(n): low<0, mid 0..9, high>=10' };
const mkAuthor = (id, impl, opts = {}) => ({ id, isBaseline: !!opts.isBaseline, fn: async () => ({ files: { 'src/impl.mjs': impl }, approachTag: opts.tag }) });

const dirs = [];
async function repoWithSuite() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rw-'));
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
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {}); });

const baseOpts = (repo, authorFactory, extra = {}) => ({
  repoDir: repo, task: TASK, probeNames: PROBE_NAMES, gate: gateOpts, targetK: 3, authorFactory, ...extra,
});

test('EARNED STOP: three behaviourally-distinct greens in wave 1 => sufficient, one wave', async () => {
  const repo = await repoWithSuite();
  const factory = async ({ wave }) => (wave === 1
    ? [mkAuthor('A', IMPL.A, { isBaseline: true, tag: 'tagA' }), mkAuthor('C', IMPL.C, { tag: 'tagC' }), mkAuthor('D', IMPL.D, { tag: 'tagD' })]
    : []);
  const r = await runWaves(baseOpts(repo, factory, { maxWaves: 4 }));
  assert.equal(r.nWaves, 1);
  assert.equal(r.stoppedBecause, 'sufficient');
  assert.equal(r.dispersion.sufficient, true);
});

test('KEEP-EXPLORING: wave 1 falls short, wave 2 accumulates to sufficient; forbid-tags thread forward', async () => {
  const repo = await repoWithSuite();
  const seenCtx = [];
  const factory = async (ctx) => {
    seenCtx.push(ctx);
    if (ctx.wave === 1) return [mkAuthor('A', IMPL.A, { isBaseline: true, tag: 'tagA' }), mkAuthor('C', IMPL.C, { tag: 'tagC' })];
    if (ctx.wave === 2) return [mkAuthor('D', IMPL.D, { tag: 'tagD' })];
    return [];
  };
  const r = await runWaves(baseOpts(repo, factory, { maxWaves: 4 }));
  assert.equal(r.nWaves, 2);
  assert.equal(r.stoppedBecause, 'sufficient');
  assert.equal(r.waves[0].reason, 'keep-exploring');
  // accumulation: wave 2 re-gated A, C (replayed) + D
  assert.deepEqual(r.greens.map((g) => g.id).sort(), ['A', 'C', 'D']);
  // forbid-tags from wave 1's greens were handed to wave 2
  assert.deepEqual(seenCtx[1].forbidApproachTags.sort(), ['tagA', 'tagC']);
});

test('NON-DISCRIMINATING: clone greens stop immediately, even with waves left', async () => {
  const repo = await repoWithSuite();
  const factory = async ({ wave }) => (wave === 1
    ? [mkAuthor('A', IMPL.A, { isBaseline: true, tag: 'tagA' }), mkAuthor('B', IMPL.A, { tag: 'tagB' })] // same behaviour
    : [mkAuthor('D', IMPL.D, { tag: 'tagD' })]);
  const r = await runWaves(baseOpts(repo, factory, { maxWaves: 4 }));
  assert.equal(r.nWaves, 1);
  assert.equal(r.stoppedBecause, 'non-discriminating');
});

test('MAX-WAVES: perpetual keep-exploring is bounded by the wave ceiling', async () => {
  const repo = await repoWithSuite();
  // only ever 2 behaviour classes (A-like, C-like) -> effectiveN ~2 < targetK 5 forever
  const factory = async ({ wave }) => [
    mkAuthor(`A${wave}`, IMPL.A, { isBaseline: wave === 1, tag: 'tagA' }),
    mkAuthor(`C${wave}`, IMPL.C, { tag: 'tagC' }),
  ];
  const r = await runWaves(baseOpts(repo, factory, { targetK: 5, maxWaves: 3 }));
  assert.equal(r.nWaves, 3);
  assert.equal(r.stoppedBecause, 'max-waves');
  assert.ok(r.waves.every((w) => w.reason === 'keep-exploring'));
});

test('NO-GREEN: a cohort with no correct candidate keeps trying until the ceiling', async () => {
  const repo = await repoWithSuite();
  const factory = async ({ wave }) => [mkAuthor(`bad${wave}`, IMPL.BAD, { isBaseline: wave === 1 })];
  const r = await runWaves(baseOpts(repo, factory, { maxWaves: 2 }));
  assert.equal(r.decision, 'no-green');
  assert.equal(r.stoppedBecause, 'max-waves');
  assert.equal(r.nWaves, 2);
});

test('BUDGET: an injected shouldContinue guard stops the loop early', async () => {
  const repo = await repoWithSuite();
  const factory = async ({ wave }) => [
    mkAuthor(`A${wave}`, IMPL.A, { isBaseline: wave === 1, tag: 'tagA' }),
    mkAuthor(`C${wave}`, IMPL.C, { tag: 'tagC' }),
  ];
  const r = await runWaves(baseOpts(repo, factory, { targetK: 5, maxWaves: 9, shouldContinue: ({ wave }) => wave <= 2 }));
  assert.equal(r.stoppedBecause, 'budget');
  assert.equal(r.nWaves, 2, 'wave 1 + wave 2 ran, wave 3 gate refused');
});

// ---- keep-exploring stop rule (held-out probes) + sideways-look seed-diversity ----
const CLASSIFY = {
  A: (n) => (n <= 0 ? 'low' : n < 10 ? 'mid' : 'high'),
  C: (n) => (n < 0 ? 'low' : n < 10 ? 'mid' : 'high'),
  D: (n) => (n < -10 ? 'low' : n < 10 ? 'mid' : 'high'),
};
const MUT = [{ id: 'mut:neg20', input: -20 }, { id: 'mut:zero', input: 0 }, { id: 'mut:neg5', input: -5 }];
const behOf = (id) => id.replace(/[0-9]+$/, ''); // author ids encode behaviour: A1/A2 -> A
const diffRunner = (gs, ps) => {
  const ref = behOf([...gs].map((g) => g.id).sort()[0]);
  return gs.map((g) => ({ id: g.id, perProbe: Object.fromEntries(ps.map((p) => [p.id, CLASSIFY[behOf(g.id)](p.input) === CLASSIFY[ref](p.input) ? 'pass' : 'fail'])) }));
};

test('runWaves: plateau — wave 2 adds no NEW held-out signature => stops "plateau"', async () => {
  const repo = await repoWithSuite();
  // wave 1: A + C (2 distinct behaviours). wave 2: another A-clone (signature already seen) => no new key.
  const factory = async ({ wave }) => (wave === 1
    ? [mkAuthor('A1', IMPL.A, { isBaseline: true, tag: 'tagA' }), mkAuthor('C1', IMPL.C, { tag: 'tagC' })]
    : [mkAuthor(`A${wave}`, IMPL.A, { tag: 'tagA' })]);
  const r = await runWaves(baseOpts(repo, factory, { targetK: 5, maxWaves: 4, mutationProbes: MUT, runProbes: diffRunner }));
  assert.equal(r.stoppedBecause, 'plateau');
  assert.equal(r.nWaves, 2);
  assert.equal(r.waves[0].reason, 'keep-exploring', 'wave 1 still discovering');
});

test('runWaves: reviewCap HARD-stops a non-sufficient cohort even though held-out says keep-exploring', async () => {
  const repo = await repoWithSuite();
  const factory = async ({ wave }) => [mkAuthor(`A${wave}`, IMPL.A, { isBaseline: wave === 1, tag: 'tagA' }), mkAuthor(`C${wave}`, IMPL.C, { tag: 'tagC' })];
  // targetK 5 (never sufficient), 2 greens/wave; reviewCap 4 fires at wave 2 (4 accumulated) before plateau.
  const r = await runWaves(baseOpts(repo, factory, { targetK: 5, maxWaves: 9, reviewCap: 4, mutationProbes: MUT, runProbes: diffRunner }));
  assert.equal(r.stoppedBecause, 'review-cap');
  assert.ok(r.greens.length >= 4, 'stopped at the reviewable-slate cap');
});

test('runWaves: seedSpecs is passed to authorFactory on WAVE 1 ONLY (verbatim), empty after', async () => {
  const repo = await repoWithSuite();
  const seen = [];
  const factory = async (ctx) => {
    seen.push(ctx.seedSpecs);
    return ctx.wave === 1
      ? [mkAuthor('A1', IMPL.A, { isBaseline: true, tag: 'tagA' }), mkAuthor('C1', IMPL.C, { tag: 'tagC' })]
      : [mkAuthor(`D${ctx.wave}`, IMPL.D, { tag: 'tagD' })];
  };
  const specs = [{ tag: 'sideways:union-find', kind: 'sideways' }];
  await runWaves(baseOpts(repo, factory, { targetK: 9, maxWaves: 2, seedSpecs: specs }));
  assert.deepEqual(seen[0], specs, 'wave 1 received seedSpecs verbatim');
  assert.deepEqual(seen[1], [], 'wave 2 received empty seedSpecs (reactive forbid-tags take over)');
});

test('runWaves: a seeded author touching a PROTECTED test path is PRUNED — the seed is gated identically', async () => {
  const repo = await repoWithSuite();
  const saboteur = { id: 'S1', isBaseline: false, fn: async () => ({ files: { 'test/suite.test.mjs': 'export {}' }, approachTag: 'sideways:cheat' }) };
  const factory = async ({ wave }) => (wave === 1
    ? [mkAuthor('A1', IMPL.A, { isBaseline: true, tag: 'tagA' }), mkAuthor('C1', IMPL.C, { tag: 'tagC' }), saboteur]
    : []);
  const r = await runWaves(baseOpts(repo, factory, { targetK: 3, maxWaves: 1 }));
  assert.ok(!r.greens.some((g) => g.id === 'S1'), 'the sideways saboteur is pruned, never admitted green');
  assert.deepEqual(r.greens.map((g) => g.id).sort(), ['A1', 'C1']);
});

test('runWaves: a distinct seeded GREEN raises effectiveN vs an all-clone cohort (correct-diversity only)', async () => {
  const repo = await repoWithSuite();
  const clones = async ({ wave }) => (wave === 1 ? [mkAuthor('A1', IMPL.A, { isBaseline: true }), mkAuthor('A2', IMPL.A)] : []);
  const withSeed = async ({ wave }) => (wave === 1 ? [mkAuthor('A1', IMPL.A, { isBaseline: true }), mkAuthor('D1', IMPL.D, { tag: 'sideways:shifted' })] : []);
  const rc = await runWaves(baseOpts(repo, clones, { targetK: 5, maxWaves: 1 }));
  const rs = await runWaves(baseOpts(repo, withSeed, { targetK: 5, maxWaves: 1 }));
  assert.ok(rs.dispersion.effectiveN > rc.dispersion.effectiveN, `seed raises dispersion: ${rc.dispersion.effectiveN} -> ${rs.dispersion.effectiveN}`);
});

test('AR-HIGH: reviewRemaining is passed to authorFactory so a cooperating factory keeps the slate within the cap', async () => {
  const repo = await repoWithSuite();
  const seenRemaining = [];
  // A COOPERATING factory: spawns at most `reviewRemaining` fresh authors.
  const factory = async (ctx) => {
    seenRemaining.push(ctx.reviewRemaining);
    const want = [mkAuthor(`A${ctx.wave}`, IMPL.A, { isBaseline: ctx.wave === 1, tag: 'tagA' }), mkAuthor(`C${ctx.wave}`, IMPL.C, { tag: 'tagC' })];
    return want.slice(0, Math.max(0, ctx.reviewRemaining));
  };
  const r = await runWaves(baseOpts(repo, factory, { targetK: 9, maxWaves: 5, reviewCap: 3 }));
  assert.ok(r.greens.length <= 3, `cooperating factory + reviewRemaining keeps slate <= cap: got ${r.greens.length}`);
  assert.equal(seenRemaining[0], 3, 'wave 1 sees full budget');
});

test('AR-HIGH: a garbage reviewCap throws (must be a non-negative integer or Infinity)', async () => {
  const repo = await repoWithSuite();
  const factory = async () => [mkAuthor('A1', IMPL.A, { isBaseline: true })];
  await assert.rejects(runWaves(baseOpts(repo, factory, { reviewCap: -1 })), /non-negative integer/);
  await assert.rejects(runWaves(baseOpts(repo, factory, { reviewCap: 2.5 })), /non-negative integer/);
});

test('AR-HIGH confirm: a NON-cooperating factory is TRUNCATED in the lib — slate never exceeds reviewCap', async () => {
  const repo = await repoWithSuite();
  // factory IGNORES reviewRemaining and returns 3 distinct greens; reviewCap 2 must still bound the slate.
  const factory = async ({ wave }) => (wave === 1
    ? [mkAuthor('A1', IMPL.A, { isBaseline: true, tag: 'tagA' }), mkAuthor('C1', IMPL.C, { tag: 'tagC' }), mkAuthor('D1', IMPL.D, { tag: 'tagD' })]
    : []);
  const r = await runWaves(baseOpts(repo, factory, { targetK: 3, maxWaves: 2, reviewCap: 2 }));
  assert.ok(r.greens.length <= 2, `lib-enforced cap holds even when the factory ignores it: got ${r.greens.length}`);
  assert.equal(r.droppedToCap, 1, 'the over-budget author was dropped and surfaced (not silent)');
  // the baseline survives truncation (sorted first), so the floor is never lost
  assert.ok(r.greens.some((g) => g.id === 'A1'), 'baseline kept through truncation');
});

test('AR-HIGH confirm2: only prior GREENS are replayed — a wave-1 non-green never re-enters the gated cohort', async () => {
  const repo = await repoWithSuite();
  // wave 1: A + C (two distinct greens => keep-exploring) + BAD (non-green). wave 2: fresh D (green).
  const factory = async ({ wave }) => (wave === 1
    ? [mkAuthor('A1', IMPL.A, { isBaseline: true, tag: 'tagA' }), mkAuthor('C1', IMPL.C, { tag: 'tagC' }), mkAuthor('BAD1', IMPL.BAD)]
    : [mkAuthor('D2', IMPL.D, { tag: 'tagD' })]);
  const r = await runWaves(baseOpts(repo, factory, { targetK: 9, maxWaves: 2 }));
  // wave 1 gated 3 (A + C + BAD); wave 2 must gate only the 2 GREENS replayed (A, C) + fresh D = 3, NOT 4.
  assert.equal(r.waves[0].nAuthors, 3, 'wave 1 gated A + C + BAD');
  assert.equal(r.waves[1].nAuthors, 3, 'wave 2 replays the GREENS A,C only (BAD not re-gated), + fresh D');
  assert.deepEqual(r.greens.map((g) => g.id).sort(), ['A1', 'C1', 'D2']);
});

test('AR-HIGH confirm3: a NON-green baseline keeps producing baseline-not-green across waves (greens-only replay must not erase the failed floor)', async () => {
  const repo = await repoWithSuite();
  // wave 1: BASE (non-green baseline, fails acceptance) + A,C (two distinct greens => keep-exploring). wave 2: fresh D.
  const factory = async ({ wave }) => (wave === 1
    ? [mkAuthor('BASE', IMPL.BAD, { isBaseline: true }), mkAuthor('A1', IMPL.A, { tag: 'tagA' }), mkAuthor('C1', IMPL.C, { tag: 'tagC' })]
    : [mkAuthor('D2', IMPL.D, { tag: 'tagD' })]);
  const r = await runWaves(baseOpts(repo, factory, { targetK: 9, maxWaves: 2 }));
  assert.ok(r.nWaves >= 2, 'reached wave 2');
  // The failed-baseline floor signal must survive: B never greens, so the floor is gone -> human-gate, flagged.
  assert.ok(r.flags.includes('baseline-not-green'), 'the failed-baseline floor signal survives later waves');
  assert.equal(r.confidence, 'human-gate', 'floor lost => human-gate, never silently re-baselined to a green');
});

test('AR-HIGH confirm4: a fresh author REUSING a prior (realized) id is rejected — cannot impersonate the failed baseline', async () => {
  const repo = await repoWithSuite();
  const factory = async ({ wave }) => (wave === 1
    ? [mkAuthor('BASE', IMPL.BAD, { isBaseline: true }), mkAuthor('A1', IMPL.A, { tag: 'tagA' }), mkAuthor('C1', IMPL.C, { tag: 'tagC' })]
    : [mkAuthor('BASE', IMPL.C, { tag: 'cheat' })]); // wave 2 REUSES the failed baseline id, now green
  await assert.rejects(runWaves(baseOpts(repo, factory, { targetK: 9, maxWaves: 2 })), /unique across waves|reuses a prior/i);
});
