// score — the fleet scorer for the reliability ablation. Reads per-item authoring tokens from the
// authoring-workflow output, gates each item's N authored worktrees (ablate.scoreItem), and prints
// the cost-adjusted table + fleet aggregate: pooled pSingle, best-of-k reliability, and the token
// cost multiple (single-shot 1x vs fan-out-N).
//
// Usage: node score.mjs <workflowOutputFile> <items.json>
import { readFileSync } from 'node:fs';
import { scoreItem } from './ablate.mjs';

const wf = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const items = JSON.parse(readFileSync(process.argv[3], 'utf8'));

// per-item authoring tokens from workflowProgress (label author:<itemId>#<i>)
const tok = {};
for (const p of (wf.workflowProgress || [])) {
  const m = /^author:(.+)#\d+$/.exec(p.label || '');
  if (m && p.tokens) tok[m[1]] = (tok[m[1]] || 0) + p.tokens;
}

const bestOfK = (p, k) => 1 - (1 - p) ** k;
const rows = [];
for (const it of items) {
  const r = await scoreItem(it.itemId, it.worktreeDir, tok[it.itemId] || null);
  rows.push(r);
}

// Prior: felt-false-green at N=20 (two earlier batches) — included for the pSingle picture.
const PRIOR = { item: 'felt-false-green-completion-gate', N: 20, greens: 10, pSingle: 0.5, regime: 'informative', prior: true };

console.log('\n=== Reliability ablation — scored fleet ===\n');
console.log('item                              N  green  pSingle  best5   regime       tok/single-shot');
const all = [PRIOR, ...rows.filter((r) => !r.error)];
for (const r of all) {
  const b5 = bestOfK(r.pSingle, 5).toFixed(3);
  const tps = r.cost ? `${Math.round(r.cost.tokensPerSingleShot / 1000)}k` : (r.prior ? '(prior)' : 'n/a');
  console.log(`${r.item.padEnd(34)}${String(r.N).padStart(2)}  ${String(r.greens).padStart(4)}   ${r.pSingle.toFixed(2)}     ${b5}  ${(r.regime || '').padEnd(12)} ${tps}`);
}
for (const r of rows.filter((r) => r.error)) console.log(`${r.item}: ERROR ${r.error}`);

// Fleet aggregate (pooled over all items incl. prior).
const pooledG = all.reduce((s, r) => s + r.greens, 0);
const pooledN = all.reduce((s, r) => s + r.N, 0);
const pooledP = pooledG / pooledN;
const newRows = rows.filter((r) => !r.error && r.cost);
const totalTok = newRows.reduce((s, r) => s + r.cost.authoringTokensTotal, 0);
const meanTps = newRows.length ? Math.round(totalTok / newRows.reduce((s, r) => s + r.N, 0)) : 0;
const itemsInformative = all.filter((r) => r.regime === 'informative').length;
const itemsTooHard = all.filter((r) => r.regime === 'too-hard').length;
const itemsTooEasy = all.filter((r) => r.regime === 'too-easy').length;

console.log('\n--- fleet ---');
console.log(`items: ${all.length} (informative ${itemsInformative}, too-hard ${itemsTooHard}, too-easy ${itemsTooEasy})`);
console.log(`pooled pSingle = ${pooledG}/${pooledN} = ${pooledP.toFixed(3)}`);
console.log(`reliability lift: single-shot ${(pooledP * 100).toFixed(0)}%  ->  fan-out-5 ${(bestOfK(pooledP, 5) * 100).toFixed(1)}%  ->  fan-out-10 ${(bestOfK(pooledP, 10) * 100).toFixed(1)}%  (verified)`);
console.log(`cost: single-shot ~${Math.round(meanTps / 1000)}k authoring tokens (ships UNVERIFIED); fan-out-5 ~${Math.round(meanTps * 5 / 1000)}k (5x, ships VERIFIED or honest no-green); gate ~free (OS processes)`);
console.log(`=> fan-out-5 + gate buys +${((bestOfK(pooledP, 5) - pooledP) * 100).toFixed(0)}pp verified-correctness for 5x authoring tokens. Worth it above blast-radius ~ (cost of a wrong fix) / (4 x ${Math.round(meanTps / 1000)}k tokens).`);
