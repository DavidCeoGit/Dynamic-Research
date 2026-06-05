# DESIGN-Gate Synthesis: PLAN_REVIEW_ENFORCE=true Flip Testing Protocol v3

**Status:** v3 SHIPPED post-sequential-MRPF (Gemini round 1 → integrate → Codex round 2 → integrate). Design doc at `Documentation/plan-review-enforce-flip-design-gate.md` (514 lines, v3). Implementation surface: this is a PROTOCOL doc, not code — the only code change required before the flip is the `agent/lib/notify.ts:buildPlanReviewEmail` template fix (G-4) which lands as a separate MERGE-gate review when the operator initiates Phase 4. **No flip occurred this session.** This is the planning artifact that gates the future flip event.

**Author:** Claude (Opus 4.7, S65 2026-05-29)
**MRPF classification:** Event Gate = DESIGN. Risk Labels = **AGENT BEHAVIOR** (gate becomes autonomous job-execution decision-maker) + **DATA** (false-blocks destroy paid runs). Severity = NORMAL. → Sequential Gemini → integrate → Codex on integrated v2 (per `~/CLAUDE.md` HARD RULE).

---

## Reviewer trail

### Round 1 — Gemini 3.1 Pro Deep Think (CLI, 117s wall-clock)

Verdict: **REQUEST_CHANGES**. 1 CRITICAL + 4 MAJOR + 2 MINOR. All actionable.

| ID | Sev | Disposition |
|---|---|---|
| **G-1** | **CRITICAL** | INTEGRATED v2. The §4.3 + §4.4 baseline-telemetry SQL queries read `research_queue.plan_review_status`, which is **force-written to 'approved' in shadow mode** by `plan-reviewer.ts:finalize()` for every non-SYSTEM_BLOCKED outcome. The original queries would have falsely reported ~100% approval — completely invalidating Phase 1 readiness. Fix: derive ORGANIC verdict from the `[SHADOW-MODE: would have been X]` marker prefix written into `error_message` by `finalize()` when overriding. Now queries return both `organic_approval_pct` (the gating metric) AND `effective_approval_pct` (informational). |
| G-2 | MAJOR | INTEGRATED v2. §3 criteria adds per-`depth_target` tier requirement: each tier with ≥ 3 jobs in n=10 must show ≥ 50% organic approval. Prevents tier-specific over-blocking (e.g. 8 executive-tier approvals masking 100% expert-tier rejections) from hiding behind a passing overall metric. |
| G-3 | MAJOR | INTEGRATED v2. §5.2 verdict-stability test adds: (a) finding-overlap criterion (≥ 60% origin overlap across replays that agree on terminal verdict), (b) severity-distribution stability (CRITICAL count within ±1). Catches "whack-a-mole rejection" where reviewers reach the same verdict via different findings — operationally unusable. |
| G-4 | MAJOR | INTEGRATED v2. §7.1 pre-flip checklist now hard-requires `sendPlanReviewEmail` template update. Current copy ("needs a quick look") implies paused/awaiting-input; enforce mode TERMINATES the job. Email-template fix moved from out-of-scope to blocking prerequisite. Codex C-3 later reinforced this with concrete string targets. |
| G-5 | MAJOR | INTEGRATED v2. §7.3 rollback trigger tightened from 2-of-5 false-blocks to **1-of-5** (immediate revert on first clear false-block). Decision D row updated. Implicit-cost analysis (G-6) supports this aggressive bias. |
| G-6 | MINOR | INTEGRATED v2. §2.3 cost asymmetry now itemizes implicit costs: false-block ~$5-50 (vs. surface compute ~$0.30) due to lost trust + support touch + replay friction; true-block ~$0.30. Shows **negative-EV regime** where the gate must aggressively avoid false-blocks. |
| G-7 | MINOR | INTEGRATED v2. §6 tuning levers explicitly ordered: synthesizer prompt → input quality → round reduction → rubric softening. Earlier levers preserve research quality; later ones weaken the gate. Decision E row updated. |

### Round 2 — Codex (codex exec -s read-only, 211s wall-clock)

Verdict: **REQUEST_CHANGES**. 5 MAJOR + 1 MINOR. All code-grounded catches that Gemini's top-down read missed.

| ID | Sev | Disposition |
|---|---|---|
| **C-1** | **MAJOR** | INTEGRATED v3. Migration sets `research_queue.plan_review_status NOT NULL DEFAULT 'pending'`. The v2 queries using `WHERE plan_review_status IS NOT NULL` would match EVERY queue row including never-reviewed pending/reviewing ones — would have included pre-gate jobs in the readiness metric. Fix: `WHERE plan_review_status IN ('approved','request_changes','blocked','system_blocked') AND plan_review_iterations > 0` across §4.2, §4.3, §7.3. |
| **C-2** | **MAJOR** | INTEGRATED v3. `plan_reviews` is one row per reviewer per iteration. The §4.4 finding audit counted all historical findings for organic-approved jobs, including CRITICAL findings from iteration 1 that were resolved by the integrator before terminal APPROVE. Fix: `AND pr.iteration = rq.plan_review_iterations` restricts to terminal iteration. |
| **E-1** | **MAJOR** | INTEGRATED v3. The S64 preflight + circuit breaker contains TERMINAL PROVIDER errors but does NOT contain plan-review false-block cascades — REQUEST_CHANGES/BLOCKED outcomes call failJob + notify and the worker keeps polling. Without containment, an over-strict gate could fail multiple queued jobs before manual review catches the first one. Fix: §7.3 now prescribes a **throttled rollout** — disable scheduled task between jobs, manually trigger one spawn at a time for the first 5 jobs, observe gate decision, then proceed. Operationally heavy (~30 min/job) but contains blast radius. Skip ONLY if Phase 1+2 telemetry was unusually strong (n≥30, ≥90% approval, stable verdicts). |
| **E-2** | **MAJOR** | INTEGRATED v3. `plan_reviews` has RLS enabled (owner + same-organization read). An owner-scoped SQL run could sample one org while service-role/admin sees all. Fix: §4 header now requires service-role connection string for all readiness queries (alternative: per-org flip with `organization_id` filters, available but adds complexity; default = service-role). |
| **C-3** | **MAJOR** | INTEGRATED v3. v2's G-4 integration updated §7.1 pre-flip checklist but left §7.5 and §8 still describing the old misleading template as if it would persist. v3 §7.5 now provides concrete target strings (`subjectByStatus.REQUEST_CHANGES` = "Your research run was halted before execution"; explicit "NOT charged for `claude -p` spawn" body wording); §8 failure-mode row reframed from "Update email template" (future) to "G-4 update was applied (preventive) + manual outreach (detective)" (defense in depth). |
| D-1 | MINOR | INTEGRATED v3. §7.2 and §7.4 changed `Stop-Process -Name node -Force` (kills ALL node processes including dev sessions / tsx test runs / pnpm watch processes) to a PID-scoped Get-Content from `.worker.pid` + Stop-Process -Id. Includes fallback for missing PID file. §7.4 rollback also now includes Python `assert before == 1` on the `.env` substitution count so a malformed `.env` fails LOUD instead of silently doing the wrong thing. |

**Total MRPF cost for this DESIGN-gate:** 2 reviewer rounds, ~5.5 min wall-clock (Gemini 117s + Codex 211s), $0 (CLI subscription quota).

---

## Reinforcement: sequential MRPF v2.2 (CP Tracker S11-S13 + DR S45 + DR S64 + DR S65)

S65 produced another empirical data point for the v2.2 sequential rule. Each reviewer caught material findings the OTHER could NOT have caught alone:

| Round | Reviewer | Critical catches that the OTHER reviewer could NOT have caught alone |
|---|---|---|
| 1 | Gemini (holistic v1) | **G-1** (shadow-override SQL bug) — required reading `plan-reviewer.ts:finalize()` semantics + the design doc together and noticing the column-vs-overridden-marker mismatch. Codex's code-grounded pass on v1 would have found this too, but Gemini saw it via top-down trace. Also G-3, G-5, G-6 — all judgment calls on protocol risk-tolerance that benefit from a holistic read. |
| 2 | Codex (code-grounded on integrated v2) | **C-1** (`plan_review_status NOT NULL DEFAULT 'pending'` makes `IS NOT NULL` filter useless) — required actually reading the migration source. **C-2** (one-row-per-reviewer-per-iteration → cross-iteration finding contamination) — required understanding the plan_reviews schema. **E-1** (S64 backstop scope mismatch) — required reading executor.ts to know what the circuit breaker actually contains. **E-2** (RLS scope mismatch) — required reading the migration's RLS policy. NONE of these were visible from the design-doc-only read; ALL required code/schema grounding. |

**Critical reinforcement:** parallel-on-v1 would have lost the entire C-1/C-2/E-1/E-2 cluster. Codex's grounding budget on v1 would have been spent re-finding G-1 + G-4 (which Gemini already had) rather than verifying the integrated v2 queries against the actual migration. Sequential cost = 1 integration cycle (~30 min author wall-clock). Sequential benefit = 4 MAJOR code-grounded catches that would have shipped as protocol-breakers.

This is now the **5th consecutive empirical validation** of the sequential rule across Client Pipeline Tracker S11-S13 (4 Codex catches on post-Gemini-v2), DR S45 (3 catches), DR S64 (S64-B1 SDK-shape catch was the biggest), DR S64.1 (the dispatcher hotfix exposed an orchestrator-test gap reclassified MINOR→MAJOR retroactively), and now DR S65. The rule continues to dogfood-validate.

---

## v3 ship verification

| Check | Result |
|---|---|
| Design doc length | 514 lines (v1: 417, v2: 480, v3: 514) |
| Decisions section (§9) | 8 author decisions (A-H), 5 updated post-Gemini-integration with reviewer-ID provenance |
| Reviewer-focus areas (§11.A + §11.B) | Both completed; all 7 Gemini + all 6 Codex focus areas addressed |
| Rollout plan (§12) | 4-phase protocol: baseline → verdict stability → conditional tuning → throttled flip + monitoring |
| Companion docs to update on ship | Project CLAUDE.md §10, dryrun_handoff.md S65 entry, new memory `feedback_enforce_flip_phased_rollout.md` |
| Code change required pre-flip | YES — `agent/lib/notify.ts:buildPlanReviewEmail` template update (G-4 + C-3) — lands as separate MERGE-gate review during Phase 4 |
| Worker state | PID 40492 healthy + polling on S64 v3 + S64.1 dispatcher hotfix code. No protocol-time changes required |

---

## Deferred follow-ons (acceptable post-ship)

1. **The flip itself.** Operator-driven; gated on Phase 1 telemetry accumulating to n=10 organic-approved with the per-tier criterion met. Wall-clock to safe flip: 2-3 weeks under normal job volume.

2. **`buildPlanReviewEmail` template update.** Will need a small MERGE-gate review when implemented. Concrete strings prescribed in §7.5 v3. Sequential Gemini → Codex pass on the actual code diff. Estimated ~$0 (CLI quota), ~15 min.

3. **Bug 53b root-cause analysis.** Listed as a Phase 4 prerequisite (the gate may be rejecting on schema-validator-rejection rather than on plan quality). Investigation is separate engineering work; may surface during Phase 1 finding audit if it correlates with REQUEST_CHANGES rate.

4. **`PREFLIGHT_NOTIFY_EMAIL` setup.** Already prescribed in the §7.1 checklist; operator should configure it before Phase 4 (the S64 dogfood validated the rest of the architecture but the email path wasn't exercised because the env var was unset).

5. **Frontend gate preview UI.** Out of scope for the flip; the corrected email template covers the immediate communication gap. Would let submitters iterate inputs without spending a queue slot — separate UX project.

---

## What ships

- `Documentation/plan-review-enforce-flip-design-gate.md` (v3, 514 lines)
- `Documentation/plan-review-enforce-flip-design-gate-peer-review.md` (THIS DOC, synthesis)
- 2 new memory files (`feedback_node22_global_fetch_dispatcher_silent_drop.md` + `project_s64_dogfood_recovery_observed.md`) from Phase A capture
- MEMORY.md index updated
- Project CLAUDE.md §6 + `dryrun_handoff.md` updated with S64.1 + S65 entries
- 4 sandbox/working/ MRPF artifacts (PROMPT.md + response.txt + invocation scripts + stderr) preserved for audit trail

**Recommend on conversation end:** capture this synthesis to MEMORY.md as a new entry, then preserve operator authority over the flip itself. The plan is now sufficient to execute confidently when telemetry supports it — but the next action is on operator side (collect Phase 1 telemetry over 1-2 weeks of normal job volume). No code changes, no deploys, no flip this session. Worker continues healthy.
