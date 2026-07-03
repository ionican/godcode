---
name: godcode
description: General superior-responder harness — deliver ANY objective (code fix, code creation, question-answering) at verified-or-honest-decline quality. Fans out oracle-blind candidates and gates each OUT-OF-BAND against a real verifier: the repo's OWN existing suite when one exists (Path A), else a CONSTRUCTED decorrelated verifier that is CERTIFIED before use (Path B). Ships the single best verified answer by default (chosen by a deterministic objective proxy, never a model judge), or ranks the verified set into an ADVISORY slate for human selection on --slate, and drives a live HTTPS source-of-truth page throughout. Never false-greens.
argument-hint: <objective / bug / question / spec-path> [--repo <dir>] [--verify "<cmd>"] [--gate-only] [--n <wave=3>] [--max <draws=8>] [--base <ref>] [--slate]
allowed-tools: Read, Edit, Write, Glob, Grep, Bash, Agent, AskUserQuestion
---

`/godcode` is a **general superior-responder harness**: for any objective it fans out N independent **oracle-blind** candidates, gates each **out-of-band** against a *real* verifier, and either ships something **VERIFIED** or returns an **honest decline** — it **never** certifies a pass the real verifier didn't produce. It runs in one of two paths depending on whether a verifier already exists:

- **Path A — code-search** (a repo that already has a discriminating test suite): gate candidates against the repo's **own** suite; `triage` decides whether the N× was worth it. *(The original `/godcode`; unchanged below.)*
- **Path B — general objective** (a question, a from-scratch artifact, anything with **no** ready oracle): **construct** a verifier from a decorrelated source, **certify** it before use, then gate the candidates against it and **ship the single best verified answer** (chosen by a deterministic objective proxy) — or, with **`--slate`**, rank the verified set into an **advisory slate** for you to pick.

**The honest thesis (both paths):** the **gate is the universal value** — a binary, external, executable check that never false-greens. **Fan-out is selection, not manufacture** — it surfaces a correct candidate, the gate proves it. **Model-judged quality is untrustworthy** (a same-family judge shares the authors' blind spots), so any ranking is **advisory only** — the machine verifies, the **human selects**. Path B's one extra move: when no oracle exists you must **build** one *before* authoring, from a source **decorrelated** from the answers, and **certify** that it actually discriminates — certification can only *authorize* the verified tier or *downgrade* confidence, never manufacture trust.

The deterministic cores are in `.claude/lib/godcode/`: Path A = `harness.mjs` (`select`) + `triage.mjs`; Path B = `orchestrate.mjs` (`orchestrateObjective`) composing `construct → certify → gate → slate → dossier`, with two domain wrappers — `orchestrateProse` (prose-QA) and `orchestrateHtml` (interactive web pages). **This skill owns only the expensive, generative half — spawning the agents — and hands their artifacts to the deterministic code (D8).**

## Step 0 — Route, then (the ONE) clarification round

**Route by a single question: does a pre-existing external verifier already discriminate this objective?**
- **YES** — a repo with an existing suite the change must satisfy/keep-green → **Path A**.
- **NO** — a fresh question, a from-scratch artifact, no ready oracle → **Path B** (construct one first). *Never "gate against nothing" — if no verifier exists, build and certify one; don't skip the gate.*

**Phase 0 — the only human await.** Before spawning anything, ask **every** genuinely blocking clarification in **one** `AskUserQuestion` round (scope, acceptance criteria, constraints, target). This is the **only** point you wait on Richard. **After this there are NO more human awaits** — every later ambiguity is resolved autonomously by the **board of experts + adjudicator** with reference to the original request and these clarifications, and **every** such Decision is recorded in the dossier's decision ledger (`d.decide({...})`). Ask thoughtful questions now; you don't get a second round.

**ALWAYS make the LAST question of that round an open catch-all: "Is there anything else you want to add before we start?"** (one option — `"No, that's everything"` — and Richard uses the free-text *Other* to add anything the structured questions missed: extra context, a constraint, a preference, a gotcha, a reference). This is the only point he can volunteer something unprompted, so give him the slot. Fold whatever he adds into the recorded `clarifications` (and hence into what the agents see) exactly like the targeted answers. If this is the **single** clarification needed (a self-contained objective with nothing genuinely blocking), the catch-all may be the **only** question you ask.

**Auto-create the live status page immediately — every godcode run gets one.** The MOMENT you've parsed the objective (before the clarification round), `init` the dossier and give Richard the URL. It's the "one source of truth", served over HTTPS, refreshable; you drive it through the run with one-line **fire-and-forget** `dossier-cli` commands (deterministic code in a child process — never the main context, D9). Do NOT hand-write node scripts for this.

> **Working root — read first (portability).** This skill is symlinked into `~/.claude/skills/`, so `/godcode` may be invoked from **any** project's cwd. godcode's own deterministic code (`.claude/lib/godcode/`) and the live dossier (`_godcode/runs/`) live **in the vault**, never the current project — always resolve them against **`$VAULT`** (define it at the top of every shell; shell state does not persist between commands). The **target** codebase is separate and always passed via **`--repo`**. Hence every godcode `*.mjs` path below is `"$VAULT/.claude/lib/godcode/…"`, and `dossier-cli` is pinned to the vault via an absolute `--dir`.
```bash
VAULT="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Rick's World"
DC(){ local c="$1"; shift; node "$VAULT/.claude/lib/godcode/dossier-cli.mjs" "$c" --dir "$VAULT/_godcode/runs/$SLUG" "$@"; }   # absolute paths; zsh-safe (do NOT use $DC — zsh won't word-split it)
SLUG="<kebab-slug-of-objective>"
# create the page + show the user the link (prints the HTTPS URL):
URL=$(DC init --id "$SLUG" --objective "<one-line objective>" --request "$ARGUMENTS" --status clarifying \
   --milestones '[{"id":"m1","title":"Clarify"},{"id":"m2","title":"Construct + certify verifier"},{"id":"m3","title":"Fan-out + gate"},{"id":"m4","title":"Slate / ship"}]')
echo "$URL"
```
> **MANDATORY — surface the link the instant the page is first drafted.** `init` is the first draft (request + milestones, served over HTTPS immediately). As your VERY NEXT action, post the Tailscale **https://** URL to Richard in chat, before the clarification round and before any other work — e.g.:
> `📄 Live status (refresh anytime): https://codepandas-mac-studio.tailf809db.ts.net:8766/_godcode/runs/<slug>/`
> Always the `https://` tailnet URL `init` printed (never `http://`, never a local path). Don't bury it in a later summary — Richard watches from the start.

Then through the run (fire-and-forget; append `&` if you want it fully non-blocking):
```bash
DC start            --id "$SLUG" --milestone m2
DC discovery        --id "$SLUG" --text "constructed verifier CERTIFIED (factual-evidence-pass)"
DC clarify          --id "$SLUG" --json '[{"q":"<asked>","a":"<answer>"}]'      # after the one human round
DC decide           --id "$SLUG" --json '{"question":"…","options":["…"],"chosen":"…","rationale":"…","adjudicator":"board"}'
DC candidate        --id "$SLUG" --json '{"id":"author-1","angle":"minimal"}'
DC candidate-update --id "$SLUG" --candidate author-1 --json '{"verdict":"green","detail":"gate green","evidence":{"gate":"green"}}'
DC done             --id "$SLUG" --milestone m2
DC finish           --id "$SLUG" --json '{"decision":"shipped-slate","tier":"factual-evidence-pass","summary":"…","slate":[{"id":"author-1","note":"advisory #1 — VERIFIED"}],"caveats":["ranking is ADVISORY — you pick"]}'
```
**Path B** runs the deterministic `orchestrateProse` (below), which OPENS this same dossier dir (`_godcode/runs/<slug>`) and drives m2–m4 + candidates + finish in-process — so for Path B you only `init` (m1) here; the orchestrator does the rest. **Path A** drives the whole page via the `dossier-cli` commands above at each step. The page anchors the verbatim request, lists milestones, and records progress / discoveries / decisions / outcomes. URL: `https://codepandas-mac-studio.tailf809db.ts.net:8766/_godcode/runs/<slug>/`.

---

# PATH A — code-search (pre-existing verifier)

Gate **all three** before running; if any fails, do not run the harness:

1. **Real external verifier?** An **existing** suite that *discriminates* the task. If none → STOP (that's Path B, or offer a direct edit with **no** capability claim).
2. **Search-shaped?** Large verifiable space, insight reachable-but-rare. A one-liner/rename is not worth N× — edit inline.
3. **Blast radius** high enough that reliability beats latency? If it's latency-sensitive trivia, plain Opus is cheaper — say so.

Resolve (ask only what you can't detect): **`--repo`**, **`--verify`** (the discriminating command), **`--base`** (default `HEAD`), and the **task spec** (the only thing authors see). **`--gate-only`** skips fan-out — gate ONE candidate via `node "$VAULT/.claude/lib/godcode/gate.mjs" …` (set `VAULT` as in the Working-root note).

**Test runner** — the gate parses **TAP** (node:test; **vitest with `--reporter=tap-flat`**, NOT plain `tap` which mis-parses) or **TRX** (`dotnet test`). For a .NET repo (e.g. IMS), the verify test step is `reporter:'trx'` with `dotnet test --results-directory {{RESULTS_DIR}} --logger trx --nologo` (the gate substitutes a fresh per-attempt results dir and parses the `.trx` file; build break → `incomplete`, never a false green). Protect the test project path + `DEFAULT_PROTECTED_DOTNET`. *(IMS's strongest RTF/BU-Profit suites are Docker-MSSQL-gated — operational, not a code blocker for the gate itself.)*

### A1 — cohort
```bash
VAULT="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Rick's World"   # godcode's code lives in the vault, not <repo>
ROOT="$(mktemp -d)/gc-cohort"; mkdir -p "$ROOT"
BASE=$(git -C <repo> rev-parse <base|HEAD>)
```
### A2 — probe (always first; the 1× cost-saver)
Spawn **one** oracle-blind author into `$ROOT/author-0` (worktree at `$BASE`), then gate:
```bash
node "$VAULT/.claude/lib/godcode/harness.mjs" --json --repo <repo> --base "$BASE" \
  --candidates "$ROOT" --verify "<verify cmd>" --global-max <max=8> [--target-greens 1] [--protected a,b] [--provision node_modules] [--run-subdir src/Pkg]
```
If `decision: gate-only` (a VERIFIED green) → ship at 1×.
### A3 — escalate (only while `keepExploring: true`)
Spawn a wave of `--n` (default 3) oracle-blind authors **in parallel** (one message, multiple `Agent` calls), each a different angle (minimal / defensive / refactor-then-fix) but **never** leaking the verifier; re-run the same `harness.mjs` over `$ROOT` (re-gating prior candidates is free). Branch on the new contract: `fanned-out`→ship; `keepExploring:true`→another wave; `keepExploring:false`→decline.

**Sideways-look seed (wave 1 only).** I.i.d. oracle-blind authors CONVERGE — measuring dispersion on a monoculture just confirms it's a monoculture. So seed ONE author in wave 1 with a *deliberately different paradigm*. **Source the paradigm CROSS-MODEL, decorrelated from the Opus authors** — the same logic that makes the adversary/judge cross-model: Opus-sourced inspiration tends to surface the paradigms Opus would already reach, reinforcing the monoculture, so a DIFFERENT model is more likely to surface a genuinely *sideways* one.
- **Default: `/codex:research --background "<problem-class> — distinct algorithmic paradigms for solving it"`** (Codex/GPT-5.5 = the decorrelated source; returns cited facts + tradeoffs). Lighter-touch fallback: ONE `web_search_advanced_exa` on the same class query.
- **Query the CLASS, never the instance** ("how is interval-merging / dedup / rate-limiting typically solved", NOT the repo/bug/oracle) — feeding the instance risks the research surfacing the actual fix and puncturing oracle-blindness.
- **Distil the answer to ONE 1–2-line approach-only hint** (a paradigm NAME — streaming/single-pass, union-find, … — never the solution, expected output, or any test); do NOT paste the research dump into the prompt (over-specifies / drifts toward the fix). Fill the seeded author's `<angle>` slot with it.

The seeded author is gated identically; one seeded author + one research call per RUN, not per draw. It is the *proactive* complement to the *reactive* re-prompting that steers later waves away from already-green approaches.

**Dispersion-driven stop (held-out probes).** When you can cheaply manufacture held-out inputs (mutate the acceptance cases — boundary/off-by-one/null-a-field/reorder/duplicate), the multi-wave loop (`runner.mjs` `runWaves`) stops on a **coverage-deficit + plateau + cap** rule over the GREEN survivors' behavioural signatures (Good-Turing `f1/n`, a zero-new-signature wave, `≥K` distinct, and a hard reviewable-slate `reviewCap`) — held-out probes drive *when to stop drawing*, never *what verified or shipped*. Set `reviewCap` to your real reviewable-slate size (the cap is lib-enforced).
### A4 — ship contract (always honest)
Report `decision`, `regime`, `pSingle` (point+CI), `draws`, `greens/targetGreens`. Record each gated candidate on the status page (`DC candidate` / `DC candidate-update`) and close it with `DC finish` (decision/tier/summary/bestFailing) so the page reflects the final verdict.
- **VERIFIED** (`shipped` set): show `git -C <shipped.dir> diff "$BASE"`; offer a PR (worktree-only). State plainly the real suite passed out-of-band.
- **NO-GREEN** (`shipped: null`): honest decline; surface `bestFailing` labelled *"human gate required"*; read the regime (`too-hard` / `setupBroken` → fix the gate, don't author more / budget-hit).
### A5 — clean up
```bash
git -C <repo> worktree list --porcelain | awk '/^worktree /{print $2}' | grep "^$ROOT" | xargs -r -I{} git -C <repo> worktree remove --force {}
rm -rf "$ROOT"
```

**Path A oracle-blind author prompt** (verbatim per author, fill brackets):
> You are an autonomous coding agent fixing a real issue. Work ENTIRELY inside this git worktree (checked out at the base commit): `<$ROOT/author-k>`.
>
> TASK (the ONLY description you get — work out the implementation yourself): `<the task spec>`
>
> HARD RULES:
> - **ORACLE-BLIND**: do NOT read, open, grep, or reference ANY test file (`tests/`/`test/`/`__tests__/`, `*.test.*` / `*.spec.*`), CI config, or lockfile. Implement from the requirement and the SOURCE only. (The gate REJECTS a candidate that touches a test/CI/lockfile.)
> - Edit only SOURCE files. Read them first to learn the real types/helpers, then make minimal correct edits satisfying every part of the requirement. Keep it compiling.
> - `<optional: take the "<angle>" approach>`.
> - Do NOT run the suite or build; your edits on disk ARE your deliverable. Reply with a one-line summary.

---

# PATH B — general objective (construct + certify the verifier)

No oracle exists, so **build one before authoring**, from a source **decorrelated** from the answer cohort, and **certify** it discriminates. The whole deterministic chain (construct → certify → gate → slate → live dossier) is **code** — `orchestrateProse` in `.claude/lib/godcode/orchestrate-prose.mjs`. You only spawn the **generative** agents and hand their artifacts to it.

**The three decorrelated roles (the load-bearing rule).** A constructed verifier is only trustworthy if three generative steps are **pairwise distinct**: the **claim-author** (writes the checkable claims + an honest residual), a **separate adversary** (writes near-miss anti-candidates + a baseline-wrong "red" answer, **blind** to the claims), and the **answer-authors** (oracle-blind, blind to both). If any two collapse into one source, `certify` demotes the run to **advisory-slate** — no verified tier. Use different agents (and prefer a different *model* for the judge).

### B1 — Source the ground truth (decorrelated)
Establish the **source**: the correct answer/spec, derived **independently of the answer cohort** (a board agent reasoning from first principles, or a cited reference). This text is what the verifier is built from — never shown to the answer-authors.

### B2 — Requirements (board)
Decompose the objective into a small set of **requirements** `[{id, text}]` — the things any correct answer must satisfy. Record the decomposition decision in the dossier ledger.

### B3 — Construct the verifier (TWO decorrelated agents, in parallel)
Spawn the **claim-author** and the **adversary** as separate `Agent` calls (one message). Their outputs are written to the run dir:
- `claims.json` — `{ claims:[…], residual:"…" }`. Each claim is `{ id (globally unique, e.g. `c1`), requirementId, kind, <kind-fields> }` — both `id` and `requirementId` are required, and anti-candidates likewise carry their own unique `id`. Claim kinds (fields are EXACT — the validator rejects wrong/missing field names): `must-include {text}`, `must-exclude {text}`, `grounded {quote}`, `number-matches {value}` — where `quote`/`value` are **short verbatim strings that must appear in BOTH the source and the answer** (source-anchored) — and the **scoped** `near` / `not-near` `{anchor, token, window?}` (answer-structure proximity, NOT source-anchored). Prefer scoped checks to avoid false-negativing a correct aside.
- `adversary.json` — `{ antiCandidates:[{id, requirementId, answer}], redAnswer:"…" }` (one anti per requirement; each a *near-miss* that must FAIL). **Each anti-candidate must be a COMPLETE answer that is CORRECT on every OTHER requirement and wrong on ONLY its one target requirement** — not a terse fragment. (`certify` demands a *clean* per-requirement kill: the anti must fail ≥1 of its own requirement's checks and **none** of any other requirement's — a sparse fragment that omits other requirements' content fails many checks at once, "bleeds" across requirements, and the certifier rejects the kill → the whole run demotes to `advisory-only`.)

### B3.5 — Bleed lint (advisory pre-flight + at-most-one re-author)
Before paying for the expensive out-of-band certify, `orchestrateProse` runs a **deterministic pre-certify lint** (`bleed-lint.mjs`) at the construct→certify seam. It predicts the four CLAIM-LEVEL certify conjuncts — structural validity, three-way decorrelation, the red baseline going red, and **every anti-candidate being cleanly killed** — from the raw strings, reusing the **exact** emitted predicate (`evaluateClaim`, the single source of truth the oracle runs). It emits **mechanical** feedback: which check `BLEED`s into a foreign requirement, which check is `BRITTLE` (fails even on the source → will reject correct answers), and whether the red baseline is `NON-DISCRIMINATION`. It is **strictly advisory** — `wouldCertify` is a PREDICTION, never a certificate; the real certify still runs by default.

**At-most-one re-author loop (the value).** Pass `lintShortCircuit: true` to `orchestrateProse` to make it return `decision:'needs-reauthor'` (BEFORE certify) when the verifier provably won't certify for a **claim-author-fixable** reason (a bleeding / non-discriminating check, or a red baseline that doesn't go red). On `needs-reauthor`, **re-spawn the BLIND claim-author ONCE** with `result.lintReport.reauthorFeedback` appended to its prompt — **`adversary.json` + `redAnswer` + `source` stay BYTE-FIXED** (so the comparison is stable and the claim-author never sees the adversary's reasoning) — regenerate `claims.json`, and re-run `orchestrateProse` a single time. Cap at **one** re-author pass (hard max two), then proceed to the real certify regardless. Decorrelation / missing-anti / structural failures are NOT claim-author-fixable, so they never trigger a re-author.

### B4 — Fan out the answers (oracle-blind)
Spawn `--n` (default 3) **answer-authors** in parallel (different angles, never the verifier) → `answer-1.txt … answer-N.txt`.

### B5 — Judge (cross-model, decorrelated)
Spawn a **judge** — prefer a **different model family** (e.g. `codex exec`) — to produce pairwise verdicts over the answers → `verdicts.json` = `{ pairs:[{a, b, winner}], rationale }`. Objective = **best OUTCOME** (most correct, complete, **insightful** substance — the "gold dust"); **verbosity is trimmable, never a demerit** (D10).

### B6 — Run the deterministic pipeline (one child process — D8/D9)
Write a tiny driver in the scratchpad and run it. It reads the agent artifacts, runs `orchestrateProse` (construct → certify → gate every answer → slate), and drives the live dossier — all deterministic, off the main context:
```js
// driver.mjs  — run with: node driver.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { orchestrateProse, defaultProseProxies } from '<vault>/.claude/lib/godcode/orchestrate-prose.mjs';
const RUN = '<run-dir>';                                    // where the agent artifacts live
const j = (f) => JSON.parse(readFileSync(path.join(RUN, f), 'utf8'));
const claims = j('claims.json'), adv = j('adversary.json');
const answers = [1,2,3].map((i) => ({ id:`author-${i}`, text: readFileSync(path.join(RUN,`answer-${i}.txt`),'utf8').trim() }));
const verdicts = j('verdicts.json');                        // {pairs, rationale}
const r = await orchestrateProse({
  dossierDir: '<vault>/_godcode/runs/<slug>', dossierVaultRelDir: '_godcode/runs/<slug>', dossierId: '<slug>',
  objective: '<one-line objective>', request: '/godcode "<original request>"',
  task: '<the question/spec the answer-authors saw>', source: '<decorrelated ground truth>',
  requirements: [{ id:'r-1', text:'…' }],
  clarifications: [{ q:'…', a:'…' }],                       // from Phase 0
  decisions: [{ question:'…', options:['…'], chosen:'…', rationale:'…', adjudicator:'board' }],
  claims: claims.claims, residual: claims.residual,
  antiCandidates: adv.antiCandidates, redAnswer: adv.redAnswer,
  answers, verdicts, proxies: defaultProseProxies(),
  slate: false,                                             // DEFAULT single-best; set true only on --slate (opt-in diversity slate)
  claimAuthor: 'claim-agent', adversary: 'adversary-agent', answerAuthor: 'answer-agents', judgeProvenance: 'codex-judge',
});
console.log(JSON.stringify(r, null, 2));                    // {certified, tier, decision, pick, pickBy, flags, slate, admitted, dossierUrl, …}
```

### B7 — Report (always honest)
Surface the dossier URL and the structured result. **The DEFAULT is single-best** — ship the one verified-correct answer; **`--slate` is the opt-in diversity mode** (rank the verified set for you to pick). Correctness is binary and settled by the certified gate, so the *default* single answer needs no "you pick" caveat; the slate's advisory framing is reserved for the opt-in case where a **quality residue beyond correctness** is what differs.
- **`decision: shipped-single`** (DEFAULT) — the certified floor admitted ≥1 answer; ship **`pick`** (the single best). `pickBy:'objective-proxy'` = it ranked first on the declared objective proxy (named in the summary); `pickBy:'sole-candidate'` = it was the only admit. Correctness is VERIFIED; the choice among equally-correct candidates is a **deterministic objective proxy, not a model judgement** — present it as the shipped answer, not "advisory".
- **`decision: shipped-single-tiebroken`** (DEFAULT) — ≥2 verified candidates were **objectively equivalent** under the proxy (`pickBy:'tie-break'`, flag `proxy-non-discriminating` or `proxy-unmeasurable`); shipped by deterministic id tie-break, **NOT** measured superiority. Surface the caveat verbatim and offer **`--slate`** to compare. If `dispersionMeasurable === false` (flag `dispersion-unmeasurable`), say the acceptance floor can't tell the verified candidates apart (all-pass monoculture) — that's *why* single-best is the honest output, NOT "converged".
- **Dispersion (`dispersionState`, both single-best decisions)** — if you supplied `o.discriminatingProbes`: `diverse` (flag `behaviourally-diverse`) = the verified answers genuinely DIFFER on the held-out probes → surface the "consider `--slate`" caveat; `converged` (flag `behaviourally-converged`) = NO measured diversity *on the supplied probes* (they may still differ on properties no probe tested — don't claim broad equivalence). With no probes it stays `unmeasurable`. **Probes only label diversity — they never change what was verified or shipped.**
- **`decision: shipped-slate`** (OPT-IN, `--slate`) — present the **advisory slate** (ordered, each candidate's earned tier) and say plainly: *candidates VERIFIED out-of-band against a certified floor; the RANKING is advisory — you pick.* Never announce a "winner".
- **`decision: no-verified`** — certified floor, zero passes → honest decline; surface `bestFailing`. The decline is trustworthy (the floor discriminated).
- **`decision: advisory-only`** — the constructed verifier **failed certification** → **nothing is verified**; present an advisory-only order and say there is no correctness guarantee; recommend reconstructing from a cleaner decorrelated source.

### Path B agent prompts (fill brackets; one message, parallel where independent)

**Claim-author** (writes the verifier's checks):
> You author a MACHINE verifier for a task. You will NOT answer the task. Given the REQUIREMENTS and the SOURCE (ground truth), output JSON `{ "claims":[…], "residual":"…" }`. Each claim is a string-checkable test on a candidate answer and is an object `{ "id":"<globally-unique e.g. c1>", "requirementId":"<r-x>", "kind":"<kind>", <kind-fields> }` — the `id` (unique per claim) AND `requirementId` are BOTH required (a claim with no `id` is rejected). Kinds (use these EXACT field names): `must-include {text}`, `must-exclude {text}`, `near {anchor, token, window}` (token must appear within `window` chars of anchor), `not-near {anchor, token, window}` (reject token only when adjacent to anchor — use this instead of a blunt `must-exclude` so a correct *aside* isn't false-negatived), `grounded {quote}` (a SHORT verbatim string that must appear in BOTH the source and the answer), `number-matches {value}` (the number as a STRING — e.g. `"0.30000000000000004"` — that must appear in BOTH the source and the answer). Every requirement needs ≥1 claim. **CALIBRATION (avoid false-negativing correct answers):** keep checks ROBUST — anchor `near`/`not-near` only on CORE terms any correct answer must use; NEVER require a specific optional adjective (e.g. the literal word "deterministic") that a correct answer could omit or phrase differently. For a "it is NOT X" requirement, prefer a `not-near` that REJECTS the wrong framing over a `near` that DEMANDS a particular right word. Prefer a few strong checks over many brittle ones. **A brittle check is doubly harmful**: a `grounded`/`near` anchored on a SPECIFIC PHRASING a correct answer might write differently (e.g. `grounded "one ULP apart"` when an answer says "one unit in the last place apart") both false-negatives correct answers AND **bleeds** — `certify` rejects ANY anti-candidate that trips ANOTHER requirement's check, so one over-specific check makes complete near-misses (correct on that requirement, phrased differently) spuriously fail it, sinking the clean-kill of OTHER requirements too. So: anchor `grounded`/`near` only on tokens any correct answer is FORCED to use; for everything else prefer `must-exclude`/`not-near` of WRONG-framing vocabulary (bleed-safe). If you are given BLEED / BRITTLE / NON-DISCRIMINATION diagnostics from a prior pass, re-author the NAMED checks to remove the foreign-requirement bleed / brittleness / non-discrimination WITHOUT weakening coverage — you will NOT be shown the anti-candidates or the adversary's reasoning; work only from the mechanical checkId/requirement diagnostics. `residual` states HONESTLY what these checks do NOT verify. Output JSON only.

**Adversary** (proves the verifier discriminates — BLIND to the claims):
> You are the adversary for a constructed verifier. You have the REQUIREMENTS and SOURCE but NOT the verifier's claims. Output JSON `{ "antiCandidates":[{"id","requirementId","answer"}], "redAnswer":"…" }`. Write exactly ONE anti-candidate per requirement. **Each anti-candidate must be a COMPLETE, full-length answer that is CORRECT on every OTHER requirement and wrong on ONLY its one target requirement** — write the whole correct answer, then break exactly that requirement (e.g. for the value requirement: a complete, well-written answer that states a subtly WRONG exact value). Do NOT write a one-sentence fragment — a sparse anti that omits the other requirements' content will fail many checks at once and be rejected as a "bleeding" (non-isolated) kill, which sinks the whole run to advisory-only. `redAnswer` is a clearly-wrong baseline answer that fails multiple requirements. Your job: try to slip wrong answers past a verifier with the most plausible single-fault near-misses you can. Output JSON only.

**Answer-author** (oracle-blind, `--n` in parallel, different angles):
> Answer the following objective as well as you possibly can — most correct, complete, and INSIGHTFUL. Do NOT optimize for brevity; substance wins (verbosity is trimmable later). You may NOT see or reference any verifier, test, or grading rubric — answer from the requirement only. `<optional: take the "<angle>" approach>`. OBJECTIVE: `<task>`. Reply with ONLY the answer text.

**Judge** (cross-model; pairwise; objective = substance):
> Compare these candidate answers to the OBJECTIVE pairwise. For each pair output the better answer by best OUTCOME — most correct, complete, and insightful. Do NOT penalize verbosity (it is trimmable); reward substance and insight. Output JSON `{ "pairs":[{"a","b","winner"}], "rationale":"…" }` where winner is an answer id or `"tie"`. JSON only.

### Path B domains — prose vs HTML/interactive (same emit-TAP shim)

The constructed verifier is a TAP-emitter installed via `oracleFiles`; the domain only changes how it MEASURES a candidate. Two adapters exist:

- **Prose / question-answering** — `prose-verifier.mjs`: claims are string checks over the answer text (above). Candidate = `answer.txt`.
- **HTML / interactive artifact** — `html-verifier.mjs` (`emitHtmlVerifier(checks)`): the emitted `html-verify.mjs` drives a REAL headless browser (the `agent-browser` CLI) to MEASURE a candidate page and emits TAP. Candidate = `index.html`; the verify command is `node html-verify.mjs <candidate.html>`. Check kinds: `dom-exists {selector}`, `dom-count {selector, op, n}`, `text-equals`/`text-includes {selector, text}`, `attr-equals {selector, attr, value}`, `after {actions:[{type:click|press|type|wait, …}], then:<check>}` (interactive behaviour, reload-isolated), and `prop-true {expr, trusted:true}` (page-trusted escape hatch — avoid for structural facts). The claim-author writes `checks`; the adversary writes broken-HTML anti-candidates + a red page. The verifier is **fail-closed** (atomic native-primitive measurement defeats instance/prototype DOM-spoofing; failed open/reload/action ⇒ closed). Honest residual: measurement runs in the page realm, so a *fully* adversarial page that also spoofs `Function.prototype.toString` is the irreducible limit of this transport — mitigated (as elsewhere in the harness) by oracle-blind authoring; a CDP/isolated-world transport is the logged fix. **agent-browser is a shared session; gate HTML candidates sequentially.** (The B3.5 pre-certify bleed-lint is **prose-only**: HTML checks have no pure in-process predicate — they need a real browser snapshot — so the HTML adapter exposes no `bleedLint` hook and HTML bleed is caught only by the full certify.) Everything downstream (certify → gate → slate → dossier) is identical to prose — and the **whole loop is INVOCABLE via `orchestrateHtml`** (`orchestrate-html.mjs`), same call shape as `orchestrateProse` but the artifacts are HTML-shaped:
```js
import { orchestrateHtml } from '<vault>/.claude/lib/godcode/orchestrate-html.mjs';
const r = await orchestrateHtml({
  dossierDir, dossierVaultRelDir, dossierId, objective, request, task, source /* the spec */, requirements,
  clarifications, decisions,
  checks,                                              // claim-author output (html-verifier check kinds)
  residual,                                            // what the checks do NOT verify
  antiCandidates,                                      // adversary: [{ id, requirementId, html }]  (broken pages)
  redAnswer,                                           // adversary: a baseline-wrong HTML page
  answers,                                             // oracle-blind: [{ id, html, angle? }]  (each an index.html)
  verdicts, claimAuthor, adversary, answerAuthor, judgeProvenance,
});                                                    // → { certified, tier:'constructed-floor-pass', decision, slate, admitted, dossierUrl }
```
Both `orchestrateProse` and `orchestrateHtml` are thin wrappers over the SAME pipeline (`orchestrate.mjs` `orchestrateObjective`) — every honesty invariant (certify-before-trust, three-way decorrelation, advisory-only slate, no-false-green) is shared. An HTML page that won't load or tampers its measurement surface BAILS (gate `incomplete`) — it can never fake a check failure, so it can't falsely certify or be admitted.

---

## Invariants (do not weaken — both paths)

- **Never claim VERIFIED without a real green.** Path A: a `shipped` green from `harness.mjs`. Path B: a `gate==='green'` against a **CERTIFIED** floor. An uncertified Path-B verifier ⇒ `advisory-only` ⇒ **nothing verified**. No exceptions — the gate is the whole point.
- **Construct-then-certify, never teach-the-gate.** A Path-B verifier is built as a TAP-emitter installed via `oracleFiles` and certified out-of-band; touch ZERO gate code. The certificate can only authorize or downgrade.
- **Three-way decorrelation.** claim-author, adversary, and answer-author must be pairwise-distinct generative steps (prefer a different model for the judge), else `certify` demotes to advisory-slate.
- **Authors/answerers are oracle-blind** — they never see the verifier.
- **The orchestrating session is oracle-blind too** — never Read/Grep/cat the target repo's test files, CI config, or lockfiles during a run (spec composition and red diagnosis included); work from gate evidence (failing test names + assertion messages) only. (2026-07-02 versus bench: author-blindness held while the orchestrator read tests in 4/7 runs — a leak path into wave briefs; closed.)
- **Default = single best; the ranked slate is OPT-IN (`--slate`).** Correctness is binary and settled by the certified gate, so the default ships the ONE verified answer, choosing among equally-correct candidates by a **deterministic objective proxy — never the model judge** (a model's quality opinion can never auto-ship "the best"). A non-discriminating proxy ⇒ `shipped-single-tiebroken` by deterministic id, flagged honestly. The slate is for the diversity case where a **quality residue beyond correctness** differs.
- **When the slate IS shown (`--slate`), its ranking is ADVISORY, never authoritative.** The slate is ordered + `selectBy:'human'`; there is no `winner`/`best` field. The objective rewards substance/insight (D10) — verbosity is never a demerit.
- **Dispersion is a LABEL, never a gate.** Admitted answers pass every floor check ⇒ all-pass monoculture ⇒ with NO probes dispersion is **unmeasurable** (`dispersionMeasurable:false`), reported as such — NEVER "converged". **Held-out discriminating probes** (`o.discriminatingProbes`, optional) measure real diversity: claim/check-shaped checks NOT in the acceptance set, run **measurement-only** over the admitted answers → `dispersionState` of `converged` (admits identical on the probes — single-best is safe) or `diverse` (admits differ → `behaviourally-diverse` flag nudges toward `--slate`). **HARD INVARIANT: a probe NEVER enters admission and NEVER changes the pick/order/tier** — it can only move the dispersion label. Probe ids are validated disjoint from the acceptance check ids. Prose runs probes in-process (`evaluateClaim`); HTML has no runner yet (needs a browser snapshot → stays unmeasurable). **Path A has the same mechanism** — `fanoutSelect`'s opt-in `mutationProbes` + `runProbes` (held-out inputs manufactured by mutating the acceptance inputs — boundary/off-by-one/null-a-field/reorder/duplicate via `generateMutationProbes`) run MEASUREMENT-ONLY over the GREEN survivors and attach a `mutationDispersion` label, validated disjoint from the gate test names; same invariant — a green that "fails" a held-out input is still verified, the probe never prunes or re-picks.
- **Worktrees only** — candidates and any eventual PR live in worktrees; the primary clone stays clean.
- **Live HTTPS source-of-truth, surfaced on first draft** — `init` the dossier and hand Richard its **`https://` Tailscale URL as your first action**, the moment the page is drafted (before clarification / any work); never bury it in a later summary, never give a local path or `http://`. The dossier (`RunDossier`) is then updated by deterministic code in a child process (fire-and-forget), never the main context; colour-blind output (label/symbol, never colour alone: `✓ VERIFIED` / `✗ NO-GREEN` / `? ADVISORY`).
- **The bleed-lint (B3.5) is ADVISORY ONLY.** `wouldCertify` is a PREDICTION, never a certificate; `blocking` is always false; the real `certifyVerifier` runs unconditionally (after at most one blind re-author pass). The lint reuses the exact emitted oracle predicate (`evaluateClaim`) as single source of truth — it never edits claims directly (only the blind claim-author re-authors), never admits a candidate, and never lets a verifier skip the gate. Prose-only: HTML bleed has no pure in-process predicate and stays caught by the expensive certify.
- Reference: `.claude/lib/godcode/README.md`. Project: [[godcode — God-Mode Coding Harness]].
