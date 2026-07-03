// orchestrate-prose.test — the general-objective pipeline end-to-end and DETERMINISTIC.
//
// Proves the three honest outcomes the loop must produce, with scripted (not LLM) generative
// artifacts so the test is hermetic:
//   1. CERTIFIED floor + ≥1 pass → VERIFIED slate, wrong answers killed, NO winner field.
//   2. CERTIFIED floor + 0 passes → honest 'no-verified' decline with a bestFailing.
//   3. UNCERTIFIED floor (red baseline non-discriminating) → 'advisory-only', NOTHING verified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { orchestrateProse, judgeFnFromVerdicts, defaultProseProxies, classifyGate, authorIsDecorrelated, resolveAnswerAuthor, pickBestFailing, NO_VERDICT, validateProbeRows } from './orchestrate-prose.mjs';
import { advisoryRank } from './slate.mjs';

const TASK = 'How many days were there in February 1900, and why?';
const SOURCE = 'Under the Gregorian calendar a year is a leap year if divisible by 4, except that centurial years (divisible by 100) are leap years only if also divisible by 400. The year 1900 is divisible by 100 but not by 400, so 1900 was not a leap year, and February 1900 had 28 days.';
const REQUIREMENTS = [{ id: 'r-feb1900', text: 'February 1900 had 28 days because 1900 is divisible by 100 but not 400, so it was not a leap year.' }];

// Scoped, decorrelation-clean fixture artifacts.
const CLAIMS = [
  { id: 'c-28', requirementId: 'r-feb1900', kind: 'must-include', text: '28' },
  { id: 'c-400', requirementId: 'r-feb1900', kind: 'must-include', text: '400' },
  { id: 'c-100', requirementId: 'r-feb1900', kind: 'must-include', text: '100' },
  { id: 'c-not-29-near-1900', requirementId: 'r-feb1900', kind: 'not-near', anchor: '1900', token: '29', window: 50 },
];
const RESIDUAL = 'Checks the answer states 28, cites the 100/400 rule, and does not place "29" next to "1900". Reasoning quality beyond those tokens is NOT verified.';
const ANTI = [{ id: 'anti-feb1900', requirementId: 'r-feb1900', answer: 'February 1900 had 29 days because 1900 is divisible by 4 and is therefore a leap year.' }];
const RED = 'February 1900 had 30 days.';

// A correct answer (no "29" at all → passes not-near vacuously; states 28, 100, 400).
const GOOD_A = 'February 1900 had 28 days. The Gregorian rule: a centurial year is a leap year only if divisible by 400; 1900 is divisible by 100 but not by 400, so it was a common year and February had 28 days.';
// A second correct answer, also clean of "29".
const GOOD_B = 'There were 28 days. 1900 is divisible by 100 but not 400, so under the Gregorian calendar it is not a leap year, giving February its usual 28 days.';
// A wrong answer ("29" next to "1900", no 400) → must be killed.
const BAD = 'February 1900 had 29 days, since 1900 is divisible by 4 and so is a leap year.';

// Two CORRECT answers with IDENTICAL specificity (#digits = 16 each) → the objective proxy cannot
// discriminate them (a genuine top-tie). GOOD_A=21 digits, GOOD_B=14 → a clear proxy winner exists there.
const TIE_X = 'February 1900 had 28 days, as 1900 is divisible by 100 but not 400.';
const TIE_Y = 'In 1900, February had 28 days; 1900 divides by 100 yet not 400 cleanly.';

function baseArgs(dir, answers, verdicts) {
  return {
    dossierDir: path.join(dir, 'run'), dossierVaultRelDir: '_godcode/runs/test', dossierId: 'test',
    objective: 'Feb-1900 QA (test)', request: `/godcode "${TASK}"`,
    task: TASK, source: SOURCE, requirements: REQUIREMENTS,
    clarifications: [{ q: 'Scope?', a: 'Gregorian calendar.' }],
    decisions: [{ question: 'D · source', options: ['wikipedia', 'first-principles'], chosen: 'first-principles', rationale: 'decorrelated from the answer cohort', adjudicator: 'board' }],
    claims: CLAIMS, residual: RESIDUAL, antiCandidates: ANTI, redAnswer: RED,
    answers, verdicts, proxies: defaultProseProxies(),
    claimAuthor: 'agent-claim', adversary: 'agent-adversary', answerAuthor: 'agent-answers', judgeProvenance: 'agent-judge',
    workdir: mkdtempSync(path.join(dir, 'wd-')), attempts: 2,
  };
}

// A BLEEDING verifier (the ieee754 shape): requirement 'rule' owns a BRITTLE grounded check on the
// exact phrasing 'divisible by 400'. The 'days' near-miss is correct-on-rule CONCEPTUALLY but phrases
// it differently ('four hundred'), so it fails the foreign grounded check → BLEED → certify can't
// cleanly kill 'days' → the whole run degrades to advisory-only. The pre-certify lint must PREDICT this.
const BLEED_REQUIREMENTS = [
  { id: 'days', text: 'February 1900 had 28 days.' },
  { id: 'rule', text: 'Because 1900 is divisible by 100 but not 400.' },
];
const BLEED_CLAIMS = [
  { id: 'y-28', requirementId: 'days', kind: 'must-include', text: '28' },
  { id: 'x-grounded', requirementId: 'rule', kind: 'grounded', quote: 'divisible by 400' },
];
const BLEED_ANTI = [
  // 'days' near-miss: wrong day count (29, no '28') AND phrases the rule as 'four hundred' (no
  // 'divisible by 400') → fails y-28 (own) AND x-grounded (foreign 'rule' check) → BLEED.
  { id: 'anti-days', requirementId: 'days', answer: 'February 1900 had 29 days. A centurial year is a leap year only if divisible by four hundred, and 1900 is divisible by one hundred but not four hundred.' },
  // 'rule' near-miss: keeps '28' (passes y-28, no bleed) but omits 'divisible by 400' → fails x-grounded (own) → clean kill.
  { id: 'anti-rule', requirementId: 'rule', answer: 'February 1900 had 28 days because 1900 is not evenly divisible by the special centurial divisor.' },
];
function bleedArgs(dir, answers) {
  return {
    dossierDir: path.join(dir, 'run'), dossierVaultRelDir: '_godcode/runs/test', dossierId: 'test',
    objective: 'Feb-1900 bleed (test)', request: `/godcode "${TASK}"`,
    task: TASK, source: SOURCE, requirements: BLEED_REQUIREMENTS,
    claims: BLEED_CLAIMS, residual: 'token checks only', antiCandidates: BLEED_ANTI, redAnswer: RED,
    answers, verdicts: undefined, proxies: defaultProseProxies(),
    claimAuthor: 'agent-claim', adversary: 'agent-adversary', answerAuthor: 'agent-answers', judgeProvenance: 'agent-judge',
    workdir: mkdtempSync(path.join(dir, 'wd-')), attempts: 2,
  };
}

test('lint: a CLEAN run attaches lintReport.wouldCertify=true and still certifies (advisory, no short-circuit by default)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-orch-lint-clean-'));
  try {
    const r = await orchestrateProse(baseArgs(dir, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }], undefined));
    assert.ok(r.lintReport, 'lintReport is attached to a prose run');
    assert.equal(r.lintReport.wouldCertify, true, 'the clean verifier is predicted to certify');
    assert.equal(r.lintReport.reauthorable, false);
    assert.equal(r.certified, true, 'the REAL certify still ran and agrees (lint is advisory, never skips the gate by default)');
    assert.match(r.decision, /^shipped-single/, 'DEFAULT mode ships the single best verified answer (slate is opt-in)');
    assert.notEqual(r.decision, 'needs-reauthor');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lint short-circuit: a BLEEDING verifier with lintShortCircuit ⇒ needs-reauthor BEFORE certify (gate never runs)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-orch-lint-sc-'));
  try {
    const args = bleedArgs(dir, [{ id: 'author-good-a', text: GOOD_A }]);
    args.lintShortCircuit = true;
    const r = await orchestrateProse(args);
    assert.equal(r.decision, 'needs-reauthor');
    assert.equal(r.certified, false, 'nothing is certified — the gate did not run');
    assert.deepEqual(r.gated, [], 'short-circuited at the M1→M2 seam: no answer was gated');
    assert.equal(r.admitted.length, 0);
    const days = r.lintReport.requirements.find((x) => x.id === 'days');
    assert.ok(days.bleedFailures.some((b) => b.checkId === 'x-grounded' && b.foreignRequirementId === 'rule'), 'the bleed is identified');
    assert.ok(r.lintReport.reauthorFeedback.some((l) => l.startsWith('BLEED:')), 'mechanical re-author feedback is produced');
    const json = JSON.parse(readFileSync(path.join(dir, 'run', 'run.json'), 'utf8'));
    assert.equal(json.outcome.decision, 'needs-reauthor');
    assert.equal(json.status, 'declined');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lint prediction MATCHES reality: the SAME bleeding verifier WITHOUT the flag runs the real certify → advisory-only', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-orch-lint-match-'));
  try {
    const r = await orchestrateProse(bleedArgs(dir, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }]));
    assert.equal(r.lintReport.wouldCertify, false, 'the lint PREDICTS the bleed will sink certification');
    assert.equal(r.certified, false, 'and the REAL out-of-band certify agrees — prediction matches reality');
    assert.equal(r.decision, 'advisory-only', 'honest decline: nothing verified against an uncertified floor');
    assert.equal(r.admitted.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('OPT-IN slate (--slate): verified slate, wrong answer killed, no winner field', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-orch-1-'));
  try {
    const answers = [
      { id: 'author-good-a', text: GOOD_A },
      { id: 'author-bad', text: BAD },
      { id: 'author-good-b', text: GOOD_B },
    ];
    const verdicts = { pairs: [{ a: 'author-good-a', b: 'author-good-b', winner: 'author-good-a' }], rationale: 'a is more complete' };
    const args = baseArgs(dir, answers, verdicts);
    args.slate = true;   // OPT-IN diversity mode — emit the ranked advisory slate, not a single pick.
    const r = await orchestrateProse(args);

    assert.equal(r.certified, true, 'verifier should certify (red baseline red, anti killed)');
    assert.equal(r.tier, 'factual-evidence-pass');
    assert.equal(r.decision, 'shipped-slate');
    assert.equal(r.pick, null, 'slate mode emits no single pick');
    assert.equal(r.slateMode, true);
    // The two correct answers are admitted; the wrong one is killed.
    assert.deepEqual([...r.admitted].sort(), ['author-good-a', 'author-good-b']);
    const bad = r.gated.find((g) => g.id === 'author-bad');
    assert.equal(bad.admitted, false, 'the wrong answer must be killed by the certified floor');
    // Honest slate: ordered, advisory, human-selected, and CRUCIALLY no winner/best key.
    assert.equal(r.rankingIsAdvisory, true);
    assert.equal(r.selectBy, 'human');
    assert.equal(r.slate.length, 2);
    for (const k of ['winner', 'best', 'chosen', 'top']) {
      assert.ok(!(k in r), `report must not expose a "${k}" key — verified ⇒ advisory slate only`);
    }
    // The live page is persisted as real files.
    assert.ok(existsSync(path.join(dir, 'run', 'index.html')), 'index.html written');
    assert.ok(existsSync(path.join(dir, 'run', 'run.json')), 'run.json written');
    const html = readFileSync(path.join(dir, 'run', 'index.html'), 'utf8');
    assert.match(html, /FACTUAL-EVIDENCE-PASS/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CERTIFIED + zero passes: honest no-verified decline with bestFailing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-orch-2-'));
  try {
    // Every answer is wrong → all killed by the certified floor.
    const answers = [
      { id: 'author-x', text: BAD },
      { id: 'author-y', text: 'February 1900 had 29 days; 1900 was a leap year.' },
    ];
    const r = await orchestrateProse(baseArgs(dir, answers, undefined));
    assert.equal(r.certified, true);
    assert.equal(r.decision, 'no-verified');
    assert.equal(r.admitted.length, 0, 'nothing verified');
    assert.equal(r.slate, null, 'no slate when nothing passed');
    const json = JSON.parse(readFileSync(path.join(dir, 'run', 'run.json'), 'utf8'));
    assert.equal(json.outcome.decision, 'no-verified');
    assert.ok(json.outcome.bestFailing, 'surfaces a bestFailing candidate');
    assert.equal(json.status, 'declined');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('UNCERTIFIED floor: advisory-only, nothing verified', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-orch-3-'));
  try {
    const args = baseArgs(dir, [
      { id: 'author-good-a', text: GOOD_A },
      { id: 'author-good-b', text: GOOD_B },
    ], { pairs: [{ a: 'author-good-a', b: 'author-good-b', winner: 'author-good-b' }] });
    // Sabotage decorrelation/discrimination: a RED answer that PASSES every claim → red baseline is
    // non-discriminating → certify fails → advisory-only path.
    args.redAnswer = GOOD_A;
    const r = await orchestrateProse(args);
    assert.equal(r.certified, false, 'a non-discriminating red baseline must fail certification');
    assert.equal(r.decision, 'advisory-only');
    assert.equal(r.tier, null, 'no verified tier when uncertified');
    assert.equal(r.admitted.length, 0, 'NOTHING is verified when the floor is untrustworthy');
    // Still produces an ordered advisory slate over all answers, human-selected.
    assert.equal(r.slate.length, 2);
    assert.equal(r.rankingIsAdvisory, true);
    assert.equal(r.selectBy, 'human');
    for (const row of r.slate) assert.equal(row.tier, 'advisory-slate');
    const json = JSON.parse(readFileSync(path.join(dir, 'run', 'run.json'), 'utf8'));
    assert.equal(json.outcome.decision, 'advisory-only');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── AR finding 4 — "no verdict" must NOT masquerade as a clean tie ─────────────────────────────
test('judgeFnFromVerdicts: explicit tie is valid; missing/garbage → NO_VERDICT (invalid)', () => {
  const j = judgeFnFromVerdicts({ pairs: [{ a: 'p', b: 'q', winner: 'p' }, { a: 'r', b: 's', winner: 'tie' }] });
  assert.equal(j({ a: { id: 'p' }, b: { id: 'q' } }), 'a');
  assert.equal(j({ a: { id: 'q' }, b: { id: 'p' } }), 'b');
  assert.equal(j({ a: { id: 'r' }, b: { id: 's' } }), 'tie', 'explicit tie stays a valid tie');
  assert.equal(j({ a: { id: 'x' }, b: { id: 'y' } }), NO_VERDICT, 'unknown pair → NO_VERDICT, not tie');
  assert.equal(judgeFnFromVerdicts({})({ a: { id: 'p' }, b: { id: 'q' } }), NO_VERDICT, 'no verdicts → NO_VERDICT');
  assert.equal(judgeFnFromVerdicts({ pairs: [{ a: 'p', b: 'q', winner: 'zzz' }] })({ a: { id: 'p' }, b: { id: 'q' } }), NO_VERDICT, 'garbage winner → NO_VERDICT');
});

test('AR-4: empty verdicts ⇒ advisoryRank flags proxyOnlyFallback (not a confident judge ranking)', async () => {
  const cands = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const r = await advisoryRank({ candidates: cands, judgeFn: judgeFnFromVerdicts({}), judgeProvenance: 'judge', answerAuthor: 'authors' });
  assert.equal(r.proxyOnlyFallback, true, 'no usable verdict on any pair ⇒ proxy-only fallback');
  assert.ok(r.invalidVerdicts >= 3, 'every missing pair counts as an invalid verdict');
});

// ── AR finding 1 — gate-result tier is derived from the gate, NEVER laundered from input ───────
test('AR-1: an inbound verified tier on a REJECTED answer is not laundered into the report', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-orch-laund-'));
  try {
    const answers = [
      { id: 'author-good-a', text: GOOD_A },
      { id: 'author-bad', text: BAD, tier: 'factual-evidence-pass' }, // a caller tries to launder a tier
    ];
    const r = await orchestrateProse(baseArgs(dir, answers, undefined));
    assert.equal(r.certified, true);
    const bad = r.gated.find((g) => g.id === 'author-bad');
    assert.equal(bad.admitted, false);
    assert.equal(bad.tier, 'advisory-slate', 'a rejected answer must NOT carry a verified tier, whatever the caller passed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── AR finding 2 — a candidate authored by a construction role cannot be verified ──────────────
test('AR-2: an answer authored by the claim-author is demoted (not admitted) even if its gate greens', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-orch-decorr-'));
  try {
    const args = baseArgs(dir, [
      { id: 'author-good-a', text: GOOD_A, answerAuthor: 'agent-claim' }, // == claimAuthor → collides
      { id: 'author-good-b', text: GOOD_B },                              // clean → admitted
    ], undefined);
    const r = await orchestrateProse(args);
    assert.equal(r.certified, true);
    const collided = r.gated.find((g) => g.id === 'author-good-a');
    assert.equal(collided.decorrelated, false);
    assert.equal(collided.admitted, false, 'a candidate authored by a construction role cannot earn a verified tier');
    assert.equal(collided.outcome, 'inconclusive');
    assert.deepEqual(r.admitted, ['author-good-b'], 'only the decorrelated answer is verified');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── AR finding 3 — inconclusive gates are not real failures; all-inconclusive ⇒ blocked ────────
test('AR-3 (unit): classifyGate distinguishes admitted / failed / inconclusive', () => {
  const map = { r1: 'pass' };
  assert.equal(classifyGate({ certified: true, decorrelated: true, gate: 'green', perTest: map }), 'admitted');
  assert.equal(classifyGate({ certified: true, decorrelated: true, gate: 'pruned', perTest: { r1: 'fail' } }), 'failed');
  assert.equal(classifyGate({ certified: true, decorrelated: true, gate: 'incomplete', perTest: null }), 'inconclusive', 'incomplete is NOT a failure');
  assert.equal(classifyGate({ certified: true, decorrelated: true, gate: 'pruned', perTest: null }), 'inconclusive', 'pruned without a per-check map is inconclusive');
  assert.equal(classifyGate({ certified: false, decorrelated: true, gate: 'green', perTest: map }), 'inconclusive', 'uncertified floor ⇒ never admitted');
  assert.equal(classifyGate({ certified: true, decorrelated: false, gate: 'green', perTest: map }), 'inconclusive', 'author collision ⇒ a GREEN is not trusted');
  // AR2 follow-up: a GENUINE failure is 'failed' regardless of author — decorrelation gates admission,
  // not failure. A wrong answer is wrong no matter who wrote it; mislabelling it inconclusive would let
  // an all-collision cohort that really failed report as 'blocked' / "no decisive failure".
  assert.equal(classifyGate({ certified: true, decorrelated: false, gate: 'pruned', perTest: { r1: 'fail' } }), 'failed', 'a real pruned failure is failed even from a colliding author');
});

test('AR2: a colliding-author answer that genuinely FAILS ⇒ no-verified (not blocked)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-orch-collide-fail-'));
  try {
    // BAD is a real wrong answer; author == claimAuthor (collision). It genuinely fails the certified
    // floor, so the run must DECLINE honestly with a bestFailing — not claim "no decisive failure".
    const args = baseArgs(dir, [{ id: 'author-bad', text: BAD, answerAuthor: 'agent-claim' }], undefined);
    const r = await orchestrateProse(args);
    assert.equal(r.certified, true);
    assert.equal(r.admitted.length, 0);
    assert.equal(r.decision, 'no-verified', 'a genuine failure is a decline, not a blocked run, even from a colliding author');
    const json = JSON.parse(readFileSync(path.join(dir, 'run', 'run.json'), 'utf8'));
    assert.ok(json.outcome.bestFailing, 'the genuine failure is surfaced as bestFailing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AR-3 (unit): pickBestFailing only ranks genuine failures and carries gate evidence', () => {
  assert.equal(pickBestFailing([]), null);
  const best = pickBestFailing([
    { id: 'x', gate: 'pruned', failStep: 'check', failedChecks: ['a', 'b'] },
    { id: 'y', gate: 'pruned', failStep: 'check', failedChecks: ['a'] },
  ]);
  assert.equal(best.id, 'y', 'fewest failed checks is closest');
  assert.equal(best.gate, 'pruned');
  assert.deepEqual(best.failedChecks, ['a']);
});

test('AR-3 (e2e): all-inconclusive (author collisions) ⇒ blocked, not no-verified', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-orch-blocked-'));
  try {
    // Both answers correct AND green, but both authored by construction roles → no decisive failure,
    // no admit → BLOCKED (gate gave no verdict), never a fabricated "answers were wrong".
    const args = baseArgs(dir, [
      { id: 'a', text: GOOD_A, answerAuthor: 'agent-claim' },
      { id: 'b', text: GOOD_B, answerAuthor: 'agent-adversary' },
    ], undefined);
    const r = await orchestrateProse(args);
    assert.equal(r.certified, true);
    assert.equal(r.admitted.length, 0);
    assert.equal(r.decision, 'blocked', 'no admit + no decisive failure ⇒ blocked, not no-verified');
    const json = JSON.parse(readFileSync(path.join(dir, 'run', 'run.json'), 'utf8'));
    assert.equal(json.outcome.bestFailing, null, 'a blocked run does not invent a bestFailing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('authorIsDecorrelated / resolveAnswerAuthor: empty and colliding tags are not decorrelated', () => {
  assert.equal(authorIsDecorrelated('answers', 'claim', 'adv'), true);
  assert.equal(authorIsDecorrelated('claim', 'claim', 'adv'), false);
  assert.equal(authorIsDecorrelated('adv', 'claim', 'adv'), false);
  assert.equal(authorIsDecorrelated('', 'claim', 'adv'), false, 'an empty author is not decorrelated');
  assert.equal(resolveAnswerAuthor({ answerAuthor: 'per-cand' }, 'global'), 'per-cand');
  assert.equal(resolveAnswerAuthor({}, 'global'), 'global');
  assert.equal(resolveAnswerAuthor({ answerAuthor: '  ' }, 'global'), 'global', 'blank override falls back to global');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// #3 — DEFAULT single-best vs OPT-IN slate. The DEFAULT (no --slate) ships ONE verified-correct answer
// picked by the OBJECTIVE PROXY (deterministic, NO judge); the slate is opt-in. Each test pins one of
// the 5 honesty invariants from the design.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('#3 DEFAULT is single-best: certified + ≥2 admitted, no --slate ⇒ shipped-single*, pick set, slate null', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-sb-default-'));
  try {
    const r = await orchestrateProse(baseArgs(dir, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }], undefined));
    assert.equal(r.certified, true);
    assert.match(r.decision, /^shipped-single/, 'default mode ships a single best, never a slate');
    assert.ok(r.pick && r.pick.id, 'a single pick is set');
    assert.equal(r.slate, null, 'no slate in single-best mode');
    assert.equal(r.slateMode, false);
    assert.deepEqual([...r.admitted].sort(), ['author-good-a', 'author-good-b']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3 INV2 pick uses the OBJECTIVE PROXY, not the judge: proxy winner overrides a disagreeing judge', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-sb-proxy-'));
  try {
    // The judge would rank GOOD_B over GOOD_A; the proxy (specificity) ranks GOOD_A first (21 vs 14
    // digits). Single-best must follow the PROXY — the advisory judge is never consulted (invariant 2).
    const verdicts = { pairs: [{ a: 'author-good-a', b: 'author-good-b', winner: 'author-good-b' }] };
    const r = await orchestrateProse(baseArgs(dir, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }], verdicts));
    assert.equal(r.pick.id, 'author-good-a', 'the pick follows the objective proxy, NOT the judge verdict');
    assert.equal(r.pickBy, 'objective-proxy');
    assert.equal(r.decision, 'shipped-single');
    const json = JSON.parse(readFileSync(path.join(dir, 'run', 'run.json'), 'utf8'));
    assert.match(json.outcome.summary, /ranks first on/, 'a discriminating proxy names the basis');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3 INV3 top-tie [1,1,3] is FLAGGED (the corrected discriminator): tie-break, not a quality claim', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-sb-tie113-'));
  try {
    // TIE_X, TIE_Y share the BEST specificity (16 each); GOOD_B is lower (14) → ranks third. The two
    // best are TIED — the pick must fall to the deterministic id tie-break and be flagged, NOT claimed
    // as proxy-selected. (This is the [1,1,3] case the dense proxyRank would mis-flag as discriminated.)
    const r = await orchestrateProse(baseArgs(dir, [
      { id: 'author-tie-x', text: TIE_X },
      { id: 'author-tie-y', text: TIE_Y },
      { id: 'author-good-b', text: GOOD_B },
    ], undefined));
    assert.equal(r.decision, 'shipped-single-tiebroken');
    assert.equal(r.pickBy, 'tie-break');
    assert.equal(r.pick.id, 'author-tie-x', 'lexicographically-smallest id among the tied top');
    assert.ok(r.flags.includes('proxy-non-discriminating'), 'the non-discrimination is flagged');
    const json = JSON.parse(readFileSync(path.join(dir, 'run', 'run.json'), 'utf8'));
    assert.ok(json.outcome.caveats.some((c) => /objectively equivalent/.test(c) && /--slate/.test(c)), 'honest tie-break caveat pointing to --slate');
    assert.ok(!/ranks first on/.test(json.outcome.summary), 'a tie-broken pick NEVER claims it ranks first');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3 INV3 full non-discrimination (all admitted equal on the proxy) ⇒ id tie-break + flag', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-sb-allflat-'));
  try {
    const r = await orchestrateProse(baseArgs(dir, [{ id: 'author-tie-y', text: TIE_Y }, { id: 'author-tie-x', text: TIE_X }], undefined));
    assert.equal(r.pickBy, 'tie-break');
    assert.equal(r.pick.id, 'author-tie-x', 'id-min pick is order-independent');
    assert.ok(r.flags.includes('proxy-non-discriminating'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3 DETERMINISM: a top-tie picks the same id regardless of input order', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-sb-determ-'));
  try {
    const r1 = await orchestrateProse(baseArgs(dir, [{ id: 'author-tie-x', text: TIE_X }, { id: 'author-tie-y', text: TIE_Y }], undefined));
    const r2 = await orchestrateProse(baseArgs(dir, [{ id: 'author-tie-y', text: TIE_Y }, { id: 'author-tie-x', text: TIE_X }], undefined));
    assert.equal(r1.pick.id, r2.pick.id, 'deterministic pick, no input-order leak');
    assert.equal(r1.pick.id, 'author-tie-x');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3 INV5 all-pass MONOCULTURE is labelled UNMEASURABLE, never "converged"', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-sb-mono-'));
  try {
    const r = await orchestrateProse(baseArgs(dir, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }], undefined));
    assert.equal(r.dispersionMeasurable, false, 'the acceptance floor cannot discriminate the verified candidates');
    assert.ok(r.flags.includes('dispersion-unmeasurable'));
    const json = JSON.parse(readFileSync(path.join(dir, 'run', 'run.json'), 'utf8'));
    const blob = JSON.stringify(json.outcome) + JSON.stringify(r.flags);
    assert.ok(!/converged/i.test(blob), 'an all-pass monoculture must NOT read as converged/high-confidence');
    assert.ok(json.outcome.caveats.some((c) => /UNMEASURABLE/.test(c) && /discriminating probes/.test(c)), 'honest unmeasurable caveat that points at discriminating probes');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3 single admitted ⇒ sole-candidate (no fabricated competition)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-sb-sole-'));
  try {
    const r = await orchestrateProse(baseArgs(dir, [{ id: 'author-good-a', text: GOOD_A }], undefined));
    assert.equal(r.decision, 'shipped-single');
    assert.equal(r.pickBy, 'sole-candidate');
    assert.ok(r.flags.includes('single-admitted'));
    assert.equal(r.dispersionMeasurable, null, 'one candidate ⇒ nothing to disperse');
    const json = JSON.parse(readFileSync(path.join(dir, 'run', 'run.json'), 'utf8'));
    assert.ok(!json.outcome.caveats.some((c) => /tie-break|UNMEASURABLE/.test(c)), 'no competition/dispersion caveat for a sole candidate');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3 INV4 tier honesty: the pick carries the REAL verifiedTier, never an inbound a.tier', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-sb-tier-'));
  try {
    // GOOD_A wins the proxy; it arrives carrying a bogus laundered tier. The pick must carry the
    // gate-earned factual-evidence-pass, not the caller's claim.
    const r = await orchestrateProse(baseArgs(dir, [
      { id: 'author-good-a', text: GOOD_A, tier: 'repo-verified' },
      { id: 'author-good-b', text: GOOD_B },
    ], undefined));
    assert.equal(r.pick.id, 'author-good-a');
    assert.equal(r.pick.tier, 'factual-evidence-pass', 'pick tier is the gate-earned tier, not the inbound claim');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3 INV4 NO "advisory, you pick" caveat in single-best; the opt-in slate DOES carry it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-sb-nocaveat-'));
  try {
    const single = await orchestrateProse(baseArgs(dir, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }], undefined));
    const sj = JSON.parse(readFileSync(path.join(dir, 'run', 'run.json'), 'utf8'));
    assert.ok(!sj.outcome.caveats.some((c) => /advisory|you pick/i.test(c)), 'single-best correctness is settled — no advisory you-pick caveat');
    assert.ok(!/advisory/i.test(sj.outcome.confidence), 'confidence justifies dropping the advisory caveat, never claims advisory ranking');

    const dir2 = mkdtempSync(path.join(tmpdir(), 'gc-sb-slate-'));
    const args = baseArgs(dir2, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }], undefined);
    args.slate = true;
    const slate = await orchestrateProse(args);
    const lj = JSON.parse(readFileSync(path.join(dir2, 'run', 'run.json'), 'utf8'));
    assert.equal(slate.decision, 'shipped-slate');
    assert.ok(lj.outcome.caveats.some((c) => /ADVISORY/i.test(c)), 'the opt-in slate keeps the advisory you-pick framing (quality, not correctness, differs there)');
    rmSync(dir2, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3 OPT-IN slate unchanged: --slate ⇒ shipped-slate, advisory, pick null', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-sb-optin-'));
  try {
    const args = baseArgs(dir, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }], { pairs: [{ a: 'author-good-a', b: 'author-good-b', winner: 'author-good-a' }] });
    args.slate = true;
    const r = await orchestrateProse(args);
    assert.equal(r.decision, 'shipped-slate');
    assert.equal(r.pick, null);
    assert.equal(r.slate.length, 2);
    assert.equal(r.rankingIsAdvisory, true);
    assert.equal(r.selectBy, 'human');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3 DECLINE branches are byte-identical with --slate absent / true / false (mode-split is scoped)', async () => {
  // no-verified (all wrong), blocked (all author-collisions), advisory-only (uncertified floor).
  const cases = {
    'no-verified': (dir, slate) => { const a = baseArgs(dir, [{ id: 'author-x', text: BAD }], undefined); if (slate !== undefined) a.slate = slate; return a; },
    blocked: (dir, slate) => { const a = baseArgs(dir, [{ id: 'a', text: GOOD_A, answerAuthor: 'agent-claim' }, { id: 'b', text: GOOD_B, answerAuthor: 'agent-adversary' }], undefined); if (slate !== undefined) a.slate = slate; return a; },
    'advisory-only': (dir, slate) => { const a = baseArgs(dir, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }], undefined); a.redAnswer = GOOD_A; if (slate !== undefined) a.slate = slate; return a; },
  };
  for (const [expected, mk] of Object.entries(cases)) {
    const decisions = [];
    for (const slate of [undefined, true, false]) {
      const dir = mkdtempSync(path.join(tmpdir(), `gc-sb-decl-${expected}-`));
      try { decisions.push((await orchestrateProse(mk(dir, slate))).decision); }
      finally { rmSync(dir, { recursive: true, force: true }); }
    }
    assert.deepEqual(decisions, [expected, expected, expected], `${expected} decline is unaffected by the slate flag`);
  }
});

test('#3 degrade-not-crash: a non-finite proxy value degrades to an id tie-break, never throws', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-sb-degrade-'));
  try {
    const args = baseArgs(dir, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }], undefined);
    args.proxies = [{ name: 'boom', of: (c) => (c.id === 'author-good-b' ? NaN : 5), prefer: 'higher' }];
    const r = await orchestrateProse(args);   // must NOT throw
    assert.match(r.decision, /^shipped-single/);
    assert.equal(r.pickBy, 'tie-break');
    assert.ok(r.flags.includes('proxy-unmeasurable'));
    assert.equal(r.pick.id, 'author-good-a', 'id-min over the admitted set');
    const json = JSON.parse(readFileSync(path.join(dir, 'run', 'run.json'), 'utf8'));
    assert.ok(json.outcome.caveats.some((c) => /unmeasurable/i.test(c)), 'the proxy error is surfaced honestly');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3 AR-HIGH: duplicate admitted ids THROW in EVERY proxy configuration (incl. the degrade paths)', async () => {
  // Two admitted answers sharing an id would let a hand-rolled fallback fabricate indistinguishable rows
  // and ship whichever appeared first (input-order-dependent) while claiming a deterministic tie-break. It
  // must SURFACE as an error in ALL paths — the discriminating proxy path AND both degrade paths (empty
  // proxies, non-finite proxy) — never a silent ship. (Confirm-pass HIGH: the degrade branches bypassed it.)
  const configs = {
    'finite proxy (rankByProxies path)': undefined,
    'empty proxies (degrade path)': [],
    'non-finite proxy (degrade path)': [{ name: 'boom', of: () => NaN, prefer: 'higher' }],
  };
  for (const [label, proxies] of Object.entries(configs)) {
    const dir = mkdtempSync(path.join(tmpdir(), 'gc-sb-dupid-'));
    try {
      const args = baseArgs(dir, [{ id: 'dup', text: GOOD_A }, { id: 'dup', text: GOOD_B }], undefined);
      if (proxies !== undefined) args.proxies = proxies;
      await assert.rejects(orchestrateProse(args), /duplicate/i, `duplicate admitted ids must throw — ${label}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('#3 AR-HIGH: a MALFORMED proxy declaration surfaces (throws), even when its value is non-finite', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-sb-badproxy-'));
  try {
    // A proxy with a bad `prefer` AND a non-finite value must NOT be laundered by the non-finite degrade —
    // a malformed DECLARATION is a structural setup error and must surface (it does in slate mode too).
    const args = baseArgs(dir, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }], undefined);
    args.proxies = [{ name: '', of: () => NaN, prefer: 'sideways' }];
    await assert.rejects(orchestrateProse(args), /non-empty name|prefer/i, 'a malformed proxy declaration must throw, not degrade');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3 empty proxies ⇒ deterministic id tie-break (nothing to measure), not a crash', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-sb-noproxy-'));
  try {
    const args = baseArgs(dir, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }], undefined);
    args.proxies = [];   // no objective proxy declared at all
    const r = await orchestrateProse(args);
    assert.match(r.decision, /^shipped-single/);
    assert.equal(r.pickBy, 'tie-break');
    assert.ok(r.flags.includes('proxy-unmeasurable'));
    assert.equal(r.pick.id, 'author-good-a', 'id-min over the admitted set');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3 AR-MED2: each proxy is evaluated ONCE per candidate — a stateful proxy cannot diverge between pre-check and rank', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-sb-memo-'));
  try {
    // A deliberately IMPURE proxy: finite on the FIRST evaluation per candidate, NaN thereafter. Without
    // single-evaluation it would pass the non-finite pre-check (call #1 → finite) then throw inside
    // rankByProxies (call #2 → NaN). Memoization makes both observe the same value ⇒ no throw, ranks normally.
    const seen = new Map();
    const args = baseArgs(dir, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }], undefined);
    args.proxies = [{ name: 'stateful', prefer: 'higher', of: (c) => {
      const n = (seen.get(c.id) || 0) + 1; seen.set(c.id, n);
      return n === 1 ? (c.id === 'author-good-a' ? 10 : 5) : NaN;   // finite once, then NaN
    } }];
    const r = await orchestrateProse(args);   // must NOT throw
    assert.match(r.decision, /^shipped-single/);
    assert.equal(r.pickBy, 'objective-proxy', 'consistent finite values let the proxy discriminate');
    assert.equal(r.pick.id, 'author-good-a');
    for (const v of seen.values()) assert.equal(v, 1, 'each proxy.of(candidate) is evaluated exactly once');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3 AR-MED: a tie-broken pick confidence must NOT claim the choice was the objective proxy', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-sb-conf-tie-'));
  try {
    const tie = await orchestrateProse(baseArgs(dir, [{ id: 'author-tie-x', text: TIE_X }, { id: 'author-tie-y', text: TIE_Y }], undefined));
    assert.equal(tie.pickBy, 'tie-break');
    const tj = JSON.parse(readFileSync(path.join(dir, 'run', 'run.json'), 'utf8'));
    assert.ok(!/choice among equally-correct candidates is a DETERMINISTIC objective proxy/i.test(tj.outcome.confidence), 'must NOT claim the proxy chose it');
    assert.match(tj.outcome.confidence, /id tie-break/i, 'tie-break confidence states the deterministic id tie-break');
    assert.match(tj.outcome.confidence, /not .*measured superiority/i);

    // Contrast: a discriminating proxy DOES state the proxy basis.
    const dir2 = mkdtempSync(path.join(tmpdir(), 'gc-sb-conf-proxy-'));
    const pj = await orchestrateProse(baseArgs(dir2, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }], undefined));
    const j2 = JSON.parse(readFileSync(path.join(dir2, 'run', 'run.json'), 'utf8'));
    assert.equal(pj.pickBy, 'objective-proxy');
    assert.match(j2.outcome.confidence, /objective proxy/i, 'the discriminating case states the proxy basis');
    rmSync(dir2, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3 AR-LOW: the dispersion caveat must not claim "by-proxy" when the pick was a tie-break', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-sb-disp-tie-'));
  try {
    const r = await orchestrateProse(baseArgs(dir, [{ id: 'author-tie-x', text: TIE_X }, { id: 'author-tie-y', text: TIE_Y }], undefined));
    assert.equal(r.pickBy, 'tie-break');
    assert.equal(r.dispersionMeasurable, false);
    const json = JSON.parse(readFileSync(path.join(dir, 'run', 'run.json'), 'utf8'));
    assert.ok(json.outcome.caveats.some((c) => /UNMEASURABLE/.test(c)), 'the unmeasurable caveat is present');
    assert.ok(!json.outcome.caveats.some((c) => /by-proxy/i.test(c)), 'no "by-proxy" claim when the pick was a tie-break');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── #3(D) — HELD-OUT DISCRIMINATING PROBES: make dispersion MEASURABLE without touching admission ──────
// A probe is a claim-shaped check NOT in the acceptance set. It runs measurement-only over the ADMITTED
// answers to label behavioural diversity the all-pass floor can't — it NEVER gates or picks.
const PROBE_COMMON = { id: 'probe-common-year', kind: 'must-include', text: 'common year' };  // A pass, B fail → DIVERGE
const PROBE_USUAL = { id: 'probe-usual', kind: 'must-include', text: 'usual' };                // A FAIL, B pass
const PROBE_FEB = { id: 'probe-february', kind: 'must-include', text: 'February' };            // both pass
const PROBE_ABSENT = { id: 'probe-absent', kind: 'must-include', text: 'xylophone' };          // both fail

test('#3(D) held-out probes make dispersion MEASURABLE + DIVERSE when admits differ on a probe', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-d-diverse-'));
  try {
    const args = baseArgs(dir, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }], undefined);
    args.discriminatingProbes = [PROBE_COMMON];   // A passes, B fails → the verified pair DIFFERS behaviourally
    const r = await orchestrateProse(args);
    assert.match(r.decision, /^shipped-single/);
    assert.equal(r.dispersionMeasurable, true, 'a held-out probe that varies makes dispersion measurable');
    assert.equal(r.dispersionState, 'diverse');
    assert.ok(r.flags.includes('behaviourally-diverse'));
    const json = JSON.parse(readFileSync(path.join(dir, 'run', 'run.json'), 'utf8'));
    assert.ok(json.outcome.caveats.some((c) => /DIVERSE/.test(c) && /--slate/.test(c)), 'the diverse caveat nudges toward --slate');
    assert.ok(!json.outcome.caveats.some((c) => /UNMEASURABLE/.test(c)), 'no longer unmeasurable once a probe discriminates');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3(D) held-out probes report CONVERGED when admits behave identically on every probe', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-d-conv-'));
  try {
    const args = baseArgs(dir, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }], undefined);
    args.discriminatingProbes = [PROBE_FEB, PROBE_ABSENT];   // both pass p-feb, both fail p-absent → identical signatures
    const r = await orchestrateProse(args);
    assert.equal(r.dispersionMeasurable, true);
    assert.equal(r.dispersionState, 'converged');
    assert.ok(r.flags.includes('behaviourally-converged'));
    const json = JSON.parse(readFileSync(path.join(dir, 'run', 'run.json'), 'utf8'));
    const conv = json.outcome.caveats.find((c) => /CONVERGED/.test(c));
    assert.ok(conv, 'converged caveat present');
    // AR-MED1: the caveat must NOT overclaim broad equivalence — only "no measured diversity ON THE SUPPLIED
    // PROBES" (two answers identical on the probes can still differ on a property no probe tested).
    assert.match(conv, /supplied/i);
    assert.match(conv, /no measured diversity/i);
    assert.ok(!/equivalent beyond the acceptance floor/i.test(conv), 'must not claim broad equivalence');
    assert.ok(!/right output/i.test(conv), 'must not claim it is the right output');
    assert.ok(!json.outcome.caveats.some((c) => /--slate/.test(c)), 'no --slate nudge when no diversity is measured');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3(D) HONESTY: probes NEVER gate admission or change the pick — only the dispersion label', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-d-honesty-'));
  const dir2 = mkdtempSync(path.join(tmpdir(), 'gc-d-honesty2-'));
  try {
    // Baseline (no probes).
    const r0 = await orchestrateProse(baseArgs(dir, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }, { id: 'author-bad', text: BAD }], undefined));
    // WITH probes — including one the PROXY WINNER (good-a) FAILS (it lacks "usual"). Admission + pick must be unchanged.
    const a1 = baseArgs(dir2, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }, { id: 'author-bad', text: BAD }], undefined);
    a1.discriminatingProbes = [PROBE_USUAL, PROBE_COMMON];
    const r1 = await orchestrateProse(a1);

    assert.deepEqual([...r1.admitted].sort(), [...r0.admitted].sort(), 'admission is identical — probes do NOT gate');
    assert.deepEqual([...r1.admitted].sort(), ['author-good-a', 'author-good-b'], 'the wrong answer is killed by the FLOOR, not the probes');
    assert.equal(r1.pick.id, r0.pick.id, 'the pick is identical with vs without probes — probes never influence the objective-proxy pick');
    assert.equal(r1.pick.id, 'author-good-a', 'good-a is the proxy pick EVEN THOUGH it fails a probe');
    assert.equal(r1.pickBy, r0.pickBy);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(dir2, { recursive: true, force: true }); }
});

test('#3(D) a probe id colliding with an acceptance check id is a STRUCTURAL error (throw)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-d-collide-'));
  try {
    const args = baseArgs(dir, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }], undefined);
    args.discriminatingProbes = [{ id: 'c-28', kind: 'must-include', text: 'common year' }];   // 'c-28' IS an acceptance claim id
    await assert.rejects(orchestrateProse(args), /collides with an acceptance check id|held-out/i, 'a probe must not share an id with a gate check');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3(D)/AR: a structural abort finishes the dossier as a declined setup-error (no hung "running" page)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-d-abort-'));
  try {
    const args = baseArgs(dir, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }], undefined);
    args.discriminatingProbes = [{ id: 'c-28', kind: 'must-include', text: 'common year' }];   // collides → throws mid-M4
    await assert.rejects(orchestrateProse(args), /collides/i);
    // The live source-of-truth page must be FINISHED (declined setup-error), not left active.
    const json = JSON.parse(readFileSync(path.join(dir, 'run', 'run.json'), 'utf8'));
    assert.equal(json.outcome.decision, 'setup-error', 'the dossier is finished as a setup-error, not hung active');
    assert.equal(json.status, 'declined');
    assert.match(json.outcome.summary, /ABORTED/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3(D)/AR: an abort on an UNCERTIFIED floor does not claim the floor certified', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-d-abort-unc-'));
  try {
    // Uncertified floor (red baseline passes everything) AND duplicate answer ids → the advisory-only branch
    // throws on the dup id before it finalizes. The setup-error summary must NOT claim the floor certified.
    const args = baseArgs(dir, [{ id: 'dup', text: GOOD_A }, { id: 'dup', text: GOOD_B }], { pairs: [] });
    args.redAnswer = GOOD_A;   // non-discriminating red ⇒ certification fails
    await assert.rejects(orchestrateProse(args), /duplicate/i);
    const json = JSON.parse(readFileSync(path.join(dir, 'run', 'run.json'), 'utf8'));
    assert.equal(json.outcome.decision, 'setup-error');
    assert.ok(!/floor certified/.test(json.outcome.summary), 'must NOT claim the floor certified on an uncertified abort');
    assert.match(json.outcome.summary, /FAILED certification/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3(D) a malformed probe (unknown kind) surfaces (throws), never silently mis-measures', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-d-badprobe-'));
  try {
    const args = baseArgs(dir, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }], undefined);
    args.discriminatingProbes = [{ id: 'probe-x', kind: 'telepathy', text: 'whatever' }];
    await assert.rejects(orchestrateProse(args), /invalid probe|unknown kind/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3(D) backward compatible: no probes ⇒ dispersion stays UNMEASURABLE (today\'s behaviour)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-d-none-'));
  try {
    const r = await orchestrateProse(baseArgs(dir, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }], undefined));
    assert.equal(r.dispersionMeasurable, false);
    assert.equal(r.dispersionState, 'unmeasurable');
    assert.ok(r.flags.includes('dispersion-unmeasurable'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#3(D) AR-MED2: validateProbeRows rejects a malformed runProbes output (never silently mis-measures)', () => {
  const ids = ['a', 'b'];
  const probeIds = ['p1', 'p2'];
  const good = [{ id: 'a', perProbe: { p1: 'pass', p2: 'fail' } }, { id: 'b', perProbe: { p1: 'pass', p2: 'pass' } }];
  const m = validateProbeRows(good, ids, probeIds);
  assert.equal(m.get('a').p2, 'fail');
  // not an array
  assert.throws(() => validateProbeRows({}, ids, probeIds), /must return an array/i);
  // missing a candidate row (only 'a')
  assert.throws(() => validateProbeRows([good[0]], ids, probeIds), /exactly one row per admitted id/i);
  // an extra / non-admitted id
  assert.throws(() => validateProbeRows([...good, { id: 'zzz', perProbe: { p1: 'pass', p2: 'pass' } }], ids, probeIds), /unexpected|non-admitted/i);
  // duplicate row for the same id
  assert.throws(() => validateProbeRows([good[0], good[0]], ids, probeIds), /duplicate/i);
  // missing a probe key
  assert.throws(() => validateProbeRows([{ id: 'a', perProbe: { p1: 'pass' } }, good[1]], ids, probeIds), /invalid\/missing result for probe/i);
  // a status that is not exactly pass/fail
  assert.throws(() => validateProbeRows([{ id: 'a', perProbe: { p1: 'pass', p2: 'skip' } }, good[1]], ids, probeIds), /must be 'pass'\|'fail'/i);
  // INHERITED verdicts (prototype pollution) must be rejected — own props required (parity with mutation-probes)
  assert.throws(() => validateProbeRows([{ id: 'a', perProbe: Object.create({ p1: 'pass', p2: 'fail' }) }, good[1]], ids, probeIds), /invalid\/missing result/i);
});

test('#3 dossier shows NO false-verified banner on a single-best ship (the pick is an evidenced candidate)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-sb-banner-'));
  try {
    const r = await orchestrateProse(baseArgs(dir, [{ id: 'author-good-a', text: GOOD_A }, { id: 'author-good-b', text: GOOD_B }], undefined));
    assert.match(r.decision, /^shipped-single/);
    const html = readFileSync(path.join(dir, 'run', 'index.html'), 'utf8');
    // Assert the banner TEXT is absent (the `.oWarn` CSS rule is always in the <style> block, so a
    // class-token match would false-positive — check the rendered warning message itself).
    assert.ok(!/Page claims a verified tier/.test(html), 'no display-honesty warning banner — the shipped pick carries gate evidence');
    assert.ok(!/no candidate with a gate-evidence artifact/.test(html));
    assert.match(html, /FACTUAL-EVIDENCE-PASS/i, 'the verified tier is shown');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
