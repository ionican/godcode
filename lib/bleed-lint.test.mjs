// bleed-lint.test — the pre-certify advisory lint. PURE (no git, no child process). Asserts it
// MIRRORS certify's predicates (decorrelation / red-baseline / clean-kill bleed rule) in-process and
// stays strictly advisory (predicts, never certifies). The single-source-of-truth agreement between
// the in-process predicate and the emitted oracle is tested in prose-verifier.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bleedLint } from './bleed-lint.mjs';

// Build a structurally-valid certificate from claims + antiCandidates (mirrors construct-prose-verifier's
// assembly: one requirement per requirementId, checkIds = its claims' ids, antiCandidateId = its anti).
function mkCertificate(claims, antiCandidates, { claimAuthor = 'claim-agent', adversary = 'adversary-agent', residual = 'string checks only; reasoning not verified' } = {}) {
  const reqIds = [...new Set(claims.map((c) => c.requirementId))];
  const requirements = reqIds.map((rid) => ({
    id: rid,
    checkIds: claims.filter((c) => c.requirementId === rid).map((c) => c.id),
    antiCandidateId: (antiCandidates.find((a) => a.requirementId === rid) || {}).id,
  }));
  return {
    tierCeiling: 'factual-evidence-pass', requirements,
    provenance: { source: 'board ground truth', timing: '2026-06-28', path: 'source.md', hash: 'deadbeef' },
    constructorProvenance: { claimAuthor, adversary }, residual,
  };
}
const lintOf = (claims, antiCandidates, redAnswer, source, opts = {}) => bleedLint({
  claims, certificate: mkCertificate(claims, antiCandidates, opts), antiCandidates, redAnswer, source,
  answerAuthor: opts.answerAuthor || 'answer-agents',
});

// ── REQUIRED: the ieee754 dogfood — a grounded check on an over-specific phrasing bleeds across reqs ──
test('ieee754 bleed: grounded "one ULP apart" on requirement A is tripped by requirement B\'s near-miss', () => {
  const source = 'The two doubles are one ULP apart; each input is rounded to the nearest representable value (round-to-nearest).';
  const claims = [
    { id: 'precision-ulp', kind: 'grounded', requirementId: 'precision', quote: 'one ULP apart' },
    { id: 'rounding-rtn', kind: 'must-include', requirementId: 'rounding', text: 'round-to-nearest' },
  ];
  const antiCandidates = [
    // precision near-miss: correct on rounding (says 'round-to-nearest'), but omits the exact 'one ULP
    // apart' phrase → fails ONLY precision-ulp (its own) → clean kill, no bleed.
    { id: 'anti-precision', requirementId: 'precision', answer: 'Each value is rounded to the nearest double (round-to-nearest); the results differ in the last bit.' },
    // rounding near-miss: a COMPLETE answer correct on precision but PHRASED differently ('one unit in
    // the last place apart', NOT 'one ULP apart') and missing 'round-to-nearest' → fails rounding-rtn
    // (own) AND the foreign precision-ulp grounded check → BLEED.
    { id: 'anti-rounding', requirementId: 'rounding', answer: 'The two doubles end up one unit in the last place apart; each input is rounded to the closest representable value.' },
  ];
  const red = 'It is simply a bug; the answer should be exactly right.';
  const r = lintOf(claims, antiCandidates, red, source);

  const rounding = r.requirements.find((x) => x.id === 'rounding');
  assert.deepEqual(rounding.bleedFailures, [{ checkId: 'precision-ulp', foreignRequirementId: 'precision' }]);
  assert.equal(rounding.killed, false);
  assert.equal(rounding.reason, 'bleed');
  const precision = r.requirements.find((x) => x.id === 'precision');
  assert.equal(precision.killed, true, 'the precision near-miss is cleanly killed (no bleed)');
  assert.equal(r.allKilled, false);
  assert.equal(r.conjuncts.allAntiCleanKilled, false);
  assert.equal(r.wouldCertify, false, 'a bleed sinks certification');
  assert.equal(r.reauthorable, true, 'a bleed is claim-author fixable');
  assert.ok(r.reauthorFeedback.some((l) => l.startsWith('BLEED:') && l.includes('precision-ulp') && l.includes('precision')),
    'a BLEED line names the foreign check + requirement');
});

// ── REQUIRED: a brittle PRESENCE check the source itself fails — advisory, never a wouldCertify input ──
test('brittle: a must-include whose text is absent from the SOURCE is flagged, but does NOT block certify', () => {
  const source = 'Alpha is the first letter; nothing here mentions the other word.';
  const claims = [
    { id: 'r1-alpha', kind: 'must-include', requirementId: 'r1', text: 'Alpha' },     // in source — fine
    { id: 'r1-brittle', kind: 'must-include', requirementId: 'r1', text: 'quantum' }, // NOT in source — brittle
  ];
  const antiCandidates = [{ id: 'anti-r1', requirementId: 'r1', answer: 'A near-miss that drops both required words entirely.' }];
  const red = 'Totally unrelated baseline text.';
  const r = lintOf(claims, antiCandidates, red, source);

  assert.ok(r.brittle.some((b) => b.checkId === 'r1-brittle'), 'the source-failing presence check is flagged brittle');
  assert.ok(!r.brittle.some((b) => b.checkId === 'r1-alpha'), 'a check the source passes is not brittle');
  assert.ok(!('brittle' in r.conjuncts), 'brittle is NOT one of the four wouldCertify conjuncts');
  assert.equal(r.wouldCertify, true, 'brittleness alone does not block certification (clean kill + red-goes-red + decorrelated)');
  assert.ok(r.reauthorFeedback.some((l) => l.startsWith('BRITTLE:') && l.includes('r1-brittle')), 'a BRITTLE feedback line is emitted');
  assert.equal(r.reauthorable, false, 'a wouldCertify=true run is never reauthorable (brittle is advisory)');
});

// ── REQUIRED: a clean verifier predicts wouldCertify=true at the capped tier ──
function cleanCeres() {
  const source = [
    'Ceres is the largest object in the asteroid belt between Mars and Jupiter.',
    'Ceres has a mass of about 938 quintillion kilograms.',
    'It is classified as a dwarf planet and is not a gas giant.',
  ].join(' ');
  const claims = [
    { id: 'names-ceres', kind: 'must-include', requirementId: 'req-names', text: 'Ceres' },
    { id: 'mass-value', kind: 'number-matches', requirementId: 'req-mass', value: '938 quintillion' },
    { id: 'grounded-belt', kind: 'grounded', requirementId: 'req-belt', quote: 'largest object in the asteroid belt' },
    { id: 'no-gas-giant', kind: 'must-exclude', requirementId: 'req-gas', text: 'gas giant' },
  ];
  const antiCandidates = [
    { id: 'anti-names', requirementId: 'req-names', answer: 'This body is the largest object in the asteroid belt and is a dwarf planet. Its mass is about 938 quintillion kilograms.' },
    { id: 'anti-mass', requirementId: 'req-mass', answer: 'Ceres is the largest object in the asteroid belt and is a dwarf planet. Its mass is about 500 quintillion kilograms.' },
    { id: 'anti-belt', requirementId: 'req-belt', answer: 'Ceres is a dwarf planet orbiting between Mars and Jupiter. Its mass is about 938 quintillion kilograms.' },
    { id: 'anti-gas', requirementId: 'req-gas', answer: 'Ceres is the largest object in the asteroid belt, a dwarf planet, not a gas giant. Its mass is about 938 quintillion kilograms.' },
  ];
  const red = 'An unrelated gas giant of unknown mass.';
  return { claims, antiCandidates, red, source };
}

test('clean verifier: wouldCertify=true, all four conjuncts true, tier capped at the ceiling', () => {
  const { claims, antiCandidates, red, source } = cleanCeres();
  const r = lintOf(claims, antiCandidates, red, source);
  assert.equal(r.wouldCertify, true);
  assert.deepEqual(r.conjuncts, { structureValid: true, decorrelated: true, redBaselineGoesRed: true, allAntiCleanKilled: true });
  assert.equal(r.allKilled, true);
  assert.equal(r.redBaseline.goesRed, true);
  assert.equal(r.decorrelation.ok, true);
  assert.equal(r.structural.valid, true);
  assert.equal(r.predictedTier, 'factual-evidence-pass', 'tier == the certificate ceiling, never above it');
  assert.equal(r.confidence, 'predicted-pass');
  assert.deepEqual(r.brittle, [], 'no brittle: must-exclude on source is NOT flagged (exclusion kind skipped)');
  assert.equal(r.reauthorable, false);
});

// ── REQUIRED: the lint never CLAIMS certified — it only predicts ──
test('lint never claims certified: no `certified` key, no admitted tier, confidence is a prediction, blocking=false', () => {
  const { claims, antiCandidates, red, source } = cleanCeres();
  const r = lintOf(claims, antiCandidates, red, source);
  assert.ok(!('certified' in r), 'report has NO certified key — it predicts, it does not certify');
  assert.ok(!('admitted' in r), 'the lint admits nothing');
  assert.ok(['predicted-pass', 'predicted-fail'].includes(r.confidence), 'confidence is a prediction, never "certified"');
  assert.equal(r.blocking, false, 'the lint never blocks');
});

test('non-discriminating red baseline: red passes every expected check ⇒ goesRed=false ⇒ wouldCertify=false', () => {
  const { claims, antiCandidates, source } = cleanCeres();
  // A "red" answer that actually satisfies every check (so it fails to discriminate).
  const red = 'Ceres is the largest object in the asteroid belt, a dwarf planet. Its mass is about 938 quintillion kilograms.';
  const r = lintOf(claims, antiCandidates, red, source);
  assert.equal(r.redBaseline.goesRed, false);
  assert.deepEqual(r.redBaseline.failedExpected, []);
  assert.equal(r.redBaseline.reason, 'no EXPECTED red check actually failed');
  assert.equal(r.conjuncts.redBaselineGoesRed, false);
  assert.equal(r.wouldCertify, false);
  assert.equal(r.reauthorable, true, 'a non-discriminating red is claim-author fixable');
  assert.ok(r.reauthorFeedback.some((l) => l.startsWith('NON-DISCRIMINATION:') && l.includes('red baseline')));
});

test('non-discriminating anti: an anti that survives its own requirement ⇒ not killed, reason "no on-target check failed"', () => {
  const { claims, antiCandidates, red, source } = cleanCeres();
  // Replace anti-names with one that passes ALL checks (including names-ceres) — survives its own req.
  const antis = antiCandidates.map((a) => a.id === 'anti-names'
    ? { ...a, answer: 'Ceres is the largest object in the asteroid belt, a dwarf planet. Its mass is about 938 quintillion kilograms.' }
    : a);
  const r = lintOf(claims, antis, red, source);
  const names = r.requirements.find((x) => x.id === 'req-names');
  assert.deepEqual(names.onTargetFailures, []);
  assert.equal(names.killed, false);
  assert.equal(names.reason, 'no on-target check failed');
  assert.equal(r.allKilled, false);
  assert.equal(r.reauthorable, true);
});

test('mis-wired anti: an anti matched on requirementId only (not antiCandidateId) is treated as missing', () => {
  const { claims, antiCandidates, red, source } = cleanCeres();
  // Give the req-mass anti a requirementId that does NOT match (certify matches on BOTH id AND requirementId).
  const antis = antiCandidates.map((a) => a.id === 'anti-mass' ? { ...a, requirementId: 'req-WRONG' } : a);
  const r = lintOf(claims, antis, red, source);
  const mass = r.requirements.find((x) => x.id === 'req-mass');
  assert.equal(mass.antiFound, false);
  assert.equal(mass.killed, false);
  assert.equal(mass.reason, 'no anti-candidate');
  assert.equal(r.allKilled, false);
});

test('decorrelation collapse is a hard precondition: clean kills do not compensate, and it is NOT reauthorable', () => {
  const { claims, antiCandidates, red, source } = cleanCeres();
  // answerAuthor === claimAuthor — a role collision. Everything else is clean.
  const r = lintOf(claims, antiCandidates, red, source, { answerAuthor: 'claim-agent' });
  assert.equal(r.decorrelation.ok, false);
  assert.equal(r.conjuncts.decorrelated, false);
  assert.equal(r.wouldCertify, false, 'clean kills + red-goes-red do NOT compensate for a decorrelation collapse');
  assert.equal(r.predictedTier, 'advisory-slate');
  assert.equal(r.reauthorable, false, 'author identity is a harness fact — re-authoring claims cannot fix it');
  assert.ok(!r.reauthorFeedback.some((l) => l.toLowerCase().includes('decorrel')), 'no re-author feedback for decorrelation');
});

test('near/not-near anchor-absent + window fallback semantics are preserved (re-uses the emitted predicate)', () => {
  // near: anchor absent in the anti → that check FAILS (cannot be near a missing anchor).
  // not-near: anchor absent → PASSES (vacuous). Window default 50 vs explicit 5.
  const source = 'alpha beta and the marker token sit close; alpha appears here.';
  const claims = [
    { id: 'r1-near', kind: 'near', requirementId: 'r1', anchor: 'alpha', token: 'beta', window: 50 },
    { id: 'r2-notnear', kind: 'not-near', requirementId: 'r2', anchor: 'marker', token: 'token', window: 10 },
  ];
  const antiCandidates = [
    // r1 near-miss: drops 'alpha' entirely → r1-near FAILS (anchor absent) = on-target; passes r2 (no 'marker') → clean.
    { id: 'anti-r1', requirementId: 'r1', answer: 'no anchors here, just filler words far apart.' },
    // r2 near-miss: puts 'token' right next to 'marker' → r2-notnear FAILS (token within window) = on-target;
    // also has 'alpha' near 'beta' so r1-near PASSES (no bleed).
    { id: 'anti-r2', requirementId: 'r2', answer: 'alpha beta together; and marker token adjacent here.' },
  ];
  const red = 'nothing relevant';
  const r = lintOf(claims, antiCandidates, red, source);
  assert.equal(r.requirements.find((x) => x.id === 'r1').killed, true, 'near fails on absent anchor → on-target kill');
  assert.equal(r.requirements.find((x) => x.id === 'r2').killed, true, 'not-near fails when token is within window → on-target kill');
  assert.deepEqual(r.requirements.find((x) => x.id === 'r1').bleedFailures, [], 'no bleed');
  assert.deepEqual(r.requirements.find((x) => x.id === 'r2').bleedFailures, []);
});

// ── Codex AR folds (cross-model review of the bleed-lint change) ───────────────────────────────
test('AR HIGH1: reauthorable requires HARD preconditions clean — a decorrelation collapse + non-discriminating red is NOT reauthorable', () => {
  const { claims, antiCandidates, source } = cleanCeres();
  // A "red" that passes EVERY check → redNonDiscrim=true (a fixable signal) ...
  const redPasses = 'Ceres is the largest object in the asteroid belt, a dwarf planet. Its mass is about 938 quintillion kilograms.';
  // ... AND a decorrelation collapse (answerAuthor === claimAuthor) — a NON-fixable hard failure.
  const r = lintOf(claims, antiCandidates, redPasses, source, { answerAuthor: 'claim-agent' });
  assert.equal(r.redBaseline.goesRed, false);
  assert.equal(r.decorrelation.ok, false);
  assert.equal(r.wouldCertify, false);
  assert.equal(r.reauthorable, false, 'a non-fixable hard failure present ⇒ NOT reauthorable; it must surface via the real certify, not be hidden behind a re-author short-circuit');
});

test('AR HIGH2: a claim with a MISSING id ⇒ structural invalid ⇒ wouldCertify false (no in-process/oracle id divergence)', () => {
  const source = 'alpha is here';
  const r = bleedLint({
    claims: [{ kind: 'must-include', requirementId: 'r1', text: 'alpha' }], // NO id
    certificate: { tierCeiling: 'factual-evidence-pass', requirements: [{ id: 'r1', checkIds: ['0'], antiCandidateId: 'anti-r1' }], provenance: { source: 's', timing: 't', path: 'p', hash: 'h' }, constructorProvenance: { claimAuthor: 'ca', adversary: 'adv' }, residual: 'r' },
    antiCandidates: [{ id: 'anti-r1', requirementId: 'r1', answer: 'no required word' }], redAnswer: 'unrelated', source, answerAuthor: 'aa',
  });
  assert.equal(r.structural.valid, false, 'a claim with no id is structurally invalid (the oracle would emit "undefined" while the lint invents an index key)');
  assert.equal(r.wouldCertify, false);
});

test('AR HIGH3: a claim id with a TAP-special char (#) ⇒ structural invalid (it truncates in the emitted TAP)', () => {
  const source = 'alpha is here';
  const r = bleedLint({
    claims: [{ id: 'AC #1', kind: 'must-include', requirementId: 'r1', text: 'alpha' }],
    certificate: { tierCeiling: 'factual-evidence-pass', requirements: [{ id: 'r1', checkIds: ['AC #1'], antiCandidateId: 'anti-r1' }], provenance: { source: 's', timing: 't', path: 'p', hash: 'h' }, constructorProvenance: { claimAuthor: 'ca', adversary: 'adv' }, residual: 'r' },
    antiCandidates: [{ id: 'anti-r1', requirementId: 'r1', answer: 'no required word' }], redAnswer: 'unrelated', source, answerAuthor: 'aa',
  });
  assert.equal(r.structural.valid, false);
  assert.equal(r.wouldCertify, false);
});

test('AR MED2: a claim NOT owned by any requirement ⇒ structural invalid (lint stays conservative vs an unowned emitted check)', () => {
  const source = 'alpha and beta are here';
  const r = bleedLint({
    claims: [
      { id: 'c-owned', kind: 'must-include', requirementId: 'r1', text: 'alpha' },
      { id: 'c-unowned', kind: 'must-include', requirementId: 'r1', text: 'beta' }, // baked into the oracle but absent from checkIds
    ],
    certificate: { tierCeiling: 'factual-evidence-pass', requirements: [{ id: 'r1', checkIds: ['c-owned'], antiCandidateId: 'anti-r1' }], provenance: { source: 's', timing: 't', path: 'p', hash: 'h' }, constructorProvenance: { claimAuthor: 'ca', adversary: 'adv' }, residual: 'r' },
    antiCandidates: [{ id: 'anti-r1', requirementId: 'r1', answer: 'neither word present' }], redAnswer: 'unrelated', source, answerAuthor: 'aa',
  });
  assert.ok(r.structural.problems.some((p) => p.includes('c-unowned')), 'the unowned emitted claim is flagged');
  assert.equal(r.structural.valid, false);
  assert.equal(r.wouldCertify, false);
});

test('structural problems (invalid certificate) ⇒ wouldCertify false, not reauthorable', () => {
  const source = 'alpha is here';
  const claims = [{ id: 'c1', kind: 'must-include', requirementId: 'r1', text: 'alpha' }];
  const antiCandidates = [{ id: 'anti-r1', requirementId: 'r1', answer: 'no required word' }];
  // Hand a BROKEN certificate (empty residual) so validateCertificate fails.
  const r = bleedLint({
    claims, certificate: { tierCeiling: 'factual-evidence-pass', requirements: [{ id: 'r1', checkIds: ['c1'], antiCandidateId: 'anti-r1' }], provenance: { source: 's', timing: 't', path: 'p', hash: 'h' }, constructorProvenance: { claimAuthor: 'ca', adversary: 'adv' }, residual: '' },
    antiCandidates, redAnswer: 'unrelated', source, answerAuthor: 'aa',
  });
  assert.equal(r.structural.valid, false);
  assert.ok(r.structural.problems.some((p) => p.includes('residual')));
  assert.equal(r.conjuncts.structureValid, false);
  assert.equal(r.wouldCertify, false);
  assert.equal(r.reauthorable, false, 'a structural cert defect is not fixed by re-authoring claims');
});
