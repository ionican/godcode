// stopRule — the keep-exploring stop decision for /godcode, as a PURE, standalone function.
//
// THE HONESTY KEYSTONE: stopDecision takes ONLY a dispersion object + the prior-wave signature-key
// set + a few scalar opts. It is handed NO winner / decision / confidence / greens — so it is
// STRUCTURALLY incapable of re-coupling the correctness floor to the diversity probes. It can only
// emit a `reason` that drives whether the caller draws another wave; it can never change what was
// verified or which candidate ships. (The held-out mutation probes feed this; the gate already
// settled correctness upstream, before this is ever called.)
//
// Stop rule = coverage-deficit + plateau + cap (the research-backed lean rule; SPRT/Bayesian/
// mid-flight pruning deferred — the plateau is early, best-of-N ~88% of the gain by k=3).
//
// Precedence, CAPS FIRST (a hard reviewable-slate/budget cap dominates every signal so the loop can
// never run up un-reviewable cost chasing diversity):
//   review-cap > no-green > floor-only > sufficient-floor > plateau > coverage-saturated > keep-exploring
//
// chao1 / completeness are carried in `metrics` for the dossier ONLY — they appear in NO branch. A
// completeness estimate is an undersampling guess; gating on it could false-stop, so it never gates.

/**
 * Decide whether to keep drawing candidates.
 *
 * @param {object} disp   a dispersion() result (the HELD-OUT mutation-probe dispersion when measurable,
 *                         else the in-suite dispersion as a floor). Reads nominalN, discriminating,
 *                         effectiveN, classes[].key, coverage, f1/f2/chao1/completeness.
 * @param {Set<string>} [prevSigKeys]  union of signature keys seen in ALL prior waves (empty on wave 1).
 * @param {object} [opts]
 * @param {number} [opts.targetK]   sufficiency floor (≥K distinct behaviours). Falls back to disp.targetK.
 * @param {number} [opts.epsilon=0.15]  coverage-deficit threshold: stop when f1/n ≤ epsilon (coverage ≥ 1−epsilon).
 * @param {boolean} [opts.measurable]  is the supplied disp a real held-out measurement? Default false ⇒ 'floor-only'
 *        (the SAFE default — never trust an unmeasured signal to lower the floor).
 * @param {number} [opts.draws]      cumulative reviewable-slate size so far (caller-owned cost; NEVER measured).
 * @param {number} [opts.reviewCap]  hard cap on draws. Both draws & reviewCap present and draws≥reviewCap ⇒ 'review-cap'.
 * @returns {{reason:string, metrics:object}}
 */
export function stopDecision(disp, prevSigKeys = new Set(), opts = {}) {
  const targetK = opts.targetK ?? disp.targetK ?? 3;
  const epsilon = opts.epsilon ?? 0.15;
  // epsilon must be a real coverage-deficit threshold in [0,1): epsilon=1 would make `coverage >= 1-epsilon`
  // (i.e. coverage>=0) ALWAYS true and stop 'coverage-saturated' on MAXIMUM deficit — the opposite of the
  // intent (AR-MED). epsilon=0 is valid (stop only at exact saturation, f1=0).
  if (!(Number.isFinite(epsilon) && epsilon >= 0 && epsilon < 1)) {
    throw new Error(`stopDecision: epsilon must be a finite number in [0,1), got ${epsilon}`);
  }
  const measurable = opts.measurable === true; // safe default: unmeasured ⇒ floor-only, never trusted to gate

  const classes = Array.isArray(disp.classes) ? disp.classes : [];
  const curKeys = classes.map((c) => c.key);
  // metrics ALWAYS carries the full counter set for the dossier; chao1/completeness are report-only.
  const metrics = {
    f1: disp.f1, f2: disp.f2, effectiveN: disp.effectiveN,
    coverage: disp.coverage, chao1: disp.chao1, completeness: disp.completeness,
    classKeys: curKeys, measurable,
  };

  let reason;
  if (opts.draws != null && opts.reviewCap != null && opts.draws >= opts.reviewCap) {
    reason = 'review-cap';                                   // HARD cap — dominates every signal
  } else if (disp.nominalN === 0) {
    reason = 'no-green';                                     // nothing correct yet; author harder
  } else if (!measurable || !disp.discriminating) {
    reason = 'floor-only';                                   // unmeasured/non-discriminating ⇒ defer to in-suite floor
  } else if (disp.effectiveN >= targetK - 1e-9) {
    reason = 'sufficient-floor';                             // ≥K behaviourally-distinct greens (the sufficiency floor)
  } else {
    const newSigs = curKeys.reduce((n, k) => n + (prevSigKeys.has(k) ? 0 : 1), 0);
    if (prevSigKeys.size > 0 && newSigs === 0) {
      reason = 'plateau-no-new-signature';                  // this wave discovered nothing new
    } else if (disp.coverage >= 1 - epsilon) {
      reason = 'coverage-saturated';                        // Good-Turing deficit f1/n ≤ epsilon — seen what exists
    } else {
      reason = 'keep-exploring';                            // still discovering, below floor, under cap
    }
  }
  return { reason, metrics };
}
