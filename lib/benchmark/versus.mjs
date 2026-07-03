// versus — Fable vs super-godcode bench runner (round 1, node-tsx items only).
//
// Per item, both arms get an identical ARENA: a detached worktree of the item's repo at baseSha
// with the fix's ORACLE TEST committed on top (realistic Path A shape — suite present, authors
// oracle-blind by instruction, gate rejects test-touching diffs). Each arm works in its own
// worktree off the arena sha; BOTH arms are scored by the same gateRunner run out-of-band.
//
//   node versus.mjs arena <itemId>            create arena, print meta JSON
//   node versus.mjs armdir <itemId> <arm>     create arm worktree (arm = fable|super)
//   node versus.mjs gate <itemId> <arm>       gate the arm dir's diff vs arena sha, print verdict JSON
//   node versus.mjs run <itemId> <arm>        full arm run: armdir -> headless claude -> gate
//                                             (fable: +1 sanitised-evidence repair round if red)
//   node versus.mjs teardown <itemId>         remove the item's worktrees
//
// State: ~/godcode-bench/<itemId>/{arena,fable,super,meta.json,*.out}
// Results: appended to ~/godcode-bench/results.jsonl  (one row per arm run)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeItem } from './materialize.mjs';
import { gateRunner } from '../gate-runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = path.join(os.homedir(), 'godcode-bench');
const RESULTS = path.join(BENCH_ROOT, 'results.jsonl');
const BENCH = JSON.parse(fs.readFileSync(path.join(HERE, 'benchmark.json'), 'utf8'));
const HIGH = (() => { try { const j = JSON.parse(fs.readFileSync(path.join(HERE, 'specs-high-altitude.json'), 'utf8')); return Object.fromEntries((j.items ?? j).map((s) => [s.id, s.spec])); } catch { return {}; } })();

const ARM_CFG = {
  fable: { model: 'claude-fable-5', effort: 'high', timeoutMin: 40 },
  super: { model: 'claude-opus-4-8', effort: 'xhigh', timeoutMin: 150 },
  ultra: { model: 'claude-opus-4-8', effort: 'xhigh', timeoutMin: 120, env: { CLAUDE_CODE_WORKFLOWS: '1', CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' } },
  'fable-med': { model: 'claude-fable-5', effort: 'medium', timeoutMin: 40 },
  'fable-low': { model: 'claude-fable-5', effort: 'low', timeoutMin: 40 },
};

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
const git = (repo, args) => { const r = sh('git', ['-C', repo, ...args]); if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`); return r.stdout; };
const die = (m) => { console.error(m); process.exit(1); };

const [cmd, itemId, armName] = process.argv.slice(2);
const item = BENCH.items.find((i) => i.id === itemId) || die(`unknown item ${itemId}`);
const m = materializeItem(item);
if (!m.supported) die(`item ${itemId}: framework ${m.framework} unsupported in round 1`);
const spec = HIGH[itemId] || item.spec || die(`no spec for ${itemId}`);
const dirs = { item: path.join(BENCH_ROOT, itemId) };
dirs.arena = path.join(dirs.item, 'arena');
dirs.meta = path.join(dirs.item, 'meta.json');
const armDirFor = (a) => path.join(dirs.item, a);

function makeArena() {
  fs.mkdirSync(dirs.item, { recursive: true });
  if (fs.existsSync(dirs.arena)) return JSON.parse(fs.readFileSync(dirs.meta, 'utf8'));
  git(m.root, ['worktree', 'add', '--detach', dirs.arena, m.base]);
  for (const [rel, content] of Object.entries(m.oracleFiles)) {
    const abs = path.join(dirs.arena, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    git(dirs.arena, ['add', rel]);
  }
  git(dirs.arena, ['-c', 'user.name=bench', '-c', 'user.email=bench@local', 'commit', '-m', `bench arena: ${itemId} oracle`]);
  const arenaSha = git(dirs.arena, ['rev-parse', 'HEAD']).trim();
  const meta = { itemId, root: m.root, base: m.base, arenaSha, runSubdir: m.runSubdir, testArgs: m.testArgs, kind: item.kind };
  fs.writeFileSync(dirs.meta, JSON.stringify(meta, null, 2));
  return meta;
}

function makeArmDir(arm) {
  const meta = makeArena();
  const dir = armDirFor(arm);
  if (!fs.existsSync(dir)) {
    git(m.root, ['worktree', 'add', '--detach', dir, meta.arenaSha]);
    for (const p of m.provision) {
      const src = path.join(m.root, p), dst = path.join(dir, p);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst);
    }
  }
  return { ...meta, armDir: dir };
}

function collectCandidate(arm) {
  const dir = armDirFor(arm);
  const meta = JSON.parse(fs.readFileSync(dirs.meta, 'utf8'));
  const changed = git(dir, ['diff', '--name-only', meta.arenaSha]).split('\n').map((s) => s.trim()).filter(Boolean);
  const untracked = git(dir, ['ls-files', '--others', '--exclude-standard']).split('\n').map((s) => s.trim()).filter(Boolean);
  const files = {};
  const skipped = [];
  for (const rel of [...new Set([...changed, ...untracked])]) {
    if (rel.startsWith('BENCH-')) continue;
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) { skipped.push(`${rel} (deleted — deletion-gating unsupported)`); continue; }
    if (fs.lstatSync(abs).isSymbolicLink()) continue;
    files[rel] = fs.readFileSync(abs, 'utf8');
  }
  return { files, skipped, meta };
}

function sanitiseEvidence(gr) {
  const failing = Object.entries(gr.perTest ?? {}).filter(([, v]) => v === 'fail').map(([k]) => k).slice(0, 15);
  let messages = [];
  try {
    const raw = fs.readFileSync(path.join(gr.evidencePath, 'test.log'), 'utf8');
    messages = raw.split('\n').filter((l) => /not ok|error:|assert|expected|actual|throw/i.test(l) && !/^ok /.test(l)).slice(0, 25);
  } catch { try {
    const dirFiles = fs.readdirSync(gr.evidencePath).filter((f) => /\.(log|txt)$/.test(f));
    for (const f of dirFiles) {
      const raw = fs.readFileSync(path.join(gr.evidencePath, f), 'utf8');
      messages.push(...raw.split('\n').filter((l) => /not ok|error:|assert|expected|actual/i.test(l)).slice(0, 10));
    }
    messages = messages.slice(0, 25);
  } catch { /* no evidence readable */ } }
  return { failing, messages };
}

async function gateArm(arm) {
  const { files, skipped, meta } = collectCandidate(arm);
  if (!Object.keys(files).length) return { gate: 'no-candidate', skipped, files: [] };
  const gr = await gateRunner({
    repoDir: m.root, baseRef: meta.arenaSha,
    candidate: { id: `${itemId}-${arm}`, files },
    verify: m.verify, protectedPaths: m.protectedPaths, provision: m.provision, runSubdir: m.runSubdir,
    attempts: 2, perStepTimeoutMs: 300000,
  });
  const evidence = gr.gate === 'green' ? { failing: [], messages: [] } : sanitiseEvidence(gr);
  return { gate: gr.gate, failStep: gr.failStep ?? null, acceptancePass: gr.acceptancePass ?? null, evidencePath: gr.evidencePath ?? null, files: Object.keys(files), skipped, ...evidence };
}

function claudeRun(arm, prompt, outFile) {
  const cfg = ARM_CFG[arm];
  const t0 = Date.now();
  const r = sh('claude', ['-p', '--model', cfg.model, '--effort', cfg.effort, '--dangerously-skip-permissions', prompt], {
    cwd: armDirFor(arm), timeout: cfg.timeoutMin * 60_000, env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', ...(cfg.env ?? {}) },
  });
  fs.writeFileSync(outFile, `EXIT ${r.status}\n--- STDOUT ---\n${r.stdout}\n--- STDERR ---\n${r.stderr}`);
  return { exit: r.status, timedOut: r.signal === 'SIGTERM' && Date.now() - t0 >= cfg.timeoutMin * 60_000 - 5000, secs: Math.round((Date.now() - t0) / 1000) };
}

const RULES = `HARD RULES (a mechanical gate enforces these — violations are auto-rejected):
- ORACLE-BLIND: do NOT open, read, grep, or reference ANY test file (tests/ dir, *.test.ts), CI config, or lockfile. Implement from the requirement and the SOURCE only. A diff touching tests/CI/lockfiles is REJECTED.
- Edit only SOURCE files under ${m.runSubdir}/src. Read them first to learn real types/helpers; make minimal correct edits satisfying every part of the requirement.
- You MAY run the TypeScript typecheck (e.g. npx tsc --noEmit, from ${m.runSubdir}) and iterate until clean. You may NOT run any test command.
- Work entirely inside the current directory (a git worktree). Do not commit. Your edits on disk are the deliverable. Finish with a one-line summary.`;

function fablePrompt() {
  return `You are an autonomous coding agent fixing a real issue in this repository (cwd = the repo worktree).\n\nTASK (the only description you get — work out the implementation yourself):\n${spec}\n\n${RULES}`;
}
function fableRepairPrompt(ev) {
  return `You are repairing your own earlier attempt (its edits are already in this worktree). An external verifier ran your change and reported the failures below. Fix your change so these pass, WITHOUT weakening or working around anything. The same HARD RULES apply (oracle-blind; source-only; typecheck allowed, tests forbidden).\n\nTASK:\n${spec}\n\nFAILING ACCEPTANCE TESTS:\n${ev.failing.join('\n') || '(names unavailable)'}\n\nFAILURE MESSAGES (truncated):\n${ev.messages.join('\n') || '(none captured)'}\n\n${RULES}`;
}
function ultraPrompt() {
  return `You are an autonomous coding agent fixing a real issue in this repository (cwd = the repo worktree). Use ultracode multi-agent orchestration: fan out a Workflow of parallel candidate implementations / adversarial critique / synthesis — whatever orchestration you judge best. This instruction opts you in; spend what the problem needs.\n\nTASK (the only description you get — work out the implementation yourself):\n${spec}\n\n${RULES}\n- The HARD RULES bind EVERY agent you spawn AND you as orchestrator: no agent may open, read, grep, or reference any test file, CI config, or lockfile — implement and self-review from the requirement and SOURCE only (typecheck allowed, tests forbidden). The final state of THIS worktree is the deliverable.`;
}
function superPrompt(meta) {
  const verifyCmd = `cd ${path.join(meta.armDir ?? armDirFor('super'), m.runSubdir)} && node --import tsx --test --test-reporter=tap ${m.testArgs.join(' ')}`;
  return `/super-godcode ${JSON.stringify(spec)} --repo ${armDirFor('super')} --verify ${JSON.stringify(verifyCmd)} --base ${meta.arenaSha} --max 8 --repair 1\n\nBENCH MODE (headless — read carefully):\n- There is NO human available. SKIP the clarification round entirely: do not call AskUserQuestion; record one Decision "headless bench run — spec taken as complete" and proceed autonomously.\n- If the dossier init fails for any reason, continue without the live page.\n- Single-best output; do NOT use --slate.\n- The repo's suite lives at ${m.runSubdir}/tests — authors stay oracle-blind per the skill, AND SO DO YOU (the orchestrator): never Read/Grep/cat any test file during this run; diagnose reds only from the gate's failing-test names + assertion messages.\n- WHEN FINISHED: if a VERIFIED candidate shipped, apply its diff to the working tree of ${armDirFor('super')} (git apply / copy the changed files) so the files on disk ARE the shipped fix; then write BENCH-RESULT.txt in that directory with lines: "decision: <ship contract decision>", "draws: <total author draws>", "greens: <n>". If you decline, leave the tree unchanged and write BENCH-RESULT.txt with "decision: declined" and why.`;
}

function appendResult(row) {
  fs.mkdirSync(BENCH_ROOT, { recursive: true });
  fs.appendFileSync(RESULTS, JSON.stringify(row) + '\n');
}

async function runArm(arm) {
  const cfg = ARM_CFG[arm] ?? die(`arm must be fable|super|ultra|fable-med|fable-low`);
  const meta = makeArmDir(arm);
  const outFile = path.join(dirs.item, `${arm}.out`);
  const t0 = Date.now();
  let draws = 1, repaired = false, sessions = [];

  if (arm === 'fable' || arm === 'ultra' || arm === 'fable-med' || arm === 'fable-low') {
    sessions.push(claudeRun(arm, arm === 'ultra' ? ultraPrompt() : fablePrompt(), outFile));
    let verdict = await gateArm(arm);
    if (verdict.gate !== 'green' && verdict.gate !== 'no-candidate') {
      repaired = true; draws = 2;
      sessions.push(claudeRun(arm, fableRepairPrompt(verdict), outFile.replace('.out', '-repair.out')));
      verdict = await gateArm(arm);
    }
    finish(arm, meta, verdict, { draws, repaired, sessions, t0 });
  } else {
    sessions.push(claudeRun(arm, superPrompt(meta), outFile));
    const verdict = await gateArm(arm);
    let benchNote = '';
    try { benchNote = fs.readFileSync(path.join(armDirFor(arm), 'BENCH-RESULT.txt'), 'utf8').slice(0, 500); } catch { /* none */ }
    const drawsMatch = benchNote.match(/draws:\s*(\d+)/);
    finish(arm, meta, verdict, { draws: drawsMatch ? Number(drawsMatch[1]) : null, repaired: null, sessions, t0, benchNote });
  }
}

function finish(arm, meta, verdict, extra) {
  const row = {
    ts: new Date().toISOString(), item: itemId, kind: item.kind, arm,
    model: ARM_CFG[arm].model, effort: ARM_CFG[arm].effort,
    gate: verdict.gate, failStep: verdict.failStep ?? null, failing: verdict.failing ?? [],
    filesChanged: verdict.files ?? [], skipped: verdict.skipped ?? [],
    draws: extra.draws, repaired: extra.repaired,
    wallClockSec: Math.round((Date.now() - extra.t0) / 1000),
    sessions: extra.sessions, benchNote: extra.benchNote ?? null, armDir: armDirFor(arm),
  };
  appendResult(row);
  console.log(JSON.stringify(row, null, 2));
}

function teardown() {
  for (const a of ['fable', 'super', 'ultra', 'fable-med', 'fable-low', 'arena']) {
    const d = path.join(dirs.item, a);
    if (fs.existsSync(d)) { try { git(m.root, ['worktree', 'remove', '--force', d]); } catch { fs.rmSync(d, { recursive: true, force: true }); } }
  }
}

if (cmd === 'arena') console.log(JSON.stringify(makeArena(), null, 2));
else if (cmd === 'armdir') console.log(JSON.stringify(makeArmDir(armName ?? die('arm?')), null, 2));
else if (cmd === 'gate') gateArm(armName ?? die('arm?')).then((v) => console.log(JSON.stringify(v, null, 2)));
else if (cmd === 'run') runArm(armName ?? die('arm?'));
else if (cmd === 'teardown') teardown();
else die('usage: versus.mjs arena|armdir|gate|run|teardown <itemId> [fable|super]');
