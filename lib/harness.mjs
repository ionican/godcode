// harness — the LIVE /godcode select driver: gate a cohort of candidate worktrees out-of-band and
// run the triage escalation policy over the real verdicts, emitting an honest ship contract.
//
// This is the deterministic core the /godcode SKILL drives. The SKILL owns the EXPENSIVE half
// (spawning oracle-blind model authors into candidate worktrees — that's the token spend); this
// driver owns the FREE half (gating is OS processes, no tokens) and the DECISION:
//
//   1. gate every candidate worktree via the same gateRunner v0 uses (immutability guard, flaky-
//      retry, hang-as-retryable, no-false-green floor) — each candidate's diff-vs-base IS its change;
//   2. ship any VERIFIED green from the gated cohort (a known green is NEVER left unshipped) and
//      classify the regime (classifyRegime) over the decisive verdicts for the decision label
//      (gate-only / fanned-out / fanned-out-partial / declined) + keepExploring. The sequential
//      draw-by-draw escalation is the SKILL's wave loop (one call per accumulated cohort), not here;
//   3. emit the ship contract — the GREEN to ship, or on a decline the best FAILING candidate
//      (closest to green) tagged for a human gate, plus `keepExploring` telling the SKILL whether
//      MORE authoring (more tokens) could still help (budget not exhausted, regime not yet too-hard).
//
// Re-gating the whole accumulated cohort each round is free, so the SKILL just keeps adding authors
// and re-running this driver until it ships, confidently declines, or hits the global draw budget.
//
// Usage:
//   node harness.mjs --repo <dir> [--base <ref>] --candidates <root> --verify "<cmd>" [--verify ...]
//     [--acceptance <re>] [--protected a,b] [--provision a,b] [--run-subdir d]
//     [--target-greens K=1] [--global-max M=8] [--attempts n=3] [--timeout-ms n] [--json]
//
//   --candidates <root>   dir holding the candidate worktrees (immediate subdirs, e.g. author-0…author-N)
//   --global-max M        the SKILL's TOTAL authoring budget; drives `keepExploring` (default 8)
// Everything else mirrors gate.mjs (the single-candidate v0 CLI) and is forwarded per candidate.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGate } from './gate.mjs';
import { classifyRegime } from './triage.mjs';

function parseArgs(argv) {
  const o = { base: 'HEAD', verify: [], targetGreens: 1, globalMax: 8, attempts: 3, timeoutMs: 120000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--repo') o.repo = next();
    else if (a === '--base') o.base = next();
    else if (a === '--candidates') o.candidates = next();
    else if (a === '--verify') o.verify.push(next());
    else if (a === '--acceptance') o.acceptance = next();
    else if (a === '--protected') o.protected = next();
    else if (a === '--provision') o.provision = next();
    else if (a === '--run-subdir') o.runSubdir = next();
    else if (a === '--target-greens') o.targetGreens = Number(next());
    else if (a === '--global-max') o.globalMax = Number(next());
    else if (a === '--attempts') o.attempts = Number(next());
    else if (a === '--timeout-ms') o.timeoutMs = Number(next());
    else if (a === '--json') o.json = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return o;
}

const passCount = (res) => Object.values(res.perTest || {}).filter((s) => s === 'pass').length;
const failing = (res) => Object.entries(res.perTest || {}).filter(([, s]) => s !== 'pass').map(([n]) => n);

// Gate every candidate worktree under `candidatesRoot` and run triage over the verdicts.
export async function select(o) {
  if (!o.repo) throw new Error('--repo is required');
  if (!o.candidates) throw new Error('--candidates <root> is required');
  if (!o.verify.length) throw new Error('at least one --verify command is required');

  const dirs = readdirSync(o.candidates)
    .map((d) => path.join(o.candidates, d))
    .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } })
    .sort();
  if (!dirs.length) throw new Error(`no candidate subdirs in ${o.candidates}`);

  // 1. Gate each candidate out-of-band (serial: each gateRunner spins its own isolated worktree).
  const gated = [];
  for (const dir of dirs) {
    const id = path.basename(dir);
    let res, nFiles, deletions;
    try { ({ res, nFiles, deletions } = await runGate({ ...o, candidate: dir })); }
    catch (e) { gated.push({ id, dir, gate: 'incomplete', failStep: `gate-error:${e.message}`, pass: 0, total: 0, nFiles: 0, failing: [] }); continue; }
    // The v0 gate does NOT apply a candidate's DELETED files to the isolated worktree (candidateFiles
    // only adds/modifies), so a deletion-only candidate would gate the UNCHANGED base -> a FALSE GREEN
    // (it ships, but the real worktree is broken). Until deletion-aware gating lands, a candidate with
    // un-gated deletions is NOT certifiable: record it 'incomplete' (never green, never shipped).
    const ungatedDel = (deletions && deletions.length) || 0;
    const gate = ungatedDel ? 'incomplete' : res.gate;
    const failStep = ungatedDel ? `ungated-deletion:${ungatedDel}` : (res.failStep || null);
    gated.push({ id, dir, gate, failStep, pass: passCount(res), total: Object.keys(res.perTest || {}).length, nFiles, evidence: res.evidencePath, failing: gate === 'pruned' ? failing(res) : [] });
  }

  // 2. Decide over the FULLY-GATED cohort. triage's sequential early-stop SAVES cost on a live draw
  //    STREAM, but here every candidate is ALREADY gated (gating is free), so the ship rule is simply
  //    "ship a verified green if one exists" — a KNOWN green must NEVER go unshipped (the bug a naive
  //    triage-replay would hit: 16 prunes then a green, triage early-declines on too-hard before
  //    drawing the green). classifyRegime reads the regime over the decisive verdicts; the sequential
  //    draw-by-draw escalation IS the skill's wave loop (it calls this driver once per accumulated
  //    cohort), not an in-driver loop.
  const globalMax = Number.isFinite(o.globalMax) ? o.globalMax : 8;        // guard NaN from a bad CLI arg
  const targetGreens = Number.isFinite(o.targetGreens) ? o.targetGreens : 1;
  const greens = gated.filter((g) => g.gate === 'green');
  const shipped = greens.length ? greens[0] : null;        // first green in sorted (probe-first) order
  const pruned = gated.filter((g) => g.gate === 'pruned');
  const bestFailing = pruned.length
    ? pruned.slice().sort((a, b) => b.pass - a.pass)[0]   // closest-to-green failing candidate, for a human gate
    : null;

  const decisiveCount = greens.length + pruned.length;
  const noEvidence = decisiveCount === 0;                  // zero decisive verdicts (informational)
  // setupBroken = zero decisive verdicts AND at least one candidate is incomplete for a GATE-FAILURE reason
  // (flaky / no-acceptance / hang / gate-error — anything but our own candidate-specific ungated-deletion
  // override). That means the gate itself couldn't render a verdict (wrong --verify / missing --provision /
  // bad base), so authoring more can't help -> STOP. A cohort whose ONLY incompletes are ungated-deletions
  // is candidate-specific (another author may not delete), so keepExploring survives.
  const gateFailedIncomplete = (g) => g.gate === 'incomplete' && !String(g.failStep || '').startsWith('ungated-deletion');
  const setupBroken = noEvidence && gated.some(gateFailedIncomplete);
  const { regime, p } = classifyRegime(greens.length, decisiveCount);   // pSingle posterior over decisive draws
  const distinctGreens = new Set(greens.map((g) => g.id)).size;
  const targetGreensMet = distinctGreens >= targetGreens;
  const draws = gated.length;                              // realized author cost (every candidate was gated)
  const wantMore = !shipped || !targetGreensMet;          // no green yet, OR a targetGreens>1 cohort unfilled
  const keepExploring = wantMore && regime !== 'too-hard' && !setupBroken && gated.length < globalMax;

  let decision;
  if (!shipped) decision = 'declined';                    // honest decline — never ships
  else if (!targetGreensMet) decision = 'fanned-out-partial';  // a green ships, but the targetGreens>1 cohort is unmet
  else if (draws === 1) decision = 'gate-only';           // a single gated candidate greened — the probe sufficed
  else decision = 'fanned-out';                           // a green among >1 gated — fan-out converted

  let verdictLabel;
  if (shipped) verdictLabel = decision === 'gate-only' ? '✓ VERIFIED (gate-only)'
    : decision === 'fanned-out' ? '✓ VERIFIED (fanned-out)' : '✓ VERIFIED (partial cohort)';
  else if (setupBroken) verdictLabel = '⊘ NO EVIDENCE — the gate produced no decisive verdict; check --verify / --provision / --run-subdir';
  else if (regime === 'too-hard') verdictLabel = '✗ NO-GREEN — declined (regime≈too-hard)';
  else if (keepExploring) verdictLabel = '? NO-GREEN — more authoring may help';
  else verdictLabel = `✗ NO-GREEN — budget ceiling reached (no green in ${draws} draws)`;

  return {
    decision,
    verdict: verdictLabel,
    shipped: shipped ? { id: shipped.id, dir: shipped.dir, changedFiles: shipped.nFiles, pass: shipped.pass, total: shipped.total, evidence: shipped.evidence } : null,
    regime,
    p,
    draws,
    greens: greens.map((g) => g.id),
    targetGreens,
    targetGreensMet,
    keepExploring,
    noEvidence,
    setupBroken,
    bestFailing: bestFailing ? { id: bestFailing.id, dir: bestFailing.dir, pass: bestFailing.pass, total: bestFailing.total, failing: bestFailing.failing.slice(0, 8), failStep: bestFailing.failStep } : null,
    candidates: gated.map((g) => ({ id: g.id, gate: g.gate, pass: g.pass, total: g.total, failStep: g.failStep })),
  };
}

function render(c) {
  const lines = [];
  lines.push(`\n  ${c.verdict}`);
  lines.push(`  decision=${c.decision}  regime=${c.regime}  pSingle=${c.p.point.toFixed(2)} [${c.p.lo.toFixed(2)},${c.p.hi.toFixed(2)}]  draws=${c.draws}  greens=${c.greens.length}/${c.targetGreens}`);
  if (c.shipped) lines.push(`  SHIP -> ${c.shipped.id}  (${c.shipped.changedFiles} changed file(s), ${c.shipped.pass}/${c.shipped.total} tests; evidence ${c.shipped.evidence || 'n/a'})`);
  else if (c.setupBroken) lines.push(`  NO DECISIVE EVIDENCE — the gate produced no verdict. This is a SETUP problem, not a hard bug: check --verify / --provision / --run-subdir before authoring more.`);
  else if (c.keepExploring) lines.push(`  NO GREEN yet — keepExploring=true: author more candidates (cohort ${c.candidates.length} < global-max) and re-run.`);
  else lines.push(`  NO GREEN — honest decline. Best failing candidate for a human gate: ${c.bestFailing ? `${c.bestFailing.id} (${c.bestFailing.pass}/${c.bestFailing.total} tests, ${c.bestFailing.failStep})` : 'none'}`);
  lines.push(`  cohort: ${c.candidates.map((g) => `${g.id}=${g.gate}(${g.pass}/${g.total})`).join('  ')}\n`);
  return lines.join('\n');
}

// CLI (robust to paths with spaces: compare the decoded path, not the URL-encoded form)
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`arg error: ${e.message}`); process.exit(64); }
  let c;
  try { c = await select(o); } catch (e) { console.error(`harness error: ${e.message}`); process.exit(65); }
  if (o.json) { console.log(JSON.stringify(c, null, 2)); }
  else console.log(render(c));
  // exit: 2 keepExploring (author more — INCLUDING a partial cohort that shipped a green but wants the
  //       rest of a targetGreens>1 set) · 0 shipped & done · 1 declined. keepExploring is checked FIRST so
  //       the CLI status never says "stop" (0) while the JSON contract says keepExploring:true.
  process.exit(c.keepExploring ? 2 : c.shipped ? 0 : 1);
}
