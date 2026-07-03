// versus-score — SCORED three-way-blind quality adjudication (degree, not win/lose).
// Presents THREE anonymous candidates per item — fable's fix, super's fix, and the
// maintainer's REAL fix hidden among them as a calibration anchor — scored ABSOLUTELY
// against an anchored rubric by codex (GPT-5.5 xhigh, decorrelated from both arms).
// Two passes per item with different orderings to wash out position bias.
//
//   node versus-score.mjs <itemId> [...itemIds]      -> appends to ~/godcode-bench/scores.jsonl
//   node versus-score.mjs --aggregate                -> prints the aggregate table from scores.jsonl

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeItem } from './materialize.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = path.join(os.homedir(), 'godcode-bench');
const OUT = path.join(BENCH_ROOT, 'scores.jsonl');
const BENCH = JSON.parse(fs.readFileSync(path.join(HERE, 'benchmark.json'), 'utf8'));
const HIGH = (() => { try { const j = JSON.parse(fs.readFileSync(path.join(HERE, 'specs-high-altitude.json'), 'utf8')); return Object.fromEntries((j.items ?? j).map((s) => [s.id, s.spec])); } catch { return {}; } })();

const ARMS = (() => { const i = process.argv.indexOf('--arms'); return i >= 0 ? process.argv[i + 1].split(',') : ['fable', 'super']; })();
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
const git = (repo, args) => sh('git', ['-C', repo, ...args]).stdout;
const DIMS = ['rootCause', 'robustness', 'minimality', 'idiom', 'maintainability'];

function perms3(seed) {
  // two distinct orderings of [arm1, arm2, real], deterministic from item id
  const [x, y] = ARMS;
  const P = [[x,y,'real'],[y,'real',x],['real',x,y],[x,'real',y],[y,x,'real'],['real',y,x]];
  const h = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 4), 16);
  return [P[h % 6], P[(h + 3) % 6]]; // second pass uses a different, deterministic ordering
}

function extractVerdict(raw, key) {
  let verdict = null;
  for (let idx = raw.lastIndexOf(key); idx >= 0 && !verdict; idx = raw.lastIndexOf(key, idx - 1)) {
    for (const end of [raw.length, raw.indexOf('\n', idx)]) {
      if (end <= idx) continue;
      try { verdict = JSON.parse(raw.slice(idx, end).trim()); break; } catch { /* next */ }
    }
  }
  return verdict;
}

async function scoreItem(itemId, pass, order) {
  const item = BENCH.items.find((i) => i.id === itemId);
  const m = materializeItem(item);
  const meta = JSON.parse(fs.readFileSync(path.join(BENCH_ROOT, itemId, 'meta.json'), 'utf8'));
  const spec = HIGH[itemId] || item.spec;
  const diffs = { real: git(m.root, ['diff', m.base, m.fix, '--', ...m.sourceFiles]) };
  for (const a of ARMS) diffs[a] = git(path.join(BENCH_ROOT, itemId, a), ['diff', meta.arenaSha, '--', '.', ':!BENCH-RESULT.txt']);
  if (Object.values(diffs).some((d) => !d.trim())) { console.error(`${itemId}: missing diff — skip`); return; }
  const label = { [order[0]]: 'A', [order[1]]: 'B', [order[2]]: 'C' };

  const prompt = `You are an independent senior reviewer SCORING three ANONYMOUS fixes for the same issue in a TypeScript codebase. All three PASS the full acceptance suite — suite-level correctness is settled. Score QUALITY BEYOND the suite, ABSOLUTELY against a senior-engineer standard (do NOT grade on a curve; identical quality = identical scores).

THE TASK SPEC:
${spec}

CANDIDATE A (unified diff vs the same base):
${diffs[order[0]]}

CANDIDATE B:
${diffs[order[1]]}

CANDIDATE C:
${diffs[order[2]]}

RUBRIC — overall (0-100): 90-100 exemplary, merge as-is, the fix a principal engineer would write; 75-89 solid, minor nits only; 60-74 acceptable, reviewer would request changes; 40-59 works but structurally concerning; below 40 barely passes the suite. Per-dimension (0-10, same anchoring /10): rootCause (fixes the mechanism vs patches the symptom), robustness (edge cases the suite may not pin), minimality (blast radius), idiom (fit with surrounding code), maintainability (clarity for the next reader; comment/doc verbosity is NOT a demerit). wouldMerge: "as-is" | "with-nits" | "needs-changes".

Output STRICT JSON only, exactly this shape, no prose outside it:
{"scores":{"A":{"overall":0,"rootCause":0,"robustness":0,"minimality":0,"idiom":0,"maintainability":0,"wouldMerge":""},"B":{...same},"C":{...same}},"rationale":"<=100 words"}`;

  const promptFile = path.join(BENCH_ROOT, itemId, `score-prompt-p${pass}.txt`);
  fs.writeFileSync(promptFile, prompt);
  const t0 = Date.now();
  const r = sh('bash', ['-c', `codex exec --skip-git-repo-check -s read-only -c 'mcp_servers={}' -c model_reasoning_effort="xhigh" "$(cat ${JSON.stringify(promptFile)})" < /dev/null 2>&1`], { timeout: 25 * 60_000 });
  const raw = r.stdout ?? '';
  fs.writeFileSync(path.join(BENCH_ROOT, itemId, `score-raw-p${pass}.txt`), raw);
  const verdict = extractVerdict(raw, '{"scores"');
  const byArm = {};
  if (verdict?.scores) for (const arm of [...ARMS, 'real']) byArm[arm] = verdict.scores[label[arm]] ?? null;
  const row = { ts: new Date().toISOString(), item: itemId, pass, order, judge: 'codex-gpt5.5-xhigh', byArm, rationale: verdict?.rationale ?? null, judgeSecs: Math.round((Date.now() - t0) / 1000), parseOk: !!verdict?.scores };
  fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
  console.log(JSON.stringify({ item: itemId, pass, parseOk: row.parseOk, overall: Object.fromEntries(Object.entries(byArm).map(([k, v]) => [k, v?.overall ?? null])) }));
}

function aggregate() {
  const rows = fs.readFileSync(OUT, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.parseOk);
  const arms = [...new Set(rows.flatMap((r) => Object.keys(r.byArm)))];
  const acc = Object.fromEntries(arms.map((a) => [a, { overall: [], dims: Object.fromEntries(DIMS.map((d) => [d, []])), merge: { 'as-is': 0, 'with-nits': 0, 'needs-changes': 0 } }]));
  const perItem = {};
  for (const r of rows) for (const a of arms) {
    const s = r.byArm[a]; if (!s) continue;
    acc[a].overall.push(s.overall);
    for (const d of DIMS) acc[a].dims[d].push(s[d]);
    if (s.wouldMerge in acc[a].merge) acc[a].merge[s.wouldMerge]++;
    (perItem[r.item] ??= {})[a] = (perItem[r.item][a] ?? []).concat(s.overall);
  }
  const mean = (xs) => xs.length ? Math.round(xs.reduce((p, c) => p + c, 0) / xs.length * 10) / 10 : null;
  console.log('=== per-item mean overall (across passes) ===');
  for (const [it, v] of Object.entries(perItem)) console.log(it.padEnd(38), Object.fromEntries(arms.map((a) => [a, mean(v[a] ?? [])])));
  console.log('=== aggregate ===');
  for (const a of arms) console.log(a.padEnd(6), 'overall', mean(acc[a].overall), '| dims', Object.fromEntries(DIMS.map((d) => [d, mean(acc[a].dims[d])])), '| merge', acc[a].merge);
  // order-bias check: pass-1 vs pass-2 mean per arm
  for (const a of arms) {
    const p1 = rows.filter((r) => r.pass === 1).map((r) => r.byArm[a]?.overall).filter((x) => x != null);
    const p2 = rows.filter((r) => r.pass === 2).map((r) => r.byArm[a]?.overall).filter((x) => x != null);
    console.log(`order-bias ${a}: pass1 ${mean(p1)} vs pass2 ${mean(p2)}`);
  }
}

const args = process.argv.slice(2).filter((a, i, arr) => a !== '--arms' && arr[i - 1] !== '--arms');
if (args[0] === '--aggregate') { aggregate(); process.exit(0); }
if (!args.length) { console.error('usage: versus-score.mjs <itemId> [...] | --aggregate'); process.exit(1); }
for (const id of args) {
  const [o1, o2] = perms3(id);
  await scoreItem(id, 1, o1);
  await scoreItem(id, 2, o2);
}
