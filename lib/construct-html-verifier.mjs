// construct-html-verifier — the GENERATIVE seam that makes HTML/interactive verification GENERAL.
//
// The analogue of construct-prose-verifier for an interactive artifact. The creative step — turning a
// task's EXTERNALLY-GIVEN requirements into checkable HTML acceptance `checks` + a broken-HTML anti-
// candidate per requirement + a red page + a residual — is INJECTED and split across TWO DECORRELATED
// agents to break circularity (same discipline as prose):
//   - claimFn({task, source, requirements}) -> { checks, residual }            the VERIFIER author.
//   - adversaryFn({task, source, requirements}) -> { antiCandidates, redAnswer }  a SEPARATE adversary,
//       per requirement an HTML page that VIOLATES it, BLIND to the checks; redAnswer = a baseline-bad page.
// Everything else is DETERMINISTIC CODE: requirement freezing, coverage validation, check validation,
// certificate assembly, provenance, and emitting the standalone agent-browser-driven oracle.
//
// HONESTY INVARIANTS (why a verifier constructed here can be trusted):
//   - Requirements are EXTERNALLY GIVEN, deep-CLONED + FROZEN before any generative fn runs.
//   - claimFn → checks (validated by validateHtmlChecks); adversaryFn → anti-pages + a red page. Neither
//     adds/drops requirements. Coverage: every requirement.id has ≥1 check AND exactly one anti, or throw.
//   - The tier ceiling is 'constructed-floor-pass' (a constructed behavioural floor — weaker than
//     'repo-verified', stronger than advisory); the certify wrapper RE-DERIVES the tier, never a self-claim.
//   - `residual` (what the checks do NOT verify) is REQUIRED, non-empty, and SUPPLIED by the claim author.
//   - constructorProvenance { claimAuthor, adversary } are distinct; certify demands a THIRD distinct
//     answer author. The HTML verifier carries the documented page-realm measurement residual (see
//     html-verifier.mjs) — fail-closed, but not a sandbox-grade guarantee.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { emitHtmlVerifier, validateHtmlChecks } from './html-verifier.mjs';
import { validateCertificate } from './certify.mjs';

const VERIFY_FILE = 'verify/html-verify.mjs';
const SPEC_FILE = 'spec.md';
const CANDIDATE_FILE = 'index.html';

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }
function sha256Hex(s) { return createHash('sha256').update(String(s)).digest('hex'); }

function freezeRequirements(requirements) {
  const clone = JSON.parse(JSON.stringify(requirements));
  for (const r of clone) Object.freeze(r);
  return Object.freeze(clone);
}

// A candidate worktree branched off base whose ONLY change vs base is index.html = html.
function htmlWorktree(repo, base, root, name, html) {
  const wt = path.join(root, name);
  git(repo, ['worktree', 'add', '-q', '--detach', wt, base]);
  writeFileSync(path.join(wt, CANDIDATE_FILE), html);
  return wt;
}

/**
 * Construct an HTML acceptance verifier for an ARBITRARY task from EXTERNALLY-GIVEN requirements.
 * Same decorrelated two-agent shape as constructProseVerifier. Tier ceiling = 'constructed-floor-pass'.
 *
 * @param {object} opts
 * @param {string} opts.task, @param {string} opts.source  (the spec / decorrelated ground truth)
 * @param {{id:string,text:string}[]} opts.requirements
 * @param {Function} opts.claimFn      → { checks, residual }
 * @param {Function} opts.adversaryFn  → { antiCandidates:[{id,requirementId,html}], redAnswer:<html> }
 * @param {string} opts.claimAuthor, @param {string} opts.adversary  (distinct provenance)
 * @returns {Promise<{verifierSource, certificate, checks, antiCandidates, redAnswer, coverage}>}
 */
export async function constructHtmlVerifier({ task, source, requirements, claimFn, adversaryFn, claimAuthor, adversary }) {
  if (typeof source !== 'string' || source.trim() === '') throw new Error('constructHtmlVerifier: source must be a non-empty string (the decorrelated spec)');
  if (!Array.isArray(requirements) || requirements.length === 0) throw new Error('constructHtmlVerifier: requirements must be a non-empty array (externally given)');
  if (typeof claimFn !== 'function') throw new Error('constructHtmlVerifier: claimFn must be a function (the verifier author)');
  if (typeof adversaryFn !== 'function') throw new Error('constructHtmlVerifier: adversaryFn must be a function (the SEPARATE adversary)');
  if (typeof claimAuthor !== 'string' || claimAuthor.trim() === '') throw new Error('constructHtmlVerifier: claimAuthor must be a non-empty provenance string');
  if (typeof adversary !== 'string' || adversary.trim() === '') throw new Error('constructHtmlVerifier: adversary must be a non-empty provenance string');
  if (claimAuthor.trim() === adversary.trim()) throw new Error(`constructHtmlVerifier: claimAuthor and adversary must be DISTINCT (both ${JSON.stringify(claimAuthor)}) — the verifier author and the adversary must be decorrelated`);

  const reqIds = new Set();
  for (const r of requirements) {
    if (!r || typeof r.id !== 'string' || r.id.trim() === '') throw new Error(`constructHtmlVerifier: every requirement needs a non-empty string id, got: ${JSON.stringify(r)}`);
    if (reqIds.has(r.id)) throw new Error(`constructHtmlVerifier: requirement id ${JSON.stringify(r.id)} is not unique`);
    reqIds.add(r.id);
  }
  const frozenReqs = freezeRequirements(requirements);

  // --- GENERATIVE STEP 1: the claim author writes the checks (+ an honest residual) ----------------
  const claimOut = await claimFn({ task, source, requirements: frozenReqs });
  const checks = claimOut && claimOut.checks;
  const residual = claimOut && claimOut.residual;
  if (!Array.isArray(checks)) throw new Error('constructHtmlVerifier: claimFn must return checks: an array');
  if (typeof residual !== 'string' || residual.trim() === '') throw new Error('constructHtmlVerifier: claimFn must return a non-empty residual string (what the checks do NOT verify) — never fabricated');
  const cv = validateHtmlChecks(checks);
  if (!cv.valid) throw new Error(`constructHtmlVerifier: check validation FAILED — refusing to proceed:\n  - ${cv.problems.join('\n  - ')}`);

  // --- GENERATIVE STEP 2: the SEPARATE adversary writes anti-pages + a red page --------------------
  const advOut = await adversaryFn({ task, source, requirements: frozenReqs });
  const antiCandidates = advOut && advOut.antiCandidates;
  const redAnswer = advOut && advOut.redAnswer;
  if (!Array.isArray(antiCandidates)) throw new Error('constructHtmlVerifier: adversaryFn must return antiCandidates: an array');
  if (typeof redAnswer !== 'string' || redAnswer.trim() === '') throw new Error('constructHtmlVerifier: adversaryFn must return a non-empty redAnswer (a baseline-wrong HTML page)');

  // --- DETERMINISTIC validation: check requirement-refs, anti shape, coverage ---------------------
  const problems = [];
  for (const c of checks) {
    if (typeof c.requirementId !== 'string' || !reqIds.has(c.requirementId)) problems.push(`check ${JSON.stringify(c.id)} references unknown requirementId ${JSON.stringify(c.requirementId)}`);
  }
  const antiIds = new Set();
  for (const a of antiCandidates) {
    if (!a || typeof a.id !== 'string' || a.id.trim() === '') { problems.push(`anti-candidate has no non-empty id: ${JSON.stringify(a)}`); continue; }
    if (antiIds.has(a.id)) problems.push(`anti-candidate id ${JSON.stringify(a.id)} is not globally unique`);
    antiIds.add(a.id);
    if (typeof a.requirementId !== 'string' || !reqIds.has(a.requirementId)) problems.push(`anti-candidate ${JSON.stringify(a.id)} references unknown requirementId ${JSON.stringify(a.requirementId)}`);
    if (typeof a.html !== 'string' || a.html.trim() === '') problems.push(`anti-candidate ${JSON.stringify(a.id)} must carry a non-empty html string`);
  }
  const checksByReq = new Map();
  for (const c of checks) { if (!checksByReq.has(c.requirementId)) checksByReq.set(c.requirementId, []); checksByReq.get(c.requirementId).push(c); }
  const antiByReq = new Map();
  for (const a of antiCandidates) { if (!antiByReq.has(a.requirementId)) antiByReq.set(a.requirementId, []); antiByReq.get(a.requirementId).push(a); }
  for (const r of frozenReqs) {
    if ((checksByReq.get(r.id) || []).length === 0) problems.push(`requirement ${JSON.stringify(r.id)} has NO check — coverage gap`);
    const as = antiByReq.get(r.id) || [];
    if (as.length === 0) problems.push(`requirement ${JSON.stringify(r.id)} has NO anti-candidate — coverage gap`);
    else if (as.length > 1) problems.push(`requirement ${JSON.stringify(r.id)} has ${as.length} anti-candidates — need EXACTLY one`);
  }
  const coverage = { ok: problems.length === 0, problems };
  if (!coverage.ok) throw new Error(`constructHtmlVerifier: coverage validation FAILED — refusing to proceed:\n  - ${problems.join('\n  - ')}`);

  // --- DETERMINISTIC ASSEMBLY ---------------------------------------------------------------------
  const verifierSource = emitHtmlVerifier(checks);   // standalone html-verify.mjs (drives agent-browser → TAP)
  const certificate = {
    tierCeiling: 'constructed-floor-pass',
    requirements: frozenReqs.map((r) => ({
      id: r.id,
      checkIds: (checksByReq.get(r.id) || []).map((c) => c.id),
      antiCandidateId: (antiByReq.get(r.id) || [])[0].id,
    })),
    provenance: { source: 'construct-html-verifier', timing: 'pre-authoring', path: 'claimFn+adversaryFn', hash: sha256Hex(source) },
    constructorProvenance: { claimAuthor, adversary },
    residual,
  };
  const v = validateCertificate(certificate);
  if (!v.valid) throw new Error(`constructHtmlVerifier: assembled certificate is structurally invalid:\n  - ${v.problems.join('\n  - ')}`);

  return { verifierSource, certificate, checks, antiCandidates, redAnswer, coverage };
}

/**
 * Build the BASE git repo + candidate worktrees certifyVerifier needs for an HTML run, plus a
 * makeAnswerCandidate() factory so a real answer author's index.html can be gated against the SAME
 * constructed verifier. Mirrors assembleForCertify but the candidate is `index.html` and the verify
 * command runs the agent-browser-driven oracle.
 *
 * expectedRedCheckIds = the UNION of all check ids (browser-free): certify additionally requires the
 * red gate to actually PRUNE, so a red page that (against expectation) passes everything is still
 * correctly found NON-discriminating — we don't need a browser run in assembly to pin which checks fail.
 *
 * @param {object} opts  { workdir, source(spec), verifierSource, redAnswer(html), antiCandidates, built }
 */
export async function assembleHtmlForCertify({ workdir, source, verifierSource, redAnswer, antiCandidates, built }) {
  if (typeof workdir !== 'string' || !workdir) throw new Error('assembleHtmlForCertify: workdir is required');
  if (typeof source !== 'string') throw new Error('assembleHtmlForCertify: source must be a string');
  if (typeof verifierSource !== 'string') throw new Error('assembleHtmlForCertify: verifierSource must be a string');
  if (typeof redAnswer !== 'string') throw new Error('assembleHtmlForCertify: redAnswer must be a string');
  if (!Array.isArray(antiCandidates)) throw new Error('assembleHtmlForCertify: antiCandidates must be an array');

  const repo = path.join(workdir, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '--initial-branch=main']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  mkdirSync(path.join(repo, 'verify'), { recursive: true });
  writeFileSync(path.join(repo, VERIFY_FILE), verifierSource);
  writeFileSync(path.join(repo, SPEC_FILE), source);
  writeFileSync(path.join(repo, CANDIDATE_FILE), redAnswer);   // base candidate = the RED page
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base: RED page + constructed HTML oracle']);
  const base = git(repo, ['rev-parse', 'HEAD']);

  const oracleFiles = { [VERIFY_FILE]: verifierSource, [SPEC_FILE]: source };
  const verify = [{ name: 'html', cmd: ['node', VERIFY_FILE, CANDIDATE_FILE], type: 'test' }];
  const protectedPaths = [VERIFY_FILE, SPEC_FILE];

  const root = mkdtempSync(path.join(workdir, 'wt-'));
  const redCandidateDir = htmlWorktree(repo, base, root, 'red', redAnswer);
  const antiCandidateDirs = antiCandidates.map((a, i) => ({
    id: a.id,
    requirementId: a.requirementId,
    dir: htmlWorktree(repo, base, root, `anti-${i}-${a.requirementId}`, a.html),
  }));

  let answerSeq = 0;
  const makeAnswerCandidate = (html) => {
    if (typeof html !== 'string') throw new Error('makeAnswerCandidate: html must be a string');
    return htmlWorktree(repo, base, root, `answer-${answerSeq++}`, html);
  };

  // Browser-free: the red page is EXPECTED to fail at least one check; certify confirms the red gate
  // actually pruned, so the union of all check ids is a sound "expected to fail" set.
  const expectedRedCheckIds = (built && built.certificate && Array.isArray(built.certificate.requirements))
    ? built.certificate.requirements.flatMap((r) => r.checkIds)
    : [];

  return { repo, base, verify, oracleFiles, protectedPaths, redCandidateDir, antiCandidateDirs, makeAnswerCandidate, expectedRedCheckIds };
}
