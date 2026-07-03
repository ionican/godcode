// orchestrate-html.mjs — the HTML/INTERACTIVE adapter over the domain-pluggable pipeline
// (orchestrate.mjs). Thin: it builds claimFn/adversaryFn from the agent artifacts (checks + broken-HTML
// anti-candidates) and plugs the HTML construct/assemble adapter into orchestrateObjective. The whole
// construct → certify → gate → slate → dossier flow, and every honesty invariant, is shared with prose.
//
// A real `/godcode "build an HTML page that does X"` run: the claim-author writes `checks`, the
// adversary writes broken-HTML anti-pages + a red page, the answer-authors write index.html candidates;
// this drives the certified-floor gate (a REAL headless browser via agent-browser) and the advisory slate.

import { constructHtmlVerifier, assembleHtmlForCertify } from './construct-html-verifier.mjs';
import { orchestrateObjective } from './orchestrate.mjs';

// The HTML domain adapter: a constructed behavioural floor confers `constructed-floor-pass`. The gate
// drives a real (or fake) headless browser per check — many subprocess spawns — so it needs a generous
// per-step timeout (the string-check prose gate keeps the 10s default).
const htmlAdapter = {
  label: 'html',
  tier: 'constructed-floor-pass',
  perStepTimeoutMs: 60000,
  construct: constructHtmlVerifier,
  assemble: assembleHtmlForCertify,
  // No `runProbes` hook (piece D): an HTML discriminating probe needs a REAL browser snapshot (same posture
  // as the prose-only bleedLint). Absent a runner, dispersion stays UNMEASURABLE — never falsely "converged".
  // A browser-driven HTML probe runner is the logged follow-on.
};

// Default SUPPLEMENTARY proxy (tie-break only — the judge is primary): smaller page to spec is a weak
// elegance/simplicity proxy. Verbosity is never a quality demerit (D10); the judge decides substance.
export function defaultHtmlProxies() {
  return [{ name: 'compactness (chars)', of: (c) => String(c.content).length, prefer: 'lower' }];
}

/**
 * Run the HTML-objective loop. Takes the agent artifacts (checks/residual/antiCandidates/redAnswer +
 * the oracle-blind answers' HTML) and runs construct → certify → gate → slate via orchestrateObjective.
 *
 * @param {object} o  { dossier*, task, source(spec), requirements, clarifications, decisions,
 *   checks, residual, antiCandidates:[{id,requirementId,html}], redAnswer:<html>,
 *   answers:[{id,html,...}], proxies?, verdicts, claimAuthor, adversary, answerAuthor,
 *   judgeProvenance?, workdir?, attempts? }
 * @param {boolean} [o.slate=false]  OUTPUT MODE — default ships the single best verified page (objective
 *   proxy); pass true (--slate) for the opt-in ranked advisory slate. Flows through to orchestrateObjective.
 */
export function orchestrateHtml(o) {
  if (!Array.isArray(o.answers) || o.answers.length === 0) {
    throw new Error('orchestrateHtml: answers must be a non-empty array of oracle-blind index.html candidates');
  }
  const claimFn = () => ({ checks: o.checks, residual: o.residual });
  const adversaryFn = () => ({ antiCandidates: o.antiCandidates, redAnswer: o.redAnswer });
  const answers = o.answers.map((a) => ({ ...a, content: a.html }));   // normalize → content
  return orchestrateObjective({
    ...o, adapter: htmlAdapter, claimFn, adversaryFn, answers,
    proxies: o.proxies || defaultHtmlProxies(),
  });
}
