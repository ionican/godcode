// ablate — score the fan-out-vs-single-shot ablation on ONE benchmark item, given N authored
// worktrees (each an independent oracle-blind edit of the item's source at base, from a
// solution-free spec). Gates all N candidates through the REAL gate and reports:
//
//   pSingle  = greens / N        — the single-shot success-rate estimate (one author, one draw)
//   anyGreen = greens >= 1        — best-of-N: did the fan-out yield a VERIFIED-correct answer?
//   lift     = anyGreen - pSingle — how much fan-out-N + gate beats a single draw on this item
//
// This is the deterministic SCORER; the model fan-out (the N authors) is upstream. The thesis is
// proven only if, across well-sized items in the right difficulty regime (pSingle ~0.2-0.8),
// anyGreen is reliably 1 at a cost of N draws — i.e. the lift is real and worth <=10x.
//
// Usage: node ablate.mjs <itemId> <worktreesRoot> [authoringTokensTotal]
// Pass the total authoring tokens spent across the N authors to get the cost-adjusted arms.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeItem } from './materialize.mjs';
import { runWaves } from '../runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH = JSON.parse(readFileSync(path.join(HERE, 'benchmark.json'), 'utf8'));

// Gate one item's N authored worktrees and return the ablation metrics. Reusable by the fleet
// scorer. `authoringTokensTotal` (optional) is the summed token spend across the N authors, used
// to express the cost-adjusted arms: gating is ~free (OS processes), so fan-out-N costs ~N×
// single-shot authoring, and that N× is what buys the reliability jump.
export async function scoreItem(itemId, wtRoot, authoringTokensTotal = null) {
  const item = BENCH.items.find((i) => i.id === itemId);
  if (!item) throw new Error(`no item ${itemId}`);
  const m = materializeItem(item);
  if (!m.supported) return { item: itemId, error: `unsupported framework ${m.framework}` };
  const authorDirs = readdirSync(wtRoot).filter((d) => d.startsWith('author-')).sort();
  if (!authorDirs.length) return { item: itemId, error: `no author-* worktrees in ${wtRoot}` };

  const factory = async ({ wave }) => (wave !== 1 ? [] : authorDirs.map((d, i) => {
    const files = {};
    for (const rel of m.sourceFiles) {
      const p = path.join(wtRoot, d, rel);
      files[rel] = existsSync(p) ? readFileSync(p, 'utf8') : m.baseSource[rel];
    }
    return { id: d, isBaseline: i === 0, fn: async () => ({ files, approachTag: d }) };
  }));

  const ship = await runWaves({
    repoDir: m.root, baseRef: m.base, task: { id: item.id, spec: item.spec },
    oracleFiles: m.oracleFiles, probeNames: [],
    gate: { verify: m.verify, acceptanceFilter: () => true, protectedPaths: m.protectedPaths, provision: m.provision, runSubdir: m.runSubdir, attempts: 1, perStepTimeoutMs: 180000 },
    targetK: 3, concurrency: 3, maxWaves: 1, authorFactory: factory,
  });

  const greens = ship.greens.length;
  const n = greens + ship.pruned.length + ship.incomplete.length;
  const pSingle = n ? greens / n : 0;
  const out = {
    item: item.id,
    N: n,
    greens,
    pSingle: Number(pSingle.toFixed(3)),
    anyGreen: greens > 0,
    regime: pSingle === 0 ? 'too-hard' : pSingle >= 1 ? 'too-easy' : 'informative',
    perCandidate: {
      green: ship.greens.map((g) => g.id),
      pruned: ship.pruned.map((p) => `${p.id}:${p.failStep}`),
      incomplete: ship.incomplete.map((p) => `${p.id}:${p.failStep}`),
    },
    authorErrors: ship.authorErrors,
  };
  if (authoringTokensTotal) {
    const perAuthor = Math.round(authoringTokensTotal / n);
    out.cost = {
      authoringTokensTotal,
      tokensPerSingleShot: perAuthor,   // single-shot arm: 1 author, ships UNVERIFIED (wrong pSingle of the time)
      fanoutNTokens: authoringTokensTotal, // fan-out-N arm: N authors + gate(~0), ships VERIFIED or honest no-green
      costMultiple: n,                  // fan-out-N vs single-shot
    };
  }
  return out;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await scoreItem(process.argv[2], process.argv[3], Number(process.argv[4]) || null);
  console.log(JSON.stringify(r, null, 2));
}
