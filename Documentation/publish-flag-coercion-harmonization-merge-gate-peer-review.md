# Publish-flag coercion harmonization — MERGE-gate peer review (S120)

**Date:** 2026-06-13 · **Gate:** MERGE · **Risk label:** AGENT BEHAVIOR (MRPF PUBLISH gate semantics) · **Severity:** NORMAL · **Topology:** sequential Gemini → Codex.
**Change:** S120 publish-flag coercion harmonization (implements the CLEARED design plan `Documentation/s120-tomorrow-design-plan.md` v4 + its design-gate review `Documentation/publish-flag-coercion-harmonization-design-gate-peer-review.md`).
**Branch:** `feat/publish-flag-coercion-harmonization`.

## What shipped
- `agent/lib/publish-gate.ts`: canonical strict predicate `isPublishFlagSet` (accepts ONLY `true`/`"true"` case+space-insensitive; rejects `"on"`/`"1"`/`"yes"`); `diagnosePublishFlag` + `formatPublishFlagAlarm` + `logPublishFlagDiagnostics` (the `[SECURITY]` logging backstop); `isPublishRequired` now ORs job+state through the predicate.
- `agent/executor.ts`: `buildManifest` seeds `publish_required` via `isPublishFlagSet(job.user_context?.publishRequired)` (Defect B); `publishBlock` keys off `isPublishRequired(job,null)` (was `=== true`, Codex C4); `logPublishFlagDiagnostics` added at both DRY_RUN sites + the full-pipeline completion gate + the studio_only gate, BEFORE each applicability decision.
- `frontend/lib/publish-flag.ts` (NEW): mirror of `isPublishFlagSet` + `resolveClonePublishRequired` (ORs the three clone sources through the predicate).
- `frontend/app/api/runs/[slug]/manifest/route.ts`: **Defect C fix** — `.select` now includes `user_context`; clone prefill uses `resolveClonePublishRequired` (was the no-op `state.userContext.publishRequired === true` that silently downgraded every clone of a publish parent — confirmed live, job `97906d8c`).
- `frontend/app/api/runs/[slug]/replay/route.ts`: `publishRequired = isPublishFlagSet(uc.publishRequired)`, `uc = parent.user_context`.
- Tests: `agent/test/publish-gate.test.ts` (+predicate matrix, diagnostic/alarm, Defect-B seed), `agent/test/publish-brief.test.ts` (+string `"TRUE"`/rejected `"on"`), `frontend/lib/__tests__/publish-flag.test.ts` (NEW — predicate + source-OR), `test/publish-flag-parity.test.ts` (NEW — cross-import behavioral parity), `package.json` test wiring.

**Tests:** agent 398 pass (+8), frontend+parity 74 pass (+9), `tsc --noEmit` clean on agent + frontend. **Automated-test coverage (mandatory for SECURITY/AGENT-BEHAVIOR):** YES — predicate value matrix, clone source-OR selection (incl. the exact 97906d8c shape + the legacy no-row case), Defect-B seed, backstop logging, cross-root parity.

## What each reviewer saw
| Reviewer | Lens | Scope | Verdict |
|---|---|---|---|
| Gemini 2.5 Pro | holistic-adversarial (breadth) | full diff `@s120-review.diff` + design-gate doc | BLOCK (4 findings) |
| Claude fresh subagent | grounded-adversarial (depth) — **interim substitute (b)** | read all 7 files + tests, 9 independent hunts | **CLEAR** |
| Codex (gpt-5.5, read-only) | grounded-adversarial (depth) — **required reviewer** | 4 attempts; could `rg`-grep but could NOT read file bodies (pwsh exec policy-blocked on this Windows sandbox; native file-read did not engage) | **Could not complete** — partial grep corroboration only |
| Gemini 2.5 Pro | grounded-adversarial — **interim substitute (a)** | launched against `@s120-review.diff` | produced no usable output (silent hang) |

## Gemini holistic findings → disposition (all grounded NON-BLOCK)
1. **[BLOCK→NON-BLOCK] Replay inconsistency / legacy storage-only downgrade.** Misframed: `replay/route.ts:112` `if (!parent) return 404` — replay REQUIRES a queue row and 404s without one, so there is no no-row downgrade path. Single-source (DB `parent.user_context`) is correct *because* the row is mandatory; the clone route's broader OR exists *because* clone must serve legacy storage-only runs. Different correctness obligations, both fail-closed. Confirmed by Codex run 1 ("replay has a hard `if(!parent) return 404` … I don't see a no-row downgrade path; clone is different by design") and the Claude subagent.
2. **[BLOCK→NON-BLOCK] StepReview.tsx not harmonized.** `StepReview.tsx:86,209` read react-hook-form state — Zod-coerced boolean; the clone prefill now yields a strict boolean via `resolveClonePublishRequired`. Display-only, not a gate decision. Dispositioned in the design (§1.4.4) as cosmetic. Confirmed by the Claude subagent.
3. **[BLOCK→NON-BLOCK] Studio_only early-return bypasses the backstop.** Hallucination: there is no success early-return between the `studioState` load (`executor.ts:1016-1031`) and `logPublishFlagDiagnostics` (`:1032`); the lines Gemini cited (`992-996`) are the spawn-error catch. Backstop is reached before the applicability decision on all four executor paths. Confirmed by the Claude subagent (call-site line audit).
4. **[NIT] Redundant guard in `diagnosePublishFlag`.** Kept: the `if (typeof rawValue !== "string")` line is reachable for symbol/function inputs (`JSON.stringify` → `undefined`), making the function total over `unknown`. Harmless and correct.

## Claude grounded subagent (interim substitute b) — CLEAR
Read all 7 files file:line + the three test files. Adversarially traced every downgrade path and could not construct an escape:
- Clone ORs DB `user_context` + top-level `state.publish_required` + legacy `state.userContext` echo through the strict predicate → covers normal UI run, legacy no-row (via the state flag), and direct-DB string `"true"`. Verified the S118 no-op root cause: `buildManifest`'s `userContext` block (`executor.ts:850-889`) genuinely omits `publishRequired`, while top-level `publish_required` (`:834`) is written — so the new state-flag arm is what catches legacy runs.
- Replay 404s on no-row; reads authoritative DB jsonb through the predicate.
- Lenient `publishBlock`/`buildManifest` seed only ever makes the gate fire MORE often — no fail-open introduced.
- `[SECURITY]` backstop reached before the applicability decision on all four paths (full-pipeline `:688`, studio_only `:1034`, both DRY_RUN sites).
- `.select("attachments, user_context")` + the `attachRowUserContext` cast are null-row / arbitrary-jsonb safe (optional chaining → `isPublishFlagSet(unknown)` guard; no throw).
- `resolveClonePublishRequired` is total over all shapes (optional chaining everywhere; pinned by tests).
- Parity is behaviorally enforced (cross-import value matrix), not byte-grep; CI-wired in `package.json`.
- **Zero residual `=== true` strict coercion in live code** (independently re-grepped).

## Codex (required reviewer) — environmental block + partial corroboration
Across 4 attempts Codex (gpt-5.5, `-s read-only`, `approval: never`) could run its `rg`-based grep but every attempt to read file bodies went through `pwsh -Command Get-Content`, which the sandbox rejects (`blocked by policy`); its native non-shell file-read did not engage. Run 3 (over-constrained by my "never shell" instruction) honestly refused to fabricate and emitted `VERDICT: BLOCK` for "could not review." Run 1 partially grounded before truncating and **confirmed the replay 404 rebuttal + the clone-is-different-by-design** point. Run 4's grep **corroborated that residual `=== true` hits are only in docs/tests/the review component, not live agent/frontend code.**

**This is a NEW Codex CLI failure mode** (joins the list in `reference_mrpf-review-cli`): *read-only sandbox on Windows — `rg` grep works, but file-body reads route through policy-blocked `pwsh` exec and the native reader does not engage → no full grounded pass.* Distinct from quota-exhaustion, so the §1a API-key flip does NOT remedy it (auth-independent sandbox policy issue).

## Synthesis & decision
- All Gemini holistic findings dispositioned NON-BLOCK on grounded inspection, independently corroborated by the Claude grounded subagent (full CLEAR) and, where reachable, by Codex's partial grep.
- The grounded-adversarial DEPTH role was fully satisfied by the Claude fresh-context subagent (substitute b). The Gemini grounded substitute (a) failed to emit.
- **Proceeding at NORMAL severity, OPERATING UNDER REDUCED REVIEW** (per the MRPF Disagreement Procedure: one reviewer effectively offline >4h → proceed with one reviewer + recorded note). The Gemini holistic pass + the Claude grounded-adversarial subagent (full CLEAR) cover breadth and depth; Codex contributed grep-level corroboration only. No open BLOCKs; no SECURITY-CRITICAL findings.
- **OWED follow-up (mandatory, <24h / next session):** a real **Codex-lineage grounded pass** once a Codex file-read path works on this host — options to try: `codex exec -s workspace-write` (lets it read without the pwsh-exec block), the Antigravity-IDE-bundled codex, or a non-Windows runner. This is NOT a human-signed URGENT bypass (none is claimed); it is a reduced-review note. The agent has not authored and will not author a `RISK-ACCEPTED-BY` sign-off.
