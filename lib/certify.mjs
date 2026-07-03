// certify — the load-bearing CERTIFICATION wrapper for a CONSTRUCTED verifier.
//
// Decides whether a verifier that was BUILT for a task (not the repo's own pre-existing
// suite) has earned a high-confidence tier, or must be demoted to 'advisory-slate'. The
// whole point is honesty: a single hole here is a false-green path, so the tier is NEVER
// taken from any adapter/author self-claim — it is RE-DERIVED here from three mechanical
// facts the verifier cannot fake:
//
//   1. RED BASELINE discriminates — a known-bad candidate (redCandidateDir) must FAIL the
//      gate, and fail it for the RIGHT reason: gate==='pruned' with a STABLE complete TAP map
//      in which at least one EXPECTED red check actually FAILS. A gate that returns
//      'incomplete' (hung / flaky / malformed-TAP / setup-broken) or 'pruned' only because the
//      candidate tripped the immutability / path-escape guard is NOT a discriminating baseline —
//      it tells us nothing about whether the verifier can catch a bad answer.
//   2. EVERY requirement is KILLED — each requirement names checkIds + a prepared
//      anti-candidate that violates exactly that requirement. The verifier must catch it with
//      the SAME positive evidence: gate==='pruned', a stable complete map, and ≥1 of THIS
//      requirement's checkIds actually FAILING in that map (and the failing-check set must
//      intersect ONLY this requirement's checkIds — no shared check certifying two requirements).
//   3. The CERTIFICATE is structurally valid — requirements/anti-candidates/provenance/
//      residual all present, requirement ids globally unique, antiCandidateIds unique, and
//      each requirement's checkIds disjoint from every other requirement's (validateCertificate).
//
// tier = certificate.tierCeiling iff (valid && redBaselineRed && every requirement killed);
// otherwise 'advisory-slate'. certified = tier !== 'advisory-slate'.
//
// Hardening invariants (each closes a false-GREEN path):
//   - Certification gates DEFAULT to attempts>=3 so gate-runner's flake quarantine is active —
//     a flaky verifier cannot fail once per anti-candidate and earn all the kills. A kill /
//     red-baseline counts ONLY from a STABLE `complete` map (gate-runner never populates perTest
//     on a flaky/hung/incomplete run, so this falls out of the positive-evidence predicate).
//   - The constructed verifier's own files (oracleFiles) are ALWAYS protected, unioned with any
//     caller protectedPaths — an anti/red candidate must not modify the verifier to print
//     `not ok` and manufacture its own kill. A candidate that touches a protected/oracle path is
//     rejected by the gate (immutability-violation) and therefore NOT discriminating / NOT killed.
//   - An anti-candidate is matched to its requirement by BOTH anti.id===R.antiCandidateId AND
//     anti.requirementId===R.id, so a mis-wired or duplicated anti-candidate cannot silently
//     stand in for the wrong requirement.
//   - Deletions / renames / copies the gate cannot faithfully apply DEMOTE: such a candidate is
//     treated as NON-discriminating (red) / NOT-killed (anti). Fail SAFE.
//
// Tiers (from the dossier confidence contract): 'repo-verified' › 'constructed-floor-pass'
// › 'factual-evidence-pass'. tierCeiling is the BEST a valid+fully-killing certificate may
// claim; this wrapper can only ever demote, never promote.
//
// All checks are deterministic OS processes via gateRunner — no LLM/agent calls at runtime.

import { gateRunner } from './gate-runner.mjs';
import { candidateFiles } from './gate.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TIER_CEILINGS = new Set(['repo-verified', 'constructed-floor-pass', 'factual-evidence-pass']);

// Certification REQUIRES the flake quarantine to be live (>=3 runs/step): a flaky verifier must
// not be able to fail once per anti-candidate and earn all kills. Tests may override DOWN only to
// keep their wall-clock sane; production never overrides.
const DEFAULT_ATTEMPTS = 3;

/**
 * Validate a certificate's STRUCTURE (not its kills — that needs the gate).
 *
 * Valid iff:
 *   - requirements is a non-empty array, and EACH requirement has >=1 checkId AND a
 *     non-empty antiCandidateId;
 *   - requirement ids are globally unique AND antiCandidateIds are globally unique;
 *   - no checkId is shared across two different requirements (a failing check must certify
 *     at most one requirement — otherwise one caught anti-candidate vacuously "kills" several);
 *   - tierCeiling is one of the three known tiers;
 *   - provenance has non-empty source/timing/path/hash;
 *   - constructorProvenance attests DECORRELATION: non-empty string claimAuthor + adversary that
 *     are DISTINCT — the verifier's claims and the anti-candidates that prove them must NOT come
 *     from the same generative step (a single source authoring both can certify its own wrong
 *     answer with a trivial claim + matching trivial anti). The module enforces the STRUCTURE; it
 *     cannot verify the actual models — honest wiring of genuinely decorrelated agents is the
 *     caller's job (certifyVerifier additionally cross-checks the answerAuthor distinctness);
 *   - residual is a non-empty string.
 *
 * @param {object} certificate
 * @returns {{ valid: boolean, problems: string[] }}
 */
export function validateCertificate(certificate) {
  const problems = [];
  const c = certificate || {};

  if (!TIER_CEILINGS.has(c.tierCeiling)) {
    problems.push(`tierCeiling must be one of {${[...TIER_CEILINGS].join(', ')}}, got: ${JSON.stringify(c.tierCeiling)}`);
  }

  const reqs = c.requirements;
  if (!Array.isArray(reqs) || reqs.length === 0) {
    problems.push('requirements must be a non-empty array');
  } else {
    const seenReqId = new Map();      // id -> count
    const seenAntiId = new Map();     // antiCandidateId -> count
    const checkOwner = new Map();     // checkId -> first requirement id that claimed it
    reqs.forEach((r, i) => {
      const id = r && r.id != null ? r.id : `#${i}`;
      if (!r || typeof r !== 'object') { problems.push(`requirement ${id}: not an object`); return; }
      if (r.id == null || (typeof r.id === 'string' && r.id.trim() === '')) {
        problems.push(`requirement ${id}: must have a non-empty id`);
      } else {
        seenReqId.set(r.id, (seenReqId.get(r.id) || 0) + 1);
      }
      if (!Array.isArray(r.checkIds) || r.checkIds.length === 0) {
        problems.push(`requirement ${id}: must have >=1 checkId`);
      } else {
        // No checkId may be shared with another requirement, and none may repeat within one.
        const localSeen = new Set();
        for (const cid of r.checkIds) {
          if (localSeen.has(cid)) {
            problems.push(`requirement ${id}: checkId ${JSON.stringify(cid)} is duplicated within the requirement`);
            continue;
          }
          localSeen.add(cid);
          if (checkOwner.has(cid) && checkOwner.get(cid) !== r.id) {
            problems.push(`requirement ${id}: checkId ${JSON.stringify(cid)} is also claimed by requirement ${checkOwner.get(cid)} — checkIds must be unique to one requirement`);
          } else if (!checkOwner.has(cid)) {
            checkOwner.set(cid, r.id);
          }
        }
      }
      if (typeof r.antiCandidateId !== 'string' || r.antiCandidateId.trim() === '') {
        problems.push(`requirement ${id}: must have a non-empty antiCandidateId`);
      } else {
        seenAntiId.set(r.antiCandidateId, (seenAntiId.get(r.antiCandidateId) || 0) + 1);
      }
    });
    for (const [id, n] of seenReqId) {
      if (n > 1) problems.push(`requirement id ${JSON.stringify(id)} is not unique (appears ${n}×) — requirement ids must be globally unique`);
    }
    for (const [aid, n] of seenAntiId) {
      if (n > 1) problems.push(`antiCandidateId ${JSON.stringify(aid)} is not unique (appears ${n}×) — antiCandidateIds must be globally unique`);
    }
  }

  const p = c.provenance || {};
  for (const field of ['source', 'timing', 'path', 'hash']) {
    if (typeof p[field] !== 'string' || p[field].trim() === '') {
      problems.push(`provenance.${field} must be a non-empty string`);
    }
  }

  // DECORRELATION ATTESTATION — the claim author and the adversary that proves the claims must be
  // distinct generative steps (see the circularity finding). Enforce that both tags are present,
  // non-empty, and DIFFERENT. (answerAuthor distinctness is enforced in certifyVerifier, which is
  // the layer that actually receives the answer author identity.)
  const cp = c.constructorProvenance;
  if (!cp || typeof cp !== 'object') {
    problems.push('constructorProvenance must be present (an object with distinct claimAuthor + adversary)');
  } else {
    for (const field of ['claimAuthor', 'adversary']) {
      if (typeof cp[field] !== 'string' || cp[field].trim() === '') {
        problems.push(`constructorProvenance.${field} must be a non-empty string`);
      }
    }
    if (typeof cp.claimAuthor === 'string' && typeof cp.adversary === 'string'
      && cp.claimAuthor.trim() !== '' && cp.claimAuthor.trim() === cp.adversary.trim()) {
      problems.push(`constructorProvenance.claimAuthor and .adversary must be DISTINCT (both ${JSON.stringify(cp.claimAuthor)}) — claims and the anti-candidates that prove them cannot be authored by the same step`);
    }
  }

  if (typeof c.residual !== 'string' || c.residual.trim() === '') {
    problems.push('residual must be a non-empty string');
  }

  return { valid: problems.length === 0, problems };
}

// Gate a prepared candidate worktree (its diff vs base IS the candidate) and return the raw
// GateResult plus the faithfulness signal. We reuse gate.mjs's hardened `candidateFiles` so
// deletions/renames/copies it cannot faithfully replay are surfaced (NOT silently dropped), then
// hand the materialized files to gateRunner directly — keeping the per-check (perTest) map. We do
// NOT re-implement gating.
//
// `protectedPaths` here is the FULL protected set (caller paths UNIONED with every oracle file):
// the constructed verifier must be immutable to candidates, so a candidate that edits the verifier
// to fake `not ok` is rejected by the gate rather than minting its own kill.
async function gateDir({ repo, base, candidateDir, verify, oracleFiles, protectedPaths, provision, runSubdir, attempts, perStepTimeoutMs, idPrefix }) {
  const { files, unfaithful } = candidateFiles(candidateDir, base);

  // Normalize verify into gateRunner's structured steps. Accept either ready-made step
  // objects ({name,cmd:[...],type}) or argv-string commands (split on whitespace, like the
  // gate.mjs CLI). All are type:'test' so the per-check (perTest) TAP map is populated.
  const steps = (verify || []).map((cmd, i) =>
    (cmd && typeof cmd === 'object' && Array.isArray(cmd.cmd))
      ? cmd
      : { name: i === 0 ? 'verify' : `verify-${i}`, cmd: String(cmd).split(/\s+/).filter(Boolean), type: 'test' });

  const res = await gateRunner({
    repoDir: repo,
    baseRef: base,
    candidate: { id: `${idPrefix}-${path.basename(candidateDir)}`, files },
    verify: steps,
    protectedPaths: protectedPaths || [],
    oracleFiles: oracleFiles || {},
    provision: provision || undefined,
    runSubdir: runSubdir || '',
    attempts: typeof attempts === 'number' && attempts > 0 ? attempts : DEFAULT_ATTEMPTS,
    ...(typeof perStepTimeoutMs === 'number' && perStepTimeoutMs > 0 ? { perStepTimeoutMs } : {}),
    worktreeRoot: mkdtempSync(path.join(tmpdir(), 'gc-certify-wt-')),
    evidenceDir: mkdtempSync(path.join(tmpdir(), 'gc-certify-ev-')),
  });
  return { res, unfaithful };
}

// The SHARED gate-honesty predicate for BOTH red baseline and per-requirement kills.
//
// Establishes ONLY that the gate produced honest, stable failure evidence — and returns the FULL
// set of failed check ids so the CALLER can reason about BOTH on-target failures (does an expected
// check fail?) AND bleed (does a check belonging to ANOTHER requirement also fail?). The earlier
// design pre-filtered the failed set to `expectedCheckIds` here, which made the caller's bleed
// check structurally blind — it could never see a failure outside the expected set. So this no
// longer takes expectedCheckIds; it reports `allFailed` and the gate-honesty `ok`:
//   - the candidate was faithfully applied (no deletion/rename/copy the gate couldn't replay);
//   - gate === 'pruned' (a real FAIL, not 'green' and not 'incomplete'/hung/flaky);
//   - the failStep is NOT an immutability-violation / path-escape — a candidate that tripped the
//     guard tells us nothing about the verifier's discrimination, and (for the verifier files)
//     would otherwise let a candidate that EDITED the oracle manufacture its own kill;
//   - perTest is a STABLE complete map (gate-runner only populates it on a `complete` run).
//
// Returns { ok, allFailed:Set<checkId>, reason }. `ok` is gate-honesty ONLY (it does NOT assert any
// particular check failed) — the caller combines it with allFailed to decide discrimination/kill.
function positiveEvidence({ res, unfaithful }) {
  if (Array.isArray(unfaithful) && unfaithful.length) {
    return { ok: false, allFailed: new Set(), reason: `candidate not faithfully applicable (${unfaithful.join(', ')})` };
  }
  if (res.gate !== 'pruned') {
    return { ok: false, allFailed: new Set(), reason: `gate=${res.gate} (need pruned; incomplete/green are non-discriminating)` };
  }
  if (res.failStep === 'immutability-violation' || res.failStep === 'path-escape') {
    return { ok: false, allFailed: new Set(), reason: `pruned by guard (${res.failStep}) — touched a protected/oracle path, not a real check failure` };
  }
  const perCheck = res.perTest;
  if (!perCheck || typeof perCheck !== 'object') {
    return { ok: false, allFailed: new Set(), reason: 'no stable per-check map (pruned before a complete test step)' };
  }
  const allFailed = new Set(Object.keys(perCheck).filter((cid) => perCheck[cid] === 'fail'));
  return { ok: true, allFailed, reason: '' };
}

/**
 * Certify a CONSTRUCTED verifier — assign its tier HONESTLY from certificate + kills,
 * never from an adapter self-claim.
 *
 * @param {object} opts
 * @param {string}   opts.repo             base git repo
 * @param {string}   opts.base             base ref the candidates branch from
 * @param {string[]} opts.verify           ordered verify commands (argv arrays) — the CONSTRUCTED verifier
 * @param {Record<string,string>} [opts.oracleFiles]  harness-materialized verifier files (ALWAYS protected)
 * @param {string[]} [opts.protectedPaths] extra protected paths (unioned with oracleFiles' keys)
 * @param {string[]} [opts.provision]
 * @param {string}   [opts.runSubdir]
 * @param {number}   [opts.attempts]       runs per step; DEFAULTS to >=3 (flake quarantine). Override
 *                                         DOWN only in tests to keep wall-clock sane.
 * @param {object}   opts.certificate      see validateCertificate
 * @param {string}   opts.redCandidateDir  a KNOWN-BAD candidate worktree — must FAIL the gate on an
 *                                         EXPECTED red check
 * @param {string[]} [opts.expectedRedCheckIds]  the checks the red candidate must fail to count as
 *                                         discriminating. If omitted, defaults to the union of every
 *                                         requirement's checkIds (≥1 must fail).
 * @param {{id:string, requirementId:string, dir:string}[]} opts.antiCandidates
 *                                         prepared worktrees, each violating ONE requirement
 * @param {string}   [opts.answerAuthor]   provenance tag for whoever authored the CANDIDATE ANSWERS
 *                                         being gated. DECORRELATION: this must be present and
 *                                         pairwise-DISTINCT from the certificate's
 *                                         constructorProvenance.claimAuthor and .adversary, else the
 *                                         run is demoted to advisory-slate — the answer author, the
 *                                         claim author, and the adversary must be three different
 *                                         generative steps. The module enforces the STRUCTURE, not
 *                                         the actual models; honest wiring is the caller's job.
 * @returns {Promise<object>} report = { certified, tier, requirements:[{id,killed}],
 *                                       redBaseline:{red}, problems, residual }
 */
export async function certifyVerifier(opts) {
  const {
    repo, base, verify, oracleFiles, protectedPaths, provision, runSubdir, attempts, perStepTimeoutMs,
    certificate, redCandidateDir, expectedRedCheckIds, antiCandidates = [], answerAuthor,
  } = opts;

  const problems = [];

  // (a) Structural validity of the certificate (includes constructorProvenance: claimAuthor +
  // adversary present and DISTINCT).
  const v = validateCertificate(certificate);
  if (!v.valid) problems.push(...v.problems);

  // (a2) THREE-WAY DECORRELATION: claimAuthor, adversary, and answerAuthor must all be present and
  // PAIRWISE DISTINCT non-empty strings. A single source doing two of these roles ⇒ equal
  // provenance ⇒ the circularity the AR flagged (one step authors the claims AND proves/answers
  // them). validateCertificate already covered claimAuthor≠adversary; here we fold in answerAuthor.
  const cp = (certificate && certificate.constructorProvenance) || {};
  const provTags = {
    claimAuthor: cp.claimAuthor,
    adversary: cp.adversary,
    answerAuthor,
  };
  let decorrelated = true;
  for (const [role, tag] of Object.entries(provTags)) {
    if (typeof tag !== 'string' || tag.trim() === '') {
      problems.push(`decorrelation: ${role} must be a non-empty provenance string`);
      decorrelated = false;
    }
  }
  if (decorrelated) {
    const pairs = [['claimAuthor', 'adversary'], ['claimAuthor', 'answerAuthor'], ['adversary', 'answerAuthor']];
    for (const [x, y] of pairs) {
      if (provTags[x].trim() === provTags[y].trim()) {
        problems.push(`decorrelation: ${x} and ${y} must be DISTINCT (both ${JSON.stringify(provTags[x])}) — claims, the adversary that proves them, and the answer author must be three different steps`);
        decorrelated = false;
      }
    }
  }

  // ALWAYS protect the constructed verifier's own files (oracleFiles), unioned with any caller
  // protectedPaths — mirrors gate.mjs's DEFAULT_PROTECTED intent for the oracle. A red/anti
  // candidate that edits the verifier to print `not ok` is then rejected by the gate's
  // immutability guard rather than minting its own kill.
  const fullProtected = Array.from(new Set([
    ...Object.keys(oracleFiles || {}),
    ...(Array.isArray(protectedPaths) ? protectedPaths : []),
  ]));

  const gateOpts = { repo, base, verify, oracleFiles, protectedPaths: fullProtected, provision, runSubdir, attempts, perStepTimeoutMs };

  const reqs = Array.isArray(certificate && certificate.requirements) ? certificate.requirements : [];

  // The checks the red baseline must fail to be discriminating: explicit opt, else the union of
  // every requirement's checkIds.
  const redExpected = Array.isArray(expectedRedCheckIds) && expectedRedCheckIds.length
    ? expectedRedCheckIds
    : reqs.flatMap((r) => (Array.isArray(r.checkIds) ? r.checkIds : []));

  // (b) RED BASELINE: a known-bad candidate must FAIL the gate for the RIGHT reason — gate-honest
  // (pruned + stable complete map) AND ≥1 EXPECTED red check actually failing in the FULL failed
  // set. We read the full failed set from positiveEvidence and intersect it with redExpected HERE.
  const redExpectedSet = new Set(redExpected);
  let redBaselineRed = false;
  if (typeof redCandidateDir === 'string' && redCandidateDir) {
    const ev = positiveEvidence(await gateDir({ ...gateOpts, candidateDir: redCandidateDir, idPrefix: 'red' }));
    const failedRedExpected = [...ev.allFailed].filter((cid) => redExpectedSet.has(cid));
    redBaselineRed = ev.ok && failedRedExpected.length >= 1;
    if (!redBaselineRed) {
      problems.push(`red baseline non-discriminating: ${ev.ok ? 'no EXPECTED red check actually failed in the stable map' : ev.reason}`);
    }
  } else {
    problems.push('no redCandidateDir provided — cannot establish a discriminating baseline');
  }

  // (c) Per requirement: gate its matched anti-candidate. Matched by BOTH the certificate's
  // antiCandidateId AND the requirement id, so a mis-wired anti-candidate cannot stand in for the
  // wrong requirement. KILLED iff the gate is honest (ev.ok), ≥1 of THIS requirement's checkIds
  // actually FAILS, AND the candidate's failing set intersects NO OTHER requirement's checkIds —
  // an anti-candidate that ALSO breaks another requirement's check is rejected (bleed), so one
  // anti-candidate cannot quietly certify two requirements. The bleed check now reads the FULL
  // failed set (positiveEvidence no longer pre-filters to this requirement's checks), so a
  // cross-requirement failure is actually visible here.
  const requirements = [];
  for (const R of reqs) {
    const checkIds = Array.isArray(R.checkIds) ? R.checkIds : [];
    const ownCheckSet = new Set(checkIds);
    const anti = antiCandidates.find((a) => a && a.id === R.antiCandidateId && a.requirementId === R.id);
    let killed = false;
    if (!anti) {
      problems.push(`requirement ${R.id}: no anti-candidate with id===antiCandidateId (${JSON.stringify(R.antiCandidateId)}) AND requirementId===${JSON.stringify(R.id)}`);
    } else if (typeof anti.dir === 'string' && anti.dir) {
      const gated = await gateDir({ ...gateOpts, candidateDir: anti.dir, idPrefix: 'anti' });
      const ev = positiveEvidence(gated);
      const failedOwn = [...ev.allFailed].filter((cid) => ownCheckSet.has(cid));
      // Bleed = the anti-candidate fails ANY check belonging to a DIFFERENT requirement. Read from
      // the FULL failed set so a cross-requirement failure is visible (the old pre-filtered set hid
      // it). validateCertificate already forbids shared checkIds, so any failure outside this
      // requirement's own set belongs to another requirement (or to no requirement — also rejected
      // as off-target, since a clean kill must break ONLY this requirement's checks).
      const otherOwned = new Set(reqs.filter((q) => q !== R).flatMap((q) => (Array.isArray(q.checkIds) ? q.checkIds : [])));
      const bleeds = [...ev.allFailed].some((cid) => otherOwned.has(cid));
      killed = ev.ok && failedOwn.length >= 1 && !bleeds;
      if (!killed) {
        const reason = !ev.ok ? ev.reason
          : bleeds ? 'failing check also belongs to another requirement'
            : 'no on-target check failed for this requirement';
        problems.push(`requirement ${R.id}: NOT killed (${reason})`);
      }
    } else {
      problems.push(`requirement ${R.id}: anti-candidate has no usable dir`);
    }
    requirements.push({ id: R.id, killed });
  }

  // (d) HONEST TIER ASSIGNMENT — derived HERE, never from any self-claim. Decorrelation (a/a2) is a
  // hard precondition: a verifier whose claims and proofs share a generative step has not earned a
  // factual tier no matter how clean its kills look.
  const allKilled = requirements.length > 0 && requirements.every((r) => r.killed);
  const earnsCeiling = v.valid && decorrelated && redBaselineRed && allKilled;
  const tier = earnsCeiling ? certificate.tierCeiling : 'advisory-slate';
  const certified = tier !== 'advisory-slate';

  return {
    certified,
    tier,
    requirements,
    redBaseline: { red: redBaselineRed },
    problems,
    residual: (certificate && typeof certificate.residual === 'string') ? certificate.residual : null,
  };
}
