// materialize — turn a benchmark item into a ready-to-gate config (the SWE-bench shape):
// resolve the repo, the base (known-wrong) + fix shas, the verifier to materialize as oracleFiles,
// and the gate-runner knobs (provision / runSubdir / protectedPaths). Also extracts the changed
// SOURCE files (fix + base content) so a deterministic replay author can reconstruct the fix.
// Shared by the discrimination pilot and the end-to-end runner. v1 supports the node+tsx framework.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
const git = (repo, args) => sh('git', ['-C', repo, ...args]);

export function classify(verifyCmd) {
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

const isTestPath = (p) => /(^|\/)tests?\//.test(p) || /\.test\.(?:ts|mjs|js)$/.test(p);

export function materializeItem(item) {
  const { cwd, testArgs, framework } = classify(item.verify.cmd);
  if (framework !== 'node-tsx') return { id: item.id, framework, supported: false };
  const root = git(cwd, ['rev-parse', '--show-toplevel']).stdout.trim();
  const runSubdir = path.relative(root, cwd);
  const base = item.baseSha;
  const fix = item.fixSha.split(' ')[0];

  // VERIFIER MATERIALIZATION: the fix's version of each named test file, keyed repo-root-relative.
  const oracleFiles = {};
  for (const arg of testArgs) {
    const rel = path.join(runSubdir, arg);
    const content = git(root, ['show', `${fix}:${rel}`]).stdout;
    if (content) oracleFiles[rel] = content;
  }

  // Changed SOURCE files (non-test) + their fix/base content, for the replay author.
  const changed = git(root, ['diff', '--name-only', base, fix]).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const sourceFiles = changed.filter((p) => !isTestPath(p));
  const fixSource = {};
  const baseSource = {};
  for (const p of sourceFiles) {
    fixSource[p] = git(root, ['show', `${fix}:${p}`]).stdout;
    const b = git(root, ['show', `${base}:${p}`]);
    baseSource[p] = b.status === 0 ? b.stdout : ''; // new-in-fix file -> absent at base
  }

  const verify = [{ name: 'test', cmd: ['node', '--import', 'tsx', '--test', '--test-reporter=tap', ...testArgs], type: 'test' }];
  const provision = [...new Set([path.join(runSubdir, 'node_modules'), 'node_modules'])];
  const protectedPaths = [path.join(runSubdir, 'tests'), path.join(runSubdir, 'test'), ...testArgs.map((a) => path.join(runSubdir, a))];

  return { id: item.id, framework, supported: true, root, base, fix, runSubdir, testArgs, oracleFiles, verify, provision, protectedPaths, sourceFiles, fixSource, baseSource };
}
