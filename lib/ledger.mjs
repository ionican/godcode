// ledger — deterministic U8 run ledger (D8 promotion of the SKILL.md inline recipe, which
// achieved 1/7 write compliance headless). Append validates + stamps ts/harnessRev; query
// serves U8a priors; annotate patches a compliance block in after audit-run.
//
//   node ledger.mjs rev
//   node ledger.mjs append   < row.json            (stdin JSON; stamps ts + harnessRev)
//   node ledger.mjs query    [--repo <dir>] [--class <problemClass>] [--limit <n>]
//   node ledger.mjs annotate --slug <slug> [--key compliance] < value.json
//
// Default ledger: $VAULT/_godcode/ledger.jsonl. harnessRev = sha256 (12 hex) over the
// godcode + super-godcode SKILL.md contents — every row is attributable to a harness revision.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VAULT = path.resolve(HERE, '..', '..', '..');
export const DEFAULT_LEDGER = path.join(VAULT, '_godcode', 'ledger.jsonl');
export const DEFAULT_SKILL_FILES = [
  path.join(VAULT, '.claude', 'skills', 'godcode', 'SKILL.md'),
  path.join(VAULT, '.claude', 'skills', 'super-godcode', 'SKILL.md'),
];

export function harnessRev(skillFiles = DEFAULT_SKILL_FILES) {
  const existing = skillFiles.filter((f) => fs.existsSync(f));
  if (!existing.length) throw new Error(`harnessRev: no skill file found among ${skillFiles.join(', ')}`);
  const h = createHash('sha256');
  // order-independent: hash each file, sort the digests, hash the concatenation
  const digests = existing.map((f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex')).sort();
  for (const d of digests) h.update(d);
  return h.digest('hex').slice(0, 12);
}

const PATHS = new Set(['A', 'B', 'D']);

export function validateRow(row) {
  const fail = (msg) => { throw new Error(`ledger row invalid: ${msg}`); };
  if (!row || typeof row !== 'object') fail('not an object');
  if (typeof row.slug !== 'string' || !row.slug) fail('slug required');
  if (typeof row.decision !== 'string' || !row.decision) fail('decision required');
  if (!PATHS.has(row.path)) fail(`path must be one of ${[...PATHS].join('|')}`);
  if (!Number.isInteger(row.draws) || row.draws < 0) fail('draws must be a non-negative integer');
  if (!Number.isInteger(row.greens) || row.greens < 0) fail('greens must be a non-negative integer');
  if (row.greens > row.draws) fail('greens cannot exceed draws');
  if (row.cells !== undefined && !Array.isArray(row.cells)) fail('cells must be an array');
  return row;
}

export function appendRow(row, { ledgerPath = DEFAULT_LEDGER, skillFiles = DEFAULT_SKILL_FILES } = {}) {
  validateRow(row);
  // stamps LAST so a caller-supplied ts/harnessRev can never forge the provenance
  const stamped = { ...row, ts: new Date().toISOString(), harnessRev: harnessRev(skillFiles) };
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, JSON.stringify(stamped) + '\n');
  return stamped;
}

export function readLedger(ledgerPath = DEFAULT_LEDGER) {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function queryLedger({ ledgerPath = DEFAULT_LEDGER, repo = null, problemClass = null, limit = 0 } = {}) {
  let rows = readLedger(ledgerPath);
  if (repo) rows = rows.filter((r) => r.repo === repo);
  if (problemClass) rows = rows.filter((r) => r.problemClass === problemClass);
  return limit > 0 ? rows.slice(-limit) : rows;
}

export function annotateRow({ ledgerPath = DEFAULT_LEDGER, slug, key = 'compliance', value }) {
  // optimistic CAS: a concurrent append between our read and rename would be silently lost,
  // so re-read before committing and retry on drift
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '';
    const rows = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    let idx = -1;
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].slug === slug) { idx = i; break; }
    if (idx < 0) throw new Error(`annotate: no row with slug ${slug} in ${ledgerPath}`);
    rows[idx] = { ...rows[idx], [key]: value };
    const tmp = `${ledgerPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    if (fs.readFileSync(ledgerPath, 'utf8') === raw) { fs.renameSync(tmp, ledgerPath); return rows[idx]; }
    fs.rmSync(tmp, { force: true });
  }
  throw new Error(`annotate: ledger changed concurrently on every retry, giving up`);
}

// ---- CLI ----
function cliArg(argv, flag, dflt = null) {
  const i = argv.indexOf(flag);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
  return v;
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, ...argv] = process.argv.slice(2);
  const ledgerPath = cliArg(argv, '--ledger', DEFAULT_LEDGER);
  try {
    if (cmd === 'rev') {
      console.log(harnessRev());
    } else if (cmd === 'append') {
      const row = JSON.parse(fs.readFileSync(0, 'utf8'));
      console.log(JSON.stringify(appendRow(row, { ledgerPath })));
    } else if (cmd === 'query') {
      const rows = queryLedger({ ledgerPath, repo: cliArg(argv, '--repo'), problemClass: cliArg(argv, '--class'), limit: Number(cliArg(argv, '--limit', '0')) });
      for (const r of rows) console.log(JSON.stringify(r));
    } else if (cmd === 'annotate') {
      const slug = cliArg(argv, '--slug');
      if (!slug) throw new Error('annotate: --slug required');
      const value = JSON.parse(fs.readFileSync(0, 'utf8'));
      console.log(JSON.stringify(annotateRow({ ledgerPath, slug, key: cliArg(argv, '--key', 'compliance'), value })));
    } else {
      console.error('usage: ledger.mjs rev | append < row.json | query [--repo d] [--class c] [--limit n] | annotate --slug s [--key k] < value.json');
      process.exit(2);
    }
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
}
