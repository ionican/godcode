// slate — the godcode RANKED SLATE (G4). The "gold dust" piece: rank the VERIFIED-admissible
// candidates and present them FOR HUMAN SELECTION.
//
// THE HONESTY SPINE (the whole point — every export below holds it):
//   - The candidates are VERIFIED: they passed the constructed floor and carry a real PER-CANDIDATE
//     `tier` (one of {repo-verified, constructed-floor-pass, factual-evidence-pass}). That tier is
//     EARNED and TRUE — and EARNED INDIVIDUALLY: buildSlate validates EACH candidate's own tier and
//     refuses to stamp a verification a candidate did not earn (no global tier laundered onto a mixed
//     or uncertified set; 'advisory-slate'/'proxy-ranked' are NOT verified).
//   - The RANKING is ADVISORY: model-judged quality is untrustworthy — the project's core invariant.
//     A same-model judge shares the answer-authors' blind spots, so a ranking it produces cannot be
//     treated as authoritative. The slate is therefore surfaced for a HUMAN to pick, NEVER
//     auto-shipped as "the best."
//   - The judge must be DECORRELATED from EVERY answer-author (cross-model in production; a
//     deterministic fake in tests). If it isn't — judgeProvenance absent, or equal to ANY one of the
//     candidates' answer-authors — the ranking is FLAGGED weaker (decorrelated:false + a reason) so
//     the caller knows to trust it even less.
//   - A throwing/junk judge does NOT abort the slate: each pair is judged in isolation, a throw or a
//     junk verdict becomes a TIE and is counted (judgeErrors/invalidVerdicts). If EVERY pair gave no
//     signal, the order is labelled a PROXY-ONLY FALLBACK, never "judge-ranked".
//
// Two tiers of ranking signal, declared upfront, combined honestly:
//   - TIER B  rankByProxies — OBJECTIVE, deterministic, no model. Pre-declared per-task proxies
//             (LOC / cyclomatic / perf for code). STRONG for code, WEAK for prose (no objective
//             quality measure). Here it TIE-BREAKS; it does NOT decide quality.
//   - TIER C  advisoryRank — ADVISORY pairwise judging by a DECORRELATED judge. PRIMARY order, but
//             explicitly advisory.
//
// HARD INVARIANT: buildSlate NEVER returns a single authoritative winner/best — only an ORDERED
// `slate` labelled rankingIsAdvisory:true + selectBy:'human'. The candidates' VERIFIED tier is real;
// the ORDER is advisory. This module makes NO claim about which candidate is correct.
//
// All of this is deterministic given a deterministic judgeFn — no LLM calls live in this file; the
// (decorrelated) judge is INJECTED, exactly as construct-prose-verifier injects claimFn/adversaryFn.

const PREFER = new Set(['higher', 'lower']);

// The VERIFIED tier set — the tiers a candidate can have EARNED at the constructed floor (mirrors
// certify.mjs's TIER_CEILINGS). A candidate may only carry one of these. 'advisory-slate' and
// 'proxy-ranked' are explicitly NOT verified: they are demotion/ordering labels, not a passed floor,
// so buildSlate must REFUSE to stamp them as a candidate's verified tier (AR finding 1).
const VERIFIED_TIERS = new Set(['repo-verified', 'constructed-floor-pass', 'factual-evidence-pass']);

// Reject duplicate candidate ids — id-keyed Maps downstream (proxyById / advById / inputIndex)
// collapse rows on a collision, silently corrupting the ranking joins (AR finding 2). Call AFTER
// the per-candidate id-shape validation so every id is a non-empty string here.
export function assertUniqueIds(candidates, fnName) {
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c.id)) {
      throw new Error(`${fnName}: duplicate candidate id ${JSON.stringify(c.id)} — candidate ids must be unique (id-keyed ranking joins collapse on a collision)`);
    }
    seen.add(c.id);
  }
}

// Candidate id-shape + uniqueness validation (extracted so callers OTHER than rankByProxies — e.g. the
// single-best picker in orchestrate.mjs — can run the SAME structural check before building any hand-rolled
// fallback ranking. A duplicate/blank id is a STRUCTURAL error that must THROW, never be laundered into a
// non-deterministic pick — orchestrate #3 AR HIGH.) Single source of truth for the id contract.
export function validateCandidateIds(candidates, fnName) {
  if (!Array.isArray(candidates)) throw new Error(`${fnName}: candidates must be an array`);
  candidates.forEach((c, i) => {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || c.id.trim() === '') {
      throw new Error(`${fnName}: candidate #${i} must have a non-empty string id, got: ${JSON.stringify(c)}`);
    }
  });
  assertUniqueIds(candidates, fnName);
}

// Proxy-DECLARATION shape validation (name/of/prefer). `allowEmpty` lets a caller that legitimately treats
// "no proxy declared" as a degrade-to-tie-break (not an error) skip ONLY the non-empty-array requirement,
// while still rejecting a MALFORMED declaration (bad name/of/prefer) as the structural error it is.
export function validateProxyDecls(proxies, fnName, { allowEmpty = false } = {}) {
  if (!Array.isArray(proxies) || (!allowEmpty && proxies.length === 0)) {
    throw new Error(`${fnName}: proxies must be a non-empty array (PRE-DECLARED per task — never a generic global bundle)`);
  }
  proxies.forEach((p, i) => {
    if (!p || typeof p !== 'object') throw new Error(`${fnName}: proxy #${i} must be an object`);
    if (typeof p.name !== 'string' || p.name.trim() === '') throw new Error(`${fnName}: proxy #${i} must have a non-empty name`);
    if (typeof p.of !== 'function') throw new Error(`${fnName}: proxy ${JSON.stringify(p.name)} must have an of:(candidate)=>number function`);
    if (!PREFER.has(p.prefer)) throw new Error(`${fnName}: proxy ${JSON.stringify(p.name)} prefer must be 'higher' or 'lower', got ${JSON.stringify(p.prefer)}`);
  });
}

// Stable dense 1-based ranking from a numeric key, lower-is-better, ties broken by original index.
// Returns an array parallel to `entries` carrying each entry's 1-based rank. Items with equal key get
// CONSECUTIVE ranks in input order (a stable, deterministic ordering — not a competition rank with
// gaps), so the rank doubles as a deterministic ordinal. Used for the AGGREGATE display ordinal,
// where a deterministic 1..N ordinal is wanted.
function denseRankAscending(entries, keyOf) {
  const order = entries
    .map((e, i) => ({ i, key: keyOf(e) }))
    .sort((a, b) => (a.key - b.key) || (a.i - b.i));   // stable: tie → original index
  const rank = new Array(entries.length);
  order.forEach((o, pos) => { rank[o.i] = pos + 1; });
  return rank;
}

// COMPETITION (standard "1224") 1-based ranking from a numeric key, lower-is-better. EQUAL keys get
// the EQUAL rank; the next distinct key skips ahead by the size of the tie group. Unlike
// denseRankAscending, input order does NOT shift the rank of tied items — so a NON-DISCRIMINATING
// proxy (all-equal) contributes the SAME rank to every candidate and cannot move the aggregate by
// input order (AR finding 6). Input index is used only as the deterministic sort key, never to break
// the rank VALUE.
function competitionRankAscending(entries, keyOf) {
  const order = entries
    .map((e, i) => ({ i, key: keyOf(e) }))
    .sort((a, b) => (a.key - b.key) || (a.i - b.i));   // stable order for determinism
  const rank = new Array(entries.length);
  let lastKey;
  let lastRank = 0;
  order.forEach((o, pos) => {
    if (pos === 0 || o.key !== lastKey) { lastRank = pos + 1; lastKey = o.key; }
    rank[o.i] = lastRank;   // equal key → equal (competition) rank
  });
  return rank;
}

/**
 * TIER B — rank VERIFIED candidates by PRE-DECLARED objective proxies (deterministic, no model).
 *
 * Proxies are declared UPFRONT, per task (AR finding 7: per-domain, never a generic global bundle).
 * Objective proxies are STRONG for code (LOC / cyclomatic / perf) and WEAK for prose (there is no
 * objective quality measure) — so in the slate they TIE-BREAK, they do not decide quality.
 *
 * Aggregate = MEAN NORMALIZED RANK across the proxies: for each proxy, rank candidates best→worst
 * (respecting prefer), then average each candidate's per-proxy rank. Lower mean rank = better. Ties
 * in the aggregate are broken by ORIGINAL INPUT INDEX (stable, deterministic).
 *
 * @param {{id:string}[]} candidates
 * @param {{name:string, of:(c:object)=>number, prefer:'higher'|'lower'}[]} proxies  PRE-DECLARED.
 * @returns {{id:string, proxyScores:Record<string,number>, proxyRank:number, meanRank:number}[]}  sorted
 *          best→worst. `proxyRank` = dense 1..N display ordinal (never ties); `meanRank` = the underlying
 *          aggregate (EQUAL meanRank ⇔ objectively equivalent — test THIS, not proxyRank, for a unique winner).
 * @throws on malformed candidates/proxies.
 */
export function rankByProxies(candidates, proxies) {
  validateCandidateIds(candidates, 'rankByProxies');   // array + non-empty string ids + uniqueness (AR finding 2).
  validateProxyDecls(proxies, 'rankByProxies');        // non-empty array + per-proxy name/of/prefer shape.

  // Raw per-proxy values (recorded for transparency) + per-proxy 1-based rank (best→worst).
  const proxyScores = candidates.map(() => ({}));
  const perProxyRank = candidates.map(() => []);   // parallel: candidate index -> [rank per proxy]
  for (const p of proxies) {
    const vals = candidates.map((c) => {
      const v = Number(p.of(c));
      if (!Number.isFinite(v)) {
        throw new Error(`rankByProxies: proxy ${JSON.stringify(p.name)} produced a non-finite value for candidate ${JSON.stringify(c.id)}`);
      }
      return v;
    });
    candidates.forEach((c, i) => { proxyScores[i][p.name] = vals[i]; });
    // prefer:'higher' → rank by NEGATED value so the largest gets rank 1 (lower-is-better internally).
    // COMPETITION ranking: equal proxy values get EQUAL per-proxy rank, so a non-discriminating proxy
    // contributes identically to every candidate and cannot shift the aggregate by input order (AR
    // finding 6). Input index remains the FINAL display tie-break in the aggregate sort below.
    const keyOf = (idx) => (p.prefer === 'higher' ? -vals[idx] : vals[idx]);
    const ranks = competitionRankAscending(candidates.map((_, i) => i), keyOf);
    candidates.forEach((_, i) => { perProxyRank[i].push(ranks[i]); });
  }

  // Aggregate = mean per-proxy rank. Lower is better. Tie-break by original index.
  const meanRank = candidates.map((_, i) =>
    perProxyRank[i].reduce((s, r) => s + r, 0) / perProxyRank[i].length);
  const aggRank = denseRankAscending(candidates.map((_, i) => i), (i) => meanRank[i]);

  // `proxyRank` is a DENSE display ordinal (1..N, ties broken by input index) — never equal for two rows.
  // `meanRank` is the underlying AGGREGATE quantity it is derived from: two candidates with EQUAL meanRank
  // are objectively EQUIVALENT under the declared proxies (the competition aggregate ranks them the same).
  // It is surfaced so a caller deciding "did the proxy pick a UNIQUE winner?" tests meanRank equality, NOT
  // the dense proxyRank (which would mis-read a genuine top-tie as discriminated). Additive — does not
  // change proxyRank/proxyScores or the order.
  return candidates
    .map((c, i) => ({ id: c.id, proxyScores: proxyScores[i], proxyRank: aggRank[i], meanRank: meanRank[i], _i: i }))
    .sort((a, b) => (a.proxyRank - b.proxyRank) || (a._i - b._i))
    .map(({ _i, ...rest }) => rest);
}

// Normalize one judge verdict to { verdict:'a'|'b'|'tie', valid:boolean }. ROBUST: only exactly 'a',
// 'b', or 'tie' is a VALID verdict; anything else (junk, undefined, null) is treated as 'tie' but
// FLAGGED invalid — an unparseable judgement settles nothing (it cannot manufacture a win), and the
// invalid flag lets advisoryRank count it (AR finding 3). 'tie' itself is a valid, non-counted verdict.
function normalizeVerdict(v) {
  if (v === 'a') return { verdict: 'a', valid: true };
  if (v === 'b') return { verdict: 'b', valid: true };
  if (v === 'tie') return { verdict: 'tie', valid: true };
  return { verdict: 'tie', valid: false };
}

// Resolve the set of ANSWER-AUTHOR provenance tags to decorrelate the judge against (AR finding 4).
// The judge must be distinct from EVERY answer-author, not just one global author. Accepts, in order
// of precedence per source (all are unioned):
//   - per-candidate `candidate.answerAuthor` (most specific)
//   - `answerAuthors` array (the multi-author convenience)
//   - `answerAuthor` single string (the original convenience — applies to all)
// Returns { authors:Set<string>, anyDeclared:boolean } where anyDeclared is true iff at least one
// non-empty author tag was supplied anywhere (so we can flag "no author declared" honestly).
function collectAnswerAuthors({ candidates, answerAuthors, answerAuthor }) {
  const authors = new Set();
  let anyDeclared = false;
  const add = (v) => {
    if (typeof v === 'string' && v.trim() !== '') { authors.add(v.trim()); anyDeclared = true; }
  };
  add(answerAuthor);
  if (Array.isArray(answerAuthors)) answerAuthors.forEach(add);
  for (const c of candidates) if (c && typeof c === 'object') add(c.answerAuthor);
  return { authors, anyDeclared };
}

/**
 * TIER C — ADVISORY ranking by a DECORRELATED pairwise judge.
 *
 * For each UNORDERED pair (a,b) the INJECTED judgeFn returns 'a' | 'b' | 'tie'. Aggregate into a
 * ranking by a Bradley-Terry-ish score = wins + 0.5*ties. Sort desc; ties broken by input index.
 *
 * DECORRELATION (AR finding 4): judgeProvenance must be a non-empty string DISTINCT from EVERY
 * answer-author (collected from `answerAuthor`, `answerAuthors[]`, and per-candidate
 * `candidate.answerAuthor`). A judge sharing ANY answer author's provenance shares its blind spots,
 * so a correlated ranking is FLAGGED (decorrelated:false + reason) — the caller must treat it as
 * weaker. The ranking is STILL produced (a human can read it); decorrelation is a confidence label.
 *
 * ROBUSTNESS (AR finding 3): each per-pair judge call is wrapped — a THROW or a junk verdict is
 * treated as a TIE (settles nothing) and counted in judgeErrors / invalidVerdicts. If EVERY pair
 * errored or was invalid, the order carries no judge signal, so proxyOnlyFallback:true is set and the
 * caller must label the order a proxy-only fallback, NOT "judge-ranked".
 *
 * ADVISORY MARKER (AR finding 5): the return carries rankingIsAdvisory:true + selectBy:'human' so a
 * direct caller cannot read ranking[0] as an authoritative "winner".
 *
 * @param {object}   opts
 * @param {string}   opts.task
 * @param {{id:string, answerAuthor?:string}[]} opts.candidates
 * @param {(args:{task:string,a:object,b:object})=>('a'|'b'|'tie')|Promise<...>} opts.judgeFn  INJECTED, decorrelated.
 * @param {string}   opts.judgeProvenance  who judged (cross-model). Must differ from every answer-author.
 * @param {string}   [opts.answerAuthor]   single answer-author (convenience; applies to all candidates).
 * @param {string[]} [opts.answerAuthors]  multiple answer-authors (the judge must differ from all).
 * @returns {Promise<{ranking:{id,wins,ties,losses,advisoryScore,advisoryRank}[],
 *                    decorrelated:boolean, reason:string, judgeErrors:number, invalidVerdicts:number,
 *                    proxyOnlyFallback:boolean, rankingIsAdvisory:true, selectBy:'human'}>}
 */
export async function advisoryRank({ task, candidates, judgeFn, judgeProvenance, answerAuthor, answerAuthors }) {
  if (!Array.isArray(candidates)) throw new Error('advisoryRank: candidates must be an array');
  candidates.forEach((c, i) => {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || c.id.trim() === '') {
      throw new Error(`advisoryRank: candidate #${i} must have a non-empty string id, got: ${JSON.stringify(c)}`);
    }
  });
  assertUniqueIds(candidates, 'advisoryRank');   // AR finding 2 — id-keyed joins collapse on a dup.
  if (typeof judgeFn !== 'function') throw new Error('advisoryRank: judgeFn must be a function (the INJECTED decorrelated judge)');

  // DECORRELATION CHECK (AR finding 4) — provenance present, non-empty, and DISTINCT from EVERY
  // answer-author. A collision with ANY one author flags the ranking weaker.
  let decorrelated = true;
  let reason = 'judge provenance is distinct from every answer-author';
  const jp = typeof judgeProvenance === 'string' ? judgeProvenance.trim() : '';
  const { authors, anyDeclared } = collectAnswerAuthors({ candidates, answerAuthors, answerAuthor });
  if (jp === '') {
    decorrelated = false;
    reason = 'judgeProvenance is absent/empty — cannot attest the judge is decorrelated from the answer authors; treat the ranking as flagged/weaker';
  } else if (!anyDeclared) {
    decorrelated = false;
    reason = 'no answer-author provenance declared (answerAuthor/answerAuthors/candidate.answerAuthor all absent) — cannot attest decorrelation; treat the ranking as flagged/weaker';
  } else if (authors.has(jp)) {
    decorrelated = false;
    reason = `judgeProvenance ${JSON.stringify(jp)} matches an answer-author of the same name — a same-model judge shares that author's blind spots; the ranking is flagged/weaker`;
  }

  // Tally — wins / ties / losses per candidate over every UNORDERED pair. Each judge call is WRAPPED:
  // a throw or junk verdict becomes a TIE and is counted (AR finding 3). Determinism is preserved —
  // a deterministic judge yields a deterministic tally; the error handling only adds counters.
  const tally = candidates.map((c) => ({ id: c.id, wins: 0, ties: 0, losses: 0 }));
  let judgeErrors = 0;       // pairs where judgeFn THREW / rejected
  let invalidVerdicts = 0;   // pairs where judgeFn returned a junk (non-a/b/tie) verdict
  let pairs = 0;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      pairs++;
      let verdict = 'tie';
      try {
        const raw = await judgeFn({ task, a: candidates[i], b: candidates[j] });
        const n = normalizeVerdict(raw);
        verdict = n.verdict;
        if (!n.valid) invalidVerdicts++;   // junk → tie, counted
      } catch {
        judgeErrors++;                     // throw → tie, counted (does NOT abort the slate)
        verdict = 'tie';
      }
      if (verdict === 'a') { tally[i].wins++; tally[j].losses++; }
      else if (verdict === 'b') { tally[j].wins++; tally[i].losses++; }
      else { tally[i].ties++; tally[j].ties++; }
    }
  }

  // If EVERY pair errored or was invalid, the judge gave NO usable signal — the order is a proxy-only
  // fallback, not a judge ranking. (No pairs at all — a single candidate — is NOT a fallback: there is
  // simply nothing to judge.)
  const proxyOnlyFallback = pairs > 0 && (judgeErrors + invalidVerdicts) === pairs;

  // Bradley-Terry-ish score; sort desc, stable tie-break by input index.
  const scored = tally.map((t, i) => ({ ...t, advisoryScore: t.wins + 0.5 * t.ties, _i: i }));
  scored.sort((a, b) => (b.advisoryScore - a.advisoryScore) || (a._i - b._i));
  const ranking = scored.map(({ _i, ...rest }, pos) => ({ ...rest, advisoryRank: pos + 1 }));

  return {
    ranking,
    decorrelated,
    reason,
    judgeErrors,
    invalidVerdicts,
    proxyOnlyFallback,
    rankingIsAdvisory: true,   // AR finding 5 — machine-readable advisory marker on the standalone return.
    selectBy: 'human',
  };
}

/**
 * Build the RANKED SLATE — combine the advisory judge ranking (PRIMARY) with the objective proxies
 * (SUPPLEMENTARY / TIE-BREAK), label it advisory, and present it FOR HUMAN SELECTION.
 *
 * PRIMARY order = advisoryRank (advisoryScore desc). Proxies supplement each row and BREAK TIES in
 * the advisory score (proxyRank asc, then input index — fully deterministic).
 *
 * HARD INVARIANT: NEVER returns a single authoritative winner/best field — only the ORDERED `slate`
 * with rankingIsAdvisory:true + selectBy:'human'. The candidates' VERIFIED `tier` is real; the ORDER
 * is advisory.
 *
 * VERIFIED TIER (AR finding 1): each candidate must carry its OWN earned `candidate.tier`, validated
 * against the VERIFIED set {repo-verified, constructed-floor-pass, factual-evidence-pass}. That earned
 * tier is copied into the row. A candidate with a missing/advisory/unknown tier is REFUSED (throw) —
 * buildSlate must NEVER stamp a verification a candidate did not earn. The deprecated global `tier` is
 * kept ONLY as a per-candidate fallback default (applied where a candidate omits its own), and is
 * ITSELF validated against the VERIFIED set; per-candidate tier is PREFERRED.
 *
 * @param {object} opts
 * @param {{id:string, tier?:string, answerAuthor?:string}[]} opts.candidates  VERIFIED-admissible candidates;
 *                                         each SHOULD carry its OWN earned `tier`.
 * @param {{name,of,prefer}[]} opts.proxies  PRE-DECLARED objective proxies (tie-break).
 * @param {Function} opts.judgeFn          INJECTED decorrelated pairwise judge.
 * @param {string}   opts.judgeProvenance  who judged (must differ from EVERY answer-author).
 * @param {string}   [opts.answerAuthor]   single answer-author (convenience; applies to all).
 * @param {string[]} [opts.answerAuthors]  multiple answer-authors (judge must differ from all).
 * @param {string}   [opts.tier]           DEPRECATED global fallback default tier — applied per-candidate
 *                                         only where the candidate omits its own. Still validated as a
 *                                         VERIFIED tier. Prefer per-candidate `candidate.tier`.
 * @returns {Promise<{slate:{id,tier,advisoryRank,advisoryScore,proxyRank,proxyScores}[],
 *                    rankingIsAdvisory:true, decorrelated:boolean, selectBy:'human',
 *                    judgeErrors:number, invalidVerdicts:number, proxyOnlyFallback:boolean, note:string}>}
 */
export async function buildSlate({ candidates, proxies, judgeFn, judgeProvenance, answerAuthor, answerAuthors, tier }) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('buildSlate: candidates must be a non-empty array of VERIFIED-admissible candidates');
  }
  // Basic id shape + uniqueness up front so the per-candidate tier errors below name a real id, and
  // so a duplicate is reported with a clear top-level message (AR finding 2) before the id-keyed joins.
  candidates.forEach((c, i) => {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || c.id.trim() === '') {
      throw new Error(`buildSlate: candidate #${i} must have a non-empty string id, got: ${JSON.stringify(c)}`);
    }
  });
  assertUniqueIds(candidates, 'buildSlate');

  // The DEPRECATED global fallback default — if supplied it must ITSELF be a verified tier (a caller
  // cannot launder an advisory/unknown global tier onto tier-less candidates). undefined/absent is OK
  // (then every candidate must carry its own).
  const globalFallback = tier === undefined ? undefined
    : (typeof tier === 'string' ? tier.trim() : tier);
  if (globalFallback !== undefined && !VERIFIED_TIERS.has(globalFallback)) {
    throw new Error(`buildSlate: the global fallback tier ${JSON.stringify(tier)} is not a VERIFIED tier {${[...VERIFIED_TIERS].join(', ')}} — buildSlate refuses to stamp a non-verified tier (it is also DEPRECATED; prefer per-candidate candidate.tier).`);
  }

  // AR finding 1 — resolve + validate EACH candidate's OWN earned tier. Per-candidate tier wins; the
  // global fallback fills a gap ONLY where a candidate omits its own. The resolved tier must be a
  // VERIFIED tier — a missing/advisory/unknown tier is REFUSED, so buildSlate never misrepresents
  // verification.
  const tierById = new Map();
  candidates.forEach((c) => {
    const own = typeof c.tier === 'string' ? c.tier.trim() : (c.tier === undefined ? undefined : c.tier);
    const resolved = (own !== undefined && own !== '') ? own : globalFallback;
    if (resolved === undefined || resolved === '') {
      throw new Error(`buildSlate: candidate ${JSON.stringify(c.id)} has no earned tier and no global fallback was supplied — each candidate must carry its OWN VERIFIED tier {${[...VERIFIED_TIERS].join(', ')}}.`);
    }
    if (!VERIFIED_TIERS.has(resolved)) {
      throw new Error(`buildSlate: candidate ${JSON.stringify(c.id)} carries tier ${JSON.stringify(resolved)}, which is NOT a VERIFIED tier {${[...VERIFIED_TIERS].join(', ')}} — buildSlate refuses to stamp a verification it did not earn ('advisory-slate'/'proxy-ranked' are not verified).`);
    }
    tierById.set(c.id, resolved);
  });

  // TIER B proxies (objective, deterministic). Index by id for tie-break + per-row enrichment.
  const proxyRanked = rankByProxies(candidates, proxies);
  const proxyById = new Map(proxyRanked.map((p) => [p.id, p]));

  // TIER C advisory judge (PRIMARY order). Decorrelation + robustness flags ride through to the slate.
  const adv = await advisoryRank({ task: undefined, candidates, judgeFn, judgeProvenance, answerAuthor, answerAuthors });
  const advById = new Map(adv.ranking.map((r) => [r.id, r]));

  // Original input index per id — the final, deterministic tie-break under a TOTAL tie.
  const inputIndex = new Map(candidates.map((c, i) => [c.id, i]));

  // PRIMARY = advisoryScore desc; SUPPLEMENTARY tie-break = proxyRank asc; final = input index.
  const slate = candidates
    .map((c) => {
      const a = advById.get(c.id);
      const p = proxyById.get(c.id);
      return {
        id: c.id,
        tier: tierById.get(c.id),          // VERIFIED — each candidate's OWN earned tier (real).
        advisoryRank: a.advisoryRank,      // ADVISORY — order only.
        advisoryScore: a.advisoryScore,
        proxyRank: p.proxyRank,            // SUPPLEMENTARY tie-break.
        proxyScores: p.proxyScores,
      };
    })
    .sort((x, y) =>
      (y.advisoryScore - x.advisoryScore)                          // PRIMARY: advisory judge
      || (x.proxyRank - y.proxyRank)                               // TIE-BREAK: objective proxies
      || (inputIndex.get(x.id) - inputIndex.get(y.id)));           // FINAL: stable input order

  // The note states verification provenance honestly: candidates VERIFIED; ORDER advisory. When the
  // judge gave no usable signal (every pair errored/invalid), the ORDER is a proxy-only fallback —
  // say so explicitly (AR finding 3), NOT "judge-ranked".
  let note;
  if (adv.proxyOnlyFallback) {
    note = `Ranking is a PROXY-ONLY FALLBACK: the judge produced no usable verdict on any pair (${adv.judgeErrors} errored, ${adv.invalidVerdicts} invalid), so the ORDER is the objective proxies' tie-break, NOT a judge ranking. The candidates' VERIFIED tiers are still earned — a HUMAN selects.`;
  } else if (adv.decorrelated) {
    note = `Ranking is ADVISORY (a decorrelated judge ranked these VERIFIED candidates). The tier is earned; the ORDER is the judge's opinion — a HUMAN selects. Proxies tie-break only.`;
  } else {
    note = `Ranking is ADVISORY and FLAGGED WEAKER: ${adv.reason}. The VERIFIED tiers are still earned, but the ORDER should be trusted even less — a HUMAN selects.`;
  }
  if (!adv.proxyOnlyFallback && (adv.judgeErrors > 0 || adv.invalidVerdicts > 0)) {
    note += ` (Note: ${adv.judgeErrors} judge error(s) + ${adv.invalidVerdicts} invalid verdict(s) were treated as ties.)`;
  }

  // NOTE the deliberate ABSENCE of any winner/best/chosen/top field — see the HARD INVARIANT above.
  return {
    slate,
    rankingIsAdvisory: true,
    decorrelated: adv.decorrelated,
    selectBy: 'human',
    judgeErrors: adv.judgeErrors,
    invalidVerdicts: adv.invalidVerdicts,
    proxyOnlyFallback: adv.proxyOnlyFallback,
    note,
  };
}
