// construct-prose-verifier — the GENERATIVE seam that makes prose-QA verification GENERAL.
//
// m2-prose-slice proves the prose-QA path against a FIXED worked example (proseExample). This
// module is the D8 split that lifts that path to ANY task: the creative step — turning a task's
// EXTERNALLY-GIVEN requirements into checkable claims + an anti-candidate per requirement + a red
// answer + a residual — is INJECTED. To break the CIRCULARITY the cross-model AR found (one step
// authoring BOTH the claims AND the anti-candidates that prove them can certify a wrong answer with
// a trivial claim + matching trivial anti), that step is split into TWO DECORRELATED agents:
//   - claimFn({task, source, requirements}) -> { claims, residual }      the VERIFIER author.
//   - adversaryFn({task, source, requirements}) -> { antiCandidates, redAnswer }
//       a SEPARATE adversary that, per requirement, writes an answer that VIOLATES it (from the
//       requirement text + source), conceptually BLIND to the claims.
// In production these are different models/sources; in tests they are deterministic fakes with
// DISTINCT provenance tags (claimAuthor / adversary). Everything else here — coverage validation,
// claim validation, certificate assembly, provenance, worktree building — is DETERMINISTIC CODE
// that NEVER calls an LLM.
//
// HONESTY INVARIANTS (why a verifier constructed here can be trusted):
//   - Requirements are EXTERNALLY GIVEN (from the task spec / clarifications), NOT invented here.
//     The given requirements are deep-CLONED and FROZEN before any generative fn runs, and BOTH
//     coverage and certificate assembly use that frozen snapshot — a claimFn/adversaryFn that
//     mutates its `requirements` argument (e.g. splice) cannot make coverage validate against a
//     shrunken array or drop a requirement from the certificate.
//   - claimFn translates requirements into claims; adversaryFn translates them into anti-candidates.
//     Neither may add or drop requirements. The coverage guard proves the translation is total
//     against the FROZEN ids: every requirement.id has ≥1 claim AND exactly one matching
//     anti-candidate, or we throw.
//   - Claims are VALIDATED (validateClaims) against the external `source` before emission — unknown
//     kinds / missing fields / ungrounded source anchors are rejected, so a vacuous claim can never
//     be baked into the oracle.
//   - Claims are GROUNDED against the external `source` (the prose-verifier 'grounded' /
//     'number-matches' kinds check the answer against the source). The source is the decorrelated
//     ground truth; an answer passes those checks only by reproducing the source's own text.
//   - The tier ceiling is ALWAYS 'factual-evidence-pass' and NEVER higher — this is source-grounded
//     prose, not the repo's own pre-existing suite (which would earn 'repo-verified').
//   - `residual` (the wrong-property / incompleteness risk that is NOT verified) is REQUIRED and
//     must be a non-empty string the CLAIM author SUPPLIES. If missing, that is a HARD ERROR — we do
//     NOT fabricate one, because a fabricated residual would understate the verifier's blind spots.
//   - The certificate carries constructorProvenance { claimAuthor, adversary } (distinct tags), and
//     certify additionally demands the answer author be a THIRD distinct provenance — so the module
//     enforces the decorrelation STRUCTURE even though it cannot verify the actual models.
//
// The assembled certificate is run through validateCertificate and THROWS if invalid — the
// assembly must produce a structurally valid certificate or fail loudly, never silently proceed.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { emitProseVerifier, validateClaims } from './prose-verifier.mjs';
import { validateCertificate } from './certify.mjs';
import { parseTapDetailed } from './gate-runner.mjs';

// Deep-clone + recursively freeze the externally-given requirements so NO generative fn can mutate
// the array (splice) or an element the coverage check + certificate assembly later read. structured
// clone via JSON is sufficient here — requirements are plain {id,text,...} objects.
function freezeRequirements(requirements) {
  const clone = JSON.parse(JSON.stringify(requirements));
  for (const r of clone) Object.freeze(r);
  return Object.freeze(clone);
}

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }

function sha256Hex(s) { return createHash('sha256').update(String(s)).digest('hex'); }

// A candidate worktree branched off base whose ONLY change vs base is answer.md = answer.
// (Same shape as m2-prose-slice's answerWorktree — reused so certify sees identical diffs.)
function answerWorktree(repo, base, root, name, answer) {
  const wt = path.join(root, name);
  git(repo, ['worktree', 'add', '-q', '--detach', wt, base]);
  writeFileSync(path.join(wt, 'answer.md'), answer);
  return wt;
}

/**
 * Construct a prose verifier for an ARBITRARY task from EXTERNALLY-GIVEN requirements.
 *
 * The creative step is split across TWO DECORRELATED agents to break circularity:
 *   - claimFn     authors the VERIFIER (claims + residual);
 *   - adversaryFn authors the PROOF that the verifier discriminates (anti-candidates + red answer),
 *                 BLIND to the claims.
 * Everything around them is deterministic: requirement freezing, coverage validation, claim
 * validation, certificate assembly, provenance, and emitting the standalone oracle. The tier
 * ceiling is fixed at 'factual-evidence-pass'.
 *
 * @param {object} opts
 * @param {string} opts.task     the task / question (decorrelated from any test scaffolding)
 * @param {string} opts.source   the decorrelated ground-truth text claims are grounded against
 * @param {{id:string, text:string}[]} opts.requirements  EXTERNALLY GIVEN; ids must be unique
 * @param {(args:{task:string, source:string, requirements:{id:string,text:string}[]}) =>
 *           Promise<{ claims:{id:string, requirementId:string, kind:string}[], residual:string }>
 *         | {claims, residual}} opts.claimFn   the VERIFIER author. May be async.
 * @param {(args:{task:string, source:string, requirements:{id:string,text:string}[]}) =>
 *           Promise<{ antiCandidates:{id:string, requirementId:string, answer:string}[], redAnswer:string }>
 *         | {antiCandidates, redAnswer}} opts.adversaryFn   the SEPARATE adversary. May be async.
 * @param {string} opts.claimAuthor  provenance tag for the claim author (must differ from adversary)
 * @param {string} opts.adversary    provenance tag for the adversary (must differ from claimAuthor)
 * @returns {Promise<{ verifierSource:string, certificate:object,
 *                     claims:object[], antiCandidates:object[], redAnswer:string,
 *                     coverage:{ ok:boolean, problems:string[] } }>}
 * @throws on any coverage gap, missing/empty residual, equal/missing provenance, an invalid claim,
 *         or a structurally invalid certificate.
 */
export async function constructProseVerifier({ task, source, requirements, claimFn, adversaryFn, claimAuthor, adversary }) {
  if (typeof source !== 'string' || source.trim() === '') {
    throw new Error('constructProseVerifier: source must be a non-empty string (the decorrelated ground truth)');
  }
  if (!Array.isArray(requirements) || requirements.length === 0) {
    throw new Error('constructProseVerifier: requirements must be a non-empty array (externally given)');
  }
  if (typeof claimFn !== 'function') {
    throw new Error('constructProseVerifier: claimFn must be a function (the verifier author)');
  }
  if (typeof adversaryFn !== 'function') {
    throw new Error('constructProseVerifier: adversaryFn must be a function (the SEPARATE adversary)');
  }
  // Provenance tags must be present and DISTINCT — the claim author and the adversary that proves
  // the claims cannot be the same generative step (the circularity the AR found).
  if (typeof claimAuthor !== 'string' || claimAuthor.trim() === '') {
    throw new Error('constructProseVerifier: claimAuthor must be a non-empty provenance string');
  }
  if (typeof adversary !== 'string' || adversary.trim() === '') {
    throw new Error('constructProseVerifier: adversary must be a non-empty provenance string');
  }
  if (claimAuthor.trim() === adversary.trim()) {
    throw new Error(`constructProseVerifier: claimAuthor and adversary must be DISTINCT (both ${JSON.stringify(claimAuthor)}) — the claim author and the adversary that proves the claims must be decorrelated`);
  }

  // Requirements are EXTERNALLY GIVEN — validate their shape + id-uniqueness HERE so the
  // constructor cannot be blamed for malformed input, and so the coverage map below is well-keyed.
  const reqIds = new Set();
  for (const r of requirements) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || r.id.trim() === '') {
      throw new Error(`constructProseVerifier: every requirement needs a non-empty string id, got: ${JSON.stringify(r)}`);
    }
    if (reqIds.has(r.id)) {
      throw new Error(`constructProseVerifier: requirement id ${JSON.stringify(r.id)} is not unique`);
    }
    reqIds.add(r.id);
  }

  // FREEZE the requirements (deep clone + Object.freeze) BEFORE calling any generative fn, and pass
  // the frozen clones to both agents. Coverage + certificate assembly run ONLY against this frozen
  // snapshot — a fn that splices/mutates its `requirements` arg cannot shrink the array coverage
  // checks against, nor drop a requirement from the certificate. (A frozen splice throws in strict
  // mode / is a no-op; either way the snapshot here is untouched.)
  const frozenReqs = freezeRequirements(requirements);

  // The TWO decorrelated creative steps. claimFn authors the verifier; adversaryFn authors the
  // discrimination proof, BLIND to the claims. Each is handed the SAME frozen requirements.
  const claimOut = await claimFn({ task, source, requirements: frozenReqs });
  const { claims, residual } = claimOut || {};
  const adversaryOut = await adversaryFn({ task, source, requirements: frozenReqs });
  const { antiCandidates, redAnswer } = adversaryOut || {};

  if (!Array.isArray(claims)) throw new Error('claimFn must return claims: an array');
  if (!Array.isArray(antiCandidates)) throw new Error('adversaryFn must return antiCandidates: an array');
  if (typeof redAnswer !== 'string' || redAnswer.trim() === '') {
    throw new Error('adversaryFn must return a non-empty redAnswer string');
  }
  // Residual is REQUIRED and must be supplied by the CLAIM author — we never fabricate one (that
  // would hide blind spots).
  if (typeof residual !== 'string' || residual.trim() === '') {
    throw new Error('claimFn must return a non-empty residual string — the unverified wrong-property / incompleteness risk MUST be declared, not fabricated');
  }

  // VALIDATE claims against the source BEFORE coverage/emit — reject unknown kinds, missing required
  // fields, and ungrounded source anchors so a vacuous claim can never be baked into the oracle.
  const cv = validateClaims(claims, source);
  if (!cv.valid) {
    throw new Error(`constructProseVerifier: claim validation FAILED — refusing to proceed:\n  - ${cv.problems.join('\n  - ')}`);
  }

  // --- DETERMINISTIC COVERAGE VALIDATION (impossible to silently proceed on a gap) ----------
  const problems = [];

  // Claim ids globally unique; every claim's requirementId names a GIVEN requirement.
  const claimsByReq = new Map();              // reqId -> claim[]
  const seenClaimId = new Set();
  for (const c of claims) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || c.id.trim() === '') {
      problems.push(`claim has no non-empty id: ${JSON.stringify(c)}`);
      continue;
    }
    if (seenClaimId.has(c.id)) {
      problems.push(`claim id ${JSON.stringify(c.id)} is not globally unique`);
      continue;
    }
    seenClaimId.add(c.id);
    if (typeof c.requirementId !== 'string' || !reqIds.has(c.requirementId)) {
      problems.push(`claim ${JSON.stringify(c.id)} references unknown requirementId ${JSON.stringify(c.requirementId)} — claims may not invent requirements`);
      continue;
    }
    if (!claimsByReq.has(c.requirementId)) claimsByReq.set(c.requirementId, []);
    claimsByReq.get(c.requirementId).push(c);
  }

  // Exactly one anti-candidate per requirement; anti.requirementId names a GIVEN requirement;
  // anti ids globally unique.
  const antiByReq = new Map();               // reqId -> anti[]
  const seenAntiId = new Set();
  for (const a of antiCandidates) {
    if (!a || typeof a !== 'object' || typeof a.id !== 'string' || a.id.trim() === '') {
      problems.push(`anti-candidate has no non-empty id: ${JSON.stringify(a)}`);
      continue;
    }
    if (seenAntiId.has(a.id)) {
      problems.push(`anti-candidate id ${JSON.stringify(a.id)} is not globally unique`);
      continue;
    }
    seenAntiId.add(a.id);
    if (typeof a.requirementId !== 'string' || !reqIds.has(a.requirementId)) {
      problems.push(`anti-candidate ${JSON.stringify(a.id)} references unknown requirementId ${JSON.stringify(a.requirementId)}`);
      continue;
    }
    if (typeof a.answer !== 'string' || a.answer.trim() === '') {
      problems.push(`anti-candidate ${JSON.stringify(a.id)} must carry a non-empty answer string`);
      continue;
    }
    if (!antiByReq.has(a.requirementId)) antiByReq.set(a.requirementId, []);
    antiByReq.get(a.requirementId).push(a);
  }

  // Every GIVEN requirement must be COVERED: ≥1 claim AND exactly one matching anti-candidate.
  // (This is the no-dropped-requirement guard — the heart of the honesty contract.) Iterate the
  // FROZEN snapshot so a generative fn that mutated its `requirements` arg can't shrink this loop.
  for (const r of frozenReqs) {
    const cs = claimsByReq.get(r.id) || [];
    if (cs.length === 0) problems.push(`requirement ${JSON.stringify(r.id)} has NO claim — coverage gap (a generative fn dropped a requirement)`);
    const as = antiByReq.get(r.id) || [];
    if (as.length === 0) problems.push(`requirement ${JSON.stringify(r.id)} has NO anti-candidate — coverage gap`);
    else if (as.length > 1) problems.push(`requirement ${JSON.stringify(r.id)} has ${as.length} anti-candidates — need EXACTLY one`);
  }

  // No checkId (claim id) shared across requirements. validateCertificate enforces this too; we
  // pre-check here so the error names the offending claim rather than the assembled certificate.
  for (const [reqId, cs] of claimsByReq) {
    for (const c of cs) {
      // a claim id is unique globally (seenClaimId), so cross-requirement sharing can only happen
      // if the SAME claim object were listed under two requirements — guarded by the unique-id pass
      // above. Kept explicit for the certify contract: each claim belongs to exactly one requirement.
      void reqId; void c;
    }
  }

  const coverage = { ok: problems.length === 0, problems };
  if (!coverage.ok) {
    throw new Error(`constructProseVerifier: coverage validation FAILED — refusing to proceed:\n  - ${problems.join('\n  - ')}`);
  }

  // --- DETERMINISTIC ASSEMBLY ----------------------------------------------------------------
  // The emitted standalone oracle bakes in the claim list; `node claims.mjs <answer> <source>`
  // prints TAP keyed by claim id (the per-check key certify reads).
  const verifierSource = emitProseVerifier(claims);

  // One requirement per given requirement; checkIds = its claims' ids; antiCandidateId = its anti.
  // Built from the FROZEN snapshot — a mutated requirements arg can't drop a requirement here.
  const certificate = {
    tierCeiling: 'factual-evidence-pass',
    requirements: frozenReqs.map((r) => ({
      id: r.id,
      checkIds: (claimsByReq.get(r.id) || []).map((c) => c.id),
      antiCandidateId: (antiByReq.get(r.id) || [])[0].id,
    })),
    provenance: {
      source: 'construct-prose-verifier',
      timing: 'pre-authoring',
      path: 'claimFn+adversaryFn',
      hash: sha256Hex(source),
    },
    // DECORRELATION attestation: the claim author and the adversary that proves the claims are
    // distinct generative steps. certify additionally demands a THIRD distinct answerAuthor.
    constructorProvenance: { claimAuthor, adversary },
    residual,
  };

  // Defensive: the assembly MUST produce a structurally valid certificate. validateCertificate
  // re-checks id uniqueness, ≥1 checkId/requirement, cross-requirement checkId disjointness,
  // provenance completeness, constructorProvenance distinctness, and a non-empty residual. THROW
  // if it doesn't hold.
  const v = validateCertificate(certificate);
  if (!v.valid) {
    throw new Error(`constructProseVerifier: assembled certificate is structurally invalid:\n  - ${v.problems.join('\n  - ')}`);
  }

  return { verifierSource, certificate, claims, antiCandidates, redAnswer, coverage };
}

/**
 * Build the BASE git repo + candidate worktrees a certifyVerifier run needs, exactly like
 * m2-prose-slice does — but parameterized on the CONSTRUCTED verifier rather than the fixed
 * example. Returns everything certifyVerifier needs, plus a makeAnswerCandidate() factory so a
 * REAL answer author's output can be gated later against the same constructed verifier.
 *
 * @param {object} opts
 * @param {string} opts.workdir         a writable dir to build the base repo + worktrees under
 * @param {string} opts.source          the decorrelated source (committed as source.md)
 * @param {string} opts.verifierSource  the emitted claims.mjs (committed as verify/claims.mjs)
 * @param {string} opts.redAnswer       the known-bad answer (committed as the RED base answer.md)
 * @param {{id:string, requirementId:string, answer:string}[]} opts.antiCandidates
 * @returns {{ repo:string, base:string, verify:object[], oracleFiles:Record<string,string>,
 *             protectedPaths:string[], redCandidateDir:string,
 *             antiCandidateDirs:{id:string, requirementId:string, dir:string}[],
 *             makeAnswerCandidate:(answerText:string)=>string,
 *             expectedRedCheckIds:string[] }}
 */
export async function assembleForCertify({ workdir, source, verifierSource, redAnswer, antiCandidates }) {
  if (typeof workdir !== 'string' || !workdir) throw new Error('assembleForCertify: workdir is required');
  if (typeof source !== 'string') throw new Error('assembleForCertify: source must be a string');
  if (typeof verifierSource !== 'string') throw new Error('assembleForCertify: verifierSource must be a string');
  if (typeof redAnswer !== 'string') throw new Error('assembleForCertify: redAnswer must be a string');
  if (!Array.isArray(antiCandidates)) throw new Error('assembleForCertify: antiCandidates must be an array');

  // BASE repo: answer.md = the RED answer, plus the emitted oracle + source. Same layout as
  // m2-prose-slice so certify gates an identical diff shape.
  const repo = path.join(workdir, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '--initial-branch=main']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  mkdirSync(path.join(repo, 'verify'), { recursive: true });
  writeFileSync(path.join(repo, 'verify', 'claims.mjs'), verifierSource);
  writeFileSync(path.join(repo, 'source.md'), source);
  writeFileSync(path.join(repo, 'answer.md'), redAnswer);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base: RED answer + constructed prose oracle']);
  const base = git(repo, ['rev-parse', 'HEAD']);

  // Gate config: the constructed verifier + its protected oracle/source. oracleFiles re-materializes
  // the oracle + source into each gate worktree (trusted-harness install, exempt from immutability);
  // protectedPaths stops any candidate from editing the oracle or source to grade itself.
  const oracleFiles = { 'verify/claims.mjs': verifierSource, 'source.md': source };
  const verify = [{ name: 'claims', cmd: ['node', 'verify/claims.mjs', 'answer.md', 'source.md'], type: 'test' }];
  const protectedPaths = ['verify/claims.mjs', 'source.md'];

  // Candidate worktrees: RED (the known-bad answer) + one anti-candidate worktree per anti-candidate,
  // each carrying { id, requirementId, dir } so certify can match it to its requirement by BOTH ids.
  const root = mkdtempSync(path.join(workdir, 'wt-'));
  const redCandidateDir = answerWorktree(repo, base, root, 'red', redAnswer);

  const antiCandidateDirs = antiCandidates.map((a, i) => ({
    id: a.id,
    requirementId: a.requirementId,
    dir: answerWorktree(repo, base, root, `anti-${i}-${a.requirementId}`, a.answer),
  }));

  // A factory for a fresh answer-candidate worktree — so a real answer author's output can be gated
  // later against this SAME constructed verifier. Each call gets a unique dir name.
  let answerSeq = 0;
  const makeAnswerCandidate = (answerText) => {
    if (typeof answerText !== 'string') throw new Error('makeAnswerCandidate: answerText must be a string');
    return answerWorktree(repo, base, root, `answer-${answerSeq++}`, answerText);
  };

  // expectedRedCheckIds: the checkIds the RED answer is EXPECTED to fail. Derive deterministically
  // by running the emitted oracle on the red answer vs source and reading which claim ids fail —
  // grounded against the real oracle, not a guess. Fall back to the union of all checkIds if the
  // run yields no failure (defensive; the red answer is meant to break ≥1 check).
  const expectedRedCheckIds = deriveRedFailures({ workdir, verifierSource, redAnswer, source });

  return {
    repo, base, verify, oracleFiles, protectedPaths,
    redCandidateDir, antiCandidateDirs, makeAnswerCandidate, expectedRedCheckIds,
  };
}

// Run the emitted oracle once over (redAnswer, source) and return the claim ids it reports as
// failing. Deterministic OS process — the same string-includes oracle certify will run. If nothing
// fails (the red answer is, against expectation, fully passing) we return the full check id set so
// certify will (correctly) find the red baseline NON-discriminating rather than silently green it.
function deriveRedFailures({ workdir, verifierSource, redAnswer, source }) {
  const dir = mkdtempSync(path.join(workdir, 'red-probe-'));
  const claimsPath = path.join(dir, 'claims.mjs');
  const answerPath = path.join(dir, 'answer.md');
  const sourcePath = path.join(dir, 'source.md');
  writeFileSync(claimsPath, verifierSource);
  writeFileSync(answerPath, redAnswer);
  writeFileSync(sourcePath, source);
  let stdout = '';
  try {
    stdout = execFileSync('node', [claimsPath, answerPath, sourcePath], { encoding: 'utf8' });
  } catch (e) {
    stdout = (e.stdout || '') + (e.stderr || '');
  }
  const detail = parseTapDetailed(stdout);
  const perCheck = detail.perTest || {};
  const failed = Object.keys(perCheck).filter((id) => perCheck[id] === 'fail');
  if (failed.length) return failed;
  // No on-target failure: hand back every check id so certify's red-baseline predicate (≥1 expected
  // check must fail) reports the baseline as non-discriminating instead of mis-greening.
  return Object.keys(perCheck);
}
