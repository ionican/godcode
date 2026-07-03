# /godcode primitives

Zero-dependency Node (ESM) library. The core building blocks of `/godcode` — `gateRunner` → `dispersion` → `fanoutSelect` → `authorLoop` → `runWaves`, with `triage` as the gate→fan-out escalation policy that decides *when paying N× is worth it* — composing into a harness that's runnable end-to-end on a benchmark item. See [[godcode — v1-lite Build Spec]] and [[godcode — God-Mode Coding Harness]].

Run the tests:

```
cd .claude/lib/godcode && node --test    # 370 tests (the timing-sensitive HANG test can flake under heavy parallel load; green in isolation)
```

Run the harness end-to-end on a benchmark item:

```
node benchmark/run.mjs felt-false-green-completion-gate --replay   # deterministic (no model)
node benchmark/run.mjs <item> --patches <dir>                      # gate real author-written patches
```

Run it on a LIVE repo via the **`/godcode` skill** (`.claude/skills/godcode/SKILL.md`) — it fans out oracle-blind authors and drives `harness.mjs` over the cohort:

```
/godcode <bug/task description or spec-path> [--repo <dir>] [--verify "<cmd>"] [--gate-only] [--n <wave>] [--max <draws>]
```

Node 24+. No `npm install` — uses only `node:*` built-ins and `node:test`.

## `gate.mjs` — v0 `--gate-only` (the shippable entrypoint)

The thin honest CLI over `gateRunner` that **is** v0 — the universal value the ablation proved (the gate caught every wrong fix and never false-greened across 114 author-draws). Given a candidate change (a git worktree whose diff vs `<base>` is the candidate) and the repo's **own existing** suite, it gates the candidate out-of-band and emits one of four honest verdicts — never VERIFIED unless the real acceptance suite actually passed:

```
node gate.mjs --repo <dir> [--base <ref>] [--candidate <dir>] --verify "<cmd>" [--acceptance <regex>] [--run-subdir <dir>] [--provision node_modules]
```

| verdict | exit | meaning |
|---|---|---|
| `✓ VERIFIED` | 0 | the acceptance suite passed out-of-band — ship |
| `✗ NO-GREEN` | 1 | the candidate FAILED the gate — did not certify (lists failing tests) |
| `? INCONCLUSIVE` | 2 | flaky / hung / no acceptance evidence — an honest decline, **not** a pass |
| `⊘ REJECTED` | 3 | the candidate touched a protected/oracle path or escaped the worktree — a candidate cannot grade itself |

v0 is `--gate-only` because the suite already exists in the repo (no SWE-bench oracle materialization — that's the benchmark/v1 path). The fan-out author wave (`authorLoop`/`runWaves`) is v1 and pays only in the **narrow, non-expandable informative regime** the ablation mapped (see `benchmark/README.md`); the gate is the value that pays everywhere. Smoke-tested in `gate.test.mjs` (VERIFIED / NO-GREEN / REJECTED on a real temp repo).

## `harness.mjs` — the LIVE select driver (what the `/godcode` skill drives)

`select(opts) -> ShipContract`. The deterministic core behind the **`/godcode` skill** (`.claude/skills/godcode/SKILL.md`). The skill owns the expensive half — spawning oracle-blind model authors into candidate worktrees; `harness.mjs` owns the free half (gating is OS processes, no tokens) and the decision:

1. gate every candidate worktree under `--candidates <root>` via the same `gateRunner` v0 uses (immutability guard, flaky-retry, hang-as-retryable, no-false-green floor) — each candidate's diff-vs-`base` IS its change;
2. replay the real per-candidate verdicts through `triage` to get the escalation decision (`gate-only` / `fanned-out` / `fanned-out-partial` / `declined`) + the regime estimate;
3. emit the ship contract — the GREEN to ship, or on a decline the **best failing** candidate (closest to green) tagged for a human gate, plus **`keepExploring`** telling the skill whether MORE authoring could still convert (budget not spent, regime not yet `too-hard`).

```
node harness.mjs --repo <dir> [--base <ref>] --candidates <root> --verify "<cmd>" \
  [--target-greens K=1] [--global-max M=8] [--acceptance <re>] [--protected a,b] [--provision node_modules] [--run-subdir d] [--json]
# exit: 0 shipped · 1 declined (no more help) · 2 keepExploring (author more)
```

The skill loop: probe with one author (the `gate-only` cost-saver), and while the contract says `keepExploring`, fan out a wave and re-run — re-gating the accumulated cohort is free. Smoke-tested in `harness.test.mjs` (mixed cohort → fanned-out ships the green + surfaces the best failing; all-wrong-under-budget → `keepExploring`).

## `gate-runner.mjs` — the out-of-band correctness gate (G5)

`gateRunner(opts) -> GateResult`. Runs a project's real verify steps as deterministic OS processes over a candidate patch in an **isolated git worktree**, and emits **per-test** results.

Enforces (mechanically, never asked of a model):
- **Immutability guard** — a candidate diff touching a protected path (tests / CI / lockfiles) is rejected outright (`failStep: 'immutability-violation'`). A candidate cannot grade itself by weakening the oracle or adding a dependency.
- **Flaky-retry** — each step runs `attempts` times; FAIL only on deterministic failure across all runs. A step that flips is **quarantined** → `incomplete` (`failStep: '<step>:flaky'`), never scored.
- **Hang-as-retryable** — a stalled/timed-out step is killed (process-group SIGKILL) and treated as a distinct retryable class; all-attempts-hung → `incomplete` (`failStep: 'hang'`).
- **Worktree isolation** — every candidate runs in its own `git worktree`, removed afterward.
- Scrubs `NODE_TEST_CONTEXT` from child env so a nested `node --test` verify command runs standalone.

**Real-repo capabilities** (validated end-to-end on live Felt suites via the benchmark pilot):
- **`provision: string[]`** — symlink gitignored dep dirs (`node_modules`) a fresh worktree lacks; the symlink *location* is forced inside the sandbox.
- **`runSubdir: string`** — run verify from a package subdir (monorepos).
- **`oracleFiles: Record<string,string>`** — harness-materialised verifier (the SWE-bench "test patch") written into the worktree, **exempt from the immutability guard** (the harness installs the oracle; only the candidate can't touch it).
- **No-false-green floor** — a run that produces zero acceptance evidence (suite failed to load) is `incomplete` (`failStep: '<step>:no-acceptance'`), never a vacuous green.
- **Indentation-aware TAP** — `describe`/subtests parse as leaves under a top-level aggregator (per-test detail keyed by ancestry); `\#`-escaped titles are literals, not directives.
- Protected-path matching is **POSIX-canonicalized** (`test/./x` can't dodge it) and candidate ids are slugged for worktree/evidence filenames (no path traversal).

**Test runners — TAP + TRX (so `/godcode` can gate .NET, not just Node).** A `type:'test'` step carries a `reporter` (`'tap'` default | `'trx'`):
- **TAP** (node:test, **vitest with `--reporter=tap-flat`**) — parsed from stdout. *Gotcha: vitest's plain `tap` reporter is nested parent-before-children (the inverse of node:test) and mis-parses — use `tap-flat` (flat `1..N`, ` > `-joined names).*
- **TRX** (`dotnet test --logger trx`) — `dotnet` writes a TRX **file**, not stdout. Declare `reporter:'trx'` and put the `{{RESULTS_DIR}}` token (exported as `RESULTS_DIR_TOKEN`) in the cmd: `['dotnet','test','--results-directory','{{RESULTS_DIR}}','--logger','trx','--nologo']`. The gate substitutes a **fresh per-attempt** results dir, runs, and parses the `.trx` into the same `{perTest,count,…}` shape (`parseTrxDetailed`/`trxComplete`/`parseTrx`). The **no-false-green floor for TRX** is the file's own `<Counters total>` matching the `<UnitTestResult>` count (the analogue of TAP plan==count): a build break writes **no** `.trx` → `incomplete`; a crashed/partial run has total≠count → `incomplete`; a duplicate name → `incomplete`; `NotExecuted`/`Inconclusive` outcomes map to `skip` (never a pass). **Cross-model-AR-hardened (1 CRIT + 1 HIGH folded test-first):** the run-level `<ResultSummary outcome>` must be a *known clean-terminal* state (`Completed`/`Failed`, allowlist) **consistent** with the rows/counters — a self-contradictory `.trx` (`Failed` with all-pass rows, or `Completed` with a failing row/counter, or no outcome) is `incomplete`; and a **multi-file** results dir requires **every** `.trx` to be individually complete before merging (summing counts across files could otherwise let two incomplete files mask each other into a false green). Validated end-to-end against a real xunit project (GREEN / pruned / build-break→incomplete / immutability). Ecosystem immutability defaults: `DEFAULT_PROTECTED_DOTNET`, `DEFAULT_PROTECTED_VITEST` (prefix-matched; add your test-project path).

```js
const r = await gateRunner({
  repoDir,                                   // base git repo
  candidate: { id, files: { 'src/x.mjs': '<content>' } },
  verify: [                                  // ordered, cheap-fail-fast
    { name: 'build', cmd: ['node', '--check', 'src/x.mjs'], type: 'check' },
    { name: 'test',  cmd: ['node', '--test', '--test-reporter=tap', 'test/x.test.mjs'], type: 'test' },
  ],
  acceptanceFilter: (name) => name.startsWith('acc'),   // which tests must pass for GREEN
  protectedPaths: ['test', 'package-lock.json', '.github'],
  attempts: 3, perStepTimeoutMs: 10000,
});
// GateResult: { candidateId, gate: 'green'|'pruned'|'incomplete', failStep,
//   steps:[{name,type,verdict,attempts}], perTest:{name:'pass'|'fail'}, acceptancePass, evidencePath }
```

`green` requires the acceptance-filtered tests to pass; the full per-test vector (acceptance + probes) is emitted for G1. Full logs/evidence are written to disk (`evidencePath`); the returned object stays compact (the G8 compact-return convention).

## `dispersion.mjs` — verifier-behaviour dispersion / effective-N (G1)

`dispersion(candidates, opts) -> measure`. Pure function over a per-probe pass/fail matrix. **No model judgement, no embeddings, no lexical distance** — diversity is measured strictly over which probe inputs each candidate passes/fails.

```js
const greens = gated
  .filter(g => g.gate === 'green')
  .map(g => ({ id: g.candidateId, signature: signatureFromResults(g.perTest, PROBE_NAMES) }));
const d = dispersion(greens, { targetK: 3, epsilon: 0 });
// { nominalN, distinctCount, effectiveN, dispersion: 0..1,
//   discriminating, sufficient, classes, modalClass }
```

- **`effectiveN`** = Hill number of order 1 = `exp(Shannon entropy)` of the class-size distribution. 1 for a monoculture, N when all differ, and **below `distinctCount` when skewed** (e.g. five clones + one outlier → ~1.57): the skew-aware "effective number of distinct behaviours". This is what quantifies *"6 branches, effectively ~2"* — the gap no watchlist peer measured.
- **`discriminating`** — does any probe column vary across candidates (needs N≥2)? If `false`, all signatures are identical: the caller must treat that as **dispersion unmeasurable**, never as convergence.
- **`sufficient`** = `discriminating && effectiveN >= targetK` — the keep-exploring stop signal (anti-dive). A monoculture is never sufficient, even at `targetK: 1`.
- **`modalClass`** — the largest behavioural class (feeds first-green-forbid).
- **`epsilon`** — Hamming tolerance for merging near-identical signatures (single-linkage), to absorb a flaky probe. Default `0` (exact).

## `fanout-select.mjs` — the v1-lite control loop

`fanoutSelect(opts) -> ShipContract`. Gates every candidate out-of-band (bounded concurrency, isolated worktrees), then selects among the GREEN survivors using only the external suite + G1 dispersion:

- rank greens by external-suite coverage (probe-pass-count proxy; true branch coverage via c8 is a follow-on), tie-break by smaller change (Occam);
- the simplest-correct **baseline always ships** unless a winner strictly beats it on the measured axis (`decision: 'ship-baseline'` labelled "search found no improvement" otherwise);
- **dispersion decides confidence**: greens that disagree on probe behaviour ⇒ the acceptance suite under-specifies ⇒ `confidence: 'human-gate'`, never a confident silent pick; greens that converge ⇒ `'external-suite-verified'`;
- `keepExploring = !dispersion.sufficient` surfaces the anti-dive signal to the upstream author loop.

The candidate set is an **input** (authoring agents are upstream); this is the deterministic gate+select core, testable with no model call.

**The keep-exploring stop rule (`stopRule.mjs` + `runner.mjs`).** `runWaves` drives author waves until an earned stop, now driven by the HELD-OUT mutation-probe dispersion (`author-loop.mjs` selects `ship.mutationDispersion` when measurable, else the in-suite signal is only a FLOOR). The pure `stopDecision(disp, prevSigKeys, opts)` — handed ONLY a dispersion object + the prior-wave signature keys, never the winner/decision/greens, so it structurally cannot re-couple the floor to the diversity probes — applies a **coverage-deficit + plateau + cap** rule, caps-first: `review-cap` (hard reviewable-slate bound) → `no-green` → `floor-only` (unmeasurable/non-discriminating ⇒ defer to in-suite) → `sufficient-floor` (≥K distinct) → `plateau-no-new-signature` (a wave added zero new behavioural signature) → `coverage-saturated` (Good-Turing `f1/n ≤ ε`) → `keep-exploring`. `dispersion.mjs` carries `f1/f2/coverage/chao1/completeness` for this (chao1/completeness are **report-only — they gate nothing**). `runWaves` enforces the cap in-lib (truncates over-budget fresh authors baseline-first; replays only prior GREENS so a non-green can't resurrect past the cap; rejects cross-wave id reuse; pins the baseline so a FAILED baseline keeps producing `baseline-not-green`). **Sideways-look seed-diversity:** an opt-in `seedSpecs` (wave-1-only, opaque to the lib) lets the skill inject a deliberately-different "sideways-look" author — the proactive complement to the reactive `forbidApproachTags` — gated identically, oracle-blindness preserved at the lib boundary. AR-hardened (1 NO-SHIP + 4 confirmatory passes → SHIP).

**OPT-IN held-out mutation probes (`opts.mutationProbes` + `opts.runProbes`).** The code-path analogue of the prose `discriminatingProbes` (piece D): held-out inputs run over the GREEN survivors MEASUREMENT-ONLY, attaching a separate `mutationDispersion` label (`unmeasurable`/`converged`/`diverse`) without touching ANY acceptance-derived field. Two fixes can both pass the gate yet diverge on inputs the suite never pinned (dedupe-stable vs dedupe-sorted both pass `[1,1,2]→[1,2]` but differ on `[3,1,3,1]`); the probes surface that as measurable dispersion. **HARD INVARIANT (tested):** a probe NEVER enters the gate, NEVER prunes a green, NEVER changes the winner/decision/confidence — a held-out input was never a requirement, so a green that "fails" one is still verified. Step 5 runs strictly after the decision is finalized; with neither opt supplied, `mutationDispersion` is `null` (byte-for-byte backward-compatible). See `mutation-probes.mjs`.

## `author-loop.mjs` — the v1-lite author wave (upstream of fanout-select)

`authorLoop(opts) -> AuthorLoopResult`. The thin upstream stage that turns a task into a candidate cohort: fan N **injected** author functions out over one oracle-blind context, then hand the cohort to `fanoutSelect` unchanged. It adds no gating/ranking/scoring — its only jobs are the three the gate+select core can't do for itself:

- **Anti-dive (layer 1, structural)** — always run **all N unique-id authors**; a green appearing early can never short-circuit the cohort (`fanoutSelect` only ever sees the full set). The multi-wave keep-exploring loop (layer 2) is the *caller's*, driven by the surfaced `exploreSignal`.
- **Oracle-blindness (boundary guarantee)** — authors get a fixed allowlist ctx `{repoDir, baseRef, task, authorId, forbidApproachOf}`; the verifier routes **only** into the gate path. Full blindness additionally needs the caller's preconditions: authors as *separate agents* (in-process fns can close over scope), SWE-bench shape (verifier absent at `baseRef`), and no verifier in `task`.
- **False-green backstop** — forwards `gate.protectedPaths = caller's ∪ keys(oracleFiles)`, so a candidate that writes a verifier path is pruned (`immutability-violation`) instead of replacing the oracle to self-certify GREEN.

```js
const r = await authorLoop({
  repoDir, baseRef: 'HEAD',
  task: { id, spec },                          // ORACLE-BLIND — never embed the verifier here
  authors: [{ id, fn: async (ctx) => ({ files, approachTag }), isBaseline: true }, ...],
  oracleFiles: { 'test/x.test.mjs': '<verifier>' },   // routed ONLY into the gate
  probeNames, gate: { verify, acceptanceFilter, provision, runSubdir, ... }, targetK: 3,
});
// AuthorLoopResult = { ...ShipContract, authored, authorErrors, baselineId, nAuthors, nAuthored,
//   exploreSignal: { keepExploring, nonDiscriminating, forbidApproachTags, reason } }
```

Designed by running `/godcode`'s own mechanism on it (a design panel of 4 framings → adversarial critique → synthesis); the synthesis chose single-pass minimal-injection because the multi-round/tiered framings all hinge on `dispersion.sufficient`, which is structurally unmeasurable on an acceptance-only suite. Author output is snapshot+validated (non-string contents → `authorErrors` reason `invalid-files`, never a cohort crash).

## `runner.mjs` — the multi-wave keep-exploring loop (the caller)

`runWaves(opts) -> { ...ShipContract, waves, nWaves, stoppedBecause }`. The loop above `authorLoop` — what the design deferred to the "caller". Made deterministic by **injecting the author factory** (`authorFactory({wave, forbidApproachTags, realizedIds}) -> authors[]`): the loop logic is unit-tested with fakes, while the real Opus-author fan-out is the injected seam (the Workflow/Skill layer supplies it).

Each wave re-gates the **accumulated** cohort (prior survivors replayed as fixed authors + this wave's fresh authors), threads `exploreSignal.forbidApproachTags` into the next wave, and decides:

- `sufficient-dispersion` → **stop** (earned: ≥K behaviourally-distinct greens);
- `non-discriminating-probes` → **stop** (the probes can't measure diversity — the honest outcome on an acceptance-only suite; more waves can't help);
- `keep-exploring` / `no-green` → **continue** while budget (`maxWaves` + an optional injected `shouldContinue`).

This realizes anti-dive layer 2 (keep-exploring); layer 1 (always-run-all-N) is guaranteed by `authorLoop` beneath. `benchmark/run.mjs` wires it to a real benchmark item (`materialize.mjs` builds the gate config), with `--replay` (deterministic fix/revert authors) or `--patches <dir>` (gate real author-written candidates). Proven end-to-end on a live Felt item.

## `triage.mjs` — the gate→fan-out escalation policy (v1: *when is paying N× worth it?*)

`triage(opts) -> TriageResult`. The control loop that answers the v1 question the benchmark posed: **when to escalate from a single gated draw (v0) to a fan-out, and when to decline.** The benchmark proved you *cannot* read a bug's reliability regime off its spec (regime is a property of the bug, not the prose — only 2/9 items were informative), so triage **samples** it: a sequential draw-and-gate loop that infers `pSingle` on the fly (Wilson interval over decisive draws) and spends the expensive N× **only where it converts**.

| outcome | decision | cost | regime |
|---|---|---|---|
| first draw greens | `gate-only` | 1× | too-easy — N× **not** paid (degenerates to v0) |
| greens after retries | `fanned-out` | n× | informative — N× **paid and converted** (a coin-flip author → a verified-correct ship) |
| confident `pSingle≈0` | `declined` | early-stop | too-hard — N× **not** thrown good-after-bad; **never false-greens** |

- **Cost-optimal with a gate in the loop.** A failed draw is *known*-wrong (the gate pruned it), so sequential-draw-until-green is expected-`1/p` draws and ~100% verified for any `p>0` — strictly beating single-shot (ships wrong at rate `1-p`, no gate) *and* fixed fan-out-N (always spends N). triage adds the two early-stops fixed-N can't: stop at the first green (easy end), and decline early when the posterior says `p≈0` (hard end).
- **The Wilson band defaults (0.2 / 0.8) ARE the informative-band edges the ablation measured.** Calling `too-hard` needs ~16 consecutive fails at the default threshold — this deliberately **encodes the benchmark lesson** that the fleet's "0/6 ⇒ too-hard" was wrong (a verifier-coupling artifact): a cheap too-hard verdict is exactly how that artifact fooled the fleet. Raise `hardThreshold` for a cheaper, less-confident decline.
- **`incomplete` draws are evidence-free** — a flaky/hang/no-acceptance gate result is *no evidence*, not evidence-of-wrong, so it never lowers `pSingle` and a string of them can never trigger a false `too-hard` (it declines as `budget`, honestly).
- **No false-green, inherited** — `shipped` is non-null **iff** a gate returned `green`; a decline never ships.
- Same injected-seam shape as `runner.mjs`: the model is `drawAndGate` (real = an Opus author writes into a fresh worktree, then `gateRunner` gates it; a fake scripted sequence in tests). **Diversity/dispersion confidence is a separate axis** — that's `runWaves` (parallel waves to K behaviourally-distinct greens); triage is the **correctness+cost** front-end. Set `targetGreens>1` to collect a cohort for `fanoutSelect` instead of stopping at the first green (`escalateForDispersion` hints the handoff).

```js
const r = await triage({
  drawAndGate: async (drawId, ctx) => gateOneAuthoredCandidate(drawId, ctx),  // injected model+gate seam
  maxDraws: 16,            // hard ceiling (incl. incompletes); default = the draws to confidently call too-hard
  targetGreens: 1,         // >1 to gather a cohort for the dispersion/diversity pick
});
// TriageResult: { decision:'gate-only'|'fanned-out'|'declined', shipped, greens, regime,
//   p:{point,lo,hi,greens,draws}, draws, costX, incompletes, stoppedBecause, escalateForDispersion, history }
```

`wilsonInterval` and `classifyRegime` are exported as pure, separately-tested helpers (boundary-correct at g=0 and g=n; a regime is only *named* when the interval is confidently in its band, else `uncertain`).

## Hardening (Codex adversarial review, 2026-06-26)

Four findings folded test-first (`hardening.test.mjs`):
- **path-escape (critical)** — candidate files are resolved strictly inside the worktree; `../`, absolute paths, and symlinked-ancestor escapes are rejected (`failStep: 'path-escape'`).
- **TAP strictness (high)** — a run counts as `complete` only if its TAP is internally consistent (plan matches count, no `Bail out!`, no duplicate names); a crashed suite that printed some `ok` lines is no longer scored green.
- **hang containment (high)** — on timeout the gate kills the process group and waits (bounded) for the child to close so a detached grandchild can't wedge it. **Limitation:** a grandchild that re-parents into its own process group can survive; hard containment needs an OS sandbox (container/cgroup) — a deployment concern for untrusted candidate authors.
- **epsilon clustering (medium)** — `dispersion` uses complete-linkage (diameter-bounded), so a chain of pairwise-near signatures no longer transitively collapses real dispersion.

### Second round (2026-06-27) — surfaced by the author-loop review

- **path-canonicalized immutability (critical)** — `matchProtected` stripped only a *leading* `./`, so `test/./suite.test.mjs` dodged a protected FILE path and let a candidate overwrite the materialized oracle → false GREEN. Paths are now POSIX-normalized before matching.
- **cohort-crash isolation (high)** — a non-string candidate file value made `writeFile` throw uncaught and reject the whole `fanoutSelect` pool; `authorLoop` now snapshots+validates author output (`invalid-files`), so one bad author is isolated, not fatal.
- **hostile-id traversal (medium)** — a candidate id like `../../pwn` became path components in worktree/evidence paths; ids are now slugged for filenames (the real id stays in `candidateId`).
- Claim-scoping: oracle-blindness is documented as a **boundary** guarantee (the lib passes no verifier) with explicit caller preconditions, not an absolute.

### triage (2026-06-27) — promotion to OTBHarness, 6 fold rounds

`triage.mjs` was promoted to OTBHarness ([PR #3](https://github.com/ionican/OTBHarness/pull/3)) behind 7 Codex AR passes → **approve**; 9 findings folded test-first, all on the trust boundary:
- **evidence-free verdicts (high)** — a malformed/unknown/**missing**/**rejected** `drawAndGate` result was counted as a decisive prune (or, with a missing `candidateId`, shipped as a phantom green). Now only an exact `pruned` is decisive; everything else is evidence-free, so a degraded gate can never read as `too-hard` or ship an unresolvable candidate.
- **honest cohort (medium)** — `targetGreens>1` is counted over **distinct** green ids and labelled honestly: `fanned-out-partial` + `targetGreensMet:false` when the run stops (budget/too-hard, incl. `maxDraws=1`) before the cohort, instead of a misleading `fanned-out`/`gate-only`.
- **`onDraw` isolation (high)** — the observability hook is fire-and-forget: a sync throw, async rejection, never-settling hang, or state mutation can't abort, corrupt, or wedge the policy. (The fix converged over rounds 4–6: sync-catch → +async-catch → drop the await; the classic fold-regression chain.)

Dogfooded on real Opus authors before promotion: too-easy → `gate-only` (1 draw); informative (`claim-ledger`, 1/6 real green) → `fanned-out`, drawing through 5 real prunes to the gate-verified green.

## Scope

In: the gate-runner + G1 + the v1-lite fan-out→select loop + the author wave + the `triage` gate→fan-out escalation policy, with the gate-runner validated end-to-end on live Felt suites (`benchmark/`). Out (deferred per the spec): the caller's multi-wave keep-exploring loop (real Opus-author fan-out), model-authored oracles (v2), the Q-panel/deepen (v3).

## Files

- `gate.mjs` / `gate.test.mjs` — **v0 `--gate-only` CLI** over the gate primitive (3 smoke tests)
- `gate-runner.mjs` / `gate-runner.test.mjs` — gate primitive (7 tests)
- `dispersion.mjs` / `dispersion.test.mjs` — G1 measure (effective-N / Hill q1) + free Good-Turing/Chao counters (`f1`/`f2`/`coverage`/`chao1`/`completeness`) off the class-size distribution, for the keep-exploring stop rule (19 tests)
- `stopRule.mjs` / `stopRule.test.mjs` — the **pure keep-exploring stop decision** (`stopDecision`): coverage-deficit + plateau + cap, caps-first; takes only a dispersion object + prior-wave signature keys (no decision handle), so it structurally cannot re-couple the floor to the diversity probes; chao1/completeness are report-only and gate nothing; epsilon validated to [0,1) (12 tests)
- `fanout-select.mjs` / `fanout-select.test.mjs` — v1-lite control loop, incl. the opt-in held-out mutation-probe wire (12 tests)
- `mutation-probes.mjs` / `mutation-probes.test.mjs` — **held-out, MEASUREMENT-ONLY discriminating probes for the CODE path** (the (D) analogue for Path A). `generateMutationProbes` (deterministic type-directed input mutation — boundary/off-by-one/sign-flip/null-a-field/reorder/duplicate — pure, deduped, no RNG), `runMutationProbes` (runs the probes over the GREEN survivors via an injected runner, validates disjointness from the acceptance/gate ids, returns ONLY a `unmeasurable`/`converged`/`diverse` dispersion label — no rank/winner/pick, so it cannot feed the floor), `validateMutationRows` (rejects a malformed/duplicate/inherited-prototype runner output → throws, never a fake signature). Cross-model-Codex-AR-hardened (1 initial NO-SHIP: 2 MED + 2 LOW — non-array-probes-as-absent, prototype-pollution fake verdict (in BOTH this and the prose validator), nameless-gate-step disjointness gap, BigInt stableKey crash — all folded test-first; confirmatory pass SHIP, all CLOSED). 27 tests.
- `author-loop.mjs` / `author-loop.test.mjs` — the author wave above fanout-select; also selects the held-out-probe stop signal + pins the baseline across waves (18 tests)
- `runner.mjs` / `runner.test.mjs` — **the multi-wave keep-exploring loop** (`runWaves`): draw → gate → measure dispersion → `stopDecision` → stop or draw again. Threads the prior-wave signature keys (plateau), the reviewCap draw-budget (validated + lib-enforced via baseline-first truncation + greens-only replay + cross-wave id-uniqueness + a defensive slate guard), and the wave-1 `seedSpecs` sideways-look seed. Cross-model-AR-hardened (1 NO-SHIP + 4 confirmatory passes; the cost-guard/cohort tail — overflow → greens-only replay → pinned baseline → id reuse — all folded test-first; the measurement-only invariant held from pass 1). 15 tests
- `triage.mjs` / `triage.test.mjs` — **the gate→fan-out escalation policy** (sequential sample-and-allocate; 22 tests, Codex-AR-hardened + dogfooded on real Opus authors)
- `harness.mjs` / `harness.test.mjs` — **the LIVE select driver** the `/godcode` skill drives (gate a cohort → ship contract; 8 tests, Codex-AR-hardened, dogfooded on real Felt; promoted to OTBHarness [PR #4](https://github.com/ionican/OTBHarness/pull/4)). The skill itself: `.claude/skills/godcode/SKILL.md`
- `dossier.mjs` / `dossier.test.mjs` — **the live HTML "source of truth" page** for ANY run (gold-dust widening M1; 16 tests, cross-model-AR-hardened). `new RunDossier({dir, request, objective})` anchors the verbatim request, tracks milestones, records discoveries/candidate-verdicts/outcome, and persists atomically as `run.json` + a self-contained `index.html` (monotonic `rev` per write). Also first-class: the **Clarifications** (the one upfront round) and **Decisions** ledger (`decide()` — the autonomous board+adjudicator audit trail). Served **HTTPS** by fronting the vault deck-server with `tailscale serve` → a run at `_godcode/runs/<id>/` is live at `https://codepandas-mac-studio.tailf809db.ts.net:8766/_godcode/runs/<id>/` (valid cert, tailnet-only); the page embeds state for first paint AND polls `run.json`, so a browser refresh shows live progress. Domain-general (no language/test-runner assumption). **Typed confidence contract** (Codex AR): `repo-verified › constructed-floor-pass › factual-evidence-pass › proxy-ranked › advisory-slate` — a candidate is `admitted` only on an executed verifier, and its verdict renders from a **gate-evidence artifact** (cmd/commit/exit/digest/verifier); `admitted` without one is flagged. Colour-blind: status by glyph+label, colour secondary.
- `provision.test.mjs` — real-repo capabilities: provision / runSubdir / oracleFiles / no-false-green (10 tests)
- `integration.test.mjs` — gate → G1 end-to-end (2 tests)
- `hardening.test.mjs` — adversarial-review regressions, both rounds (10 tests)
- `certify.mjs` / `certify.test.mjs` — **the verifier-certification wrapper** (gold-dust M2; the load-bearing honesty piece). Decides whether a CONSTRUCTED verifier earns its `tierCeiling` or is demoted to `advisory-slate`, via one shared positive-evidence predicate (gate===pruned + faithfully-applied candidate + stable complete TAP map + an EXPECTED check actually failing), over a red baseline + a per-requirement anti-candidate kill. Tier is RE-DERIVED here, never from a self-claim. Cross-model-Codex-AR-hardened (2 CRIT + 3 HIGH false-green paths folded test-first: incomplete-as-red, verifier-tampering, attempts:1-flake, antiCandidateId-ignored, deletion/rename). 16 tests.
- `prose-verifier.mjs` / `prose-verifier.test.mjs` — the **prose-QA adapter** (gold-dust M2 first slice): `emitProseVerifier(claims)` returns a standalone `claims.mjs` that checks an answer against a decorrelated source with MECHANICAL checks only (must-include / must-exclude / grounded / number-matches / near / not-near) and emits TAP; `proseExample()` is the fixed worked example. The per-claim predicate is the exported **`evaluateClaim(claim, answer, source)`** (+ batch `evaluateClaims`) — the SINGLE SOURCE OF TRUTH: `emitProseVerifier` serializes the SAME function into the oracle via `Function.prototype.toString`, so the in-process predicate the bleed-lint runs is byte-identical to what runs in the gate (guarded by an agreement regression test). Claim ids are validated (non-empty + TAP-safe charset) in both `validateClaims` and `emitProseVerifier` so an emitted TAP name can never truncate/diverge from a certificate checkId. No model judgment at runtime. 16 tests.
- `dossier-cli.mjs` / `dossier-cli.test.mjs` — the **turnkey status-page CLI** so `/godcode` AUTO-creates + drives the live HTML page on every invocation with one-line fire-and-forget commands (no hand-written scripts): `init` (anchor request + milestones, prints the HTTPS URL) · `start`/`done` (milestones) · `discovery` · `clarify` · `decide` · `candidate`/`candidate-update` · `finish` · `url`. Each is its own process: load `run.json` → one mutation → atomic re-render. `init` is idempotent via `RunDossier.open` (load-or-create) so it can spin the page up at run start and `orchestrateProse` continues the SAME page. 5 tests.
- `m2-prose-slice.mjs` / `m2-prose-slice.test.mjs` — the **end-to-end M2 proof**: construct → red baseline → certify → gate the correct answer green → `factual-evidence-pass`. The gate→certify→ship chain for prose, exactly as for code, no false-greens. 1 test.
- `construct-prose-verifier.mjs` / `construct-prose-verifier.test.mjs` — the **generative constructor** that makes prose-QA general (any task, not the fixed example). `constructProseVerifier({task, source, requirements, claimFn, adversaryFn, claimAuthor, adversary})` — the verifier is authored by `claimFn` (the VERIFIER author) and attacked by a SEPARATE decorrelated `adversaryFn` (BLIND to the claims); certify requires `claimAuthor`/`adversary`/`answerAuthor` to be three pairwise-distinct generative steps or it demotes (closes the **circularity** — one step can't author both a verifier and the proof it works). Requirements are deep-frozen (no mutation bypass); claims are schema-validated + source-grounded. Cross-model-AR-hardened (2 CRIT + 3 HIGH folded test-first). 8 tests.
- `slate.mjs` / `slate.test.mjs` — the **ranked-slate** builder (gold-dust G4). `rankByProxies` (Tier-B objective proxies; returns each row's dense display `proxyRank` AND the underlying `meanRank` aggregate — EQUAL meanRank ⇔ objectively equivalent, so the single-best picker tests meanRank, not the never-tying proxyRank, for a unique winner), `advisoryRank` (Tier-C decorrelated pairwise judge → Bradley-Terry), `buildSlate` (combine; HARD invariant — **no `winner`/`best` field**, only an ordered slate + `rankingIsAdvisory:true` + `selectBy:'human'`; each candidate carries its OWN earned VERIFIED tier or is refused). Also exports the structural validators `validateCandidateIds` / `validateProxyDecls` (single source of truth — the single-best picker runs the SAME id-uniqueness + proxy-shape checks before any degrade, so a duplicate id / malformed proxy can't be laundered into a tie-break). Cross-model-AR-hardened. 37 tests.
- `html-verifier.mjs` / `html-verifier.test.mjs` — the **HTML/interactive acceptance oracle** (gold-dust G1 — the second domain adapter, same emit-TAP shim as prose). Emits a standalone `html-verify.mjs` that drives a REAL headless browser (the `agent-browser` CLI) to MEASURE a candidate page — DOM structure, text, attributes, and POST-INTERACTION behaviour (`after` = click/press/type/wait then assert, reload-isolated) — and asserts each baked-in check deterministically → TAP. `decideCheck` is the SINGLE source of truth, embedded into the standalone via `.toString()` (no drift). FAIL-CLOSED + cross-model-AR-hardened over TWO rounds (round 1: 1 CRIT + 2 HIGH; round 2: 2 CRIT + 1 HIGH + 2 MED + 1 LOW — all folded test-first). Each probe ATOMICALLY captures the native DOM primitives from their PROTOTYPES (`Document.prototype.querySelector`/`querySelectorAll`, `Element.prototype.getAttribute`, the `Node.prototype` textContent getter), verifies each is `[native code]`, and measures via `.call()` — defeating instance- AND prototype-shadow spoofs in one eval (no re-tamper window). `--json` success on open/reload/every action + a fresh per-run session kill stale/failed greens; `dom-count` requires a non-negative integer; `parseJsonEval` requires exactly one envelope; `prop-true` is a `trusted:true`-gated escape hatch. Proven live on a real browser: correct greens, red baseline + each anti-candidate red, and two distinct spoof pages (querySelector instance-override, prototype `textContent` shadow) both defeated. A later AR pass (during the HTML-orchestrator build) added the **integrity bail**: each probe returns a TAGGED `{t,v}` — `t:false` (tampered surface) ⇒ TAP `Bail out!` ⇒ gate `incomplete` at ANY probe (incl. a mid-run re-tamper), `t:true,v` ⇒ a measured value (`v:null` = absent element = a real predicate fail). So an integrity failure can never be mistaken for a check failure (which would falsely certify a verifier), while a genuinely-broken page still reds. 17 tests.
- `orchestrate.mjs` — **the domain-pluggable Path-B pipeline** (`orchestrateObjective(adapter, …)`): the shared, AR-hardened chain construct → certify → gate-every-answer → **select/ship** → live dossier, in one child process. Domains plug in via a tiny `adapter` (`construct` / `assemble` / `tier`); prose and HTML are two thin wrappers. All the honesty logic lives here (tier never laundered; per-candidate three-way decorrelation guard; `classifyGate` admitted/failed/inconclusive; blocked vs no-verified vs advisory-only). **Output mode (#3):** DEFAULT = **single-best** — ship the ONE verified answer (`decision:'shipped-single'`/`'shipped-single-tiebroken'`, return `pick`+`pickBy`), chosen among equally-VERIFIED admits by the OBJECTIVE PROXY (`rankByProxies` — deterministic; the advisory judge is NEVER consulted), tie-broken to a deterministic id and FLAGGED when the proxy doesn't discriminate (top-tie detected on `meanRank`, not the dense `proxyRank`, which would mis-read a `[1,1,3]` tie as `[1,2,3]`). OPT-IN `o.slate===true` (`--slate`) = the advisory ranked slate (`'shipped-slate'`, unchanged) for the diversity case. `dispersion` runs as a LABEL only (`dispersionMeasurable` / `dispersionState`): with no probes admits are an all-pass monoculture ⇒ **unmeasurable, never "converged"**. **Piece (D) — held-out discriminating probes (`o.discriminatingProbes`):** claim/check-shaped checks NOT in the acceptance set, run MEASUREMENT-ONLY over the admitted answers via an adapter `runProbes` hook → `dispersionState` `converged` (admits identical on the probes) or `diverse` (admits differ → `behaviourally-diverse` flag → consider `--slate`). HARD INVARIANT (tested): a probe NEVER enters `classifyGate`/admission and NEVER changes the pick/order/tier — it can only move the dispersion label; probe ids validated disjoint from the acceptance check ids. Exercised by both wrappers' tests.
- `construct-html-verifier.mjs` / `…test.mjs` — the **HTML generative constructor + assembler** (the analogue of construct-prose-verifier). `constructHtmlVerifier({task,source,requirements,claimFn,adversaryFn,claimAuthor,adversary})` — claimFn → `checks`, a SEPARATE adversaryFn → broken-HTML anti-pages + a red page; deep-frozen requirements, coverage + decorrelation enforced, tier ceiling `constructed-floor-pass`. `assembleHtmlForCertify` builds the gate repo (candidate = `index.html`, verify = the agent-browser oracle), browser-free (`expectedRedCheckIds` = all check ids; certify still requires the red gate to prune). 3 tests.
- `orchestrate-html.mjs` / `…test.mjs` — the **HTML wrapper** (`orchestrateHtml`): builds claimFn/adversaryFn from the agent artifacts (checks + broken-HTML antis) and plugs the HTML adapter into `orchestrateObjective`. End-to-end hermetic tests via a fake agent-browser (each candidate page embeds its scripted measurements) prove certified-floor admit/kill + default single-best ship + opt-in (`--slate`) advisory slate + the uncertified degrade + the (D) no-runner path (probes supplied to HTML ⇒ `unmeasurable` reason `no-runner`, never a crash or false converged); the REAL-browser run is the flagship demo. 5 tests.
- `orchestrate-prose.mjs` / `orchestrate-prose.test.mjs` — **the prose-QA (Path B) wrapper** (now thin over `orchestrate.mjs`) the `/godcode` skill drives — `orchestrateProse(...)`: the DETERMINISTIC chain construct → certify → gate-every-answer → slate → live dossier, in one child process (D8/D9). The skill spawns only the generative agents (claim-author · adversary · oracle-blind answers · cross-model judge) and hands artifacts here. Honest outcomes: certified+pass → DEFAULT single-best ship (`shipped-single`/`-tiebroken`), or opt-in `--slate` advisory slate; certified+0-pass → `no-verified` decline (+bestFailing); uncertified floor → `advisory-only` (nothing verified). Helpers: `classifyGate` (admitted|failed|**inconclusive** — an incomplete gate is never a near-miss), `authorIsDecorrelated`/`resolveAnswerAuthor` (per-candidate three-way decorrelation guard), `judgeFnFromVerdicts` (`NO_VERDICT` sentinel so a missing verdict ≠ a clean tie). Cross-model-AR-hardened over TWO Codex passes (round 1: 3 HIGH + 1 MED honesty-floor holes — tier-laundering, decorrelation bypass, incomplete-as-failure, no-verdict-as-tie; round 2 confirmed all closed + caught 1 fold-introduced MED: a decorrelation guard mislabelling a genuine failure as inconclusive — decorrelation gates ADMISSION not failure). All folded test-first. Now also runs the pre-certify **bleed-lint** at the M1→M2 seam (prose adapter only) and threads `lintReport` into the result + an opt-in `lintShortCircuit` → `needs-reauthor`. Also drives the #3 **single-best matrix** (default single-best vs opt-in slate, proxy-not-judge, top-tie flag, monoculture-unmeasurable, degrade-not-crash, decline-branch isolation, + AR folds: dup-id throws not silent-ships in EVERY proxy config, malformed-proxy surfaces, branch-specific confidence, pickBy-agnostic dispersion caveat, once-per-candidate proxy eval) **and the (D) probe layer** — `runProbes` (in-process `validateClaims`+`evaluateClaims`) on the prose adapter; the matrix proves diverse/converged labelling AND the measurement-only invariant (probes never gate admission or change the pick), plus `validateProbeRows` rejecting a malformed runner output and an honest dossier abort on a structural error (AR-hardened over 2 confirmatory passes: honest converged wording, runProbes-output validation, union acceptance-id collection, M4 wrapped so a structural throw finishes the live page as a declined `setup-error` not a hung "running", `no-probes` vs `no-runner` unmeasurable reasons, `certified`-conditional abort summary, an `m4Finalizing` flag so a dossier-write failure during a normal finish isn't mislabeled). 43 tests.
- `bleed-lint.mjs` / `bleed-lint.test.mjs` — the **pre-certify advisory lint** (the dogfood-driven Path-B reliability fix). `bleedLint({claims, certificate, antiCandidates, redAnswer, source, answerAuthor})` forecasts `certify`'s verdict IN-PROCESS from raw strings — no git, no child process — by reusing the exact `evaluateClaim` predicate (single source of truth). It mirrors certify's four CLAIM-LEVEL conjuncts (structural validity · three-way decorrelation · red-baseline-goes-red · every-anti-**cleanly-killed** with the bleed rule certify.mjs:378) and flags, per check: **BLEED** (an anti for requirement X fails a check owned by requirement Y → certify rejects the kill), **BRITTLE** (a presence check the SOURCE itself fails → will reject correct answers; advisory only, exclusion kinds skipped), **NON-DISCRIMINATION** (the red baseline or an anti isn't killed). STRICTLY ADVISORY: `wouldCertify` is a PREDICTION (no `certified` key, `blocking` always false, predictedTier capped at the ceiling); the real `certifyVerifier` stays authoritative and runs by default. It emits MECHANICAL re-author feedback (checkIds/requirements only, never the anti prose) so the SKILL can re-spawn the blind claim-author once. Proven to PREDICT the real certify (a bleeding verifier the lint flags is the same one the out-of-band certify declines). Cross-model-Codex-AR-hardened (3 HIGH + 2 MED folded test-first: short-circuit could hide a non-fixable failure → `reauthorable` now requires hard preconditions clean; in-process↔emitted claim-id divergence → claim ids validated (non-empty + TAP-safe charset) in `validateClaims`/`emitProseVerifier` and `evaluateClaims` keys by `c.id`; unowned-emitted-check guard). 14 tests.
- `index.mjs` — public exports
- `benchmark/` — the held-out v1-ablation benchmark + the gate-runner-driven discrimination pilot
