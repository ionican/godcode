import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispersion, hammingDistance, signatureFromResults } from './dispersion.mjs';

const c = (id, signature) => ({ id, signature });
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('hammingDistance counts differing bits and rejects length mismatch', () => {
  assert.equal(hammingDistance([true, false, true], [true, true, true]), 1);
  assert.equal(hammingDistance([false, false], [true, true]), 2);
  assert.throws(() => hammingDistance([true], [true, false]));
});

test('signatureFromResults: missing => fail', () => {
  const sig = signatureFromResults({ a: 'pass', b: 'fail' }, ['a', 'b', 'c']);
  assert.deepEqual(sig, [true, false, false]);
});

test('empty cohort => zeroes, not discriminating, not sufficient', () => {
  const r = dispersion([]);
  assert.equal(r.nominalN, 0);
  assert.equal(r.effectiveN, 0);
  assert.equal(r.discriminating, false);
  assert.equal(r.sufficient, false);
  assert.equal(r.modalClass, null);
});

test('single candidate => effectiveN 1, not discriminating', () => {
  const r = dispersion([c('x', [true, false, true])]);
  assert.equal(r.nominalN, 1);
  assert.equal(r.distinctCount, 1);
  assert.equal(r.effectiveN, 1);
  assert.equal(r.discriminating, false);
  assert.equal(r.dispersion, 0);
});

test('all-identical signatures => monoculture: effectiveN 1, NOT discriminating', () => {
  const sig = [true, true, false, false];
  const r = dispersion([c('a', sig), c('b', [...sig]), c('c', [...sig])]);
  assert.equal(r.distinctCount, 1);
  assert.equal(r.effectiveN, 1);
  assert.equal(r.dispersion, 0);
  assert.equal(r.discriminating, false, 'identical vectors do not discriminate');
  assert.equal(r.sufficient, false);
  assert.deepEqual(r.modalClass.members.sort(), ['a', 'b', 'c']);
});

test('all-distinct => effectiveN === N, dispersion 1, discriminating', () => {
  const r = dispersion([
    c('a', [true, false, false]),
    c('b', [false, true, false]),
    c('c', [false, false, true]),
  ]);
  assert.equal(r.distinctCount, 3);
  assert.ok(approx(r.effectiveN, 3), `effectiveN ${r.effectiveN}`);
  assert.ok(approx(r.dispersion, 1));
  assert.equal(r.discriminating, true);
});

test('skewed {5,1} => distinctCount 2 but effectiveN ~1.57 (near-monoculture exposed)', () => {
  const majority = [true, true, false];
  const cands = [];
  for (let i = 0; i < 5; i++) cands.push(c(`m${i}`, [...majority]));
  cands.push(c('odd', [false, false, true]));
  const r = dispersion(cands);
  assert.equal(r.distinctCount, 2);
  // exp(-(5/6 ln 5/6 + 1/6 ln 1/6)) ≈ 1.5719
  assert.ok(r.effectiveN > 1.5 && r.effectiveN < 1.65, `effectiveN ${r.effectiveN}`);
  assert.equal(r.discriminating, true);
  assert.deepEqual(r.modalClass.members.sort(), ['m0', 'm1', 'm2', 'm3', 'm4']);
  assert.equal(r.modalClass.size, 5);
});

test('sufficiency: effectiveN >= targetK AND discriminating', () => {
  const distinct3 = [
    c('a', [true, false, false]),
    c('b', [false, true, false]),
    c('c', [false, false, true]),
  ];
  assert.equal(dispersion(distinct3, { targetK: 3 }).sufficient, true);
  assert.equal(dispersion(distinct3, { targetK: 4 }).sufficient, false);
  // skewed: distinctCount 2 but effectiveN < 2, so targetK 2 is NOT met by effectiveN
  const skew = [c('a', [true, false]), c('b', [true, false]), c('c', [false, true])];
  const r = dispersion(skew, { targetK: 2 });
  assert.equal(r.distinctCount, 2);
  assert.ok(r.effectiveN < 2);
  assert.equal(r.sufficient, false, 'skew-aware: 2 distinct but effectively <2 is not sufficient');
});

test('non-discriminating forces sufficient=false even at high targetK=1', () => {
  const sig = [true, false];
  const r = dispersion([c('a', sig), c('b', [...sig])], { targetK: 1 });
  assert.equal(r.discriminating, false);
  assert.equal(r.sufficient, false, 'no measured diversity => never sufficient, even K=1');
});

test('epsilon tolerates a single flaky-probe flip (single-linkage merge)', () => {
  const base = [true, true, true, false];
  const flip = [true, true, false, false]; // 1 bit from base
  const far = [false, false, false, true];
  const exact = dispersion([c('a', base), c('b', flip), c('c', far)], { epsilon: 0 });
  assert.equal(exact.distinctCount, 3);
  const merged = dispersion([c('a', base), c('b', flip), c('c', far)], { epsilon: 1 });
  assert.equal(merged.distinctCount, 2, 'a and b within epsilon merge; far stays separate');
});

test('epsilon uses complete-linkage: a chain a~b~c (d(a,c)=2) does NOT collapse to one class', () => {
  // single-linkage would merge all three transitively; complete-linkage must not.
  const s1 = [true, true, true];   // '111'
  const s2 = [true, true, false];  // '110' — 1 from s1
  const s3 = [true, false, false]; // '100' — 1 from s2, 2 from s1
  const r = dispersion([c('s1', s1), c('s2', s2), c('s3', s3)], { epsilon: 1 });
  assert.equal(r.distinctCount, 2, 'chain endpoints differ by 2 > epsilon, so not one class');
});

// ---- property tests over random cohorts ----
test('properties: 1 <= effectiveN <= distinctCount <= N; permutation-invariant', () => {
  // deterministic PRNG (no Math.random reliance on determinism needed, but keep stable)
  let seed = 1234567;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let trial = 0; trial < 200; trial++) {
    const n = 1 + Math.floor(rnd() * 8);
    const L = 1 + Math.floor(rnd() * 6);
    const cands = [];
    for (let i = 0; i < n; i++) {
      cands.push(c(`c${i}`, Array.from({ length: L }, () => rnd() < 0.5)));
    }
    const r = dispersion(cands);
    assert.ok(r.effectiveN >= 1 - 1e-9 || n === 0, `effectiveN ${r.effectiveN} < 1`);
    assert.ok(r.effectiveN <= r.distinctCount + 1e-9, 'effectiveN <= distinctCount');
    assert.ok(r.distinctCount <= n, 'distinctCount <= N');
    assert.ok(r.dispersion >= -1e-9 && r.dispersion <= 1 + 1e-9, `dispersion ${r.dispersion}`);
    // permutation invariance of the scalar measures
    const shuffled = [...cands].reverse();
    const r2 = dispersion(shuffled);
    assert.ok(approx(r.effectiveN, r2.effectiveN, 1e-9), 'effectiveN permutation-invariant');
    assert.equal(r.distinctCount, r2.distinctCount, 'distinctCount permutation-invariant');
    assert.equal(r.discriminating, r2.discriminating);
  }
});

test('property: adding a duplicate of an existing class never increases effectiveN', () => {
  const cands = [
    c('a', [true, false, false]),
    c('b', [false, true, false]),
    c('c', [false, false, true]),
  ];
  const before = dispersion(cands).effectiveN;
  const after = dispersion([...cands, c('a2', [true, false, false])]).effectiveN;
  assert.ok(after <= before + 1e-9, `dup should not raise effectiveN: ${before} -> ${after}`);
});

test('length mismatch across candidates throws', () => {
  assert.throws(() => dispersion([c('a', [true, false]), c('b', [true])]));
});

// --- Good-Turing / Chao counters (keep-exploring stop-rule inputs) ---

const A = [true, false, false], B = [false, true, false], C2 = [false, false, true], D = [true, true, false];

test('counters: {5,1} class-size dist => f1=1, f2=0, coverage=1-1/6', () => {
  const cands = [c('a', A), c('a2', A), c('a3', A), c('a4', A), c('a5', A), c('b', B)]; // sizes {5,1}
  const r = dispersion(cands);
  assert.equal(r.f1, 1);
  assert.equal(r.f2, 0);
  assert.ok(approx(r.coverage, 1 - 1 / 6), `coverage ${r.coverage}`);
  // f2===0 branch: chao1 = distinctCount + f1*(f1-1)/2 = 2 + 0 = 2
  assert.ok(approx(r.chao1, 2));
  assert.ok(approx(r.completeness, 1));
});

test('counters: {2,2,1,1} => f1=2, f2=2, chao1 uses f1^2/(2f2)', () => {
  const cands = [c('a', A), c('a2', A), c('b', B), c('b2', B), c('c', C2), c('d', D)]; // sizes {2,2,1,1}
  const r = dispersion(cands);
  assert.equal(r.f1, 2);
  assert.equal(r.f2, 2);
  assert.ok(approx(r.coverage, 1 - 2 / 6), `coverage ${r.coverage}`);
  // f2>0 branch: chao1 = 4 + 2^2/(2*2) = 5; completeness = 4/5
  assert.ok(approx(r.chao1, 5));
  assert.ok(approx(r.completeness, 0.8));
});

test('counters: monoculture (all identical) => f1=0, coverage=1, completeness=1', () => {
  const r = dispersion([c('a', A), c('b', A), c('d', A)]); // one class of size 3
  assert.equal(r.f1, 0);
  assert.equal(r.f2, 0);
  assert.ok(approx(r.coverage, 1));
  assert.ok(approx(r.completeness, 1));
});

test('counters: empty cohort early-return carries f1=0, coverage=0, completeness=1', () => {
  const r = dispersion([]);
  assert.equal(r.f1, 0);
  assert.equal(r.f2, 0);
  assert.equal(r.coverage, 0);
  assert.equal(r.chao1, 0);
  assert.equal(r.completeness, 1);
});

test('counters: completeness is always in (0,1]', () => {
  for (const cands of [
    [c('a', A)],
    [c('a', A), c('b', B)],
    [c('a', A), c('a2', A), c('b', B), c('b2', B), c('c', C2), c('d', D)],
  ]) {
    const r = dispersion(cands);
    assert.ok(r.completeness > 0 && r.completeness <= 1 + 1e-9, `completeness ${r.completeness}`);
  }
});
