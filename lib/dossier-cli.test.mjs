// dossier-cli.test — the turnkey status-page CLI, driven as real subprocesses (as the skill does).
// Proves: init auto-creates the page + prints the HTTPS URL; a sequence of one-line mutations lands in
// run.json + re-renders index.html; init is idempotent (open, not clobber); errors exit non-zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dossier-cli.mjs');
const run = (args, opts = {}) => execFileSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });
const readRun = (dir) => JSON.parse(readFileSync(path.join(dir, 'run.json'), 'utf8'));

test('init: auto-creates the page, prints the HTTPS URL, anchors the request', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'gc-dcli-'));
  const dir = path.join(base, '_godcode/runs/test-run');
  try {
    const url = run(['init', '--dir', dir, '--objective', 'Demo objective', '--request', '/godcode "do X"',
      '--status', 'clarifying', '--milestones', JSON.stringify([{ id: 'm1', title: 'Clarify' }, { id: 'm2', title: 'Build' }])]).trim();
    assert.match(url, /^https:\/\/.*\/_godcode\/runs\/test-run\/$/, 'prints the clickable HTTPS tailnet URL');
    assert.ok(existsSync(path.join(dir, 'run.json')) && existsSync(path.join(dir, 'index.html')), 'both files written');
    const s = readRun(dir);
    assert.equal(s.request, '/godcode "do X"');
    assert.equal(s.objective, 'Demo objective');
    assert.equal(s.status, 'clarifying');
    assert.deepEqual(s.milestones.map((m) => m.id), ['m1', 'm2']);
    const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(html, /Demo objective/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('drive: a sequence of one-line mutations lands in run.json + re-renders', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'gc-dcli-'));
  const dir = path.join(base, '_godcode/runs/run2');
  try {
    run(['init', '--dir', dir, '--objective', 'Seq', '--request', 'r', '--milestones', JSON.stringify([{ id: 'm1', title: 'Build' }])]);
    run(['start', '--dir', dir, '--milestone', 'm1']);
    run(['discovery', '--dir', dir, '--text', 'verifier certified']);
    run(['decide', '--dir', dir, '--json', JSON.stringify({ question: 'Q?', options: ['a', 'b'], chosen: 'a', rationale: 'because', adjudicator: 'board' })]);
    const cid = run(['candidate', '--dir', dir, '--json', JSON.stringify({ id: 'author-1', angle: 'minimal' })]).trim();
    assert.equal(cid, 'author-1', 'candidate add echoes the id');
    run(['candidate-update', '--dir', dir, '--candidate', 'author-1', '--json', JSON.stringify({ verdict: 'green', detail: '18/18', evidence: { gate: 'green' } })]);
    run(['done', '--dir', dir, '--milestone', 'm1']);
    run(['finish', '--dir', dir, '--json', JSON.stringify({ decision: 'shipped-slate', tier: 'factual-evidence-pass', summary: 'one verified' })]);

    const s = readRun(dir);
    assert.equal(s.milestones[0].state, 'done');
    assert.ok(s.findings.some((f) => /verifier certified/.test(f.text)));
    assert.equal(s.decisions.length, 1);
    assert.equal(s.decisions[0].chosen, 'a');
    assert.equal(s.candidates.length, 1);
    assert.equal(s.candidates[0].verdict, 'green');
    assert.equal(s.candidates[0].evidence.gate, 'green');
    assert.equal(s.outcome.decision, 'shipped-slate');
    assert.equal(s.tier, 'factual-evidence-pass');
    assert.ok(s.rev > 5, 'each mutation bumped the monotonic rev');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('init is idempotent (open, not clobber): a re-init preserves prior progress', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'gc-dcli-'));
  const dir = path.join(base, '_godcode/runs/run3');
  try {
    run(['init', '--dir', dir, '--objective', 'Keep me', '--request', 'r']);
    run(['discovery', '--dir', dir, '--text', 'important finding']);
    // A second init (e.g. orchestrateProse opening the same dir) must NOT wipe the finding.
    run(['init', '--dir', dir, '--objective', 'Keep me']);
    const s = readRun(dir);
    assert.ok(s.findings.some((f) => /important finding/.test(f.text)), 're-init preserves progress');
    assert.equal(s.objective, 'Keep me');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('url subcommand prints the run page URL', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'gc-dcli-'));
  const dir = path.join(base, '_godcode/runs/run4');
  try {
    run(['init', '--dir', dir, '--objective', 'u', '--request', 'r']);
    assert.match(run(['url', '--dir', dir]).trim(), /^https:\/\/.*\/_godcode\/runs\/run4\/$/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('errors: unknown command and missing --dir exit non-zero', () => {
  assert.throws(() => run(['bogus', '--dir', '/tmp/x']), /Command failed/);
  assert.throws(() => run(['start']), /Command failed/);
});

// ── AR fold (2 HIGH + 3 MED) — the status page must not misrepresent or corrupt ──────────────
test('AR-MED5: --id rejects path traversal / separators (single slug only)', () => {
  assert.throws(() => run(['init', '--id', '../evil', '--objective', 'x']), /Command failed/, 'no .. escape');
  assert.throws(() => run(['init', '--id', 'a/b', '--objective', 'x']), /Command failed/, 'no separators');
  assert.throws(() => run(['init', '--id', '.', '--objective', 'x']), /Command failed/, 'no dot segment');
});

test('AR-MED4: a value flag with no value errors loudly (not a silent "true")', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'gc-dcli-'));
  const dir = path.join(base, '_godcode/runs/m4');
  try {
    run(['init', '--dir', dir, '--objective', 'o', '--request', 'r']);
    assert.throws(() => run(['discovery', '--dir', dir, '--text']), /Command failed/, '--text with no value must fail');
    // --key=value form is supported.
    run(['discovery', '--dir', dir, '--text=hello world']);
    assert.ok(readRun(dir).findings.some((f) => /hello world/.test(f.text)), '--text=value parses');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('AR-MED3: re-init does NOT reset milestones/status on an existing run', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'gc-dcli-'));
  const dir = path.join(base, '_godcode/runs/m3');
  try {
    run(['init', '--dir', dir, '--objective', 'O', '--request', 'R', '--status', 'clarifying',
      '--milestones', JSON.stringify([{ id: 'm1', title: 'A' }, { id: 'm2', title: 'B' }])]);
    run(['start', '--dir', dir, '--milestone', 'm2']);
    // a second init with DIFFERENT milestones + objective must preserve the in-progress run.
    run(['init', '--dir', dir, '--objective', 'HIJACK', '--milestones', JSON.stringify([{ id: 'm9', title: 'Z' }])]);
    const s = readRun(dir);
    assert.deepEqual(s.milestones.map((m) => m.id), ['m1', 'm2'], 'milestones preserved');
    assert.equal(s.milestones.find((m) => m.id === 'm2').state, 'active', 'progress preserved');
    assert.equal(s.objective, 'O', 'anchored objective not hijacked by a re-init');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('AR-HIGH1: a verified tier with NO evidenced candidate renders a conspicuous warning', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'gc-dcli-'));
  const dir = path.join(base, '_godcode/runs/h1');
  try {
    run(['init', '--dir', dir, '--objective', 'o', '--request', 'r']);
    // finish with a VERIFIED tier but no candidate carrying gate evidence ⇒ the page must NOT read as a
    // confirmed gate result.
    run(['finish', '--dir', dir, '--json', JSON.stringify({ decision: 'shipped-slate', tier: 'factual-evidence-pass', summary: 'claims verified' })]);
    let html = readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(html, /display only, not a confirmed gate result/i, 'unbacked verified tier is flagged');
    // add an evidenced green candidate, re-finish ⇒ warning gone.
    run(['candidate', '--dir', dir, '--json', JSON.stringify({ id: 'a', verdict: 'green', evidence: { gate: 'green' } })]);
    run(['finish', '--dir', dir, '--json', JSON.stringify({ decision: 'shipped-slate', tier: 'factual-evidence-pass', summary: 'now backed' })]);
    html = readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.ok(!/display only, not a confirmed gate result/i.test(html), 'an evidenced pass clears the warning');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
