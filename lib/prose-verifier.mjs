// prose-verifier — emit a DETERMINISTIC claim-check oracle for a prose answer.
//
// The gate-runner family certifies CODE by running a repo's real test suite out-of-band.
// This module gives a PROSE answer the same kind of mechanical oracle: a standalone
// `claims.mjs` that, run as `node claims.mjs <answerFile> <sourceFile>`, checks a fixed
// list of claims against the answer text (and, for grounding/number claims, the source
// text) and prints TAP — exactly the shape `gate-runner.mjs`'s parseTapDetailed/tapComplete
// parse. No LLM, no model judgment: every check is a string `includes` test, so the verdict
// is reproducible and a candidate answer cannot grade itself.
//
// Claim kinds (all deterministic):
//   - must-include   { id, text }   -> answer.includes(text)
//   - must-exclude   { id, text }   -> !answer.includes(text)   (a known-false statement is ABSENT)
//   - grounded       { id, quote }  -> source.includes(quote) && answer.includes(quote)
//   - number-matches { id, value }  -> answer.includes(value) && source.includes(value)
//   - near           { id, anchor, token, window? } -> SCOPED must-include: `token` occurs within
//                    `window` chars (default 50) of SOME occurrence of `anchor` in the answer.
//                    If `anchor` is ABSENT, FAIL (cannot be near a missing anchor).
//   - not-near       { id, anchor, token, window? } -> SCOPED must-exclude: `token` does NOT occur
//                    within `window` chars of ANY occurrence of `anchor`. If `anchor` is ABSENT,
//                    PASS (vacuous — nothing near it). Distance = |tokenStart - anchorStart| over the
//                    cartesian product of anchor/token start indices; "near" iff that <= window.
//
// near/not-near are ANSWER-STRUCTURE checks (they ignore the source) — unlike grounded/number-matches.
// They fix the crude `must-exclude "29"` false-negative: an answer that mentions "29 days in 2000"
// while correctly discussing February 1900 is rejected by must-exclude but PASSES not-near{1900,29}.
//
// Emitted TAP: a `1..N` plan line plus one `ok <n> - <id>` / `not ok <n> - <id> # <reason>`
// per claim. The plan count equals the number of claims, so tapComplete() holds on a
// well-formed run.

// The known claim kinds and the REQUIRED field each one anchors on. A claim of an unknown kind, or
// one missing its required field (or carrying a non-string / empty one), is VACUOUS: the emitted
// oracle would coerce `undefined` through String() and silently "check" the literal text
// "undefined", greening or reding by accident. So every claim must be validated BEFORE emission.
const CLAIM_KINDS = {
  'must-include': 'text',
  'must-exclude': 'text',
  grounded: 'quote',
  'number-matches': 'value',
  // Scoped kinds carry no single text-field; their required fields (anchor + token, optional window)
  // are validated by validateScoped() / emitted via the proximity logic below. The `null` marks them
  // as known-but-not-single-field so the generic CLAIM_KINDS[field] path is skipped for them.
  near: null,
  'not-near': null,
};

// Kinds whose shape is { anchor, token, window? } (a proximity check inside the answer), validated
// by validateScoped rather than the single-required-field path.
const SCOPED_KINDS = new Set(['near', 'not-near']);

/**
 * Validate a scoped (near / not-near) claim's structure. Returns a problem string, or null if OK.
 * Requires non-empty string `anchor` AND `token`; if `window` is present it must be a positive
 * finite number. These are ANSWER-STRUCTURE checks — anchor/token are NOT required to appear in the
 * source (unlike grounded/number-matches).
 */
function validateScoped(c, where) {
  if (typeof c.anchor !== 'string' || c.anchor.trim() === '') {
    return `${where}: kind ${JSON.stringify(c.kind)} requires a non-empty string "anchor", got ${JSON.stringify(c.anchor)}`;
  }
  if (typeof c.token !== 'string' || c.token.trim() === '') {
    return `${where}: kind ${JSON.stringify(c.kind)} requires a non-empty string "token", got ${JSON.stringify(c.token)}`;
  }
  if (c.window !== undefined && (typeof c.window !== 'number' || !Number.isFinite(c.window) || c.window <= 0)) {
    return `${where}: kind ${JSON.stringify(c.kind)} "window" must be a positive finite number when present, got ${JSON.stringify(c.window)}`;
  }
  return null;
}

// Kinds whose anchor must literally appear in the SOURCE. A 'grounded'/'number-matches' claim whose
// quote/value is absent from the source is vacuous — it can never be satisfied by reproducing the
// source (there is nothing to reproduce), so it is an authoring error, not a checkable claim.
const SOURCE_ANCHORED = new Set(['grounded', 'number-matches']);

// Claim ids are EMITTED verbatim as TAP test names (`ok N - <id>`). They must be present and free of
// TAP-special characters: `#` starts a TAP comment/directive (truncating the name), and
// whitespace/newlines/control chars break the one-line-per-claim contract. If an id is missing or
// unsafe, the emitted oracle's parsed key (e.g. `undefined`, or `AC` from `AC #1`) DIVERGES from the
// certificate's checkId and from the in-process predicate the bleed-lint runs — a silent false
// prediction. So restrict ids to a safe charset, enforced everywhere a claim is validated or emitted.
const SAFE_CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
function claimIdProblem(id, where) {
  if (typeof id !== 'string' || id.trim() === '') return `${where}: claim requires a non-empty string "id"`;
  if (!SAFE_CLAIM_ID.test(id)) return `${where}: claim id ${JSON.stringify(id)} has TAP-unsafe characters — use only [A-Za-z0-9._:-] (no "#", whitespace, or control chars; they truncate/break the emitted TAP name)`;
  return null;
}

/**
 * Validate a claim list against the source BEFORE it is baked into an oracle.
 *
 * Rejects (returns problems for) any claim whose:
 *   - kind is not one of the known kinds;
 *   - kind's required field (text / quote / value) is missing, non-string, or empty;
 *   - kind is source-anchored ('grounded' / 'number-matches') yet the anchor does NOT appear in
 *     `source` — an ungrounded anchor is vacuous and must be rejected, not silently emitted.
 *
 * This is the guard the AR found missing: without it, a claim like `{kind:'must-exclude'}` (no
 * `text`) coerces `String(undefined)` and the oracle "checks" the literal "undefined", a vacuous
 * pass/fail. `id` shape is validated by the construction layer (coverage), not here.
 *
 * @param {{id?:string, kind?:string, text?:string, quote?:string, value?:string}[]} claims
 * @param {string} source  the decorrelated ground truth source-anchored claims must appear in
 * @returns {{ valid: boolean, problems: string[] }}
 */
export function validateClaims(claims, source) {
  const problems = [];
  if (!Array.isArray(claims)) return { valid: false, problems: ['claims must be an array'] };
  if (typeof source !== 'string') return { valid: false, problems: ['source must be a string'] };
  claims.forEach((c, i) => {
    const where = c && typeof c === 'object' && typeof c.id === 'string' && c.id ? `claim ${JSON.stringify(c.id)}` : `claim #${i}`;
    if (!c || typeof c !== 'object') { problems.push(`${where}: not an object`); return; }
    // The `id` is EMITTED as a TAP test name, so validate it HERE (not only in the construction-layer
    // coverage): a missing / TAP-unsafe id makes the emitted oracle key diverge from the in-process
    // predicate the bleed-lint runs. Push the problem but keep checking the kind so all issues surface.
    const idProblem = claimIdProblem(c.id, where);
    if (idProblem) problems.push(idProblem);
    // A `kind` is known iff it is a key of CLAIM_KINDS (the value may be `null` for scoped kinds).
    if (!Object.prototype.hasOwnProperty.call(CLAIM_KINDS, c.kind)) {
      problems.push(`${where}: unknown kind ${JSON.stringify(c.kind)} (must be one of ${Object.keys(CLAIM_KINDS).join(', ')})`);
      return;
    }
    if (SCOPED_KINDS.has(c.kind)) {
      // near / not-near: { anchor, token, window? } answer-structure check — NOT source-anchored.
      const problem = validateScoped(c, where);
      if (problem) problems.push(problem);
      return;
    }
    const field = CLAIM_KINDS[c.kind];
    const v = c[field];
    if (typeof v !== 'string' || v.trim() === '') {
      problems.push(`${where}: kind ${JSON.stringify(c.kind)} requires a non-empty string ${JSON.stringify(field)}, got ${JSON.stringify(v)}`);
      return;
    }
    if (SOURCE_ANCHORED.has(c.kind) && !source.includes(v)) {
      problems.push(`${where}: kind ${JSON.stringify(c.kind)} anchor ${JSON.stringify(v)} does not appear in the source — an ungrounded anchor is vacuous`);
    }
  });
  return { valid: problems.length === 0, problems };
}

// --- The per-claim predicate: the SINGLE SOURCE OF TRUTH ----------------------------------------
// `evaluateClaim` (+ its helpers) is the ONE definition of what each claim kind means. It is BOTH
// (a) exported for in-process reuse — the bleed-lint forecasts the gate verdict by calling it
// directly, no child process — AND (b) serialized verbatim into the emitted claims.mjs oracle
// (emitProseVerifier below embeds it via Function.prototype.toString). So the bytes that run in the
// real out-of-band gate are identical to the bytes the lint runs; editing the predicate here changes
// both, with no second copy to drift. (Same hoist-and-share pattern as validateScoped above.)

// All start indices of needle in hay (overlapping search via indexOf loop).
function allOccurrences(hay, needle) {
  const out = [];
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + 1; // advance by 1 to catch overlapping matches
  }
  return out;
}

// True iff SOME occurrence of token starts within window chars of SOME occurrence of anchor,
// measured |tokenStart - anchorStart|. Used by both near (want true) and not-near (want false).
function tokenNearAnchor(text, anchor, token, window) {
  const anchorStarts = allOccurrences(text, anchor);
  if (anchorStarts.length === 0) return false; // anchor absent -> nothing is "near" it
  const tokenStarts = allOccurrences(text, token);
  for (const a of anchorStarts) {
    for (const t of tokenStarts) {
      if (Math.abs(t - a) <= window) return true;
    }
  }
  return false;
}

const DEFAULT_WINDOW = 50;

/**
 * Evaluate ONE claim against an answer (and, for source-anchored kinds, the source). PURE — no I/O.
 * Returns `{ ok: true }` on pass and `{ ok: false, reason }` on fail (reason only on failure).
 * This is the exact predicate the emitted oracle runs — reuse it, never re-implement it.
 *
 * @param {{kind:string, text?:string, quote?:string, value?:string, anchor?:string, token?:string, window?:number}} claim
 * @param {string} answer  the candidate answer text
 * @param {string} source  the decorrelated ground truth (only read by grounded / number-matches)
 * @returns {{ ok: boolean, reason?: string }}
 */
export function evaluateClaim(claim, answer, source) {
  switch (claim.kind) {
    case 'must-include':
      return answer.includes(claim.text)
        ? { ok: true }
        : { ok: false, reason: 'answer is missing required text: ' + JSON.stringify(claim.text) };
    case 'must-exclude':
      return !answer.includes(claim.text)
        ? { ok: true }
        : { ok: false, reason: 'answer contains forbidden text: ' + JSON.stringify(claim.text) };
    case 'grounded': {
      const inSource = source.includes(claim.quote);
      const inAnswer = answer.includes(claim.quote);
      if (inSource && inAnswer) return { ok: true };
      const missing = [];
      if (!inSource) missing.push('source');
      if (!inAnswer) missing.push('answer');
      return { ok: false, reason: 'quote not grounded in ' + missing.join(' & ') + ': ' + JSON.stringify(claim.quote) };
    }
    case 'number-matches': {
      const inAnswer = answer.includes(claim.value);
      const inSource = source.includes(claim.value);
      if (inAnswer && inSource) return { ok: true };
      const missing = [];
      if (!inAnswer) missing.push('answer');
      if (!inSource) missing.push('source');
      return { ok: false, reason: 'value ' + JSON.stringify(claim.value) + ' not found in ' + missing.join(' & ') };
    }
    case 'near': {
      // SCOPED must-include: token within window chars of SOME anchor occurrence. Anchor absent -> FAIL.
      const window = typeof claim.window === 'number' ? claim.window : DEFAULT_WINDOW;
      if (allOccurrences(answer, claim.anchor).length === 0) {
        return { ok: false, reason: 'anchor ' + JSON.stringify(claim.anchor) + ' absent from answer — cannot be near a missing anchor' };
      }
      return tokenNearAnchor(answer, claim.anchor, claim.token, window)
        ? { ok: true }
        : { ok: false, reason: 'token ' + JSON.stringify(claim.token) + ' not within ' + window + ' chars of anchor ' + JSON.stringify(claim.anchor) };
    }
    case 'not-near': {
      // SCOPED must-exclude: token must NOT be within window chars of ANY anchor. Anchor absent -> PASS (vacuous).
      const window = typeof claim.window === 'number' ? claim.window : DEFAULT_WINDOW;
      return !tokenNearAnchor(answer, claim.anchor, claim.token, window)
        ? { ok: true }
        : { ok: false, reason: 'token ' + JSON.stringify(claim.token) + ' within ' + window + ' chars of anchor ' + JSON.stringify(claim.anchor) };
    }
    default:
      return { ok: false, reason: 'unknown claim kind: ' + JSON.stringify(claim.kind) };
  }
}

/**
 * Batch: evaluate every claim against one answer. PURE. Returns
 * `{ pass, results:[{ id, ok, reason? }] }` with `results[i].id = claims[i].id ?? String(i)` and
 * `pass = results.every(r => r.ok)`.
 *
 * @param {object[]} claims
 * @param {string} answer
 * @param {string} source
 * @returns {{ pass: boolean, results: {id:string, ok:boolean, reason?:string}[] }}
 */
export function evaluateClaims(claims, answer, source) {
  // Key each result by the claim's OWN id (exactly as the emitted oracle does — `ok N - <c.id>`), with
  // NO index fallback: inventing a synthetic key would make the in-process result diverge from the
  // oracle's TAP key for an id-less claim. Such claims are rejected upstream by validateClaims / emit,
  // so a well-formed input always has a real id here.
  const results = claims.map((c) => {
    const r = evaluateClaim(c, answer, source);
    return r.ok ? { id: c.id, ok: true } : { id: c.id, ok: false, reason: r.reason };
  });
  return { pass: results.every((r) => r.ok), results };
}

/**
 * Build the source text of a standalone `claims.mjs` oracle for `claims`.
 * The emitted script is dependency-free: it reads the two files utf8, runs each
 * claim mechanically, and prints TAP. The claim list is baked in as a JSON literal.
 *
 * Defensively rejects unknown kinds / missing required fields BEFORE baking — an unvalidated claim
 * would otherwise coerce `undefined` through String() at runtime and "check" the literal "undefined".
 * (Source-grounding of anchors is NOT re-checked here — emit has no source — but the structural
 * shape is. Callers that have the source should run `validateClaims(claims, source)` too.)
 *
 * @param {{id:string, kind:string, text?:string, quote?:string, value?:string}[]} claims
 * @returns {string} the source of a runnable claims.mjs
 */
export function emitProseVerifier(claims) {
  if (!Array.isArray(claims)) throw new TypeError('emitProseVerifier: claims must be an array');
  // Defensive structural validation: reject unknown kinds / missing-or-empty required field rather
  // than coerce. (Source-anchoring is checked by validateClaims, which emit cannot do without the
  // source.) This stops a vacuous claim from being baked into a runnable oracle.
  claims.forEach((c, i) => {
    const where = c && typeof c.id === 'string' && c.id ? JSON.stringify(c.id) : `#${i}`;
    if (!c || typeof c !== 'object') throw new TypeError(`emitProseVerifier: claim ${where} is not an object`);
    // Reject a missing / TAP-unsafe id BEFORE baking — the id is emitted as the TAP test name, so an
    // unsafe one would silently truncate (`AC #1` → `AC`) or read as `undefined`, diverging from the
    // certificate's checkId and the in-process predicate. Never emit an oracle with an unkeyable claim.
    const idProblem = claimIdProblem(c.id, `claim ${where}`);
    if (idProblem) throw new TypeError(`emitProseVerifier: ${idProblem}`);
    if (!Object.prototype.hasOwnProperty.call(CLAIM_KINDS, c.kind)) {
      throw new TypeError(`emitProseVerifier: claim ${where} has unknown kind ${JSON.stringify(c.kind)}`);
    }
    if (SCOPED_KINDS.has(c.kind)) {
      const problem = validateScoped(c, `claim ${where}`);
      if (problem) throw new TypeError(`emitProseVerifier: ${problem}`);
      return;
    }
    const field = CLAIM_KINDS[c.kind];
    if (typeof c[field] !== 'string' || c[field].trim() === '') {
      throw new TypeError(`emitProseVerifier: claim ${where} (kind ${JSON.stringify(c.kind)}) needs a non-empty string ${JSON.stringify(field)}`);
    }
  });
  // Bake the claims in as JSON so the emitted file is a pure data+logic standalone (no import
  // of this module). JSON.stringify is safe here — claim fields are plain strings/ids.
  const baked = JSON.stringify(claims, null, 2);
  return `// claims.mjs — GENERATED by emitProseVerifier (deterministic prose-claim oracle).
// Usage: node claims.mjs <answerFile> <sourceFile>
// Reads both files utf8, checks each baked-in claim, prints TAP (plan + one line/claim).
import { readFileSync } from 'node:fs';

const CLAIMS = ${baked};

const [answerFile, sourceFile] = process.argv.slice(2);
if (!answerFile || !sourceFile) {
  process.stderr.write('usage: node claims.mjs <answerFile> <sourceFile>\\n');
  process.exit(2);
}
const answer = readFileSync(answerFile, 'utf8');
const source = readFileSync(sourceFile, 'utf8');

// The predicate below is SERIALIZED verbatim from prose-verifier.mjs's module-scope
// allOccurrences / tokenNearAnchor / evaluateClaim via Function.prototype.toString — so it is
// byte-identical to the in-process evaluateClaim the bleed-lint runs (single source of truth).
const DEFAULT_WINDOW = ${DEFAULT_WINDOW};
${allOccurrences.toString()}
${tokenNearAnchor.toString()}
${evaluateClaim.toString()}

const lines = [];
lines.push('1..' + CLAIMS.length);
CLAIMS.forEach((c, i) => {
  const n = i + 1;
  const r = evaluateClaim(c, answer, source);
  if (r.ok) lines.push('ok ' + n + ' - ' + c.id);
  else lines.push('not ok ' + n + ' - ' + c.id + ' # ' + r.reason);
});
process.stdout.write(lines.join('\\n') + '\\n');
`;
}

/**
 * A FIXED worked example: a small factual Q with a decorrelated source, a claim set spanning
 * 4 kinds (incl. number-matches and must-exclude), a correctAnswer that passes ALL claims, a
 * wrongAnswer that bakes in a false number, and antiCandidates each violating EXACTLY one claim.
 *
 * The subject (the mass of the dwarf planet Ceres) is decorrelated from any test scaffolding —
 * the only way an answer passes the number/grounding claims is by reproducing the source's text.
 *
 * @returns {{question:string, source:string, claims:object[], correctAnswer:string, wrongAnswer:string, antiCandidates:{requirementId:string, answer:string}[]}}
 */
export function proseExample() {
  const question = 'What is Ceres, and what is its mass?';

  // Decorrelated source: a few sentences with one specific number ("938 quintillion").
  const source = [
    'Ceres is the largest object in the asteroid belt between Mars and Jupiter.',
    'It was the first asteroid to be discovered, found by Giuseppe Piazzi in 1801.',
    'Ceres has a mass of about 938 quintillion kilograms, roughly a third of the belt total.',
    'It is classified as a dwarf planet and is not a gas giant.',
  ].join(' ');

  const claims = [
    { id: 'names-ceres', kind: 'must-include', text: 'Ceres' },
    { id: 'mass-value', kind: 'number-matches', value: '938 quintillion' },
    { id: 'grounded-belt', kind: 'grounded', quote: 'largest object in the asteroid belt' },
    { id: 'no-gas-giant', kind: 'must-exclude', text: 'gas giant' },
  ];

  // Passes ALL claims: names Ceres, carries the grounded phrase + the source number verbatim,
  // and never asserts the forbidden "gas giant".
  const correctAnswer = [
    'Ceres is the largest object in the asteroid belt and is a dwarf planet.',
    'Its mass is about 938 quintillion kilograms.',
  ].join(' ');

  // Bakes in a FALSE number (contradicts the source's "938 quintillion") -> number-matches fails.
  // (It also keeps the grounded phrase and names Ceres, so ONLY the number claim breaks.)
  const wrongAnswer = [
    'Ceres is the largest object in the asteroid belt and is a dwarf planet.',
    'Its mass is about 500 quintillion kilograms.',
  ].join(' ');

  // Each anti-candidate violates EXACTLY one claim, holding the other three.
  const antiCandidates = [
    {
      // violates names-ceres only (drops the name "Ceres"; "this body" instead) — keeps phrase, number, no gas-giant.
      requirementId: 'names-ceres',
      answer: 'This body is the largest object in the asteroid belt and is a dwarf planet. Its mass is about 938 quintillion kilograms.',
    },
    {
      // violates mass-value only (wrong number) — names Ceres, keeps phrase, no gas-giant.
      requirementId: 'mass-value',
      answer: 'Ceres is the largest object in the asteroid belt and is a dwarf planet. Its mass is about 500 quintillion kilograms.',
    },
    {
      // violates grounded-belt only (drops the exact grounded phrase) — names Ceres, keeps number, no gas-giant.
      requirementId: 'grounded-belt',
      answer: 'Ceres is a dwarf planet orbiting between Mars and Jupiter. Its mass is about 938 quintillion kilograms.',
    },
    {
      // violates no-gas-giant only (asserts the forbidden "gas giant") — names Ceres, keeps phrase + number.
      requirementId: 'no-gas-giant',
      answer: 'Ceres is the largest object in the asteroid belt, a dwarf planet, not a gas giant. Its mass is about 938 quintillion kilograms.',
    },
  ];

  return { question, source, claims, correctAnswer, wrongAnswer, antiCandidates };
}
