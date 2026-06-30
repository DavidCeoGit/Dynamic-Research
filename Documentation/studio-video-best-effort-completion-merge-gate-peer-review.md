# S188 — Best-effort completion for a still-rendering Studio video (MERGE gate)

> **Gate:** MERGE (agent/ → production worker). **Status:** CLEARED — **UNANIMOUS ENDORSE.**
> Sequential tri-vendor: Claude (author, grounded self-verify) → Gemini 3.1-pro-preview (holistic-adversarial, ENDORSE) → integrate → Codex gpt-5.5 xhigh (grounded-adversarial, ENDORSE) → integrate (comment-only).
> **Severity:** NORMAL. **Risk labels:** AGENT BEHAVIOR (worker completeness/finalize logic propagates to every run), DATA (run-status transitions; a `completed` row deliberately missing the video; billing-ledger), ARCHITECTURE (cross-cutting executor ↔ state-evaluation ↔ studio-completeness ↔ recovery-sweep ↔ finalize ↔ nlm-artifact-cli ↔ schema ↔ frontend mirrors), INFRA (one additive migration).
> **§11 HARD RULE honored:** FULL Gemini + Codex + Claude reviewed BEFORE merge, NO substitutes (Codex ran live on real ChatGPT auth, gpt-5.5). **Implements the CLEARED design** `studio-video-best-effort-completion-design-gate.md` (v3-FINAL).
> **Branch:** `s187-video-checkpoint-best-effort` vs `main` `bf50c42`. **Dark-launch:** behind `STUDIO_VIDEO_RENDER_ENABLED` (default OFF ⇒ feature INERT). **Deploy:** migration FIRST, then worker; flag stays OFF until a shadow-observed run.

---

## 0. Outcome

The implementation half of P0-2 (Branch (c) "Studio video still rendering at the worker checkpoint" → best-effort completion) is **APPROVED FOR MERGE**. All three reviewers engaged adversarially and found **no CRITICAL/MAJOR blocker**. The change is fail-closed (no path completes a genuinely-incomplete run), anti-stale (no cross-run contamination), bounded (no strand), billing-correct (no double-bill / un-completion), and **inert when the flag is OFF** (the pre-S188 paths are behavior-identical — proven by the 687 pre-existing tests staying green).

- **What each reviewer saw:** the FULL working-tree change vs `main` (the S187 commit `9871519` + the S188 MERGE-gate integration), the full post-change source of every core file, the migration, the new + updated tests, AND the cleared design doc. Codex additionally **ran the full test suite itself** (`pnpm -C agent exec node --import=tsx --test test/*.test.ts` → 701 passing, 0 failing).
- **Test delta:** 687 → **701 agent** (+14: 6 sweep render-arm/best-effort integration + 8 Branch-(c) classify anti-stale) / **142 frontend**, 0 fail; `tsc --noEmit` strict clean both subprojects.

---

## 1. The change (14 files S187 + 6 files S188-integration)

S187 (committed `9871519`): the full agent-side of Branch (c) behind the dark-launch flag — status-aware NLM list helper, Gate-A deliverable-presence defer probe, Gate-B render classification (exact `videoTaskId` else `created_at >= runFloorMs`), sweep render-arm + render-window best-effort completion, `finalizeBestEffortRun` (narrow, video-only, non-force, requires videoTaskId), honest notify copy + operator outage alert, the additive `studio_recovery_video_deferred` migration, and the `frontend/lib/validate.ts` Zod allowlist passthrough.

S188 MERGE-gate integration (this session, on-branch via sandbox+promote): see §4.

---

## 2. Round 1 — Gemini 3.1-pro-preview (holistic-adversarial, BREADTH) → ENDORSE

Verbatim findings (`/c/tmp/dr-s188/review/gemini-merge.log`, model `gemini-3.1-pro-preview`, 336,779-char prompt = full diff + full source + design):

> **MAJOR 1. Missing publish gate re-assertion at completion edge** (`finalize-recovered-run.ts`). Design §7.2 mandates `finalizeBestEffortRun` fetch `state.publish_verification` and re-assert publish/claims for publish jobs; the impl re-asserts research-text docs but omits the publish re-assert. *Why NOT a CRITICAL fail-open:* a job must pass the real publish gate in `executor.ts` BEFORE it can reach Gate B and be parked, so it is structurally impossible for a publish-failed job to enter the sweep. A clear deviation from the defensive design intent; should be patched.
>
> **MAJOR 2. Cross-tier parity: missing frontend types** (`frontend/lib/types/queue.ts`). Left untouched — missing `recovery_kind`/`videoTaskId`/`runFloorMs` on `StudioRecoveryProduct` + `studio_recovery_video_deferred` on `ResearchJob`. Blocks the future results-page banner without type errors.
>
> **MAJOR 3. Sweep render-arm core logic is completely untested** (`studio-recovery-sweep.ts`). Polling the status-aware list, anti-stale match, download on status_id 3, render-window exhaustion, dispatch to `finalizeBestEffortRun` — zero coverage (only dummy stubs). The deferred integration tests **must land before merge**.
>
> **MINOR 4. Zod schema parity** — `agentUpdateSchema` missing `studio_recovery_video_deferred` (worker writes it via direct REST, so not a runtime gap; add for mirror completeness).
>
> **INFO 5. Edge case** — a video that reaches status_id 3 but hits continuous download blips until the 120-min window exhausts is dropped via best-effort. Perfectly acceptable (2h of download failure is effectively an outage); worth documenting.
>
> Summary: core safety requirements (no fail-opens, no cross-run contamination, bounded loops, idempotent billing) solidly implemented; dark-launch flag correctly leaves existing behavior inert when OFF. Once tests are added and type mirrors synced, ready to ship. **VERDICT: ENDORSE**

---

## 3. Round 2 — Codex gpt-5.5 xhigh (grounded-adversarial, DEPTH) → ENDORSE

Run banner asserted: `model: gpt-5.5`, `provider: openai`, `approval: never`, `sandbox: workspace-write`, `reasoning effort: xhigh` (`/c/tmp/dr-s188/review/codex-v1.log`). Ran on the INTEGRATED v2; executed the full test suite (701 passing). Verbatim:

**Findings**
- **MINOR** — Render window timing is materially slower than the "120 min" comment implies (`studio-recovery-sweep.ts:83` window vs `:93` reused backoff): checks land ~5,20,65,185 min, so best-effort first fires ~185 min, and a video completing at 25 min may not download until the 65-min tick. **Latency/comment drift, not a strand or fail-open.**
- **INFO** — Render status handling treats any matched non-`3` status as "still rendering" (`:420`); a failed/unknown render status waits until window exhaustion rather than fast-terminalizing. Still cannot complete before `finalizeBestEffortRun` reasserts non-video obligations + research docs → not blocking.
- **INFO** — The "byte-identical" finalizer claim is source-level overstated, but behavior holds; the parity test pins behavior, not literal source.
- **INFO** — `studio_recovery_video_deferred` is written by direct REST from the finalizer, not the agent route; consistent + acceptable (the route is not the writer).

**Grounded checks (all PASSED):**
- **No publish fail-open** — Gate-A defer is after terminal classification and requires `publishOk` (`executor.ts:412,:428`); the normal publish gate still runs on the deferred fall-through (`:474`) before Gate B can park. *(Directly ground-tests + validates the MAJOR-1 acceptance.)*
- **No direct-completion fail-open** — `recoverablePending` never makes `ok` true; the park path throws before upload/`completeJob` (`executor.ts:553,:621`).
- **Anti-stale sound** — exact `videoTaskId` first, else `created_at >= runFloorMs` (`studio-completeness.ts:222`); persisted payload (`executor.ts:571`); sweep uses the same identity (`studio-recovery-sweep.ts:414`).
- **Zod parity correct** — the 3 fields allowlisted (`validate.ts:373`); route passes the payload through (`api/queue/[id]/route.ts:123`); without the allowlist Zod strips them.
- **Billing not double-inserting** — UPDATE existing `research_usage.job_status` (`usage-tracking.ts:424`) after a successful completed patch (`finalize-recovered-run.ts:411`).
- **Dark-launch inertness holds** — flag defaults off (`worker-config.ts:64`), gates both the Gate-A defer and the Gate-B render classification.

**No CRITICAL or MAJOR blocker found. VERDICT: ENDORSE**

---

## 4. Synthesis + integration (Claude, the author leg)

The author independently grounded-verified the load-bearing fail-open question before the gate: a Gate-A defer that cannot be confirmed at Gate B (`classifyVideoRender` → null on a CLI blip / foreign / never-launched) flows to a **terminal hard-fail** (the pre-S187 behavior), never a completion. Both reviewers' grounded passes confirm. Dispositions:

| Finding | Reviewer | Disposition |
|---|---|---|
| MAJOR-2 frontend `queue.ts` parity | Gemini (+author) | **FIXED** — `recovery_kind`/`videoTaskId`/`runFloorMs` + `studio_recovery_video_deferred` added, mirroring `agent/types.ts`. |
| MINOR-4 `agentUpdateSchema` parity | Gemini | **FIXED** — `studio_recovery_video_deferred: z.boolean().optional()` added (parity only; worker writes via direct REST). |
| MAJOR-3 sweep render-arm + classify untested | Gemini | **FIXED** — +14 tests (6 sweep: render→status_id 3→download→finalize; still-rendering→retry; window-exhaust→best-effort completed+alert; mixed download+render→no best-effort; best-effort refusal→retry; finalizeBestEffort throw→strand-guard. 8 classify: exact-id, just-completed-3, floor-match, foreign<floor→terminal, 92s-before-floor→terminal strict, never-launched→terminal, CLI-blip→terminal, flag-OFF→inert). To make the flag-ON path testable, the flag is threaded via `CompletenessOptions.videoRenderEnabled ?? STUDIO_VIDEO_RENDER_ENABLED` (defaults to the const; the executor never sets it ⇒ production unchanged). |
| MAJOR-1 publish re-assert omitted at `finalizeBestEffortRun` | Gemini; ground-tested by Codex | **ACCEPTED DEVIATION (documented + comment tripwire).** Not a fail-open: the executor publish gate + the Gate-A `publishOk` probe both fail-closed BEFORE a run can park; `finalizeBestEffortRun` is sweep-only (no CLI entry); state.json is immutable post-run. A correct re-assert would thread `user_context` + the URGENT bypass snapshot + a state read into the sweep-only caller — new surface guarding an UNREACHABLE state. Codex ground-tested it: "No publish fail-open found." A code-comment TRIPWIRE in `finalizeBestEffortRun` instructs any future non-sweep caller to add the re-assert. |
| MINOR render-window "120 min" comment misleading | Codex (+author §9) | **FIXED (comment-only)** — the comment now states the effective first best-effort firing is ~185 min under the shared backoff, and that design §9's faster render backoff is a deferred post-shadow tuning. |
| INFO "byte-identical" overstated | Codex | **FIXED (comment-only)** — softened to "behaviour-identical (the parity test pins behaviour)". |
| INFO failed/unknown render status waits until exhaustion vs fast-terminalize | Codex | **DEFERRED (backlog).** Not blocking (still gated by the obligation re-assert). A fast-terminalize-on-failed-render-status robustness improvement for the post-shadow tuning pass. |
| INFO direct-REST marker; INFO-5 rendered-but-blipped drop | Codex / Gemini | **ACCEPTED** — both correct-as-designed; documented. |

**Deferred to a post-shadow tuning pass (non-blocking, recorded):** (a) design §9 faster render backoff (a dedicated render-backoff schedule, so best-effort responsiveness matches the 120-min intent); (b) fast-terminalize on a known-FAILED render status. Both are responsiveness refinements, not correctness gaps, and are best tuned after observing a real shadow run.

---

## 5. Deploy plan (migration-first, flag OFF)

1. Merge `s187-video-checkpoint-best-effort` → `main` (squash).
2. `supabase db push` — applies `20260629_studio_recovery_video_deferred.sql` to prod (additive, idempotent, NOT NULL DEFAULT false; no CHECK/enum churn) **BEFORE** the worker.
3. `git -C C:\Users\ceo\Projects\DR-Deploy pull origin main` → `Stop/Start-ScheduledTask DynamicResearchWorker`; verify the new PID preflights green.
4. **Keep `STUDIO_VIDEO_RENDER_ENABLED` OFF** (do NOT add it to DR-Deploy `.env`) — the feature ships INERT. Flip to `"true"` only after a shadow-observed run, then restart the worker.

Frontend results-page surface (the `video_deferred` banner, the dashboard predicate dedup into `run-status.ts` + parity guard, render-vs-download copy, `/api/state` exposure) is a SEPARATE frontend MERGE per the design "ship close."
