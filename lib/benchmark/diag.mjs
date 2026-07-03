// diag — closeness diagnostic for a too-hard (0/N) benchmark item. Distinguishes an
// UNDERSPECIFIED spec (the closest author flips all-but-one of the bug-relevant tests — they got
// the fix, missed a detail the spec didn't pin) from a TRUE honest-thesis BOUNDARY (the closest
// author flips ~none — the core insight is unreachable for blind Opus).
//
// Method: gate the FIX (reference: must be GREEN, gives the canonical test set) and the BASE (gives
// the TARGET set = the tests the bug breaks, which an author must flip). Then gate each authored
// worktree and count, of that target set, how many flipped to pass (and any regressions — tests
// that passed at base but now fail). Closeness = max flips across authors.
//
// Usage: node diag.mjs <itemId> <worktreesRoot>
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeItem } from './materialize.mjs';
import { gateRunner } from '../gate-runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH = JSON.parse(readFileSync(path.join(HERE, 'benchmark.json'), 'utf8'));

async function gate(m, id, files) {
  const wtRoot = mkdtempSync(path.join(tmpdir(), 'gcdiag-wt-'));
  const evDir = mkdtempSync(path.join(tmpdir(), 'gcdiag-ev-'));
  try {
    const res = await gateRunner({
      repoDir: m.root, baseRef: m.base, candidate: { id, files },
      verify: m.verify, acceptanceFilter: () => true,
      protectedPaths: m.protectedPaths, oracleFiles: m.oracleFiles,
      provision: m.provision, runSubdir: m.runSubdir,
      attempts: 1, perStepTimeoutMs: 180000, worktreeRoot: wtRoot, evidenceDir: evDir,
    });
    return res;
  } finally {
    rmSync(wtRoot, { recursive: true, force: true });
    rmSync(evDir, { recursive: true, force: true });
  }
}

export async function diagItem(itemId, wtRoot) {
  const item = BENCH.items.find((i) => i.id === itemId);
  if (!item) throw new Error(`no item ${itemId}`);
  const m = materializeItem(item);
  if (!m.supported) return { item: itemId, error: `unsupported ${m.framework}` };

  // Reference gates: fix (canonical pass set) + base (target set the bug breaks).
  const fixRes = await gate(m, '__fix__', m.fixSource);
  const baseRes = await gate(m, '__base__', m.baseSource);
  const fixPt = fixRes.perTest || {};
  const basePt = baseRes.perTest || {};
  const allTests = Object.keys(fixPt);
  const target = allTests.filter((t) => basePt[t] !== 'pass'); // bug-relevant: fail (or absent) at base, pass at fix
  const ref = {
    fixGate: fixRes.gate, fixPass: Object.values(fixPt).filter((s) => s === 'pass').length, fixTotal: allTests.length,
    baseGate: baseRes.gate, baseFailStep: baseRes.failStep,
    targetCount: target.length, target,
  };

  // Each authored worktree: how many target tests flipped to pass? Any regressions?
  const authorDirs = readdirSync(wtRoot).filter((d) => d.startsWith('author-')).sort();
  const rows = [];
  for (const d of authorDirs) {
    const files = {};
    for (const rel of m.sourceFiles) {
      const p = path.join(wtRoot, d, rel);
      files[rel] = existsSync(p) ? readFileSync(p, 'utf8') : m.baseSource[rel];
    }
    const res = await gate(m, d, files);
    const pt = res.perTest || {};
    const ran = Object.keys(pt).length > 0;
    const flipped = target.filter((t) => pt[t] === 'pass');
    const stillFailing = target.filter((t) => pt[t] !== 'pass');
    // regressions: tests that passed at base but fail for this author
    const basePassers = allTests.filter((t) => basePt[t] === 'pass');
    const regressions = basePassers.filter((t) => pt[t] !== undefined && pt[t] !== 'pass');
    rows.push({
      id: d, gate: res.gate, failStep: res.failStep, ran,
      flipped: flipped.length, regressions: regressions.length,
      stillFailing, regressed: regressions,
    });
  }
  rows.sort((a, b) => b.flipped - a.flipped || a.regressions - b.regressions);
  return { item: itemId, ref, rows };
}

// CLI (robust to paths with spaces: compare decoded path, not the URL-encoded form)
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = await diagItem(process.argv[2], process.argv[3]);
  if (r.error) { console.log(`${r.item}: ERROR ${r.error}`); process.exit(0); }
  const { ref } = r;
  console.log(`\n=== closeness diagnosis: ${r.item} ===`);
  console.log(`reference: fix gate=${ref.fixGate} (${ref.fixPass}/${ref.fixTotal} pass) | base gate=${ref.baseGate} (${ref.baseFailStep || 'ok'})`);
  console.log(`TARGET set (bug-relevant tests an author must flip): ${ref.targetCount}`);
  for (const t of ref.target) console.log(`    - ${t}`);
  console.log(`\nauthor          gate       flipped/target   regressions   still-failing`);
  for (const row of r.rows) {
    console.log(`${row.id.padEnd(14)}  ${(row.gate || '').padEnd(10)} ${String(row.flipped).padStart(3)}/${ref.targetCount}            ${String(row.regressions).padStart(3)}          ${row.stillFailing.length ? row.stillFailing.join('; ') : '(none — GREEN on target)'}`);
  }
  const best = r.rows[0];
  const verdict = best.flipped >= ref.targetCount - 1 && best.regressions === 0
    ? `UNDERSPECIFIED-LEANING — closest author flipped ${best.flipped}/${ref.targetCount} (missed ${ref.targetCount - best.flipped}), 0 regressions: the fix was nearly reached; likely a spec detail not pinned.`
    : best.flipped === 0
      ? `TRUE BOUNDARY — closest author flipped 0/${ref.targetCount}: the core insight is unreachable for blind Opus.`
      : `MIXED — closest author flipped ${best.flipped}/${ref.targetCount} with ${best.regressions} regression(s): partial reach; inspect the still-failing tests.`;
  console.log(`\nVERDICT: ${verdict}`);
}
