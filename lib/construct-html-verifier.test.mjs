// construct-html-verifier.test — the generative HTML constructor + the browser-free assembly, hermetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { constructHtmlVerifier, assembleHtmlForCertify } from './construct-html-verifier.mjs';
import { htmlExample } from './html-verifier.mjs';

const EX = htmlExample();
const REQ = [{ id: 'r-counter', text: 'A +1 button increments a counter from 0 by 1.' }];
const RESIDUAL = 'Checks the button + counter exist, the initial count is 0, and a click yields 1. Does NOT verify styling, a11y, keyboard, or repeated clicks.';
// EXACTLY ONE anti per requirement (coverage rule) — reuse the example's clean click-breaker.
const ANTI = [{ id: 'anti-counter', requirementId: 'r-counter', html: EX.antiCandidates.find((a) => a.id === 'anti-click').html }];

const claimFn = () => ({ checks: EX.checks, residual: RESIDUAL });
const adversaryFn = () => ({ antiCandidates: ANTI, redAnswer: EX.redHtml });
const baseOpts = { task: 'build a counter', source: EX.spec, requirements: REQ, claimFn, adversaryFn, claimAuthor: 'agent-claim', adversary: 'agent-adversary' };

test('constructHtmlVerifier: builds a constructed-floor-pass certificate + agent-browser oracle', async () => {
  const built = await constructHtmlVerifier(baseOpts);
  assert.equal(built.certificate.tierCeiling, 'constructed-floor-pass');
  assert.equal(built.checks.length, 4);
  assert.equal(built.certificate.requirements.length, 1);
  assert.deepEqual(built.certificate.requirements[0].checkIds, ['has-button', 'has-count', 'starts-zero', 'click-increments']);
  assert.equal(built.certificate.requirements[0].antiCandidateId, 'anti-counter');
  assert.deepEqual(built.certificate.constructorProvenance, { claimAuthor: 'agent-claim', adversary: 'agent-adversary' });
  assert.match(built.verifierSource, /html-verify\.mjs/);
  assert.match(built.verifierSource, /agent-browser|GODCODE_AB_BIN/);
});

test('constructHtmlVerifier: rejects bad provenance / missing residual / coverage gaps / bad checks', async () => {
  await assert.rejects(constructHtmlVerifier({ ...baseOpts, adversary: 'agent-claim' }), /DISTINCT/, 'claim author == adversary');
  await assert.rejects(constructHtmlVerifier({ ...baseOpts, claimFn: () => ({ checks: EX.checks, residual: '' }) }), /non-empty residual/);
  await assert.rejects(constructHtmlVerifier({ ...baseOpts, claimFn: () => ({ checks: [{ id: 'x', requirementId: 'r-counter', kind: 'mystery' }], residual: 'r' }) }), /check validation FAILED/);
  // two anti-candidates for one requirement ⇒ coverage gap (need exactly one).
  await assert.rejects(constructHtmlVerifier({ ...baseOpts, adversaryFn: () => ({ antiCandidates: [...ANTI, { id: 'anti-2', requirementId: 'r-counter', html: '<html></html>' }], redAnswer: EX.redHtml }) }), /EXACTLY one/);
  // a requirement with no check.
  await assert.rejects(constructHtmlVerifier({ ...baseOpts, requirements: [...REQ, { id: 'r-extra', text: 'uncovered' }] }), /coverage/);
});

test('assembleHtmlForCertify: builds the gate repo (index.html candidate, browser oracle), browser-free', async () => {
  const built = await constructHtmlVerifier(baseOpts);
  const work = mkdtempSync(path.join(tmpdir(), 'gc-html-asm-'));
  try {
    const asm = await assembleHtmlForCertify({ workdir: work, source: EX.spec, verifierSource: built.verifierSource, redAnswer: built.redAnswer, antiCandidates: built.antiCandidates, built });
    assert.ok(existsSync(path.join(asm.repo, 'index.html')), 'base candidate index.html');
    assert.ok(existsSync(path.join(asm.repo, 'verify', 'html-verify.mjs')), 'the oracle is committed');
    assert.deepEqual(asm.verify, [{ name: 'html', cmd: ['node', 'verify/html-verify.mjs', 'index.html'], type: 'test' }]);
    assert.deepEqual(asm.protectedPaths, ['verify/html-verify.mjs', 'spec.md']);
    // browser-free: expectedRedCheckIds = the union of all check ids (certify still requires the red gate to prune).
    assert.deepEqual(asm.expectedRedCheckIds.sort(), ['click-increments', 'has-button', 'has-count', 'starts-zero']);
    assert.equal(asm.antiCandidateDirs.length, 1);
    assert.equal(asm.antiCandidateDirs[0].id, 'anti-counter');
    // makeAnswerCandidate writes a candidate index.html in a fresh worktree.
    const wt = asm.makeAnswerCandidate('<!doctype html><html><body>hi</body></html>');
    assert.equal(readFileSync(path.join(wt, 'index.html'), 'utf8'), '<!doctype html><html><body>hi</body></html>');
  } finally { rmSync(work, { recursive: true, force: true }); }
});
