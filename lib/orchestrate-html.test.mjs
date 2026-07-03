// orchestrate-html.test — the HTML objective loop END-TO-END and hermetic (NO real browser).
//
// The gate runs the emitted `html-verify.mjs` as a real OS process; we point it at a FAKE agent-browser
// (GODCODE_AB_BIN) that returns each candidate page's measurements from a `<script id="gc-fake">` it
// embeds (ordered to the plan's probe sequence). So construct → certify → gate → slate runs for real,
// with deterministic measurements — proving the ADAPTER wiring. (Real-DOM behaviour is proven by the
// html-verifier real-browser demo; the orchestration honesty logic is proven by orchestrate-prose.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { orchestrateHtml } from './orchestrate-html.mjs';
import { htmlExample } from './html-verifier.mjs';

const EX = htmlExample();
// eval order (probes self-tag integrity): has-button, has-count, starts-zero, click-increments. Each
// embedded value is wrapped by the fake as the tagged probe result {t:true,v}; '__TAMPER__' ⇒ {t:false}.
const page = (evals) => `<!doctype html><html><body><script id="gc-fake" type="application/json">${JSON.stringify(evals)}</script></body></html>`;
const CORRECT = page([true, true, '0', '1']);          // all pass
const CORRECT2 = page([true, true, '0', '1']).replace('<body>', '<body><!--variant-->');  // a 2nd correct page (distinct source, same behaviour)
const WRONG = page([true, true, '0', '0']);            // click stays 0 → click-increments fails
const RED = page([true, true, '5', '5']);              // starts-zero + click fail (red discriminates)
const ANTI = page([true, true, '0', '2']);             // click yields 2 → click-increments fails (anti killed)
const SABOTAGE = page(['__TAMPER__']);                 // first probe reports a tampered surface → BAIL (incomplete) — must NOT count as a kill

// A fake agent-browser: replays each page's embedded eval list (per --session, reset on `open`).
function writeFakeAb(dir) {
  const bin = path.join(dir, 'fake-ab.cjs');
  writeFileSync(bin, `#!/usr/bin/env node
const fs=require('fs'),os=require('os'),path=require('path');
const argv=process.argv.slice(2), cmd=argv[0];
function sess(){const i=argv.indexOf('--session');return i>=0?argv[i+1]:'default';}
function sf(){return path.join(os.tmpdir(),'gc-fake-ab-'+sess()+'.json');}
function env(r){return JSON.stringify({success:true,data:(r===undefined?{}:{result:r}),error:null})+'\\n';}
if(cmd==='open'){
  const p=String(argv[1]||'').replace(/^file:\\/\\//,'');
  let evals=[]; try{const h=fs.readFileSync(p,'utf8');const m=h.match(/<script id="gc-fake"[^>]*>([\\s\\S]*?)<\\/script>/);if(m)evals=JSON.parse(m[1]);}catch(e){}
  fs.writeFileSync(sf(),JSON.stringify({evals,i:0})); process.stdout.write(env({url:p}));
}else if(cmd==='eval'){
  let st={evals:[],i:0}; try{st=JSON.parse(fs.readFileSync(sf(),'utf8'));}catch(e){}
  const e=st.i<st.evals.length?st.evals[st.i]:null; st.i++; fs.writeFileSync(sf(),JSON.stringify(st));
  // wrap each embedded value as the TAGGED probe result {t,v}; '__TAMPER__' ⇒ {t:false}.
  const result=(e==='__TAMPER__')?{t:false}:{t:true,v:e};
  process.stdout.write(env(result));
}else{ process.stdout.write(env()); }
`);
  chmodSync(bin, 0o755);
  return bin;
}

test('orchestrateHtml: OPT-IN slate (--slate) — correct page VERIFIED, wrong page killed, honest advisory slate', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-orch-html-'));
  const prevBin = process.env.GODCODE_AB_BIN;
  try {
    process.env.GODCODE_AB_BIN = writeFakeAb(dir);
    const r = await orchestrateHtml({
      dossierDir: path.join(dir, '_godcode/runs/html-test'), dossierVaultRelDir: '_godcode/runs/html-test', dossierId: 'html-test',
      objective: 'A +1 counter page', request: '/godcode "build a +1 counter"',
      task: 'Build a page with a +1 button and a counter starting at 0; clicking increments by 1.',
      source: EX.spec,
      requirements: [{ id: 'r-counter', text: 'A +1 button increments a counter from 0 by 1.' }],
      clarifications: [{ q: 'Framework?', a: 'Vanilla, single file.' }],
      decisions: [{ question: 'D · scope', options: ['canvas', 'DOM'], chosen: 'DOM', rationale: 'simplest checkable', adjudicator: 'board' }],
      checks: EX.checks,
      residual: 'Checks structure + initial 0 + a single click → 1. Does NOT verify styling, a11y, or repeated clicks.',
      antiCandidates: [{ id: 'anti-counter', requirementId: 'r-counter', html: ANTI }],
      redAnswer: RED,
      answers: [
        { id: 'author-correct', html: CORRECT, angle: 'minimal' },
        { id: 'author-wrong', html: WRONG, angle: 'off-by-one' },
      ],
      verdicts: { pairs: [], rationale: '' }, slate: true,
      claimAuthor: 'agent-claim', adversary: 'agent-adversary', answerAuthor: 'agent-answers', judgeProvenance: 'agent-judge',
      workdir: mkdtempSync(path.join(dir, 'wd-')), attempts: 2,
    });

    assert.equal(r.certified, true, 'red baseline red + anti killed ⇒ certified');
    assert.equal(r.tier, 'constructed-floor-pass', 'HTML floor confers constructed-floor-pass');
    assert.equal(r.decision, 'shipped-slate');
    assert.equal(r.lintReport, null, 'HTML adapter exposes no bleedLint hook — the in-process lint is a no-op (HTML checks need a real browser snapshot)');
    assert.deepEqual(r.admitted, ['author-correct'], 'the correct page is VERIFIED');
    assert.equal(r.gated.find((g) => g.id === 'author-wrong').admitted, false, 'the off-by-one page is killed');
    assert.equal(r.gated.find((g) => g.id === 'author-wrong').outcome, 'failed');
    // honest slate: ordered, advisory, human-selected, no winner key.
    assert.equal(r.rankingIsAdvisory, true);
    assert.equal(r.selectBy, 'human');
    assert.equal(r.slate.length, 1);
    for (const k of ['winner', 'best', 'chosen', 'top']) assert.ok(!(k in r), `no "${k}" key`);
    // the live page is real + reflects the HTML run.
    assert.ok(existsSync(path.join(dir, '_godcode/runs/html-test', 'index.html')));
    const json = JSON.parse(readFileSync(path.join(dir, '_godcode/runs/html-test', 'run.json'), 'utf8'));
    assert.equal(json.outcome.decision, 'shipped-slate');
    assert.equal(json.tier, 'constructed-floor-pass');
  } finally {
    if (prevBin === undefined) delete process.env.GODCODE_AB_BIN; else process.env.GODCODE_AB_BIN = prevBin;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orchestrateHtml: DEFAULT single-best — one admitted page ships as sole-candidate (no slate)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-orch-html-sb-'));
  const prevBin = process.env.GODCODE_AB_BIN;
  try {
    process.env.GODCODE_AB_BIN = writeFakeAb(dir);
    const r = await orchestrateHtml({
      dossierDir: path.join(dir, '_godcode/runs/html-sb'), dossierVaultRelDir: '_godcode/runs/html-sb', dossierId: 'html-sb',
      objective: 'A +1 counter page', request: '/godcode "build a +1 counter"',
      task: 'Build a page with a +1 button and a counter starting at 0; clicking increments by 1.',
      source: EX.spec,
      requirements: [{ id: 'r-counter', text: 'A +1 button increments a counter from 0 by 1.' }],
      checks: EX.checks, residual: 'as above',
      antiCandidates: [{ id: 'anti-counter', requirementId: 'r-counter', html: ANTI }],
      redAnswer: RED,
      answers: [
        { id: 'author-correct', html: CORRECT, angle: 'minimal' },
        { id: 'author-wrong', html: WRONG, angle: 'off-by-one' },   // killed ⇒ a single admitted page remains
      ],
      verdicts: { pairs: [] },   // no slate flag ⇒ default single-best
      claimAuthor: 'agent-claim', adversary: 'agent-adversary', answerAuthor: 'agent-answers', judgeProvenance: 'agent-judge',
      workdir: mkdtempSync(path.join(dir, 'wd-')), attempts: 2,
    });
    assert.equal(r.certified, true);
    assert.equal(r.decision, 'shipped-single', 'one admitted page ⇒ single-best ship, not a slate');
    assert.equal(r.pickBy, 'sole-candidate');
    assert.equal(r.pick.id, 'author-correct');
    assert.equal(r.pick.tier, 'constructed-floor-pass');
    assert.equal(r.slate, null);
    assert.equal(r.slateMode, false);
  } finally {
    if (prevBin === undefined) delete process.env.GODCODE_AB_BIN; else process.env.GODCODE_AB_BIN = prevBin;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orchestrateHtml: discriminatingProbes with NO html runner ⇒ dispersion unmeasurable (no-runner), never a crash', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-orch-html-norunner-'));
  const prevBin = process.env.GODCODE_AB_BIN;
  try {
    process.env.GODCODE_AB_BIN = writeFakeAb(dir);
    const r = await orchestrateHtml({
      dossierDir: path.join(dir, '_godcode/runs/html-nr'), dossierVaultRelDir: '_godcode/runs/html-nr', dossierId: 'html-nr',
      objective: 'counter', request: 'r', task: 'counter', source: EX.spec,
      requirements: [{ id: 'r-counter', text: 'A +1 button increments a counter from 0 by 1.' }],
      checks: EX.checks, residual: 'as above',
      antiCandidates: [{ id: 'anti-counter', requirementId: 'r-counter', html: ANTI }],
      redAnswer: RED,
      answers: [{ id: 'author-correct', html: CORRECT }, { id: 'author-correct2', html: CORRECT2 }],   // 2 admitted ⇒ dispersion applies
      discriminatingProbes: [{ id: 'p-x', kind: 'dom-exists', selector: '#x' }],   // supplied, but the HTML adapter has no runner
      verdicts: { pairs: [] },
      claimAuthor: 'agent-claim', adversary: 'agent-adversary', answerAuthor: 'agent-answers', judgeProvenance: 'agent-judge',
      workdir: mkdtempSync(path.join(dir, 'wd-')), attempts: 2,
    });
    assert.equal(r.certified, true);
    assert.equal(r.admitted.length, 2, 'both correct pages are admitted');
    assert.equal(r.dispersionMeasurable, false);
    assert.equal(r.dispersionState, 'unmeasurable');
    assert.equal(r.unmeasurableReason, 'no-runner', 'probes were supplied but the HTML domain has no runner');
    const json = JSON.parse(readFileSync(path.join(dir, '_godcode/runs/html-nr', 'run.json'), 'utf8'));
    assert.ok(json.outcome.caveats.some((c) => /no probe runner|browser snapshot/i.test(c)), 'honest no-runner caveat, not "add probes"');
  } finally {
    if (prevBin === undefined) delete process.env.GODCODE_AB_BIN; else process.env.GODCODE_AB_BIN = prevBin;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orchestrateHtml: an UNCERTIFIED floor (red page passes everything) ⇒ advisory-only', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-orch-html2-'));
  const prevBin = process.env.GODCODE_AB_BIN;
  try {
    process.env.GODCODE_AB_BIN = writeFakeAb(dir);
    const r = await orchestrateHtml({
      dossierDir: path.join(dir, '_godcode/runs/html-test2'), dossierVaultRelDir: '_godcode/runs/html-test2', dossierId: 'html-test2',
      objective: 'counter', request: 'r', task: 'counter', source: EX.spec,
      requirements: [{ id: 'r-counter', text: 'A +1 button increments a counter from 0 by 1.' }],
      checks: EX.checks, residual: 'as above',
      antiCandidates: [{ id: 'anti-counter', requirementId: 'r-counter', html: ANTI }],
      redAnswer: CORRECT,   // SABOTAGE: a red page that passes every check ⇒ non-discriminating ⇒ certify fails
      answers: [{ id: 'author-correct', html: CORRECT }],
      verdicts: { pairs: [] },
      claimAuthor: 'agent-claim', adversary: 'agent-adversary', answerAuthor: 'agent-answers', judgeProvenance: 'agent-judge',
      workdir: mkdtempSync(path.join(dir, 'wd-')), attempts: 2,
    });
    assert.equal(r.certified, false, 'a non-discriminating red page must fail certification');
    assert.equal(r.decision, 'advisory-only');
    assert.equal(r.tier, null);
    assert.equal(r.admitted.length, 0, 'NOTHING verified when the floor is untrustworthy');
  } finally {
    if (prevBin === undefined) delete process.env.GODCODE_AB_BIN; else process.env.GODCODE_AB_BIN = prevBin;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AR: a SABOTAGED red page (bails to incomplete) cannot certify a verifier (integrity ≠ kill)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-orch-html3-'));
  const prevBin = process.env.GODCODE_AB_BIN;
  try {
    process.env.GODCODE_AB_BIN = writeFakeAb(dir);
    const r = await orchestrateHtml({
      dossierDir: path.join(dir, '_godcode/runs/html-test3'), dossierVaultRelDir: '_godcode/runs/html-test3', dossierId: 'html-test3',
      objective: 'counter', request: 'r', task: 'counter', source: EX.spec,
      requirements: [{ id: 'r-counter', text: 'A +1 button increments a counter from 0 by 1.' }],
      checks: EX.checks, residual: 'as above',
      antiCandidates: [{ id: 'anti-counter', requirementId: 'r-counter', html: ANTI }],
      redAnswer: SABOTAGE,   // the red page sabotages its OWN measurement (bails) — must NOT count as red-baseline-red
      answers: [{ id: 'author-correct', html: CORRECT }],
      verdicts: { pairs: [] },
      claimAuthor: 'agent-claim', adversary: 'agent-adversary', answerAuthor: 'agent-answers', judgeProvenance: 'agent-judge',
      workdir: mkdtempSync(path.join(dir, 'wd-')), attempts: 2,
    });
    assert.equal(r.certified, false, 'an integrity bail is NOT a kill — the red baseline did not discriminate, so no certification');
    assert.equal(r.admitted.length, 0, 'no false-certify ⇒ nothing earns a verified tier');
  } finally {
    if (prevBin === undefined) delete process.env.GODCODE_AB_BIN; else process.env.GODCODE_AB_BIN = prevBin;
    rmSync(dir, { recursive: true, force: true });
  }
});
