// dossier.test — the live source-of-truth page: state persists atomically, the render anchors the
// verbatim request, verdicts/milestones/outcome surface honestly, and untrusted text is escaped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunDossier, renderDossier, slugify, SCHEMA } from './dossier.mjs';

function tmp() { return mkdtempSync(path.join(tmpdir(), 'gc-dossier-')); }

test('opens a run: writes run.json + index.html, anchors the verbatim request', () => {
  const dir = tmp();
  try {
    const d = new RunDossier({ dir, request: 'recreate Pac-Man in one HTML file', objective: 'Pac-Man clone' });
    assert.ok(existsSync(path.join(dir, 'run.json')), 'run.json written');
    assert.ok(existsSync(path.join(dir, 'index.html')), 'index.html written');
    const state = JSON.parse(readFileSync(path.join(dir, 'run.json'), 'utf8'));
    assert.equal(state.schema, SCHEMA);
    assert.equal(state.request, 'recreate Pac-Man in one HTML file');
    assert.equal(state.status, 'planning');
    const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(html, /recreate Pac-Man in one HTML file/, 'request anchored in the page');
    assert.match(html, /Original request/, 'request section labelled');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('milestones: set, start, finish — progress count tracks done/total', () => {
  const dir = tmp();
  try {
    const d = new RunDossier({ dir, request: 'r', objective: 'o' });
    d.setMilestones([{ id: 'g1', title: 'Scaffold' }, { id: 'g2', title: 'Author' }, { id: 'g3', title: 'Gate' }]);
    d.startMilestone('g1');
    d.finishMilestone('g1');
    const s = d.state;
    assert.equal(s.milestones.length, 3);
    assert.equal(s.milestones[0].state, 'done');
    assert.ok(s.milestones[0].startedAt && s.milestones[0].endedAt, 'timestamps set');
    assert.equal(s.milestones[1].state, 'pending');
    const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(html, /1<\/b> \/ 3 milestones/, 'progress 1/3 rendered');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('candidates: verdict transition logs a gate event; admitted only via explicit verdict', () => {
  const dir = tmp();
  try {
    const d = new RunDossier({ dir, request: 'r', objective: 'o' });
    const id = d.addCandidate({ id: 'author-0', angle: 'minimal' });
    assert.equal(d.state.candidates[0].verdict, 'pending', 'new candidate is pending, never auto-admitted');
    d.updateCandidate(id, { verdict: 'admitted', detail: '18/18 tests', metrics: { loc: 240 } });
    const c = d.state.candidates[0];
    assert.equal(c.verdict, 'admitted');
    assert.equal(c.metrics.loc, 240);
    const gateEvents = d.state.events.filter((e) => e.kind === 'gate');
    assert.equal(gateEvents.length, 1, 'one gate event for the transition');
    assert.match(gateEvents[0].text, /Admitted/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('discovery adds a finding and an event; both render', () => {
  const dir = tmp();
  try {
    const d = new RunDossier({ dir, request: 'r', objective: 'o' });
    d.discovery('all 4 authors invented a different method name — verifier-coupling signal');
    assert.equal(d.state.findings.length, 1);
    assert.equal(d.state.events.filter((e) => e.kind === 'discovery').length, 1);
    const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(html, /verifier-coupling signal/);
    assert.match(html, /Discoveries/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('finish: sets outcome + tier + derived status, renders the ranked slate', () => {
  const dir = tmp();
  try {
    const d = new RunDossier({ dir, request: 'r', objective: 'o' });
    d.finish({
      decision: 'slate', tier: 'C', summary: 'three admissible answers',
      slate: [{ id: 'author-2', note: 'fewest LOC' }, { id: 'author-0', note: 'most edge cases' }],
      caveats: ['subjective feel not machine-verified'],
    });
    assert.equal(d.state.tier, 'proxy-ranked');  // 'C' normalizes to the canonical typed-contract label
    assert.equal(d.state.status, 'slate');  // proxy-ranked = ranked slate awaiting a human pick, not auto-shipped
    assert.equal(d.state.outcome.slate.length, 2);
    const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(html, /Ranked slate/);
    assert.match(html, /author-2/);
    assert.match(html, /subjective feel not machine-verified/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tier A finish derives shipped + VERIFIED label', () => {
  const dir = tmp();
  try {
    const d = new RunDossier({ dir, request: 'r', objective: 'o' });
    d.finish({ decision: 'gate-only', tier: 'A', summary: 'first draw greened' });
    assert.equal(d.state.status, 'shipped');
    const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(html, /VERIFIED/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('untrusted text is HTML-escaped (no injection via request/objective/findings)', () => {
  const dir = tmp();
  try {
    const d = new RunDossier({ dir, request: '<script>alert(1)</script>', objective: 'x & y < z' });
    d.discovery('<img src=x onerror=alert(2)>');
    const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /<script>alert\(1\)/, 'request script tag escaped');
    assert.doesNotMatch(html, /<img src=x onerror/, 'finding escaped');
    assert.match(html, /&lt;script&gt;/, 'escaped form present');
    assert.match(html, /x &amp; y &lt; z/, 'objective escaped');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('load() round-trips state; persist advances updatedAt; page embeds it for polling', () => {
  const dir = tmp();
  try {
    const d = new RunDossier({ dir, request: 'r', objective: 'o' });
    const t0 = d.state.updatedAt;
    d.log('info', 'something happened');
    assert.notEqual(d.state.updatedAt, t0, 'updatedAt advanced on mutation');
    const reloaded = RunDossier.load(dir);
    assert.equal(reloaded.state.request, 'r');
    assert.equal(reloaded.state.events.at(-1).text, 'something happened');
    const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.ok(html.includes(JSON.stringify(d.state.updatedAt)), 'updatedAt embedded for the poll loop');
    assert.match(html, /run\.json\?_=/, 'poll loop present');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('clarifications: the one upfront round renders; unanswered shows a documented-assumption note', () => {
  const dir = tmp();
  try {
    const d = new RunDossier({ dir, request: 'r', objective: 'o' });
    d.setClarifications([
      { q: 'Which repo?', a: '~/Felt' },
      { q: 'Acceptance source?', a: '' },  // unanswered
    ]);
    assert.equal(d.state.clarifications.length, 2);
    const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(html, /Clarifications/);
    assert.match(html, /Which repo\?/);
    assert.match(html, /~\/Felt/);
    assert.match(html, /proceeding on documented assumption/, 'unanswered clarification flagged');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('decide(): records an adjudicated decision, logs it, renders options with the chosen marked', () => {
  const dir = tmp();
  try {
    const d = new RunDossier({ dir, request: 'r', objective: 'o' });
    const dec = d.decide({
      question: 'HTTPS mechanism for the page?',
      options: ['tailscale serve front', 'self-signed TLS on the deck server', 'leave as http'],
      chosen: 'tailscale serve front',
      rationale: 'additive + reversible + valid cert; does not touch the shared deck-server service',
      references: ['request: "must be https"', 'pattern: HTTPS-over-Tailscale'],
      board: ['infra: tailscale serve is already the host pattern', 'security: valid cert avoids warning fatigue'],
      adjudicator: 'cross-model (Codex)',
    });
    assert.equal(d.state.decisions.length, 1);
    assert.equal(dec.chosen, 'tailscale serve front');
    assert.equal(d.state.events.filter((e) => e.kind === 'decision').length, 1, 'decision logged to the activity log');
    const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(html, /Decisions — autonomous, adjudicated/);
    assert.match(html, /HTTPS mechanism for the page\?/);
    assert.match(html, /◎ tailscale serve front/, 'chosen option marked');
    assert.match(html, /does not touch the shared deck-server service/, 'rationale rendered');
    assert.match(html, /adjudicator: cross-model \(Codex\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('url() emits an HTTPS tailnet URL by default', () => {
  const dir = tmp();
  try {
    const d = new RunDossier({ dir, request: 'r', objective: 'o' });
    const u = d.url('_godcode/runs/abc');
    assert.match(u, /^https:\/\//, 'https scheme');
    assert.match(u, /ts\.net:8766\/_godcode\/runs\/abc\/$/, 'tailnet host + path');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('typed confidence contract: aliases normalize; constructed-floor-pass ships with its label', () => {
  const dir = tmp();
  try {
    const d = new RunDossier({ dir, request: 'r', objective: 'o' });
    d.finish({ decision: 'floor', tier: 'constructed-floor-pass', summary: 's' });
    assert.equal(d.state.tier, 'constructed-floor-pass');
    assert.equal(d.state.status, 'shipped');
    const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(html, /CONSTRUCTED-FLOOR-PASS/);
    // old alias still works
    const d2 = new RunDossier({ dir: tmp(), request: 'r', objective: 'o' });
    d2.finish({ tier: 'A' });
    assert.equal(d2.state.tier, 'repo-verified');
    rmSync(d2.dir, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('candidate evidence: admitted without a gate artifact is flagged; with one it renders (AR 9)', () => {
  const dir = tmp();
  try {
    const d = new RunDossier({ dir, request: 'r', objective: 'o' });
    d.addCandidate({ id: 'a', verdict: 'admitted' });  // no evidence
    let html = readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(html, /admitted without a gate artifact/, 'flags missing evidence');
    d.addCandidate({ id: 'b', verdict: 'admitted', evidence: { cmd: 'node --test', exit: 0, commit: 'abc1234', verifier: 'suite-v1' } });
    html = readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(html, /verifier suite-v1/, 'renders the gate artifact');
    assert.match(html, /exit 0/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rev increments monotonically per persist and renders (AR 10)', () => {
  const dir = tmp();
  try {
    const d = new RunDossier({ dir, request: 'r', objective: 'o' });
    const r0 = d.state.rev;
    d.log('info', 'x');
    assert.ok(d.state.rev > r0, 'rev advanced');
    const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(html, /rev \d+/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('renderDossier is pure and total on an empty/partial state', () => {
  const html = renderDossier({ request: 'just a question', status: 'running' });
  assert.match(html, /just a question/);
  assert.match(html, /No milestones set yet/);
  assert.match(html, /No candidates drawn yet/);
  assert.doesNotThrow(() => renderDossier({}), 'no throw on empty state');
});

test('slugify is filesystem-safe', () => {
  assert.equal(slugify('Create a one-page HTML page!'), 'create-a-one-page-html-page');
  assert.equal(slugify(''), 'run');
  assert.ok(!slugify('a/b\\c:d').includes('/'));
});
