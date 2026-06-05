# Plan-Review R2 Refinement — MERGE-gate Peer Review (companion)

**Change under review:** `isAntiBypassFinding()` helper narrows the anti-bypass
predicate to MAJOR+ at 4 sites in `agent/lib/plan-reviewer.ts` (decideTerminal R2 +
3 `ensurePersonaDepthFinding` injection guards) + 8 new tests.
**Gate:** MERGE × AGENT BEHAVIOR × NORMAL. **Topology:** sequential Gemini → Codex.
**Session:** S86 (2026-06-03 UTC). **Outcome:** **CLOSED — both APPROVE.**
Implements the DESIGN gate `plan-review-r2-refinement-design-gate.md` (v3).

## Tests covered? (MRPF AGENT-BEHAVIOR mandatory question)
**Yes.** 24/24 node:test pass (`pnpm -C agent exec node --import=tsx --test
test/plan-reviewer-convergence.test.ts`): 16 pre-existing S85 + 8 new. The 8 new:
5 `decideTerminal` R2-refinement boundary cases (MAJOR→R2, CRITICAL→R1, MINOR→R5
with reservation, MINOR+3 MAJOR→R4, residual MINOR→R3), 1 transparency case, and
2 `reviewPlan` guard-regression cases (deficient + null persona score with organic
MINOR plan-ambition → MAJOR injected → terminal R2 = bypass closed). `pnpm test`
(grep guard + tsc agent + tsc frontend) also GREEN.

## What each reviewer saw
- **Gemini (round 1, holistic):** the `git diff` of `plan-reviewer.ts` + test file
  pasted into the prompt + design context.
- **Codex (round 2, code-grounded, `codex exec -s read-only`):** read the promoted
  live `agent/lib/plan-reviewer.ts` and `agent/test/plan-reviewer-convergence.test.ts`
  directly and walked the full control-flow trace.

## Gemini — APPROVE (3 MINOR, all confirming; no required changes)
1. [MINOR] `isAntiBypassFinding` extraction is a clean single source of truth across
   the 4 sites, neutralizing the drift risk Codex flagged at the design gate.
2. [MINOR] Test coverage comprehensive and precise; guard-regression tests lock the
   exact boundary where the bypass could reappear.
3. [MINOR] `adjustVerdictForAmbition` correctly left severity-agnostic — preserves
   MINOR-ambition visibility via the ladder (no silent `allApprove` early-exit loss).
   No risk of silently changing convergence for unrelated findings.

## Codex — APPROVE (0 findings; full code-grounded verification)
1. Bypass closed: helper matches `origin === "plan-ambition"` && MAJOR|CRITICAL
   (`plan-reviewer.ts:396-400`).
2. All four production sites use it: `:298` (low-score guard), `:334` (null-score
   guard), `:346` (hedge guard), `:441` (terminal R2).
3. `adjustVerdictForAmbition` (`:372`) intentionally still severity-agnostic — only
   downgrades approve-like verdicts before terminal routing; R2 stays MAJOR+ scoped.
4. Deficient-persona + organic-MINOR trace is safe: MINOR fails the helper → MAJOR
   injected → approve-like rewritten (`:631/:736`) → all-approve fast-path avoided
   (`:848-857`) → R2 blocks (`:449-450`). No path where a persona-deficient plan
   reaches R5.
5. Guard-regression tests assert `terminal_decision === "R2"` (`test:587-610`,
   `:613-634`); R2-refinement cases cover all rungs (`test:290-364`).
6. The 16 S85 tests remain compatible (old R2 uses MAJOR `plan-ambition`,
   `test:208-215`; unchanged ladder behavior elsewhere).

## Synthesis & disposition
- No disagreement; no SECURITY-labeled finding; no blocking item. Both reviewers
  independently confirm the bypass is fully closed and the S85 suite cannot regress.
- Sequential value (again): the design-gate CRITICAL (suppression guards) originated
  from Codex's code-grounded pass and is the substance of this change; the MERGE
  pass confirms it landed correctly in code. [[feedback_mrpf_sequential_dogfood_wins]].
- **Adopt.** Commit + push (agent-only; no frontend deploy). Dark-launch validate
  e18e1931 (expect R5) before any `PLAN_REVIEW_LADDER_ENFORCE` flip (S87).
