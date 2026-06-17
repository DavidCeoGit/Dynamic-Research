# S136 Pipeline Bug-Fix — MERGE/DESIGN Gate Peer Review Synthesis

**Artifact reviewed:** `Documentation/s136-studio-poll-source-import-design-gate.md` (v1 → v2 → v3).
**Gate:** DESIGN (pipeline architecture) + MERGE (skill + worker code). **Risk:** AGENT BEHAVIOR + ARCHITECTURE. **Severity:** NORMAL.
**Topology:** Sequential — Gemini holistic-adversarial (v1) → integrate (v2) → Codex grounded-adversarial (v2) → integrate (v3). Reviewer order per `~/CLAUDE.md` HARD RULE.
**Date:** 2026-06-16 (S136).

## What each reviewer saw
- **Gemini (holistic-adversarial):** the full v1 design doc + 4 source excerpts embedded inline (poll block, executor coverage-boundary + cap-kill, studio-completeness resolution, Perplexity research/source-add). No live file access (reasoned from the packet). Model: gemini-cli 0.43.0 default.
- **Codex (grounded-adversarial):** the v2 design doc on disk + the ACTUAL shipped files (`agent/executor.ts`, `agent/lib/studio-completeness.ts`, `~/.claude/commands/research-compare.md`) read in its `-s workspace-write` sandbox, plus web research against the Perplexity MCP / Sonar API. Ran PowerShell counterexamples. ~322k tokens.

## Verdicts
Both **BLOCK** on v1/v2 respectively. v3 resolves every finding into an implementation spec. No reviewer disagreement; Codex's grounded pass *overturned* one Gemini answer (Q3, Perplexity MCP shape) — recorded below.

## Findings ledger
| # | Reviewer | Sev | Finding | Resolution in v3 |
|---|---|---|---|---|
| C-1 | Gemini | CRITICAL | Layer 1 newest-completed-≥-floor has an intra-run v2-regen race (completed v1 satisfies floor, aborts wait for still-rendering v2) | Superseded by v3 snapshot-diff (per-attempt id) |
| C-2 | Gemini | CRITICAL | Layer 2 cost-cap bypass — `killAttempted` shared boolean; cost-killed rogue job could be marked success | v3 `killReason` enum; DURATION-only recovery; cost stays fail-fast |
| C-3 | Gemini | MAJOR | Prong B (NLM discovered-source harvest) infeasible — CLI exposes no machine-readable discovered sources → would induce CLI hallucination | Prong B DROPPED |
| K-1 | Codex | CRITICAL | Prong A unsound — official `@perplexity-ai/mcp-server` flattens citations into response TEXT, does NOT expose `citations[]`/`search_results[].url` to the prompt (overturns Gemini Q3) | v3 Prong A: write full `structuredContent.response`, parse appended citation text, WARN on zero |
| K-2 | Codex | CRITICAL | Layer 1 "newest after submit" unsafe — NLM CLI does not sort `artifact list` (API order); floor too weak | v3 snapshot-diff (before/after id set, exactly-one-new) |
| K-3 | Codex | MAJOR | Stronger alias algorithm needed (snapshot/diff, ambiguity → fail closed, include pending; persist to state.artifacts the backstop reads) | Adopted verbatim as v3 Layer 1 |
| K-4 | Codex | MAJOR | Layer 2 not merge-ready — `waitForProcess` returns only a number; nonzero-exit branch precedes completeness; must classify terminal errors before duration recovery | v3 `waitForProcess→{code,killReason}`; terminal-class-first; pure helper |
| K-5 | Codex | MAJOR | Cost-bypass test not wireable — private helpers/import-time const | v3 extracts pure `shouldRecoverAfterDurationKill()` for unit test |
| K-6 | Codex | MAJOR | Layer 1 must cover all 5 products (slides=`slide-deck`), not just video | v3 makes per-product uniform explicit |
| K-7 | Codex | MINOR | `completed_artifact_ids` must return a sentinel (`null`), not `{}`, on list error | v3 mirrors worker's `null` pattern |

## Implementation risk ranking (for execution scoping)
1. **Layer 2 (worker `executor.ts`)** — surgical + UNIT-TESTABLE via the pure `shouldRecoverAfterDurationKill` helper; directly converts the run-3 cap-fail-loss into a recovered success. Touches cost-safety control flow → must keep cost + terminal kills fail-fast (asserted by test). **Highest value, moderate blast radius, testable.**
2. **Prong A-lite (skill)** — write full MCP response + WARN on zero URLs. Low risk; modest value (Prong C/`additionalUrls` is the real source lever).
3. **List-error sentinel (skill)** — trivial, low risk.
4. **Layer 1 snapshot-diff (skill, `research-compare.md` poll block)** — UNTESTED surface; the snapshot-diff is non-trivial and ships into an unattended run. **Highest implementation risk.** Layer 2 is a safety net for the same failure, so Layer 1 can follow with care.

## Scoping recommendation
Ship **Layer 2 + Prong A-lite + sentinel** first (testable / low-risk, and Layer 2 alone prevents run-3's artifact loss). Run the comparison via **Prong C (`additionalUrls`)** for source richness — no code. Stage **Layer 1 snapshot-diff** as a careful follow-up (it's the riskiest surface and Layer 2 backstops the same failure).

Raw reviewer outputs: `c:/tmp/s136-gemini-out.txt`, `c:/tmp/s136-codex-out.log`.
