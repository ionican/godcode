// gate.test — v0 `--gate-only` smoke: the entrypoint gates a real temp repo honestly across the
// three verdicts that matter (VERIFIED / NO-GREEN / REJECTED). Proves gate.mjs wires gateRunner
// correctly and never false-greens a wrong fix or a candidate that edits its own oracle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { runGate } from './gate.mjs';

function git(cwd, args) { execFileSync('git', args, { cwd, encoding: 'utf8' }); }

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-gatetest-'));
  git(dir, ['init', '-q', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(path.join(dir, 'sum.mjs'), 'export const add = (a, b) => a + b;\n');
  mkdirSync(path.join(dir, 'test'));
  writeFileSync(path.join(dir, 'test', 'sum.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { add } from '../sum.mjs';\ntest('acc adds', () => assert.equal(add(2, 3), 5));\n");
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

const VERIFY = ['node --test --test-reporter=tap test/sum.test.mjs'];

test('VERIFIED: a correct candidate passes the gate', async () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, 'sum.mjs'), 'export const add = (a, b) => b + a;\n'); // refactor, still correct
  const { res } = await runGate({ repo, base: 'HEAD', verify: VERIFY, attempts: 1, timeoutMs: 30000 });
  assert.equal(res.gate, 'green');
  rmSync(repo, { recursive: true, force: true });
});

test('NO-GREEN: a wrong candidate is pruned, never false-greened', async () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, 'sum.mjs'), 'export const add = (a, b) => a - b;\n'); // wrong
  const { res } = await runGate({ repo, base: 'HEAD', verify: VERIFY, attempts: 1, timeoutMs: 30000 });
  assert.equal(res.gate, 'pruned');
  rmSync(repo, { recursive: true, force: true });
});

test('REJECTED: a candidate that edits its own oracle is an immutability violation', async () => {
  const repo = makeRepo();
  // weaken the test AND break the source — must be rejected outright, not allowed to self-certify
  writeFileSync(path.join(repo, 'test', 'sum.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('acc adds', () => assert.equal(1, 1));\n");
  writeFileSync(path.join(repo, 'sum.mjs'), 'export const add = (a, b) => a - b;\n');
  const { res } = await runGate({ repo, base: 'HEAD', verify: VERIFY, attempts: 1, timeoutMs: 30000 });
  assert.equal(res.failStep, 'immutability-violation');
  rmSync(repo, { recursive: true, force: true });
});
