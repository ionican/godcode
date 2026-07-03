// gate-runner-trx.test — the TRX (dotnet `--logger trx`) reporter. Two layers:
//   1. PURE fixture tests of parseTrxDetailed / trxComplete / parseTrx — the no-false-green floor:
//      a crashed/partial run (total ≠ count), a missing <Counters>, a duplicate name, a skipped or
//      aborted run, and XML-entity-escaped test names. These ALWAYS run.
//   2. A real end-to-end `gateRunner` run over a tiny xunit project (GREEN / pruned / build-break →
//      incomplete / immutability), skipped when `dotnet` is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { gateRunner, runCmd, parseTrx, parseTrxDetailed, trxComplete, readTrxMap, RESULTS_DIR_TOKEN, DEFAULT_PROTECTED_DOTNET } from './gate-runner.mjs';

// ---- TRX fixture builders ----
const ROW = (name, outcome, container = false) =>
  container
    ? `<UnitTestResult testName="${name}" outcome="${outcome}"><Output><ErrorInfo><Message>boom</Message></ErrorInfo></Output></UnitTestResult>`
    : `<UnitTestResult testName="${name}" outcome="${outcome}" />`;
// Build a realistic TRX: outcome + counters are DERIVED from the rows (Failed if any Failed row) so a
// fixture is internally consistent by default. Override `summaryOutcome` to FORCE a contradiction;
// `total:'omit'` drops <Counters>; `total:N` forces a (possibly mismatched) declared total.
const DOC = (rows, { total, summaryOutcome } = {}) => {
  const failed = rows.filter((r) => /outcome="(Failed|Error|Timeout|Aborted|NotRunnable)"/.test(r)).length;
  const outcome = summaryOutcome ?? (failed > 0 ? 'Failed' : 'Completed');
  const counters = total === 'omit' ? '' : `    <Counters total="${total ?? rows.length}" passed="${Math.max(0, rows.length - failed)}" failed="${failed}" error="0" timeout="0" aborted="0" inconclusive="0" notExecuted="0" />\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
${rows.map((r) => '    ' + r).join('\n')}
  </Results>
  <ResultSummary outcome="${outcome}">
${counters}  </ResultSummary>
</TestRun>`;
};

test('parseTrx: a clean pass/fail run → per-test map, complete', () => {
  const xml = DOC([ROW('N.A', 'Passed'), ROW('N.B', 'Failed', true)], { summaryOutcome: 'Failed' });
  const d = parseTrxDetailed(xml);
  assert.deepEqual(d.perTest, { 'N.A': 'pass', 'N.B': 'fail' });
  assert.equal(d.count, 2);
  assert.equal(d.total, 2);
  assert.equal(trxComplete(d), true);
  assert.deepEqual(parseTrx(xml), { 'N.A': 'pass', 'N.B': 'fail' });
});

test('NO-FALSE-GREEN: a crashed/partial run (total ≠ count) is INCOMPLETE', () => {
  // The declared total (5) exceeds the actual rows (2) — the run died mid-suite. Must NOT be complete,
  // even though both present tests passed (the exact false-green the floor exists to reject).
  const d = parseTrxDetailed(DOC([ROW('N.A', 'Passed'), ROW('N.B', 'Passed')], { total: 5 }));
  assert.equal(d.count, 2);
  assert.equal(d.total, 5);
  assert.equal(trxComplete(d), false);
});

test('NO-FALSE-GREEN: a TRX with no <Counters> (total null) is INCOMPLETE', () => {
  const d = parseTrxDetailed(DOC([ROW('N.A', 'Passed')], { total: 'omit' }));
  assert.equal(d.total, null);
  assert.equal(trxComplete(d), false);
});

test('NO-FALSE-GREEN: a duplicate test name is INCOMPLETE (ambiguous map)', () => {
  const d = parseTrxDetailed(DOC([ROW('N.Dup', 'Passed'), ROW('N.Dup', 'Failed')], { total: 2 }));
  assert.equal(d.duplicate, true);
  assert.equal(trxComplete(d), false);
});

test('NO-FALSE-GREEN: an aborted/errored run-level outcome is INCOMPLETE even if rows look passed', () => {
  for (const bad of ['Aborted', 'Error', 'Timeout', 'Disconnected', 'NotRunnable', 'Inconclusive']) {
    const d = parseTrxDetailed(DOC([ROW('N.A', 'Passed')], { summaryOutcome: bad }));
    assert.equal(trxComplete(d), false, `${bad} run must be incomplete`);
  }
  // …but a clean run that merely has FAILING tests ('Failed') is COMPLETE (so it can be pruned).
  assert.equal(trxComplete(parseTrxDetailed(DOC([ROW('N.A', 'Failed', true)], { summaryOutcome: 'Failed' }))), true);
});

test('skipped tests map to "skip" (not "pass") so an acceptance test that did not run cannot satisfy the floor', () => {
  const d = parseTrxDetailed(DOC([ROW('N.A', 'Passed'), ROW('N.Skip', 'NotExecuted'), ROW('N.Inc', 'Inconclusive')], { total: 3, summaryOutcome: 'Completed' }));
  assert.equal(d.perTest['N.A'], 'pass');
  assert.equal(d.perTest['N.Skip'], 'skip');
  assert.equal(d.perTest['N.Inc'], 'skip');
  assert.equal(trxComplete(d), true); // the run itself is complete; the SKIP just isn't a pass
});

test('XML-entity-escaped test names are decoded; attribute order is tolerated', () => {
  // outcome BEFORE testName, and a name carrying &quot; &amp; &lt; &gt; (parameterized cases).
  const row = '<UnitTestResult outcome="Passed" testName="N.Theory(s: &quot;a&amp;b&lt;c&gt;&quot;)" />';
  const d = parseTrxDetailed(DOC([row], { total: 1 }));
  assert.deepEqual(d.perTest, { 'N.Theory(s: "a&b<c>")': 'pass' });
  assert.equal(trxComplete(d), true);
});

test('parseTrx returns null on a TRX with no results', () => {
  assert.equal(parseTrx(DOC([], { total: 0 })), null);
  assert.equal(parseTrx('not xml at all'), null);
});

// ── Codex AR folds (cross-model review of the TRX gate) ─────────────────────────────────────────
test('AR CRITICAL: multi-file merge does NOT mask individually-incomplete .trx', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gc-trxmerge-'));
  try {
    // a.trx: no <Counters> (incomplete alone). b.trx: total=2 but only 1 row (incomplete alone).
    // Summed, the OLD code got count=2,total=2 → falsely "complete". Each must be rejected on its own.
    await writeFile(path.join(dir, 'a.trx'), DOC([ROW('Acc', 'Passed')], { total: 'omit' }));
    await writeFile(path.join(dir, 'b.trx'), DOC([ROW('Probe', 'Passed')], { total: 2 }));
    assert.equal(await readTrxMap(dir), null, 'two individually-incomplete files must NOT merge into a complete run');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('AR CRITICAL: two COMPLETE .trx merge by distinct name; a cross-file duplicate name ⇒ null', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gc-trxmerge2-'));
  try {
    await writeFile(path.join(dir, 'a.trx'), DOC([ROW('A.one', 'Passed')], { total: 1 }));
    await writeFile(path.join(dir, 'b.trx'), DOC([ROW('B.two', 'Failed', true)], { total: 1 }));
    assert.deepEqual(await readTrxMap(dir), { 'A.one': 'pass', 'B.two': 'fail' });
    await writeFile(path.join(dir, 'b.trx'), DOC([ROW('A.one', 'Failed', true)], { total: 1 })); // same name in both
    assert.equal(await readTrxMap(dir), null, 'a test name in two files is ambiguous ⇒ incomplete');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('AR HIGH: an internally contradictory summary/rows is INCOMPLETE', () => {
  // outcome="Failed" but every row + counter says passed → contradictory → not a clean run.
  assert.equal(trxComplete(parseTrxDetailed(DOC([ROW('Acc', 'Passed')], { total: 1, summaryOutcome: 'Failed' }))), false,
    'a Failed summary with NO failing row/counter is contradictory');
  // outcome="Completed" but a row failed → contradictory.
  assert.equal(trxComplete(parseTrxDetailed(DOC([ROW('Acc', 'Passed'), ROW('Bad', 'Failed', true)], { total: 2, summaryOutcome: 'Completed' }))), false,
    'a Completed summary with a failing row is contradictory');
  // a TRX with NO / unknown ResultSummary outcome → incomplete (a known clean-terminal outcome is required).
  const noOutcome = `<TestRun><Results>${ROW('Acc', 'Passed')}</Results><ResultSummary><Counters total="1" passed="1" failed="0" /></ResultSummary></TestRun>`;
  assert.equal(trxComplete(parseTrxDetailed(noOutcome)), false, 'a TRX with no ResultSummary outcome is incomplete');
  // sanity: a genuinely-clean Failed run (a real failing row) is still COMPLETE → can prune.
  assert.equal(trxComplete(parseTrxDetailed(DOC([ROW('Acc', 'Failed', true)], { total: 1, summaryOutcome: 'Failed' }))), true);
});

// ──────────────────────────────────────────────────────────────────────────────────────────────
// End-to-end: a real `gateRunner` over a tiny xunit project. Skipped when dotnet is unavailable.
let HAS_DOTNET = false;
try { execFileSync('dotnet', ['--version'], { stdio: 'ignore' }); HAS_DOTNET = true; } catch { /* skip */ }

const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><IsPackable>false</IsPackable></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.2" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
  </ItemGroup>
</Project>`;
const TESTS_CS = `using Xunit;
public class Tests {
  [Fact] public void Acc_AddsCorrectly() { Assert.Equal(5, Calc.Add(2, 3)); }
  [Fact] public void Probe_AddZero() { Assert.Equal(2, Calc.Add(2, 0)); }
}`;
const CALC_BUG = `public static class Calc { public static int Add(int a, int b) => a - b; }`;   // base bug
const CALC_FIX = `public static class Calc { public static int Add(int a, int b) => a + b; }`;   // correct
const CALC_WRONG = `public static class Calc { public static int Add(int a, int b) => a * b; }`;  // still wrong
const CALC_SYNTAX = `public static class Calc { public static int Add(int a, int b) => a + ; }`;  // build break

const TRX_VERIFY = [{
  name: 'dotnet-test', type: 'test', reporter: 'trx',
  cmd: ['dotnet', 'test', '--results-directory', RESULTS_DIR_TOKEN, '--logger', 'trx;LogFileName=r.trx', '--nologo', '-v', 'q'],
}];
const trxOpts = (repoDir, candidate, extra = {}) => ({
  repoDir, candidate, verify: TRX_VERIFY,
  acceptanceFilter: (n) => /(^|\.)Acc_/.test(n),
  protectedPaths: [...DEFAULT_PROTECTED_DOTNET, 'Tests.cs'],
  attempts: 1, perStepTimeoutMs: 240000,
  ...extra,
});

async function makeDotnetRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gr-dotnet-'));
  for (const [rel, content] of Object.entries({ 'proj.csproj': CSPROJ, 'Tests.cs': TESTS_CS, 'Calc.cs': CALC_BUG, '.gitignore': 'bin/\nobj/\n' })) {
    await writeFile(path.join(dir, rel), content);
  }
  await runCmd('git', ['init', '-q'], { cwd: dir });
  await runCmd('git', ['add', '-A'], { cwd: dir });
  await runCmd('git', ['-c', 'user.email=ci@local', '-c', 'user.name=ci', 'commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

test('dotnet e2e: TRX reporter gates a real xunit project (GREEN / pruned / build-break / immutability)', { skip: !HAS_DOTNET ? 'dotnet not installed' : false }, async () => {
  const repo = await makeDotnetRepo();
  try {
    // GREEN — the candidate fixes Calc.cs; both acceptance + probe pass via the real .trx.
    const green = await gateRunner(trxOpts(repo, { id: 'fix', files: { 'Calc.cs': CALC_FIX } }));
    assert.equal(green.gate, 'green', `expected green, got ${JSON.stringify({ gate: green.gate, failStep: green.failStep, perTest: green.perTest })}`);
    assert.equal(green.acceptancePass, true);
    assert.equal(green.perTest['Tests.Acc_AddsCorrectly'], 'pass');
    assert.equal(green.perTest['Tests.Probe_AddZero'], 'pass');

    // PRUNED — a wrong fix: acceptance fails, run is COMPLETE, so it prunes (not incomplete).
    const pruned = await gateRunner(trxOpts(repo, { id: 'wrong', files: { 'Calc.cs': CALC_WRONG } }));
    assert.equal(pruned.gate, 'pruned', `expected pruned, got ${pruned.gate}`);
    assert.equal(pruned.perTest['Tests.Acc_AddsCorrectly'], 'fail');

    // BUILD BREAK — a syntax error: no .trx is written → INCOMPLETE, never a false green.
    const broken = await gateRunner(trxOpts(repo, { id: 'syntax', files: { 'Calc.cs': CALC_SYNTAX } }));
    assert.equal(broken.gate, 'incomplete', `a build break must be incomplete, got ${broken.gate}`);
    assert.notEqual(broken.gate, 'green');

    // IMMUTABILITY — a candidate touching the test file is rejected before anything runs.
    const tampered = await gateRunner(trxOpts(repo, { id: 'tamper', files: { 'Calc.cs': CALC_FIX, 'Tests.cs': 'public class Tests {}' } }));
    assert.equal(tampered.failStep, 'immutability-violation');
    assert.equal(tampered.gate, 'pruned');
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  }
});
