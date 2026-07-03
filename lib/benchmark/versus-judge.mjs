// versus-judge — blind cross-model QUALITY adjudication of the versus bench arms.
// Correctness is already settled by the gate; this judges quality BEYOND the suite,
// via codex (GPT-5.5, decorrelated from both contestants), pairwise, arm-blind.
//
//   node versus-judge.mjs <itemId> [...itemIds]     judge each item, append to judgments.jsonl
//
// Per item: diff(arena -> fable), diff(arena -> super), the maintainer's real fix diff
// (reference), spec. A/B assignment is a deterministic coin from the item id hash.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeItem } from './materialize.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = path.join(os.homedir(), 'godcode-bench');
const OUT = path.join(BENCH_ROOT, 'judgments.jsonl');
const BENCH = JSON.parse(fs.readFileSync(path.join(HERE, 'benchmark.json'), 'utf8'));
const HIGH = (() => { try { const j = JSON.parse(fs.readFileSync(path.join(HERE, 'specs-high-altitude.json'), 'utf8')); return Object.fromEntries((j.items ?? j).map((s) => [s.id, s.spec])); } catch { return {}; } })();

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
const git = (repo, args) => sh('git', ['-C', repo, ...args]).stdout;

function armDiff(itemId, arm, meta) {
  const dir = path.join(BENCH_ROOT, itemId, arm);
  return git(dir, ['diff', meta.arenaSha, '--', '.', ':!BENCH-RESULT.txt']);
}
function proxies(diff) {
  const files = (diff.match(/^diff --git /gm) || []).length;
  const plus = (diff.match(/^\+[^+]/gm) || []).length;
  const minus = (diff.match(/^-[^-]/gm) || []).length;
  return { files, plus, minus };
}

async function judge(itemId) {
  const item = BENCH.items.find((i) => i.id === itemId);
  if (!item) { console.error(`unknown item ${itemId}`); return; }
  const m = materializeItem(item);
  const meta = JSON.parse(fs.readFileSync(path.join(BENCH_ROOT, itemId, 'meta.json'), 'utf8'));
  const spec = HIGH[itemId] || item.spec;
  const fableDiff = armDiff(itemId, 'fable', meta);
  const superDiff = armDiff(itemId, 'super', meta);
  if (!fableDiff.trim() || !superDiff.trim()) { console.error(`${itemId}: missing a diff (fable ${fableDiff.length}b, super ${superDiff.length}b) — skip`); return; }
  const realFix = git(m.root, ['diff', m.base, m.fix, '--', ...m.sourceFiles]);

  // deterministic blind assignment: even hash -> A=fable, odd -> A=super
  const coin = parseInt(createHash('sha256').update(itemId).digest('hex').slice(0, 2), 16) % 2;
  const A = coin === 0 ? 'fable' : 'super';
  const Bm = coin === 0 ? 'super' : 'fable';
  const diffs = { A: coin === 0 ? fableDiff : superDiff, B: coin === 0 ? superDiff : fableDiff };

  const prompt = `You are an independent senior reviewer adjudicating TWO ANONYMOUS fixes for the same issue in a TypeScript codebase. Both already PASS the full acceptance suite — correctness at the suite level is settled and is NOT the question. Judge QUALITY BEYOND the suite.

THE TASK SPEC:
${spec}

CANDIDATE A (unified diff vs the same base):
${diffs.A}

CANDIDATE B (unified diff vs the same base):
${diffs.B}

REFERENCE — the maintainer's actual historical fix for this issue (context for intent; NOT necessarily the best possible fix; do not reward mere similarity to it, reward addressing the same root cause):
${realFix}

Judge on: (1) root-cause depth (fixes the mechanism vs patches the symptom), (2) robustness on edge cases the suite may not pin, (3) minimality / blast radius, (4) idiomatic fit with the surrounding code, (5) maintainability & clarity. Comment/doc verbosity is NOT a demerit. Output STRICT JSON only, no prose outside it:
{"winner":"A"|"B"|"tie","confidence":"low"|"medium"|"high","dimensions":{"rootCause":"A"|"B"|"tie","robustness":"A"|"B"|"tie","minimality":"A"|"B"|"tie","idiom":"A"|"B"|"tie","maintainability":"A"|"B"|"tie"},"rationale":"<=120 words","notableRisks":{"A":"<=25 words","B":"<=25 words"}}`;

  const promptFile = path.join(BENCH_ROOT, itemId, 'judge-prompt.txt');
  fs.writeFileSync(promptFile, prompt);
  const t0 = Date.now();
  const r = sh('bash', ['-c', `codex exec --skip-git-repo-check -s read-only -c 'mcp_servers={}' -c model_reasoning_effort="xhigh" "$(cat ${JSON.stringify(promptFile)})" < /dev/null 2>&1`], { timeout: 20 * 60_000 });
  const raw = r.stdout ?? '';
  fs.writeFileSync(path.join(BENCH_ROOT, itemId, 'judge-raw.txt'), raw);
  let verdict = null;
  for (let idx = raw.lastIndexOf('{"winner"'); idx >= 0 && !verdict; idx = raw.lastIndexOf('{"winner"', idx - 1)) {
    for (const end of [raw.length, raw.indexOf('\n', idx)]) {
      if (end <= idx) continue;
      try { verdict = JSON.parse(raw.slice(idx, end).trim()); break; } catch { /* try next */ }
    }
  }
  const row = {
    ts: new Date().toISOString(), item: itemId, judge: 'codex-gpt5.5-xhigh', blind: { A, B: Bm },
    verdict, winnerArm: verdict?.winner === 'tie' ? 'tie' : verdict ? (verdict.winner === 'A' ? A : Bm) : null,
    proxies: { fable: proxies(fableDiff), super: proxies(superDiff) },
    judgeSecs: Math.round((Date.now() - t0) / 1000), parseOk: !!verdict,
  };
  fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
  console.log(JSON.stringify({ item: itemId, winnerArm: row.winnerArm, confidence: verdict?.confidence, proxies: row.proxies, parseOk: row.parseOk }, null, 1));
}

const ids = process.argv.slice(2);
if (!ids.length) { console.error('usage: versus-judge.mjs <itemId> [...]'); process.exit(1); }
for (const id of ids) await judge(id);
