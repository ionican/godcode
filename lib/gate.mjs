// gate — /godcode v0 `--gate-only`: the universal-value entrypoint.
//
// Given a candidate change (a git worktree/checkout whose diff vs <base> IS the candidate) and the
// repo's OWN existing test suite, gate the candidate out-of-band — in an isolated worktree, as
// deterministic OS processes — and report ONE of four honest verdicts. It NEVER prints VERIFIED
// unless the real acceptance suite actually passed; it distinguishes "failed" from "couldn't tell"
// from "tried to cheat". This is the load-bearing value proven across the ablation: the gate caught
// every wrong fix and never false-greened (114 author-draws, 0 false-green).
//
// v0 scope: the external suite ALREADY EXISTS in the repo (no SWE-bench oracle materialization —
// that's the benchmark/v1 path). oracleFiles is empty here; protectedPaths still stops a candidate
// from editing the very tests that grade it.
//
// Usage:
//   node gate.mjs --repo <dir> [--base <ref>] [--candidate <dir>] --verify "<cmd>" [...]
//     --repo <dir>          base git repo (the known-good checkout to branch the sandbox from)
//     --base <ref>          base ref to gate against           (default: HEAD)
//     --candidate <dir>     worktree whose diff vs <base> is the candidate (default: --repo)
//     --verify "<cmd>"      a verify command (argv split on spaces); repeatable, run in order
//     --acceptance <regex>  test names that MUST pass for GREEN (default: all)
//     --protected <a,b,..>  paths a candidate may not touch    (default: test dirs + lockfiles + CI)
//     --run-subdir <dir>    run verify from this subdir         (monorepos)
//     --provision <a,b,..>  gitignored dep dirs to symlink in   (e.g. node_modules)
//     --attempts <n>        runs per step; FAIL only if all fail (default: 3)
//     --timeout-ms <n>      per-step timeout                    (default: 120000)
//     --json                emit the raw GateResult as JSON
//
// Exit codes: 0 VERIFIED · 1 NO-GREEN (failed) · 2 INCONCLUSIVE (flaky/hung/no-acceptance) ·
//             3 REJECTED (touched a protected path / path-escape / setup error).
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gateRunner } from './gate-runner.mjs';

const DEFAULT_PROTECTED = ['test', 'tests', '__tests__', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.github'];

function parseArgs(argv) {
  const o = { base: 'HEAD', verify: [], attempts: 3, timeoutMs: 120000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--repo') o.repo = next();
    else if (a === '--base') o.base = next();
    else if (a === '--candidate') o.candidate = next();
    else if (a === '--verify') o.verify.push(next());
    else if (a === '--acceptance') o.acceptance = next();
    else if (a === '--protected') o.protected = next();
    else if (a === '--run-subdir') o.runSubdir = next();
    else if (a === '--provision') o.provision = next();
    else if (a === '--attempts') o.attempts = Number(next());
    else if (a === '--timeout-ms') o.timeoutMs = Number(next());
    else if (a === '--json') o.json = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return o;
}

// The candidate's changed files (rel -> content), read from the candidate checkout. Modified/added
// are materialized into `files`; a deletion or rename/copy is reported as a limitation rather than
// silently dropped — a fresh base-checkout worktree still carries the OLD path, so writing only the
// new content of a rename (and not removing the old path) would NOT faithfully apply the candidate.
// `unfaithful` collects every change this reader cannot replay exactly (deletions + renames/copies),
// so a caller that needs a faithful apply (e.g. certify) can fail SAFE instead of mis-gating.
export function candidateFiles(candidateDir, base) {
  const r = spawnSync('git', ['-C', candidateDir, 'diff', '--name-status', base], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git diff failed in ${candidateDir}: ${r.stderr.trim()}`);
  const files = {};
  const deletions = [];
  const renames = []; // { status, from, to } for R*/C* — old path is NOT removed from a base worktree
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [status, ...rest] = line.split('\t');
    const rel = rest[rest.length - 1];
    if (status.startsWith('D')) { deletions.push(rel); continue; }
    if (status.startsWith('R') || status.startsWith('C')) {
      renames.push({ status, from: rest[0], to: rest[rest.length - 1] });
    }
    const p = path.join(candidateDir, rel);
    if (existsSync(p)) files[rel] = readFileSync(p, 'utf8');
  }
  const unfaithful = [...deletions.map((p) => `delete:${p}`), ...renames.map((r) => `${r.status}:${r.from}->${r.to}`)];
  return { files, deletions, renames, unfaithful };
}

export async function runGate(o) {
  if (!o.repo) throw new Error('--repo is required');
  if (!o.verify.length) throw new Error('at least one --verify command is required');
  const candidateDir = o.candidate || o.repo;
  const { files, deletions } = candidateFiles(candidateDir, o.base);
  const verify = o.verify.map((cmd, i) => ({ name: i === 0 ? 'test' : `verify-${i}`, cmd: cmd.split(/\s+/).filter(Boolean), type: 'test' }));
  const acceptRe = o.acceptance ? new RegExp(o.acceptance) : null;

  const res = await gateRunner({
    repoDir: o.repo,
    baseRef: o.base,
    candidate: { id: 'v0-candidate', files },
    verify,
    acceptanceFilter: acceptRe ? (name) => acceptRe.test(name) : () => true,
    protectedPaths: o.protected ? o.protected.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_PROTECTED,
    provision: o.provision ? o.provision.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    runSubdir: o.runSubdir,
    attempts: o.attempts,
    perStepTimeoutMs: o.timeoutMs,
    worktreeRoot: mkdtempSync(path.join(tmpdir(), 'gc-gate-wt-')),
    evidenceDir: mkdtempSync(path.join(tmpdir(), 'gc-gate-ev-')),
  });
  return { res, nFiles: Object.keys(files).length, deletions };
}

// Map a GateResult to the honest verdict + exit code (no colour — labels/symbols only, per the
// colour-blind UI rule).
function verdict(res) {
  const pt = res.perTest || {};
  const passed = Object.values(pt).filter((s) => s === 'pass').length;
  const total = Object.keys(pt).length;
  if (res.gate === 'green') return { code: 0, label: '✓ VERIFIED', detail: `candidate passes the acceptance suite out-of-band (${passed}/${total} tests). Ship.` };
  if (res.failStep === 'immutability-violation' || res.failStep === 'path-escape')
    return { code: 3, label: '⊘ REJECTED', detail: `candidate touched a protected/oracle path or escaped the worktree (${res.failStep}). NOT certified — a candidate cannot grade itself.` };
  if (res.gate === 'incomplete')
    return { code: 2, label: '? INCONCLUSIVE', detail: `could not determine pass/fail honestly (${res.failStep}: flaky / hung / no acceptance evidence). This is an honest decline, NOT a pass.` };
  // pruned
  const failed = Object.entries(pt).filter(([, s]) => s !== 'pass').map(([n]) => n);
  return { code: 1, label: '✗ NO-GREEN', detail: `candidate FAILED the gate (${res.failStep}). Did NOT certify.${failed.length ? ` Failing: ${failed.slice(0, 5).join('; ')}${failed.length > 5 ? ` (+${failed.length - 5} more)` : ''}` : ''}` };
}

// CLI (robust to paths with spaces: compare decoded path, not the URL-encoded form)
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`arg error: ${e.message}`); process.exit(64); }
  let out;
  try { out = await runGate(o); } catch (e) { console.error(`gate error: ${e.message}`); process.exit(65); }
  const { res, nFiles, deletions } = out;
  if (o.json) { console.log(JSON.stringify({ ...res, nFiles, deletions }, null, 2)); process.exit(verdict(res).code); }
  const v = verdict(res);
  console.log(`\n  ${v.label}  —  ${v.detail}`);
  console.log(`  (candidate: ${nFiles} changed file(s)${deletions.length ? `, ${deletions.length} deletion(s) NOT gated — v0 limitation` : ''}; evidence: ${res.evidencePath || 'n/a'})\n`);
  process.exit(v.code);
}
