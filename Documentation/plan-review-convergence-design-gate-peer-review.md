# Plan-Review Convergence Design — DESIGN-gate peer review

**Session:** S84 (2026-06-03 UTC)
**Artifact under review:** `Documentation/plan-review-convergence-design-gate.md`
**MRPF:** DESIGN gate × AGENT BEHAVIOR × NORMAL. Topology: sequential Gemini → integrate → Codex → integrate (HARD RULE). Reviewer order honored.
**Outcome:** DESIGN gate **CLOSED at v3.** Both reviewers APPROVE the core ladder. Implementation is a follow-on MERGE-gate chunk.

## What each reviewer saw
- **Gemini (gemini-3.1-pro-preview, 18,437 tok, ~22s):** v1 design doc only (diff/doc-only). No code access.
- **Codex (`codex exec -s read-only`, 185,353 tok):** v2 design doc + **read the actual code** (`plan-reviewer.ts`, `plan-types.ts`, `executor.ts`, `notify.ts`, `PlanReviewBanner.tsx`, the gate migration) to verify the design's code claims.

## Round 1 — Gemini (v1 → APPROVE-WITH-CHANGES)
| # | Finding | Disposition |
|---|---|---|
| [MAJOR] | Unbounded divergence: R4 should bound unresolved MAJORs (lax reviewer + 6 MAJORs shouldn't proceed) | **ACCEPTED** → added R4 volume bound `MAX_RESERVATION_MAJORS=2` (block at 3+) |
| [MINOR] Q1 | Hard-block `source-strategy` MAJOR (flawed source strategy burns budget) | **REJECTED** — would re-break e18e1931 (its terminal blockers were source-strategy + scoring-rubric MAJORs); documented in §6. Covered by R4 volume bound + the requirement that the other reviewer independently approved |
| [MINOR] Q5 | Telemetry: ship a JSONB dashboard query for R5 trigger-rate | **ACCEPTED** → §5a |
| [NIT] | Distinguish one-reviewer-down APPROVED from R5 override in telemetry | **ACCEPTED** → §5a |
| Q2 | Reuse `APPROVED` (no migration) | Confirmed author's lean |
| Q3 | Yes, bound MAJORs | → R4 |
| Q4 | Defer semantic convergence-detection | Confirmed → §8 |

## Round 2 — Codex (v2, code-grounded → APPROVE-WITH-CHANGES)
| # | Finding | Disposition |
|---|---|---|
| [MAJOR-1] | One-reviewer-down + approve-like hits the **early-exit (line 753)** → plain APPROVED *before* the ladder; v1/v2 "R5 with reservations" claim was wrong | **ACCEPTED** → §6 edge-case-1 corrected: reservations only arise when BOTH reviewers available and split |
| [MAJOR-2] | "Never silent" unmet: executor maps APPROVED→approved with **no email**; `sendPlanReviewEmail` rejects APPROVED; UI hides approved. Reservations field would be recorded but never surfaced | **ACCEPTED** → new §5b mandates surfacing path (persist to terminal record + advisory completion-email; UI deferred) |
| [MINOR] | Count R4 from **final-round in-memory `availableCalls`**, not cumulative `calls`/DB rows (also dodges double-persist double-count) | **ACCEPTED** → new §6.5 + test |
| [NIT] | R1–R4 hard-block only in enforcement mode; `finalize()` forces APPROVED in shadow — ladder must still compute+log decision | **ACCEPTED** → §6 edge-case-5 |

**Codex answers:** (1) ladder implementable replacing only the `round===maxRounds` branch; early-exit + S64 preserved. (2) concurs rejecting source-strategy hard-block. (2b) `plan-ambition` can't exist on UNAVAILABLE calls; no double-count if counted in-memory. (3) reuse-APPROVED avoids the DB CHECK migration; but downstream ignores reservations without the §5b wiring. (4) `>2` boundary correct for e18e1931's 2 MAJORs; add 2-vs-3 tests. (5) preserve pre-terminal hard gates (BLOCK/cost-cap/timeout/both-unavailable/S64).

## Synthesis
Both reviewers independently APPROVE the core design: a severity-graded terminal ladder that imports the human MRPF Disagreement Procedure into the automated gate (CRITICAL + anti-bypass + both-reject + MAJOR-volume all hard-block; otherwise proceed-with-reservations when one reviewer approves). Gemini hardened it against the lax-reviewer failure mode (volume bound); Codex's code-grounded pass caught two implementation-completeness gaps (early-exit interaction, non-silent surfacing) that materially shaped v3 but did not challenge the approach. No disagreement requiring the MRPF disagreement procedure. **Loop closed at v3.**

## Resolution
DESIGN approved. Proceed to a **MERGE-gate implementation chunk** (next session): edit `plan-reviewer.ts` (`decideTerminal()` + `MAX_RESERVATION_MAJORS`), `plan-types.ts` (`reservations?`/`terminal_decision?`), `executor.ts` + `notify.ts` (§5b surfacing), tests (§9). Dark-launch first (compute+log in shadow per §6.5) to measure R5 trigger-rate before enforcement. Implementation code gets its own Gemini→Codex MERGE review.
