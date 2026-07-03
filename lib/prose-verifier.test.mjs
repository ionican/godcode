// prose-verifier.test — the emitted claims.mjs oracle is a DETERMINISTIC prose gate: run over
// the worked example it greens the correct answer (all ok, plan==count), reds the one violated
// claim on the wrong answer, and on each anti-candidate fails EXACTLY its one claim. Also confirms
// the emitted TAP parses through gate-runner's parseTapDetailed/tapComplete to the right per-check
// map — i.e. it's wire-compatible with the gate the rest of /godcode already speaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { emitProseVerifier, proseExample, validateClaims, evaluateClaims } from './prose-verifier.mjs';
import { parseTapDetailed, tapComplete } from './gate-runner.mjs';

// Materialize the emitted oracle + an answer/source pair into a fresh temp dir and run it.
// Returns { stdout, detail } — detail is the parsed-TAP per-check map.
function runOracle(claims, answer, source) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-prose-'));
  try {
    const claimsPath = path.join(dir, 'claims.mjs');
    const answerPath = path.join(dir, 'answer.txt');
    const sourcePath = path.join(dir, 'source.txt');
    writeFileSync(claimsPath, emitProseVerifier(claims));
    writeFileSync(answerPath, answer);
    writeFileSync(sourcePath, source);
    let stdout = '';
    try {
      stdout = execFileSync('node', [claimsPath, answerPath, sourcePath], { encoding: 'utf8' });
    } catch (e) {
      // the oracle exits 0 on every well-formed run (TAP carries the verdict, not the exit code)
      stdout = (e.stdout || '') + (e.stderr || '');
      throw new Error('oracle exited non-zero:\n' + stdout);
    }
    return { stdout, detail: parseTapDetailed(stdout) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Map a per-check detail to { id: 'pass'|'fail' } keyed by claim id (the oracle uses ids as TAP names).
function statusById(detail) {
  return detail.perTest; // names ARE the claim ids
}

test('correctAnswer: every claim ok, plan matches count, TAP is complete', () => {
  const ex = proseExample();
  const { detail } = runOracle(ex.claims, ex.correctAnswer, ex.source);
  assert.equal(detail.plan, ex.claims.length, 'plan line must equal claim count');
  assert.equal(detail.count, ex.claims.length, 'parsed count must equal claim count');
  assert.ok(tapComplete(detail), 'a well-formed all-ok run must be TAP-complete');
  const byId = statusById(detail);
  for (const c of ex.claims) assert.equal(byId[c.id], 'pass', `claim ${c.id} should pass`);
});

test('wrongAnswer: the baked-in false number is the ONLY not-ok claim', () => {
  const ex = proseExample();
  const { detail } = runOracle(ex.claims, ex.wrongAnswer, ex.source);
  assert.equal(detail.plan, ex.claims.length);
  assert.ok(tapComplete(detail), 'still a complete TAP run — a failing claim is reported, not a crash');
  const byId = statusById(detail);
  assert.equal(byId['mass-value'], 'fail', 'the contradicted number claim must fail');
  // every OTHER claim still passes — the wrong answer breaks exactly one thing
  for (const c of ex.claims) {
    if (c.id === 'mass-value') continue;
    assert.equal(byId[c.id], 'pass', `claim ${c.id} should still pass on the wrong answer`);
  }
});

test('each antiCandidate fails EXACTLY its one claim', () => {
  const ex = proseExample();
  for (const anti of ex.antiCandidates) {
    const { detail } = runOracle(ex.claims, anti.answer, ex.source);
    assert.ok(tapComplete(detail), `anti-candidate for ${anti.requirementId} must yield a complete TAP run`);
    const byId = statusById(detail);
    const failed = Object.keys(byId).filter((id) => byId[id] === 'fail');
    assert.deepEqual(
      failed,
      [anti.requirementId],
      `anti-candidate for ${anti.requirementId} should fail exactly that claim, got [${failed.join(', ')}]`,
    );
  }
});

test('emitted TAP parses through gate-runner to the right per-check map', () => {
  const ex = proseExample();
  const { stdout, detail } = runOracle(ex.claims, ex.correctAnswer, ex.source);
  // independent re-parse from the raw stdout (not the cached detail) to prove wire-compatibility
  const reparsed = parseTapDetailed(stdout);
  assert.deepEqual(Object.keys(reparsed.perTest).sort(), ex.claims.map((c) => c.id).sort());
  assert.equal(reparsed.plan, ex.claims.length);
  assert.equal(reparsed.count, ex.claims.length);
  assert.equal(reparsed.bailout, false);
  assert.equal(reparsed.duplicate, false);
  assert.ok(tapComplete(reparsed));
  // the failure path also parses cleanly (reason text after '# ' is a directive, not a check)
  const wrong = runOracle(ex.claims, ex.wrongAnswer, ex.source).detail;
  assert.equal(wrong.perTest['mass-value'], 'fail');
});

test('a not-ok line carries a # reason and still keeps a stable id name', () => {
  // guards the TAP escaping path: the reason after '# ' must not bleed into the parsed name,
  // so the per-check map stays keyed by the bare claim id.
  const ex = proseExample();
  const { stdout } = runOracle(ex.claims, ex.wrongAnswer, ex.source);
  const notOk = stdout.split('\n').find((l) => l.startsWith('not ok'));
  assert.match(notOk, /^not ok \d+ - mass-value # /, 'failure line shape: "not ok N - <id> # <reason>"');
});

// =============================================================================================
// SCOPED claim kinds: `near` / `not-near`. These check a TOKEN's proximity to a subject ANCHOR
// inside the ANSWER (no source), deterministically. They fix the crude `must-exclude "29"`
// false-negative: an answer that mentions "29 days in 2000" while correctly discussing February
// 1900 should NOT be rejected — only "29" NEAR "1900" is wrong.
// `near` and `not-near` ignore the source; pass a placeholder source the oracle still requires.
const NO_SOURCE = 'unused source for answer-structure checks';

// The motivating real-world false-negative: leap-year reasoning about February 1900 vs 2000.
test('not-near: "29" far from "1900" passes; "29" adjacent to "1900" fails (the leap-year false-negative)', () => {
  const claims = [{ id: 'no-29-near-1900', requirementId: 'leap', kind: 'not-near', anchor: '1900', token: '29' }];

  // CORRECT answer: a fuller explanation where the 1900 discussion and the (correct) "29 days in
  // 2000" remark are well separated — the only "29" is >50 chars from "1900", so not-near passes.
  const good = 'The year 1900 was divisible by 100 but not 400, so it was a common year — February had only 28 days that year. Contrast the year 2000, which was divisible by 400 and so was a leap year: that February had 29 days.';
  const { detail: goodDetail } = runOracle(claims, good, NO_SOURCE);
  assert.ok(tapComplete(goodDetail), 'a well-formed run');
  assert.equal(statusById(goodDetail)['no-29-near-1900'], 'pass', 'the only "29" is far from "1900" → not-near passes');

  // WRONG answer: "29" is adjacent to "1900" — the classic leap-year error.
  const bad = 'February 1900 had 29 days.';
  const { detail: badDetail } = runOracle(claims, bad, NO_SOURCE);
  assert.equal(statusById(badDetail)['no-29-near-1900'], 'fail', '"29" adjacent to "1900" → not-near fails');
});

test('near: token close to anchor passes; token far from (or anchor absent) fails', () => {
  const claims = [{ id: '28-near-1900', requirementId: 'leap', kind: 'near', anchor: '1900', token: '28' }];

  // "28" sits right next to "1900" → near passes.
  const close = 'February 1900 had 28 days, not 29.';
  assert.equal(statusById(runOracle(claims, close, NO_SOURCE).detail)['28-near-1900'], 'pass', '"28" close to "1900" → near passes');

  // "28" exists but is FAR from "1900" (a long filler gap) → near fails.
  const far = '1900 was not a leap year. ' + 'x'.repeat(200) + ' Some month had 28 days somewhere else.';
  assert.equal(statusById(runOracle(claims, far, NO_SOURCE).detail)['28-near-1900'], 'fail', '"28" far from "1900" → near fails');

  // anchor "1900" absent entirely → near fails (cannot be near a missing anchor).
  const noAnchor = 'February in a common year has 28 days.';
  assert.equal(statusById(runOracle(claims, noAnchor, NO_SOURCE).detail)['28-near-1900'], 'fail', 'anchor absent → near fails');
});

test('window boundary: a token just inside vs just outside the window flips pass/fail', () => {
  // Distance is |tokenStart - anchorStart|. Build answers where the token starts EXACTLY at the
  // window boundary (passes) vs one char beyond (fails). window = 10.
  // anchor 'A' at index 0; token 'B' placed so its start index = the gap.
  const win = 10;
  const claimNear = [{ id: 'b-near-a', requirementId: 'r', kind: 'near', anchor: 'AAAA', token: 'BBBB', window: win }];

  // 'AAAA' starts at 0. Put 'BBBB' starting at index 10 (== window) → near passes.
  const inside = 'AAAA' + 'x'.repeat(6) + 'BBBB'; // 'BBBB' starts at index 4+6 = 10
  assert.equal(statusById(runOracle(claimNear, inside, NO_SOURCE).detail)['b-near-a'], 'pass', 'token start at exactly window distance → near passes');

  // 'BBBB' starting at index 11 (> window) → near fails.
  const outside = 'AAAA' + 'x'.repeat(7) + 'BBBB'; // 'BBBB' starts at index 4+7 = 11
  assert.equal(statusById(runOracle(claimNear, outside, NO_SOURCE).detail)['b-near-a'], 'fail', 'token start one char beyond window → near fails');

  // not-near is the mirror: inside the window → fails; outside → passes.
  const claimNotNear = [{ id: 'b-not-near-a', requirementId: 'r', kind: 'not-near', anchor: 'AAAA', token: 'BBBB', window: win }];
  assert.equal(statusById(runOracle(claimNotNear, inside, NO_SOURCE).detail)['b-not-near-a'], 'fail', 'token inside window → not-near fails');
  assert.equal(statusById(runOracle(claimNotNear, outside, NO_SOURCE).detail)['b-not-near-a'], 'pass', 'token outside window → not-near passes');
});

test('anchor absent: not-near passes (vacuous), near fails', () => {
  const answer = 'No relevant anchor appears here at all.';
  const notNear = [{ id: 'nn', requirementId: 'r', kind: 'not-near', anchor: 'ZZZZ', token: 'token' }];
  assert.equal(statusById(runOracle(notNear, answer, NO_SOURCE).detail)['nn'], 'pass', 'not-near with absent anchor → vacuous pass');
  const near = [{ id: 'nr', requirementId: 'r', kind: 'near', anchor: 'ZZZZ', token: 'token' }];
  assert.equal(statusById(runOracle(near, answer, NO_SOURCE).detail)['nr'], 'fail', 'near with absent anchor → fail');
});

test('near/not-near use the default window (50) when window is omitted', () => {
  // anchor at 0, token at index 50 → near with default window passes (<= 50).
  const within = 'ANCH' + 'y'.repeat(46) + 'TOK'; // 'TOK' starts at 4+46 = 50
  const near = [{ id: 'd-near', requirementId: 'r', kind: 'near', anchor: 'ANCH', token: 'TOK' }];
  assert.equal(statusById(runOracle(near, within, NO_SOURCE).detail)['d-near'], 'pass', 'token at default-window distance → near passes');

  // token at index 51 → near fails (beyond default 50).
  const beyond = 'ANCH' + 'y'.repeat(47) + 'TOK'; // 'TOK' starts at 51
  assert.equal(statusById(runOracle(near, beyond, NO_SOURCE).detail)['d-near'], 'fail', 'token beyond default window → near fails');
});

test('emitted near/not-near TAP parses through gate-runner (plan==count, keys are claim ids)', () => {
  const claims = [
    { id: 'k-near', requirementId: 'r1', kind: 'near', anchor: '1900', token: '28' },
    { id: 'k-not-near', requirementId: 'r2', kind: 'not-near', anchor: '1900', token: '29' },
  ];
  // "28" sits right next to "1900" (near passes); "29" is pushed well past the default 50-char
  // window by a long filler gap (not-near passes).
  const answer = 'February 1900 had 28 days, since it was not a leap year. ' + 'Much later in the text, '.repeat(4) + 'the year 2000 by contrast had a February of 29 days.';
  const { stdout, detail } = runOracle(claims, answer, NO_SOURCE);
  const reparsed = parseTapDetailed(stdout);
  assert.deepEqual(Object.keys(reparsed.perTest).sort(), ['k-near', 'k-not-near']);
  assert.equal(reparsed.plan, claims.length);
  assert.equal(reparsed.count, claims.length);
  assert.equal(reparsed.bailout, false);
  assert.equal(reparsed.duplicate, false);
  assert.ok(tapComplete(reparsed));
  assert.equal(detail.perTest['k-near'], 'pass', '"28" near "1900" → near passes');
  assert.equal(detail.perTest['k-not-near'], 'pass', 'the only "29" is far from "1900" → not-near passes');
});

// --- validateClaims structural checks for the scoped kinds (answer-structure, NOT source-grounded) ---
test('validateClaims accepts well-formed near/not-near (anchor + token need not appear in the source)', () => {
  const source = 'a totally unrelated source with none of the tokens';
  const claims = [
    { id: 'v1', requirementId: 'r', kind: 'near', anchor: '1900', token: '28' },
    { id: 'v2', requirementId: 'r', kind: 'not-near', anchor: '1900', token: '29', window: 30 },
  ];
  const res = validateClaims(claims, source);
  assert.equal(res.valid, true, `well-formed near/not-near must validate; problems: ${JSON.stringify(res.problems)}`);
});

test('validateClaims rejects near/not-near with missing/empty anchor or token, and a non-positive window', () => {
  const source = 'source';
  const cases = [
    { id: 'm1', requirementId: 'r', kind: 'near', token: '28' },                                  // missing anchor
    { id: 'm2', requirementId: 'r', kind: 'near', anchor: '', token: '28' },                        // empty anchor
    { id: 'm3', requirementId: 'r', kind: 'not-near', anchor: '1900' },                             // missing token
    { id: 'm4', requirementId: 'r', kind: 'not-near', anchor: '1900', token: '   ' },               // whitespace token
    { id: 'm5', requirementId: 'r', kind: 'near', anchor: '1900', token: '28', window: 0 },          // non-positive window
    { id: 'm6', requirementId: 'r', kind: 'near', anchor: '1900', token: '28', window: -5 },         // negative window
    { id: 'm7', requirementId: 'r', kind: 'not-near', anchor: '1900', token: '29', window: Infinity }, // non-finite window
  ];
  for (const c of cases) {
    const res = validateClaims([c], source);
    assert.equal(res.valid, false, `claim ${c.id} must be rejected: ${JSON.stringify(c)}`);
    assert.ok(res.problems.length >= 1, `claim ${c.id} must carry a problem`);
  }

  // A valid window (positive finite) is accepted.
  const ok = validateClaims([{ id: 'ok', requirementId: 'r', kind: 'near', anchor: '1900', token: '28', window: 12 }], source);
  assert.equal(ok.valid, true, `a positive finite window must be accepted; problems: ${JSON.stringify(ok.problems)}`);
});

test('emitProseVerifier rejects a structurally-invalid near/not-near claim before baking', () => {
  // missing token → must throw, never coerce String(undefined) into a bogus check.
  assert.throws(
    () => emitProseVerifier([{ id: 'bad', requirementId: 'r', kind: 'near', anchor: '1900' }]),
    /token|non-empty/,
    'a near claim with no token must be rejected at emit',
  );
  assert.throws(
    () => emitProseVerifier([{ id: 'bad2', requirementId: 'r', kind: 'not-near', token: '29' }]),
    /anchor|non-empty/,
    'a not-near claim with no anchor must be rejected at emit',
  );
});

// AR fold (HIGH2/HIGH3): claim ids are emitted as TAP test names, so they must be present and free
// of TAP-special chars — else the oracle's key truncates/becomes "undefined" and diverges from the
// in-process predicate (a silent false prediction). validateClaims rejects them; emit throws.
test('AR: validateClaims + emitProseVerifier reject a missing or TAP-unsafe claim id', () => {
  const source = 'alpha';
  assert.equal(validateClaims([{ kind: 'must-include', text: 'alpha' }], source).valid, false, 'missing id is rejected');
  assert.equal(validateClaims([{ id: 'a #b', kind: 'must-include', text: 'alpha' }], source).valid, false, 'an id with a space/# is rejected');
  assert.equal(validateClaims([{ id: 'c1', kind: 'must-include', text: 'alpha' }], source).valid, true, 'a clean id passes');
  assert.equal(validateClaims([{ id: 'names-ceres', kind: 'must-include', text: 'alpha' }], source).valid, true, 'kebab ids pass');
  assert.throws(() => emitProseVerifier([{ kind: 'must-include', text: 'x' }]), /id/i, 'emit rejects a claim with no id');
  assert.throws(() => emitProseVerifier([{ id: 'a#b', kind: 'must-include', text: 'x' }]), /id/i, 'emit rejects a TAP-unsafe id');
});

// SINGLE SOURCE OF TRUTH regression guard: the in-process predicate the bleed-lint runs
// (evaluateClaims) must agree, per claim, with the emitted oracle that runs in the real gate. The
// emitter serializes evaluateClaim via Function.prototype.toString, so they cannot diverge unless
// someone re-introduces a second hand-written copy — which THIS test would catch.
test('SINGLE SOURCE OF TRUTH: in-process evaluateClaims agrees with the emitted oracle per claim', () => {
  const ex = proseExample();
  const answers = [
    ['correctAnswer', ex.correctAnswer],
    ['wrongAnswer', ex.wrongAnswer],
    ...ex.antiCandidates.map((a) => [`anti:${a.requirementId}`, a.answer]),
  ];
  for (const [label, ans] of answers) {
    const child = runOracle(ex.claims, ans, ex.source).detail.perTest; // id -> 'pass'|'fail'
    const inproc = evaluateClaims(ex.claims, ans, ex.source);
    for (const r of inproc.results) {
      assert.equal(r.ok, child[r.id] === 'pass',
        `${label}: claim ${r.id} — in-process ok=${r.ok} but emitted oracle=${child[r.id]} (PREDICATE DRIFT — the lint and the gate disagree)`);
    }
  }
});
