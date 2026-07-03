// bleed-lint — forecast `certify`'s verdict IN-PROCESS, before paying for the out-of-band gate.
//
// The dogfood (2026-06-28) showed the fragile link in Path B: a one-shot claim-author often produces
// a verifier that CANNOT cleanly certify — a check that is too generic / brittle "bleeds", failing an
// anti-candidate that targets a DIFFERENT requirement, so certify's clean-kill rule (certify.mjs:378)
// rejects the kill and the whole run honestly degrades to `advisory-only`. The honesty floor handles
// this correctly, but the practical result is a decline that a SHARPER verifier would have avoided.
//
// `bleedLint` predicts the four CLAIM-LEVEL conjuncts of `certify` from RAW STRINGS — no git, no child
// process, no browser — by reusing the EXACT emitted predicate (`evaluateClaim`/`evaluateClaims` from
// prose-verifier.mjs, the single source of truth the oracle runs). It then emits MECHANICAL re-author
// feedback so the SKILL can re-spawn the BLIND claim-author once, before the expensive certify.
//
// HONESTY INVARIANTS (this module can never launder trust):
//   - ADVISORY ONLY. `wouldCertify` is a PREDICTION, never a certificate; the report carries NO
//     `certified` key and never admits a candidate. `blocking` is always false. The real
//     `certifyVerifier` stays authoritative and (by default) always runs afterward — a predicted pass
//     that certify later contradicts defers to certify; a lint RED never blocks, it just feeds back.
//   - NEVER UPGRADES. It can predict "this WILL be advisory-slate" (provable failure) but never "this
//     IS certified". `predictedTier` is CAPPED at the certificate's tierCeiling (demote-only).
//   - FAIL-SAFE. The gate-INFRASTRUCTURE conjuncts certify also checks (flaky-retry / immutability /
//     path-escape / completeness) are UNMODELLED here and EXCLUDED from `conjuncts`; they can never
//     flip `wouldCertify` true on their behalf. Any uncertainty ⇒ wouldCertify false.
//   - SINGLE SOURCE OF TRUTH. It calls the SAME `evaluateClaim` that `emitProseVerifier` serializes
//     into the oracle (guarded by the agreement regression test) — no divergent re-implementation.
//   - PRESERVES THE BLEED / CLEAN-KILL RULE EXACTLY (certify.mjs:378): killed iff the anti fails ≥1 of
//     its OWN requirement's checks and NONE of any other requirement's. Ownership comes from
//     certificate.requirements[].checkIds; the anti is matched by BOTH id===antiCandidateId AND
//     requirementId===R.id (certify.mjs:363).
//   - THREE-WAY DECORRELATION is a hard precondition (certify.mjs:289-314) — and is NOT claim-author
//     fixable (author identity is a harness fact), so a decorrelation collapse never produces re-author
//     feedback and never makes the run "reauthorable".

import { validateClaims, evaluateClaim, evaluateClaims } from './prose-verifier.mjs';
import { validateCertificate } from './certify.mjs';

/**
 * Predict whether a constructed prose verifier will certify, and emit mechanical re-author feedback.
 * PURE — no I/O, no child process. Reuses the exact emitted predicate as single source of truth.
 *
 * @param {object} args
 * @param {object[]} args.claims         the claim-author's claims (each {id, kind, requirementId, ...})
 * @param {object}   args.certificate    built.certificate ({tierCeiling, requirements:[{id,checkIds,antiCandidateId}], constructorProvenance:{claimAuthor,adversary}, residual})
 * @param {object[]} args.antiCandidates the adversary's anti-candidates ([{id, requirementId, answer}])
 * @param {string}   args.redAnswer      the adversary's baseline-wrong answer
 * @param {string}   args.source         the decorrelated ground truth
 * @param {string}   args.answerAuthor   provenance of the oracle-blind answer authors (third role)
 * @param {string[]} [args.expectedRedCheckIds]  optional; default = union of every requirement's checkIds
 * @returns {LintReport}
 */
export function bleedLint({ claims, certificate, antiCandidates, redAnswer, source, answerAuthor, expectedRedCheckIds }) {
  const claimList = Array.isArray(claims) ? claims : [];
  const antiList = Array.isArray(antiCandidates) ? antiCandidates : [];
  const src = typeof source === 'string' ? source : '';

  // The authoritative ownership map (checkId → requirementId) from the certificate. Built up-front so
  // the structural check can also verify EVERY emitted claim is OWNED by a requirement.
  const reqs = Array.isArray(certificate && certificate.requirements) ? certificate.requirements : [];
  const checkOwner = new Map();
  for (const R of reqs) for (const cid of (Array.isArray(R.checkIds) ? R.checkIds : [])) checkOwner.set(cid, R.id);

  // (1) STRUCTURAL — mirror the FULL construct→certify ACCEPT condition (not `certify` alone):
  // `construct` runs validateClaims (incl. id-safety + source-anchoring) and THROWS if invalid, then
  // `certify` runs validateCertificate. Plus an OWNERSHIP guard: every emitted claim id must be in some
  // requirement's checkIds — an unowned emitted check that an anti fails is INVISIBLE to certify's bleed
  // test (certify.mjs:376 only scans OTHER requirements' checkIds), so it could mask a non-clean kill.
  // (Including validateClaims here is the SAFE direction: a claim it rejects never reaches certify,
  // because construct throws first — so the lint mirrors the pipeline's accept condition, not a hole.)
  const claimVal = validateClaims(claimList, src);
  const certVal = validateCertificate(certificate);
  const ownershipProblems = [];
  for (const c of claimList) {
    if (c && typeof c.id === 'string' && c.id && !checkOwner.has(c.id)) {
      ownershipProblems.push(`claim ${JSON.stringify(c.id)} is not owned by any requirement (absent from every requirement.checkIds) — an unowned emitted check cannot be cleanly attributed`);
    }
  }
  const structural = {
    valid: claimVal.valid && certVal.valid && ownershipProblems.length === 0,
    problems: [...claimVal.problems, ...certVal.problems, ...ownershipProblems],
  };

  // (2) THREE-WAY DECORRELATION — from certificate.constructorProvenance + answerAuthor (certify.mjs:289-314).
  const cp = (certificate && certificate.constructorProvenance) || {};
  const provTags = { claimAuthor: cp.claimAuthor, adversary: cp.adversary, answerAuthor };
  const decorrelationProblems = [];
  let decorrelated = true;
  for (const [role, tag] of Object.entries(provTags)) {
    if (typeof tag !== 'string' || tag.trim() === '') {
      decorrelationProblems.push(`decorrelation: ${role} must be a non-empty provenance string`);
      decorrelated = false;
    }
  }
  if (decorrelated) {
    for (const [x, y] of [['claimAuthor', 'adversary'], ['claimAuthor', 'answerAuthor'], ['adversary', 'answerAuthor']]) {
      if (provTags[x].trim() === provTags[y].trim()) {
        decorrelationProblems.push(`decorrelation: ${x} and ${y} must be DISTINCT (both ${JSON.stringify(provTags[x])})`);
        decorrelated = false;
      }
    }
  }
  const decorrelation = { ok: decorrelated, problems: decorrelationProblems };

  // (reqs + checkOwner are built above, before the structural check.)

  // The set of claim ids that FAIL on a given answer (in-process, the same predicate the oracle runs).
  const failedIds = (answer) => evaluateClaims(claimList, typeof answer === 'string' ? answer : '', src)
    .results.filter((r) => !r.ok).map((r) => r.id);

  // (3) RED BASELINE goes-red — a known-bad answer must FAIL ≥1 EXPECTED red check (certify.mjs:329-346).
  const redExpected = Array.isArray(expectedRedCheckIds) && expectedRedCheckIds.length
    ? expectedRedCheckIds
    : reqs.flatMap((r) => (Array.isArray(r.checkIds) ? r.checkIds : []));
  const redExpectedSet = new Set(redExpected);
  const hasRed = typeof redAnswer === 'string';
  const redFailedExpected = hasRed ? failedIds(redAnswer).filter((cid) => redExpectedSet.has(cid)) : [];
  const redBaseline = {
    goesRed: redFailedExpected.length >= 1,
    failedExpected: redFailedExpected,
    ...(redFailedExpected.length >= 1 ? {} : { reason: hasRed ? 'no EXPECTED red check actually failed' : 'no redAnswer provided' }),
  };

  // (4) PER-REQUIREMENT CLEAN KILL — the bleed rule (certify.mjs:359-389).
  const requirements = reqs.map((R) => {
    const ownCheckSet = new Set(Array.isArray(R.checkIds) ? R.checkIds : []);
    const anti = antiList.find((a) => a && a.id === R.antiCandidateId && a.requirementId === R.id);
    if (!anti) {
      return { id: R.id, antiCandidateId: R.antiCandidateId, antiFound: false, onTargetFailures: [], bleedFailures: [], killed: false, reason: 'no anti-candidate' };
    }
    const allFailed = failedIds(anti.answer);
    const onTargetFailures = allFailed.filter((cid) => ownCheckSet.has(cid));
    const bleedFailures = allFailed
      .filter((cid) => !ownCheckSet.has(cid) && checkOwner.has(cid))
      .map((cid) => ({ checkId: cid, foreignRequirementId: checkOwner.get(cid) }));
    const killed = onTargetFailures.length >= 1 && bleedFailures.length === 0;
    const out = { id: R.id, antiCandidateId: R.antiCandidateId, antiFound: true, onTargetFailures, bleedFailures, killed };
    if (!killed) out.reason = bleedFailures.length ? 'bleed' : 'no on-target check failed';
    return out;
  });
  const allKilled = requirements.length > 0 && requirements.every((r) => r.killed);

  // (5) BRITTLE — ADVISORY ONLY (never a wouldCertify input): a PRESENCE check the SOURCE itself
  // fails. The source is the ground truth, so a must-include / near / grounded / number-matches it
  // cannot pass will reject genuinely-correct answers too. EXCLUSION checks (must-exclude / not-near)
  // are deliberately skipped: the source legitimately MENTIONS the wrong framing (often to define or
  // negate it — e.g. "is NOT a gas giant"), so source-contains is normal there, not brittle.
  const EXCLUSION_KINDS = new Set(['must-exclude', 'not-near']);
  const brittle = [];
  for (const c of claimList) {
    if (!c || EXCLUSION_KINDS.has(c.kind)) continue;
    const r = evaluateClaim(c, src, src);
    if (!r.ok) brittle.push({ checkId: c.id || null, requirementId: c.requirementId || null, reason: r.reason });
  }

  // The four claim-level conjuncts of certify's earnsCeiling (certify.mjs:395) — gate-infra excluded.
  const conjuncts = {
    structureValid: structural.valid,
    decorrelated: decorrelation.ok,
    redBaselineGoesRed: redBaseline.goesRed,
    allAntiCleanKilled: allKilled,
  };
  const wouldCertify = conjuncts.structureValid && conjuncts.decorrelated && conjuncts.redBaselineGoesRed && conjuncts.allAntiCleanKilled;

  const tierCeiling = (certificate && certificate.tierCeiling) || 'advisory-slate';
  const predictedTier = wouldCertify ? tierCeiling : 'advisory-slate';
  const confidence = wouldCertify ? 'predicted-pass' : 'predicted-fail';

  // MECHANICAL re-author feedback — names checkIds / requirements only, NEVER the anti-candidate prose
  // (the claim-author stays blind to the adversary). Decorrelation / missing-anti / structural issues
  // are NOT claim-author fixable, so they do NOT appear here.
  const reauthorFeedback = [];
  let hasBleed = false;
  let hasAntiNonDiscrim = false;
  for (const R of requirements) {
    for (const b of R.bleedFailures) {
      hasBleed = true;
      reauthorFeedback.push(`BLEED: check ${JSON.stringify(b.checkId)} (owned by requirement ${JSON.stringify(b.foreignRequirementId)}) is tripped by the near-miss for requirement ${JSON.stringify(R.id)} — that check is too generic; narrow it so it isolates ${JSON.stringify(b.foreignRequirementId)} only, or swap to a not-near / must-exclude of the wrong-framing vocabulary.`);
    }
    if (R.antiFound && R.onTargetFailures.length === 0 && R.bleedFailures.length === 0) {
      hasAntiNonDiscrim = true;
      reauthorFeedback.push(`NON-DISCRIMINATION: requirement ${JSON.stringify(R.id)} has no check that its own near-miss fails — add/tighten a discriminating check so the anti-candidate for ${JSON.stringify(R.id)} fails at least one of this requirement's own checks.`);
    }
  }
  for (const b of brittle) {
    reauthorFeedback.push(`BRITTLE: check ${JSON.stringify(b.checkId)} fails even on the SOURCE (${b.reason}) — it will reject correct answers; loosen it (anchor on a token any correct answer must use, or use grounded/number-matches on a verbatim source string).`);
  }
  const redNonDiscrim = hasRed && !redBaseline.goesRed;
  if (redNonDiscrim) {
    reauthorFeedback.push('NON-DISCRIMINATION: the red baseline trips zero expected checks — tighten an under-specified check so at least one fails on the red answer.');
  }

  // `reauthorable` gates the opt-in short-circuit: re-spawn the claim-author ONLY when ALL the HARD
  // preconditions are clean (structural validity, three-way decorrelation, every anti-candidate
  // present) AND the only remaining failure is claim-author-fixable (a bleeding / non-discriminating
  // check, or a non-discriminating red baseline). If a non-fixable hard failure CO-EXISTS — a
  // decorrelation collapse, a structural/cert defect, a missing anti — re-authoring the CLAIMS can't
  // fix it, so we must NOT short-circuit: let the real certify run and surface it honestly (AR HIGH1).
  const hardPreconditionsClean = structural.valid && decorrelation.ok && requirements.every((r) => r.antiFound);
  const reauthorable = !wouldCertify && hardPreconditionsClean && (hasBleed || hasAntiNonDiscrim || redNonDiscrim);

  return {
    wouldCertify,
    predictedTier,
    confidence,
    conjuncts,
    structural,
    decorrelation,
    redBaseline,
    requirements,
    allKilled,
    brittle,
    reauthorFeedback,
    reauthorable,
    blocking: false,
  };
}
