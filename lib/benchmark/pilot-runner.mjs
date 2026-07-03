// pilot-runner — validate that each benchmark item's verifier actually DISCRIMINATES
// base->fix, by driving the REAL gate-runner (one path, not two). The survey reasoned
// `wouldCatchRevert` from diffs; this EXECUTES it through the same primitive /godcode ships.
//
// Per item, two gate-runner calls against the live repo:
//   BASE  — worktree at baseSha (known-wrong source) + oracleFiles = the fix's version of each
//           named test file (the SWE-bench "test patch", materialized by the harness, exempt
//           from the immutability guard). Expect gate=PRUNED (the verifier fails on buggy source) = RED.
//   FIX   — worktree at fixSha as-is. Expect gate=GREEN.
// discriminates = RED@base && GREEN@fix. A behaviour-preserving refactor legitimately shows
// GREEN@base (gate=green) — flagged, not failed: it needs the mutant corpus, not the parent.
//
// Both calls use provision (symlink the gitignored node_modules a fresh worktree lacks) and
// runSubdir (the package the tests live under). v1 supports node+tsx (Felt); vitest/dotnet skip.
// Usage: node pilot-runner.mjs [itemId ...]   (default: the node-tsx positives)

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateRunner } from '../gate-runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH = JSON.parse(readFileSync(path.join(HERE, 'benchmark.json'), 'utf8'));

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
const git = (repo, args) => sh('git', ['-C', repo, ...args]);

function classify(verifyCmd) {
  const [cdPart, ...rest] = verifyCmd.split('&&');
  const cwd = cdPart.replace(/^\s*cd\s+/, '').trim();
  const runPart = rest.join('&&');
  const testArgs = runPart.match(/\S+\.test\.(?:ts|mjs|js)/g) || [];
  let framework = 'unknown';
  if (/node --import tsx --test/.test(runPart)) framework = 'node-tsx';
  else if (/vitest/.test(runPart)) framework = 'vitest';
  else if (/dotnet test/.test(runPart)) framework = 'dotnet';
  return { cwd, testArgs, framework };
}

async function discriminate(item) {
  const { cwd, testArgs, framework } = classify(item.verify.cmd);
  if (framework !== 'node-tsx') return { id: item.id, framework, skipped: true };
  const root = git(cwd, ['rev-parse', '--show-toplevel']).stdout.trim();
  const runSubdir = path.relative(root, cwd);
  const base = item.baseSha;
  const fix = item.fixSha.split(' ')[0]; // strip any annotation

  // VERIFIER MATERIALIZATION: the fix's version of each named test file, keyed repo-root-relative.
  const oracleFiles = {};
  for (const arg of testArgs) {
    const rel = path.join(runSubdir, arg);
    const content = git(root, ['show', `${fix}:${rel}`]).stdout;
    if (content) oracleFiles[rel] = content;
  }
  if (Object.keys(oracleFiles).length === 0) {
    return { id: item.id, framework, error: 'no oracle test files resolved at fix' };
  }

  const verify = [{ name: 'test', cmd: ['node', '--import', 'tsx', '--test', '--test-reporter=tap', ...testArgs], type: 'test' }];
  const provision = [...new Set([path.join(runSubdir, 'node_modules'), 'node_modules'])];
  const protectedPaths = [path.join(runSubdir, 'tests'), path.join(runSubdir, 'test'), ...testArgs.map((a) => path.join(runSubdir, a))];
  const common = {
    repoDir: root, verify, runSubdir, provision, protectedPaths,
    acceptanceFilter: () => true, // every test in the named (scoped) files must pass
    attempts: 1, perStepTimeoutMs: 180000,
  };

  // BASE: known-wrong source + materialized fix-verifier -> expect RED (pruned).
  const baseRes = await gateRunner({ ...common, baseRef: base, candidate: { id: `${item.id}:base`, files: {} }, oracleFiles });
  // FIX: fix tree as-is -> expect GREEN.
  const fixRes = await gateRunner({ ...common, baseRef: fix, candidate: { id: `${item.id}:fix`, files: {} } });

  const red = baseRes.gate === 'pruned';
  const green = fixRes.gate === 'green';
  let verdict;
  if (green && red) verdict = 'DISCRIMINATES';
  else if (green && baseRes.gate === 'green') verdict = 'BASE-ALSO-GREEN (refactor → needs mutants)';
  else if (green) verdict = `BASE-${baseRes.gate.toUpperCase()}:${baseRes.failStep} (investigate)`;
  else verdict = `FIX-NOT-GREEN:${fixRes.gate}/${fixRes.failStep} (investigate)`;
  return { id: item.id, framework, root, runSubdir, base, fix, baseGate: pick(baseRes), fixGate: pick(fixRes), red, green, verdict };
}

const pick = (r) => {
  const t = r.perTest || {};
  const tot = Object.keys(t).length;
  const pass = Object.values(t).filter((s) => s === 'pass').length;
  return { gate: r.gate, failStep: r.failStep, pass, tot, provisioned: r.provisioned };
};

const wanted = process.argv.slice(2);
const positives = BENCH.items.filter((i) => i.kind === 'search-shaped');
const targets = (wanted.length ? BENCH.items.filter((i) => wanted.includes(i.id)) : positives);

console.log(`pilot-runner: ${targets.length} item(s) — driving the gate-runner\n`);
const results = [];
for (const item of targets) {
  process.stdout.write(`• ${item.id} … `);
  const r = await discriminate(item);
  results.push(r);
  if (r.skipped) console.log(`SKIPPED (framework=${r.framework}, v1 supports node-tsx)`);
  else if (r.error) console.log(`ERROR: ${r.error}`);
  else console.log(`${r.verdict}  [base ${r.baseGate.pass}/${r.baseGate.tot} (${r.baseGate.gate}), fix ${r.fixGate.pass}/${r.fixGate.tot} (${r.fixGate.gate})]`);
}
console.log('\n=== summary ===');
for (const r of results) {
  if (r.skipped) { console.log(`  SKIP  ${r.id} (${r.framework})`); continue; }
  if (r.error) { console.log(`  ERR   ${r.id}: ${r.error}`); continue; }
  const tag = r.red && r.green ? 'PASS' : r.verdict.startsWith('BASE-ALSO') ? 'NOTE' : 'FAIL';
  console.log(`  ${tag}  ${r.id}: ${r.verdict}`);
}
