import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gateRunner, runCmd, parseTap, parseTapDetailed, tapComplete } from './gate-runner.mjs';

// ---- toy repo helpers ----
const SUITE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sum, classify } from '../src/impl.mjs';
test('acc: sum adds', () => { assert.equal(sum(2, 3), 5); });
test('acc: classify nonneg', () => { assert.equal(classify(1), 'nonneg'); });
test('probe: classify zero', () => { assert.equal(classify(0), 'nonneg'); });
test('probe: classify neg', () => { assert.equal(classify(-1), 'neg'); });
`;
const IMPL_OK = `export function sum(a, b) { return a + b; }
export function classify(n) { return n >= 0 ? 'nonneg' : 'neg'; }
`;
const IMPL_ACC_FAIL = `export function sum(a, b) { return a - b; }
export function classify(n) { return n >= 0 ? 'nonneg' : 'neg'; }
`;
const IMPL_SYNTAX = `export function sum(a, b) { return a + ; }
`;
const IMPL_HANG = `while (true) {}
export function sum(a, b) { return a + b; }
export function classify(n) { return n >= 0 ? 'nonneg' : 'neg'; }
`;

const repos = [];
async function makeRepo(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gr-repo-'));
  repos.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(dir, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content);
  }
  assert.equal((await runCmd('git', ['init', '-q'], { cwd: dir })).exit, 0, 'git init');
  assert.equal((await runCmd('git', ['add', '-A'], { cwd: dir })).exit, 0, 'git add');
  const commit = await runCmd('git', ['-c', 'user.email=ci@local', '-c', 'user.name=ci', 'commit', '-q', '-m', 'init'], { cwd: dir });
  assert.equal(commit.exit, 0, `git commit: ${commit.stderr}`);
  return dir;
}

const VERIFY = [
  { name: 'build', cmd: ['node', '--check', 'src/impl.mjs'], type: 'check' },
  { name: 'test', cmd: ['node', '--test', '--test-reporter=tap', 'test/suite.test.mjs'], type: 'test' },
];
const baseOpts = (repoDir, candidate, extra = {}) => ({
  repoDir,
  candidate,
  verify: VERIFY,
  acceptanceFilter: (n) => n.startsWith('acc'),
  protectedPaths: ['test', 'package.json', '.github'],
  attempts: 2,
  perStepTimeoutMs: 12000,
  ...extra,
});

after(async () => {
  for (const d of repos) await rm(d, { recursive: true, force: true }).catch(() => {});
});

test('parseTap parses ok / not ok lines', () => {
  const m = parseTap('TAP version 13\nok 1 - acc: a\nnot ok 2 - probe: b\n1..2\n');
  assert.deepEqual(m, { 'acc: a': 'pass', 'probe: b': 'fail' });
  assert.equal(parseTap('no tap here'), null);
});

// vitest rides the EXISTING TAP path — but ONLY via `--reporter=tap-flat`. vitest's plain `tap`
// reporter is nested PARENT-BEFORE-children (the inverse of node:test) with `# time=` directives +
// YAML diagnostic blocks, which parseTapDetailed (built for node:test's children-before-parent order)
// mis-counts. `tap-flat` emits a flat `1..N` with ` > `-joined names that parses cleanly. This fixture
// is real captured vitest tap-flat output — locks the right reporter choice in as a regression.
test('vitest tap-flat output parses cleanly (the correct vitest reporter; plain `tap` would mis-parse)', () => {
  const tap = [
    'TAP version 13',
    '1..3',
    'ok 1 - test/a.test.ts > acc adds # time=0.77ms',
    'ok 2 - test/a.test.ts > group > probe nested # time=0.08ms',
    'not ok 3 - test/a.test.ts > group > probe fails # time=2.74ms',
    '    ---',
    '    error:',
    '        name: "AssertionError"',
    '        message: "expected 1 to be 2"',
    '    ...',
  ].join('\n');
  const d = parseTapDetailed(tap);
  assert.equal(tapComplete(d), true, 'flat vitest TAP is plan==count complete');
  assert.deepEqual(d.perTest, {
    'test/a.test.ts > acc adds': 'pass',
    'test/a.test.ts > group > probe nested': 'pass',
    'test/a.test.ts > group > probe fails': 'fail',
  });
});

test('GREEN: correct candidate passes build + all acceptance tests', async () => {
  const repo = await makeRepo({ 'src/impl.mjs': IMPL_OK, 'test/suite.test.mjs': SUITE });
  const r = await gateRunner(baseOpts(repo, { id: 'ok', files: { 'src/impl.mjs': IMPL_OK } }));
  assert.equal(r.gate, 'green', JSON.stringify(r));
  assert.equal(r.acceptancePass, true);
  assert.deepEqual(r.perTest, {
    'acc: sum adds': 'pass',
    'acc: classify nonneg': 'pass',
    'probe: classify zero': 'pass',
    'probe: classify neg': 'pass',
  });
  assert.ok(r.evidencePath, 'writes evidence to disk');
});

test('PRUNED: a failing acceptance test prunes (failStep=test), per-test still emitted', async () => {
  const repo = await makeRepo({ 'src/impl.mjs': IMPL_OK, 'test/suite.test.mjs': SUITE });
  const r = await gateRunner(baseOpts(repo, { id: 'accfail', files: { 'src/impl.mjs': IMPL_ACC_FAIL } }));
  assert.equal(r.gate, 'pruned');
  assert.equal(r.failStep, 'test');
  assert.equal(r.acceptancePass, false);
  assert.equal(r.perTest['acc: sum adds'], 'fail');
});

test('PRUNED: a build (syntax) failure prunes at the cheap step before tests run', async () => {
  const repo = await makeRepo({ 'src/impl.mjs': IMPL_OK, 'test/suite.test.mjs': SUITE });
  const r = await gateRunner(baseOpts(repo, { id: 'syntax', files: { 'src/impl.mjs': IMPL_SYNTAX } }));
  assert.equal(r.gate, 'pruned');
  assert.equal(r.failStep, 'build');
  assert.equal(r.perTest, null, 'test step never ran');
});

test('IMMUTABILITY: a candidate touching a protected test path is rejected outright', async () => {
  const repo = await makeRepo({ 'src/impl.mjs': IMPL_OK, 'test/suite.test.mjs': SUITE });
  const r = await gateRunner(baseOpts(repo, {
    id: 'cheater',
    files: { 'src/impl.mjs': IMPL_ACC_FAIL, 'test/suite.test.mjs': 'export const x=1;' },
  }));
  assert.equal(r.gate, 'pruned');
  assert.equal(r.failStep, 'immutability-violation');
  assert.deepEqual(r.violations, ['test/suite.test.mjs']);
});

test('HANG: a stalling test step is a retryable hang -> INCOMPLETE (not pruned)', async () => {
  const repo = await makeRepo({ 'src/impl.mjs': IMPL_OK, 'test/suite.test.mjs': SUITE });
  const r = await gateRunner(baseOpts(repo, { id: 'hang', files: { 'src/impl.mjs': IMPL_HANG } }, { perStepTimeoutMs: 1500, attempts: 2 }));
  assert.equal(r.gate, 'incomplete', JSON.stringify(r.steps));
  assert.equal(r.failStep, 'hang');
  const testStep = r.steps.find((s) => s.name === 'test');
  assert.equal(testStep.verdict, 'hang');
  assert.ok(testStep.attempts.every((a) => a.timedOut), 'every attempt timed out');
});

test('FLAKY: a test that flips across runs is quarantined -> INCOMPLETE, never scored', async () => {
  const counter = path.join(await mkdtemp(path.join(os.tmpdir(), 'gr-ctr-')), 'n');
  await writeFile(counter, '0');
  process.env.GR_COUNTER = counter;
  const FLAKY_SUITE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('acc: always', () => { assert.ok(true); });
test('probe: flaky parity', () => {
  const p = process.env.GR_COUNTER;
  let n = 0; try { n = parseInt(fs.readFileSync(p, 'utf8')) || 0; } catch {}
  fs.writeFileSync(p, String(n + 1));
  assert.equal(n % 2, 0);
});
`;
  const repo = await makeRepo({ 'test/flaky.test.mjs': FLAKY_SUITE });
  const r = await gateRunner({
    repoDir: repo,
    candidate: { id: 'flaky', files: {} },
    verify: [{ name: 'test', cmd: ['node', '--test', '--test-reporter=tap', 'test/flaky.test.mjs'], type: 'test' }],
    acceptanceFilter: (n) => n.startsWith('acc'),
    protectedPaths: ['test'],
    attempts: 3,
    perStepTimeoutMs: 12000,
  });
  delete process.env.GR_COUNTER;
  assert.equal(r.gate, 'incomplete', JSON.stringify(r.steps));
  assert.equal(r.failStep, 'test:flaky');
});
