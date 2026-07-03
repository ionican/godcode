// slate.test — the RANKED SLATE (G4), proven HONEST and DETERMINISTIC.
//
// The honesty spine under test: the candidates are VERIFIED (they earned the constructed floor /
// `tier`); the RANKING is ADVISORY (model-judged quality is untrustworthy). So:
//   - rankByProxies (TIER B) is OBJECTIVE + deterministic over PRE-DECLARED proxies — it tie-breaks,
//     it does NOT decide quality.
//   - advisoryRank (TIER C) is model-judged, so the judge must be DECORRELATED from the answer
//     author; equal/absent provenance flags the ranking weaker (decorrelated:false).
//   - buildSlate NEVER returns a single authoritative winner/best — only an ORDERED slate explicitly
//     labelled rankingIsAdvisory + selectBy:'human'. The `tier` is real; the ORDER is advisory.
//
// A deterministic fake judge (prefers the longer `text`; 'tie' on equal length) stands in for the
// production decorrelated cross-model judge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankByProxies, advisoryRank, buildSlate } from './slate.mjs';

// ---------------------------------------------------------------------------------------------
// Four fake VERIFIED candidates. `text` length drives the fake judge; `loc`/`cx` drive proxies.
const CANDIDATES = [
  { id: 'a', text: 'short', loc: 30, cx: 4 },
  { id: 'b', text: 'a much much longer answer here', loc: 50, cx: 9 },
  { id: 'c', text: 'medium length answer', loc: 20, cx: 2 },
  { id: 'd', text: 'tiny', loc: 90, cx: 12 },
];

const ANSWER_AUTHOR = 'fake-answer-author';
const JUDGE_PROVENANCE = 'fake-decorrelated-judge';

// Deterministic fake judge: prefers the candidate whose `text` is longer; 'tie' on equal length.
// In production this is a DIFFERENT model from the answer author.
function fakeJudgeFn({ a, b }) {
  const la = String(a.text).length, lb = String(b.text).length;
  if (la > lb) return 'a';
  if (lb > la) return 'b';
  return 'tie';
}

// PRE-DECLARED proxies for this (fake) task: lower LOC preferred, lower cyclomatic preferred.
// (Objective proxies are STRONG for code — here both prefer:'lower'.)
const PROXIES = [
  { name: 'loc', of: (c) => c.loc, prefer: 'lower' },
  { name: 'cyclomatic', of: (c) => c.cx, prefer: 'lower' },
];

// ---------------------------------------------------------------------------------------------
// 1. rankByProxies — objective, deterministic, orders by the declared proxies incl. a prefer:'lower'.
test('rankByProxies orders by declared proxies (both prefer:lower) deterministically', () => {
  const ranked = rankByProxies(CANDIDATES, PROXIES);
  // By loc: c(20) < a(30) < b(50) < d(90); by cx: c(2) < a(4) < b(9) < d(12). Both agree → c,a,b,d.
  assert.deepEqual(ranked.map((r) => r.id), ['c', 'a', 'b', 'd']);
  // proxyRank is 1-based and dense.
  assert.deepEqual(ranked.map((r) => r.proxyRank), [1, 2, 3, 4]);
  // proxyScores carry the raw per-proxy values for transparency.
  const c = ranked.find((r) => r.id === 'c');
  assert.equal(c.proxyScores.loc, 20);
  assert.equal(c.proxyScores.cyclomatic, 2);
});

test('rankByProxies honours prefer:higher vs prefer:lower independently', () => {
  // Single proxy, prefer:'higher' on loc → d(90) > b(50) > a(30) > c(20).
  const ranked = rankByProxies(CANDIDATES, [{ name: 'loc', of: (c) => c.loc, prefer: 'higher' }]);
  assert.deepEqual(ranked.map((r) => r.id), ['d', 'b', 'a', 'c']);
});

test('rankByProxies breaks ties by input index (stable)', () => {
  // All identical on the proxy → order must follow input index, untouched.
  const flat = [
    { id: 'x', v: 1 }, { id: 'y', v: 1 }, { id: 'z', v: 1 }, { id: 'w', v: 1 },
  ];
  const ranked = rankByProxies(flat, [{ name: 'v', of: (c) => c.v, prefer: 'lower' }]);
  assert.deepEqual(ranked.map((r) => r.id), ['x', 'y', 'z', 'w']);
  assert.deepEqual(ranked.map((r) => r.proxyRank), [1, 2, 3, 4]);
});

test('rankByProxies with two disagreeing proxies uses the mean-normalized-rank aggregate', () => {
  // proxyHi prefers HIGHER v: order p1(10)>p2(8)>p3(6) → ranks p1=1,p2=2,p3=3.
  // proxyLo prefers LOWER w:  order p3(1)<p2(2)<p1(3)  → ranks p3=1,p2=2,p1=3.
  // mean rank: p1=(1+3)/2=2, p2=(2+2)/2=2, p3=(3+1)/2=2 → all tie → stable input order p1,p2,p3.
  const items = [
    { id: 'p1', v: 10, w: 3 },
    { id: 'p2', v: 8, w: 2 },
    { id: 'p3', v: 6, w: 1 },
  ];
  const ranked = rankByProxies(items, [
    { name: 'hi', of: (c) => c.v, prefer: 'higher' },
    { name: 'lo', of: (c) => c.w, prefer: 'lower' },
  ]);
  assert.deepEqual(ranked.map((r) => r.id), ['p1', 'p2', 'p3']);
});

test('rankByProxies validates inputs', () => {
  assert.throws(() => rankByProxies('nope', PROXIES), /candidates must be an array/);
  assert.throws(() => rankByProxies(CANDIDATES, []), /proxies must be a non-empty array/);
  assert.throws(() => rankByProxies(CANDIDATES, [{ name: 'x', of: (c) => c.loc, prefer: 'sideways' }]), /prefer/);
  assert.throws(() => rankByProxies(CANDIDATES, [{ name: 'x', of: 'notfn', prefer: 'lower' }]), /of/);
  assert.throws(() => rankByProxies([{ text: 'no id' }], PROXIES), /id/);
});

// ---------------------------------------------------------------------------------------------
// 2. advisoryRank — advisory, decorrelated pairwise judging.
test('advisoryRank yields the order expected from pairwise wins', async () => {
  const out = await advisoryRank({
    task: 'pick the best', candidates: CANDIDATES, judgeFn: fakeJudgeFn,
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
  });
  // text lengths: b=30, c=20, a=5, d=4. Longer wins every pair → strict order b > c > a > d.
  assert.deepEqual(out.ranking.map((r) => r.id), ['b', 'c', 'a', 'd']);
  assert.deepEqual(out.ranking.map((r) => r.advisoryRank), [1, 2, 3, 4]);
  assert.equal(out.decorrelated, true);
  // Bradley-Terry-ish score = wins + 0.5*ties; with N=4 there are 3 pairs each. b beats all 3.
  const b = out.ranking.find((r) => r.id === 'b');
  assert.equal(b.wins, 3);
  assert.equal(b.ties, 0);
  assert.equal(b.losses, 0);
  assert.equal(b.advisoryScore, 3);
  const d = out.ranking.find((r) => r.id === 'd');
  assert.equal(d.wins, 0);
  assert.equal(d.advisoryScore, 0);
});

test('advisoryRank counts ties as 0.5 and orders by wins+0.5*ties', async () => {
  // Two pairs tie, the rest are decided by length. Use equal-length texts to force ties.
  const cs = [
    { id: 'e', text: 'aaaa' },   // len 4
    { id: 'f', text: 'bbbb' },   // len 4 → ties with e
    { id: 'g', text: 'cc' },     // len 2 → loses to both
  ];
  const out = await advisoryRank({
    task: 't', candidates: cs, judgeFn: fakeJudgeFn,
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
  });
  // e vs f → tie; e vs g → e; f vs g → f. e: 1 win + 1 tie = 1.5; f: 1.5; g: 0.
  // e & f tie on score 1.5 → stable input order e before f. g last.
  assert.deepEqual(out.ranking.map((r) => r.id), ['e', 'f', 'g']);
  const e = out.ranking.find((r) => r.id === 'e');
  assert.equal(e.wins, 1);
  assert.equal(e.ties, 1);
  assert.equal(e.advisoryScore, 1.5);
});

test('advisoryRank flags decorrelated:false when judgeProvenance === answerAuthor', async () => {
  const out = await advisoryRank({
    task: 't', candidates: CANDIDATES, judgeFn: fakeJudgeFn,
    judgeProvenance: ANSWER_AUTHOR, answerAuthor: ANSWER_AUTHOR,  // SAME → correlated
  });
  assert.equal(out.decorrelated, false);
  assert.match(out.reason, /decorrelat|same|distinct|answerAuthor/i);
  // The ranking is still produced (so a human can see it) — only FLAGGED weaker.
  assert.equal(out.ranking.length, CANDIDATES.length);
});

test('advisoryRank flags decorrelated:false when judgeProvenance is absent', async () => {
  const out = await advisoryRank({
    task: 't', candidates: CANDIDATES, judgeFn: fakeJudgeFn,
    judgeProvenance: '', answerAuthor: ANSWER_AUTHOR,
  });
  assert.equal(out.decorrelated, false);
  assert.match(out.reason, /provenance|absent|non-empty/i);
});

test('advisoryRank is robust to a junk judge return (unknown treated as tie)', async () => {
  // Junk judge always returns garbage → every pair is a tie → all scores equal → stable input order.
  const junkJudge = () => 'banana';
  const out = await advisoryRank({
    task: 't', candidates: CANDIDATES, judgeFn: junkJudge,
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
  });
  // All ties → input order preserved a,b,c,d; every advisoryScore == 0.5 * (N-1).
  assert.deepEqual(out.ranking.map((r) => r.id), ['a', 'b', 'c', 'd']);
  for (const r of out.ranking) {
    assert.equal(r.wins, 0);
    assert.equal(r.ties, 3);
    assert.equal(r.advisoryScore, 1.5);
  }
});

test('advisoryRank validates inputs', async () => {
  await assert.rejects(() => advisoryRank({ task: 't', candidates: 'no', judgeFn: fakeJudgeFn, judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR }), /candidates/);
  await assert.rejects(() => advisoryRank({ task: 't', candidates: CANDIDATES, judgeFn: 'no', judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR }), /judgeFn/);
});

// ---------------------------------------------------------------------------------------------
// 3. buildSlate — combine, label advisory, never name a winner.
test('buildSlate returns an ordered slate labelled advisory + selectBy:human', async () => {
  const out = await buildSlate({
    candidates: CANDIDATES, proxies: PROXIES, judgeFn: fakeJudgeFn,
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
    tier: 'factual-evidence-pass',
  });
  // PRIMARY order = advisory judge ranking: b > c > a > d (longer text wins).
  assert.deepEqual(out.slate.map((s) => s.id), ['b', 'c', 'a', 'd']);
  // Honesty labels.
  assert.equal(out.rankingIsAdvisory, true);
  assert.equal(out.selectBy, 'human');
  assert.equal(out.decorrelated, true);
  assert.ok(typeof out.note === 'string' && out.note.length > 0);
  // Every slate entry carries the VERIFIED tier (real) + both rank views.
  for (const s of out.slate) {
    assert.equal(s.tier, 'factual-evidence-pass');
    assert.equal(typeof s.advisoryRank, 'number');
    assert.equal(typeof s.advisoryScore, 'number');
    assert.equal(typeof s.proxyRank, 'number');
    assert.equal(typeof s.proxyScores, 'object');
  }
});

test('buildSlate HARD INVARIANT: no top-level winner/best key, anywhere', async () => {
  const out = await buildSlate({
    candidates: CANDIDATES, proxies: PROXIES, judgeFn: fakeJudgeFn,
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
    tier: 'factual-evidence-pass',
  });
  // No authoritative single-winner field at the top level.
  for (const banned of ['winner', 'best', 'chosen', 'selected', 'top', 'champion']) {
    assert.ok(!(banned in out), `buildSlate must NOT expose a top-level '${banned}' key`);
  }
  // Nor inside any slate entry.
  for (const s of out.slate) {
    for (const banned of ['winner', 'best', 'isBest', 'chosen']) {
      assert.ok(!(banned in s), `slate entry must NOT expose a '${banned}' key`);
    }
  }
});

test('buildSlate propagates decorrelated:false when judge == answer author', async () => {
  const out = await buildSlate({
    candidates: CANDIDATES, proxies: PROXIES, judgeFn: fakeJudgeFn,
    judgeProvenance: ANSWER_AUTHOR, answerAuthor: ANSWER_AUTHOR,
    tier: 'factual-evidence-pass',
  });
  assert.equal(out.decorrelated, false);
  // Still advisory + human-select, still no winner.
  assert.equal(out.rankingIsAdvisory, true);
  assert.equal(out.selectBy, 'human');
  assert.ok(!('best' in out) && !('winner' in out));
  // The note must surface the weaker-confidence flag for a human.
  assert.match(out.note, /decorrelat|weaker|flag|same/i);
});

test('buildSlate uses proxies as a tie-break under a full judge tie (stable, deterministic)', async () => {
  // Junk judge → every advisory score ties. Then proxies break the tie deterministically.
  const junkJudge = () => 'banana';
  const out = await buildSlate({
    candidates: CANDIDATES, proxies: PROXIES, judgeFn: junkJudge,
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
    tier: 'factual-evidence-pass',
  });
  // Advisory all-tie → tie-break by proxyRank: c,a,b,d (from rankByProxies above).
  assert.deepEqual(out.slate.map((s) => s.id), ['c', 'a', 'b', 'd']);
});

test('buildSlate with a TOTAL tie (junk judge + flat proxies) is a stable input order', async () => {
  const flat = [
    { id: 'm', text: 'xx', v: 1 }, { id: 'n', text: 'xx', v: 1 },
    { id: 'o', text: 'xx', v: 1 }, { id: 'p', text: 'xx', v: 1 },
  ];
  const out = await buildSlate({
    candidates: flat, proxies: [{ name: 'v', of: (c) => c.v, prefer: 'lower' }],
    judgeFn: () => 'tie',  // explicit total tie
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
    tier: 'constructed-floor-pass',
  });
  // Everything ties everywhere → stable input order m,n,o,p; deterministic across runs.
  assert.deepEqual(out.slate.map((s) => s.id), ['m', 'n', 'o', 'p']);
  // Re-run: identical (determinism).
  const out2 = await buildSlate({
    candidates: flat, proxies: [{ name: 'v', of: (c) => c.v, prefer: 'lower' }],
    judgeFn: () => 'tie',
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
    tier: 'constructed-floor-pass',
  });
  assert.deepEqual(out2.slate.map((s) => s.id), out.slate.map((s) => s.id));
});

test('buildSlate validates the VERIFIED tier argument', async () => {
  await assert.rejects(() => buildSlate({
    candidates: CANDIDATES, proxies: PROXIES, judgeFn: fakeJudgeFn,
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
    tier: '',
  }), /tier/);
});

// =============================================================================================
// ADVERSARIAL-REVIEW REGRESSIONS — each fails on the pre-AR code, passes after the fix.
// The honesty spine: candidates are VERIFIED (passed a constructed floor); the RANKING is
// ADVISORY (for human selection), never an authoritative "best".
// =============================================================================================

// The VERIFIED set buildSlate accepts as an EARNED tier (mirrors certify.mjs TIER_CEILINGS).
// 'advisory-slate' / 'proxy-ranked' are NOT verified — a candidate carrying them must be refused.
const VERIFIED_TIERS = ['repo-verified', 'constructed-floor-pass', 'factual-evidence-pass'];

// Candidates carrying their OWN earned per-candidate tier (the preferred shape post-AR).
const VERIFIED_CANDIDATES = CANDIDATES.map((c) => ({ ...c, tier: 'factual-evidence-pass' }));

// ---------------------------------------------------------------------------------------------
// FINDING 1 [HIGH] — buildSlate must not stamp a VERIFIED tier a candidate did not EARN.
// Each candidate carries its OWN tier; buildSlate validates each against the VERIFIED set and
// copies candidate.tier into its row. A missing/advisory/unknown tier is REFUSED (throw).

test('F1: buildSlate copies each candidate OWN earned tier into its row', async () => {
  const mixed = [
    { ...CANDIDATES[0], tier: 'repo-verified' },
    { ...CANDIDATES[1], tier: 'constructed-floor-pass' },
    { ...CANDIDATES[2], tier: 'factual-evidence-pass' },
    { ...CANDIDATES[3], tier: 'repo-verified' },
  ];
  const out = await buildSlate({
    candidates: mixed, proxies: PROXIES, judgeFn: fakeJudgeFn,
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
  });
  const tierById = Object.fromEntries(mixed.map((c) => [c.id, c.tier]));
  for (const s of out.slate) {
    assert.equal(s.tier, tierById[s.id], `row ${s.id} must carry its OWN earned tier`);
  }
});

test('F1: buildSlate REFUSES a candidate carrying an advisory tier (not verified)', async () => {
  const tainted = [
    { ...CANDIDATES[0], tier: 'factual-evidence-pass' },
    { ...CANDIDATES[1], tier: 'advisory-slate' },   // NOT a verified tier — must be refused
    { ...CANDIDATES[2], tier: 'factual-evidence-pass' },
    { ...CANDIDATES[3], tier: 'factual-evidence-pass' },
  ];
  await assert.rejects(() => buildSlate({
    candidates: tainted, proxies: PROXIES, judgeFn: fakeJudgeFn,
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
  }), /tier/i);
});

test('F1: buildSlate REFUSES a candidate with a missing tier when no global fallback given', async () => {
  const noTier = [
    { ...CANDIDATES[0], tier: 'factual-evidence-pass' },
    { ...CANDIDATES[1] },   // no tier, no global fallback → cannot attest verification
  ];
  await assert.rejects(() => buildSlate({
    candidates: noTier, proxies: PROXIES, judgeFn: fakeJudgeFn,
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
  }), /tier/i);
});

test('F1: buildSlate REFUSES an UNKNOWN tier string', async () => {
  const bad = VERIFIED_CANDIDATES.map((c, i) => (i === 1 ? { ...c, tier: 'made-up-tier' } : c));
  await assert.rejects(() => buildSlate({
    candidates: bad, proxies: PROXIES, judgeFn: fakeJudgeFn,
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
  }), /tier/i);
});

test('F1: the deprecated global tier is REFUSED if it is itself not a verified tier', async () => {
  // A caller passing an advisory/unknown global tier for tier-less candidates must be refused —
  // the global fallback is still validated against the VERIFIED set.
  await assert.rejects(() => buildSlate({
    candidates: CANDIDATES, proxies: PROXIES, judgeFn: fakeJudgeFn,
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
    tier: 'advisory-slate',
  }), /tier/i);
});

test('F1: per-candidate tier OVERRIDES the global fallback default', async () => {
  // Global says factual-evidence-pass, but candidate b earned only constructed-floor-pass.
  const cands = [
    { ...CANDIDATES[0] },                                  // inherits global
    { ...CANDIDATES[1], tier: 'constructed-floor-pass' },  // own earned tier wins
    { ...CANDIDATES[2] },
    { ...CANDIDATES[3] },
  ];
  const out = await buildSlate({
    candidates: cands, proxies: PROXIES, judgeFn: fakeJudgeFn,
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
    tier: 'factual-evidence-pass',
  });
  const b = out.slate.find((s) => s.id === 'b');
  const a = out.slate.find((s) => s.id === 'a');
  assert.equal(b.tier, 'constructed-floor-pass');
  assert.equal(a.tier, 'factual-evidence-pass');
});

// ---------------------------------------------------------------------------------------------
// FINDING 2 [HIGH] — duplicate candidate ids corrupt the id-keyed ranking joins. All three
// functions must reject duplicate ids with a clear error.

test('F2: rankByProxies rejects duplicate candidate ids', () => {
  const dup = [{ id: 'x', loc: 1, cx: 1 }, { id: 'x', loc: 2, cx: 2 }];
  assert.throws(() => rankByProxies(dup, PROXIES), /duplicate/i);
});

test('F2: advisoryRank rejects duplicate candidate ids', async () => {
  const dup = [{ id: 'x', text: 'aa' }, { id: 'x', text: 'bbbb' }];
  await assert.rejects(() => advisoryRank({
    task: 't', candidates: dup, judgeFn: fakeJudgeFn,
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
  }), /duplicate/i);
});

test('F2: buildSlate rejects duplicate candidate ids', async () => {
  const dup = [
    { id: 'x', text: 'aa', loc: 1, cx: 1, tier: 'factual-evidence-pass' },
    { id: 'x', text: 'bbbb', loc: 2, cx: 2, tier: 'factual-evidence-pass' },
  ];
  await assert.rejects(() => buildSlate({
    candidates: dup, proxies: PROXIES, judgeFn: fakeJudgeFn,
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
  }), /duplicate/i);
});

// ---------------------------------------------------------------------------------------------
// FINDING 3 [MED] — a throwing/rejecting judgeFn must NOT abort the whole slate. Each per-pair
// judge call is wrapped; a throw OR junk verdict is treated as a TIE and counted. If EVERY pair
// errored/was-invalid, the ordering is labelled a proxy-only fallback (not "judge-ranked").

test('F3: advisoryRank survives a judgeFn that throws on ONE pair (that pair a tie, counted)', async () => {
  // Throw only on the (a,b)-style pair where one candidate is the longest 'b'. Count = 1.
  let threw = 0;
  const judge = ({ a, b }) => {
    if (a.id === 'a' && b.id === 'b') { threw++; throw new Error('boom'); }
    const la = String(a.text).length, lb = String(b.text).length;
    if (la > lb) return 'a';
    if (lb > la) return 'b';
    return 'tie';
  };
  const out = await advisoryRank({
    task: 't', candidates: CANDIDATES, judgeFn: judge,
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
  });
  // Slate still produced over all 4 candidates.
  assert.equal(out.ranking.length, CANDIDATES.length);
  assert.equal(threw, 1);
  assert.equal(out.judgeErrors, 1);
  assert.equal(out.proxyOnlyFallback, false);
});

test('F3: advisoryRank counts junk verdicts as invalidVerdicts (still a tie)', async () => {
  const junk = () => 'banana';
  const out = await advisoryRank({
    task: 't', candidates: CANDIDATES, judgeFn: junk,
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
  });
  const pairs = (CANDIDATES.length * (CANDIDATES.length - 1)) / 2;
  assert.equal(out.invalidVerdicts, pairs);
  assert.equal(out.judgeErrors, 0);
});

test('F3: a judgeFn that throws on ALL pairs sets the proxy-only fallback flag', async () => {
  const allThrow = () => { throw new Error('judge down'); };
  const out = await advisoryRank({
    task: 't', candidates: CANDIDATES, judgeFn: allThrow,
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
  });
  const pairs = (CANDIDATES.length * (CANDIDATES.length - 1)) / 2;
  assert.equal(out.ranking.length, CANDIDATES.length);  // still produced
  assert.equal(out.judgeErrors, pairs);
  assert.equal(out.proxyOnlyFallback, true);
});

test('F3: buildSlate surfaces judgeErrors / fallback and still produces a slate', async () => {
  const allThrow = () => { throw new Error('judge down'); };
  const out = await buildSlate({
    candidates: VERIFIED_CANDIDATES, proxies: PROXIES, judgeFn: allThrow,
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
  });
  assert.equal(out.slate.length, VERIFIED_CANDIDATES.length);
  assert.equal(out.proxyOnlyFallback, true);
  assert.ok(out.judgeErrors >= 1);
  // The note must say the order is a proxy-only fallback, not judge-ranked.
  assert.match(out.note, /proxy[- ]only|fallback/i);
  // All pairs tie → ordering falls to proxies: c,a,b,d (from rankByProxies).
  assert.deepEqual(out.slate.map((s) => s.id), ['c', 'a', 'b', 'd']);
});

// ---------------------------------------------------------------------------------------------
// FINDING 4 [MED] — decorrelation must hold against EVERY candidate's answer-author, not one
// global author. Accept answerAuthors[] OR per-candidate candidate.answerAuthor; the judge is
// decorrelated only if judgeProvenance is non-empty AND distinct from every answer-author.

test('F4: judgeProvenance equal to ONE of several answerAuthors → decorrelated:false', async () => {
  const out = await advisoryRank({
    task: 't', candidates: CANDIDATES, judgeFn: fakeJudgeFn,
    judgeProvenance: 'author-2',
    answerAuthors: ['author-1', 'author-2', 'author-3'],  // judge collides with author-2
  });
  assert.equal(out.decorrelated, false);
  // Reason must cite the COLLISION with a specific answer-author, not merely "absent author".
  // (On the pre-AR code answerAuthors is ignored, so the singular author is absent and the flag
  // fires for the WRONG reason — this assertion makes the regression bite.)
  assert.match(out.reason, /author-2|same|collid|matches/i);
  assert.doesNotMatch(out.reason, /absent|missing/i);
});

test('F4: judgeProvenance distinct from EVERY answerAuthor → decorrelated:true', async () => {
  const out = await advisoryRank({
    task: 't', candidates: CANDIDATES, judgeFn: fakeJudgeFn,
    judgeProvenance: 'judge-X', answerAuthors: ['author-1', 'author-2', 'author-3'],
  });
  assert.equal(out.decorrelated, true);
});

test('F4: per-candidate answerAuthor — judge colliding with any one is not decorrelated', async () => {
  const cands = [
    { ...CANDIDATES[0], answerAuthor: 'model-A' },
    { ...CANDIDATES[1], answerAuthor: 'model-B' },
    { ...CANDIDATES[2], answerAuthor: 'model-C' },
    { ...CANDIDATES[3], answerAuthor: 'model-A' },
  ];
  const out = await advisoryRank({
    task: 't', candidates: cands, judgeFn: fakeJudgeFn,
    judgeProvenance: 'model-B',  // collides with candidate b
  });
  assert.equal(out.decorrelated, false);
  // Must fire for the COLLISION, not because the global author is absent.
  assert.match(out.reason, /model-B|same|collid|matches/i);
  assert.doesNotMatch(out.reason, /absent|missing/i);
});

// ---------------------------------------------------------------------------------------------
// FINDING 5 [MED] — standalone advisoryRank must carry the machine-readable advisory marker so a
// direct caller cannot read ranking[0] as "the winner".

test('F5: advisoryRank returns rankingIsAdvisory:true + selectBy:human', async () => {
  const out = await advisoryRank({
    task: 't', candidates: CANDIDATES, judgeFn: fakeJudgeFn,
    judgeProvenance: JUDGE_PROVENANCE, answerAuthor: ANSWER_AUTHOR,
  });
  assert.equal(out.rankingIsAdvisory, true);
  assert.equal(out.selectBy, 'human');
});

// ---------------------------------------------------------------------------------------------
// FINDING 6 [LOW-MED] — rankByProxies must give EQUAL proxy-rank to EQUAL proxy values
// (competition ranking), using input index only as the final display tie-break. A
// non-discriminating proxy must not shift the aggregate by input order.

test('F6: equal proxy values get EQUAL rank contribution regardless of input order', () => {
  // proxy 'flat' is identical for all → contributes equally to every candidate. proxy 'k'
  // discriminates: m1(1) < m2(2) < m3(2) ... we make m1 best, m2/m3 tie.
  const a = [
    { id: 'm1', flat: 5, k: 1 },
    { id: 'm2', flat: 5, k: 2 },
    { id: 'm3', flat: 5, k: 2 },
  ];
  const proxies = [
    { name: 'flat', of: (c) => c.flat, prefer: 'lower' },  // non-discriminating
    { name: 'k', of: (c) => c.k, prefer: 'lower' },
  ];
  const r1 = rankByProxies(a, proxies);
  // m1 best; m2 and m3 tie on k AND flat → m2 before m3 by input index only.
  assert.deepEqual(r1.map((x) => x.id), ['m1', 'm2', 'm3']);

  // Reorder the two tied inputs: the discriminating result for m1 must NOT change, and the two
  // tied candidates keep input-order display tie-break. With competition ranking the flat proxy
  // contributes equally, so m1 stays first.
  const b = [
    { id: 'm3', flat: 5, k: 2 },
    { id: 'm2', flat: 5, k: 2 },
    { id: 'm1', flat: 5, k: 1 },
  ];
  const r2 = rankByProxies(b, proxies);
  assert.equal(r2[0].id, 'm1', 'the discriminating winner must be first regardless of input order');
});

test('F6: two candidates equal on EVERY proxy share the same proxyRank contribution; a third differs', () => {
  // t1 and t2 identical on both proxies; t3 strictly worse. Competition ranking: t1,t2 share
  // rank-1 contribution per proxy, t3 ranks after. Final display order t1,t2 by input index, t3 last.
  const items = [
    { id: 't1', a: 10, b: 1 },
    { id: 't2', a: 10, b: 1 },
    { id: 't3', a: 20, b: 2 },
  ];
  const proxies = [
    { name: 'a', of: (c) => c.a, prefer: 'lower' },
    { name: 'b', of: (c) => c.b, prefer: 'lower' },
  ];
  const r = rankByProxies(items, proxies);
  assert.deepEqual(r.map((x) => x.id), ['t1', 't2', 't3']);
  // t3 must be strictly last; t1/t2 ahead of it.
  assert.equal(r[2].id, 't3');
  // Even if t3 is FIRST in input order, it is still ranked last (proxy-driven, not input-driven).
  const items2 = [
    { id: 't3', a: 20, b: 2 },
    { id: 't1', a: 10, b: 1 },
    { id: 't2', a: 10, b: 1 },
  ];
  const r2 = rankByProxies(items2, proxies);
  assert.equal(r2[r2.length - 1].id, 't3');
  assert.deepEqual(r2.map((x) => x.id), ['t1', 't2', 't3']);
});

// meanRank — the underlying AGGREGATE (NOT the dense display ordinal). The single-best picker keys top-tie
// detection on meanRank: genuinely-tied candidates MUST share it (the dense proxyRank deliberately does not).
test('meanRank ties for objectively-equivalent candidates; proxyRank stays a unique dense ordinal', () => {
  // t1,t2 identical on both proxies (objectively equivalent); t3 strictly worse.
  const items = [
    { id: 't1', a: 10, b: 1 },
    { id: 't2', a: 10, b: 1 },
    { id: 't3', a: 20, b: 2 },
  ];
  const proxies = [
    { name: 'a', of: (c) => c.a, prefer: 'lower' },
    { name: 'b', of: (c) => c.b, prefer: 'lower' },
  ];
  const r = rankByProxies(items, proxies);
  const by = Object.fromEntries(r.map((x) => [x.id, x]));
  // meanRank is EQUAL for the two equivalent candidates, strictly greater for the worse one.
  assert.equal(by.t1.meanRank, by.t2.meanRank, 'equivalent candidates share meanRank');
  assert.ok(by.t3.meanRank > by.t1.meanRank, 'the strictly-worse candidate has a higher meanRank');
  // proxyRank is a UNIQUE dense ordinal — it does NOT tie (which is exactly why top-tie detection must
  // use meanRank, not proxyRank).
  assert.deepEqual([...new Set(r.map((x) => x.proxyRank))].sort(), [1, 2, 3], 'proxyRank is a distinct 1..N ordinal');
});
