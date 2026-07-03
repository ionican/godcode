// certify.test — the HONESTY contract for the constructed-verifier certification wrapper.
//
// Proves certifyVerifier assigns a high-confidence tier ONLY when, mechanically: the
// certificate is structurally valid, a known-bad red baseline FAILS the gate (the verifier
// discriminates), AND every requirement's anti-candidate is caught (killed) — otherwise it
// demotes to 'advisory-slate'. A single hole here is a false-green path, so each test pokes
// exactly one hole and asserts the demotion.
//
// The verifier is TRIVIAL and self-contained: a node script (materialized as an oracleFile)
// that greps the candidate source for required tokens and emits one TAP point per token,
// named for its checkId. A candidate missing a token fails that check. This keeps the test
// independent of the prose certificate module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { validateCertificate, certifyVerifier } from './certify.mjs';

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }

// A self-contained verifier: greps src.mjs for each required token and emits TAP. The check
// NAMES are the checkIds the certificate references. All tokens present -> all ok -> gate green.
const VERIFIER = `
import { readFileSync } from 'node:fs';
const TOKENS = ['ALPHA', 'BETA', 'GAMMA'];   // one per checkId: check-alpha/check-beta/check-gamma
let src = '';
try { src = readFileSync(new URL('./src.mjs', import.meta.url), 'utf8'); } catch {}
console.log('TAP version 13');
console.log('1..' + TOKENS.length);
TOKENS.forEach((tok, i) => {
  const ok = src.includes(tok);
  console.log((ok ? 'ok ' : 'not ok ') + (i + 1) + ' - check-' + tok.toLowerCase());
});
`;

// The verifier prints its own TAP directly, so a plain `node verify.mjs` is the verify cmd;
// gateRunner parses the 'ok N - name' lines (with a top-level '1..N' plan) for the per-check map.
const VERIFY = ['node verify.mjs'];

// Build a repo whose base src.mjs has ALL tokens (so the base is GREEN), with the verifier
// committed as a normal file. Returns { dir, base }.
function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-certtest-'));
  git(dir, ['init', '-q', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(path.join(dir, 'src.mjs'), '// ALPHA BETA GAMMA — all requirements satisfied\nexport const x = 1;\n');
  writeFileSync(path.join(dir, 'verify.mjs'), VERIFIER);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init (all tokens)']);
  return { dir, base: git(dir, ['rev-parse', 'HEAD']) };
}

// Create a candidate worktree off base whose src.mjs is `src`. Returns its dir.
function candidate(dir, base, root, name, src) {
  const wt = path.join(root, name);
  git(dir, ['worktree', 'add', '-q', '--detach', wt, base]);
  writeFileSync(path.join(wt, 'src.mjs'), src);
  return wt;
}

function cleanup(dir, root) {
  rmSync(root, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

// A well-formed certificate ceiling-claiming 'constructed-floor-pass' with 3 requirements,
// each naming one checkId + its anti-candidate id.
function goodCertificate() {
  return {
    tierCeiling: 'constructed-floor-pass',
    requirements: [
      { id: 'req-alpha', checkIds: ['check-alpha'], antiCandidateId: 'anti-alpha', threat: 'drops ALPHA' },
      { id: 'req-beta', checkIds: ['check-beta'], antiCandidateId: 'anti-beta', threat: 'drops BETA' },
      { id: 'req-gamma', checkIds: ['check-gamma'], antiCandidateId: 'anti-gamma', threat: 'drops GAMMA' },
    ],
    provenance: { source: 'spec://task-42', timing: 'pre-author', path: 'verify.mjs', hash: 'deadbeef' },
    // DECORRELATION: distinct claim author + adversary tags (certifyVerifier calls add a distinct
    // answerAuthor). Without these validateCertificate is invalid and certify demotes.
    constructorProvenance: { claimAuthor: 'author-A', adversary: 'adversary-B' },
    residual: 'covers token presence only; does not check runtime behaviour',
  };
}

// answerAuthor tag distinct from goodCertificate()'s claimAuthor/adversary — passed to every
// certifyVerifier call so the three-way decorrelation gate is satisfied on the healthy paths.
const ANSWER_AUTHOR = 'answer-author-C';

test('validateCertificate: a well-formed certificate is valid with no problems', () => {
  const v = validateCertificate(goodCertificate());
  assert.equal(v.valid, true);
  assert.deepEqual(v.problems, []);
});

test('validateCertificate: missing provenance is invalid with a problem per field', () => {
  const c = goodCertificate();
  delete c.provenance;
  const v = validateCertificate(c);
  assert.equal(v.valid, false);
  assert.ok(v.problems.some((p) => /provenance\.source/.test(p)));
  assert.ok(v.problems.some((p) => /provenance\.hash/.test(p)));
});

test('validateCertificate: a requirement with no checkId or empty antiCandidateId is invalid', () => {
  const c = goodCertificate();
  c.requirements[0].checkIds = [];
  c.requirements[1].antiCandidateId = '';
  const v = validateCertificate(c);
  assert.equal(v.valid, false);
  assert.ok(v.problems.some((p) => /req-alpha.*checkId/.test(p)));
  assert.ok(v.problems.some((p) => /req-beta.*antiCandidateId/.test(p)));
});

test('happy path: valid cert + discriminating red baseline + all requirements killed -> certified, tier===ceiling', async () => {
  const { dir, base } = makeRepo();
  const root = mkdtempSync(path.join(tmpdir(), 'gc-certcohort-'));
  // red baseline: a KNOWN-BAD candidate missing every token -> all checks fail -> gate pruned.
  const red = candidate(dir, base, root, 'red', '// nothing here\nexport const x = 0;\n');
  // each anti-candidate violates exactly ONE requirement (drops one token).
  const antiCandidates = [
    { id: 'anti-alpha', requirementId: 'req-alpha', dir: candidate(dir, base, root, 'anti-alpha', '// BETA GAMMA\nexport const x=1;\n') },
    { id: 'anti-beta', requirementId: 'req-beta', dir: candidate(dir, base, root, 'anti-beta', '// ALPHA GAMMA\nexport const x=1;\n') },
    { id: 'anti-gamma', requirementId: 'req-gamma', dir: candidate(dir, base, root, 'anti-gamma', '// ALPHA BETA\nexport const x=1;\n') },
  ];
  const report = await certifyVerifier({
    repo: dir, base, verify: VERIFY,
    certificate: goodCertificate(), redCandidateDir: red, antiCandidates, answerAuthor: ANSWER_AUTHOR,
  });
  assert.equal(report.certified, true);
  assert.equal(report.tier, 'constructed-floor-pass');
  assert.equal(report.redBaseline.red, true);
  assert.ok(report.requirements.every((r) => r.killed), 'every requirement must be killed');
  assert.deepEqual(report.problems, []);
  assert.equal(report.residual, 'covers token presence only; does not check runtime behaviour');
  cleanup(dir, root);
});

test('non-discriminating: red baseline GREENS -> advisory-slate, not certified', async () => {
  const { dir, base } = makeRepo();
  const root = mkdtempSync(path.join(tmpdir(), 'gc-certcohort-'));
  // The "red baseline" actually has ALL tokens, so the verifier greens it -> does NOT discriminate.
  const red = candidate(dir, base, root, 'red', '// ALPHA BETA GAMMA all present\nexport const x=1;\n');
  const antiCandidates = [
    { id: 'anti-alpha', requirementId: 'req-alpha', dir: candidate(dir, base, root, 'anti-alpha', '// BETA GAMMA\nexport const x=1;\n') },
    { id: 'anti-beta', requirementId: 'req-beta', dir: candidate(dir, base, root, 'anti-beta', '// ALPHA GAMMA\nexport const x=1;\n') },
    { id: 'anti-gamma', requirementId: 'req-gamma', dir: candidate(dir, base, root, 'anti-gamma', '// ALPHA BETA\nexport const x=1;\n') },
  ];
  const report = await certifyVerifier({
    repo: dir, base, verify: VERIFY,
    certificate: goodCertificate(), redCandidateDir: red, antiCandidates, answerAuthor: ANSWER_AUTHOR,
  });
  assert.equal(report.redBaseline.red, false);
  assert.equal(report.tier, 'advisory-slate');
  assert.equal(report.certified, false);
  assert.ok(report.problems.some((p) => /non-discriminating|does not discriminate/.test(p)));
  cleanup(dir, root);
});

test('unkilled requirement: one anti-candidate the verifier does NOT catch -> advisory-slate', async () => {
  const { dir, base } = makeRepo();
  const root = mkdtempSync(path.join(tmpdir(), 'gc-certcohort-'));
  const red = candidate(dir, base, root, 'red', '// nothing\nexport const x=0;\n');
  // anti-gamma does NOT actually drop GAMMA (it still has all tokens), so check-gamma still
  // passes -> requirement req-gamma is NOT killed.
  const antiCandidates = [
    { id: 'anti-alpha', requirementId: 'req-alpha', dir: candidate(dir, base, root, 'anti-alpha', '// BETA GAMMA\nexport const x=1;\n') },
    { id: 'anti-beta', requirementId: 'req-beta', dir: candidate(dir, base, root, 'anti-beta', '// ALPHA GAMMA\nexport const x=1;\n') },
    { id: 'anti-gamma', requirementId: 'req-gamma', dir: candidate(dir, base, root, 'anti-gamma', '// ALPHA BETA GAMMA (not actually violated)\nexport const x=1;\n') },
  ];
  const report = await certifyVerifier({
    repo: dir, base, verify: VERIFY,
    certificate: goodCertificate(), redCandidateDir: red, antiCandidates, answerAuthor: ANSWER_AUTHOR,
  });
  assert.equal(report.redBaseline.red, true);
  const gamma = report.requirements.find((r) => r.id === 'req-gamma');
  assert.equal(gamma.killed, false, 'req-gamma must be reported unkilled');
  assert.equal(report.tier, 'advisory-slate');
  assert.equal(report.certified, false);
  assert.ok(report.problems.some((p) => /req-gamma.*NOT killed/.test(p)));
  cleanup(dir, root);
});

test('malformed certificate: missing provenance -> validateCertificate false AND certifyVerifier advisory-slate', async () => {
  const { dir, base } = makeRepo();
  const root = mkdtempSync(path.join(tmpdir(), 'gc-certcohort-'));
  const cert = goodCertificate();
  delete cert.provenance; // structurally invalid
  // Everything ELSE is healthy: discriminating red + all anti-candidates would be caught.
  const red = candidate(dir, base, root, 'red', '// nothing\nexport const x=0;\n');
  const antiCandidates = [
    { id: 'anti-alpha', requirementId: 'req-alpha', dir: candidate(dir, base, root, 'anti-alpha', '// BETA GAMMA\nexport const x=1;\n') },
    { id: 'anti-beta', requirementId: 'req-beta', dir: candidate(dir, base, root, 'anti-beta', '// ALPHA GAMMA\nexport const x=1;\n') },
    { id: 'anti-gamma', requirementId: 'req-gamma', dir: candidate(dir, base, root, 'anti-gamma', '// ALPHA BETA\nexport const x=1;\n') },
  ];
  assert.equal(validateCertificate(cert).valid, false);
  const report = await certifyVerifier({
    repo: dir, base, verify: VERIFY,
    certificate: cert, redCandidateDir: red, antiCandidates, answerAuthor: ANSWER_AUTHOR,
  });
  assert.equal(report.tier, 'advisory-slate');
  assert.equal(report.certified, false);
  assert.ok(report.problems.some((p) => /provenance/.test(p)));
  cleanup(dir, root);
});

// ===========================================================================================
// AR regression suite — each test pokes one FALSE-GREEN hole the cross-model review found, and
// asserts certifyVerifier DEMOTES to advisory-slate. Tests pass attempts:3 so the flake
// quarantine is live (production default), except where a smaller count is deliberately probed.
// ===========================================================================================

// A verifier whose checks are token-greps like the base one, but where a marker token in the
// candidate source can force the verify run to HANG (infinite loop) — used to manufacture an
// 'incomplete' gate result. The verifier is materialized as an ORACLE file (so finding #2's
// "always protect oracleFiles" path is exercised) and committed at base too (so a worktree off
// base can run it without the oracle overlay if needed).
const VERIFIER_HANGABLE = `
import { readFileSync } from 'node:fs';
const TOKENS = ['ALPHA', 'BETA', 'GAMMA'];
let src = '';
try { src = readFileSync(new URL('./src.mjs', import.meta.url), 'utf8'); } catch {}
if (src.includes('HANGNOW')) { while (true) {} }   // marker -> infinite loop -> gate sees a hang
console.log('TAP version 13');
console.log('1..' + TOKENS.length);
TOKENS.forEach((tok, i) => {
  const ok = src.includes(tok);
  console.log((ok ? 'ok ' : 'not ok ') + (i + 1) + ' - check-' + tok.toLowerCase());
});
`;

// A FLAKY verifier: it flips check-alpha pass/fail across runs using an external counter file,
// regardless of the candidate source. With attempts:1 a single run can land on 'fail' and mint a
// kill; with attempts>=3 gate-runner quarantines it (-> incomplete, no perTest).
function flakyVerifier(counterPath) {
  return `
import { readFileSync, writeFileSync } from 'node:fs';
const TOKENS = ['ALPHA', 'BETA', 'GAMMA'];
let src = '';
try { src = readFileSync(new URL('./src.mjs', import.meta.url), 'utf8'); } catch {}
let n = 0; try { n = parseInt(readFileSync(${JSON.stringify(counterPath)}, 'utf8')) || 0; } catch {}
writeFileSync(${JSON.stringify(counterPath)}, String(n + 1));
console.log('TAP version 13');
console.log('1..' + TOKENS.length);
TOKENS.forEach((tok, i) => {
  // check-alpha is forced FAIL on odd runs, PASS on even — flaky irrespective of the source.
  let ok = src.includes(tok);
  if (tok === 'ALPHA') ok = (n % 2 === 0);
  console.log((ok ? 'ok ' : 'not ok ') + (i + 1) + ' - check-' + tok.toLowerCase());
});
`;
}

// Build a repo whose base src.mjs has ALL tokens and whose verifier source is `verifierSrc`,
// committed as verify.mjs. Returns { dir, base }.
function makeRepoWith(verifierSrc) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-certtest-'));
  git(dir, ['init', '-q', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(path.join(dir, 'src.mjs'), '// ALPHA BETA GAMMA — all requirements satisfied\nexport const x = 1;\n');
  writeFileSync(path.join(dir, 'verify.mjs'), verifierSrc);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return { dir, base: git(dir, ['rev-parse', 'HEAD']) };
}

// Healthy anti-candidates for the standard ALPHA/BETA/GAMMA cert (each drops exactly one token).
function healthyAntis(dir, base, root) {
  return [
    { id: 'anti-alpha', requirementId: 'req-alpha', dir: candidate(dir, base, root, 'anti-alpha', '// BETA GAMMA\nexport const x=1;\n') },
    { id: 'anti-beta', requirementId: 'req-beta', dir: candidate(dir, base, root, 'anti-beta', '// ALPHA GAMMA\nexport const x=1;\n') },
    { id: 'anti-gamma', requirementId: 'req-gamma', dir: candidate(dir, base, root, 'anti-gamma', '// ALPHA BETA\nexport const x=1;\n') },
  ];
}

// --- Finding #1 [CRITICAL]: an 'incomplete' (hung) red baseline must NOT count as discriminating.
test('AR#1: a red baseline that HANGS (gate=incomplete) is NON-discriminating -> advisory-slate', async () => {
  const { dir, base } = makeRepoWith(VERIFIER_HANGABLE);
  const root = mkdtempSync(path.join(tmpdir(), 'gc-certcohort-'));
  // Red baseline drops all tokens AND carries HANGNOW: the verifier infinite-loops -> gate hangs ->
  // 'incomplete'. Under the OLD `gate !== 'green'` test this counted as red. It must NOT.
  const red = candidate(dir, base, root, 'red', '// HANGNOW (no tokens)\nexport const x=0;\n');
  const antiCandidates = healthyAntis(dir, base, root);
  const report = await certifyVerifier({
    repo: dir, base, verify: VERIFY, attempts: 3,
    certificate: goodCertificate(),
    expectedRedCheckIds: ['check-alpha', 'check-beta', 'check-gamma'],
    redCandidateDir: red, antiCandidates, answerAuthor: ANSWER_AUTHOR,
  });
  assert.equal(report.redBaseline.red, false, 'a hung/incomplete red baseline does not discriminate');
  assert.equal(report.tier, 'advisory-slate');
  assert.equal(report.certified, false);
  assert.ok(report.problems.some((p) => /non-discriminating/.test(p)));
  cleanup(dir, root);
});

// --- Finding #1 (b): a red baseline that fails NO expected check is non-discriminating even if pruned.
test('AR#1b: a red baseline pruned on the WRONG check (no expected red check fails) -> advisory-slate', async () => {
  const { dir, base } = makeRepo(); // standard verifier
  const root = mkdtempSync(path.join(tmpdir(), 'gc-certcohort-'));
  // Red drops only GAMMA, but we DECLARE the expected red checks to be alpha+beta. GAMMA fails,
  // alpha/beta pass -> no EXPECTED check fails -> not a discriminating baseline for those reqs.
  const red = candidate(dir, base, root, 'red', '// ALPHA BETA (gamma dropped)\nexport const x=0;\n');
  const antiCandidates = healthyAntis(dir, base, root);
  const report = await certifyVerifier({
    repo: dir, base, verify: VERIFY, attempts: 3,
    certificate: goodCertificate(),
    expectedRedCheckIds: ['check-alpha', 'check-beta'],
    redCandidateDir: red, antiCandidates, answerAuthor: ANSWER_AUTHOR,
  });
  assert.equal(report.redBaseline.red, false, 'no expected red check failed');
  assert.equal(report.certified, false);
  assert.ok(report.problems.some((p) => /non-discriminating/.test(p)));
  cleanup(dir, root);
});

// --- Finding #2 [CRITICAL]: a candidate that EDITS the verifier (oracle) to print not-ok must not
// mint its own kill — the oracle must be protected, so the gate rejects it (immutability) and the
// candidate is NOT discriminating / NOT killed.
test('AR#2: a candidate that modifies the verifier oracle is rejected, not credited -> advisory-slate', async () => {
  const { dir, base } = makeRepoWith(VERIFIER_HANGABLE);
  const root = mkdtempSync(path.join(tmpdir(), 'gc-certcohort-'));
  const oracleFiles = { 'verify.mjs': VERIFIER_HANGABLE };
  // The "red" candidate keeps ALL tokens (so it would GREEN honestly) but ALSO rewrites verify.mjs
  // to unconditionally print `not ok` for every check — trying to manufacture its own red baseline.
  const redWt = path.join(root, 'red');
  git(dir, ['worktree', 'add', '-q', '--detach', redWt, base]);
  writeFileSync(path.join(redWt, 'src.mjs'), '// ALPHA BETA GAMMA all present\nexport const x=1;\n');
  writeFileSync(path.join(redWt, 'verify.mjs'),
    "console.log('TAP version 13');console.log('1..3');console.log('not ok 1 - check-alpha');console.log('not ok 2 - check-beta');console.log('not ok 3 - check-gamma');\n");
  const antiCandidates = healthyAntis(dir, base, root);
  const report = await certifyVerifier({
    repo: dir, base, verify: VERIFY, oracleFiles, attempts: 3,
    certificate: goodCertificate(),
    expectedRedCheckIds: ['check-alpha', 'check-beta', 'check-gamma'],
    redCandidateDir: redWt, antiCandidates, answerAuthor: ANSWER_AUTHOR,
  });
  assert.equal(report.redBaseline.red, false, 'editing the oracle must be rejected, not credited as a red baseline');
  assert.equal(report.tier, 'advisory-slate');
  assert.equal(report.certified, false);
  cleanup(dir, root);
});

// --- Finding #3 [HIGH]: a FLAKY verifier must not earn kills. With the production default
// attempts>=3 the gate quarantines the flake (-> incomplete, no perTest), so the kill that a single
// run would have minted does not count.
test('AR#3: a flaky verifier is quarantined at the default attempts -> req NOT killed -> advisory-slate', async () => {
  const counter = path.join(mkdtempSync(path.join(tmpdir(), 'gc-ctr-')), 'n');
  writeFileSync(counter, '0');
  const { dir, base } = makeRepoWith(flakyVerifier(counter));
  const root = mkdtempSync(path.join(tmpdir(), 'gc-certcohort-'));
  const red = candidate(dir, base, root, 'red', '// nothing\nexport const x=0;\n');
  // anti-alpha does NOT actually drop ALPHA (keeps all tokens) — the ONLY way check-alpha "fails"
  // is the verifier's own flakiness. At attempts:3 that's quarantined, so req-alpha is unkilled.
  const antiCandidates = [
    { id: 'anti-alpha', requirementId: 'req-alpha', dir: candidate(dir, base, root, 'anti-alpha', '// ALPHA BETA GAMMA (all present)\nexport const x=1;\n') },
    { id: 'anti-beta', requirementId: 'req-beta', dir: candidate(dir, base, root, 'anti-beta', '// ALPHA GAMMA\nexport const x=1;\n') },
    { id: 'anti-gamma', requirementId: 'req-gamma', dir: candidate(dir, base, root, 'anti-gamma', '// ALPHA BETA\nexport const x=1;\n') },
  ];
  // Use beta/gamma as the red's expected checks so the flaky alpha doesn't gate the red baseline.
  const report = await certifyVerifier({
    repo: dir, base, verify: VERIFY, attempts: 3,
    certificate: goodCertificate(),
    expectedRedCheckIds: ['check-beta', 'check-gamma'],
    redCandidateDir: red, antiCandidates, answerAuthor: ANSWER_AUTHOR,
  });
  const alpha = report.requirements.find((r) => r.id === 'req-alpha');
  assert.equal(alpha.killed, false, 'a flaky check must NOT count as a kill at the default attempts');
  assert.equal(report.certified, false);
  cleanup(dir, root);
});

// --- Finding #4 [HIGH]: anti-candidate must match by BOTH id===antiCandidateId AND requirementId.
// A mis-wired anti-candidate (right requirementId, WRONG id) must not silently stand in.
test('AR#4: anti-candidate whose id !== certificate antiCandidateId does NOT count -> advisory-slate', async () => {
  const { dir, base } = makeRepo();
  const root = mkdtempSync(path.join(tmpdir(), 'gc-certcohort-'));
  const red = candidate(dir, base, root, 'red', '// nothing\nexport const x=0;\n');
  // anti for req-alpha carries the WRONG id ('wrong-id' instead of 'anti-alpha') though it DOES
  // drop ALPHA. The OLD code matched on requirementId alone and would credit the kill.
  const antiCandidates = [
    { id: 'wrong-id', requirementId: 'req-alpha', dir: candidate(dir, base, root, 'anti-alpha', '// BETA GAMMA\nexport const x=1;\n') },
    { id: 'anti-beta', requirementId: 'req-beta', dir: candidate(dir, base, root, 'anti-beta', '// ALPHA GAMMA\nexport const x=1;\n') },
    { id: 'anti-gamma', requirementId: 'req-gamma', dir: candidate(dir, base, root, 'anti-gamma', '// ALPHA BETA\nexport const x=1;\n') },
  ];
  const report = await certifyVerifier({
    repo: dir, base, verify: VERIFY, attempts: 3,
    certificate: goodCertificate(),
    expectedRedCheckIds: ['check-alpha', 'check-beta', 'check-gamma'],
    redCandidateDir: red, antiCandidates, answerAuthor: ANSWER_AUTHOR,
  });
  const alpha = report.requirements.find((r) => r.id === 'req-alpha');
  assert.equal(alpha.killed, false, 'a wrong-id anti-candidate must not be matched by requirementId alone');
  assert.equal(report.certified, false);
  assert.ok(report.problems.some((p) => /req-alpha.*no anti-candidate/.test(p)));
  cleanup(dir, root);
});

// --- Finding #4 (validateCertificate): duplicate requirement ids / duplicate antiCandidateIds.
test('AR#4b: validateCertificate rejects duplicate requirement ids and duplicate antiCandidateIds', () => {
  const dupReq = goodCertificate();
  dupReq.requirements[1].id = 'req-alpha'; // collide with requirements[0]
  let v = validateCertificate(dupReq);
  assert.equal(v.valid, false);
  assert.ok(v.problems.some((p) => /req-alpha.*not unique|not unique.*req-alpha/.test(p)));

  const dupAnti = goodCertificate();
  dupAnti.requirements[1].antiCandidateId = 'anti-alpha'; // collide with requirements[0]
  v = validateCertificate(dupAnti);
  assert.equal(v.valid, false);
  assert.ok(v.problems.some((p) => /anti-alpha.*not unique|antiCandidateId.*not unique/.test(p)));
});

// --- Finding #5 [HIGH]: a deletion/rename the gate cannot faithfully apply must fail SAFE — the
// candidate is treated as NON-discriminating (red) / NOT-killed (anti).
test('AR#5: a red baseline expressed as a DELETION is non-discriminating (fail-safe) -> advisory-slate', async () => {
  const { dir, base } = makeRepo();
  const root = mkdtempSync(path.join(tmpdir(), 'gc-certcohort-'));
  // The "red" candidate DELETES src.mjs entirely. The old gateDir silently skipped deletions, so
  // the gate saw an empty diff -> base (all tokens) -> GREEN, yet `gate !== 'green'`... actually the
  // empty candidate greens, so red would be false anyway there; the real hole is that a DELETION is
  // applied as a NO-OP, which can mask a real change. Fail SAFE: any unfaithful change => not red.
  const redWt = path.join(root, 'red');
  git(dir, ['worktree', 'add', '-q', '--detach', redWt, base]);
  rmSync(path.join(redWt, 'src.mjs'), { force: true });
  const antiCandidates = healthyAntis(dir, base, root);
  const report = await certifyVerifier({
    repo: dir, base, verify: VERIFY, attempts: 3,
    certificate: goodCertificate(),
    expectedRedCheckIds: ['check-alpha', 'check-beta', 'check-gamma'],
    redCandidateDir: redWt, antiCandidates, answerAuthor: ANSWER_AUTHOR,
  });
  assert.equal(report.redBaseline.red, false, 'a deletion the gate cannot faithfully apply is non-discriminating');
  assert.equal(report.certified, false);
  // Distinguishing assertion: ONLY the new fail-safe path emits "not faithfully applicable". The
  // original silently no-ops the deletion (greens), so it could never produce this reason.
  assert.ok(report.problems.some((p) => /not faithfully applicable/.test(p)), 'must demote via the explicit fail-safe reason, not an accidental green');
  cleanup(dir, root);
});

test('AR#5b: an anti-candidate expressed as a RENAME is NOT-killed (fail-safe) -> advisory-slate', async () => {
  const { dir, base } = makeRepo();
  const root = mkdtempSync(path.join(tmpdir(), 'gc-certcohort-'));
  const red = candidate(dir, base, root, 'red', '// nothing\nexport const x=0;\n');
  // anti-alpha RENAMES src.mjs -> renamed.mjs (dropping ALPHA in the new file). git records this as
  // R (rename). gate.mjs's candidateFiles reports it as unfaithful (old path not removed in a base
  // worktree). Fail SAFE: this anti-candidate cannot be credited with the kill.
  const antiWt = path.join(root, 'anti-alpha');
  git(dir, ['worktree', 'add', '-q', '--detach', antiWt, base]);
  git(antiWt, ['mv', 'src.mjs', 'renamed.mjs']);
  writeFileSync(path.join(antiWt, 'renamed.mjs'), '// BETA GAMMA\nexport const x=1;\n');
  const antiCandidates = [
    { id: 'anti-alpha', requirementId: 'req-alpha', dir: antiWt },
    { id: 'anti-beta', requirementId: 'req-beta', dir: candidate(dir, base, root, 'anti-beta', '// ALPHA GAMMA\nexport const x=1;\n') },
    { id: 'anti-gamma', requirementId: 'req-gamma', dir: candidate(dir, base, root, 'anti-gamma', '// ALPHA BETA\nexport const x=1;\n') },
  ];
  const report = await certifyVerifier({
    repo: dir, base, verify: VERIFY, attempts: 3,
    certificate: goodCertificate(),
    expectedRedCheckIds: ['check-alpha', 'check-beta', 'check-gamma'],
    redCandidateDir: red, antiCandidates, answerAuthor: ANSWER_AUTHOR,
  });
  const alpha = report.requirements.find((r) => r.id === 'req-alpha');
  assert.equal(alpha.killed, false, 'a rename the gate cannot faithfully apply is NOT a kill');
  assert.equal(report.certified, false);
  // Distinguishing assertion: the new code surfaces the explicit fail-safe reason for req-alpha.
  // The original silently parsed only the rename's NEW path and never reported unfaithfulness.
  assert.ok(report.problems.some((p) => /req-alpha.*not faithfully applicable/.test(p)), 'must demote the rename via the explicit fail-safe reason');
  cleanup(dir, root);
});

// --- Finding #6 [MED]: a checkId shared across two requirements must be rejected by
// validateCertificate (one failing check must not certify multiple requirements).
test('AR#6: validateCertificate rejects a checkId shared across two requirements', () => {
  const c = goodCertificate();
  c.requirements[1].checkIds = ['check-alpha']; // share req-alpha's checkId
  const v = validateCertificate(c);
  assert.equal(v.valid, false);
  assert.ok(v.problems.some((p) => /check-alpha.*unique|also claimed/.test(p)));
});

// --- Finding #7 [LOW]: the happy path still certifies (provenancePresent removal is behaviour-
// preserving). Covered structurally by the existing happy-path test; this asserts the redundant
// flag's removal did not change the verdict for a fully-valid certificate with attempts:3.
test('AR#7: happy path still certifies at production attempts (no provenancePresent regression)', async () => {
  const { dir, base } = makeRepo();
  const root = mkdtempSync(path.join(tmpdir(), 'gc-certcohort-'));
  const red = candidate(dir, base, root, 'red', '// nothing\nexport const x=0;\n');
  const antiCandidates = healthyAntis(dir, base, root);
  const report = await certifyVerifier({
    repo: dir, base, verify: VERIFY, attempts: 3,
    certificate: goodCertificate(),
    expectedRedCheckIds: ['check-alpha', 'check-beta', 'check-gamma'],
    redCandidateDir: red, antiCandidates, answerAuthor: ANSWER_AUTHOR,
  });
  assert.equal(report.certified, true);
  assert.equal(report.tier, 'constructed-floor-pass');
  assert.deepEqual(report.problems, []);
  cleanup(dir, root);
});

// =============================================================================================
// AR regression suite (round 2) — cross-model review of the prose-QA construction path folded into
// certify. These poke the BLEED check (one anti-candidate must violate ONLY its own requirement) and
// the DECORRELATION attestation (claimAuthor/adversary/answerAuthor must be present + pairwise
// distinct). They FAIL on the pre-fix certify.
// =============================================================================================

// --- Finding #4 [HIGH]: an anti-candidate that fails its OWN check AND ANOTHER requirement's check
// must NOT be credited as a clean kill. The pre-fix bleed check read a per-requirement-FILTERED
// failed set (positiveEvidence pre-filtered to expectedCheckIds), so a cross-requirement failure was
// invisible and the kill was wrongly credited. Now positiveEvidence returns the FULL failed set and
// the caller's bleed check can see it.
test('AR#bleed: an anti-candidate that ALSO fails another requirement\'s check is NOT killed -> advisory-slate', async () => {
  const { dir, base } = makeRepo();
  const root = mkdtempSync(path.join(tmpdir(), 'gc-certcohort-'));
  const red = candidate(dir, base, root, 'red', '// nothing\nexport const x=0;\n');
  // anti-alpha drops BOTH ALPHA (its own check) AND GAMMA (req-gamma's check) — it bleeds. A clean
  // kill must break ONLY req-alpha's check; this one trips req-gamma's too, so it must be rejected.
  const antiCandidates = [
    { id: 'anti-alpha', requirementId: 'req-alpha', dir: candidate(dir, base, root, 'anti-alpha', '// BETA only (alpha AND gamma dropped)\nexport const x=1;\n') },
    { id: 'anti-beta', requirementId: 'req-beta', dir: candidate(dir, base, root, 'anti-beta', '// ALPHA GAMMA\nexport const x=1;\n') },
    { id: 'anti-gamma', requirementId: 'req-gamma', dir: candidate(dir, base, root, 'anti-gamma', '// ALPHA BETA\nexport const x=1;\n') },
  ];
  const report = await certifyVerifier({
    repo: dir, base, verify: VERIFY, attempts: 3,
    certificate: goodCertificate(),
    expectedRedCheckIds: ['check-alpha', 'check-beta', 'check-gamma'],
    redCandidateDir: red, antiCandidates, answerAuthor: ANSWER_AUTHOR,
  });
  const alpha = report.requirements.find((r) => r.id === 'req-alpha');
  assert.equal(alpha.killed, false, 'an anti-candidate that also fails another requirement\'s check must NOT be a clean kill');
  assert.equal(report.certified, false);
  assert.ok(report.problems.some((p) => /req-alpha.*another requirement/.test(p)), 'must cite the cross-requirement bleed');
  cleanup(dir, root);
});

// --- Finding #5 [MED]: decorrelation must be ATTESTED. Missing constructorProvenance, or
// claimAuthor===adversary, or adversary===answerAuthor → advisory-slate.
test('AR#decorr: missing constructorProvenance -> advisory-slate', async () => {
  const { dir, base } = makeRepo();
  const root = mkdtempSync(path.join(tmpdir(), 'gc-certcohort-'));
  const cert = goodCertificate();
  delete cert.constructorProvenance; // no decorrelation attestation
  const red = candidate(dir, base, root, 'red', '// nothing\nexport const x=0;\n');
  const antiCandidates = healthyAntis(dir, base, root);
  assert.equal(validateCertificate(cert).valid, false, 'a certificate with no constructorProvenance must be structurally invalid');
  const report = await certifyVerifier({
    repo: dir, base, verify: VERIFY, attempts: 3,
    certificate: cert,
    expectedRedCheckIds: ['check-alpha', 'check-beta', 'check-gamma'],
    redCandidateDir: red, antiCandidates, answerAuthor: ANSWER_AUTHOR,
  });
  assert.equal(report.tier, 'advisory-slate');
  assert.equal(report.certified, false);
  assert.ok(report.problems.some((p) => /constructorProvenance/.test(p)));
  cleanup(dir, root);
});

test('AR#decorr: claimAuthor===adversary -> advisory-slate', async () => {
  const { dir, base } = makeRepo();
  const root = mkdtempSync(path.join(tmpdir(), 'gc-certcohort-'));
  const cert = goodCertificate();
  cert.constructorProvenance = { claimAuthor: 'same-model', adversary: 'same-model' }; // circular
  const red = candidate(dir, base, root, 'red', '// nothing\nexport const x=0;\n');
  const antiCandidates = healthyAntis(dir, base, root);
  const report = await certifyVerifier({
    repo: dir, base, verify: VERIFY, attempts: 3,
    certificate: cert,
    expectedRedCheckIds: ['check-alpha', 'check-beta', 'check-gamma'],
    redCandidateDir: red, antiCandidates, answerAuthor: ANSWER_AUTHOR,
  });
  assert.equal(report.tier, 'advisory-slate', 'claimAuthor===adversary is the circularity — must demote');
  assert.equal(report.certified, false);
  assert.ok(report.problems.some((p) => /DISTINCT|decorrelat/i.test(p)));
  cleanup(dir, root);
});

test('AR#decorr: adversary===answerAuthor -> advisory-slate', async () => {
  const { dir, base } = makeRepo();
  const root = mkdtempSync(path.join(tmpdir(), 'gc-certcohort-'));
  const cert = goodCertificate(); // claimAuthor=author-A, adversary=adversary-B
  const red = candidate(dir, base, root, 'red', '// nothing\nexport const x=0;\n');
  const antiCandidates = healthyAntis(dir, base, root);
  const report = await certifyVerifier({
    repo: dir, base, verify: VERIFY, attempts: 3,
    certificate: cert,
    expectedRedCheckIds: ['check-alpha', 'check-beta', 'check-gamma'],
    redCandidateDir: red, antiCandidates,
    answerAuthor: 'adversary-B', // SAME as the certificate's adversary → not three distinct steps
  });
  assert.equal(report.tier, 'advisory-slate', 'adversary===answerAuthor must demote');
  assert.equal(report.certified, false);
  assert.ok(report.problems.some((p) => /decorrelation.*adversary.*answerAuthor|adversary.*answerAuthor.*DISTINCT/i.test(p)));
  cleanup(dir, root);
});

test('AR#decorr: missing answerAuthor -> advisory-slate', async () => {
  const { dir, base } = makeRepo();
  const root = mkdtempSync(path.join(tmpdir(), 'gc-certcohort-'));
  const cert = goodCertificate();
  const red = candidate(dir, base, root, 'red', '// nothing\nexport const x=0;\n');
  const antiCandidates = healthyAntis(dir, base, root);
  const report = await certifyVerifier({
    repo: dir, base, verify: VERIFY, attempts: 3,
    certificate: cert,
    expectedRedCheckIds: ['check-alpha', 'check-beta', 'check-gamma'],
    redCandidateDir: red, antiCandidates, // answerAuthor omitted
  });
  assert.equal(report.tier, 'advisory-slate', 'a missing answerAuthor breaks three-way decorrelation');
  assert.equal(report.certified, false);
  assert.ok(report.problems.some((p) => /answerAuthor/.test(p)));
  cleanup(dir, root);
});
