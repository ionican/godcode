// End-to-end: fan out candidates -> gate each (out-of-band) -> measure G1 dispersion
// over the GREEN survivors' per-test verifier behaviour. Proves the two primitives
// compose: the gate emits per-test results; dispersion turns them into effective-N.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gateRunner, runCmd } from './gate-runner.mjs';
import { dispersion, signatureFromResults } from './dispersion.mjs';

const SUITE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/impl.mjs';
test('acc: mid', () => assert.equal(classify(5), 'mid'));
test('acc: high', () => assert.equal(classify(50), 'high'));
test('probe: zero', () => assert.equal(classify(0), 'mid'));
test('probe: neg', () => assert.equal(classify(-5), 'low'));
test('probe: big', () => assert.equal(classify(1000), 'high'));
`;
// All four pass ACCEPTANCE (classify(5)=mid, classify(50)=high) but differ on edge PROBES.
const IMPL = {
  A: `export function classify(n){ return n <= 0 ? 'low' : n < 10 ? 'mid' : 'high'; }`, // wrong at 0
  B: `export function classify(n){ return n <= 0 ? 'low' : n < 10 ? 'mid' : 'high'; }`, // identical behaviour to A
  C: `export function classify(n){ return n < 0 ? 'low' : n < 10 ? 'mid' : 'high'; }`,  // correct on all probes
  D: `export function classify(n){ return n < -10 ? 'low' : n < 10 ? 'mid' : 'high'; }`, // wrong at -5
};
const PROBE_NAMES = ['probe: zero', 'probe: neg', 'probe: big'];

const dirs = [];
async function makeRepo(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gr-int-'));
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
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {}); });

test('fan-out -> gate -> G1 dispersion exposes effective-N (clones collapse)', async () => {
  const repo = await makeRepo({ 'src/impl.mjs': IMPL.C, 'test/suite.test.mjs': SUITE });
  const verify = [
    { name: 'build', cmd: ['node', '--check', 'src/impl.mjs'], type: 'check' },
    { name: 'test', cmd: ['node', '--test', '--test-reporter=tap', 'test/suite.test.mjs'], type: 'test' },
  ];
  const opts = (id) => ({
    repoDir: repo,
    candidate: { id, files: { 'src/impl.mjs': IMPL[id] } },
    verify,
    acceptanceFilter: (n) => n.startsWith('acc'),
    protectedPaths: ['test'],
    attempts: 2,
    perStepTimeoutMs: 12000,
  });

  const gated = [];
  for (const id of ['A', 'B', 'C', 'D']) gated.push(await gateRunner(opts(id)));

  // every candidate is GREEN (all pass acceptance), so selection can't lean on the gate alone
  assert.ok(gated.every((g) => g.gate === 'green'), gated.map((g) => `${g.candidateId}:${g.gate}`).join(' '));

  const greens = gated.map((g) => ({ id: g.candidateId, signature: signatureFromResults(g.perTest, PROBE_NAMES) }));
  // designed verifier-behaviour signatures over [zero, neg, big]
  assert.deepEqual(greens.find((g) => g.id === 'A').signature, [false, true, true]);
  assert.deepEqual(greens.find((g) => g.id === 'B').signature, [false, true, true]);
  assert.deepEqual(greens.find((g) => g.id === 'C').signature, [true, true, true]);
  assert.deepEqual(greens.find((g) => g.id === 'D').signature, [true, false, true]);

  const d = dispersion(greens, { targetK: 3 });
  assert.equal(d.nominalN, 4);
  assert.equal(d.distinctCount, 3, 'A and B collapse to one behavioural class');
  assert.ok(d.effectiveN > 2.8 && d.effectiveN < 2.86, `effectiveN ${d.effectiveN}`);
  assert.equal(d.discriminating, true);
  assert.deepEqual(d.modalClass.members.sort(), ['A', 'B'], 'modal class = the clone pair');

  // anti-dive: nominal N=4 but effective ~2.83 — NOT 4 independent solutions.
  assert.equal(d.sufficient, false, 'effectiveN 2.83 < targetK 3 => keep exploring');
  assert.equal(dispersion(greens, { targetK: 2 }).sufficient, true);
});

test('full monoculture (all branches converge) => dispersion unmeasurable, never "sufficient"', async () => {
  const repo = await makeRepo({ 'src/impl.mjs': IMPL.C, 'test/suite.test.mjs': SUITE });
  const verify = [{ name: 'test', cmd: ['node', '--test', '--test-reporter=tap', 'test/suite.test.mjs'], type: 'test' }];
  const gated = [];
  for (const id of ['A', 'B']) {
    gated.push(await gateRunner({
      repoDir: repo, candidate: { id, files: { 'src/impl.mjs': IMPL[id] } }, verify,
      acceptanceFilter: (n) => n.startsWith('acc'), protectedPaths: ['test'], attempts: 2, perStepTimeoutMs: 12000,
    }));
  }
  const greens = gated.map((g) => ({ id: g.candidateId, signature: signatureFromResults(g.perTest, PROBE_NAMES) }));
  const d = dispersion(greens, { targetK: 1 });
  assert.equal(d.effectiveN, 1);
  assert.equal(d.discriminating, false, 'identical verifier behaviour => no measurable diversity');
  assert.equal(d.sufficient, false, 'must not be read as convergence/coverage even at K=1');
});
