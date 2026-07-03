// ledger.test — the U8 ledger becomes deterministic code (D8): append validates + stamps
// ts/harnessRev, query filters priors, annotate patches compliance in place atomically.
// The 1/7 headless write-compliance failure this replaces was instruction-level bookkeeping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { harnessRev, appendRow, queryLedger, annotateRow, validateRow } from './ledger.mjs';

const row = (over = {}) => ({
  slug: 'test-run', path: 'A', decision: 'VERIFIED', draws: 3, greens: 2,
  repo: '/tmp/repo', problemClass: 'off-by-one', ...over,
});

function tmpLedger() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-ledgertest-'));
  return { dir, file: path.join(dir, 'ledger.jsonl') };
}

test('harnessRev: deterministic 12-hex over the skill files, changes when a skill changes', () => {
  const { dir } = tmpLedger();
  const a = path.join(dir, 'a.md'); const b = path.join(dir, 'b.md');
  writeFileSync(a, 'skill A v1'); writeFileSync(b, 'skill B v1');
  const r1 = harnessRev([a, b]);
  assert.match(r1, /^[0-9a-f]{12}$/);
  assert.equal(harnessRev([a, b]), r1);          // stable
  assert.equal(harnessRev([b, a]), r1);          // order-independent
  writeFileSync(b, 'skill B v2');
  assert.notEqual(harnessRev([a, b]), r1);       // content-sensitive
  rmSync(dir, { recursive: true, force: true });
});

test('harnessRev: throws when no skill file exists (never a silent "unknown")', () => {
  assert.throws(() => harnessRev(['/nonexistent/x.md']));
});

test('validateRow: rejects missing required fields and bad types', () => {
  assert.throws(() => validateRow({ slug: 'x' }), /decision/);
  assert.throws(() => validateRow(row({ draws: 'three' })), /draws/);
  assert.throws(() => validateRow(row({ path: 'Z' })), /path/);
  assert.throws(() => validateRow(row({ greens: 5, draws: 2 })), /greens/); // greens > draws is impossible
  assert.deepEqual(validateRow(row()).slug, 'test-run');
});

test('appendRow: stamps ts + harnessRev, appends one JSON line, never rewrites prior lines', () => {
  const { dir, file } = tmpLedger();
  const skill = path.join(dir, 's.md'); writeFileSync(skill, 'v1');
  appendRow(row(), { ledgerPath: file, skillFiles: [skill] });
  appendRow(row({ slug: 'second' }), { ledgerPath: file, skillFiles: [skill] });
  const lines = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].slug, 'test-run');
  assert.match(lines[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(lines[0].harnessRev, /^[0-9a-f]{12}$/);
  assert.equal(lines[1].slug, 'second');
  rmSync(dir, { recursive: true, force: true });
});

test('appendRow: invalid row throws and writes NOTHING', () => {
  const { dir, file } = tmpLedger();
  const skill = path.join(dir, 's.md'); writeFileSync(skill, 'v1');
  assert.throws(() => appendRow(row({ decision: undefined }), { ledgerPath: file, skillFiles: [skill] }));
  assert.throws(() => readFileSync(file)); // file never created
  rmSync(dir, { recursive: true, force: true });
});

test('queryLedger: filters by repo and problemClass, newest last, respects limit', () => {
  const { dir, file } = tmpLedger();
  const skill = path.join(dir, 's.md'); writeFileSync(skill, 'v1');
  for (let i = 0; i < 4; i++) appendRow(row({ slug: `r${i}`, problemClass: i % 2 ? 'race' : 'off-by-one' }), { ledgerPath: file, skillFiles: [skill] });
  appendRow(row({ slug: 'other-repo', repo: '/tmp/other' }), { ledgerPath: file, skillFiles: [skill] });
  const byRepo = queryLedger({ ledgerPath: file, repo: '/tmp/repo' });
  assert.equal(byRepo.length, 4);
  const byClass = queryLedger({ ledgerPath: file, repo: '/tmp/repo', problemClass: 'race' });
  assert.deepEqual(byClass.map((r) => r.slug), ['r1', 'r3']);
  const limited = queryLedger({ ledgerPath: file, limit: 2 });
  assert.deepEqual(limited.map((r) => r.slug), ['r3', 'other-repo']); // last N, order preserved
  assert.deepEqual(queryLedger({ ledgerPath: path.join(dir, 'missing.jsonl') }), []); // cold start, not an error
  rmSync(dir, { recursive: true, force: true });
});

test('AR fold 2026-07-03: caller-supplied ts/harnessRev cannot override the stamp (HIGH)', () => {
  const { dir, file } = tmpLedger();
  const skill = path.join(dir, 's.md'); writeFileSync(skill, 'v1');
  const out = appendRow(row({ ts: '1970-01-01T00:00:00.000Z', harnessRev: 'deadbeefdead' }), { ledgerPath: file, skillFiles: [skill] });
  assert.notEqual(out.harnessRev, 'deadbeefdead');
  assert.match(out.ts, /^20/); // stamped now, not the forged epoch
  const line = JSON.parse(readFileSync(file, 'utf8').trim());
  assert.notEqual(line.harnessRev, 'deadbeefdead');
  rmSync(dir, { recursive: true, force: true });
});

test('annotateRow: patches the LAST row matching slug under the given key, atomically, others untouched', () => {
  const { dir, file } = tmpLedger();
  const skill = path.join(dir, 's.md'); writeFileSync(skill, 'v1');
  appendRow(row({ slug: 'dup' }), { ledgerPath: file, skillFiles: [skill] });
  appendRow(row({ slug: 'mid' }), { ledgerPath: file, skillFiles: [skill] });
  appendRow(row({ slug: 'dup', notes: 'newer' }), { ledgerPath: file, skillFiles: [skill] });
  annotateRow({ ledgerPath: file, slug: 'dup', key: 'compliance', value: { violations: 0, pass: true } });
  const lines = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].compliance, undefined);           // earlier dup untouched
  assert.equal(lines[1].compliance, undefined);
  assert.deepEqual(lines[2].compliance, { violations: 0, pass: true });
  assert.throws(() => annotateRow({ ledgerPath: file, slug: 'nope', key: 'compliance', value: {} }), /no row/);
  rmSync(dir, { recursive: true, force: true });
});
