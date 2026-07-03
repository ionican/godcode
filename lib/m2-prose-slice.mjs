// m2-prose-slice — the M2 prose-QA FIRST SLICE, wired end-to-end and DETERMINISTIC.
//
// Proves the prose-QA path the way gate.mjs proves the code path: a CONSTRUCTED prose
// verifier (emitProseVerifier over proseExample's fixed claims) is CERTIFIED out-of-band
// by certifyVerifier, and the resulting gate ships the correct answer + prunes the wrong one.
// No author agents, no LLM, no model judgment anywhere at runtime — every candidate is a
// SCRIPTED answer (proseExample's correct/wrong/anti answers) and every check is the
// emitted oracle's mechanical string test. The whole slice is reproducible.
//
// The chain, end-to-end:
//   1. proseExample() gives the fixed source + claims + correct/wrong/anti answers.
//   2. A BASE git repo is built with answer.md = the WRONG answer (the RED baseline), the
//      emitted verify/claims.mjs oracle, and source.md.
//   3. Candidate worktrees branch off base: the red candidate (wrong answer), one
//      anti-candidate per claim (each violating EXACTLY that claim), and a GOOD candidate
//      (the correct answer).
//   4. certifyVerifier RE-DERIVES the tier from three mechanical facts: red baseline FAILS,
//      every requirement's anti-candidate is KILLED by its checkId, the certificate is valid.
//      A clean run earns the 'factual-evidence-pass' ceiling.
//   5. runGate gates the GOOD candidate against the SAME oracle → it GREENS (the correct
//      answer ships).
//
// oracleFiles re-materializes verify/claims.mjs + source.md into each gate worktree (exempt
// from the immutability guard, the trusted harness installs the oracle); protectedPaths stops
// any candidate from editing the oracle or source to grade itself.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { emitProseVerifier, proseExample } from './prose-verifier.mjs';
import { certifyVerifier } from './certify.mjs';
import { runGate } from './gate.mjs';

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }

// A candidate worktree branched off base whose ONLY change vs base is answer.md = answer.
function answerWorktree(repo, base, root, name, answer) {
  const wt = path.join(root, name);
  git(repo, ['worktree', 'add', '-q', '--detach', wt, base]);
  writeFileSync(path.join(wt, 'answer.md'), answer);
  return wt;
}

/**
 * Run the M2 prose-QA first slice end-to-end inside `workdir`.
 *
 * Builds a RED base repo, certifies the constructed prose verifier (red baseline must fail,
 * every claim's anti-candidate must be killed, tier === 'factual-evidence-pass'), then gates
 * the GOOD candidate to confirm the correct answer ships. Asserts the full chain internally
 * and returns the structured result.
 *
 * @param {string} workdir  a writable directory to build the base repo + worktrees under
 * @returns {Promise<{certified:boolean, tier:string, requirements:{id:string,killed:boolean}[],
 *                     goodCandidateGreen:boolean, redBaselineRed:boolean}>}
 */
export async function runProseSlice(workdir) {
  // 1. The fixed worked example — source, claims, and scripted answers (no model).
  const ex = proseExample();

  // The emitted standalone oracle: `node claims.mjs <answer> <source>` → TAP keyed by claim id.
  const verifierSrc = emitProseVerifier(ex.claims);

  // 2. BASE repo: answer.md = the WRONG answer (RED base), plus the oracle + source.
  const repo = path.join(workdir, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '--initial-branch=main']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  mkdirSync(path.join(repo, 'verify'), { recursive: true });
  writeFileSync(path.join(repo, 'verify', 'claims.mjs'), verifierSrc);
  writeFileSync(path.join(repo, 'source.md'), ex.source);
  writeFileSync(path.join(repo, 'answer.md'), ex.wrongAnswer);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base: RED answer + prose oracle']);
  const base = git(repo, ['rev-parse', 'HEAD']);

  // 3. Gate config: the constructed verifier + its protected oracle/source.
  const oracleFiles = { 'verify/claims.mjs': verifierSrc, 'source.md': ex.source };
  const verify = [{ name: 'claims', cmd: ['node', 'verify/claims.mjs', 'answer.md', 'source.md'], type: 'test' }];
  const protectedPaths = ['verify/claims.mjs', 'source.md'];

  // 4. Candidate worktrees: RED (wrong), one anti-candidate per claim, and the GOOD answer.
  const root = mkdtempSync(path.join(workdir, 'wt-'));
  const redCandidateDir = answerWorktree(repo, base, root, 'red', ex.wrongAnswer);

  // Each anti-candidate violates EXACTLY one claim; requirementId = the claim id it breaks.
  const antiCandidates = ex.antiCandidates.map((a, i) => ({
    id: a.requirementId,
    requirementId: a.requirementId,
    dir: answerWorktree(repo, base, root, `anti-${i}-${a.requirementId}`, a.answer),
  }));

  const goodCandidateDir = answerWorktree(repo, base, root, 'good', ex.correctAnswer);

  // 5. Certificate: tierCeiling = factual-evidence-pass; one requirement per claim, each naming
  // its own checkId (the claim id, which is the TAP per-test key) + its anti-candidate. Claim ids
  // are unique, so requirement ids, antiCandidateIds, and checkIds are all unique/disjoint as the
  // stricter validateCertificate now requires.
  // constructorProvenance attests DECORRELATION: distinct claimAuthor + adversary tags, and the
  // certifyVerifier call passes a THIRD distinct answerAuthor. These fixture tags only satisfy the
  // STRUCTURE (the slice is fully scripted from proseExample — no real models). A REAL run MUST
  // wire genuinely decorrelated agents here: a claim-author model, a separate adversary model, and
  // a distinct answer-author model — three different generative steps, not three string labels.
  const certificate = {
    tierCeiling: 'factual-evidence-pass',
    requirements: ex.claims.map((c) => ({ id: c.id, checkIds: [c.id], antiCandidateId: c.id })),
    provenance: {
      source: 'proseExample (fixed)',
      timing: 'pre-authoring',
      path: 'prose-verifier.mjs#proseExample',
      hash: createHash('sha256').update(ex.source).digest('hex'),
    },
    constructorProvenance: { claimAuthor: 'fixture-claims', adversary: 'fixture-adversary' },
    residual: 'verifies only the listed claims against the given source',
  };

  // The RED baseline is ex.wrongAnswer, which bakes in a false number and so fails EXACTLY the
  // 'mass-value' claim (every other claim still passes). Declare that as the expected red check so
  // the red baseline counts as discriminating only on a real, on-target failure.
  const expectedRedCheckIds = ['mass-value'];

  // 6. CERTIFY: tier is RE-DERIVED from kills (never self-claimed). A clean run earns the ceiling.
  // attempts:3 keeps the flake quarantine live (the deterministic oracle never flakes, so it's free).
  const report = await certifyVerifier({
    repo, base, verify, oracleFiles, protectedPaths,
    certificate, redCandidateDir, expectedRedCheckIds, antiCandidates, attempts: 3,
    // THIRD distinct provenance: the answer author. In a REAL run this is the model that wrote the
    // candidate answers — different from both the claim author and the adversary.
    answerAuthor: 'fixture-author',
  });

  if (report.certified !== true) {
    throw new Error(`certifyVerifier did NOT certify: ${JSON.stringify(report.problems)}`);
  }
  if (report.tier !== 'factual-evidence-pass') {
    throw new Error(`unexpected tier: ${report.tier} (expected factual-evidence-pass)`);
  }
  if (report.redBaseline.red !== true) {
    throw new Error('red baseline did NOT discriminate (greened the wrong answer)');
  }
  for (const r of report.requirements) {
    if (!r.killed) throw new Error(`requirement ${r.id} was NOT killed by its anti-candidate`);
  }

  // 7. GATE the GOOD candidate against the SAME constructed verifier → it must GREEN (ship).
  const good = await runGate({
    repo,
    base,
    candidate: goodCandidateDir,
    verify: ['node verify/claims.mjs answer.md source.md'],
    protected: protectedPaths.join(','),
    attempts: 1,
    timeoutMs: 30000,
  });
  const goodCandidateGreen = good.res.gate === 'green';
  if (!goodCandidateGreen) {
    throw new Error(`GOOD candidate did NOT green: gate=${good.res.gate} failStep=${good.res.failStep}`);
  }

  return {
    certified: report.certified,
    tier: report.tier,
    requirements: report.requirements,
    goodCandidateGreen: true,
    redBaselineRed: true,
  };
}
