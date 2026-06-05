# Plan-Review Convergence — Implementation MERGE-gate Peer Review

**Session:** S85 (2026-06-03 UTC)
**Classification:** MERGE × **AGENT BEHAVIOR** × NORMAL (changes the convergence
classifier that gates every research job). Implements the gate-CLOSED design
`Documentation/plan-review-convergence-design-gate.md` (v3).
**Topology:** Sequential Gemini → Codex (HARD RULE). Gemini first holistic read;
Codex code-grounded pass on the same artifact (Gemini had zero findings → v1 = v2).
**Outcome:** Both APPROVE core. Gemini APPROVE (0 findings); Codex
APPROVE_WITH_CHANGES (1 MINOR, test-hygiene — integrated). Loop CLOSED.

## What each reviewer saw
- **Gemini** (`gemini-3.1-pro-preview`, holistic): closed design doc + unified
  diffs of all 4 changed files + the new test file (embedded in prompt).
- **Codex** (`codex exec -s read-only`, code-grounded): same packet PLUS live
  read of sandbox/live `plan-types.ts`, `plan-reviewer.ts`, `executor.ts`,
  `notify.ts`, `agent/api-client.ts`, the frontend plan-review hook/banner/routes,
  and the supabase plan-review migration. Did not run tests (proposal still in
  sandbox/, not promoted).

## Changed files
- `agent/lib/plan-types.ts` — `TERMINAL_RULES`/`TerminalRule`; `ReviewResult.terminal_decision?` + `.reservations?`.
- `agent/lib/plan-reviewer.ts` — `MAX_RESERVATION_MAJORS=2`; `decideTerminal()` ladder; `ladderEnforce?` option; terminal-branch replacement; `finalize()` carries telemetry through shadow forcing.
- `agent/executor.ts` — `PLAN_REVIEW_LADDER_ENFORCE` flag; `buildReservationAdvisory()`; plan_review_error advisory on APPROVED path; terminal_decision logging; reservations threaded to completion email.
- `agent/lib/notify.ts` — `NotifyArgs.reservations?`; advisory block in success email (text + HTML).
- `agent/test/plan-reviewer-convergence.test.ts` — NEW, 16 tests.

## Gemini round 1 — VERDICT: APPROVE (0 findings)
Confirmed: (Q1) ladder precedence R1>R2>R3>R4>R5 via ordered early-returns;
decideTerminal evaluates only the terminal `availableCalls`. (Q2) `ladderEnforce`
gates `emitApproved`; dark-launch computes telemetry but reverts to legacy
REQUEST_CHANGES; early-exits unaffected. (Q3) surfacing genuinely non-silent —
traced executor advisory persist + `planReviewOutcome → notifyTerminal →
sendCompletionEmail` text+HTML. (Q4) coverage exhaustive (R1–R5, 2-vs-3 boundary,
final-round counting, one-reviewer-down). (Q5) no TS/null-safety issues.

## Codex round 2 — VERDICT: APPROVE_WITH_CHANGES (1 MINOR — integrated)
- **C-MIN-1 [test-hygiene]** ACCEPT — the pure `decideTerminal()` test
  "one reviewer APPROVE, other APPROVE_WITH_CHANGES + 1 MAJOR" fed two
  approve-like calls, an UNREACHABLE input (real `reviewPlan` early-exits via
  `allApprove` before the ladder runs), implying those findings would be
  surfaced as reservations when they never would. **Fix:** rewrote the test to
  a reachable terminal state (gemini APPROVE_WITH_CHANGES + codex
  REQUEST_CHANGES with 1 MAJOR → allApprove false → ladder runs → R5,
  reservations.length 1). No production-code change.

### Codex code-grounded confirmations (not findings)
- **C1** dark-launch preserved: `emitApproved = wouldApprove && ladderEnforce`
  blocks R5→APPROVED unless `PLAN_REVIEW_LADDER_ENFORCE=true`.
- **C2** `planReservations` in scope only on the full-run completion path;
  `runStudioOnly` reservation-free (a prior scope bug was caught by tsc + fixed).
- **C3** no code path treats non-null `plan_review_error` as failure when
  `plan_review_status=approved` (banner hides approved states; field used only
  for system-blocked detail) → advisory write is safe.
- **C4** shadow mode still forces non-SYSTEM_BLOCKED → APPROVED while preserving
  `terminal_decision`. Note: shadow-mode R5 reservations DO get surfaced because
  the executor keys on the emitted APPROVED — this is expected shadow behavior
  (whole gate non-blocking), not ladder enforcement. No action.
- **C5** advisory email/DB threading has no executor/notify integration test
  (the existing executor paths likewise lack Supabase+Resend mocks). Both
  reviewers hand-traced the call graph as correct. DEFERRED as a known test gap,
  not blocking for a MINOR.

## Disposition
Both reviewers APPROVE the core ladder + surfacing. The single MINOR is test-only
clarity and was integrated. No SECURITY/DATA/CRITICAL findings. **Merge approved.**
Ship dark-launched (`PLAN_REVIEW_LADDER_ENFORCE` unset → default false); flip to
`true` to validate e18e1931 ships, then monitor R5 trigger-rate via §5a query.
