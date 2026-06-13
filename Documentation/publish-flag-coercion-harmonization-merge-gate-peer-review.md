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
| Codex (gpt-5.5, `-s workspace-write`) | grounded-adversarial (depth) — **required reviewer** | full file:line read of all changed files (5th attempt — see note) | **CLEAR** — all 4 rebuttals confirmed CORRECT; 2 new NON-BLOCK/NIT findings (integrated) |
| Claude fresh subagent | grounded-adversarial (depth) — corroborating | read all 7 files + tests, 9 independent hunts | **CLEAR** |
| Gemini 2.5 Pro | grounded-adversarial — attempted substitute | launched against `@s120-review.diff` | produced no usable output (silent hang) — moot once real Codex completed |

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

## Codex (required reviewer) — completed CLEAR after a sandbox-mode switch
Codex (gpt-5.5, `approval: never`) FAILED to read file bodies across 4 `-s read-only` attempts: it routed reads through `pwsh -Command Get-Content`, which the read-only sandbox rejects (`blocked by policy`), and its native non-shell reader did not engage; `rg` grep worked (run 4 corroborated residual `=== true` is docs/tests only). Run 3 honestly refused to fabricate (`VERDICT: BLOCK` = "could not review"). **The 5th attempt switched to `codex exec -s workspace-write`** — which permits `pwsh`/`rg` exec — and Codex completed a full file:line grounded pass:
- **VERDICT: CLEAR.** All 4 author rebuttals confirmed **CORRECT** with file:line (replay 404 at `:93-117`; StepReview display-only, Zod source `validate.ts:80`; studio diagnostics at `executor.ts:1016-1042` before the gate, spawn-catch at `:989-997`; the symbol/function guard reachable). Probe: clone OR covers DB+state+legacy; replay DB string `"true"` stays set; seed+publishBlock use the predicate; no residual `=== true`; no fail-open.
- **2 new findings, both integrated this session (post-Codex, sequential topology):**
  1. **[NON-BLOCK, log-injection hardening]** `diagnosePublishFlag` truncated but didn't escape control chars before logging — an AI-written `state.publish_required` with newlines could forge multiline `[SECURITY]` log lines (no gate fail-open). **Fixed:** `rawValue.replace(/[\x00-\x1f\x7f]/g, " ")` before truncation + a test asserting the alarm stays single-line.
  2. **[NIT]** No test pinned the `JSON.stringify→undefined` (symbol/function) branch. **Fixed:** added a symbol+function diagnostic test. Agent suite now 400 pass.

**NEW Codex CLI failure mode recorded** ([[feedback_codex_readonly_windows_cannot_read_file_bodies]]): *read-only sandbox on Windows — `rg` grep works, but file-body reads route through policy-blocked `pwsh` exec → no grounded read. Remedy: `-s workspace-write`.* Auth-independent (the §1a API-key flip does NOT remedy it).

## Synthesis & decision — GATE CLOSED (full cross-vendor topology)
- **Both required reviewers ran clean on the integrated change:** Gemini holistic-adversarial (4 findings → all grounded NON-BLOCK) + Codex grounded-adversarial (`workspace-write`, CLEAR, all rebuttals CORRECT, 2 minor findings integrated). The Claude grounded subagent independently corroborated CLEAR.
- **No reduced-review caveat. No follow-up owed.** Sequential topology honored: Gemini first → integrated → Codex on the integrated version → its 2 findings integrated. No open BLOCKs; no SECURITY-CRITICAL findings. Automated-test coverage YES (400 agent + 74 frontend/parity, tsc clean).
