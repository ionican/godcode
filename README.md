# godcode

An attempt to provide Fable-level responses from lesser models: `/godcode` (single-agent) and `/super-godcode` (orchestrated multi-author) Claude Code skills, plus the deterministic library they stand on.

**Runtime home is the Obsidian vault** (`.claude/lib/godcode/`, `.claude/skills/{godcode,super-godcode}/`) — skills load from there. This repo is the versioned mirror: branch-diff adversarial review, the codex push gate, and history live here. Sync direction is vault → repo.

## Layout

| Path | Contents |
|---|---|
| `skills/godcode/SKILL.md` | Single-agent harness: paths A/B/D, evidence gates, honesty invariants |
| `skills/super-godcode/SKILL.md` | Orchestrated harness: fan-out authors, blind gate, certify, U1–U8 upgrades |
| `lib/` | Deterministic modules (node, zero deps) — each `x.mjs` pairs with `x.test.mjs` |
| `lib/benchmark/` | The versus bench: item bank, runner, blind scorer, judge |

Key lib modules: `gate-runner` (candidate gating), `certify` (final verification), `ledger` (U8 run ledger, harnessRev stamping), `audit-run` (transcript compliance audit — oracle-blindness enforcement), `dossier` (run bookkeeping).

## Tests

```sh
cd lib && node --test *.test.mjs
```

Note: `gate-runner.test.mjs` "HANG → retryable" is timing-sensitive and can fail under full-suite load; it is green in isolation.

## Improvement loop

The harness improves the way it makes code improve: runs write a ledger stamped with `harnessRev` (sha256 of both SKILL.md files), a deterministic auditor checks compliance, retros mine the ledger into pre-registered hypotheses, A/B arms test them on the bench, and a fold gate ships only non-regressing measured wins. Graders (gate-runner, certify, bench scorer) are fenced — the loop can never edit them.
