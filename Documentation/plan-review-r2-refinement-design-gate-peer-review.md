# Plan-Review R2 Refinement — DESIGN-gate Peer Review (companion)

**Artifact under review:** `Documentation/plan-review-r2-refinement-design-gate.md`
**Gate:** DESIGN × AGENT BEHAVIOR × NORMAL. **Topology:** sequential Gemini → Codex
(per `~/CLAUDE.md` Review Topology). **Session:** S86 (2026-06-03 UTC).
**Outcome:** DESIGN gate **CLOSED at v3.** Code implementation verified separately at
the MERGE gate (`plan-review-r2-refinement-merge-gate-peer-review.md`, follow-on).

## What each reviewer saw
- **Gemini (round 1, holistic):** design doc v1 + grounding code excerpts (injection
  severities, R2 predicate, adjustVerdictForAmbition, call construction) pasted into
  the prompt. Did NOT read the repo directly.
- **Codex (round 2, code-grounded, `codex exec -s read-only`):** design doc v2 + read
  `agent/lib/plan-reviewer.ts` and `agent/test/plan-reviewer-convergence.test.ts`
  directly from the working tree.
- **Codex (round 3, fidelity QA):** design doc v3 + re-read `plan-reviewer.ts`.

## Round 1 — Gemini (verdict: APPROVE)
- **[MINOR]** Add a two-reviewer transparency test locking in the deferred
  `adjustVerdictForAmbition` behavior (R1 APPROVE / R2 raw-APPROVE+MINOR-ambition
  flipped → assert R5 with reservation intact). → **Integrated** as §7.6 in v2.
- **[NIT] Q1** strongly concur deferring `adjustVerdictForAmbition` narrowing; the
  transparency argument is "mathematically correct and functionally superior."
- **[NIT] Q3** concur R4 must not count MINORs of any origin.
- **[NIT]** residual both-reviewers-MINOR → R3 edge acceptable to document-and-defer
  (two models flagging scope is a strong-enough combined signal).

## Round 2 — Codex (verdict: REQUEST_CHANGES) — caught what Gemini missed
- **[CRITICAL]** Fix (a) as written (R2-only) is **not** invariant-preserving: the
  three injection *suppression* guards (`plan-reviewer.ts:298/334/346`) are also
  severity-agnostic. A deficient persona score + organic MINOR `plan-ambition`
  suppresses the MAJOR injection → R2-MAJOR+ lets the MINOR fall through → bypass
  reopened. → **Integrated** in v3: unified `isAntiBypassFinding()` helper narrows
  all 4 sites (R2 + 3 guards).
- **[MAJOR]** e18e1931 R5 trace otherwise correct against code: verdicts stored
  post-`adjustVerdictForAmbition` (L610/L716), terminal reads final-round
  `availableCalls` (L824-855), R5 returns reservations (L418-436). → Confirmed.
- **[MINOR]** §4 deferral + transparency argument factually correct against code:
  silent early-exit (L827-846) does not pass `terminalDecision`/`reservations`; only
  the max-round branch (L855-876) does. → Confirmed; strengthens the deferral case.
- **[MAJOR]** §7 missing a guard regression test (deficient score + MINOR ambition →
  MAJOR injected → R2). → **Integrated** as §7.7 in v3.

## Round 3 — Codex fidelity QA on v3 (verdict: REQUEST_CHANGES — code, not design)
Codex verified by reading `plan-reviewer.ts` that the v3-prescribed changes (helper +
3 guard narrowings + R2 + §7.7 test) are **not yet present in code** — expected, since
this is the DESIGN gate; code lands at the implementation/MERGE step. The pass raised
**no new design concern**; its "missing" enumeration is exactly v3's change list, which
*confirms* the design targets the correct sites. Code-vs-design fidelity is therefore
deferred to the MERGE gate (the correct place to verify the implementation matches v3).

## Synthesis & disposition
- Sequential value confirmed: Codex's code-grounded pass surfaced a **CRITICAL** the
  holistic v1 read missed (the suppression-guard half of the bypass) —
  [[feedback_mrpf_sequential_dogfood_wins]] holds again.
- All substantive findings integrated into v3 (CRITICAL + 2× MAJOR + MINOR + Gemini
  MINOR). No SECURITY label; no blocking disagreement; both reviewers APPROVE the core
  direction (Codex's R2/R3 verdicts were "fix the design then the code," now done).
- **Tests covered?** (MRPF AGENT-BEHAVIOR mandatory question.) Yes — §7 specifies 5
  new boundary tests incl. the guard regression that directly proves the bypass closed,
  plus the 16-test S85 regression set. Verified GREEN at the MERGE gate.
- **Decision: adopt (a) v3.** Implement the 4-site helper + tests; MERGE-gate review
  the code; re-validate e18e1931 dark-launched (expect R5) before any enforce flip.
