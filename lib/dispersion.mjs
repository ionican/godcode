// G1 — verifier-behaviour dispersion / effective-N measure for /godcode.
//
// Pure function over a per-probe pass/fail matrix across candidate solutions.
// NO model judgement, NO embeddings, NO lexical distance: diversity is measured
// strictly over WHICH probe inputs each candidate passes/fails (verifier behaviour).
//
// Why effective-N and not nominal N: six branches sampled from the same model on
// the same spec can collapse to ~2 distinct behaviours. "Keep exploring after the
// first correct" is only meaningful if we can tell genuine diversity (effective N)
// from N near-clones. This module quantifies that, and — critically — reports when
// the probe set fails to DISCRIMINATE at all (the coarse-oracle case), so the caller
// never mistakes "all identical" for "converged".

/** Hamming distance between two equal-length boolean signatures. */
export function hammingDistance(a, b) {
  if (a.length !== b.length) throw new Error('signature length mismatch');
  let d = 0;
  for (let i = 0; i < a.length; i++) if (Boolean(a[i]) !== Boolean(b[i])) d++;
  return d;
}

/** Build a boolean signature from a {testName: 'pass'|'fail'} map over ordered probe names. Missing => fail. */
export function signatureFromResults(perTest, probeNames) {
  return probeNames.map((n) => perTest[n] === 'pass');
}

function signatureKey(sig) {
  return sig.map((b) => (b ? '1' : '0')).join('');
}

// Cluster candidates by behavioural signature.
// epsilon === 0: exact grouping by identical signature (deterministic).
// epsilon  >  0: COMPLETE-linkage greedy clustering — a candidate joins a cluster
//               only if it is within Hamming epsilon of EVERY member. This bounds a
//               cluster's diameter at epsilon and removes the single-linkage hazard
//               where a chain of pairwise-near signatures (a~b~c, but d(a,c)>epsilon)
//               transitively collapses into one class and erases real dispersion.
//               Sorted iteration makes the greedy assignment deterministic.
function clusterCandidates(candidates, epsilon) {
  if (epsilon === 0) {
    const byKey = new Map();
    for (const c of candidates) {
      const k = signatureKey(c.signature);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(c);
    }
    return [...byKey.values()];
  }
  const sorted = [...candidates].sort((a, b) => signatureKey(a.signature).localeCompare(signatureKey(b.signature)));
  const clusters = [];
  for (const c of sorted) {
    const target = clusters.find((cl) => cl.every((m) => hammingDistance(m.signature, c.signature) <= epsilon));
    if (target) target.push(c);
    else clusters.push([c]);
  }
  return clusters;
}

/**
 * Measure verifier-behaviour dispersion across green candidates.
 *
 * @param {{id:string, signature: boolean[]}[]} candidates  one per green branch; equal-length signatures.
 * @param {{epsilon?:number, targetK?:number}} [opts]
 * @returns {{
 *   nominalN:number, distinctCount:number, effectiveN:number, dispersion:number,
 *   discriminating:boolean, sufficient:boolean, targetK:number,
 *   classes:{members:string[], signature:boolean[], size:number, key:string}[],
 *   modalClass:{members:string[], signature:boolean[], size:number, key:string}|null
 * }}
 *
 * effectiveN = Hill number of order 1 = exp(Shannon entropy of the class-size
 * distribution). It equals 1 for a monoculture, equals N when all N differ, and
 * sits below distinctCount when classes are skewed (e.g. {5,1} -> ~1.57): the
 * skew-aware "effective number of distinct behaviours".
 *
 * discriminating = at least one probe column varies across candidates (needs N>=2).
 * If false, all signatures are identical and effectiveN is forced to 1 — the caller
 * must treat this as "dispersion unmeasurable", NOT as convergence.
 *
 * sufficient = discriminating && effectiveN >= targetK  (the keep-exploring stop signal).
 */
export function dispersion(candidates, opts = {}) {
  const epsilon = opts.epsilon ?? 0;
  const targetK = opts.targetK ?? 3;
  const nominalN = candidates.length;

  if (nominalN === 0) {
    return {
      nominalN: 0, distinctCount: 0, effectiveN: 0, dispersion: 0,
      discriminating: false, sufficient: false, targetK, classes: [], modalClass: null,
      f1: 0, f2: 0, coverage: 0, chao1: 0, completeness: 1,
    };
  }

  const L = candidates[0].signature.length;
  for (const c of candidates) {
    if (!Array.isArray(c.signature) || c.signature.length !== L) {
      throw new Error(`signature length mismatch for candidate ${c.id}: expected ${L}`);
    }
  }

  // discriminating: does any probe column vary across candidates?
  let discriminating = false;
  if (nominalN >= 2) {
    for (let j = 0; j < L; j++) {
      const first = Boolean(candidates[0].signature[j]);
      if (candidates.some((c) => Boolean(c.signature[j]) !== first)) {
        discriminating = true;
        break;
      }
    }
  }

  const clusters = clusterCandidates(candidates, epsilon);
  const distinctCount = clusters.length;

  // Hill q=1 = exp(Shannon entropy) of the cluster-size distribution.
  let H = 0;
  for (const cl of clusters) {
    const p = cl.length / nominalN;
    if (p > 0) H -= p * Math.log(p);
  }
  const effectiveN = Math.exp(H);

  const normDispersion = nominalN > 1 ? (effectiveN - 1) / (nominalN - 1) : 0;

  const classes = clusters
    .map((cl) => ({
      members: cl.map((c) => c.id),
      signature: cl[0].signature.slice(),
      size: cl.length,
      key: signatureKey(cl[0].signature),
    }))
    .sort((a, b) => b.size - a.size || a.key.localeCompare(b.key));
  const modalClass = classes.length ? classes[0] : null;

  const sufficient = discriminating && effectiveN >= targetK - 1e-9;

  // Good-Turing / Chao biodiversity counters, computed FREE off the class-size distribution.
  // f1 = singleton signatures (seen exactly once), f2 = doubletons. These are the "rare class"
  // counts the keep-exploring stop rule reads: coverage deficit f1/n estimates the probability mass
  // of UNSEEN behaviours (high ⇒ undersampled, keep drawing; low ⇒ seen what exists), and Chao1 is
  // an asymptotic richness LOWER BOUND for a report-only completeness diagnostic. All pure, no params.
  const f1 = classes.reduce((n, c) => n + (c.size === 1 ? 1 : 0), 0);
  const f2 = classes.reduce((n, c) => n + (c.size === 2 ? 1 : 0), 0);
  const coverage = 1 - f1 / nominalN;                                  // Good-Turing sample coverage
  const chao1 = distinctCount + (f2 > 0 ? (f1 * f1) / (2 * f2) : (f1 * (f1 - 1)) / 2);
  const completeness = chao1 > 0 ? distinctCount / chao1 : 1;          // S_obs / Chao1 ∈ (0,1]

  return {
    nominalN, distinctCount, effectiveN, dispersion: normDispersion,
    discriminating, sufficient, targetK, classes, modalClass,
    f1, f2, coverage, chao1, completeness,
  };
}
