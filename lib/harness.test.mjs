// harness.test — the LIVE select driver smoke: gate a real cohort of candidate worktrees over a
// buggy temp repo's own suite and confirm the ship contract — fanned-out ships the verified green
// and surfaces the best failing candidate; an all-wrong cohort under budget asks for more authoring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { select } from './harness.mjs';

const HARNESS_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'harness.mjs');

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }

function makeRepoWithBug() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-harness-'));
  git(dir, ['init', '-q', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(path.join(dir, 'sum.mjs'), 'export const add = (a, b) => a - b;\n'); // BUG: should be a + b
  mkdirSync(path.join(dir, 'test'));
  writeFileSync(path.join(dir, 'test', 'sum.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { add } from '../sum.mjs';\ntest('acc adds', () => assert.equal(add(2, 3), 5));\n");
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init (buggy)']);
  return { dir, base: git(dir, ['rev-parse', 'HEAD']) };
}

const VERIFY = ['node --test --test-reporter=tap test/sum.test.mjs'];

function cohort(dir, base, edits) {
  const root = mkdtempSync(path.join(tmpdir(), 'gc-cohort-'));
  edits.forEach((src, i) => {
    const wt = path.join(root, `author-${i}`);
    git(dir, ['worktree', 'add', '-q', '--detach', wt, base]);
    writeFileSync(path.join(wt, 'sum.mjs'), src);
  });
  return root;
}
function cleanup(dir, root) {
  // deleting both temp trees removes the candidate worktrees and the repo; no `git worktree remove`
  // (its path-matching is fragile under macOS /var vs /private/var symlinks).
  rmSync(root, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

test('select: mixed cohort -> fanned-out, ships the green, surfaces the best failing for a human gate', async () => {
  const { dir, base } = makeRepoWithBug();
  const root = cohort(dir, base, [
    'export const add = (a, b) => a * b;\n',  // author-0: wrong -> pruned
    'export const add = (a, b) => a + b;\n',  // author-1: correct -> green
  ]);
  const c = await select({ repo: dir, base, candidates: root, verify: VERIFY, attempts: 1, timeoutMs: 30000, targetGreens: 1, globalMax: 8 });
  assert.equal(c.decision, 'fanned-out');
  assert.ok(c.shipped, 'must ship a verified green');
  assert.equal(c.shipped.id, 'author-1');
  assert.equal(c.bestFailing.id, 'author-0');     // the wrong candidate, surfaced for a human gate
  assert.equal(c.keepExploring, false);            // shipped -> nothing to explore
  cleanup(dir, root);
});

test('select: all-wrong cohort under budget -> no green, keepExploring (author more)', async () => {
  const { dir, base } = makeRepoWithBug();
  const root = cohort(dir, base, [
    'export const add = (a, b) => a * b;\n',  // wrong
    'export const add = (a, b) => a;\n',      // wrong
  ]);
  const c = await select({ repo: dir, base, candidates: root, verify: VERIFY, attempts: 1, timeoutMs: 30000, globalMax: 8 });
  assert.equal(c.shipped, null);
  assert.equal(c.decision, 'declined');
  assert.notEqual(c.regime, 'too-hard');           // 2 fails is not enough evidence for too-hard
  assert.equal(c.keepExploring, true);             // 2 fails < global-max 8 -> author more
  assert.ok(c.bestFailing, 'a best failing candidate is surfaced even mid-exploration');
  cleanup(dir, root);
});

test('select: an ALL-INCOMPLETE cohort (broken gate) does NOT keepExploring — surfaces noEvidence', async () => {
  // a --verify that runs but emits no test/acceptance evidence -> every candidate gates 'incomplete'
  // (the gateRunner no-false-green floor). That is a SETUP problem, not "author more".
  const { dir, base } = makeRepoWithBug();
  const root = cohort(dir, base, [
    'export const add = (a, b) => a + b;\n',
    'export const add = (a, b) => a * b;\n',
  ]);
  const c = await select({ repo: dir, base, candidates: root, verify: ['node -e process.exit(0)'], attempts: 1, timeoutMs: 30000, globalMax: 8 });
  assert.equal(c.shipped, null);
  assert.equal(c.noEvidence, true);                // zero decisive verdicts
  assert.equal(c.setupBroken, true);               // a no-acceptance gate is a SETUP failure
  assert.equal(c.keepExploring, false);            // do NOT loop authoring against a broken gate
  assert.match(c.verdict, /NO EVIDENCE/);
  cleanup(dir, root);
});

test('select: a candidate-specific incomplete (deletion) under budget KEEPS exploring, not a setup-stop (AR-r4)', async () => {
  // an ungated deletion is uncertifiable (incomplete) but CANDIDATE-specific — another author may not
  // delete. It must NOT be conflated with a broken-gate setup-stop: under budget, keepExploring stays true.
  const { dir, base } = makeRepoWithBug();
  const root = mkdtempSync(path.join(tmpdir(), 'gc-cohort-'));
  const wt = path.join(root, 'author-0');
  git(dir, ['worktree', 'add', '-q', '--detach', wt, base]);
  git(wt, ['rm', '-q', 'sum.mjs']);                          // an ungated deletion -> incomplete
  const c = await select({ repo: dir, base, candidates: root, verify: VERIFY, attempts: 1, timeoutMs: 30000, globalMax: 8 });
  assert.equal(c.shipped, null);
  assert.equal(c.candidates[0].gate, 'incomplete');
  assert.equal(c.noEvidence, true);                // zero decisive draws this cohort
  assert.equal(c.setupBroken, false);              // but the gate works — this is candidate-specific
  assert.equal(c.keepExploring, true);             // -> author more, not a setup-stop
  cleanup(dir, root);
});

test('select: a green AFTER 16 prunes still ships — a known green is never left unshipped (AR-high)', async () => {
  // Regression for the cross-model AR find: a naive triage-replay early-declines on 'too-hard' at 16
  // consecutive prunes and never draws the 17th (green) candidate. A FULLY-gated cohort must ship the
  // verified green regardless of its sort position.
  const { dir, base } = makeRepoWithBug();
  const root = mkdtempSync(path.join(tmpdir(), 'gc-cohort-'));
  for (let k = 0; k < 17; k++) {
    const wt = path.join(root, `author-${String(k).padStart(2, '0')}`);   // zero-pad so author-16 sorts last
    git(dir, ['worktree', 'add', '-q', '--detach', wt, base]);
    writeFileSync(path.join(wt, 'sum.mjs'), k < 16 ? 'export const add = (a, b) => a * b;\n' : 'export const add = (a, b) => a + b;\n');
  }
  const c = await select({ repo: dir, base, candidates: root, verify: VERIFY, attempts: 1, timeoutMs: 30000, globalMax: 20 });
  assert.ok(c.shipped, 'the green at index 16 MUST ship despite 16 preceding prunes');
  assert.equal(c.shipped.id, 'author-16');
  assert.equal(c.decision, 'fanned-out');
  assert.equal(c.keepExploring, false);
  cleanup(dir, root);
});

test('CLI: a partial cohort (targetGreens>1, one green, budget left) exits 2 keepExploring, not 0 (AR-r2)', () => {
  // The JSON contract says keepExploring:true for a fanned-out-partial; the CLI status must agree (2),
  // not exit 0 and tell a wave-loop to stop with the requested green cohort unfilled.
  const { dir, base } = makeRepoWithBug();
  const root = cohort(dir, base, [
    'export const add = (a, b) => a + b;\n',  // green
    'export const add = (a, b) => a * b;\n',  // pruned
  ]);
  let code = 0;
  try {
    execFileSync('node', [HARNESS_CLI, '--repo', dir, '--base', base, '--candidates', root,
      '--verify', VERIFY[0], '--target-greens', '2', '--global-max', '8', '--attempts', '1', '--timeout-ms', '30000', '--json'],
      { encoding: 'utf8' });
  } catch (e) { code = e.status; }
  assert.equal(code, 2, 'green shipped but the targetGreens=2 cohort is unfilled under budget -> keepExploring -> exit 2');
  cleanup(dir, root);
});

test('select: a deletion-only candidate is NOT false-greened (ungated deletion -> incomplete) (AR-r3 critical)', async () => {
  // PASSING base; a candidate that DELETES the imported module. The v0 gate does not apply deletions,
  // so the isolated worktree would gate the UNCHANGED base GREEN -> harness must refuse to ship it.
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-harness-'));
  git(dir, ['init', '-q', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(path.join(dir, 'sum.mjs'), 'export const add = (a, b) => a + b;\n');   // correct base -> passes
  mkdirSync(path.join(dir, 'test'));
  writeFileSync(path.join(dir, 'test', 'sum.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { add } from '../sum.mjs';\ntest('acc adds', () => assert.equal(add(2, 3), 5));\n");
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init (passing)']);
  const base = git(dir, ['rev-parse', 'HEAD']);
  const root = mkdtempSync(path.join(tmpdir(), 'gc-cohort-'));
  const wt = path.join(root, 'author-0');
  git(dir, ['worktree', 'add', '-q', '--detach', wt, base]);
  git(wt, ['rm', '-q', 'sum.mjs']);                          // the un-gated deletion
  const c = await select({ repo: dir, base, candidates: root, verify: VERIFY, attempts: 1, timeoutMs: 30000 });
  assert.equal(c.shipped, null, 'an ungated deletion must NEVER ship as VERIFIED');
  assert.equal(c.candidates[0].gate, 'incomplete');
  assert.match(c.candidates[0].failStep || '', /ungated-deletion/);
  cleanup(dir, root);
});

test('select: budget-ceiling decline is labelled as such, not "more may help"', async () => {
  const { dir, base } = makeRepoWithBug();
  const root = cohort(dir, base, [
    'export const add = (a, b) => a * b;\n',  // wrong
    'export const add = (a, b) => a;\n',      // wrong
  ]);
  // global-max == cohort size: the budget is spent, so keepExploring must be false and the label honest.
  const c = await select({ repo: dir, base, candidates: root, verify: VERIFY, attempts: 1, timeoutMs: 30000, globalMax: 2 });
  assert.equal(c.shipped, null);
  assert.equal(c.keepExploring, false);            // cohort (2) == global-max (2): ceiling reached
  assert.match(c.verdict, /budget ceiling/);
  cleanup(dir, root);
});
