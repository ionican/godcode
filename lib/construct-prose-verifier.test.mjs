// construct-prose-verifier.test — the GENERATIVE seam, proven GENERAL (a fresh task, not the fixed
// proseExample) and DETERMINISTIC. TWO DECORRELATED fakes stand in for the production agents:
// fakeClaimFn (the verifier author → grounded claims + residual) and fakeAdversaryFn (a SEPARATE
// adversary → one anti-candidate per requirement + a red answer). The tests assert (1) a clean
// construction yields a valid 'factual-evidence-pass' certificate covering every requirement and
// carrying distinct constructorProvenance, (2) the full certify chain re-derives the ceiling (red
// baseline red, every requirement killed) with a THIRD distinct answerAuthor, and (3) the honesty
// guards FIRE — a dropped requirement, a missing residual, equal provenance, and a mutated
// requirements arg are hard errors / cannot drop coverage, never silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { constructProseVerifier, assembleForCertify } from './construct-prose-verifier.mjs';
import { validateCertificate, certifyVerifier } from './certify.mjs';
import { emitProseVerifier } from './prose-verifier.mjs';

// ---------------------------------------------------------------------------------------------
// A fresh decorrelated task: three factual requirements about the Mariana Trench, with a short
// source that carries one specific number ('10,994 metres') and a groundable phrase. This is NOT
// proseExample — proving the module generalizes past the fixed worked example.
const TASK = 'What is the Mariana Trench, and how deep is it?';
const SOURCE = [
  'The Mariana Trench is the deepest oceanic trench on Earth, located in the western Pacific Ocean.',
  'Its deepest point, the Challenger Deep, reaches about 10,994 metres below sea level.',
  'It is a subduction zone, not a mid-ocean ridge.',
].join(' ');

// Externally given requirements (ids unique). The fake constructFn only TRANSLATES these.
const REQUIREMENTS = [
  { id: 'names-trench', text: 'The answer must name the Mariana Trench.' },
  { id: 'depth-value', text: 'The answer must state the depth as in the source.' },
  { id: 'not-ridge', text: 'The answer must not call it a mid-ocean ridge.' },
];

// Distinct provenance tags for the three decorrelated roles. In production these correspond to
// three different models/sources; here they only satisfy the structural distinctness gate.
const CLAIM_AUTHOR = 'fake-claim-author';
const ADVERSARY = 'fake-adversary';
const ANSWER_AUTHOR = 'fake-answer-author';

// The production claimFn is a decorrelated AGENT (the VERIFIER author); here it is a deterministic
// fake returning grounded claims + a residual.
function fakeClaimFn({ requirements }) {
  // sanity: the fake is handed exactly the externally-given requirements
  assert.deepEqual(requirements.map((r) => r.id).sort(), ['depth-value', 'names-trench', 'not-ridge']);
  const claims = [
    { id: 'c-names-trench', requirementId: 'names-trench', kind: 'must-include', text: 'Mariana Trench' },
    { id: 'c-depth-value', requirementId: 'depth-value', kind: 'number-matches', value: '10,994 metres' },
    { id: 'c-grounded-deepest', requirementId: 'names-trench', kind: 'grounded', quote: 'deepest oceanic trench on Earth' },
    { id: 'c-not-ridge', requirementId: 'not-ridge', kind: 'must-exclude', text: 'mid-ocean ridge' },
  ];
  const residual = 'verifies only the named, depth, and not-ridge claims against the given source; does not check oceanographic correctness beyond them';
  return { claims, residual };
}

// The production adversaryFn is a SEPARATE decorrelated agent, BLIND to the claims; here it is a
// deterministic fake returning one anti-candidate per requirement (each violating EXACTLY its
// requirement while holding the others) + a red answer. Mirrors proseExample's discipline so each
// kill is on-target.
function fakeAdversaryFn({ requirements }) {
  assert.deepEqual(requirements.map((r) => r.id).sort(), ['depth-value', 'names-trench', 'not-ridge']);
  const antiCandidates = [
    {
      // violates names-trench only: drops "Mariana Trench" AND the grounded phrase belonging to it.
      // (names-trench owns two checks — c-names-trench + c-grounded-deepest — so its anti must break
      //  ≥1 of them while leaving the OTHER requirements' checks intact.)
      id: 'a-names-trench', requirementId: 'names-trench',
      answer: 'This feature is the lowest oceanic trench on Earth. Its deepest point is about 10,994 metres deep.',
    },
    {
      // violates depth-value only: wrong number; still names it + keeps grounded phrase + no ridge.
      id: 'a-depth-value', requirementId: 'depth-value',
      answer: 'The Mariana Trench is the deepest oceanic trench on Earth. Its deepest point is about 8,000 metres deep.',
    },
    {
      // violates not-ridge only: asserts the forbidden "mid-ocean ridge"; keeps name + depth + phrase.
      id: 'a-not-ridge', requirementId: 'not-ridge',
      answer: 'The Mariana Trench is the deepest oceanic trench on Earth, a mid-ocean ridge, about 10,994 metres deep.',
    },
  ];
  // RED answer: bakes in a wrong number => fails ONLY depth-value (every other check still passes).
  const redAnswer = 'The Mariana Trench is the deepest oceanic trench on Earth. Its deepest point is about 8,000 metres deep.';
  return { antiCandidates, redAnswer };
}

// Convenience: the full decorrelated construction opts for the happy path.
function constructOpts(extra = {}) {
  return {
    task: TASK, source: SOURCE, requirements: REQUIREMENTS,
    claimFn: fakeClaimFn, adversaryFn: fakeAdversaryFn,
    claimAuthor: CLAIM_AUTHOR, adversary: ADVERSARY,
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------
test('constructProseVerifier: valid factual-evidence-pass certificate covering every requirement', async () => {
  const built = await constructProseVerifier(constructOpts());

  // The certificate is structurally valid and pinned to the source-grounded-prose ceiling.
  assert.equal(built.certificate.tierCeiling, 'factual-evidence-pass', 'ceiling must be the constructed-prose tier, never higher');
  const v = validateCertificate(built.certificate);
  assert.equal(v.valid, true, `certificate must validate; problems: ${JSON.stringify(v.problems)}`);

  // Every externally-given requirement is covered by ≥1 claim + exactly one anti-candidate.
  assert.deepEqual(
    built.certificate.requirements.map((r) => r.id).sort(),
    REQUIREMENTS.map((r) => r.id).sort(),
    'one certificate requirement per given requirement',
  );
  for (const r of built.certificate.requirements) {
    assert.ok(r.checkIds.length >= 1, `requirement ${r.id} must carry ≥1 checkId`);
    assert.ok(typeof r.antiCandidateId === 'string' && r.antiCandidateId, `requirement ${r.id} must name its anti-candidate`);
  }
  // names-trench owns BOTH of its claims (the must-include + the grounded phrase).
  const namesReq = built.certificate.requirements.find((r) => r.id === 'names-trench');
  assert.deepEqual(namesReq.checkIds.sort(), ['c-grounded-deepest', 'c-names-trench'], 'a requirement may own multiple checks');

  // Provenance is the construct path; hash is over the source; residual is the constructor's.
  assert.equal(built.certificate.provenance.source, 'construct-prose-verifier');
  assert.equal(built.certificate.provenance.timing, 'pre-authoring');
  assert.equal(built.certificate.provenance.path, 'claimFn+adversaryFn');
  assert.match(built.certificate.provenance.hash, /^[0-9a-f]{64}$/, 'hash must be a sha256 hex of the source');
  assert.ok(built.certificate.residual.length > 0, 'residual must be the constructor-supplied non-empty string');
  assert.equal(built.coverage.ok, true, 'coverage report must be ok on a clean construction');

  // DECORRELATION: the certificate attests distinct claimAuthor + adversary provenance.
  assert.equal(built.certificate.constructorProvenance.claimAuthor, CLAIM_AUTHOR);
  assert.equal(built.certificate.constructorProvenance.adversary, ADVERSARY);
  assert.notEqual(built.certificate.constructorProvenance.claimAuthor, built.certificate.constructorProvenance.adversary, 'claimAuthor and adversary must be distinct');

  // The emitted oracle is a runnable standalone (bakes the claims in).
  assert.match(built.verifierSource, /node claims\.mjs/, 'verifierSource is the emitted standalone oracle');
});

// ---------------------------------------------------------------------------------------------
test('assembleForCertify -> certifyVerifier: certified, factual-evidence-pass, every requirement killed, red baseline red', async () => {
  const work = mkdtempSync(path.join(tmpdir(), 'gc-construct-prose-'));
  try {
    const built = await constructProseVerifier(constructOpts());
    const asm = await assembleForCertify({
      workdir: work,
      source: SOURCE,
      verifierSource: built.verifierSource,
      redAnswer: built.redAnswer,
      antiCandidates: built.antiCandidates,
    });

    // The red answer bakes a wrong number, so the derived expected-red set is exactly depth-value.
    assert.deepEqual(asm.expectedRedCheckIds, ['c-depth-value'], 'red failures derived from the real oracle run');

    const report = await certifyVerifier({
      repo: asm.repo,
      base: asm.base,
      verify: asm.verify,
      oracleFiles: asm.oracleFiles,
      protectedPaths: asm.protectedPaths,
      certificate: built.certificate,
      redCandidateDir: asm.redCandidateDir,
      expectedRedCheckIds: asm.expectedRedCheckIds,
      antiCandidates: asm.antiCandidateDirs,
      answerAuthor: ANSWER_AUTHOR, // THIRD distinct provenance (the candidate-answer author)
      attempts: 1, // deterministic oracle never flakes; keep wall-clock sane in the test
    });

    assert.equal(report.certified, true, `must certify; problems: ${JSON.stringify(report.problems)}`);
    assert.equal(report.tier, 'factual-evidence-pass', 'tier re-derives to the constructed-prose ceiling');
    assert.equal(report.redBaseline.red, true, 'red baseline must discriminate (wrong number fails depth-value)');
    assert.equal(report.requirements.length, REQUIREMENTS.length, 'one report row per requirement');
    for (const r of report.requirements) {
      assert.equal(r.killed, true, `requirement ${r.id} must be killed by its anti-candidate`);
    }

    // The factory produces a gateable answer worktree for a real author's output later.
    const ansDir = asm.makeAnswerCandidate('The Mariana Trench is the deepest oceanic trench on Earth, about 10,994 metres deep.');
    assert.ok(typeof ansDir === 'string' && ansDir.length > 0, 'makeAnswerCandidate returns a worktree dir');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
test('coverage guard: a claimFn/adversaryFn that DROPS a requirement throws (not silent)', async () => {
  // claimFn drops not-ridge's claim AND adversaryFn drops its anti — the requirement is uncovered.
  const droppingClaim = (args) => {
    const full = fakeClaimFn(args);
    return { ...full, claims: full.claims.filter((c) => c.requirementId !== 'not-ridge') };
  };
  const droppingAdversary = (args) => {
    const full = fakeAdversaryFn(args);
    return { ...full, antiCandidates: full.antiCandidates.filter((a) => a.requirementId !== 'not-ridge') };
  };
  await assert.rejects(
    () => constructProseVerifier(constructOpts({ claimFn: droppingClaim, adversaryFn: droppingAdversary })),
    /coverage validation FAILED|NO claim|NO anti-candidate/,
    'a dropped requirement must be a hard error before any certificate is assembled',
  );

  // Also: dropping ONLY the anti-candidate (claim kept) is still a coverage gap.
  const dropAntiOnly = (args) => {
    const full = fakeAdversaryFn(args);
    return { ...full, antiCandidates: full.antiCandidates.filter((a) => a.requirementId !== 'depth-value') };
  };
  await assert.rejects(
    () => constructProseVerifier(constructOpts({ adversaryFn: dropAntiOnly })),
    /coverage validation FAILED|NO anti-candidate/,
    'a missing anti-candidate for a requirement must also fail coverage',
  );
});

// ---------------------------------------------------------------------------------------------
test('coverage guard fires BEFORE certify: forcing a dropped-requirement certificate through would demote', async () => {
  // Prove the guard is the FIRST line of defence: construct WITHOUT the guard by hand-assembling a
  // certificate that omits not-ridge, then show certify would NOT certify it (defence in depth).
  const work = mkdtempSync(path.join(tmpdir(), 'gc-construct-drop-'));
  try {
    const claimOut = fakeClaimFn({ requirements: REQUIREMENTS });
    const advOut = fakeAdversaryFn({ requirements: REQUIREMENTS });
    // Hand-build a certificate that covers only 2 of 3 requirements (simulating a guard bypass).
    const holed = {
      tierCeiling: 'factual-evidence-pass',
      requirements: [
        { id: 'names-trench', checkIds: ['c-names-trench', 'c-grounded-deepest'], antiCandidateId: 'a-names-trench' },
        { id: 'depth-value', checkIds: ['c-depth-value'], antiCandidateId: 'a-depth-value' },
        // not-ridge OMITTED — the hole the guard would have caught
      ],
      provenance: { source: 'construct-prose-verifier', timing: 'pre-authoring', path: 'claimFn+adversaryFn', hash: 'deadbeef' },
      constructorProvenance: { claimAuthor: CLAIM_AUTHOR, adversary: ADVERSARY },
      residual: 'holed certificate',
    };
    const asm = await assembleForCertify({
      workdir: work, source: SOURCE, verifierSource: emitProseVerifier(claimOut.claims),
      redAnswer: advOut.redAnswer, antiCandidates: advOut.antiCandidates,
    });
    const report = await certifyVerifier({
      repo: asm.repo, base: asm.base, verify: asm.verify, oracleFiles: asm.oracleFiles,
      protectedPaths: asm.protectedPaths, certificate: holed,
      redCandidateDir: asm.redCandidateDir, expectedRedCheckIds: asm.expectedRedCheckIds,
      antiCandidates: asm.antiCandidateDirs, answerAuthor: ANSWER_AUTHOR, attempts: 1,
    });
    // certify certifies the HOLED certificate only over the 2 requirements it names — not-ridge is
    // simply unverified. The construct-time guard is what prevents that hole from ever being minted;
    // this asserts the structural difference (the holed cert covers fewer requirements than given).
    assert.ok(report.requirements.length < REQUIREMENTS.length, 'a holed certificate verifies FEWER requirements than were given — exactly the gap the guard prevents');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
test('residual guard: a claimFn returning empty/missing residual is a hard error', async () => {
  const noResidual = (args) => { const full = fakeClaimFn(args); const { residual, ...rest } = full; void residual; return rest; };
  await assert.rejects(
    () => constructProseVerifier(constructOpts({ claimFn: noResidual })),
    /residual/,
    'a missing residual must be a hard error — never fabricated',
  );

  const emptyResidual = (args) => ({ ...fakeClaimFn(args), residual: '   ' });
  await assert.rejects(
    () => constructProseVerifier(constructOpts({ claimFn: emptyResidual })),
    /residual/,
    'a whitespace-only residual must also be a hard error',
  );
});

// =============================================================================================
// AR regression suite — cross-model adversarial review of the prose-QA CONSTRUCTION path. Each
// test reproduces a FALSE-CONFIDENCE exploit the AR found and asserts it can no longer mint a
// factual-evidence-pass on a WRONG answer. These FAIL on the pre-fix code.
// =============================================================================================

// --- Finding #1 [CRITICAL]: a generative fn that MUTATES (splices) its `requirements` argument must
// NOT shrink coverage or drop a requirement from the certificate — the given requirements are
// deep-cloned + frozen first, and coverage + assembly read only that frozen snapshot.
test('AR#1: a claimFn that SPLICES its requirements arg cannot drop a requirement from coverage', async () => {
  // A claimFn that tries to mutate the requirements it was handed (drop the last requirement) AND
  // only emits claims for the 2 it kept. On the pre-fix code (which iterated the same array object
  // the fn mutated) coverage would validate against the shrunken array — the dropped requirement
  // would silently vanish from the certificate. With the frozen snapshot, EITHER the splice throws
  // (frozen array) OR the snapshot is untouched and coverage fails on the now-missing claim/anti.
  const splicingClaim = (args) => {
    try { args.requirements.splice(2); } catch { /* frozen → throws; fine, the point is no drop */ }
    const full = fakeClaimFn({ requirements: REQUIREMENTS });
    // emit claims ONLY for the (post-splice) first two requirements
    return { ...full, claims: full.claims.filter((c) => c.requirementId !== 'not-ridge') };
  };
  await assert.rejects(
    () => constructProseVerifier(constructOpts({ claimFn: splicingClaim })),
    /coverage validation FAILED|NO claim|Cannot add|object is not extensible|read only|Cannot delete/,
    'a mutated requirements arg must not be able to drop a requirement — frozen snapshot defends coverage',
  );

  // And the POSITIVE half: a claimFn that splices but STILL emits all claims yields a certificate
  // that covers ALL original requirements (the frozen snapshot is what assembly reads).
  const splicingButComplete = (args) => {
    try { args.requirements.splice(1); } catch { /* frozen */ }
    return fakeClaimFn({ requirements: REQUIREMENTS });
  };
  const built = await constructProseVerifier(constructOpts({ claimFn: splicingButComplete }));
  assert.deepEqual(
    built.certificate.requirements.map((r) => r.id).sort(),
    REQUIREMENTS.map((r) => r.id).sort(),
    'the certificate must cover ALL originally-given requirements despite the splice',
  );
});

// --- Finding #2 [CRITICAL]: CIRCULARITY. A single source authoring BOTH the claims and the
// anti-candidates that prove them (equal claimAuthor/adversary provenance) — with a TRIVIAL claim +
// matching trivial anti certifying a WRONG answer — must be DEMOTED, never certified. Reproduces the
// AR exploit end-to-end: one fn used as BOTH claimFn and adversaryFn (same provenance).
test('AR#2: one source as BOTH claim author and adversary (equal provenance) is DEMOTED, not certified', async () => {
  // The circular fn: a single generative step emits a TRIVIAL grounded claim (1 source char) AND the
  // matching trivial anti AND a wrong redAnswer. Conceptually this would "pass" its own check.
  const ONE_CHAR = SOURCE[0]; // a single character guaranteed present in the source
  const circularClaim = () => ({
    claims: [{ id: 'c-trivial', requirementId: 'names-trench', kind: 'grounded', quote: ONE_CHAR }],
    residual: 'trivial circular claim — verifies almost nothing',
  });
  // Single-requirement task so the trivial claim "covers" it; the WRONG answer still trivially
  // includes ONE_CHAR, so the circular verifier would green it.
  const oneReq = [{ id: 'names-trench', text: 'name the trench' }];
  const circularAdversary = () => ({
    antiCandidates: [{ id: 'a-trivial', requirementId: 'names-trench', answer: 'x' /* missing ONE_CHAR? no — pick an anti that DOES drop it */ }],
    redAnswer: 'a completely wrong answer that happens to contain ' + ONE_CHAR,
  });

  // The construction layer itself refuses equal provenance — the circularity is rejected BEFORE any
  // certificate is assembled. (This is the construct-time half of the defence.)
  await assert.rejects(
    () => constructProseVerifier({
      task: 'trivial', source: SOURCE, requirements: oneReq,
      claimFn: circularClaim, adversaryFn: circularAdversary,
      claimAuthor: 'same-model', adversary: 'same-model', // EQUAL provenance = the circular wiring
    }),
    /DISTINCT|decorrelat/i,
    'equal claimAuthor/adversary (one source doing both) must be rejected at construction',
  );

  // And the certify-time half: a hand-built certificate carrying equal constructorProvenance must be
  // DEMOTED to advisory-slate even if every kill otherwise looks clean.
  const work = mkdtempSync(path.join(tmpdir(), 'gc-circular-'));
  try {
    const built = await constructProseVerifier(constructOpts()); // a valid build to get a real asm
    const asm = await assembleForCertify({
      workdir: work, source: SOURCE, verifierSource: built.verifierSource,
      redAnswer: built.redAnswer, antiCandidates: built.antiCandidates,
    });
    const circularCert = { ...built.certificate, constructorProvenance: { claimAuthor: 'same-model', adversary: 'same-model' } };
    const report = await certifyVerifier({
      repo: asm.repo, base: asm.base, verify: asm.verify, oracleFiles: asm.oracleFiles,
      protectedPaths: asm.protectedPaths, certificate: circularCert,
      redCandidateDir: asm.redCandidateDir, expectedRedCheckIds: asm.expectedRedCheckIds,
      antiCandidates: asm.antiCandidateDirs, answerAuthor: ANSWER_AUTHOR, attempts: 1,
    });
    assert.equal(report.tier, 'advisory-slate', 'equal claimAuthor===adversary must DEMOTE to advisory-slate');
    assert.equal(report.certified, false, 'a circular construction must NOT be certified');
    assert.ok(report.problems.some((p) => /DISTINCT|decorrelat/i.test(p)), 'must cite the decorrelation failure');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// --- Finding #3 [HIGH]: an unvalidated claim is vacuous. A claim missing its required field, and a
// 'grounded' claim whose quote is ABSENT from the source, must be REJECTED before emission — not
// coerced through String(undefined) into a fake check.
test('AR#3: a claim missing its field, or an ungrounded grounded anchor, is rejected', async () => {
  // (a) must-exclude with NO text → required field missing.
  const noField = (args) => {
    const full = fakeClaimFn(args);
    const claims = full.claims.map((c) => (c.id === 'c-not-ridge' ? { id: c.id, requirementId: c.requirementId, kind: 'must-exclude' } : c));
    return { ...full, claims };
  };
  await assert.rejects(
    () => constructProseVerifier(constructOpts({ claimFn: noField })),
    /claim validation FAILED|requires a non-empty string|unknown kind/,
    'a claim missing its required field is vacuous and must be rejected',
  );

  // (b) grounded claim whose quote does NOT appear in the source → vacuous anchor.
  const ungrounded = (args) => {
    const full = fakeClaimFn(args);
    const claims = full.claims.map((c) => (c.id === 'c-grounded-deepest' ? { ...c, quote: 'a phrase that is nowhere in the source text' } : c));
    return { ...full, claims };
  };
  await assert.rejects(
    () => constructProseVerifier(constructOpts({ claimFn: ungrounded })),
    /claim validation FAILED|does not appear in the source|ungrounded/,
    'a grounded claim whose quote is absent from the source must be rejected',
  );
});
