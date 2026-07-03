// vet — confirm a mined commit is a valid SWE-bench-shaped item: its fix's tests, run against the
// PARENT source, must FAIL (RED), and against the fix source must PASS (GREEN). Derives the changed
// test/source files from git, materializes the verifier, and gates base vs fix via the real gate.
// Usage: node vet.mjs <sha> [<sha> ...]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { gateRunner } from '../gate-runner.mjs';

const REPO = '/Users/codepanda/Felt';
const SUB = 'src/Felt.AgentService';
const git = (args) => spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).stdout;

async function vet(sha) {
  const base = `${sha}^`;
  const numstat = git(['show', '--numstat', '--format=', sha]).trim().split('\n');
  const changed = numstat.map((l) => l.split('\t')[2]).filter(Boolean);
  const testRel = changed.filter((p) => p.startsWith(`${SUB}/tests/`) && p.endsWith('.test.ts')).map((p) => p.slice(SUB.length + 1));
  const srcRel = changed.filter((p) => p.startsWith(`${SUB}/src/`) && p.endsWith('.ts') && !p.endsWith('.test.ts')).map((p) => p.slice(SUB.length + 1));
  if (!testRel.length) return { sha, error: 'no test files' };

  const oracleFiles = {};
  for (const t of testRel) { const c = git(['show', `${sha}:${SUB}/${t}`]); if (c) oracleFiles[`${SUB}/${t}`] = c; }
  const verify = [{ name: 'test', cmd: ['node', '--import', 'tsx', '--test', '--test-reporter=tap', ...testRel], type: 'test' }];
  const provision = [...new Set([`${SUB}/node_modules`, 'node_modules'])];
  const protectedPaths = [`${SUB}/tests`, ...testRel.map((t) => `${SUB}/${t}`)];
  const common = { repoDir: REPO, verify, runSubdir: SUB, provision, protectedPaths, acceptanceFilter: () => true, attempts: 1, perStepTimeoutMs: 180000 };

  const baseRes = await gateRunner({ ...common, baseRef: base, candidate: { id: `${sha.slice(0, 7)}:base`, files: {} }, oracleFiles });
  const fixRes = await gateRunner({ ...common, baseRef: sha, candidate: { id: `${sha.slice(0, 7)}:fix`, files: {} } });
  const red = baseRes.gate === 'pruned';
  const green = fixRes.gate === 'green';
  const tally = (r) => r.perTest ? `${Object.values(r.perTest).filter((s) => s === 'pass').length}/${Object.keys(r.perTest).length}` : `(${r.gate}/${r.failStep})`;
  return {
    sha: sha.slice(0, 8), srcRel, testRel, srcN: srcRel.length,
    base: tally(baseRes), fix: tally(fixRes), red, green,
    verdict: green && red ? 'DISCRIMINATES' : green ? `base-${baseRes.gate} (no RED)` : `fix-${fixRes.gate}:${fixRes.failStep}`,
  };
}

const shas = process.argv.slice(2);
for (const sha of shas) {
  const r = await vet(sha);
  if (r.error) { console.log(`${sha.slice(0, 8)}  ERROR ${r.error}`); continue; }
  console.log(`${r.sha}  ${r.red && r.green ? 'PASS' : 'FAIL'}  ${r.verdict}  [base ${r.base} -> fix ${r.fix}]  src[${r.srcRel.join(',')}] test[${r.testRel.join(',')}]`);
}
