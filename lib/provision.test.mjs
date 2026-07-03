// provision.test.mjs — dep-provisioning regression for the gate-runner.
//
// A fresh `git worktree` lacks gitignored dep dirs (node_modules), so a real-repo
// verify command that imports from them cannot run. The pilot-runner discovered this
// against the Felt suites; this folds the fix into the gate-runner primitive and locks
// the behaviour:
//   1) provisioning a dep dir makes a dep-importing suite GREEN that is otherwise un-runnable;
//   2) a provision path that escapes the worktree is a setup error, never silently followed;
//   3) a missing provision source is skipped (a depless repo still gates).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gateRunner, runCmd } from './gate-runner.mjs';

const repos = [];
async function makeRepo(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gr-prov-'));
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

after(async () => { for (const d of repos) await rm(d, { recursive: true, force: true }).catch(() => {}); });

// A toy bare-specifier dependency (`leftpad`) that lives only in node_modules, which is
// gitignored — so it is present in the base repo on disk but ABSENT from any fresh worktree.
const DEP_FILES = {
  '.gitignore': 'node_modules\n',
  'node_modules/leftpad/package.json': JSON.stringify({ name: 'leftpad', type: 'module', main: 'index.mjs' }),
  'node_modules/leftpad/index.mjs': "export const pad = (s) => '__' + s;\n",
  'src/impl.mjs': "import { pad } from 'leftpad';\nexport function go() { return pad('x'); }\n",
  'test/suite.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { go } from '../src/impl.mjs';
test('acc: dep resolves', () => { assert.equal(go(), '__x'); });
`,
};
const DEP_VERIFY = [{ name: 'test', cmd: ['node', '--test', '--test-reporter=tap', 'test/suite.test.mjs'], type: 'test' }];
const depOpts = (repoDir, extra = {}) => ({
  repoDir,
  candidate: { id: 'dep', files: {} },
  verify: DEP_VERIFY,
  acceptanceFilter: (n) => n.startsWith('acc'),
  protectedPaths: ['test', 'package.json'],
  attempts: 2,
  perStepTimeoutMs: 12000,
  ...extra,
});

test('WITHOUT provision: a dep-importing suite cannot run -> not green', async () => {
  const repo = await makeRepo(DEP_FILES);
  const r = await gateRunner(depOpts(repo)); // no provision
  assert.notEqual(r.gate, 'green', `un-provisioned worktree must not pass: ${JSON.stringify(r.steps)}`);
  assert.notEqual(r.acceptancePass, true, 'the acceptance test never resolved its dep -> no pass');
});

// The honesty invariant that makes provisioning gate-observable: a run that produces NO
// acceptance evidence (the filter matches nothing that ran) is INCOMPLETE, never a vacuous
// green. Deterministic — a passing probe-only suite, independent of import-crash reporting.
test('no acceptance evidence (filter matches nothing that ran) -> incomplete, never green', async () => {
  const repo = await makeRepo({
    'test/suite.test.mjs': `import { test } from 'node:test';
test('probe: only', () => {});
`,
  });
  const r = await gateRunner({
    repoDir: repo, candidate: { id: 'noacc', files: {} },
    verify: [{ name: 'test', cmd: ['node', '--test', '--test-reporter=tap', 'test/suite.test.mjs'], type: 'test' }],
    acceptanceFilter: (n) => n.startsWith('acc'), protectedPaths: ['test'], attempts: 2, perStepTimeoutMs: 12000,
  });
  assert.equal(r.gate, 'incomplete');
  assert.equal(r.failStep, 'test:no-acceptance');
  assert.equal(r.acceptancePass, false);
});

test('WITH provision: symlinking node_modules makes the same suite GREEN', async () => {
  const repo = await makeRepo(DEP_FILES);
  const r = await gateRunner(depOpts(repo, { provision: ['node_modules'] }));
  assert.equal(r.gate, 'green', JSON.stringify(r));
  assert.equal(r.acceptancePass, true);
  assert.deepEqual(r.provisioned, ['node_modules'], 'records what it linked');
  assert.equal(r.perTest['acc: dep resolves'], 'pass');
});

test('provision path escape is a setup error, never silently followed', async () => {
  const repo = await makeRepo(DEP_FILES);
  const r = await gateRunner(depOpts(repo, { provision: ['../escape'] }));
  assert.equal(r.gate, 'incomplete');
  assert.equal(r.failStep, 'provision-setup');
});

test('absolute provision path is rejected as a setup error', async () => {
  const repo = await makeRepo(DEP_FILES);
  const r = await gateRunner(depOpts(repo, { provision: ['/etc'] }));
  assert.equal(r.gate, 'incomplete');
  assert.equal(r.failStep, 'provision-setup');
});

test('runSubdir: verify runs from a worktree subdir (monorepo) + provisions deps there', async () => {
  // The dep + suite live under pkg/; running from the worktree root would miss both.
  const repo = await makeRepo({
    '.gitignore': 'node_modules\n',
    'pkg/node_modules/leftpad/package.json': JSON.stringify({ name: 'leftpad', type: 'module', main: 'index.mjs' }),
    'pkg/node_modules/leftpad/index.mjs': "export const pad = (s) => '__' + s;\n",
    'pkg/src/impl.mjs': "import { pad } from 'leftpad';\nexport function go() { return pad('y'); }\n",
    'pkg/test/suite.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { go } from '../src/impl.mjs';
test('acc: subdir dep resolves', () => { assert.equal(go(), '__y'); });
`,
  });
  const r = await gateRunner({
    repoDir: repo,
    candidate: { id: 'sub', files: {} },
    verify: [{ name: 'test', cmd: ['node', '--test', '--test-reporter=tap', 'test/suite.test.mjs'], type: 'test' }],
    runSubdir: 'pkg',
    provision: ['pkg/node_modules'],
    acceptanceFilter: (n) => n.startsWith('acc'),
    protectedPaths: ['pkg/test'],
    attempts: 2,
    perStepTimeoutMs: 12000,
  });
  assert.equal(r.gate, 'green', JSON.stringify(r));
  assert.equal(r.perTest['acc: subdir dep resolves'], 'pass');
});

test('oracleFiles: harness materializes the verifier onto a protected path; RED on buggy source', async () => {
  // Repo ships with BUGGY source and NO test. The harness overlays the oracle test (a protected
  // path) — exempt from the immutability guard — and the buggy source fails it -> pruned (RED).
  const repo = await makeRepo({
    'src/impl.mjs': "export function classify(n){ return 'always'; }\n", // buggy
  });
  const ORACLE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/impl.mjs';
test('acc: neg', () => { assert.equal(classify(-1), 'neg'); });
`;
  const common = {
    repoDir: repo,
    verify: [{ name: 'test', cmd: ['node', '--test', '--test-reporter=tap', 'test/oracle.test.mjs'], type: 'test' }],
    acceptanceFilter: (n) => n.startsWith('acc'),
    protectedPaths: ['test'],
    attempts: 1,
    perStepTimeoutMs: 12000,
  };
  const red = await gateRunner({ ...common, candidate: { id: 'buggy', files: {} }, oracleFiles: { 'test/oracle.test.mjs': ORACLE } });
  assert.equal(red.gate, 'pruned', JSON.stringify(red));
  assert.equal(red.acceptancePass, false);

  // A CANDIDATE supplying the same test path is still rejected by the immutability guard.
  const cheat = await gateRunner({ ...common, candidate: { id: 'cheat', files: { 'test/oracle.test.mjs': ORACLE } } });
  assert.equal(cheat.gate, 'pruned');
  assert.equal(cheat.failStep, 'immutability-violation');
});

test('oracleFiles: a correct fix passes the materialized verifier -> GREEN', async () => {
  const repo = await makeRepo({
    'src/impl.mjs': "export function classify(n){ return n >= 0 ? 'nonneg' : 'neg'; }\n", // correct
  });
  const ORACLE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/impl.mjs';
test('acc: neg', () => { assert.equal(classify(-1), 'neg'); });
test('acc: pos', () => { assert.equal(classify(2), 'nonneg'); });
`;
  const r = await gateRunner({
    repoDir: repo,
    candidate: { id: 'fix', files: {} },
    oracleFiles: { 'test/oracle.test.mjs': ORACLE },
    verify: [{ name: 'test', cmd: ['node', '--test', '--test-reporter=tap', 'test/oracle.test.mjs'], type: 'test' }],
    acceptanceFilter: (n) => n.startsWith('acc'),
    protectedPaths: ['test'],
    attempts: 1,
    perStepTimeoutMs: 12000,
  });
  assert.equal(r.gate, 'green', JSON.stringify(r));
  assert.equal(r.perTest['acc: neg'], 'pass');
});

test('runSubdir escape is a setup error', async () => {
  const repo = await makeRepo(DEP_FILES);
  const r = await gateRunner(depOpts(repo, { runSubdir: '../escape' }));
  assert.equal(r.gate, 'incomplete');
  assert.equal(r.failStep, 'runsubdir-setup');
});

test('a missing provision source is skipped (depless repo still gates)', async () => {
  // No node_modules on disk; a no-dep suite should gate normally despite the provision ask.
  const repo = await makeRepo({
    'src/impl.mjs': 'export const n = 1;\n',
    'test/suite.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { n } from '../src/impl.mjs';
test('acc: nodep', () => { assert.equal(n, 1); });
`,
  });
  const r = await gateRunner(depOpts(repo, { verify: DEP_VERIFY, provision: ['node_modules'] }));
  assert.equal(r.gate, 'green', JSON.stringify(r));
  assert.equal(r.provisioned, undefined, 'nothing was linked, so no provisioned field');
});
