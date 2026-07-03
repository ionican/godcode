// html-verifier.test — the HTML acceptance oracle, hermetic (NO real browser).
//
// Layers: (1) the pure decision predicate + compile + validate; (2) renderSnapshot driven by a FAKE
// exec (records the agent-browser command sequence); (3) the EMITTED standalone html-verify.mjs run
// end-to-end against a FAKE agent-browser stub (proves the embedded decideCheck + TAP shape with zero
// drift) for a CORRECT page (all green) and a BROKEN page (the behaviour check reds).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  decideCheck, evaluateChecks, planFor, probeJs, validateHtmlChecks, renderSnapshot, emitHtmlVerifier, htmlExample,
} from './html-verifier.mjs';

const EX = htmlExample();

test('decideCheck: per-kind pass/fail', () => {
  assert.equal(decideCheck({ kind: 'dom-exists', selector: '#x' }, true).ok, true);
  assert.equal(decideCheck({ kind: 'dom-exists', selector: '#x' }, false).ok, false);
  assert.equal(decideCheck({ kind: 'dom-count', selector: 'li', op: '>=', n: 3 }, 4).ok, true);
  assert.equal(decideCheck({ kind: 'dom-count', selector: 'li', op: '>=', n: 3 }, 2).ok, false);
  assert.equal(decideCheck({ kind: 'dom-count', selector: 'li', n: 2 }, 2).ok, true, 'default op is ==');
  assert.equal(decideCheck({ kind: 'text-equals', selector: '#c', text: '0' }, ' 0 ').ok, true, 'trimmed equality');
  assert.equal(decideCheck({ kind: 'text-equals', selector: '#c', text: '0' }, '1').ok, false);
  assert.equal(decideCheck({ kind: 'text-includes', selector: '#c', text: 'core' }, 'Score: 9').ok, true);
  assert.equal(decideCheck({ kind: 'attr-equals', selector: 'a', attr: 'href', value: '/x' }, '/x').ok, true);
  assert.equal(decideCheck({ kind: 'attr-equals', selector: 'a', attr: 'href', value: '/x' }, null).ok, false, 'missing attr fails');
  assert.equal(decideCheck({ kind: 'prop-true', expr: 'foo' }, true).ok, true);
  assert.equal(decideCheck({ kind: 'prop-true', expr: 'foo' }, false).ok, false);
  // after delegates to its then-check against the post-action value.
  assert.equal(decideCheck({ kind: 'after', actions: [], then: { kind: 'text-equals', selector: '#c', text: '1' } }, '1').ok, true);
  assert.equal(decideCheck({ kind: 'after', actions: [], then: { kind: 'text-equals', selector: '#c', text: '1' } }, '0').ok, false);
  assert.equal(decideCheck({ kind: 'nope' }, 1).ok, false, 'unknown kind fails closed');
});

test('probeJs: atomic native-primitive guard + TAGGED {t,v} result (integrity ≠ value)', () => {
  const p = probeJs({ kind: 'dom-count', selector: 'li' });
  assert.match(p, /__nat\(\)/, 'every probe gates on the native-surface check');
  assert.match(p, /\{t:false\}/, 'a tampered surface returns the integrity-failure tag');
  assert.match(p, /\{t:true,v:/, 'a measured probe returns the tagged value');
  assert.match(p, /__qsa\.call\(document,"li"\)\.length/, 'measures via the CAPTURED native prototype primitive');
  assert.ok(!/document\.querySelector\(/.test(p), 'does NOT read through the spoofable instance/document path');
  assert.match(probeJs({ kind: 'after', then: { kind: 'text-equals', selector: '#c' } }), /__tc\.call/, 'text reads via the native textContent getter');
});

test('planFor: static vs reload-isolated interactive', () => {
  const plan = planFor(EX.checks);
  assert.deepEqual(plan.staticProbes.map((p) => p.key), ['has-button', 'has-count', 'starts-zero']);
  assert.deepEqual(plan.interactive.map((p) => p.key), ['click-increments']);
  assert.deepEqual(plan.interactive[0].actions, [{ type: 'click', selector: '#inc' }]);
});

test('validateHtmlChecks: accepts the example; rejects malformed', () => {
  assert.equal(validateHtmlChecks(EX.checks).valid, true);
  const bad = validateHtmlChecks([
    { id: 'a', kind: 'mystery' },
    { id: 'b', kind: 'dom-exists' },                                   // missing selector
    { id: 'c', kind: 'dom-count', selector: 'li', op: '≈', n: 1 },     // bad op
    { id: 'a', kind: 'dom-exists', selector: '#x' },                   // duplicate id
    { id: 'd', kind: 'after', actions: [], then: { kind: 'dom-exists', selector: '#x' } },  // empty actions
    { id: 'e', kind: 'after', actions: [{ type: 'jump' }], then: { kind: 'after', actions: [], then: {} } }, // bad action + nested after
    { id: 'f', kind: 'dom-count', selector: 'li', n: -1 },             // negative n
    { id: 'g', kind: 'prop-true', expr: 'window.x' },                  // prop-true WITHOUT trusted:true
  ]);
  assert.equal(bad.valid, false);
  assert.ok(bad.problems.some((p) => /unknown kind/.test(p)));
  assert.ok(bad.problems.some((p) => /needs a non-empty string "selector"/.test(p)));
  assert.ok(bad.problems.some((p) => /op .* invalid/.test(p)));
  assert.ok(bad.problems.some((p) => /duplicate id/.test(p)));
  assert.ok(bad.problems.some((p) => /non-empty actions/.test(p)));
  assert.ok(bad.problems.some((p) => /nested 'after' is not allowed/.test(p)));
  assert.ok(bad.problems.some((p) => /non-negative integer n/.test(p)));
  assert.ok(bad.problems.some((p) => /must set trusted:true/.test(p)), 'prop-true requires explicit trusted:true');
  // prop-true WITH trusted:true is accepted.
  assert.equal(validateHtmlChecks([{ id: 'p', kind: 'prop-true', expr: 'true', trusted: true }]).valid, true);
});

test('evaluateChecks: correct snapshot greens; broken snapshot reds only the behaviour check', () => {
  const good = evaluateChecks(EX.checks, { 'has-button': true, 'has-count': true, 'starts-zero': '0', 'click-increments': '1' });
  assert.ok(good.results.every((r) => r.ok), 'all green on a correct measurement');
  assert.match(good.tap, /^1\.\.4\n/);
  const broken = evaluateChecks(EX.checks, { 'has-button': true, 'has-count': true, 'starts-zero': '0', 'click-increments': '0' });
  assert.deepEqual(broken.results.filter((r) => !r.ok).map((r) => r.id), ['click-increments']);
  assert.match(broken.tap, /not ok 4 - click-increments/);
});

// Tagged probe results: M(v) is a measured value; T is an integrity failure (tampered surface).
const M = (v) => ({ t: true, v });
const TAMPER = { t: false };
const envOf = (result) => JSON.stringify({ success: true, data: { result }, error: null }) + '\n';

test('renderSnapshot: open → static probes → reload+click → interactive probe, in order', () => {
  const calls = [];
  // eval order (probes self-tag integrity): has-button, has-count, starts-zero, click-increments.
  const evalResponses = [M(true), M(true), M('0'), M('1')];
  let ei = 0;
  const exec = (args) => {
    calls.push(args);
    if (args[0] === 'eval') return envOf(evalResponses[ei++]);
    return JSON.stringify({ success: true, data: {}, error: null }) + '\n';
  };
  const r = renderSnapshot('/tmp/cand.html', planFor(EX.checks), { exec });
  assert.equal(r.bail, null, 'a measurable page does not bail');
  assert.deepEqual(r.snapshot, { 'has-button': true, 'has-count': true, 'starts-zero': '0', 'click-increments': '1' });
  assert.equal(calls[0][0], 'open');
  assert.match(calls[0][1], /^file:\/\/\/tmp\/cand\.html$/);
  const reloadIdx = calls.findIndex((c) => c[0] === 'reload');
  const clickIdx = calls.findIndex((c) => c[0] === 'click');
  assert.ok(reloadIdx >= 0 && clickIdx > reloadIdx, 'interactive check reloads to pristine BEFORE acting');
  assert.ok(calls.find((c) => c[0] === 'click').includes('--json'), 'actions run with --json so failures are detectable');
});

test('renderSnapshot: an absent element (v:null, integrity OK) REDS — it does NOT bail', () => {
  // text/attr on a missing node ⇒ {t:true, v:null} ⇒ a real predicate failure, not an integrity bail.
  const evalResponses = [M(true), M(true), M(null), M('1')];   // starts-zero measures null (absent)
  let ei = 0;
  const exec = (args) => (args[0] === 'eval' ? envOf(evalResponses[ei++]) : JSON.stringify({ success: true, data: {}, error: null }) + '\n');
  const r = renderSnapshot('/tmp/x.html', planFor(EX.checks), { exec });
  assert.equal(r.bail, null, 'an absent element is a predicate result, not an integrity failure');
  assert.equal(r.snapshot['starts-zero'], null);
  assert.equal(decideCheck(EX.checks[2], r.snapshot['starts-zero']).ok, false, 'absent #count ⇒ starts-zero reds (a valid kill)');
});

test('AR-2: a failed ACTION ⇒ the interactive check fails closed (null), not a bail', () => {
  const exec = (args) => {
    if (args[0] === 'click') return JSON.stringify({ success: false, data: null, error: 'element not found' }) + '\n';
    if (args[0] === 'eval') return envOf(M(true));
    return JSON.stringify({ success: true, data: {}, error: null }) + '\n';
  };
  const r = renderSnapshot('/tmp/x.html', planFor(EX.checks), { exec });
  assert.equal(r.bail, null, 'a failed action is a predicate-side failure, not an integrity bail');
  assert.equal(r.snapshot['click-increments'], null, 'a failed action ⇒ interactive measurement is null');
  assert.equal(decideCheck(EX.checks[3], r.snapshot['click-increments']).ok, false);
});

test('AR-CRIT: a mid-run TAMPER at ANY probe ⇒ BAIL (cannot fake a kill / falsely certify)', () => {
  // has-button + has-count measure fine; starts-zero's probe reports a tampered surface (t:false) ⇒ bail.
  const evalResponses = [M(true), M(true), TAMPER, M('1')];
  let ei = 0;
  const exec = (args) => (args[0] === 'eval' ? envOf(evalResponses[ei++]) : JSON.stringify({ success: true, data: {}, error: null }) + '\n');
  const r = renderSnapshot('/tmp/x.html', planFor(EX.checks), { exec });
  assert.match(r.bail, /integrity failure at starts-zero/, 'a tamper at a later probe bails — never a fake check failure');
});

test('AR-MED: parseJsonEval ambiguous (≠1 envelope) ⇒ unmeasurable ⇒ BAIL (incomplete, not fake-fail)', () => {
  const exec = (args) => {
    if (args[0] === 'eval') return '{"success":true,"data":{"result":{"t":true,"v":true}},"error":null}\n{"success":true,"data":{"result":{"t":true,"v":true}},"error":null}\n';
    return JSON.stringify({ success: true, data: {}, error: null }) + '\n';
  };
  const r = renderSnapshot('/tmp/x.html', planFor(EX.checks), { exec });
  assert.ok(r.bail, 'ambiguous output ⇒ the probe is unevaluable ⇒ bail (not a fake check failure)');
});

// A fake `agent-browser` stub: replays an ordered list of `eval` results (as --json envelopes) across
// SEPARATE process invocations (index persisted in a sidecar .idx file); non-eval commands succeed.
function writeFakeAb(dir, evalResponses) {
  const fixture = path.join(dir, 'fixture.json');
  writeFileSync(fixture, JSON.stringify({ evals: evalResponses }));
  const bin = path.join(dir, 'fake-ab.cjs');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const fx = JSON.parse(fs.readFileSync(process.env.GODCODE_AB_FAKE, 'utf8'));
if (process.argv[2] === 'eval') {
  const sf = process.env.GODCODE_AB_FAKE + '.idx';
  let i = 0; try { i = parseInt(fs.readFileSync(sf, 'utf8'), 10) || 0; } catch {}
  fs.writeFileSync(sf, String(i + 1));
  // wrap each embedded value as the TAGGED probe result {t,v}; the '__TAMPER__' sentinel ⇒ {t:false}.
  const e = fx.evals[i];
  const result = (e === '__TAMPER__') ? { t: false } : { t: true, v: e };
  process.stdout.write(JSON.stringify({ success: true, data: { result }, error: null }) + '\\n');
} else { process.stdout.write(JSON.stringify({ success: true, data: {}, error: null }) + '\\n'); }
`);
  chmodSync(bin, 0o755);
  return { bin, fixture };
}

test('emitHtmlVerifier: the STANDALONE greens a correct page and reds a broken one (fake browser)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-html-emit-'));
  try {
    const verifier = path.join(dir, 'html-verify.mjs');
    writeFileSync(verifier, emitHtmlVerifier(EX.checks));
    // eval order (probes self-tag integrity): has-button, has-count, starts-zero, click. CORRECT → green.
    const good = writeFakeAb(path.join(mkdtempSync(path.join(dir, 'good-'))), [true, true, '0', '1']);
    const goodTap = execFileSync('node', [verifier, '/tmp/whatever.html'], {
      encoding: 'utf8', env: { ...process.env, GODCODE_AB_BIN: good.bin, GODCODE_AB_FAKE: good.fixture },
    });
    assert.match(goodTap, /^1\.\.4\n/);
    assert.equal((goodTap.match(/^ok /gm) || []).length, 4, 'all four checks green');
    assert.ok(!/not ok/.test(goodTap));

    // BROKEN page (loads + native): click does nothing → counter stays "0" → behaviour check REDS
    // (a real predicate failure → `not ok`, NOT a bail).
    const bad = writeFakeAb(path.join(mkdtempSync(path.join(dir, 'bad-'))), [true, true, '0', '0']);
    const badTap = execFileSync('node', [verifier, '/tmp/whatever.html'], {
      encoding: 'utf8', env: { ...process.env, GODCODE_AB_BIN: bad.bin, GODCODE_AB_FAKE: bad.fixture },
    });
    assert.match(badTap, /not ok 4 - click-increments/);
    assert.equal((badTap.match(/^ok /gm) || []).length, 3, 'structure + initial state still green');

    // TAMPERED page: the FIRST probe reports a non-native surface ({t:false}) ⇒ BAIL (gate reads
    // 'incomplete'), NOT a fake all-not-ok — so a sabotaged page can never count as a real check failure.
    const evil = writeFakeAb(path.join(mkdtempSync(path.join(dir, 'evil-'))), ['__TAMPER__', true, '0', '1']);
    const evilTap = execFileSync('node', [verifier, '/tmp/whatever.html'], {
      encoding: 'utf8', env: { ...process.env, GODCODE_AB_BIN: evil.bin, GODCODE_AB_FAKE: evil.fixture },
    });
    assert.match(evilTap, /^Bail out!/, 'an unmeasurable page BAILS (→ incomplete), never fakes check failures');
    assert.ok(!/^1\.\.4/m.test(evilTap) && !/not ok/.test(evilTap), 'no plan / no fake not-ok lines on a bail');

    // MID-RUN tamper: the page measures fine for the first checks, then re-tampers before a later probe
    // ({t:false} at starts-zero) ⇒ BAIL — the certification-critical case (can't fake a late kill).
    const late = writeFakeAb(path.join(mkdtempSync(path.join(dir, 'late-'))), [true, true, '__TAMPER__', '1']);
    const lateTap = execFileSync('node', [verifier, '/tmp/whatever.html'], {
      encoding: 'utf8', env: { ...process.env, GODCODE_AB_BIN: late.bin, GODCODE_AB_FAKE: late.fixture },
    });
    assert.match(lateTap, /^Bail out!/, 'a mid-run re-tamper bails — never a complete not-ok TAP that certify would accept as a kill');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── AR fold (1 CRIT + 2 HIGH) — the oracle must be FAIL-CLOSED ─────────────────────────────────
test('AR-HIGH/MED: dom-count fails CLOSED on non-(non-negative-integer) for EVERY op', () => {
  for (const op of ['==', '>=', '<=', '>', '<']) {
    // null/NaN/string (coercion), and impossible counts (negative, fractional) all fail closed.
    for (const v of [null, undefined, NaN, '3', '0', -1, 1.5]) {
      assert.equal(decideCheck({ kind: 'dom-count', selector: 'li', op, n: 0 }, v).ok, false, `dom-count ${op} 0 must fail on ${JSON.stringify(v)}`);
    }
  }
  // a real non-negative integer measurement still works.
  assert.equal(decideCheck({ kind: 'dom-count', selector: 'li', op: '>=', n: 2 }, 3).ok, true);
  assert.equal(decideCheck({ kind: 'dom-count', selector: 'li', n: 0 }, 0).ok, true, 'zero is a valid count');
});

test('AR-HIGH: every check kind fails CLOSED on a null (failed/absent) measurement', () => {
  assert.equal(decideCheck({ kind: 'dom-exists', selector: '#x' }, null).ok, false);
  assert.equal(decideCheck({ kind: 'text-equals', selector: '#x', text: '0' }, null).ok, false);
  assert.equal(decideCheck({ kind: 'text-includes', selector: '#x', text: '0' }, null).ok, false);
  assert.equal(decideCheck({ kind: 'attr-equals', selector: '#x', attr: 'id', value: 'y' }, null).ok, false);
  assert.equal(decideCheck({ kind: 'prop-true', expr: 'x' }, null).ok, false);
});

test('AR-HIGH: a FAILED open (or stale page) ⇒ BAIL (incomplete), never fake check failures', () => {
  const exec = (args) => {
    if (args[0] === 'open') return JSON.stringify({ success: false, data: null, error: 'nav failed' }) + '\n';
    if (args[0] === 'eval') return JSON.stringify({ success: true, data: { result: true }, error: null }) + '\n'; // even if a stale page would "measure"
    return JSON.stringify({ success: true, data: {}, error: null }) + '\n';
  };
  const r = renderSnapshot('/tmp/x.html', planFor(EX.checks), { exec });
  assert.equal(r.bail, 'page did not load', 'a failed open bails — no stale-page measurement, no fake failures');
});

test('AR-CRIT: a non-tagged / garbage probe result ⇒ BAIL, not a fake check failure', () => {
  // a probe result that is not a {t:true,...} tag (here a raw `false`) is untrustworthy ⇒ bail.
  const exec = (args) => {
    if (args[0] === 'eval') return JSON.stringify({ success: true, data: { result: false }, error: null }) + '\n';
    return JSON.stringify({ success: true, data: {}, error: null }) + '\n';
  };
  const r = renderSnapshot('/tmp/x.html', planFor(EX.checks), { exec });
  assert.match(r.bail, /integrity failure/, 'a garbage probe result bails (→ incomplete), so it can never count as a kill');
});

test('htmlExample: anti-candidates each break exactly one check (by construction, via evaluateChecks)', () => {
  // Simulate each anti-candidate's measured snapshot and assert it fails its OWN requirement's check.
  // (anti-button → has-button false; anti-start → starts-zero "1"; anti-click → click yields "2".)
  const snaps = {
    'anti-button': { 'has-button': false, 'has-count': true, 'starts-zero': '0', 'click-increments': '1' },
    'anti-start': { 'has-button': true, 'has-count': true, 'starts-zero': '1', 'click-increments': '2' },
    'anti-click': { 'has-button': true, 'has-count': true, 'starts-zero': '0', 'click-increments': '2' },
  };
  for (const a of EX.antiCandidates) {
    const r = evaluateChecks(EX.checks, snaps[a.id]);
    assert.ok(r.results.some((x) => !x.ok), `${a.id} must fail at least one check`);
  }
});
