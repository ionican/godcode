---
name: super-godcode
description: Fable-mimicry superset of /godcode — keeps the never-false-green gate, decorrelation, and honest-decline core, and adds the 8 upgrades that make the harness ITERATE rather than only SELECT: (U1) bounded gate-feedback repair loop, (U2) toolchain-feedback authors, (U3) debug path with deterministic fault localisation + certified repro oracle, (U4) cross-model paradigm-cell cohorts, (U5) verifier-strength audit + suite strengthening, (U6) milestone-gated decomposition for large builds, (U7) adaptive compute controller, (U8) cross-run ledger + stepping-stone archive. Ships VERIFIED-or-honest-decline exactly like godcode; new evidence appears as QUALIFIED labels (suite-strength k/n, repaired flag, provenance), never as new trust.
argument-hint: <objective / bug / question / spec-path> [--repo <dir>] [--verify "<cmd>"] [--debug] [--milestones] [--n <wave=adaptive>] [--max <draws=adaptive>] [--repair <rounds=1>] [--models opus[,codex,glm]] [--base <ref>] [--slate] [--gate-only] [--strength-audit] [--no-ar] [--no-ledger]
allowed-tools: Read, Edit, Write, Glob, Grep, Bash, Agent, AskUserQuestion
---

`/super-godcode` is `/godcode` upgraded from a **selection** harness to an **iteration** harness. godcode's honest thesis stands: fan-out is selection over the base model's distribution — with per-draw success probability `p`, N draws buy `1−(1−p)^N`, and nothing about sampling moves `p`. The 8 upgrades here attack `p` itself (feedback, localisation, decomposition), the *effective* N (real diversity, not temperature), the *meaning* of a green (suite strength), and the *allocation* of compute (adaptivity, memory). Every honesty invariant is inherited unweakened.

## Relationship to /godcode (read this first)

- **The deterministic core is shared and unchanged**: `$VAULT/.claude/lib/godcode/` (gate-runner, harness `select`, triage, certify, orchestrate*, dossier-cli). Never fork it; never touch gate code.
- **Path A / Path B mechanics, the Working-root note (`$VAULT`, `DC()`, `SLUG`), the dossier protocol, the one-clarification-round rule, and all agent prompt templates are inherited verbatim** from `.claude/skills/godcode/SKILL.md`. When executing those stages, follow that file; this document specifies only the deltas. Do not duplicate its text into prompts — read it.
- **All godcode invariants apply** (never claim VERIFIED without a real green; construct-then-certify; three-way decorrelation; oracle-blind authors; default single-best, slate opt-in; dispersion is a label; worktrees only; live HTTPS dossier surfaced first). New invariants are added at the bottom; none supersede an old one.

## Intended use — the user's view (guide the user through this)

**Run it when all three hold**: (1) the objective has an executable verifier, or one can honestly be constructed (Path B); (2) the space is worth searching — not a one-liner, a rename, or config trivia; (3) the blast radius justifies N× tokens and latency over one inline pass. **If the request fails this test, say so and route cheaper** — inline edit, `/implement`, or a plain single pass. Running a fan-out on trivia is a worse answer, not a safer one.

**Typical invocations:**
```
/super-godcode "NullRef in TimeController.SyncTimeEntries when …" --repo ~/RiderProjects/IMS3.0 --debug
/super-godcode "add the CSV export endpoint per spec.md" --repo <dir> --milestones --strength-audit
/super-godcode "<question, or self-contained artifact spec>"          # Path B — verifier constructed + certified first
/super-godcode <task> --repo <dir> --gate-only                        # gate ONE candidate honestly, 1× cost
```

**Set the interaction expectation at the start of every run:** the live HTTPS dossier URL arrives before anything else; ONE batch of clarifying questions follows (the last is always an open catch-all — the user should front-load everything, there is no second round); then the run is fully autonomous, with every judgement call recorded in the dossier's Decisions ledger. The run ends in exactly one of: a **VERIFIED ship** (possibly qualified — `suite kill k/n`, `repaired`, `AR advisories (n)`), an honest **NO-GREEN decline** with the best failing candidate surfaced for a human gate, or an **ADVISORY** outcome where nothing is verified and the report says so plainly.

## The upgrade map

| # | Upgrade | Attacks | Stage | Honesty cost |
|---|---|---|---|---|
| U1 | Gate-feedback repair loop | `p` (per-candidate) | after each red wave | controlled: sanitised evidence only |
| U2 | Toolchain-feedback authors | wasted `incomplete` draws | authoring | none (oracle-free signal) |
| U3 | Debug path: localise + certified repro oracle | `p` (evidence) + verifier coverage | pre-authoring | none (repro certified red-on-base) |
| U4 | Cross-model paradigm-cell cohort | effective-N | wave composition | none (selection unchanged) |
| U5 | Verifier-strength audit + strengthening; U5b cross-model AR fold | meaning of green | post-green | none (advises, never gates) |
| U6 | Milestone-gated decomposition | `p` (task size) | large objectives | none (each slice still gated) |
| U7 | Adaptive compute controller | cost allocation | throughout | none (never tiers down verification) |
| U8 | Run ledger + stepping-stone archive | cold starts, cross-run `p` | start + finish | none (archived candidates re-gated) |

## Step 0 — Route, ledger consult, dossier, clarify

**Routes** (superset of godcode's two):
- **Path A** — repo with an existing discriminating suite → godcode Path A + U1/U2/U4/U5/U7.
- **Path B** — no ready oracle (question / from-scratch artifact) → godcode Path B + U4/U7. (U1 repair NEVER applies to the certify chain — see invariants.)
- **Path D** (`--debug`, or auto when the objective is a bug with an observable failure) — Path A plus the U3 localisation + repro-oracle prologue.
- **Modifier `--milestones`** (or auto when the spec plausibly spans >3 files / a greenfield module) — U6 decomposition wraps whichever path is active.
- **`--gate-only`** — unchanged from godcode: gate ONE candidate, no fan-out; U5 still applies on green.

**You — the orchestrating session — are oracle-blind too.** The same blindness the author prompts enforce binds YOU for the whole run: never Read, Grep, or cat a test file, CI config, or lockfile in the target repo — not to compose the task spec, not to diagnose a red, not to brief a wave or a repair. Everything you learn about a failure comes from the sanitised gate evidence (failing test NAMES + assertion messages, U1). If a red genuinely cannot be understood from that, surface it as a human-gate moment — do not read the oracle.

**U8a — ledger consult (before clarifying; skip on `--no-ledger`).** Priors live at `$VAULT/_godcode/ledger.jsonl`, one JSON object per completed run:

```bash
VAULT="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Rick's World"
node "$VAULT/.claude/lib/godcode/ledger.mjs" query --repo "<repo-path>" --limit 10   # all-repo class stats: drop --repo
```

Use the priors mechanically, not speculatively: a known `verify` command / protected-path set for this repo → don't re-ask it in clarification; historical `greens/draws` for this problem class → seeds U7's initial `pHat`; historical winning paradigm cells → bias (never exclusive) wave-1 cell assignment. No ledger file → proceed on godcode defaults; this is a cold start, not an error.

**Dossier + clarification round: identical to godcode** (init dossier first, surface the HTTPS URL as the very next action, one `AskUserQuestion` round ending with the open catch-all, then fully autonomous with board-adjudicated Decisions). Two delta rules: (1) milestones passed to `init` should reflect the REAL plan — for `--milestones` runs use the U6 decomposition's milestone titles once known (`DC` supports adding progress against them); (2) record ledger-derived assumptions as Decisions (`adjudicator: "ledger-prior"`), so a stale prior is auditable.

## U7 — Adaptive compute controller (replaces fixed `--n`/`--max` defaults)

godcode's triage already samples `pSingle` (Wilson interval) and stops honestly. U7 adds the allocation policy around it. `--n`/`--max`, when given explicitly, override all of this.

1. **Always probe 1× first** (godcode A2, unchanged). Then classify the probe's failure before spending a wave:
   - `green` → ship at 1× (unchanged).
   - `incomplete` with `failStep` = toolchain/hang/no-acceptance → **fix the gate, don't author more** (godcode's rule, now explicit and first).
   - red, **near** (≥80% of acceptance tests passing) → small wave (`n=2`) + U1 repair on the probe candidate. The insight is likely present but incomplete — repair is cheaper than redraw.
   - red, **far** → diverse wave (`n=3–4`) across U4 paradigm cells; repair only survivors that get near.
2. **Draw budget from blast radius**, declared once in the clarification round or a Decision: low → `max=4`, medium → `max=8` (godcode default), high (merge-gate class / load-bearing algorithm) → `max=16`. Ledger `pHat` for the class shifts the initial wave size by ±1.
3. **Continue rule**: draw while the harness contract says `keepExploring: true` AND `draws < max` AND (Wilson `hi` × remaining budget) still admits a green in expectation — i.e. stop early when even the optimistic `pSingle` bound can't produce a green within budget. This is a cheaper stop, never a cheaper green.
4. **Model tiering (authors only)**: authors default to the session model (Opus-class). On a ledger-known **too-easy** class you may staff wave 1 with cheaper scouts (e.g. Sonnet) and keep one Opus author; on hard classes go straight to full-effort authors. **Never tier down the gate, certify, judge, or adjudication path** — the discriminating role always runs at full strength (inherited G3 rule).

## U4 — Cross-model paradigm-cell cohort (replaces the single sideways seed)

godcode seeds ONE wave-1 author with a cross-model paradigm hint. U4 generalises it into structured diversity — attacking Codex finding #2 (six same-model draws ≈ effective N of 2):

1. **Paradigm map (once per run, before wave 1).** One cross-model enumeration — `/codex:research --background "<problem-CLASS> — distinct implementation/solution paradigms"` (class, never instance; same leak rules as godcode's sideways seed) — distilled to **3–6 named cells** (paradigm name + 1-line approach hint each). Record the map as a Decision.
2. **Pin each wave-1 author to a distinct cell** via the `<angle>` slot (approach hint only — never a solution, never a test). Later waves fill cells that produced no green yet, biased by ledger `cellWins`.
3. **Cross-model authors.** When `--models` includes more than `opus` (default `opus,codex` when the codex CLI is available): staff ≥1 cell per wave with a **different model family** — a Codex author via `codex exec` writing into its own worktree with the same oracle-blind Path-A author prompt; optionally a local GLM author via `/glm` for free extra diversity. Tag every candidate's dossier entry with `{model, cell}` provenance. The gate treats all candidates identically — provenance is evidence for the report and the ledger, never a selection input.
4. **Selection is unchanged** (gate admits; deterministic proxies order). With `--slate`, the slate gains a best-per-cell view: report the top VERIFIED candidate of each behaviourally-distinct cell (a quality-diversity portfolio), not just a flat ranking. Single-best default is untouched.

## U2 — Toolchain-feedback authors (oracle-blind ≠ tool-blind)

godcode authors were forbidden to run ANYTHING ("your edits on disk ARE your deliverable") — so trivially non-compiling candidates burn whole draws as `incomplete`. The oracle is the **test suite**, not the compiler: letting authors see oracle-FREE toolchain signals costs zero honesty and kills the wasted-draw tail.

**Path A author prompt delta** — replace the "Do NOT run the suite or build" rule with:

> - You MAY run the build, type-checker, linter, or `--check`-style syntax checks (scoped to the source project, e.g. `<run-subdir>`), and iterate until they pass. You may NOT run any test command, and the ORACLE-BLIND rule still stands: never read, open, grep, or reference any test file, CI config, or lockfile. (The gate still rejects any candidate whose diff touches them.)

For .NET point authors at the **source project** build (`dotnet build <src.csproj>`), not the solution (which compiles test projects and can leak test symbols through errors). For TS/JS use `tsc --noEmit -p <src>` / the package's lint. Keep the KillStalePort/build-server footguns in mind on IMS (see memory) — authors work in their own worktrees, so builds are isolated.

## U3 — Path D: localise, then repro-first (debugging)

For bug objectives, evidence beats sampling. Before any authoring:

1. **D1 — Repro.** Write a minimal repro (a failing test file, or a script asserting the wrong behaviour) and **verify it is RED at `$BASE` out-of-band** — run it yourself in a clean worktree at base. Red-on-base is the repro's certification; a repro that passes at base is wrong, fix it before proceeding. This mechanises write-the-regression-test-BEFORE-the-fix.
2. **D2 — Deterministic localisation** (pick what the bug affords, cheapest first):
   - `git bisect run <repro>` when a known-good ref exists → the introducing commit;
   - delta-debug the failing input (halve it while red) → minimal trigger;
   - one instrumented run (targeted logging/trace around the suspect path) → observed vs expected at the fault site.
   Distil into `localisation.md`: suspect files/functions, the introducing commit if found, the minimal trigger, observed-vs-expected. This is **evidence, not oracle** — it contains no test content and no fix.
3. **D3 — Repro joins the gate.** Install the repro test via `oracleFiles` (immutability-exempt, candidates can't touch it) and extend `--verify` so acceptance = **repro goes green AND the existing suite stays green**. This closes the classic hole where the repo's suite doesn't cover the bug (that's why it was a bug) yet a candidate can green the suite without fixing anything.
4. **D4 — Authors get the spec + `localisation.md`.** They remain test-blind (the repro file itself is never shown). Fan-out proceeds per U7 — localised bugs usually resolve at 1–2 draws.

## U1 — Gate-feedback repair loop (the biggest single upgrade)

godcode discards its richest signal: the gate's red output. A failing candidate is *known-wrong-with-a-reason*, and the reason is machine-readable. U1 feeds it back — bounded, sanitised, and tagged.

**When**: after a `harness.mjs` run in which no candidate greened (or fewer than `targetGreens`). **Who**: the top ≤2 failing candidates by acceptance-pass-count (the harness's `bestFailing` ordering). **Rounds**: `--repair` (default 1, hard max 2) per candidate per run.

1. **Sanitise the evidence.** From the candidate's gate `evidencePath`, extract ONLY: failing acceptance test **names** + the assertion/exception **message lines** (≤40 lines total). Never test source, never expected-value tables, never diff-vs-oracle content:
```bash
node -e '
  const ev=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  const fails=Object.entries(ev.perTest??{}).filter(([,v])=>v==="fail").map(([k])=>k);
  console.log(["FAILING ACCEPTANCE TESTS:",...fails.slice(0,15),"",
    "FAILURE MESSAGES (truncated):",(ev.failureMessages??"").split("\n").filter(l=>/assert|expect|error|exception/i.test(l)).slice(0,25).join("\n")].join("\n"))
' "<evidencePath>"
```
   (Adjust field access to the actual evidence JSON shape on first use; the contract is the OUTPUT — names + messages only.)
2. **Repair prompt** (spawned to a fresh agent, working in the SAME worktree):
> You are repairing your own earlier attempt at this task. TASK: `<the task spec>`. Your current change (diff vs base) is in this worktree: `<dir>`. An external verifier ran it and reported the failures below. Fix your change so these pass, WITHOUT weakening or working around anything: the same HARD RULES apply (oracle-blind — no reading/touching test files, CI, lockfiles; source edits only; you may build/typecheck per U2). Failures: `<sanitised evidence>`.
3. **Re-gate everything** — re-running `harness.mjs` over `$ROOT` re-gates the cohort for free; repaired candidates go through the identical out-of-band gate.
4. **Tag honestly.** Mark repaired candidates `repaired: true` (in `DC candidate-update` json and the ship contract). A repaired green is still a real green — the gate is unchanged — but the tag preserves the audit trail that this candidate saw sanitised oracle-derived signal.

**Why this is honest enough**: the evidence is exactly what a human developer gets from CI (red names + messages); the immutability guard still rejects any test-touching diff; held-out mutation probes (godcode's Path-A dispersion layer) remain available to flag overfit-to-the-suite behaviour; and the certified floor in Path B is out of repair's reach entirely. **Why it is worth the controlled relaxation**: repair moves `p` — the one thing the honest thesis says fan-out cannot do. Expected draws fall from `1/p` toward `1/p′` with `p′ ≫ p` on near-miss regimes.

**Hard exclusions**: U1 never touches Path B's construct/certify chain — `claims.json`, `adversary.json`, `redAnswer`, and the source stay byte-fixed (only the existing bleed-lint single blind re-author is allowed, per godcode B3.5). Answer-authors in Path B may receive ONE repair round only when the floor is already **certified** and the evidence is sanitised to failing check ids + `requirementId`s (never claim text).

## U5 — Verifier-strength audit (what does this green MEAN?)

A green against a weak suite is a weak claim. On `--strength-audit` (auto-on for high blast radius), after a Path-A green is selected:

1. **Generate ~5 mechanical mutants of the SHIPPED diff** — single-site, operator-driven only (negate one condition / off-by-one a boundary / swap `<`→`<=` / drop one guard / transpose two statements). Mechanical operators only, never "plausible LLM mistakes" (same-family mutants share the authors' blind spots — the original design's rule). Apply each to a copy of the shipped worktree.
2. **Run the suite on each mutant** (the gate machinery re-used; mutants that fail to build count as killed-by-toolchain, reported separately).
3. **Kill-rate = suite strength.** Report the ship as `✓ VERIFIED (suite kill k/n)`. `n−k` surviving mutants are listed with their mutation site — each one is a behaviour the suite does not pin.
4. **Strengthening pass (optional, offered not forced)**: for surviving mutants, run the Path-B construct+certify machinery to author a SMALL decorrelated check set (property/regression claims from the spec, certified red against the surviving mutants, green on the shipped candidate), install via `oracleFiles`, and re-gate. Only a CERTIFIED strengthened check upgrades the label; an uncertified one is reported as advisory.

**Invariant**: the audit **qualifies** the label; it never flips a VERIFIED to failed and never blocks the ship. Low kill-rate + high blast radius → recommend the strengthening pass or a human gate, in those words.

### U5b — Cross-model adversarial review of the shipped diff (pre-PR)

Auto-on for high blast radius, opt-in otherwise (`--no-ar` skips). Runs after U5's kill-rate is known and before the PR offer. Rationale: the suite — even strengthened — only pins behaviours someone thought to test; a decorrelated reviewer surfaces the ones nobody did, and running it while the harness is still open means findings get folded now instead of bouncing at the push gate later.

1. **Run `/adversarial-review`** (Codex — the independent model) inside the winning candidate's worktree, reviewing the shipped diff vs `$BASE` only.
2. **Findings are advisory tier.** No finding vetoes the VERIFIED label; no clean pass adds trust. The label never moves on model opinion, in either direction.
3. **Fold confirmed critical/high findings test-first.** For each: author a check that pins the claimed defect (a repo test for Path A; a constructed+certified claim for Path B), confirm it goes RED on the shipped candidate — a finding whose check cannot be made to fail is unconfirmed and stays advisory — then fix the candidate (a targeted edit, not an oracle-blind draw; that is fine because the new check is now IN the acceptance set) and **re-gate the full acceptance set out-of-band**. Only that re-gated green changes the verdict; the folded check ships with the PR.
4. **Report the remainder.** Unfolded findings ship as `AR advisories (n)` beside the label, verbatim in the dossier. The codex-ar-push-gate still fires at `git push` as the backstop; U5b does not replace it.

## U6 — Milestone-gated decomposition (large builds)

One-shot authoring of a multi-file objective gives all-or-nothing verdicts and re-authors from zero. On `--milestones` (or auto-trigger, confirmed as a Decision):

1. **Decompose** (board, recorded as Decisions): ordered milestones `m1..mk`, each with a **verifiable slice** — Path A: the subset of the suite (or a constructed+certified check file) that pins that milestone; Path B: that milestone's claims. Every slice must be executable; a milestone with no checkable surface is merged into its neighbour, not waved through.
2. **Gate incrementally.** Authors build milestone-by-milestone; the gate runs the cumulative acceptance set (slices `1..j`) at each boundary, so regressions of earlier milestones are caught at the boundary they break.
3. **Targeted re-author.** A red at milestone `j` re-authors **only `j`**, from the last green state: commit the green-so-far worktree state and treat it as the new author base. Fan out (U4/U7) only on milestones that resist; most milestones ship at 1×.
4. **Honest partial contract.** If the budget dies at milestone `j<k`: ship nothing by default, but report `milestones green: j/k` + the frozen green-so-far worktree as `bestFailing`-equivalent (labelled *partial — human gate required*). A partial is never presented as a VERIFIED whole.

Dossier milestones mirror the real `m1..mk`, so the live page shows true build progress.

## U8b — Ledger append + stepping-stone archive (finish)

At `DC finish` time (every run, incl. declines; skip on `--no-ledger`):

1. **Append one JSON line** via the deterministic CLI (validates the row, stamps `ts` + `harnessRev` — never hand-write the line):
```bash
node "$VAULT/.claude/lib/godcode/ledger.mjs" append <<'ROW'
{"slug":"<slug>","repo":"<repo-path-or-null>","path":"A|B|D","problemClass":"<1-3 word class>",
 "decision":"<ship contract decision>","draws":0,"greens":0,"pSingle":{"point":0,"lo":0,"hi":0},
 "repaired":0,"verify":"<cmd>","suiteKill":"k/n|null","winningCell":"<paradigm|null>",
 "cells":[{"cell":"<name>","model":"<opus|codex|glm>","gate":"green|pruned|incomplete"}],
 "costDraws":0,"notes":"<one line>"}
ROW
```
2. **Archive stepping-stones**: for pruned candidates that were behaviourally DISTINCT (different gate signature from every green — the dispersion classes), save `git diff` patches under `$VAULT/_godcode/archive/<problemClass>/<slug>-<candidate>.patch` with a 3-line header (task, cell, signature). Losers with novel behaviour are ancestors of future winners (the Darwin-Gödel-Machine lesson already logged in the project note); losers identical to a green are noise — don't archive them.
3. **Future seeding**: a later run on a similar class may seed ONE wave-1 author with an archived near-miss patch as its starting worktree state (provenance-tagged `seed:archive`). It is gated identically — the archive can propose, only the gate disposes.
4. **Compliance audit (after the ledger append)**: run the deterministic transcript audit and annotate the row — this is how instruction-level rules (orchestrator oracle-blindness, bookkeeping) get MEASURED instead of assumed:
```bash
node "$VAULT/.claude/lib/godcode/audit-run.mjs" --transcript "<this session's ~/.claude/projects/<proj>/<session>.jsonl>" \
  --ledger "$VAULT/_godcode/ledger.jsonl" --slug "<slug>" --dossier "$VAULT/_godcode/runs/<slug>/run.json" --annotate
```
Run it UNSCOPED (no `--repo`) for dedicated run sessions. A non-pass block in the ledger is evidence for the retro loop, never something to edit away.

## Ship contract deltas

Everything godcode reports, plus: `repaired` flags per candidate; `suiteKill k/n` when U5 ran (with surviving-mutant sites); `AR advisories (n)` + folded-finding checks when U5b ran; `{model, cell}` provenance per candidate; `milestones j/k` for U6 runs; the ledger line written. Colour-blind labelling unchanged (`✓ VERIFIED` / `✗ NO-GREEN` / `? ADVISORY`, glyph + word, never colour alone).

## Invariants (additive to godcode's — do not weaken either set)

- **Sanitised evidence only.** Repair (U1) sees failing test NAMES + assertion MESSAGES, never test source, oracle files, or expected-value content. The sanitiser output is the contract; when in doubt, drop the line.
- **The orchestrator is oracle-blind too** (versus-bench finding, 2026-07-02): the session driving this skill never reads test/CI/lockfile content in the target repo at any point in a run — spec composition, red diagnosis, wave briefs, and repair prompts all work from sanitised gate evidence only. Round 1 showed author-blindness holding while the orchestrator read tests in 4/7 runs — a leak path around the author guarantee; this closes it.
- **Repair is bounded and tagged.** ≤ `--repair` rounds (hard max 2), top-2 failing candidates only, `repaired: true` in every report. The certify chain (claims/antis/red/source) is byte-fixed — repair never touches it.
- **Toolchain feedback is oracle-free by construction** (U2): build/typecheck/lint only, scoped to source; any test execution by an author disqualifies the candidate (and the gate's immutability guard remains the backstop).
- **Localisation is evidence, not oracle** (U3): `localisation.md` carries no test content and no fix; the repro test is certified red-on-base before it joins the gate.
- **Provenance and paradigm cells never enter selection** (U4): the gate admits, deterministic proxies order; model/cell tags are report + ledger data.
- **Strength audit qualifies, never gates** (U5): kill-rate annotates the label; a surviving mutant never un-ships a green; only a CERTIFIED strengthening check changes the acceptance set.
- **AR advises; only a folded, re-gated check changes a verdict** (U5b): `/adversarial-review` output never vetoes, blocks, or certifies. A confirmed finding enters the run only as a test-first check — RED on the current candidate, green after the fix — with the full acceptance set re-gated out-of-band. Unfolded findings are reported as advisories, never silently dropped.
- **Every milestone slice is executable** (U6); a partial build is reported as a partial, never as a VERIFIED whole.
- **Verification never tiers down** (U7): scouts may author; the gate, certify, judge, and adjudicator always run full-strength.
- **The archive proposes, the gate disposes** (U8): archived patches and ledger priors are seeds/priors only; nothing from memory ships without a fresh out-of-band green in THIS run.
- Reference: `.claude/skills/godcode/SKILL.md` (inherited mechanics) · `.claude/lib/godcode/README.md` (deterministic core) · [[godcode — God-Mode Coding Harness]] (design history).

## Current fallbacks (honest gaps — candidates for lib hardening)

U1's sanitiser and U5's mutant generator run as inline recipes above (deterministic one-liners, but not yet AR-hardened lib modules with tests). If a recipe misbehaves, prefer doing less (drop evidence lines, skip the audit) over improvising a richer channel. Promoting these two to `.claude/lib/godcode/` modules (`sanitise-evidence.mjs`, `mutate-shipped.mjs`) is the logged next build. U8's ledger and the post-run compliance audit ARE lib modules now (`ledger.mjs`, `audit-run.mjs`, tested 2026-07-03): every append validates and stamps `harnessRev` (12-hex over both SKILL.md files + the lib modules) so runs are attributable to a harness revision, and the audit turns the oracle-blindness + bookkeeping rules into measured compliance.
