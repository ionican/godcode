import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateMutationProbes, runMutationProbes, validateMutationRows,
} from './mutation-probes.mjs';

// ---------------------------------------------------------------------------
// generateMutationProbes — deterministic, type-directed, deduped.
// ---------------------------------------------------------------------------

const opsOf = (probes) => probes.map((p) => p.op);

test('generator: number base yields zero/negate/inc/dec', () => {
  const p = generateMutationProbes([{ id: 'n', input: 5 }]);
  assert.deepEqual(opsOf(p).sort(), ['dec', 'inc', 'negate', 'zero']);
  assert.deepEqual(p.find((x) => x.op === 'zero').input, 0);
  assert.deepEqual(p.find((x) => x.op === 'negate').input, -5);
  assert.deepEqual(p.find((x) => x.op === 'inc').input, 6);
  assert.deepEqual(p.find((x) => x.op === 'dec').input, 4);
  assert.ok(p.every((x) => x.derivedFrom === 'n'));
});

test('generator: boundary base 0 drops self-equal mutations (zero, -0) keeps inc/dec', () => {
  const p = generateMutationProbes([{ id: 'z', input: 0 }]);
  assert.deepEqual(opsOf(p).sort(), ['dec', 'inc']);
  assert.deepEqual(p.find((x) => x.op === 'inc').input, 1);
  assert.deepEqual(p.find((x) => x.op === 'dec').input, -1);
});

test('generator: boolean base yields flip only', () => {
  const p = generateMutationProbes([{ id: 'b', input: true }]);
  assert.deepEqual(opsOf(p), ['flip']);
  assert.equal(p[0].input, false);
});

test('generator: string base yields empty/double/reverse, deduped on palindrome', () => {
  const p = generateMutationProbes([{ id: 's', input: 'ab' }]);
  assert.deepEqual(opsOf(p).sort(), ['double', 'empty', 'reverse']);
  // palindrome: reverse == original -> dropped, leaving empty + double only
  const pal = generateMutationProbes([{ id: 's', input: 'aa' }]);
  assert.deepEqual(opsOf(pal).sort(), ['double', 'empty']);
  // empty string: every mutation collapses to '' == original -> zero probes
  assert.deepEqual(generateMutationProbes([{ id: 's', input: '' }]), []);
});

test('generator: array base yields empty/reverse/dropFirst/duplicate; [] yields none', () => {
  const p = generateMutationProbes([{ id: 'a', input: [1, 2, 3] }]);
  assert.deepEqual(opsOf(p).sort(), ['dropFirst', 'duplicate', 'empty', 'reverse']);
  assert.deepEqual(p.find((x) => x.op === 'duplicate').input, [1, 2, 3, 1, 2, 3]);
  assert.deepEqual(p.find((x) => x.op === 'reverse').input, [3, 2, 1]);
  assert.deepEqual(p.find((x) => x.op === 'dropFirst').input, [2, 3]);
  assert.deepEqual(generateMutationProbes([{ id: 'a', input: [] }]), []);
});

test('generator: object base nulls then drops each key', () => {
  const p = generateMutationProbes([{ id: 'o', input: { a: 1, b: 2 } }]);
  assert.deepEqual(opsOf(p).sort(), ['drop:a', 'drop:b', 'null:a', 'null:b']);
  assert.deepEqual(p.find((x) => x.op === 'null:a').input, { a: null, b: 2 });
  assert.deepEqual(p.find((x) => x.op === 'drop:a').input, { b: 2 });
});

test('generator: deterministic across calls (no RNG / no Date)', () => {
  const base = [{ id: 'n', input: 7 }, { id: 'a', input: [1, 1, 2] }, { id: 'o', input: { x: true } }];
  assert.deepEqual(generateMutationProbes(base), generateMutationProbes(base));
});

test('generator: ids are unique and namespaced by prefix; collisions disambiguated', () => {
  // two bases with the SAME explicit id force a prefix:id:op collision -> '#seq' suffix
  const p = generateMutationProbes([{ id: 'dup', input: 3 }, { id: 'dup', input: 9 }], { prefix: 'mx' });
  const ids = p.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'all ids unique');
  assert.ok(ids.every((id) => id.startsWith('mx:dup:')));
  assert.ok(ids.some((id) => id.includes('#')), 'collision was disambiguated');
});

test('generator: raw (unwrapped) inputs indexed by position', () => {
  const p = generateMutationProbes([5, true]);
  assert.ok(p.some((x) => x.derivedFrom === '0' && x.op === 'zero'));
  assert.ok(p.some((x) => x.derivedFrom === '1' && x.op === 'flip'));
});

test('generator: rejects non-array baseInputs', () => {
  assert.throws(() => generateMutationProbes('nope'), /must be an array/);
});

// ---------------------------------------------------------------------------
// runMutationProbes — MEASUREMENT-ONLY label.
// ---------------------------------------------------------------------------

const greens = (...ids) => ids.map((id) => ({ id }));
// runner where each green's verdict on a probe is decided by a table fn(greenId, probeId)
const tableRunner = (fn) => (gs, ps) => gs.map((g) => ({
  id: g.id, perProbe: Object.fromEntries(ps.map((p) => [p.id, fn(g.id, p.id)])),
}));
const probes2 = [{ id: 'p1' }, { id: 'p2' }];

test('run: <2 greens / no probes / no runner degrade to unmeasurable with a reason', async () => {
  assert.deepEqual(
    await runMutationProbes({ greens: [], probes: probes2, runner: tableRunner(() => 'pass') }),
    { measurable: false, dispersionState: 'unmeasurable', reason: 'no-green', dispersion: null, perGreen: null },
  );
  assert.equal((await runMutationProbes({ greens: greens('A'), probes: probes2, runner: tableRunner(() => 'pass') })).reason, 'single-green');
  assert.equal((await runMutationProbes({ greens: greens('A', 'B'), probes: [], runner: tableRunner(() => 'pass') })).reason, 'no-probes');
  assert.equal((await runMutationProbes({ greens: greens('A', 'B'), probes: probes2 })).reason, 'no-runner');
});

test('run: greens identical on probes => converged (measured, no diversity on the supplied probes)', async () => {
  const r = await runMutationProbes({ greens: greens('A', 'B', 'C'), probes: probes2, runner: tableRunner(() => 'pass') });
  assert.equal(r.measurable, true);
  assert.equal(r.dispersionState, 'converged');
  assert.equal(r.dispersion.discriminating, false);
  assert.equal(r.perGreen.length, 3);
});

test('run: a probe column that splits the greens => diverse', async () => {
  // p1 separates A (fail) from B,C (pass); p2 all pass
  const r = await runMutationProbes({
    greens: greens('A', 'B', 'C'), probes: probes2,
    runner: tableRunner((gid, pid) => (pid === 'p1' && gid === 'A' ? 'fail' : 'pass')),
  });
  assert.equal(r.dispersionState, 'diverse');
  assert.equal(r.dispersion.discriminating, true);
  assert.equal(r.measurable, true);
});

test('run: return shape carries NO rank/winner/decision — it cannot feed the floor', async () => {
  const r = await runMutationProbes({ greens: greens('A', 'B'), probes: probes2, runner: tableRunner(() => 'pass') });
  assert.deepEqual(Object.keys(r).sort(), ['dispersion', 'dispersionState', 'measurable', 'perGreen', 'reason']);
  for (const k of ['winner', 'decision', 'pick', 'rank', 'confidence', 'ship']) assert.ok(!(k in r), `must not expose ${k}`);
});

test('run: probe "fail" never drops a green — every admitted id is still measured', async () => {
  // A fails BOTH probes; it must still appear in perGreen (measurement-only, never pruned)
  const r = await runMutationProbes({
    greens: greens('A', 'B'), probes: probes2,
    runner: tableRunner((gid) => (gid === 'A' ? 'fail' : 'pass')),
  });
  assert.deepEqual(r.perGreen.map((p) => p.id).sort(), ['A', 'B']);
  assert.deepEqual(r.perGreen.find((p) => p.id === 'A').signature, [false, false]);
});

test('run: determinism — same inputs, same label', async () => {
  const args = { greens: greens('A', 'B', 'C'), probes: probes2, runner: tableRunner((gid, pid) => (pid === 'p1' && gid === 'C' ? 'fail' : 'pass')) };
  const a = await runMutationProbes(args);
  const b = await runMutationProbes(args);
  assert.deepEqual({ s: a.dispersionState, n: a.dispersion.effectiveN }, { s: b.dispersionState, n: b.dispersion.effectiveN });
});

// ---------------------------------------------------------------------------
// Structural setup errors THROW (caller bugs) — even when greens<2 (validated first).
// ---------------------------------------------------------------------------

test('run: probes not an array throws', async () => {
  await assert.rejects(runMutationProbes({ greens: greens('A', 'B'), probes: 'x', runner: tableRunner(() => 'pass') }), /probes must be an array/);
});

test('run: empty/non-string probe id throws', async () => {
  await assert.rejects(runMutationProbes({ greens: greens('A', 'B'), probes: [{ id: '' }], runner: tableRunner(() => 'pass') }), /non-empty string id/);
  await assert.rejects(runMutationProbes({ greens: greens('A', 'B'), probes: [{ id: 5 }], runner: tableRunner(() => 'pass') }), /non-empty string id/);
});

test('run: duplicate probe id throws', async () => {
  await assert.rejects(runMutationProbes({ greens: greens('A', 'B'), probes: [{ id: 'p1' }, { id: 'p1' }], runner: tableRunner(() => 'pass') }), /duplicate probe id/);
});

test('run: probe id colliding with an acceptance/gate id throws (HELD-OUT invariant)', async () => {
  await assert.rejects(
    runMutationProbes({ greens: greens('A', 'B'), probes: [{ id: 'acc: high' }], acceptanceIds: ['acc: high', 'build'], runner: tableRunner(() => 'pass') }),
    /must be HELD-OUT/,
  );
});

test('run: structural probe-set error throws even with <2 greens (validated before degrade)', async () => {
  await assert.rejects(
    runMutationProbes({ greens: [], probes: [{ id: 'p1' }, { id: 'p1' }], runner: tableRunner(() => 'pass') }),
    /duplicate probe id/,
    'dup id must throw, not silently return no-green',
  );
});

// ---------------------------------------------------------------------------
// validateMutationRows — untrusted runner output is guarded.
// ---------------------------------------------------------------------------

test('validateMutationRows: accepts a well-formed matrix, returns a Map', () => {
  const m = validateMutationRows(
    [{ id: 'A', perProbe: { p1: 'pass', p2: 'fail' } }, { id: 'B', perProbe: { p1: 'fail', p2: 'pass' } }],
    ['A', 'B'], ['p1', 'p2'],
  );
  assert.equal(m.get('A').p1, 'pass');
  assert.equal(m.get('B').p2, 'pass');
});

test('validateMutationRows: missing row / extra row / duplicate row / bad value all throw', () => {
  assert.throws(() => validateMutationRows([{ id: 'A', perProbe: { p1: 'pass' } }], ['A', 'B'], ['p1']), /exactly one row per green/);
  assert.throws(() => validateMutationRows([{ id: 'A', perProbe: { p1: 'pass' } }, { id: 'Z', perProbe: { p1: 'pass' } }], ['A'], ['p1']), /unexpected \/ non-green/);
  assert.throws(() => validateMutationRows([{ id: 'A', perProbe: { p1: 'pass' } }, { id: 'A', perProbe: { p1: 'fail' } }], ['A'], ['p1']), /DUPLICATE row/);
  assert.throws(() => validateMutationRows([{ id: 'A', perProbe: { p1: 'maybe' } }], ['A'], ['p1']), /invalid\/missing result/);
  assert.throws(() => validateMutationRows([{ id: 'A', perProbe: {} }], ['A'], ['p1']), /invalid\/missing result/);
  assert.throws(() => validateMutationRows('nope', ['A'], ['p1']), /must return an array/);
});

test('run: a buggy runner (missing a probe verdict) surfaces as a throw, not a fake signature', async () => {
  await assert.rejects(
    runMutationProbes({ greens: greens('A', 'B'), probes: probes2, runner: () => [{ id: 'A', perProbe: { p1: 'pass' } }, { id: 'B', perProbe: { p1: 'pass', p2: 'pass' } }] }),
    /invalid\/missing result for probe "p2"/,
  );
});

test('AR-MED2: validateMutationRows rejects INHERITED perProbe verdicts (no prototype-pollution fake signature)', () => {
  // a runner whose perProbe carries verdicts only on the prototype must NOT pass — own props required
  const polluted = Object.create({ p1: 'pass', p2: 'fail' });
  assert.throws(() => validateMutationRows([{ id: 'A', perProbe: polluted }], ['A'], ['p1', 'p2']), /invalid\/missing result/);
  // a genuine own-prop matrix still passes, and the returned verdicts are own-only (null-prototype)
  const ok = validateMutationRows([{ id: 'A', perProbe: { p1: 'pass', p2: 'fail' } }], ['A'], ['p1', 'p2']);
  assert.equal(Object.getPrototypeOf(ok.get('A')), null);
  assert.equal(ok.get('A').p1, 'pass');
});

test('AR-MED2 (end-to-end): a runner returning prototype-only verdicts throws, never a fabricated diverse/converged label', async () => {
  const protoRunner = (gs, ps) => gs.map((g) => ({ id: g.id, perProbe: Object.create(Object.fromEntries(ps.map((p) => [p.id, 'pass']))) }));
  await assert.rejects(runMutationProbes({ greens: greens('A', 'B'), probes: probes2, runner: protoRunner }), /invalid\/missing result/);
});

test('AR-LOW4: generator is TOTAL on unsupported types (bigint/symbol/undefined) — no crash, no mutations', () => {
  assert.deepEqual(generateMutationProbes([1n]), []);
  assert.deepEqual(generateMutationProbes([Symbol('s')]), []);
  assert.deepEqual(generateMutationProbes([undefined]), []);
  // and a bigint mixed with a real base still yields the real base's probes deterministically
  const p = generateMutationProbes([{ id: 'big', input: 9n }, { id: 'n', input: 2 }]);
  assert.ok(p.every((x) => x.derivedFrom === 'n'));
  assert.deepEqual(generateMutationProbes([{ id: 'big', input: 9n }, { id: 'n', input: 2 }]), p);
});
