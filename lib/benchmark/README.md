# /godcode v1-ablation benchmark (PILOT)

The held-out benchmark for the v1 ablation: *does a diverse fan-out + out-of-band gate beat single-shot Opus xhigh at ≤10× token cost?* Built 2026-06-27 by a 29-agent read-only survey of IMS + Felt (`benchmark.json` is generated directly from the survey synthesis — see the `/godcode` project notes).

## Status: PILOT — underpowered for a scored ablation

- **6** search-shaped positives (5 truly clean; `felt-publish-gate-branch-aware` has a Claude-co-authored verifier kept with a caveat).
- **7** negative / insight-shaped items — *more* than enough for the honesty-floor sub-test.
- A meaningful scored ablation needs **~10–20 positives**; 6 is ~half the floor (a 1-item swing moves win-rate ~17pp). **Do not treat any run on this set as the ablation result** — it is a pilot to debug the gate-runner end-to-end and confirm discrimination.

## Pilot results (2026-06-27) — discrimination CONFIRMED for all 4 Felt items, via the REAL gate-runner

`pilot-runner.mjs` now **drives the shipped gate-runner** (one path, not two): per item it gates the **base** (worktree at `baseSha` + `oracleFiles` = the fix's version of each named test file, the SWE-bench "test patch" — expect gate=PRUNED/RED) and the **fix** (worktree at `fixSha` as-is — expect gate=GREEN), both with `provision` (symlink the gitignored `node_modules`) and `runSubdir` (the package dir). All four Felt positives discriminate — turning the survey's reasoned-from-diff `wouldCatchRevert` into executed fact through the same primitive `/godcode` ships:

| item | base (pass/total) | fix | verdict |
|---|---|---|---|
| felt-false-green-completion-gate | 5/18 | 18/18 | DISCRIMINATES |
| felt-atomic-pin-drop-lifecycle | 143/155 | 155/155 | DISCRIMINATES |
| felt-single-lock-revalidation-refactor | 93/101 | 101/101 | DISCRIMINATES |
| felt-publish-gate-branch-aware | 3/9 | 9/9 | DISCRIMINATES |

Notes:
- `felt-single-lock-revalidation-refactor` discriminated *despite* being behaviour-preserving — the named verify set includes the fix's NEW primitive tests (absent at base), so it does **not** need the mutant corpus to discriminate (mutants would still strengthen it).
- **The gate-runner is now real-repo-capable.** Wiring the pilot to drive it surfaced & fixed 6 gaps test-first (45/45 green): `provision` (symlink gitignored deps), `runSubdir` (monorepo verify cwd), `oracleFiles` (immutability-exempt verifier materialization), a no-false-green honesty floor (zero acceptance evidence → INCOMPLETE), indentation-aware TAP (subtests → leaves), and TAP `\#`-escape handling (no false duplicate). See the `/godcode — v1-lite Build Spec` "Update 2026-06-27" callout.
- IMS items (`ims-warranty-scheduler` = dotnet, `ims-pwa-utc-wire-parse` = vitest) are SKIPPED pending framework support in the runner (v1 = node-tsx only).

Run: `node .claude/lib/godcode/benchmark/pilot-runner.mjs [itemId ...]`

## Reliability ablation pilot (2026-06-27) — the first fan-out-vs-single-shot signal

The make-or-break question is *reliability*: does fan-out-N + gate produce a verified-correct answer more often than single-shot Opus? Measured on `felt-false-green-completion-gate` with **20 iid oracle-blind authors** (two batches, same **solution-free** spec — requirement-level, no implementation guidance) gated through the real verifier (`ablate.mjs`):

| metric | value | meaning |
|---|---|---|
| greens | **10/20** | 10 independent authors passed all 18 human tests; the other 10 were pruned (`:test`) — gate caught every wrong fix, **no false-green** |
| `pSingle` | **0.50** (95% CI [0.28, 0.72]) | single-author success-rate estimate |
| best-of-5 | **0.969** | P(≥1 of 5 correct) at p=0.5 → fan-out-5 + gate reliability |
| best-of-10 | **0.999** | fan-out-10 + gate reliability |

At `pSingle≈0.5`, fan-out-**5** + gate ≈ **97%** verified-correct vs **50%** single-shot at **5×** tokens (fan-out-10 ≈ 99.9% at 10×) — a real reliability win inside the ≤10× budget. This confirms the honest thesis on this item: inference-time search is a *selection* operator amplifying a 50%-reliable author into a ~97–99.9%-reliable VERIFIED outcome, and the gate keeps it honest (it pruned all 10 wrong fixes rather than shipping one). The solution-free spec pulled `pSingle` out of the transcription regime (the detailed-spec dogfood was 3/3 ≈ 1.0, zero lift); two batches (N=5 → 0.60, N=20 → 0.50) agree within CI.

**Still one item.** A scored ablation needs ~10–15 items. **8 more right-sized items mined + vetted** (`vet.mjs`, base RED → fix GREEN confirmed; base tallies 1/4 … 31/36 spanning strong→narrow discrimination): promotion-empty-squash, trust-gate-default-on, brief-confusable-areaid, refresh-absorbed-paths, owned-area-confined-read, claim-ledger-batched-resume, sync-unchecked-base, publish-reconcile-origin. Finding: right-sized SWE-bench-shaped items are *scarce* in Felt (10 of 194 AgentService commits; the prior positives `publish-gate`/`atomic-pin-drop` are too large to author blind). **Next:** finish solution-free specs for the 8, run the ablation across all 9, add per-arm token-cost accounting, then the diversity claim (G1 needs discriminating probes = v2). Run: `node ablate.mjs <itemId> <worktreesRoot>`; mine/vet: `node mine`/`vet.mjs`.

## Scored fleet ablation (2026-06-27) — the honest, regime-dependent result

`score.mjs` ran the ablation across 9 items (8 new at N=6 + the false-green prior at N=20 = 68 author-draws), with per-arm token accounting. Result is **bimodal, not a clean win**:

| item | N | green | pSingle | best-of-5 | regime |
|---|---|---|---|---|---|
| felt-false-green | 20 | 10 | 0.50 | 0.97 | **informative** |
| felt-claim-ledger-batched-resume | 6 | 1 | 0.17 | 0.60 | **informative** |
| felt-promotion-empty-squash | 6 | 6 | 1.00 | 1.00 | too-easy |
| felt-trust-gate-default-on | 6 | 6 | 1.00 | 1.00 | too-easy |
| felt-brief-confusable-areaid | 6 | 6 | 1.00 | 1.00 | too-easy |
| felt-owned-area-confined-read | 6 | 6 | 1.00 | 1.00 | too-easy |
| felt-sync-unchecked-base | 6 | 6 | 1.00 | 1.00 | too-easy |
| felt-refresh-absorbed-paths | 6 | 0 | 0.00 | 0.00 | too-hard |
| felt-publish-reconcile-origin | 6 | 0 | 0.00 | 0.00 | too-hard |

Pooled pSingle 0.603 → fan-out-5 99% → fan-out-10 100%, at ~71k single-shot vs ~356k (5×) authoring tokens. **But the pooled headline is misleading** — it's a blend of 5 too-easy (p=1, fan-out wasted), 2 too-hard (p=0, fan-out futile), and only **2 informative** (p∈0.2–0.8, where fan-out earns its cost: 0.50→0.97, 0.17→0.60).

**This IS the honest thesis, measured:** inference-time search is a *selection* operator — it amplifies *reachable* insight (the informative items) into reliability, **cannot manufacture unreachable insight** (the two 0/6 items: 6 blind Opus draws all failed; both had the relevant source files, so not a missing-file artifact — either the honest-thesis boundary or an underspecified spec, TBD by whether the closest author missed 1 test or many), and is overkill on already-solved problems (the p=1 items). **The gate is the universal value:** across all 68 draws and every regime it **never false-greened** — on too-hard items it ships `no-green` rather than a wrong fix.

**Benchmark lesson (deepened):** right-*sizing* isn't enough — items cluster at p=0/p=1; the informative band is narrow and only 2/9 landed in it. A clean fleet-wide cost-adjusted lift needs **many informative-band items**, which are scarce (a spec detailed enough to be reachable but hard enough to be unreliable is a narrow target). Next: source/construct informative-band items (vary spec altitude on the too-easy ones; check the too-hard specs for completeness); then re-score. Run: `node score.mjs <workflowOutput> <items.json>`.

## Re-pitch A/B (2026-06-27) — prose altitude does NOT relocate regime

Tested lever 1 directly: re-pitch the **5 too-easy items** to higher altitude and re-run the ablation, holding `baseSha` and N=6 fixed so the **only changed variable is the spec prose**. The high-altitude variants (`specs-high-altitude.json`, non-destructive — `benchmark.json` unchanged) keep every behavioral acceptance case + oracle string (required error substrings, reason codes, enumerated REJECT/ACCEPT cases) and remove only the root-cause `## Symptom` pre-diagnosis and the implementation/how-to-detect guidance. 30 iid oracle-blind authors (~1.98M tokens, ~66k/author).

**Result: every item stayed at 6/6, p=1.00 — zero movement.**

| item | canonical spec | high-altitude spec |
|---|---|---|
| felt-promotion-empty-squash | 6/6 | **6/6** |
| felt-trust-gate-default-on | 6/6 | **6/6** |
| felt-brief-confusable-areaid | 6/6 | **6/6** |
| felt-owned-area-confined-read | 6/6 | **6/6** |
| felt-sync-unchecked-base | 6/6 | **6/6** |

All 30 worktrees carry real, **varied** diffs (brief-confusable 18–48 lines across authors; sync 101–178) — 30 distinct correct fixes, not copies, so the green is not vacuous. The hand-holding removed was **not load-bearing**: every author independently re-derived the "insight" (probe the staged index with `git diff --cached`; NFKC + strip leading format chars for the confusables; stat-based regular-file + byte-cap checks; route sync through the ref store).

**Conclusion — regime is a property of the bug, not the spec prose.** Once a spec is *requirement-complete* (which it must be, or you manufacture verifier-pedantry artifacts rather than insight-difficulty), Opus xhigh reaches the correct implementation reliably for these bugs. This was the **maximal *valid* re-pitch**: going further (deleting the enumerated acceptance cases) wouldn't lower p honestly — it would *underspecify*, so authors solve a different valid problem the narrow verifier rejects, measuring spec/verifier coupling not reachability. So this is a clean negative, not a "try harder."

**Lever 1 (re-pitch existing items) is dead.** You cannot grow the informative band by editing prose; informative items must be **selected** (bugs whose correct fix is a coin-flip *given a complete requirement* — subtle ordering, easy-to-miss edge case, invariant-breaking refactor), not **engineered**. The gate stayed honest across +30 draws (98 total: 68 prior + 30 here, zero false-green). Remaining levers: diagnose the 2 too-hard 0/6 items (true boundary vs underspecified); add a second source repo (IMS headless) to widen the intrinsic-difficulty pool. Run: `node score.mjs <workflowOutput> <items.json>` against worktrees from `setup-repitch.mjs`.

## Closeness diagnosis of the 2 too-hard items (2026-06-27) — BOTH were underspecified, NOT the boundary

The scored fleet labelled `felt-refresh-absorbed-paths` and `felt-publish-reconcile-origin` (both 0/6) as *too-hard = the honest-thesis boundary (search can't manufacture unreachable insight)*. **That label was WRONG.** `diag.mjs` re-ran each item (N=8 oracle-blind authors, canonical specs) and measured, per author, how many of the **target set** (the bug-relevant tests an author must flip — derived by gating base vs fix) flipped. Both turned out to be **verifier-coupling artifacts** — the verifier asserts on an API surface the spec never pinned, so 0/N measured spec/verifier coupling, not reachability:

- **`felt-refresh-absorbed-paths` — PROVEN underspecified.** All 8 authors implemented the correct 5-case logic but bound it to an invented option name `tolerateAbsorbedDivergences`; the verifier calls `executeRefresh(..., { acceptAbsorbedPaths: true })`, so the authors' guarded branch never fired → 0/2. **The rename experiment is decisive** (`confirm-rename.mjs`): string-replacing `tolerateAbsorbedDivergences` → `acceptAbsorbedPaths` flipped **4 of 8 authors from PRUNED to GREEN (13/13)** with no other change. With the option name pinned, **pSingle = 0/8 → 4/8 = 0.50 — an informative-band item** (fan-out-4 ≈ 94%). The other 4 authors had genuine logic errors (stuck at 1/3 even renamed) — exactly the spread a real informative item shows.
- **`felt-publish-reconcile-origin` — same class.** 3/8 authors flipped 1/2 (got F3 "behind reconcile refuses a non-fast-forward"), all 8 missed F1 ("`getBaseBranchPath` surfaces a build/sync path mismatch"). The spec mentions `reconcile`/`fast-forward` (F3, which authors reached) but **never** `getBaseBranchPath`, "build/sync", or "path mismatch" (F1's subject) — so F1 was unreachable-by-omission, not unreachable-by-difficulty.

**Three consequences:**
1. **Correction to the fleet result.** The benchmark has **zero confirmed honest-thesis-boundary items**. The boundary claim (search amplifies reachable insight, cannot manufacture an unreachable one) remains the design principle and is *argued and plausible*, but is **not empirically demonstrated** by this benchmark — both candidate p≈0 items dissolved into under-specification on inspection. A clean boundary item still needs to be *found* (genuinely unreachable insight given a complete spec — hard by construction).
2. **A candidate lever to grow the informative band** — de-underspecification (pin every API name/field/string the verifier asserts on). The rename proxy suggested refresh would land informative at ~0.50. **It did NOT — see the pinned confirmation below: de-underspec yields a too-easy item, not an informative one.**
3. **A benchmark-validity gate.** An item is only valid if its spec pins everything the verifier checks; otherwise 0/N is a coupling artifact masquerading as a boundary. **Audit every item for this** (does the spec name every option/field/string the test asserts on?) before trusting a 0/N as "too-hard." Run: `node diag.mjs <itemId> <worktreesRoot>` (closeness), `confirm-rename.mjs`-style probes to isolate a name artifact.

## Pinned confirmation (2026-06-27) — de-underspec yields TOO-EASY, not informative

Pinned both items' missing names into the spec (`specs-pinned.json`: refresh `acceptAbsorbedPaths`/`absorbedPaths`; publish-reconcile `syncBaseBranch(..., {ffOnly})`/`getBaseBranchPath`) and ran a **fresh** oracle-blind authoring (N=8 each, `setup-pinned.mjs` — not a post-hoc rename). Result:

| item | canonical (under-spec) | pinned (fresh authoring) |
|---|---|---|
| felt-refresh-absorbed-paths | 0/6 (artifact) | **8/8, p=1.00 — too-easy** |
| felt-publish-reconcile-origin | 0/6 (artifact) | **8/8, p=1.00 — too-easy** |

All 16 are genuine, varied fixes (refresh 68–82 changed lines, publish-reconcile 125–154, all using the pinned names, all gated green against the real oracle).

**The rename proxy (4/8 → 0.50) was confounded.** It took the *under-spec* authors and fixed only their invented name; 4 had correct logic, 4 didn't — because the ambiguous spec tripped their *logic* too, not just the name. The valid measurement is fresh authoring against the complete spec, and that is **8/8**. De-underspecification removed the false-hard artifact but landed on **too-easy**, exactly like the original 5 too-easy items.

**Conclusion (now triply-confirmed): regime is a property of the bug given a complete spec, not adjustable by spec engineering in either direction.** (a) Re-pitch *up* (remove hand-holding) → too-easy stays too-easy. (b) De-underspecify (pin names) → artifact-hard becomes too-easy. (c) The only genuinely-informative items (`felt-false-green` 0.50, `felt-claim-ledger-batched-resume` 0.17) are informative because the *bug's* correct fix is intrinsically a coin-flip **even with a complete spec** — a property of the bug, not the prose.

**The informative band is irreducibly scarce and cannot be manufactured.** Spec-tuning only shuffles items between artifact-hard and too-easy. The only path to a powered ablation is **volume-mining for the rare intrinsically-coin-flip bug** (lever c: a second source repo + more mining), accepting that most mined items will be too-easy or artifact-hard. There is no spec-engineering shortcut. Net informative count after all of this work: still **2**. The benchmark's real lesson is about the bug distribution, not the specs — and it sharpens /godcode's value framing: fan-out's reliability premium over single-shot Opus is concentrated in a genuinely narrow, non-expandable regime; the **gate is the universal value**.

## Construction (SWE-bench shape)

Each item is a real merged commit: `baseSha` = the parent (the **known-wrong** state the solver starts from), `spec` = a self-contained task (the solver sees **only** this, never the tests), verifier = the human-authored tests the fix makes pass. The negative items are real fixes whose only catching evidence is insight-coupled or model-authored — they probe whether `/godcode` ships the baseline + human-gates rather than false-certifying.

## What the survey established (the structural findings)

- **Felt.AgentService is the source repo.** ~1698 node:test cases over real throwaway git repos, zero Docker/DB, fully headless. 4 of 6 positives come from it, and it uniquely supplies a genuinely **pre-existing human-authored discriminator** (`felt-single-lock-revalidation-refactor` / `6a69635`).
  - **NB — Felt is DEPRECATED** (superseded 2026-06-03; split into **FeltControl** = LLM-free control plane + **OTBHarness** = work engine). It is used here purely as a **frozen test workload**, not an active dev target. A parked repo with a stable, no-longer-churning suite is *ideal* for a reproducible benchmark (history won't move, suites stay green). /godcode's eventual **production** workload is the live repos (IMS, OTBHarness), where new search-shaped problems arise — do not mistake "best benchmark source" for "best production target." Felt's history is also finite, so it caps how many positives can be mined from it.
- **IMS's strongest tests are Docker-gated.** The richest RTF/BU-Profit discrimination lives behind the env-gated `RtfHeadlessGateRunner` (needs a Docker MSSQL `test` DB), so IMS's cheap headless positives are effectively just `warranty` + `utc-wire`.
- **Model-authored-test contamination is real.** Recent Felt commits skew Claude-co-authored; mining more positives must filter on git trailers (keep human / Cursor, drop gate-model). A model-authored verifier is exactly the case the honesty floor caps at human-gate.

## Per-item caveats baked into the gate-runner wiring

- **Same-commit verifiers** (most positives): `wouldCatchRevert` is *reasoned from diff*, not executed — the pilot must run the reverted base and confirm RED before any scored run.
- **`felt-single-lock-revalidation-refactor`** is behaviour-preserving — a literal base revert **passes**; discrimination is against subtly-wrong fusions only → needs the **mutant corpus**, not the parent.
- **`ims-pwa-utc-wire-parse`**: materialize tests from descendant `04c3cdb0`; on base the imports don't exist → the runner must count import/assert failure as **FAIL**, not skipped.
- **`felt-atomic-pin-drop` / `felt-false-green`**: scope to the named test files — those repo states carry unrelated `phase4-promotion-routes` failures; do not gate on whole-suite green.

## Next actions (from the survey, in order)

1. **Pilot the gate-runner end-to-end** on all 13 items — confirm each positive goes RED at base, GREEN at fix. Converts every reasoned `wouldCatchRevert` into an executed fact.
2. **Mine ~8–12 more Felt positives** (deploy/sync, trust-gate decision router, brief-approval-resolver) filtering on git trailers, to reach the ~15 floor.
3. **Wire the mutant corpus** — Stryker.NET (`WarrantyVisitScheduler`) + StrykerJS (deploy-manager, claim-ledger, spec-store, dates). Mutation score doubles as a verifier-strength gate (demote items whose suite kills <~70% of in-scope mutants).
4. **Add an explicit honesty signal to `/godcode`** so negative items are scorable (a `shipped-baseline+gated` vs `certified-pass` decision) — otherwise a non-discriminating green is indistinguishable from an honest decline.
5. **Decision gate** after the pilot: if the 6 discriminate cleanly and ~8 more are minable in budget → scored ablation at ~15 positives; else hold and report the run as underpowered.

See `benchmark.json` for the full item set, known-wrong corpus (12 real reverted bases + the mutant plan), risks, and scoring.
