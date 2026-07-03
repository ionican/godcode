import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopDecision } from './stopRule.mjs';
import { dispersion, signatureFromResults } from './dispersion.mjs';

// Build a real dispersion() result from {id: 'pass'/'fail' per probe} rows over ordered probe names.
const dispFrom = (rows, probeNames, targetK = 3) =>
  dispersion(rows.map((r) => ({ id: r.id, signature: signatureFromResults(r.perProbe, probeNames) })), { targetK });

const PN = ['p1', 'p2', 'p3'];
// 3 behaviourally-DISTINCT greens (discriminating, effectiveN 3): A passes p1, B passes p2, C passes p3.
const threeDistinct = () => dispFrom([
  { id: 'A', perProbe: { p1: 'pass', p2: 'fail', p3: 'fail' } },
  { id: 'B', perProbe: { p1: 'fail', p2: 'pass', p3: 'fail' } },
  { id: 'C', perProbe: { p1: 'fail', p2: 'fail', p3: 'pass' } },
], PN, 3);
// 2 distinct greens (below targetK=3), each a singleton ⇒ high f1/n.
const twoDistinct = () => dispFrom([
  { id: 'A', perProbe: { p1: 'pass', p2: 'fail', p3: 'fail' } },
  { id: 'B', perProbe: { p1: 'fail', p2: 'pass', p3: 'fail' } },
], PN, 3);
// monoculture: 2 greens, identical signatures ⇒ NOT discriminating.
const monoculture = () => dispFrom([
  { id: 'A', perProbe: { p1: 'pass', p2: 'fail', p3: 'fail' } },
  { id: 'B', perProbe: { p1: 'pass', p2: 'fail', p3: 'fail' } },
], PN, 3);

test('review-cap fires FIRST — draws>=reviewCap with maximal deficit STILL stops review-cap', () => {
  const d = twoDistinct(); // f1=2, n=2 ⇒ f1/n=1 (maximal coverage deficit), below floor — would be keep-exploring
  const { reason } = stopDecision(d, new Set(), { measurable: true, draws: 5, reviewCap: 5 });
  assert.equal(reason, 'review-cap', 'the hard cap dominates the keep-exploring signal');
  // one under the cap: the signal is allowed through
  assert.equal(stopDecision(d, new Set(), { measurable: true, draws: 4, reviewCap: 5 }).reason, 'keep-exploring');
});

test('no-green when nominalN===0', () => {
  const { reason } = stopDecision(dispersion([], { targetK: 3 }), new Set(), { measurable: true });
  assert.equal(reason, 'no-green');
});

test('floor-only when the supplied signal is unmeasurable (defers to in-suite, never lowers the floor)', () => {
  const { reason } = stopDecision(threeDistinct(), new Set(), { measurable: false });
  assert.equal(reason, 'floor-only', 'unmeasured ⇒ defer; even an effectiveN≥K signal is not trusted');
  // default (measurable omitted) is the SAFE floor-only
  assert.equal(stopDecision(threeDistinct(), new Set(), {}).reason, 'floor-only');
});

test('floor-only when measurable but the probe set does not discriminate (monoculture)', () => {
  const { reason } = stopDecision(monoculture(), new Set(), { measurable: true });
  assert.equal(reason, 'floor-only');
});

test('sufficient-floor when effectiveN>=targetK (wins over plateau/coverage)', () => {
  const d = threeDistinct(); // effectiveN 3, targetK 3
  // even with prevKeys that would otherwise trigger plateau, the floor wins
  const prev = new Set(d.classes.map((c) => c.key));
  const { reason } = stopDecision(d, prev, { measurable: true });
  assert.equal(reason, 'sufficient-floor');
});

test('plateau-no-new-signature when a wave adds zero new keys (and one new key prevents it)', () => {
  const d = twoDistinct(); // below floor, discriminating
  const allSeen = new Set(d.classes.map((c) => c.key));
  assert.equal(stopDecision(d, allSeen, { measurable: true }).reason, 'plateau-no-new-signature');
  // drop one prior key ⇒ this wave contributes a "new" signature ⇒ not a plateau
  const minusOne = new Set([...allSeen].slice(1));
  assert.notEqual(stopDecision(d, minusOne, { measurable: true }).reason, 'plateau-no-new-signature');
});

test('coverage-saturated when f1/n<=epsilon (below floor, with a new signature)', () => {
  // 5 greens: 4 share one signature (a size-4 class), 1 singleton ⇒ f1=1, n=5, f1/n=0.2.
  const d = dispFrom([
    { id: 'A', perProbe: { p1: 'pass', p2: 'fail', p3: 'fail' } },
    { id: 'A2', perProbe: { p1: 'pass', p2: 'fail', p3: 'fail' } },
    { id: 'A3', perProbe: { p1: 'pass', p2: 'fail', p3: 'fail' } },
    { id: 'A4', perProbe: { p1: 'pass', p2: 'fail', p3: 'fail' } },
    { id: 'B', perProbe: { p1: 'fail', p2: 'pass', p3: 'fail' } },
  ], PN, 3); // distinctCount 2 (<targetK 3), discriminating, f1/n = 0.2
  assert.ok(d.effectiveN < 3, 'below the sufficiency floor');
  const { reason } = stopDecision(d, new Set(), { measurable: true, epsilon: 0.25 }); // 0.2 <= 0.25
  assert.equal(reason, 'coverage-saturated');
  // tighten epsilon below the deficit ⇒ keep exploring
  assert.equal(stopDecision(d, new Set(), { measurable: true, epsilon: 0.1 }).reason, 'keep-exploring');
});

test('keep-exploring: high deficit, new signatures, below floor, under cap', () => {
  const { reason } = stopDecision(twoDistinct(), new Set(), { measurable: true, epsilon: 0.15 });
  assert.equal(reason, 'keep-exploring'); // f1/n = 1 > 0.15, wave-1 (no prev), below floor
});

test('HONESTY: chao1/completeness ride in metrics but NEVER appear in a stop branch', () => {
  // Construct a cohort with high completeness but NOT saturated by f1/n, and below floor.
  const d = twoDistinct();
  const { reason, metrics } = stopDecision(d, new Set(), { measurable: true, epsilon: 0.15 });
  assert.ok('chao1' in metrics && 'completeness' in metrics, 'diagnostics are reported');
  // The decision must be driven by f1/n + plateau + floor only — never completeness. Forcing a high
  // completeness must NOT flip the reason away from keep-exploring.
  const dHighComplete = { ...d, completeness: 0.999, chao1: d.distinctCount };
  assert.equal(stopDecision(dHighComplete, new Set(), { measurable: true, epsilon: 0.15 }).reason, reason);
});

test('metrics always carries the full counter set incl. classKeys, even on no-green', () => {
  const { metrics } = stopDecision(dispersion([], { targetK: 3 }), new Set(), { measurable: true });
  for (const k of ['f1', 'f2', 'effectiveN', 'coverage', 'chao1', 'completeness', 'classKeys', 'measurable']) {
    assert.ok(k in metrics, `metrics.${k} present`);
  }
  assert.deepEqual(metrics.classKeys, []);
});

test('targetK from opts overrides disp.targetK', () => {
  const d = threeDistinct(); // effectiveN 3
  // raise the floor to 4 ⇒ no longer sufficient ⇒ falls through to coverage/keep (f1/n=1 here)
  assert.notEqual(stopDecision(d, new Set(), { measurable: true, targetK: 4 }).reason, 'sufficient-floor');
});

test('AR-MED: an out-of-range epsilon throws (must be finite in [0,1)) — coverageEpsilon:1 cannot force coverage-saturated', () => {
  const d = twoDistinct();
  assert.throws(() => stopDecision(d, new Set(), { measurable: true, epsilon: 1 }), /\[0,1\)/);
  assert.throws(() => stopDecision(d, new Set(), { measurable: true, epsilon: -0.1 }), /\[0,1\)/);
  assert.throws(() => stopDecision(d, new Set(), { measurable: true, epsilon: Infinity }), /\[0,1\)/);
  // epsilon === 0 is valid (exact saturation only)
  assert.doesNotThrow(() => stopDecision(d, new Set(), { measurable: true, epsilon: 0 }));
});
