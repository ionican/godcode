// orchestrate.mjs — the DETERMINISTIC general-objective pipeline (the "gold-dust" loop for a task with
// no pre-existing verifier), DOMAIN-PLUGGABLE. The /godcode skill does the GENERATIVE steps (clarify,
// claim/check authoring, adversary, answer fan-out, judge) via Agent calls, then hands the artifacts
// here; this module runs everything DETERMINISTIC (D8) in one child process so the main agent context
// stays lean (D9) and the live HTTPS dossier (the one source of truth) is driven by code, not an agent.
//
// The honesty contract is preserved end-to-end and is IDENTICAL across domains:
//   • CONSTRUCT a decorrelated verifier (claim-author + separate adversary, both ≠ answer-author).
//   • CERTIFY it out-of-band (red baseline must go red; every anti-candidate must be killed;
//     three-way decorrelation). Certification can only AUTHORIZE the verified tier or DOWNGRADE.
//   • If certified → GATE each oracle-blind answer against it; admitted answers earn the verified
//     tier; rank the admitted set with a decorrelated judge into an ADVISORY slate; a HUMAN picks.
//   • If NOT certified → the floor is untrustworthy → NOBODY is verified; degrade to an advisory
//     slate over all answers and say so. Never a false green.
//
// The ONLY domain-specific pieces are the ADAPTER's `construct` (claims/checks → a verifier) and
// `assemble` (build the certify/gate repo + candidate factory). prose and HTML are two thin adapters
// over this same pipeline (orchestrate-prose.mjs / orchestrate-html.mjs). NEVER emits a "winner":
// verified ⇒ ordered slate + selectBy:'human'.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { certifyVerifier } from './certify.mjs';
import { candidateFiles } from './gate.mjs';
import { gateRunner } from './gate-runner.mjs';
import { buildSlate, advisoryRank, rankByProxies, validateCandidateIds, validateProxyDecls } from './slate.mjs';
import { dispersion, signatureFromResults } from './dispersion.mjs';
import { RunDossier } from './dossier.mjs';

// A sentinel the judge function returns when it has NO usable verdict for a pair (missing pair, or a
// garbage `winner`). It is deliberately NOT 'a'/'b'/'tie' so advisoryRank's normalizeVerdict flags it
// INVALID and counts it toward proxyOnlyFallback (AR finding 4) — distinct from an EXPLICIT tie, which
// is a real signal. Never let "the judge said nothing" masquerade as "the judge called it even".
export const NO_VERDICT = 'no-verdict';

/**
 * Build the pairwise judge function the slate needs from a judge agent's verdict object.
 * verdicts = { pairs: [{ a, b, winner }], rationale? }, winner ∈ {a-id, b-id, 'tie'}.
 * - explicit winner=a-id/b-id → 'a'/'b'; explicit winner='tie' → 'tie' (a real, valid signal).
 * - missing pair OR garbage winner → NO_VERDICT (invalid ⇒ advisoryRank counts it, never a fake tie).
 */
export function judgeFnFromVerdicts(verdicts) {
  const pairs = (verdicts && Array.isArray(verdicts.pairs)) ? verdicts.pairs : [];
  return ({ a, b }) => {
    const p = pairs.find((x) => (x.a === a.id && x.b === b.id) || (x.a === b.id && x.b === a.id));
    if (!p) return NO_VERDICT;                       // no signal — NOT a tie
    if (p.winner === 'tie') return 'tie';            // explicit, valid
    if (p.winner === a.id) return 'a';
    if (p.winner === b.id) return 'b';
    return NO_VERDICT;                               // garbage winner — invalid, NOT a tie
  };
}

/** Resolve a candidate's answer-author provenance (per-candidate override, else the global tag). */
export function resolveAnswerAuthor(answer, globalAuthor) {
  const a = (answer && typeof answer.answerAuthor === 'string') ? answer.answerAuthor.trim() : '';
  const g = (typeof globalAuthor === 'string') ? globalAuthor.trim() : '';
  return a || g;
}

/**
 * Is a candidate's answer-author DECORRELATED from the verifier's two construction roles? An answer
 * authored by the claim-author or the adversary is NOT a third independent step — it cannot earn a
 * verified tier however green its gate (AR finding 2 — per-candidate answerAuthor could bypass the
 * three-way decorrelation certify checks only against the GLOBAL author).
 */
export function authorIsDecorrelated(author, claimAuthor, adversary) {
  const a = (author || '').trim();
  if (!a) return false;
  return a !== (claimAuthor || '').trim() && a !== (adversary || '').trim();
}

/**
 * Classify one gate result into a TRUST outcome — the honesty taxonomy that keeps an inconclusive
 * gate from masquerading as a near-miss failure (AR finding 3):
 *   'admitted'     — certified floor, author decorrelated, gate green ⇒ VERIFIED.
 *   'failed'       — certified, pruned with a COMPLETE per-check map ⇒ a real, decisive check failure.
 *   'inconclusive' — uncertified floor, OR author not decorrelated, OR incomplete / pruned-without-map
 *                    ⇒ NO decisive correctness evidence; never a verified pass and never a "best failing".
 */
export function classifyGate({ certified, decorrelated, gate, perTest }) {
  if (!certified) return 'inconclusive';                 // untrustworthy floor — no verified evidence
  // A GENUINE, decisive failure (pruned with a complete per-check map) is a 'failed' REGARDLESS of who
  // authored the answer — decorrelation gates ADMISSION (you can't TRUST a green from a colliding
  // author), but a wrong answer is wrong no matter who wrote it. Classifying it before the
  // decorrelation guard keeps an honest decline honest (AR2: else an all-collision cohort that really
  // failed would mislabel as 'blocked'/"no decisive failure").
  if (gate === 'pruned' && perTest && Object.keys(perTest).length > 0) return 'failed';
  if (gate === 'green') return decorrelated ? 'admitted' : 'inconclusive';  // green is trusted only if decorrelated
  return 'inconclusive';                                  // incomplete / pruned-without-map — no evidence
}

/** Pick the closest-to-green among GENUINELY-FAILED candidates (fewest failed checks). Inconclusive
 * candidates are excluded by the caller — they did not "almost pass", the gate gave no verdict. */
export function pickBestFailing(failed) {
  if (!Array.isArray(failed) || failed.length === 0) return null;
  const best = [...failed].sort((x, y) => x.failedChecks.length - y.failedChecks.length)[0];
  return { id: best.id, gate: best.gate, failStep: best.failStep || null, failedChecks: best.failedChecks };
}

/**
 * Validate an adapter `runProbes` output before it feeds the dispersion measure (AR MED — a buggy/adversarial
 * runner must not silently mis-measure diversity). Requires EXACTLY one row per admitted id (no missing, no
 * extra/non-admitted, no duplicate) and every probe id present with a value of EXACTLY 'pass' or 'fail'. A
 * violation THROWS (surfaces the runner bug) rather than coercing a missing/odd result into a fake signature.
 * Returns a Map<id, perProbe>. This guards ONLY the dispersion LABEL — it never affects admission or the pick.
 * @returns {Map<string, Record<string,'pass'|'fail'>>}
 */
export function validateProbeRows(rows, admittedIds, probeIds) {
  if (!Array.isArray(rows)) throw new Error('discriminatingProbes: runProbes must return an array of {id, perProbe} rows');
  const expected = new Set(admittedIds);
  const byId = new Map();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !expected.has(row.id)) {
      throw new Error(`discriminatingProbes: runProbes returned a row for an unexpected / non-admitted id ${JSON.stringify(row && row.id)}`);
    }
    if (byId.has(row.id)) throw new Error(`discriminatingProbes: runProbes returned a DUPLICATE row for id ${JSON.stringify(row.id)}`);
    const pp = (row.perProbe && typeof row.perProbe === 'object') ? row.perProbe : {};
    // OWN props only — an INHERITED verdict (polluted prototype) must not count as a real result (parity
    // with mutation-probes.mjs). Copy into a null-prototype object so nothing downstream reads an inherited value.
    const clean = Object.create(null);
    for (const pid of probeIds) {
      if (!Object.hasOwn(pp, pid) || (pp[pid] !== 'pass' && pp[pid] !== 'fail')) {
        throw new Error(`discriminatingProbes: runProbes row ${JSON.stringify(row.id)} has an invalid/missing result for probe ${JSON.stringify(pid)} (must be 'pass'|'fail', got ${JSON.stringify(pp[pid])})`);
      }
      clean[pid] = pp[pid];
    }
    byId.set(row.id, clean);
  }
  if (byId.size !== expected.size) {
    throw new Error(`discriminatingProbes: runProbes returned ${byId.size} row(s) for ${expected.size} admitted candidate(s) — exactly one row per admitted id is required`);
  }
  return byId;
}

// Rank an answer set advisorily WITHOUT claiming verification — used when the constructed verifier
// failed certification (the floor is untrustworthy, so nothing is verified). Mirrors the buildSlate
// shape but every row is tier 'advisory-slate' and selectBy stays 'human'.
async function advisoryOnlySlate({ candidates, judgeFn, judgeProvenance, answerAuthor }) {
  const adv = await advisoryRank({ task: undefined, candidates, judgeFn, judgeProvenance, answerAuthor });
  const slate = adv.ranking.map((r) => ({ id: r.id, tier: 'advisory-slate', advisoryRank: r.advisoryRank, advisoryScore: r.advisoryScore }));
  return {
    slate, rankingIsAdvisory: true, decorrelated: adv.decorrelated, selectBy: 'human',
    judgeErrors: adv.judgeErrors, invalidVerdicts: adv.invalidVerdicts, proxyOnlyFallback: adv.proxyOnlyFallback,
    note: 'Verifier NOT certified — the constructed floor is untrustworthy, so NO answer is verified. The order is ADVISORY only; a HUMAN selects, with no correctness guarantee.',
  };
}

/**
 * Run the full deterministic general-objective pipeline for ANY domain, given an ADAPTER.
 *
 * @param {object} o
 * @param {{construct:Function, assemble:Function, tier?:string, label?:string}} o.adapter
 *        construct({task,source,requirements,claimFn,adversaryFn,claimAuthor,adversary}) → built
 *          (built: {verifierSource, certificate, antiCandidates, redAnswer, claims?|checks?})
 *        assemble({workdir,source,verifierSource,redAnswer,antiCandidates}) → asm
 *          (asm: {repo,base,verify,oracleFiles,protectedPaths,redCandidateDir,antiCandidateDirs,
 *                 makeAnswerCandidate,expectedRedCheckIds})
 *        tier: the VERIFIED tier this domain's certified floor confers (default 'constructed-floor-pass').
 * @param {Function} o.claimFn      () → { claims|checks, residual } (the verifier author's output)
 * @param {Function} o.adversaryFn  () → { antiCandidates, redAnswer } (the SEPARATE adversary's output)
 * @param {{id:string,content:string,tier?:string,answerAuthor?:string,angle?:string}[]} o.answers
 *        each candidate's `content` is the domain artifact string (prose text / HTML source).
 * @param {object[]} [o.proxies]    supplementary slate proxies (tie-break only)
 * @param {{pairs:object[]}} [o.verdicts] judge output (absent ⇒ proxy-only order)
 * @param {boolean} [o.slate=false] OUTPUT MODE. DEFAULT (false) = ship the SINGLE best verified answer,
 *        picked among the equally-VERIFIED admitted set by the OBJECTIVE PROXY (deterministic, NO judge),
 *        because correctness is binary and settled by the certified gate. OPT-IN (true) = emit the ranked
 *        ADVISORY slate (the judge ranks the verified set; a HUMAN picks) — for the diversity case where a
 *        quality residue beyond correctness is what differs. Orthogonal to o.n (how many are DRAWN/gated).
 * @param {number} [o.targetK=3]   dispersion sufficiency target (label only; see dispersion.mjs).
 * @param {object[]} [o.discriminatingProbes]  HELD-OUT, MEASUREMENT-ONLY probes (claim/check-shaped, NOT in
 *        the acceptance set) run over the ADMITTED answers to measure behavioural diversity the all-pass
 *        floor can't. NEVER gate admission or change the pick/order — they ONLY label dispersion
 *        (unmeasurable → converged → diverse). Validated disjoint from the acceptance check ids. Requires the
 *        adapter to expose a `runProbes(candidates, probes, {source})` runner (prose: in-process; HTML: none).
 * @param {string} o.dossierDir, o.dossierVaultRelDir, o.dossierId, o.objective, o.request
 * @param {string} o.task, o.source
 * @param {{id:string,text:string}[]} o.requirements
 * @param {{q,a}[]} [o.clarifications]  @param {object[]} [o.decisions]
 * @param {string} o.claimAuthor, o.adversary, o.answerAuthor  (pairwise-distinct provenance)
 * @param {string} [o.judgeProvenance]  @param {string} [o.workdir]  @param {number} [o.attempts=3]
 * @returns {Promise<object>} the run report
 */
export async function orchestrateObjective(o) {
  const {
    adapter,
    dossierDir, dossierVaultRelDir, dossierId, objective, request,
    task, source, requirements, clarifications = [], decisions = [],
    claimFn, adversaryFn, answers,
    proxies = [], verdicts,
    claimAuthor, adversary, answerAuthor, judgeProvenance = 'unknown-judge',
    workdir, attempts = 3,
  } = o;

  if (!adapter || typeof adapter.construct !== 'function' || typeof adapter.assemble !== 'function') {
    throw new Error('orchestrateObjective: adapter with construct() + assemble() is required');
  }
  if (typeof claimFn !== 'function' || typeof adversaryFn !== 'function') {
    throw new Error('orchestrateObjective: claimFn + adversaryFn are required');
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new Error('orchestrateObjective: answers must be a non-empty array of oracle-blind candidates');
  }

  const VERIFIED_TIER = adapter.tier || 'constructed-floor-pass';
  const label = adapter.label || 'obj';
  // OUTPUT MODE — default single-best (one verified answer by objective proxy), opt-in ranked slate.
  // Read separately (not destructured) to avoid colliding with the local `slate` result variable.
  const wantSlate = o.slate === true;
  const targetK = (typeof o.targetK === 'number' && o.targetK > 0) ? o.targetK : 3;
  // Per-gate-step timeout: a browser-driven domain (HTML) needs a generous one (the adapter sets it);
  // a string-check domain (prose) keeps the gate default. Threaded to certify + the answer gate.
  const perStepTimeoutMs = (typeof o.perStepTimeoutMs === 'number' && o.perStepTimeoutMs > 0) ? o.perStepTimeoutMs
    : (typeof adapter.perStepTimeoutMs === 'number' && adapter.perStepTimeoutMs > 0) ? adapter.perStepTimeoutMs : undefined;
  const scratch = workdir || mkdtempSync(path.join(tmpdir(), `gc-${label}-`));

  // ── live source-of-truth page (open the page the skill already drafted, or create it) ──────
  const d = RunDossier.open({ dir: dossierDir, id: dossierId, objective, request });
  d.setMilestones([
    { id: 'm1', title: 'Construct verifier', detail: 'two decorrelated agents — claim-author + separate adversary, from a decorrelated source' },
    { id: 'm2', title: 'Certify verifier', detail: 'red baseline must go red · every anti-candidate must be killed · three-way decorrelation' },
    { id: 'm3', title: 'Fan-out + gate answers', detail: 'oracle-blind answers gated out-of-band against the certified floor' },
    { id: 'm4', title: 'Select / ship', detail: 'DEFAULT: ship the single best verified answer by objective proxy · OPT-IN --slate: advisory ranked slate, a HUMAN selects' },
  ]);
  if (clarifications.length) d.setClarifications(clarifications);
  for (const dec of decisions) d.decide(dec);

  // ── M1 · construct the verifier (two decorrelated generative steps, supplied as data) ──────
  d.startMilestone('m1');
  const built = await adapter.construct({ task, source, requirements, claimFn, adversaryFn, claimAuthor, adversary });
  const nChecks = (built.claims || built.checks || []).length;
  d.discovery(`Verifier constructed: ${nChecks} check(s) over ${requirements.length} requirement(s), ${built.antiCandidates.length} anti-candidate(s). Decorrelation: claim-author=${claimAuthor} · adversary=${adversary} · answer-author=${answerAuthor}.`);
  d.finishMilestone('m1', 'done');

  // ── M1.5 · advisory pre-certify lint (prose adapter only) ──────────────────────────────────
  // Forecast certify's verdict IN-PROCESS from raw strings, reusing the EXACT emitted predicate
  // (single source of truth) — no git, no child process. STRICTLY ADVISORY: it predicts + emits
  // mechanical re-author feedback + (opt-in) short-circuits to 'needs-reauthor' on a PROVABLE,
  // claim-author-fixable failure; it NEVER certifies, never admits, never lets a verifier skip the
  // real certifyVerifier below. HTML adapters expose no bleedLint hook (their checks need a real
  // browser snapshot) ⇒ the lint is a no-op there and HTML bleed stays caught by full certify.
  const lintReport = (typeof adapter.bleedLint === 'function' && built.certificate)
    ? adapter.bleedLint({ claims: built.claims, certificate: built.certificate, antiCandidates: built.antiCandidates, redAnswer: built.redAnswer, source, answerAuthor })
    : null;
  if (lintReport) {
    d.discovery(`Pre-certify lint (ADVISORY): wouldCertify=${lintReport.wouldCertify} · red-goes-red=${lintReport.redBaseline.goesRed} · all-anti-killed=${lintReport.allKilled}${lintReport.requirements.some((r) => r.bleedFailures.length) ? ' · BLEED detected' : ''}${lintReport.brittle.length ? ` · ${lintReport.brittle.length} brittle check(s)` : ''}. The real certify still runs — this is a PREDICTION, never a certificate.`);
  }
  if (lintReport && o.lintShortCircuit === true && lintReport.reauthorable) {
    // OPT-IN short-circuit: the verifier PROVABLY won't certify for a claim-author-fixable reason (a
    // bleeding / non-discriminating check, or a red baseline that doesn't go red). Skip the expensive
    // certify and hand the mechanical feedback back so the SKILL can re-spawn the BLIND claim-author
    // once. This is a DOWNGRADE/retry signal, never a verdict — nothing is certified or admitted here,
    // and the real certify runs on the next pass.
    d.finish({
      decision: 'needs-reauthor', status: 'declined',
      summary: `Pre-certify lint predicts the constructed floor will NOT certify, for a claim-author-fixable reason — ${lintReport.reauthorFeedback.length} actionable finding(s). Short-circuited BEFORE the out-of-band certify; re-author the named checks and re-run.`,
      confidence: 'Advisory PREDICTION only — NOT a certificate and NOT a decline. The real certify did not run; re-author the flagged claims and the gate runs on the next pass.',
      caveats: lintReport.reauthorFeedback,
    });
    return {
      dossierUrl: d.url(dossierVaultRelDir),
      certified: false, tier: null, decision: 'needs-reauthor',
      requirements: [], certProblems: [],
      gated: [], admitted: [],
      slate: null, rankingIsAdvisory: null, decorrelated: null, selectBy: null,
      lintReport,
      dossierRev: d.state.rev,
    };
  }

  // ── M2 · certify it out-of-band ────────────────────────────────────────────────────────────
  d.startMilestone('m2');
  const asm = await adapter.assemble({ workdir: scratch, source, verifierSource: built.verifierSource, redAnswer: built.redAnswer, antiCandidates: built.antiCandidates, built });
  const cert = await certifyVerifier({
    repo: asm.repo, base: asm.base, verify: asm.verify, oracleFiles: asm.oracleFiles, protectedPaths: asm.protectedPaths,
    certificate: built.certificate, redCandidateDir: asm.redCandidateDir, antiCandidates: asm.antiCandidateDirs,
    expectedRedCheckIds: asm.expectedRedCheckIds, answerAuthor, attempts, perStepTimeoutMs,
  });
  const certified = cert.certified === true;
  const verifiedTier = certified ? (cert.tier || VERIFIED_TIER) : null;
  d.discovery(certified
    ? `Verifier CERTIFIED (tier ${verifiedTier}): red baseline goes red and every requirement's anti-candidate is killed. The floor discriminates — answers may now earn ${verifiedTier}.`
    : `Verifier NOT certified${cert.problems && cert.problems.length ? `: ${cert.problems.join('; ')}` : ''}. The constructed floor is untrustworthy — NO answer can be VERIFIED; the run degrades to an ADVISORY slate (honesty floor: never a false green).`);
  d.finishMilestone('m2', certified ? 'done' : 'failed');

  // ── M3 · gate every oracle-blind answer against the certified floor ────────────────────────
  d.startMilestone('m3');
  const gated = [];
  for (const a of answers) {
    const cid = d.addCandidate({ id: a.id, angle: a.angle || '', verdict: 'pending' });
    // AR finding 2 — a candidate authored by the claim-author or adversary is NOT a third decorrelated
    // step; certify only checked the GLOBAL author, so re-check THIS candidate's resolved author here.
    const candAuthor = resolveAnswerAuthor(a, answerAuthor);
    const decorrelated = authorIsDecorrelated(candAuthor, claimAuthor, adversary);
    const dir = asm.makeAnswerCandidate(String(a.content));
    const { files } = candidateFiles(dir, asm.base);
    const res = await gateRunner({
      repoDir: asm.repo, baseRef: asm.base, candidate: { id: a.id, files }, verify: asm.verify,
      protectedPaths: asm.protectedPaths, oracleFiles: asm.oracleFiles, attempts,
      ...(perStepTimeoutMs ? { perStepTimeoutMs } : {}),
      worktreeRoot: mkdtempSync(path.join(tmpdir(), `gc-${label}-w-`)), evidenceDir: mkdtempSync(path.join(tmpdir(), `gc-${label}-e-`)),
    });
    const outcome = classifyGate({ certified, decorrelated, gate: res.gate, perTest: res.perTest });
    const admitted = outcome === 'admitted';
    // AR finding 3 — failedChecks is only meaningful for a DECISIVE pruned gate; an incomplete/no-map
    // gate has no per-check evidence, so it stays empty AND the candidate is 'inconclusive', not 'failed'.
    const failedChecks = (outcome === 'failed' && res.perTest)
      ? Object.entries(res.perTest).filter(([, v]) => v !== 'pass').map(([k]) => k) : [];
    // AR finding 1 — the gate-result tier is derived PURELY from the gate, never from inbound a.tier.
    // Only an admitted candidate earns the verified tier; everything else is advisory-slate.
    const tier = admitted ? verifiedTier : 'advisory-slate';
    const detail = outcome === 'admitted' ? `gate green — earns ${verifiedTier}`
      : outcome === 'failed' ? `gate ${res.gate} — failed: ${failedChecks.join(', ') || 'n/a'}`
        : !certified ? 'verifier not certified — advisory only'
          : !decorrelated ? `author ${JSON.stringify(candAuthor)} collides with a construction role — NOT decorrelated, cannot be verified`
            : `gate ${res.gate} — INCONCLUSIVE (no decisive check evidence)`;
    gated.push({ id: a.id, content: a.content, angle: a.angle || '', tier, answerAuthor: candAuthor, decorrelated, outcome, admitted, gate: res.gate, failStep: res.failStep || null, perTest: res.perTest, failedChecks });
    d.updateCandidate(cid, {
      verdict: outcome === 'admitted' ? 'green' : outcome === 'failed' ? 'rejected' : 'pending',
      detail,
      evidence: { gate: res.gate, failStep: res.failStep, perTest: res.perTest, outcome },
      metrics: { admitted, decorrelated, failedChecks: failedChecks.length },
    });
  }
  const admittedAnswers = gated.filter((g) => g.outcome === 'admitted');
  const failedAnswers = gated.filter((g) => g.outcome === 'failed');
  d.discovery(`Gate: ${admittedAnswers.length}/${gated.length} answer(s) ${certified ? `VERIFIED (${verifiedTier})` : 'advisory'} — ${gated.map((g) => `${g.id}:${g.outcome === 'admitted' ? 'ADMITTED' : g.outcome === 'failed' ? 'FAILED' : 'inconclusive'}`).join('  ')}.`);
  d.finishMilestone('m3', 'done');

  // ── M4 · slate ─────────────────────────────────────────────────────────────────────────────
  d.startMilestone('m4');
  const judgeFn = judgeFnFromVerdicts(verdicts);
  let slate = null;
  let decision;
  // Single-best result fields (null/empty in slate + decline modes). pick/slate are MUTUALLY EXCLUSIVE.
  let pick = null;
  let pickBy = null;                 // 'objective-proxy' | 'tie-break' | 'sole-candidate' | null
  let dispersionMeasurable = null;   // boolean | null (null = no competition: sole candidate / not single-best)
  let dispersionState = null;        // 'unmeasurable' | 'converged' | 'diverse' | null (piece D)
  let unmeasurableReason = null;     // 'no-probes' | 'no-runner' | null — why dispersion couldn't be measured
  let flags = [];
  // Set TRUE by a normal branch the instant it begins finalizing the dossier (right before its
  // finishMilestone/finish). Lets the abort-catch tell a STRUCTURAL selection error (flag still false ⇒ write
  // a setup-error) from a dossier-WRITE failure during a normal finish (flag already true ⇒ don't relabel it).
  let m4Finalizing = false;

  // Guard the whole M4 dispatch: a STRUCTURAL setup error thrown mid-selection (a duplicate/blank candidate
  // id, a malformed proxy or discriminating-probe declaration, or a probe runner that returns a malformed map)
  // must NOT leave the LIVE dossier hung in an active M4 state. On such a throw, finish the page as a declined
  // setup-error (nothing was verified or shipped) and rethrow so the caller still sees it. The normal branches
  // each finish the dossier themselves, so this catch fires ONLY on an abort. (Body kept at this indent level
  // to avoid a large mechanical re-indent of the dispatch.)
  try {
  if (certified && admittedAnswers.length > 0 && wantSlate) {
    // OPT-IN SLATE (--slate) — DIVERSITY mode. buildSlate over the admitted set (each earns the real
    // tier); the decorrelated judge ranks them into an ADVISORY order; a HUMAN picks. Unchanged from the
    // original verified path. Reserved for the case where a QUALITY residue beyond correctness differs.
    const built2 = await buildSlate({ candidates: admittedAnswers, proxies, judgeFn, judgeProvenance, answerAuthor, tier: verifiedTier });
    slate = built2;
    decision = 'shipped-slate';
    m4Finalizing = true;
    d.finishMilestone('m4', 'done');
    d.finish({
      decision, tier: verifiedTier,
      summary: `${admittedAnswers.length}/${gated.length} answer(s) VERIFIED (${verifiedTier}); advisory ranked slate for human selection — ${slate.slate.map((s) => `${s.id} #${s.advisoryRank}`).join(', ')}.`,
      confidence: `Candidates: ${verifiedTier} (verified out-of-band against a CERTIFIED floor). Ranking: ADVISORY (${slate.decorrelated ? 'decorrelated' : 'NOT-decorrelated — trust even less'} judge) — a HUMAN selects.`,
      slate: slate.slate.map((s) => ({ id: s.id, note: `advisory #${s.advisoryRank} — VERIFIED ${s.tier}` })),
      caveats: [
        'Ranking is ADVISORY — surfaced for human selection, never auto-shipped as best.',
        `Verifier residual (NOT checked): ${built.certificate.residual}`,
      ],
    });
  } else if (certified && admittedAnswers.length > 0) {
    // DEFAULT — SINGLE-BEST. Ship ONE verified-correct answer. Correctness is binary and SETTLED by the
    // certified gate, so this is NOT an "advisory, you pick" output; the choice AMONG equally-verified
    // candidates is made by the OBJECTIVE PROXY (rankByProxies — deterministic, NO model), tie-broken to a
    // deterministic id. The advisory judge (judgeFn/verdicts) is DELIBERATELY never consulted here — a
    // model's quality opinion can never auto-ship "the best" (the core invariant).
    const n = admittedAnswers.length;

    // STRUCTURAL validation FIRST — BEFORE any degrade. A duplicate/blank admitted id, or a MALFORMED proxy
    // declaration (bad name/of/prefer), is a SETUP error and must SURFACE as a throw — exactly as slate mode
    // (buildSlate→rankByProxies) does — never be laundered into a fabricated, input-order-dependent tie-break
    // (AR HIGH, confirmed: the degrade branches built fallback rows directly, bypassing the uniqueness check).
    // `allowEmpty:true` because "no proxy declared" is NOT a malformation — it legitimately degrades below.
    validateCandidateIds(admittedAnswers, 'orchestrateObjective(single-best)');
    validateProxyDecls(proxies, 'orchestrateObjective(single-best)', { allowEmpty: true });

    // Evaluate each proxy AT MOST ONCE per candidate: memoize `p.of` by candidate id (ids validated unique
    // above), then drive BOTH the non-finite pre-check AND rankByProxies from the SAME memoized proxies. A
    // stateful/impure proxy therefore cannot return finite during the pre-check and NaN during the rank
    // (which would throw instead of degrade, or rank on values that were never checked) — AR MED. For the
    // declared-pure default proxies this is purely a single-evaluation optimisation.
    const memoProxies = proxies.map((p) => {
      const cache = new Map();
      return { ...p, of: (c) => { if (!cache.has(c.id)) cache.set(c.id, p.of(c)); return cache.get(c.id); } };
    });

    // Tier-B objective ranking. DEGRADE-NOT-CRASH now applies ONLY to the intended runtime cases (ids +
    // proxy declarations already validated above): NO proxy declared, or a well-formed proxy that yields a
    // NON-FINITE VALUE for some candidate (a measurement gap). Both fall back to a pure id tie-break.
    let proxyRanked; let proxyDegraded = false; let proxyError = '';
    const nonFinite = [];
    for (const p of memoProxies) {
      for (const a of admittedAnswers) {
        if (!Number.isFinite(Number(p.of(a)))) nonFinite.push(`${p.name}→${a.id}`);
      }
    }
    if (memoProxies.length === 0) {
      proxyDegraded = true; proxyError = 'no objective proxy declared';
      proxyRanked = admittedAnswers.map((a) => ({ id: a.id, proxyRank: 1, meanRank: 1, proxyScores: {} }));
    } else if (nonFinite.length) {
      proxyDegraded = true; proxyError = `proxy produced a non-finite value (${nonFinite.join(', ')})`;
      proxyRanked = admittedAnswers.map((a) => ({ id: a.id, proxyRank: 1, meanRank: 1, proxyScores: {} }));
    } else {
      proxyRanked = rankByProxies(admittedAnswers, memoProxies);   // SAME memoized values as the pre-check; structural throw → propagate
    }
    const proxyNames = proxies.map((p) => p.name).join(', ') || '(none declared)';

    // tiedTop = candidates sharing the BEST aggregate proxy standing (meanRank — the pre-dense aggregate;
    // EQUAL meanRank ⇔ objectively equivalent). NOT the dense `proxyRank`, which breaks ties by input index
    // and would mis-flag a genuine top-tie as discriminated. proxyDiscriminated ⇔ a UNIQUE top.
    const bestMean = proxyRanked.reduce((m, p) => Math.min(m, p.meanRank), Infinity);
    const tiedTop = proxyRanked.filter((p) => Math.abs(p.meanRank - bestMean) < 1e-9);
    const pickRow = [...tiedTop].sort((a, b) => a.id.localeCompare(b.id))[0];   // deterministic, order-independent
    const pickAnswer = admittedAnswers.find((a) => a.id === pickRow.id);

    // ── DISCRIMINATING PROBES (piece D) — measure behavioural diversity the acceptance floor structurally
    // CAN'T. Admitted answers pass EVERY floor check ⇒ all-pass signatures ⇒ a monoculture the gate can't
    // tell apart. HELD-OUT probes (claim-shaped, NOT in the acceptance set) are run MEASUREMENT-ONLY over the
    // admitted set to surface real diversity. HARD INVARIANT: probes never enter classifyGate/admission and
    // never change the pick/order (the pick above is already fixed) — they ONLY label dispersion. They are
    // validated DISJOINT from the acceptance check ids so a probe can't masquerade as a gate check; absent a
    // probe set (or a runner, e.g. HTML) the dispersion stays UNMEASURABLE exactly as before.
    // Acceptance ids = the UNION of claims + checks (AR LOW: `built.claims || built.checks` would, for an
    // adapter that returns an empty `claims:[]` alongside real `checks`, pick the empty array and let a probe
    // collide with a real check id — `[]` is truthy).
    const acceptanceIds = new Set([...(built.claims || []), ...(built.checks || [])].map((c) => c.id));
    const probes = Array.isArray(o.discriminatingProbes) ? o.discriminatingProbes : [];
    let disp = null; let probesRun = false;
    if (n > 1 && probes.length && typeof adapter.runProbes === 'function') {
      const seenProbeIds = new Set();
      for (const p of probes) {
        if (!p || typeof p.id !== 'string' || p.id.trim() === '') throw new Error('discriminatingProbes: every probe needs a non-empty string id');
        if (seenProbeIds.has(p.id)) throw new Error(`discriminatingProbes: duplicate probe id ${JSON.stringify(p.id)}`);
        seenProbeIds.add(p.id);
        if (acceptanceIds.has(p.id)) throw new Error(`discriminatingProbes: probe id ${JSON.stringify(p.id)} collides with an acceptance check id — probes must be HELD-OUT (measurement-only), never a gate check.`);
      }
      const probeIds = probes.map((p) => p.id);
      const perCand = await adapter.runProbes(admittedAnswers, probes, { source });   // [{ id, perProbe:{probeId:'pass'|'fail'} }]
      // AR MED — validate the runner's output shape (exactly one row per admitted id; every probe a pass/fail)
      // so a buggy/adversarial runner THROWS instead of silently mis-measuring the dispersion label.
      const byId = validateProbeRows(perCand, admittedAnswers.map((a) => a.id), probeIds);
      disp = dispersion(admittedAnswers.map((a) => ({ id: a.id, signature: signatureFromResults(byId.get(a.id), probeIds) })), { targetK });
      probesRun = true;
    }
    // Three honest states (n>1): UNMEASURABLE (no probes — the floor can't discriminate, add some) ·
    // CONVERGED (probes ran, admits identical ON THEM — no measured diversity on the supplied probes) · DIVERSE (probes ran,
    // admits differ — genuinely different correct answers ⇒ consider --slate). n===1 ⇒ nothing to disperse.
    if (n === 1) { dispersionMeasurable = null; dispersionState = null; }
    else if (!probesRun) {
      dispersionMeasurable = false; dispersionState = 'unmeasurable';
      // WHY unmeasurable: probes supplied but the domain has no runner (e.g. HTML) ⇒ 'no-runner' (adding more
      // probes won't help); else simply none supplied ⇒ 'no-probes'. Drives an honest, actionable caveat (AR).
      unmeasurableReason = (probes.length && typeof adapter.runProbes !== 'function') ? 'no-runner' : 'no-probes';
    }
    else { dispersionMeasurable = true; dispersionState = disp.discriminating ? 'diverse' : 'converged'; }

    // Honest basis labelling. The word "best" never appears as a quality claim; the proxy is NAMED so the
    // claim is exactly the measurement, not a verdict. The `confidence` is BRANCH-SPECIFIC: only the
    // discriminating case may state the proxy chose the answer — a tie-break/degraded ship must say so
    // plainly (AR MED), never reintroduce an unearned proxy-quality claim.
    const VERIFIED_PREFIX = 'Correctness is VERIFIED out-of-band against a CERTIFIED floor — binary and settled by the gate.';
    const caveats = [`Verifier residual (NOT checked): ${built.certificate.residual}`];
    let summary; let confidence;
    if (n === 1) {
      pickBy = 'sole-candidate'; decision = 'shipped-single'; flags.push('single-admitted');
      summary = `Shipped ${pickRow.id}: the sole VERIFIED (${verifiedTier}) candidate cleared the certified floor.`;
      confidence = `${VERIFIED_PREFIX} Only one candidate cleared the floor, so no selection among alternatives was made; it is shipped directly.`;
    } else if (proxyDegraded || tiedTop.length > 1) {
      pickBy = 'tie-break'; decision = 'shipped-single-tiebroken';
      flags.push(proxyDegraded ? 'proxy-unmeasurable' : 'proxy-non-discriminating');
      summary = `Shipped ${pickRow.id}: ${proxyDegraded ? 'the objective proxy could not be measured' : `${tiedTop.length} of ${n} verified-correct candidates are objectively equivalent under the declared proxy(ies)`} — selected by deterministic id tie-break, NOT by measured superiority.`;
      confidence = `${VERIFIED_PREFIX} The objective proxy did NOT yield a unique winner among these equally-correct candidates, so the shipped answer was chosen by a DETERMINISTIC id tie-break — NOT measured superiority and NOT a model judgement. Re-run with --slate to compare all ${n}.`;
      caveats.push(proxyDegraded
        ? `Objective proxy unmeasurable (${proxyError}); shipped ${pickRow.id} by deterministic id tie-break, NOT by measured superiority. Re-run with --slate to compare all ${n}.`
        : `${tiedTop.length} verified-correct candidate(s) are objectively equivalent under the declared proxy(ies) (${proxyNames}); shipped ${pickRow.id} by deterministic id tie-break, NOT by measured superiority — they may differ on quality the machine cannot measure. Re-run with --slate to compare all ${n}.`);
    } else {
      pickBy = 'objective-proxy'; decision = 'shipped-single';
      summary = `Shipped ${pickRow.id}: 1 of ${n}/${gated.length} VERIFIED (${verifiedTier}); selected among equally-VERIFIED candidates by objective proxy (ranks first on ${proxyNames}).`;
      confidence = `${VERIFIED_PREFIX} The choice among equally-correct candidates is a DETERMINISTIC objective proxy, NOT a model judgement; correctness (not quality) is what is settled, so this single answer is shipped directly rather than offered as a ranked slate.`;
    }
    // Dispersion caveat — only when there WAS a competition (n>1). Phrased pickBy-AGNOSTICALLY (AR LOW): the
    // honest output is a single shipped answer, never asserted as "by-proxy" (the pick may have been a tie-break).
    if (dispersionState === 'unmeasurable') {
      flags.push('dispersion-unmeasurable');
      caveats.push(unmeasurableReason === 'no-runner'
        ? 'Dispersion UNMEASURABLE — discriminating probes were supplied but this domain has no probe runner (e.g. HTML needs a real browser snapshot), so behavioural diversity could not be measured. A single verified answer is the honest default output.'
        : 'Dispersion UNMEASURABLE — the acceptance floor does not discriminate among the verified candidates (all-pass monoculture); add discriminating probes to measure diversity. This unmeasurability is itself why a single verified answer (not a ranked slate) is the honest default output.');
    } else if (dispersionState === 'converged') {
      flags.push('behaviourally-converged');
      // AR MED — claim ONLY what the probes measured: identical-on-the-supplied-probes, NOT broad equivalence
      // (two answers identical on these probes may still differ on a property no probe tested).
      caveats.push(`Behaviourally CONVERGED on the supplied probes — the ${n} verified candidates pass/fail all ${probes.length} held-out discriminating probe(s) IDENTICALLY (effective-N ${disp.effectiveN.toFixed(2)}); NO measured diversity on the supplied probes, though they may still differ on properties no probe tested.`);
    } else if (dispersionState === 'diverse') {
      flags.push('behaviourally-diverse');
      caveats.push(`Behaviourally DIVERSE — the ${n} verified candidates DIFFER on the held-out discriminating probes (effective-N ${disp.effectiveN.toFixed(2)} of ${n}); they are genuinely different correct approaches that may differ on quality the gate cannot judge. Re-run with --slate to compare them.`);
    }

    pick = { id: pickRow.id, tier: verifiedTier, proxyRank: pickRow.proxyRank, proxyScores: pickRow.proxyScores || {}, angle: (pickAnswer && pickAnswer.angle) || '' };
    m4Finalizing = true;
    d.finishMilestone('m4', 'done');
    d.finish({ decision, tier: verifiedTier, summary, confidence, caveats });
  } else if (certified && failedAnswers.length > 0) {
    // CERTIFIED FLOOR, ZERO PASSES, ≥1 DECISIVE failure — honest decline. bestFailing comes ONLY from
    // genuinely-failed candidates (AR finding 3): an inconclusive gate did not "almost pass".
    const bestFailing = pickBestFailing(failedAnswers);
    decision = 'no-verified';
    m4Finalizing = true;
    d.finishMilestone('m4', 'skipped');
    d.finish({
      decision, status: 'declined', tier: verifiedTier,
      summary: `0/${gated.length} answers passed the CERTIFIED floor — honest decline (no verified answer). Closest genuine failure: ${bestFailing.id} (failed ${bestFailing.failedChecks.length} check(s): ${bestFailing.failedChecks.join(', ') || 'n/a'}).`,
      confidence: 'No false green: the floor discriminated and no candidate cleared it. Human gate required.',
      bestFailing,
      caveats: ['The verifier IS certified, so this decline is trustworthy — the answers genuinely did not meet the requirements, or the answer fan-out was too narrow. Widen the cohort or sharpen the requirements.'],
    });
  } else if (certified) {
    // CERTIFIED FLOOR, ZERO PASSES, ZERO DECISIVE FAILURES — every non-admitted candidate is
    // INCONCLUSIVE (incomplete gates, or author collisions). The gate produced NO decisive verdict, so
    // this is a BLOCKED setup, NOT an honest "the answers were wrong" (AR finding 3). Do not fabricate
    // a near-miss.
    decision = 'blocked';
    m4Finalizing = true;
    d.finishMilestone('m4', 'failed');
    d.finish({
      decision, status: 'declined', tier: verifiedTier,
      summary: `0/${gated.length} answers VERIFIED and NONE produced a decisive check failure — every candidate was inconclusive (incomplete gate or author-not-decorrelated). The gate gave no verdict: this is a BLOCKED run, not a decline.`,
      confidence: 'No false green AND no false decline: the gate produced no decisive evidence for any candidate. Fix the gate setup / answer-author decorrelation and re-run.',
      caveats: [
        'No candidate was either verified or decisively failed — do NOT read this as "the answers were wrong".',
        ...gated.filter((g) => !g.decorrelated).map((g) => `${g.id}: author ${JSON.stringify(g.answerAuthor)} collides with a construction role (claim-author/adversary) — re-author from an independent agent.`),
      ],
    });
  } else {
    // UNCERTIFIED FLOOR — advisory-only over ALL answers; nothing is verified.
    slate = await advisoryOnlySlate({ candidates: gated, judgeFn, judgeProvenance, answerAuthor });
    decision = 'advisory-only';
    m4Finalizing = true;
    d.finishMilestone('m4', 'done');
    d.finish({
      decision, tier: 'advisory-slate',
      summary: `Verifier NOT certified — NO answer verified. Advisory-only order over all ${gated.length} answer(s): ${slate.slate.map((s) => `${s.id} #${s.advisoryRank}`).join(', ')}.`,
      confidence: 'ADVISORY ONLY — the constructed floor failed certification, so there is no correctness guarantee. A HUMAN selects.',
      slate: slate.slate.map((s) => ({ id: s.id, note: `advisory #${s.advisoryRank} — UNVERIFIED (verifier not certified)` })),
      caveats: [
        'The constructed verifier failed certification — its checks are untrustworthy. Reconstruct from a cleaner decorrelated source before trusting any gate result.',
        ...((cert.problems && cert.problems.length) ? [`Certification problems: ${cert.problems.join('; ')}`] : []),
      ],
    });
  }
  } catch (abortErr) {
    // A branch above threw a STRUCTURAL setup error before finishing — make the live dossier honest (declined
    // setup-error, nothing verified or shipped), then rethrow so the caller sees the ORIGINAL error. Two guards:
    //   (AR 1b) only finish if NO normal branch had begun finalizing. `m4Finalizing` is set the instant a
    //     branch starts its finishMilestone/finish, so a dossier-WRITE failure DURING a normal finish (which
    //     throws before/while setting state.outcome) is NOT relabeled as a structural setup-error.
    //   (AR 1c / new low) the cleanup is BEST-EFFORT (its own throw is swallowed) and abortErr is ALWAYS
    //     rethrown, so a dossier-write failure can never mask the original structural error.
    if (!m4Finalizing) {
      try {
        d.finishMilestone('m4', 'failed');
        d.finish({
          decision: 'setup-error', status: 'declined', tier: verifiedTier,
          // Context is conditional on `certified` (AR LOW): an abort on the UNCERTIFIED (advisory-only) path
          // must NOT claim the floor certified.
          summary: `Run ABORTED on a structural setup error during selection (${certified ? `after the floor certified and ${admittedAnswers.length} answer(s) were admitted` : 'after the floor FAILED certification — no answer was eligible for verification'}): ${abortErr && abortErr.message ? abortErr.message : String(abortErr)}`,
          confidence: 'No verified result was produced and nothing was shipped — a setup/configuration error (a duplicate candidate id, or a malformed proxy or discriminating probe) aborted the run before a selection. Fix the named input and re-run.',
          caveats: ['This is NOT a correctness decline — the answers were not judged; the run could not complete its selection step.'],
        });
      } catch { /* best-effort dossier finish — never let a dossier-write failure mask the original error */ }
    }
    throw abortErr;
  }

  return {
    dossierUrl: d.url(dossierVaultRelDir),
    certified, tier: verifiedTier, decision,
    requirements: cert.requirements, certProblems: cert.problems || [],
    gated: gated.map((g) => ({ id: g.id, outcome: g.outcome, admitted: g.admitted, gate: g.gate, tier: g.tier, decorrelated: g.decorrelated, failedChecks: g.failedChecks })),
    admitted: admittedAnswers.map((a) => a.id),
    // SINGLE-BEST (default): `pick` is the shipped answer + `pickBy` its selection basis; `slate` is null.
    // SLATE (--slate) / advisory-only: `slate` is the ordered set; `pick` is null. They are mutually exclusive.
    pick,
    pickBy,
    slateMode: wantSlate,
    dispersionMeasurable,
    dispersionState,
    unmeasurableReason,
    flags,
    slate: slate ? slate.slate : null,
    rankingIsAdvisory: slate ? slate.rankingIsAdvisory : null,
    decorrelated: slate ? slate.decorrelated : null,
    selectBy: slate ? slate.selectBy : null,
    lintReport: lintReport || null,
    dossierRev: d.state.rev,
  };
}
