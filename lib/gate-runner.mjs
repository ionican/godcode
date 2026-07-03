// gate-runner — the /godcode out-of-band correctness gate primitive.
//
// Runs a project's REAL verify steps (build/types/lint/test) as deterministic OS
// processes over a candidate patch in an ISOLATED git worktree, and returns a
// structured GateResult with PER-TEST results (which G1/dispersion consumes).
//
// Invariants enforced here (not asked of any model):
//   - IMMUTABILITY GUARD: a candidate diff that touches a protected path
//     (tests / CI config / lockfiles) is rejected outright — a candidate must not
//     grade itself by weakening the oracle or adding a dependency.
//   - FLAKY-RETRY: each step runs N times; FAIL only on deterministic failure
//     across all runs; a step that flips is QUARANTINED (-> incomplete), never scored.
//   - HANG-AS-RETRYABLE: a timed-out / stalled step is a distinct retryable failure
//     class; all-attempts-hung -> circuit-break to INCOMPLETE (bounded attempts).
//   - WORKTREE ISOLATION: every candidate runs in its own `git worktree`.
//
// Exit codes / parsed counts ARE the reward. No in-context "please verify".

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm, realpath, symlink, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

async function pathExists(p) { try { await lstat(p); return true; } catch { return false; } }

/** Run a command with a hard timeout; kills the whole process group on timeout. */
export function runCmd(cmd, args, { cwd, timeoutMs = 10000, env } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    let child;
    try {
      // Scrub the parent's test-runner context so a nested `node --test` (the gate's
      // own verify command) runs the suite standalone instead of short-circuiting as
      // a subtest of whatever invoked the gate-runner.
      const childEnv = { ...process.env, ...env };
      delete childEnv.NODE_TEST_CONTEXT;
      child = spawn(cmd, args, { cwd, env: childEnv, detached: true });
    } catch (err) {
      resolve({ exit: 127, stdout: '', stderr: String(err), timedOut: false, ms: 0 });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer;
    let killTimer;
    const finish = (exit) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ exit, stdout, stderr, timedOut, ms: Date.now() - start });
    };
    timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole process group, then WAIT for the child to actually close
      // (reap it) before resolving — but bound the wait so a detached grandchild
      // holding a pipe open cannot wedge the gate. LIMITATION: a grandchild that
      // re-parents into its OWN new process group can survive this; hard containment
      // requires an OS sandbox (container/cgroup) and is a deployment concern.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      killTimer = setTimeout(() => finish(null), 2000);
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { stderr += String(err); finish(timedOut ? null : 127); });
    child.on('close', (code) => finish(timedOut ? null : code));
  });
}

const git = (args, cwd) => runCmd('git', args, { cwd, timeoutMs: 30000 });

/**
 * Parse TAP into structured detail: per-test results + plan + bailout + duplicate flag.
 *
 * INDENTATION-AWARE. node:test (and tsx) emit subtests (describe / t.test) as child points
 * indented 4 spaces per level, under one TOP-LEVEL aggregator point, with a top-level plan of
 * `1..<top-level count>`. So:
 *   - `count`/`plan` completeness is checked at the TOP LEVEL (the aggregators the plan counts),
 *   - per-test detail comes from the LEAVES (the actual assertions), keyed by ancestry path so
 *     the same case name under different `describe` blocks does not false-collide.
 * A point is an aggregator (non-leaf) iff the immediately preceding point is deeper — node:test
 * prints a subtree's children before its parent.
 */
export function parseTapDetailed(stdout) {
  const points = []; // { depth, name, status } in emission order
  let plan = null;   // TOP-LEVEL plan only
  let bailout = false;
  for (const raw of stdout.split('\n')) {
    if (/^\s*Bail out!/.test(raw)) { bailout = true; continue; }
    const indent = raw.length - raw.replace(/^\s+/, '').length;
    const depth = Math.floor(indent / 4);
    const line = raw.trim();
    const pm = /^1\.\.(\d+)$/.exec(line);
    if (pm) { if (depth === 0) plan = Number(pm[1]); continue; }
    const m = /^(not )?ok\s+\d+\s+-\s+(.+)$/.exec(line);
    if (m) points.push({ depth, name: tapName(m[2]), status: m[1] ? 'fail' : 'pass' });
  }
  const isAggregator = points.map((p, i) => i > 0 && points[i - 1].depth > p.depth);
  const count = points.filter((p) => p.depth === 0).length; // top-level points (what the plan counts)
  const perTest = {};
  let duplicate = false;
  points.forEach((p, i) => {
    if (isAggregator[i]) return; // aggregators are not assertions
    const key = ancestryKey(points, i);
    if (Object.prototype.hasOwnProperty.call(perTest, key)) duplicate = true;
    perTest[key] = p.status;
  });
  return { perTest, count, plan, bailout, duplicate };
}

// Extract a TAP test description, honouring TAP escaping: an UNescaped '#' starts a directive
// (TODO/SKIP) and is dropped; '\#' and '\\' are literals. node:test escapes '#' in titles as
// '\#', so naive '#'-splitting truncates names like "AC #1"/"AC #2" to a single false duplicate.
function tapName(rest) {
  let name = '';
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '\\' && i + 1 < rest.length) { name += rest[i + 1]; i++; continue; }
    if (c === '#') break; // unescaped directive delimiter
    name += c;
  }
  return name.trim();
}

// Build a leaf's hierarchical key by walking FORWARD to its ancestors (node:test prints a
// subtree's children before its parent, so each shallower point that follows is an ancestor).
function ancestryKey(points, i) {
  const names = [points[i].name];
  let want = points[i].depth - 1;
  for (let j = i + 1; j < points.length && want >= 0; j++) {
    if (points[j].depth === want) { names.unshift(points[j].name); want--; }
  }
  return names.join(' > ');
}

// A TAP run is COMPLETE only if it is internally consistent: a plan line whose
// count matches the parsed assertions, no `Bail out!`, and no duplicate/ambiguous
// names. This rejects a crashed suite that printed some `ok` lines before dying —
// which, with the runner exit code ignored, could otherwise be scored GREEN on a
// fragment and feed a corrupt per-test vector into G1.
export function tapComplete(detail) {
  return !!detail && !detail.bailout && detail.plan !== null && detail.plan === detail.count && !detail.duplicate;
}

/** Parse TAP into { testName: 'pass'|'fail' }. Returns null if no assertions seen. */
export function parseTap(stdout) {
  const d = parseTapDetailed(stdout);
  return d.count > 0 ? d.perTest : null;
}

// ── TRX (`dotnet test --logger trx`) ─────────────────────────────────────────────────────────────
// `dotnet test` does NOT speak TAP — it writes a TRX (Visual Studio Test Results, XML) FILE. So a
// dotnet test step is declared with `reporter: 'trx'` and a `{{RESULTS_DIR}}` token in its cmd
// (`dotnet test --results-directory {{RESULTS_DIR}} --logger trx …`); the gate substitutes a fresh
// per-attempt dir, runs, and parses the .trx FILE (not stdout) into the SAME { perTest, count, … }
// shape the TAP path yields — so certify + the acceptance floor stay domain-agnostic. The
// no-false-green completeness floor is the TRX's own declared <Counters total> matching the number
// of <UnitTestResult> rows (the analogue of TAP's plan == count); a build break writes NO .trx, and a
// crashed/partial run has total ≠ count — neither can score green. The token the cmd must carry:
export const RESULTS_DIR_TOKEN = '{{RESULTS_DIR}}';

// Decode the five predefined XML entities + numeric refs — TRX attribute values are XML-escaped and
// test names routinely carry quotes / & / < / > from parameterized cases.
function decodeXmlEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // amp LAST, so a literal "&amp;amp;" doesn't collapse twice
}
function safeCodePoint(n) { try { return String.fromCodePoint(n); } catch { return ''; } }

// Pull one attribute's DECODED value out of an element's opening-tag text, tolerant of attribute
// order and single/double quotes. Returns null if absent.
function xmlAttr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"|\\b${name}\\s*=\\s*'([^']*)'`).exec(tag);
  if (!m) return null;
  return decodeXmlEntities(m[1] !== undefined ? m[1] : m[2]);
}

// TRX per-test outcome → the binary the gate scores on. ONLY 'Passed' is a pass; everything else
// (Failed/Error/Timeout/Aborted/Inconclusive/NotExecuted/…) is NOT a pass — so a skipped or errored
// ACCEPTANCE test can never vacuously satisfy the floor.
function trxOutcome(o) {
  if (o === 'Passed') return 'pass';
  if (o === 'NotExecuted' || o === 'Inconclusive' || o === 'Pending') return 'skip';
  return 'fail'; // Failed / Error / Timeout / Aborted / Disconnected / NotRunnable / unknown
}

// The ONLY run-level <ResultSummary outcome> values that represent a clean terminal run: 'Completed'
// (all passed) and 'Failed' (a clean run with failing tests, which we then prune). Anything else —
// Aborted / Error / Timeout / Disconnected / NotRunnable / Inconclusive / Pending / InProgress, OR an
// ABSENT outcome — means the run did not finish cleanly → incomplete (allowlist, not denylist, so an
// unknown/new outcome is conservatively rejected rather than slipping through).
const TRX_GOOD_OUTCOMES = new Set(['Completed', 'Failed']);

/**
 * Parse a TRX document into { perTest, count, total, summaryOutcome, duplicate } — the TRX analogue of
 * parseTapDetailed. `perTest[name]` ∈ 'pass'|'fail'|'skip'; `count` = #UnitTestResult rows;
 * `total` = the declared <Counters total> (null if absent); `summaryOutcome` = <ResultSummary outcome>.
 */
export function parseTrxDetailed(xml) {
  const text = String(xml || '');
  const perTest = {};
  let count = 0;
  let duplicate = false;
  // Every <UnitTestResult …> opening tag (self-closing or container). Attribute values are XML-escaped,
  // so a literal '>' never appears inside a tag — `[^>]*` is safe.
  const re = /<UnitTestResult\b([^>]*)>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = xmlAttr(m[1], 'testName');
    if (name === null) continue; // not a result row
    count++;
    if (Object.prototype.hasOwnProperty.call(perTest, name)) duplicate = true;
    perTest[name] = trxOutcome(xmlAttr(m[1], 'outcome'));
  }
  const counters = /<Counters\b([^>]*)>/.exec(text);
  const totalStr = counters ? xmlAttr(counters[1], 'total') : null;
  const total = totalStr !== null && /^\d+$/.test(totalStr) ? Number(totalStr) : null;
  // The declared failure tally (failed + error + timeout + aborted + notRunnable) — used to detect a
  // summary/rows contradiction (a 'Failed' run with no visible failure, or a 'Completed' run with one).
  const intAttr = (a) => { const v = counters ? xmlAttr(counters[1], a) : null; return v !== null && /^\d+$/.test(v) ? Number(v) : 0; };
  const failedCount = counters ? ['failed', 'error', 'timeout', 'aborted', 'notRunnable'].reduce((s, a) => s + intAttr(a), 0) : null;
  const summary = /<ResultSummary\b([^>]*)>/.exec(text);
  const summaryOutcome = summary ? xmlAttr(summary[1], 'outcome') : null;
  return { perTest, count, total, failedCount, summaryOutcome, duplicate };
}

/**
 * A TRX run is COMPLETE only if it is internally consistent: ≥1 result, the declared <Counters total>
 * equals the parsed <UnitTestResult> count (analogue of TAP plan == count — a run that crashed
 * mid-suite has total ≠ count or no Counters), no duplicate test names, and a run-level outcome that
 * is not an aborted/errored state. (A build break writes NO .trx → readTrxMap returns null; this
 * guards the case where a .trx IS written but is internally broken.)
 */
export function trxComplete(detail) {
  if (!detail || detail.count === 0) return false;
  if (detail.total === null || detail.total !== detail.count) return false;
  if (detail.duplicate) return false;
  // The run-level outcome must be a KNOWN clean-terminal state (present + Completed/Failed).
  if (!TRX_GOOD_OUTCOMES.has(detail.summaryOutcome)) return false;
  // CONSISTENCY — the summary must AGREE with the rows/counters, or the file contradicts itself (an
  // adversarial/buggy .trx, e.g. outcome="Failed" with all-pass rows, must not be scored as a clean
  // pass): Completed ⇒ ZERO failures anywhere; Failed ⇒ at least one failure somewhere.
  const rowFails = Object.values(detail.perTest).filter((v) => v === 'fail').length;
  const failedCount = detail.failedCount || 0;
  if (detail.summaryOutcome === 'Completed' && (rowFails > 0 || failedCount > 0)) return false;
  if (detail.summaryOutcome === 'Failed' && rowFails === 0 && failedCount === 0) return false;
  return true;
}

/** Parse TRX into { testName: 'pass'|'fail'|'skip' }. Returns null if no results. */
export function parseTrx(xml) {
  const d = parseTrxDetailed(xml);
  return d.count > 0 ? d.perTest : null;
}

// Read + merge every *.trx in a results dir into a single perTest map, or null. EVERY file must be
// INDIVIDUALLY complete (trxComplete) BEFORE merging — never sum counts across files first, or two
// individually-incomplete files could add up to a "complete" merged total and score a false green
// (AR CRITICAL). A name collision across files is ambiguous ⇒ null. Zero .trx (build break / no tests
// ran) → null → incomplete; an unreadable file mid-loop → null (the safe outcome).
export async function readTrxMap(dir) {
  let files;
  try { files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.trx')); }
  catch { return null; }
  if (files.length === 0) return null;
  const merged = {};
  for (const f of files) {
    let xml;
    try { xml = await readFile(path.join(dir, f), 'utf8'); } catch { return null; }
    const d = parseTrxDetailed(xml);
    if (!trxComplete(d)) return null; // each file must stand on its own — no summing masks a broken one
    for (const [k, v] of Object.entries(d.perTest)) {
      if (Object.prototype.hasOwnProperty.call(merged, k)) return null; // cross-file duplicate ⇒ ambiguous
      merged[k] = v;
    }
  }
  return merged;
}

// Reasonable immutability-guard defaults per ecosystem (PREFIX-matched from the repo root by
// matchProtected). Callers should ADD their actual test-project path(s) — those are project-specific
// and the gate can't infer them. Universal here: CI config, lockfiles, central build/package props.
export const DEFAULT_PROTECTED_DOTNET = Object.freeze(['.github', 'azure-pipelines.yml', '.azure-pipelines', 'Directory.Build.props', 'Directory.Build.targets', 'Directory.Packages.props', 'nuget.config', 'NuGet.config', 'global.json']);
export const DEFAULT_PROTECTED_VITEST = Object.freeze(['.github', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'vitest.config.ts', 'vitest.config.js', 'vite.config.ts', 'vite.config.js', 'vitest.workspace.ts']);

// Canonicalize a repo-relative path so an attacker cannot dodge a protected-path match with
// `.` / `//` segments (e.g. `test/./suite.test.mjs` vs protected `test/suite.test.mjs`).
function canonPath(s) {
  const x = path.posix.normalize(String(s).replace(/\\/g, '/'));
  return x.replace(/^\.\//, '').replace(/\/+$/, '');
}
function matchProtected(file, patterns) {
  const f = canonPath(file);
  return patterns.some((p) => {
    const pp = canonPath(String(p).replace(/\/\*\*$/, ''));
    return f === pp || f.startsWith(pp + '/');
  });
}

// A filesystem-safe slug for a candidate id used ONLY in worktree/evidence FILENAMES — a hostile
// id (e.g. `../../pwn`) must not become path components that escape worktreeRoot / evidenceDir.
// The real id is always preserved verbatim in the structured result (candidateId).
function slugId(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'cand';
}

// Resolve a candidate-relative path STRICTLY inside the worktree, or null if it
// would escape — absolute path, `..` traversal, or a symlinked ancestor pointing
// out of the root. Without this, `path.join(wt, '../x')` lets an adversarial
// candidate write outside its sandbox and dodge both the immutability guard and
// the in-worktree `git diff`.
async function resolveInside(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0) return null;
  if (path.isAbsolute(rel)) return null;
  if (rel.split(/[\\/]+/).includes('..')) return null;
  let realRoot;
  try { realRoot = await realpath(root); } catch { return null; }
  const dest = path.resolve(realRoot, rel);
  const relCheck = path.relative(realRoot, dest);
  if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) return null;
  // Symlink escape: realpath the nearest EXISTING ancestor of dest and confirm it
  // is still inside realRoot.
  let probe = path.dirname(dest);
  for (;;) {
    try {
      const real = await realpath(probe);
      const rel2 = path.relative(realRoot, real);
      if (rel2.startsWith('..') || path.isAbsolute(rel2)) return null;
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return dest;
}

function classifyCheck(outcomes) {
  if (outcomes.every((o) => o === 'hang')) return 'hang';
  if (outcomes.every((o) => o === 'pass')) return 'pass';
  if (outcomes.every((o) => o === 'fail')) return 'fail';
  return 'flaky';
}

/**
 * Gate one candidate.
 *
 * @param {object} opts
 * @param {string} opts.repoDir            base git repo
 * @param {string} [opts.baseRef='HEAD']
 * @param {{id:string, files:Record<string,string>}} opts.candidate  files to write into the worktree
 * @param {{name:string, cmd:string[], type?:'check'|'test'}[]} opts.verify  ordered, cheap-fail-fast
 * @param {(testName:string)=>boolean} [opts.acceptanceFilter]  tests that must pass for GREEN (default: all)
 * @param {string[]} [opts.protectedPaths]  immutability guard
 * @param {Record<string,string>} [opts.oracleFiles={}]  harness-materialized verifier files
 *                                          (e.g. a SWE-bench test patch) written into the worktree
 *                                          BEFORE the candidate — EXEMPT from the immutability guard
 *                                          (the trusted harness installs the oracle; only the
 *                                          candidate is forbidden from touching it)
 * @param {string[]} [opts.provision=[]]    repo-relative gitignored dep dirs (e.g. node_modules)
 *                                          to symlink from the base repo into the worktree — a
 *                                          fresh worktree has none, so a real verify command can't run
 * @param {number} [opts.perStepTimeoutMs=10000]
 * @param {number} [opts.attempts=3]        runs per step (flaky/hang detection)
 * @param {string} [opts.runSubdir='']       run verify steps from this subdir of the worktree
 *                                          (monorepo support — the package whose deps/tests live deeper)
 * @param {string} [opts.worktreeRoot]      where worktrees are created (default os.tmpdir())
 * @param {string} [opts.evidenceDir]       where full logs are written (default os.tmpdir())
 * @returns {Promise<object>} GateResult
 */
export async function gateRunner(opts) {
  const {
    repoDir,
    baseRef = 'HEAD',
    candidate,
    verify,
    acceptanceFilter = () => true,
    protectedPaths = [],
    oracleFiles = {},
    provision = [],
    runSubdir = '',
    perStepTimeoutMs = 10000,
    attempts = 3,
    worktreeRoot = os.tmpdir(),
    evidenceDir = os.tmpdir(),
  } = opts;

  const result = {
    candidateId: candidate.id,
    gate: 'green',
    failStep: null,
    steps: [],
    perTest: null,
    acceptancePass: null,
    evidencePath: null,
  };
  const evidence = { candidateId: candidate.id, steps: [], perTest: null };

  // IMMUTABILITY GUARD — reject before doing any work if the candidate touches a protected path.
  const touched = Object.keys(candidate.files || {}).filter((f) => matchProtected(f, protectedPaths));
  if (touched.length) {
    result.gate = 'pruned';
    result.failStep = 'immutability-violation';
    result.violations = touched;
    return result;
  }

  const wt = path.join(worktreeRoot, `gr-${slugId(candidate.id)}-${randomUUID().slice(0, 8)}`);
  let worktreeAdded = false;
  try {
    const add = await git(['-C', repoDir, 'worktree', 'add', '--detach', wt, baseRef], undefined);
    if (add.exit !== 0) {
      result.gate = 'incomplete';
      result.failStep = 'worktree-setup';
      result.error = add.stderr.trim();
      return result;
    }
    worktreeAdded = true;

    // PROVISION — share gitignored dependency dirs (node_modules, etc.) from the base
    // repo into the fresh worktree; without them a real-repo verify command can't run.
    // The symlink LOCATION is forced inside the sandbox (escape = setup error, never
    // followed); the TARGET is the base repo's real dir. A path that escapes is a
    // trusted-config error -> INCOMPLETE (not the candidate's fault). A missing source
    // is skipped (a depless repo is legal). These dirs are gitignored, so they never
    // surface in the immutability `git diff` below. NB the linked deps reflect the base
    // repo's CURRENT installed state, not baseRef's — fine when deps don't move across
    // the base/fix commits (the common case).
    const provisioned = [];
    for (const rel of provision) {
      const dest = await resolveInside(wt, rel);
      if (!dest) {
        result.gate = 'incomplete';
        result.failStep = 'provision-setup';
        result.error = `provision path escapes worktree: ${rel}`;
        return await finalize(result, evidence, evidenceDir);
      }
      const src = path.join(repoDir, rel);
      if (!(await pathExists(src))) continue; // nothing installed to share — fine
      await mkdir(path.dirname(dest), { recursive: true });
      await symlink(src, dest).catch((e) => { if (e.code !== 'EEXIST') throw e; });
      provisioned.push(rel);
    }
    if (provisioned.length) result.provisioned = provisioned;

    // ORACLE FILES — harness-materialized verifier (e.g. a SWE-bench test patch). Written by
    // the trusted caller, so they are EXEMPT from the immutability guard: the harness installs
    // the oracle; only the CANDIDATE is forbidden from touching protected paths. Still forced
    // inside the worktree (a harness escape is a setup error).
    for (const [rel, content] of Object.entries(oracleFiles || {})) {
      const dest = await resolveInside(wt, rel);
      if (!dest) {
        result.gate = 'incomplete';
        result.failStep = 'oracle-setup';
        result.error = `oracle path escapes worktree: ${rel}`;
        return await finalize(result, evidence, evidenceDir);
      }
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, content);
    }

    // Apply candidate files — STRICTLY inside the worktree (reject path escapes).
    for (const [rel, content] of Object.entries(candidate.files || {})) {
      const dest = await resolveInside(wt, rel);
      if (!dest) {
        result.gate = 'pruned';
        result.failStep = 'path-escape';
        result.violations = [rel];
        return await finalize(result, evidence, evidenceDir);
      }
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, content);
    }

    // Defensive: confirm no protected path was modified BY THE CANDIDATE in the worktree.
    // Oracle overlays are harness-installed and legitimately may touch protected (test) paths,
    // so they are subtracted before flagging.
    const oracleSet = new Set(Object.keys(oracleFiles || {}).map((f) => f.replace(/^\.?\//, '')));
    const diff = await git(['-C', wt, 'diff', '--name-only'], undefined);
    const changedProtected = diff.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
      .filter((f) => matchProtected(f, protectedPaths))
      .filter((f) => !oracleSet.has(f.replace(/^\.?\//, '')));
    if (changedProtected.length) {
      result.gate = 'pruned';
      result.failStep = 'immutability-violation';
      result.violations = changedProtected;
      return result;
    }

    // Verify steps run from runSubdir (monorepo support), forced inside the worktree.
    const runDir = runSubdir ? await resolveInside(wt, runSubdir) : wt;
    if (!runDir) {
      result.gate = 'incomplete';
      result.failStep = 'runsubdir-setup';
      result.error = `runSubdir escapes worktree: ${runSubdir}`;
      return await finalize(result, evidence, evidenceDir);
    }

    // Run verify steps in order (cheap-fail-fast).
    for (const step of verify) {
      const type = step.type ?? 'check';
      const reporter = step.reporter ?? 'tap';
      const runs = [];
      const stepMaps = []; // per-attempt COMPLETE perTest map (test steps only), or null
      for (let i = 0; i < attempts; i++) {
        // For a TRX (dotnet) test step, give each attempt a FRESH results dir so dotnet's timestamped
        // .trx files never mix across attempts, and substitute the {{RESULTS_DIR}} token in the cmd.
        let cmd = step.cmd;
        let attemptDir = null;
        if (type === 'test' && reporter === 'trx') {
          attemptDir = await mkdtemp(path.join(os.tmpdir(), 'gc-trx-'));
          cmd = step.cmd.map((a) => String(a).replaceAll(RESULTS_DIR_TOKEN, attemptDir));
        }
        const r = await runCmd(cmd[0], cmd.slice(1), { cwd: runDir, timeoutMs: perStepTimeoutMs });
        runs.push(r);
        if (type === 'test') {
          if (r.timedOut) stepMaps.push(null);
          else if (reporter === 'trx') stepMaps.push(await readTrxMap(attemptDir));
          else { const d = parseTapDetailed(r.stdout); stepMaps.push(tapComplete(d) ? d.perTest : null); }
        }
        if (attemptDir) await rm(attemptDir, { recursive: true, force: true }).catch(() => {});
      }
      const stepEvidence = { name: step.name, type, runs: runs.map((r) => ({ exit: r.exit, timedOut: r.timedOut, ms: r.ms, stderr: r.stderr.slice(0, 4000), stdout: r.stdout.slice(0, 8000) })) };
      evidence.steps.push(stepEvidence);

      if (type === 'check') {
        const verdict = classifyCheck(runs.map((r) => (r.timedOut ? 'hang' : r.exit === 0 ? 'pass' : 'fail')));
        result.steps.push({ name: step.name, type, verdict, attempts: runs.map((r) => ({ exit: r.exit, timedOut: r.timedOut, ms: Math.round(r.ms) })) });
        if (verdict === 'pass') continue;
        result.gate = verdict === 'hang' ? 'incomplete' : verdict === 'flaky' ? 'incomplete' : 'pruned';
        result.failStep = verdict === 'hang' ? 'hang' : verdict === 'flaky' ? `${step.name}:flaky` : step.name;
        return await finalize(result, evidence, evidenceDir);
      }

      // type === 'test': a run counts only if its TAP is internally COMPLETE
      // (plan matches count, no bailout/duplicates). Per-test parse drives pass/fail;
      // run-level (hang / disagreement / incomplete-TAP) drives hang vs flaky.
      const hangs = runs.filter((r) => r.timedOut).length;
      const validMaps = stepMaps; // computed per-attempt above (TAP from stdout, or TRX from the .trx file)
      let verdict;
      let perTest = null;
      if (hangs === runs.length) {
        verdict = 'hang';
      } else if (validMaps.every(Boolean) && allEqual(validMaps.map((m) => stableKey(m)))) {
        verdict = 'complete';
        perTest = validMaps[0];
      } else {
        verdict = 'flaky'; // hang+complete mix, incomplete/crashed TAP, or disagreeing maps
      }
      result.steps.push({ name: step.name, type, verdict, attempts: runs.map((r) => ({ exit: r.exit, timedOut: r.timedOut, ms: Math.round(r.ms) })) });

      if (verdict === 'hang') {
        result.gate = 'incomplete';
        result.failStep = 'hang';
        return await finalize(result, evidence, evidenceDir);
      }
      if (verdict === 'flaky') {
        result.gate = 'incomplete';
        result.failStep = `${step.name}:flaky`;
        return await finalize(result, evidence, evidenceDir);
      }
      // complete
      result.perTest = perTest;
      evidence.perTest = perTest;
      // The acceptance set must be PRESENT, not merely non-failing. A suite that fails to
      // load (e.g. an unresolved dependency in a worktree missing its deps) emits only a
      // file-level `not ok` whose name matches no acceptance predicate — leaving
      // acceptance-by-predicate VACUOUSLY satisfied. Refuse to certify a run that produced
      // zero acceptance evidence; that is a false GREEN, the one thing the gate must not emit.
      const matched = Object.keys(perTest).filter((name) => acceptanceFilter(name));
      if (matched.length === 0) {
        result.acceptancePass = false;
        result.gate = 'incomplete';
        result.failStep = `${step.name}:no-acceptance`;
        return await finalize(result, evidence, evidenceDir);
      }
      const accPass = matched.every((name) => perTest[name] === 'pass');
      result.acceptancePass = accPass;
      if (!accPass) {
        result.gate = 'pruned';
        result.failStep = step.name;
        return await finalize(result, evidence, evidenceDir);
      }
    }

    // All steps passed and acceptance (if a test step ran) holds.
    result.gate = 'green';
    return await finalize(result, evidence, evidenceDir);
  } finally {
    if (worktreeAdded) {
      await git(['-C', repoDir, 'worktree', 'remove', '--force', wt], undefined).catch(() => {});
    }
    await rm(wt, { recursive: true, force: true }).catch(() => {});
  }
}

function allEqual(arr) {
  return arr.every((x) => x === arr[0]);
}
function stableKey(map) {
  return Object.keys(map).sort().map((k) => `${k}=${map[k]}`).join(',');
}

async function finalize(result, evidence, evidenceDir) {
  try {
    await mkdir(evidenceDir, { recursive: true });
    const p = path.join(evidenceDir, `${slugId(result.candidateId)}.json`);
    await writeFile(p, JSON.stringify({ ...evidence, gate: result.gate, failStep: result.failStep, acceptancePass: result.acceptancePass }, null, 2));
    result.evidencePath = p;
  } catch { /* evidence is best-effort */ }
  return result;
}
