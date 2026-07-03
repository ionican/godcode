// orchestrate-prose.mjs — the PROSE-QA adapter over the domain-pluggable pipeline (orchestrate.mjs).
// Thin: it builds claimFn/adversaryFn from the agent artifacts and plugs the prose construct/assemble
// adapter into orchestrateObjective. All the honesty logic + the AR-hardened gate→slate handling lives
// in orchestrate.mjs (and is exercised by this module's tests through the prose adapter).

import { constructProseVerifier, assembleForCertify } from './construct-prose-verifier.mjs';
import { orchestrateObjective } from './orchestrate.mjs';
import { bleedLint } from './bleed-lint.mjs';
import { validateClaims, evaluateClaims } from './prose-verifier.mjs';

// MEASUREMENT-ONLY discriminating-probe runner (piece D). Evaluates HELD-OUT, claim-shaped probes against
// each ADMITTED answer IN-PROCESS, reusing the exact `evaluateClaim` predicate (no git/browser). Returns a
// per-candidate pass/fail map the orchestrator turns into a behavioural signature for the dispersion measure.
// It NEVER gates admission — the orchestrator calls it only over the already-admitted set, purely to LABEL
// diversity. A malformed probe throws (validated up front) so a bad probe can't silently mis-measure.
function runProseProbes(candidates, probes, { source }) {
  const { valid, problems } = validateClaims(probes, source);
  if (!valid) throw new Error(`discriminatingProbes (prose): invalid probe(s) — ${problems.join('; ')}`);
  return candidates.map((c) => {
    const { results } = evaluateClaims(probes, String(c.content), source);
    const perProbe = {};
    for (const r of results) perProbe[r.id] = r.ok ? 'pass' : 'fail';
    return { id: c.id, perProbe };
  });
}

// Re-export the shared helpers so existing importers (and tests) keep their import paths.
export {
  NO_VERDICT, judgeFnFromVerdicts, resolveAnswerAuthor, authorIsDecorrelated, classifyGate, pickBestFailing, validateProbeRows,
} from './orchestrate.mjs';

/**
 * The default SUPPLEMENTARY proxies (tie-break only — the judge is primary). Per D10 the objective is
 * best OUTCOME (correct + complete + insightful); verbosity is trimmable, NEVER a demerit — so there
 * is deliberately NO concision proxy here. Specificity (digit count) is a weak factual-density proxy.
 */
export function defaultProseProxies() {
  return [{ name: 'specificity (#digits)', of: (c) => (String(c.content).match(/\d/g) || []).length, prefer: 'higher' }];
}

// The prose domain adapter: the constructed verifier confers `factual-evidence-pass`. It also
// exposes `bleedLint` — prose claims are a PURE string predicate, so the pre-certify lint can run the
// exact oracle predicate in-process (no git/browser). HTML adapters expose no hook (their checks need
// a real browser snapshot) ⇒ the lint is a no-op there and HTML bleed stays caught by full certify.
const proseAdapter = {
  label: 'prose',
  tier: 'factual-evidence-pass',
  construct: constructProseVerifier,
  assemble: assembleForCertify,
  bleedLint,
  runProbes: runProseProbes,   // piece D — measurement-only behavioural-diversity probes (in-process).
};

/**
 * Run the prose-QA loop. Takes the agent artifacts (claims/residual/antiCandidates/redAnswer + the
 * oracle-blind answers' text) and runs construct → certify → gate → slate via orchestrateObjective.
 *
 * @param {object} o  — same shape as before: { dossier*, task, source, requirements, clarifications,
 *   decisions, claims, residual, antiCandidates, redAnswer, answers:[{id,text,...}], proxies?, verdicts,
 *   claimAuthor, adversary, answerAuthor, judgeProvenance?, workdir?, attempts? }
 * @param {boolean} [o.slate=false]  OUTPUT MODE — default ships the single best verified answer (objective
 *   proxy); pass true (--slate) for the opt-in ranked advisory slate. Flows through to orchestrateObjective.
 */
export function orchestrateProse(o) {
  if (!Array.isArray(o.answers) || o.answers.length === 0) {
    throw new Error('orchestrateProse: answers must be a non-empty array of oracle-blind candidates');
  }
  const claimFn = () => ({ claims: o.claims, residual: o.residual });
  const adversaryFn = () => ({ antiCandidates: o.antiCandidates, redAnswer: o.redAnswer });
  const answers = o.answers.map((a) => ({ ...a, content: a.text }));   // normalize → content
  return orchestrateObjective({
    ...o, adapter: proseAdapter, claimFn, adversaryFn, answers,
    proxies: o.proxies || defaultProseProxies(),
  });
}
