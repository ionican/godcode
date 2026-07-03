// Regression tests for the Codex adversarial-review findings (2026-06-26).
// Written BEFORE the fixes (fold discipline): path-escape, TAP strictness,
// hang-containment, and (in dispersion.test.mjs) epsilon chain collapse.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gateRunner, runCmd, parseTapDetailed, tapComplete } from './gate-runner.mjs';

const dirs = [];
async function makeMinimalRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hard-'));
  dirs.push(dir);
  await writeFile(path.join(dir, 'README'), 'x');
  await runCmd('git', ['init', '-q'], { cwd: dir });
  await runCmd('git', ['add', '-A'], { cwd: dir });
  await runCmd('git', ['-c', 'user.email=ci@local', '-c', 'user.name=ci', 'commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {}); });

// ---- [critical] candidate path escape ----
test('SECURITY: candidate paths escaping the worktree are rejected (path-escape), nested OK', async () => {
  const repo = await makeMinimalRepo();
  const absSentinel = path.join(os.tmpdir(), `godcode-escape-${process.pid}.txt`);
  const base = { repoDir: repo, verify: [{ name: 'noop', cmd: ['node', '-e', 'process.exit(0)'], type: 'check' }], protectedPaths: [], attempts: 1, perStepTimeoutMs: 8000 };
  for (const badKey of ['../escape.txt', absSentinel, 'a/../../escape2.txt']) {
    const r = await gateRunner({ ...base, candidate: { id: 'esc', files: { [badKey]: 'PWNED' } } });
    assert.equal(r.gate, 'pruned', badKey);
    assert.equal(r.failStep, 'path-escape', badKey);
  }
  assert.equal(existsSync(absSentinel), false, 'absolute escape was not written');
  const ok = await gateRunner({ ...base, candidate: { id: 'okp', files: { 'src/new/file.mjs': 'export const x = 1;' } } });
  assert.equal(ok.gate, 'green', 'a normal nested path still works');
});

// ---- [high] TAP fragment / crash accepted as complete ----
test('TAP STRICTNESS: incomplete/crashed/ambiguous TAP is never scored complete', async () => {
  const repo = await makeMinimalRepo();
  const mk = (id, tap) => ({
    repoDir: repo, candidate: { id, files: {} }, acceptanceFilter: (n) => n.startsWith('acc'),
    protectedPaths: [], attempts: 2, perStepTimeoutMs: 8000,
    verify: [{ name: 'test', type: 'test', cmd: ['node', '-e', `process.stdout.write(${JSON.stringify(tap)})`] }],
  });
  // ok line but NO plan -> fragment
  assert.equal((await gateRunner(mk('frag', 'TAP version 13\nok 1 - acc: x\n'))).gate, 'incomplete');
  // bailout mid-stream
  assert.equal((await gateRunner(mk('bail', 'ok 1 - acc: x\n1..1\nBail out! boom\n'))).gate, 'incomplete');
  // plan/count mismatch (crash after first ok)
  assert.equal((await gateRunner(mk('short', 'ok 1 - acc: x\n1..3\n'))).gate, 'incomplete');
  // duplicate ambiguous names
  assert.equal((await gateRunner(mk('dup', 'ok 1 - acc: x\nok 2 - acc: x\n1..2\n'))).gate, 'incomplete');
  // control: a VALID, complete TAP with all acceptance passing -> green
  assert.equal((await gateRunner(mk('good', 'ok 1 - acc: x\nok 2 - acc: y\n1..2\n'))).gate, 'green');
});

test('tapComplete unit: plan must match count, no bailout, no duplicate', () => {
  assert.equal(tapComplete(parseTapDetailed('ok 1 - a\nok 2 - b\n1..2\n')), true);
  assert.equal(tapComplete(parseTapDetailed('ok 1 - a\n')), false, 'no plan');
  assert.equal(tapComplete(parseTapDetailed('ok 1 - a\n1..2\n')), false, 'count<plan');
  assert.equal(tapComplete(parseTapDetailed('ok 1 - a\nBail out!\n1..1\n')), false, 'bailout');
  assert.equal(tapComplete(parseTapDetailed('ok 1 - a\nok 2 - a\n1..2\n')), false, 'duplicate');
});

// Subtests (describe/t.test) emit INDENTED child points under one top-level point with a
// top-level plan of `1..1`. The plan must be checked against TOP-LEVEL points, and per-test
// detail must come from the LEAVES — otherwise a real suite reads as plan/count mismatch -> flaky.
test('TAP NESTING: subtests parse as leaves; top-level plan governs completeness', () => {
  const NESTED = [
    'TAP version 13',
    '# Subtest: outer',
    '    # Subtest: case a',
    '    ok 1 - case a',
    '    # Subtest: case b',
    '    not ok 2 - case b',
    '    1..2',
    'not ok 1 - outer',
    '1..1',
    '# tests 2',
  ].join('\n') + '\n';
  const d = parseTapDetailed(NESTED);
  assert.equal(tapComplete(d), true, 'top-level plan 1..1 matches the single top-level point');
  assert.deepEqual(d.perTest, { 'outer > case a': 'pass', 'outer > case b': 'fail' }, 'leaves keyed by ancestry');
  assert.ok(!('outer' in d.perTest), 'the aggregator point is not a leaf');
});

// A test title containing '#' is escaped by node:test as '\#'. That is NOT a TAP directive,
// and must not be truncated — else AC #1 / AC #2 / ... all collapse to one name (false duplicate)
// and a clean, complete suite is wrongly rejected as incomplete. (Real regression: atomic-pin-drop.)
test('TAP ESCAPING: backslash-escaped # in a name is a literal, not a directive', () => {
  const T = ['ok 1 - AC \\#1 covers null', 'ok 2 - AC \\#2 covers empty', '1..2'].join('\n') + '\n';
  const d = parseTapDetailed(T);
  assert.equal(tapComplete(d), true, 'two distinct names -> no false duplicate -> complete');
  assert.deepEqual(d.perTest, { 'AC #1 covers null': 'pass', 'AC #2 covers empty': 'pass' });
});

test('TAP DIRECTIVE: an UNescaped # directive is still stripped from the name', () => {
  const d = parseTapDetailed('ok 1 - a real test # SKIP later\nok 2 - b\n1..2\n');
  assert.equal(d.perTest['a real test'], 'pass', 'directive removed, name trimmed');
  assert.equal(d.perTest['b'], 'pass');
});

// Same leaf name under two different describe blocks is NOT an ambiguous duplicate.
test('TAP NESTING: identical leaf names under different parents do not false-collide', () => {
  const TWO = [
    '# Subtest: groupA',
    '    ok 1 - handles null',
    '    1..1',
    'ok 1 - groupA',
    '# Subtest: groupB',
    '    ok 1 - handles null',
    '    1..1',
    'ok 2 - groupB',
    '1..2',
  ].join('\n') + '\n';
  const d = parseTapDetailed(TWO);
  assert.equal(tapComplete(d), true, 'two top-level points, plan 1..2, no genuine duplicate');
  assert.deepEqual(d.perTest, { 'groupA > handles null': 'pass', 'groupB > handles null': 'pass' });
});

// ---- [critical] path-normalized immutability: a dotted protected path must still match ----
// Codex AR #4: matchProtected stripped only a LEADING `./`, so a candidate key `test/./oracle.test.mjs`
// did not match the protected FILE path `test/oracle.test.mjs` (only a `test` DIR prefix would have).
// resolveInside then normalized it and writeFile overwrote the target -> immutability bypass.
test('IMMUTABILITY (path-normalized): an internal ./ segment cannot dodge a protected FILE path', async () => {
  const repo = await makeMinimalRepo();
  const base = { repoDir: repo, verify: [{ name: 'noop', cmd: ['node', '-e', 'process.exit(0)'], type: 'check' }], attempts: 1, perStepTimeoutMs: 8000 };
  for (const key of ['test/./oracle.test.mjs', 'test//oracle.test.mjs', './test/oracle.test.mjs']) {
    const r = await gateRunner({ ...base, protectedPaths: ['test/oracle.test.mjs'], candidate: { id: 'dot', files: { [key]: 'PWNED' } } });
    assert.equal(r.gate, 'pruned', key);
    assert.equal(r.failStep, 'immutability-violation', key);
  }
});

// ---- [medium] hostile candidate id must not escape worktreeRoot / evidenceDir ----
test('ROBUSTNESS: a path-traversal candidate id cannot escape evidenceDir', async () => {
  const repo = await makeMinimalRepo();
  const evDir = await mkdtemp(path.join(os.tmpdir(), 'hard-ev-'));
  dirs.push(evDir);
  const r = await gateRunner({
    repoDir: repo, candidate: { id: '../../pwn', files: { 'src/x.mjs': 'export const x = 1;' } },
    verify: [{ name: 'noop', cmd: ['node', '-e', 'process.exit(0)'], type: 'check' }],
    protectedPaths: [], attempts: 1, perStepTimeoutMs: 8000, evidenceDir: evDir,
  });
  assert.equal(r.gate, 'green');
  assert.equal(r.candidateId, '../../pwn', 'the real id is preserved in the result');
  assert.ok(r.evidencePath, 'evidence written');
  const within = path.resolve(r.evidencePath).startsWith(path.resolve(evDir) + path.sep);
  assert.ok(within, `evidence path escaped evidenceDir: ${r.evidencePath}`);
});

// ---- [high] hang containment: detached grandchild must not wedge the gate ----
test('HANG CONTAINMENT: a hang spawning a detached grandchild still resolves promptly as hang', async () => {
  const repo = await makeMinimalRepo();
  const t0 = Date.now();
  const r = await gateRunner({
    repoDir: repo, candidate: { id: 'gc', files: {} }, protectedPaths: [], attempts: 1, perStepTimeoutMs: 1200,
    acceptanceFilter: (n) => n.startsWith('acc'),
    verify: [{
      name: 'test', type: 'test',
      cmd: ['node', '-e', 'const{spawn}=require("child_process");const c=spawn(process.execPath,["-e","setTimeout(()=>{},4000)"],{detached:true,stdio:"ignore"});c.unref();while(true){}'],
    }],
  });
  const elapsed = Date.now() - t0;
  assert.equal(r.gate, 'incomplete');
  assert.equal(r.failStep, 'hang');
  assert.ok(elapsed < 8000, `gate must not wedge on the grandchild; resolved in ${elapsed}ms`);
});
