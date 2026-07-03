// html-verifier — emit a DETERMINISTIC acceptance oracle for an HTML/JS artifact.
//
// The prose adapter gives a text answer a mechanical oracle (string checks → TAP). This is the
// analogue for an INTERACTIVE artifact: a standalone `html-verify.mjs` that drives a REAL headless
// browser (the `agent-browser` CLI) to MEASURE a candidate page — DOM structure, text, attributes,
// and post-interaction behaviour — then asserts each baked-in check deterministically and prints TAP
// in exactly the shape gate-runner's parseTapDetailed/tapComplete read. No model judgment: the
// browser measures, the check predicate decides; a candidate page cannot grade itself.
//
// Division of labour (the honest separation):
//   • the BROWSER (agent-browser) is neutral infrastructure — it renders + measures the named probes.
//   • the CHECK PREDICATE (decideCheck) is pure and is the SINGLE source of truth: the lib uses it,
//     and emitHtmlVerifier embeds its `.toString()` into the standalone so there is NO logic drift.
//
// HONESTY POSTURE — FAIL CLOSED (cross-model-AR-hardened, 2 rounds). Probes run in the candidate page's
// JS realm, so a page could try to fabricate measurements (agent-browser's own `get count` is spoofable
// via a querySelectorAll override — confirmed). Defenses:
//   (a) ATOMIC NATIVE-PRIMITIVE measurement: every probe, in ONE page eval, (i) captures the DOM methods
//       from their PROTOTYPES (Document.prototype.querySelector/querySelectorAll, Element.prototype
//       .getAttribute, the Node.prototype textContent getter), (ii) verifies each is '[native code]',
//       (iii) measures by calling those captured primitives via .call() — bypassing any instance- or
//       subclass-prototype shadowing of textContent/getAttribute/querySelector. Tampered ⇒ returns null.
//       Atomic ⇒ no event-loop turn between the native-check and the measure, so a timer/microtask
//       cannot re-tamper in between (closes the after-check window too).
//   (b) failed `open` / `reload` / ACTION (each run with --json, success checked) ⇒ fail closed.
//   (c) a fresh per-run agent-browser --session ⇒ a stale page can't be measured.
//   (d) dom-count requires a non-negative INTEGER (no `null >= 0` coercion green; no impossible counts).
//   (e) parseJsonEval requires EXACTLY ONE agent-browser envelope on stdout (ambiguous output ⇒ closed).
// IRREDUCIBLE RESIDUAL (stated, not hidden — round-3 AR): the native check ultimately trusts the page
// realm's Function.prototype.toString. A FULLY adversarial page that overrides a DOM method AND
// Function.prototype.toString (to report '[native code]') can defeat __nat(); for existence/count checks
// this is even blindly exploitable (no need to know the expected value). This is NOT closable from inside
// the page realm — agent-browser evaluates in the MAIN world (its own `get count` is equally spoofable,
// confirmed), so there is no clean isolated-world escape via this CLI. It is in the SAME mitigation class
// as the rest of the harness (the code gate likewise relies on the immutability guard + oracle-blindness,
// not a cryptographic sandbox): answer-authors are ORACLE-BLIND, so they cannot author a targeted spoof,
// and every realistic non-adversarial tamper (framework patches, naive spoofs, prototype shadows) fails
// closed. The real fix is a TRANSPORT change — measure via CDP DOM / an isolated world or the engine's
// accessibility tree, out of the page realm — tracked as a follow-up. Until then, HTML-verifier results
// carry this residual and must not be presented as a sandbox-grade guarantee.
// `prop-true` is an EXPLICIT page-trusted escape hatch — it requires `trusted:true` and is barred from
// ordinary structural acceptance checks (use a structural kind instead).
//
// Check kinds (each { id, requirementId, kind, ... }):
//   - dom-exists    { selector }              -> querySelector(selector) is non-null
//   - dom-count     { selector, op, n }       -> querySelectorAll(selector).length <op> n   (op: == >= <= > <)
//   - text-equals   { selector, text }        -> trimmed textContent === text
//   - text-includes { selector, text }        -> textContent includes text
//   - attr-equals   { selector, attr, value } -> getAttribute(attr) === value
//   - prop-true     { expr, trusted:true }    -> page-JS boolean is truthy (TRUSTED escape hatch only)
//   - after         { actions[], then }       -> run actions (click/press/type/wait) on a FRESHLY-RELOADED
//                                                page, THEN assert `then` (any non-after check) — verifies
//                                                INTERACTIVE behaviour, isolated per check by the reload.
//
// Emitted TAP: a `1..N` plan plus one `ok <n> - <id>` / `not ok <n> - <id> # <reason>` per check.

const ACTION_TYPES = new Set(['click', 'press', 'type', 'wait']);

// The known check kinds and the fields each requires. `after` is special-cased (nested then-check).
const KIND_FIELDS = {
  'dom-exists': ['selector'],
  'dom-count': ['selector'],          // op/n validated specially
  'text-equals': ['selector', 'text'],
  'text-includes': ['selector', 'text'],
  'attr-equals': ['selector', 'attr', 'value'],
  'prop-true': ['expr'],
  after: null,
};

// Capture the native DOM measurement primitives FROM THEIR PROTOTYPES and expose a __nat() guard. By
// reading from Document.prototype / Element.prototype / the Node.prototype textContent getter and
// CALLING them via .call(), measurements are immune to a page shadowing textContent/getAttribute/
// querySelector on instances or subclass prototypes (the round-2 AR CRITICAL).
const NATIVE_CAPTURE = "var __F=Function.prototype.toString;function __n(f){try{return __F.call(f).indexOf('[native code]')>=0;}catch(e){return false;}}var __qs=Document.prototype.querySelector,__qsa=Document.prototype.querySelectorAll,__ga=Element.prototype.getAttribute,__tcd=Object.getOwnPropertyDescriptor(Node.prototype,'textContent'),__tc=__tcd&&__tcd.get;function __nat(){return __n(__qs)&&__n(__qsa)&&__n(__ga)&&!!__tc&&__n(__tc);}";

// The raw per-kind measurement expression — uses the CAPTURED native primitives (__qs/__qsa/__ga/__tc).
function measureJs(check) {
  switch (check.kind) {
    case 'dom-exists': return `!!__qs.call(document,${JSON.stringify(check.selector)})`;
    case 'dom-count': return `__qsa.call(document,${JSON.stringify(check.selector)}).length`;
    case 'text-equals':
    case 'text-includes': return `(function(){var __e=__qs.call(document,${JSON.stringify(check.selector)});return __e?__tc.call(__e):null;})()`;
    case 'attr-equals': return `(function(){var __e=__qs.call(document,${JSON.stringify(check.selector)});return __e?__ga.call(__e,${JSON.stringify(check.attr)}):null;})()`;
    case 'prop-true': return `!!(${check.expr})`;
    case 'after': return measureJs(check.then);
    default: return 'null';
  }
}

// ── PURE: the per-check probe — page-JS that ATOMICALLY checks the measurement surface is native and,
// only then, measures via the captured native primitives, returning a TAGGED result IN ONE eval:
//   { t:false }            → INTEGRITY failure: the surface was tampered (DOM/native methods overridden).
//   { t:true, v:<value> }  → measured: v is the value (which may be null for an ABSENT element — a real
//                            predicate result, NOT an integrity failure).
// The driver BAILS (TAP `Bail out!` ⇒ gate 'incomplete') on `t:false` (or an unevaluable probe), so a
// tamper at ANY probe — including a mid-run re-tamper AFTER a page-level check — can NEVER masquerade as
// a real check failure (and so can never falsely CERTIFY a verifier). An absent-element `v:null` flows to
// decideCheck and reds honestly. Self-contained (no closure) so it embeds into the standalone.
export function probeJs(check) {
  return `(function(){${NATIVE_CAPTURE}if(!__nat())return {t:false};return {t:true,v:(${measureJs(check)})};})()`;
}

// ── PURE: the decision predicate — the SINGLE source of truth (embedded into the standalone). ──
export function decideCheck(check, value) {
  switch (check.kind) {
    case 'dom-exists':
      return value === true ? { ok: true } : { ok: false, reason: `no element matches ${JSON.stringify(check.selector)}` };
    case 'dom-count': {
      // FAIL CLOSED unless the count is a non-negative INTEGER. Without this, JS coercion makes
      // `null >= 0` true (a crashed probe greens), and a negative/fractional value is impossible for a
      // real querySelectorAll().length ⇒ a spoofed/corrupt measurement.
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return { ok: false, reason: `count measurement is not a non-negative integer (${JSON.stringify(value)}) for ${JSON.stringify(check.selector)} — failing closed` };
      }
      const op = check.op || '==';
      const n = check.n;
      const pass = op === '==' ? value === n : op === '>=' ? value >= n : op === '<=' ? value <= n
        : op === '>' ? value > n : op === '<' ? value < n : false;
      return pass ? { ok: true } : { ok: false, reason: `count ${value} not ${op} ${n} for ${JSON.stringify(check.selector)}` };
    }
    case 'text-equals':
      return (value != null && String(value).trim() === check.text)
        ? { ok: true } : { ok: false, reason: `text ${JSON.stringify(value)} !== ${JSON.stringify(check.text)} for ${JSON.stringify(check.selector)}` };
    case 'text-includes':
      return (value != null && String(value).includes(check.text))
        ? { ok: true } : { ok: false, reason: `text ${JSON.stringify(value)} missing ${JSON.stringify(check.text)} for ${JSON.stringify(check.selector)}` };
    case 'attr-equals':
      return value === check.value
        ? { ok: true } : { ok: false, reason: `attr ${check.attr}=${JSON.stringify(value)} !== ${JSON.stringify(check.value)} for ${JSON.stringify(check.selector)}` };
    case 'prop-true':
      return value === true ? { ok: true } : { ok: false, reason: `expression not truthy: ${JSON.stringify(check.expr)}` };
    case 'after':
      return decideCheck(check.then, value);   // value = the post-action probe of the then-check
    default:
      return { ok: false, reason: `unknown check kind ${JSON.stringify(check.kind)}` };
  }
}

// ── PURE: compile checks → a render plan (static probes + reload-isolated interactive checks). ──
export function planFor(checks) {
  const staticProbes = [];
  const interactive = [];
  for (const c of checks) {
    if (c.kind === 'after') interactive.push({ key: c.id, actions: Array.isArray(c.actions) ? c.actions : [], js: probeJs(c) });
    else staticProbes.push({ key: c.id, js: probeJs(c) });
  }
  return { staticProbes, interactive };
}

/**
 * Validate a check list BEFORE it is baked into an oracle. Rejects unknown kinds, missing/empty required
 * fields, bad dom-count op/n, malformed `after`, and a `prop-true` without `trusted:true` (the page-trusted
 * escape hatch must be explicit — it bypasses the native-primitive measurement discipline). Returns
 * { valid, problems }. `id` shape + uniqueness is enforced (the gate keys on it).
 */
export function validateHtmlChecks(checks) {
  const problems = [];
  if (!Array.isArray(checks)) return { valid: false, problems: ['checks must be an array'] };
  const seen = new Set();
  const validateOne = (c, where, allowAfter) => {
    if (!c || typeof c !== 'object') { problems.push(`${where}: not an object`); return; }
    if (!Object.prototype.hasOwnProperty.call(KIND_FIELDS, c.kind)) {
      problems.push(`${where}: unknown kind ${JSON.stringify(c.kind)} (must be one of ${Object.keys(KIND_FIELDS).join(', ')})`);
      return;
    }
    if (c.kind === 'after') {
      if (!allowAfter) { problems.push(`${where}: nested 'after' is not allowed in a then-check`); return; }
      if (!Array.isArray(c.actions) || c.actions.length === 0) problems.push(`${where}: 'after' needs a non-empty actions array`);
      else c.actions.forEach((a, j) => {
        if (!a || !ACTION_TYPES.has(a.type)) problems.push(`${where}: action #${j} has invalid type ${JSON.stringify(a && a.type)} (one of ${[...ACTION_TYPES].join(', ')})`);
        else if ((a.type === 'click' || a.type === 'type') && (typeof a.selector !== 'string' || a.selector === '')) problems.push(`${where}: action #${j} (${a.type}) needs a non-empty selector`);
        else if (a.type === 'press' && (typeof a.key !== 'string' || a.key === '')) problems.push(`${where}: action #${j} (press) needs a non-empty key`);
        else if (a.type === 'type' && typeof a.text !== 'string') problems.push(`${where}: action #${j} (type) needs a text string`);
        else if (a.type === 'wait' && (typeof a.ms !== 'number' || !Number.isFinite(a.ms) || a.ms < 0)) problems.push(`${where}: action #${j} (wait) needs a non-negative ms number`);
      });
      if (c.then === undefined) problems.push(`${where}: 'after' needs a then-check`);
      else validateOne(c.then, `${where}.then`, false);
      return;
    }
    if (c.kind === 'prop-true' && c.trusted !== true) {
      problems.push(`${where}: kind 'prop-true' is a page-TRUSTED escape hatch — it must set trusted:true explicitly (prefer a structural kind for acceptance checks)`);
    }
    if (c.kind === 'dom-count') {
      if (typeof c.n !== 'number' || !Number.isInteger(c.n) || c.n < 0) problems.push(`${where}: dom-count needs a non-negative integer n`);
      if (c.op !== undefined && !['==', '>=', '<=', '>', '<'].includes(c.op)) problems.push(`${where}: dom-count op ${JSON.stringify(c.op)} invalid`);
    }
    for (const f of KIND_FIELDS[c.kind]) {
      if (typeof c[f] !== 'string' || c[f] === '') problems.push(`${where}: kind ${JSON.stringify(c.kind)} needs a non-empty string ${JSON.stringify(f)}`);
    }
  };
  checks.forEach((c, i) => {
    const where = c && typeof c.id === 'string' && c.id ? `check ${JSON.stringify(c.id)}` : `check #${i}`;
    if (c && typeof c === 'object') {
      if (typeof c.id !== 'string' || c.id === '') problems.push(`${where}: needs a non-empty string id`);
      else if (seen.has(c.id)) problems.push(`${where}: duplicate id`);
      else seen.add(c.id);
    }
    validateOne(c, where, true);
  });
  return { valid: problems.length === 0, problems };
}

// ── PURE: snapshot → TAP (uses decideCheck). Returns { results, tap }. ──
export function evaluateChecks(checks, snapshot) {
  const results = checks.map((c) => ({ id: c.id, ...decideCheck(c, snapshot ? snapshot[c.id] : undefined) }));
  const lines = ['1..' + checks.length];
  results.forEach((r, i) => {
    const n = i + 1;
    lines.push(r.ok ? `ok ${n} - ${r.id}` : `not ok ${n} - ${r.id} # ${r.reason}`);
  });
  return { results, tap: lines.join('\n') + '\n' };
}

// Parse an agent-browser `--json` envelope { success, data, error } from stdout. Requires EXACTLY ONE
// envelope line (ambiguous/extra envelopes ⇒ fail closed). Returns { ok, value } where value is
// data.result (eval). ok=false ⇒ a failed/absent/ambiguous measurement (caller fails closed).
function parseJsonEval(out) {
  const envelopes = [];
  for (const raw of String(out).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o && typeof o === 'object' && 'success' in o) envelopes.push(o);
  }
  if (envelopes.length !== 1) return { ok: false, value: null };   // exactly one, else ambiguous → closed
  const o = envelopes[0];
  if (!o.success) return { ok: false, value: null };
  const v = o.data && Object.prototype.hasOwnProperty.call(o.data, 'result') ? o.data.result : null;
  return { ok: true, value: v === undefined ? null : v };
}

/**
 * Drive a browser (via the injected `exec`) to MEASURE every probe → a snapshot. `exec(args)` runs the
 * agent-browser CLI with `args` and returns stdout. Injectable: tests use a deterministic fake, the real
 * run uses agent-browser. FAIL-CLOSED throughout: a failed `open`/`reload`/ACTION, or any failed/tampered
 * probe (the atomic native guard returns null), yields `null` — which every decideCheck kind treats as a
 * failure. Interactive (`after`) checks reload first so side-effects are isolated.
 */
export function renderSnapshot(htmlPath, plan, { exec, sessionArgs = [] }) {
  if (typeof exec !== 'function') throw new TypeError('renderSnapshot: exec must be a function');
  const url = String(htmlPath).startsWith('file://') ? String(htmlPath) : ('file://' + htmlPath);
  const cmd = (args) => parseJsonEval(exec([...args, '--json', ...sessionArgs]));
  const ev = (js) => cmd(['eval', js]);
  const runAction = (a) => {
    if (a.type === 'click') return cmd(['click', a.selector]);
    if (a.type === 'press') return cmd(['press', a.key]);
    if (a.type === 'type') return cmd(['type', a.selector, a.text]);
    if (a.type === 'wait') return cmd(['wait', String(a.ms)]);
    return { ok: false, value: null };
  };
  // Run a probe → { bail:true } if the measurement surface was tampered (or the probe is unevaluable),
  // else { value } (value may be null for an absent element — a real predicate result). An INTEGRITY
  // failure at ANY probe (incl. a mid-run re-tamper) BAILS (⇒ gate 'incomplete'), so it can never be
  // mistaken for a real requirement failure (which would falsely certify a trivial verifier — AR).
  const probe = (js) => {
    const r = ev(js);
    if (!r.ok || !r.value || typeof r.value !== 'object' || r.value.t !== true) return { bail: true };
    return { value: r.value.v === undefined ? null : r.value.v };
  };
  const snapshot = {};

  if (!cmd(['open', url]).ok) return { snapshot, bail: 'page did not load' };
  for (const p of plan.staticProbes) { const r = probe(p.js); if (r.bail) return { snapshot, bail: `measurement integrity failure at ${p.key}` }; snapshot[p.key] = r.value; }
  for (const ic of plan.interactive) {
    if (!cmd(['reload']).ok) return { snapshot, bail: `reload failed before ${ic.key}` };
    let actionFailed = false;
    for (const a of ic.actions) { if (!runAction(a).ok) { actionFailed = true; break; } }  // AR-2: a failed action fails THAT check closed (a predicate-side failure, not an integrity bail)
    if (actionFailed) { snapshot[ic.key] = null; continue; }
    const r = probe(ic.js);
    if (r.bail) return { snapshot, bail: `measurement integrity failure at ${ic.key}` };
    snapshot[ic.key] = r.value;
  }
  return { snapshot, bail: null };
}

/** End-to-end (lib side): measure with `exec` then evaluate. Returns { snapshot, bail, results?, tap }.
 *  An integrity bail yields a TAP `Bail out!` (the gate reads it as 'incomplete'), NOT all-not-ok. */
export function runHtmlVerifier({ htmlPath, checks, exec }) {
  const { snapshot, bail } = renderSnapshot(htmlPath, planFor(checks), { exec });
  if (bail) return { snapshot, bail, results: [], tap: `Bail out! ${bail}\n` };
  return { snapshot, bail: null, ...evaluateChecks(checks, snapshot) };
}

/**
 * Build the source of a standalone `html-verify.mjs` for `checks`. Run as
 * `node html-verify.mjs <candidate.html>` it drives agent-browser (bin from $GODCODE_AB_BIN, default
 * 'agent-browser') over the BAKED render plan, then prints TAP. The decision predicate is the embedded
 * `decideCheck` (this module's exact function), so the standalone and the lib never diverge.
 */
export function emitHtmlVerifier(checks) {
  const v = validateHtmlChecks(checks);
  if (!v.valid) throw new TypeError('emitHtmlVerifier: invalid checks:\n  - ' + v.problems.join('\n  - '));
  const baked = JSON.stringify(checks, null, 2);
  const plan = JSON.stringify(planFor(checks), null, 2);
  return `// html-verify.mjs — GENERATED by emitHtmlVerifier (deterministic HTML acceptance oracle).
// Usage: node html-verify.mjs <candidate.html>     (drives agent-browser; prints TAP)
// FAIL-CLOSED: a failed open/reload/action, a tampered DOM-measurement surface, or any failed probe ⇒ not ok.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const CHECKS = ${baked};
const PLAN = ${plan};
const AB = process.env.GODCODE_AB_BIN || 'agent-browser';
const SESS = ['--session', 'gcv-' + process.pid];   // fresh per run — no stale shared page

const candidate = process.argv[2];
if (!candidate) { process.stderr.write('usage: node html-verify.mjs <candidate.html>\\n'); process.exit(2); }

function exec(args) {
  try { return execFileSync(AB, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return (e && (e.stdout || '')) || ''; }
}
function parseJsonEval(out) {
  const envelopes = [];
  for (const raw of String(out).split('\\n')) {
    const line = raw.trim(); if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o && typeof o === 'object' && 'success' in o) envelopes.push(o);
  }
  if (envelopes.length !== 1) return { ok: false, value: null };
  const o = envelopes[0];
  if (!o.success) return { ok: false, value: null };
  const v = o.data && Object.prototype.hasOwnProperty.call(o.data, 'result') ? o.data.result : null;
  return { ok: true, value: v === undefined ? null : v };
}
// EMBEDDED — the lib's exact decision predicate (single source of truth, no drift):
const decideCheck = ${decideCheck.toString()};

const url = candidate.startsWith('file://') ? candidate : ('file://' + path.resolve(candidate));   // absolute file URL (candidate may be a relative path in the gate worktree)
const cmd = (args) => parseJsonEval(exec([...args, '--json', ...SESS]));
const ev = (js) => cmd(['eval', js]);
function runAction(a) {
  if (a.type === 'click') return cmd(['click', a.selector]);
  if (a.type === 'press') return cmd(['press', a.key]);
  if (a.type === 'type') return cmd(['type', a.selector, a.text]);
  if (a.type === 'wait') return cmd(['wait', String(a.ms)]);
  return { ok: false, value: null };
}
// Each probe returns a TAGGED result {t,v}: t:false ⇒ INTEGRITY failure (surface tampered) ⇒ BAIL (gate
// 'incomplete'); t:true ⇒ measured (v may be null = absent element = a real predicate fail). A tamper at
// ANY probe (incl. mid-run) bails, so it can never fake a check failure / falsely certify (AR).
const probe = (js) => { const r = ev(js); if (!r.ok || !r.value || typeof r.value !== 'object' || r.value.t !== true) return { bail: true }; return { value: r.value.v === undefined ? null : r.value.v }; };
const snap = {};
let bail = null;
if (!cmd(['open', url]).ok) bail = 'page did not load';
else {
  for (const p of PLAN.staticProbes) { const r = probe(p.js); if (r.bail) { bail = 'measurement integrity failure at ' + p.key; break; } snap[p.key] = r.value; }
  if (!bail) for (const ic of PLAN.interactive) {
    if (!cmd(['reload']).ok) { bail = 'reload failed before ' + ic.key; break; }
    let actionFailed = false;
    for (const a of ic.actions) { if (!runAction(a).ok) { actionFailed = true; break; } }
    if (actionFailed) { snap[ic.key] = null; continue; }
    const r = probe(ic.js); if (r.bail) { bail = 'measurement integrity failure at ' + ic.key; break; } snap[ic.key] = r.value;
  }
}
try { exec(['close', ...SESS]); } catch {}

if (bail) {
  process.stdout.write('Bail out! ' + bail + '\\n');
} else {
  const lines = ['1..' + CHECKS.length];
  CHECKS.forEach((c, i) => {
    const r = decideCheck(c, snap[c.id]);
    lines.push(r.ok ? ('ok ' + (i + 1) + ' - ' + c.id) : ('not ok ' + (i + 1) + ' - ' + c.id + ' # ' + r.reason));
  });
  process.stdout.write(lines.join('\\n') + '\\n');
}
`;
}

/**
 * A FIXED worked example: a tiny INTERACTIVE spec ("a +1 button that increments a counter starting at
 * 0"). Checks span structure (button + counter exist), initial state (count is "0"), and BEHAVIOUR
 * (after a click the count is "1"). correctHtml passes all; redHtml fails the baseline; each
 * anti-candidate breaks AT LEAST its own requirement's check (interactive checks couple — a missing
 * `#inc` also fails the click probe — so a structural break can cascade to the behaviour check; all
 * checks here share one requirement, so nothing bleeds across requirements).
 */
export function htmlExample() {
  const spec = 'A page with a button labelled "+1" and a counter starting at 0; clicking the button increments the counter by 1.';
  const checks = [
    { id: 'has-button', requirementId: 'r-counter', kind: 'dom-exists', selector: '#inc' },
    { id: 'has-count', requirementId: 'r-counter', kind: 'dom-exists', selector: '#count' },
    { id: 'starts-zero', requirementId: 'r-counter', kind: 'text-equals', selector: '#count', text: '0' },
    { id: 'click-increments', requirementId: 'r-counter', kind: 'after', actions: [{ type: 'click', selector: '#inc' }], then: { id: 'click-increments', kind: 'text-equals', selector: '#count', text: '1' } },
  ];
  const page = (script) => `<!doctype html><html><body><button id="inc">+1</button><span id="count">0</span><script>${script}</script></body></html>`;
  const correctHtml = page(`let n=0;const c=document.getElementById('count');document.getElementById('inc').addEventListener('click',()=>{n++;c.textContent=String(n);});`);
  // RED baseline: button does nothing (no handler) → click-increments fails, starts-zero still passes.
  const redHtml = page(`/* no handler — counter never changes */`);
  const antiCandidates = [
    // breaks has-button (wrong id on the button → #inc absent; the click probe can't target it either).
    { id: 'anti-button', requirementId: 'r-counter', html: `<!doctype html><html><body><button id="nope">+1</button><span id="count">0</span><script>let n=0;const c=document.getElementById('count');document.querySelector('button').addEventListener('click',()=>{n++;c.textContent=String(n);});</script></body></html>` },
    // breaks starts-zero (counter renders "1" initially; clicking then yields "2", not "1").
    { id: 'anti-start', requirementId: 'r-counter', html: page(`let n=1;const c=document.getElementById('count');c.textContent='1';document.getElementById('inc').addEventListener('click',()=>{n++;c.textContent=String(n);});`) },
    // breaks click-increments cleanly (structure + start-0 intact, but increments by 2 → "2" not "1").
    { id: 'anti-click', requirementId: 'r-counter', html: page(`let n=0;const c=document.getElementById('count');document.getElementById('inc').addEventListener('click',()=>{n+=2;c.textContent=String(n);});`) },
  ];
  return { spec, checks, correctHtml, redHtml, antiCandidates };
}
