# Peer-review record — Studio video best-effort completion (DESIGN gate, S185)

Companion to `studio-video-best-effort-completion-design-gate.md`. Captures the §11 sequential tri-vendor DESIGN gate: **Gemini holistic-adversarial → integrate → Codex grounded-adversarial → integrate → Codex fidelity-QA → CLEARED.** Raw reviewer transcripts: `/c/tmp/dr-s185/review/` (`gemini-v1.log`, `codex-v2.log`, `codex-fidelity.log` + the `*.mjs`/`*-prompt.txt` harnesses).

**Gate metadata:** Event Gate = DESIGN (downstream MERGE). Severity = NORMAL. Risk labels (for the downstream MERGE) = AGENT BEHAVIOR + DATA + ARCHITECTURE + INFRA. Topology = sequential (Gemini → Codex), both lenses adversarial, per `~/CLAUDE.md` §Review-Topology. Product decision (best-effort + alert) ruled by the human owner over Gemini's mandatory dissent.

## What each reviewer saw (§11 step-4 requirement)
- **Gemini round-1 (holistic-adversarial, breadth):** the **v1** design doc IN FULL + the **parent** transient-tolerance design IN FULL + 7 load-bearing source files pasted into the prompt (`state-evaluation.ts`, `studio-completeness.ts`, `finalize-recovered-run.ts`, `studio-recovery-sweep.ts`, `executor.ts`, `20260623_studio_recovery_dimension.sql`, `run-status.ts`). Model `gemini-3.1-pro-preview` (asserted in `gemini-v1.log`). It cannot execute code — a doc+source read.
- **Codex round-2 (grounded-adversarial, depth):** the **v2** design doc + the **live shipped repo** (read files in its `workspace-write` sandbox + ran greps; verified file:line). Model `gpt-5.5`, reasoning xhigh (run-banner asserted: `model: gpt-5.5`, `provider: openai`, `approval: never`, `sandbox: workspace-write`, `reasoning effort: xhigh`). 307,511 tokens, EXIT=0.
- **Codex round-3 (fidelity-QA):** the **v3** design doc + spot-checks of the shipped code cited in round-2. Model `gpt-5.5` xhigh. Confirmed faithful application; flagged 3 citation nits.

## Round 1 — Gemini holistic-adversarial → **VERDICT: BLOCK** (integrated as v2)
Gemini's framing: *"systemic fail-opens and fundamental composability breaks … the design fails to account for missing non-media deliverables, contradicts its own taxonomy split, and proposes a 'late attach' feature that is structurally impossible given the parent sweep's constraints."*

| # | Sev | Finding (verbatim gist) | Disposition |
|---|---|---|---|
| C-1 | CRITICAL | Gate-A interception conflates "studio-plausible" with "research complete" — a phase-5.5 crash (never ran phase 6/7) would be best-effort-completed missing its Vendor Evaluation / Finalization docs. Must positively assert those artifacts present before bypassing the terminal check. | Integrated → §5.1 deliverable-presence probe (refined further by Codex M-6). |
| C-2 | CRITICAL | Branch (b) and (c) don't compose (audio-blip + video-render → terminal-fails a doubly-recoverable run); `StudioRecoveryPayload` has no per-product discriminator. | Integrated → §4.2 composability rule + `recovery_kind`. |
| C-3 | CRITICAL | Cross-run contamination — a prior run's still-rendering video in a reused notebook could be falsely classified/attached. Apply the `runFloorMs` strict anti-stale filter to in-progress artifacts. | Integrated → §5.2 (refined by Codex C-3: persist in payload). |
| M-1 | MAJOR | "Late attach" is dead-on-arrival — `fetchDueCandidate` pins `.eq("status","failed")`, so a completed row is never re-claimed; §7.3/I4 broken. | Integrated → single-completion hybrid; D-1b rejected. |
| M-2 | MAJOR | Billing/usage ledger leak — recovered runs delivered `completed` but `recordUsage` logs `failed`; sweep/finalize never call `recordUsage`. | Verified + integrated (refined by Codex C-1). |
| D-1/D-7 | — | **Recommended mandatory over best-effort** — same benefit for Veo3 latency without the fail-open; on a genuine outage the run *should* fail so operators are alerted + the user isn't charged. | Recorded as dissent; **human owner ruled best-effort + alert**, folding in Gemini's safety asks (operator alert + honesty + billing). D-1a↔D-7 kept a one-branch swap. |

Gemini's per-decision guidance (D-2a+discriminator, deliverable-presence Gate-A scope, `runFloorMs` proof, 120-min window, no prompt-side hint) adopted in §10.

## Round 2 — Codex grounded-adversarial on v2 → **VERDICT: BLOCK** (integrated as v3)
All findings are **implementability corrections** — Codex endorsed the design DIRECTION (D-3/D-7/D-8/D-10 "supported"). Full verbatim in `codex-v2.log` lines ~13592-13657.

| # | Sev | Finding (file:line) | Disposition (v3) |
|---|---|---|---|
| C-1 | CRITICAL | Billing fix infeasible: `recordUsage` plain INSERT, no unique key on `research_queue_id` (`usage-tracking.ts:344-370`; `20260525_research_usage_telemetry.sql:46-76,100-101`); sweep lacks `stdoutBuf/exitCode/model/tokens/duration/cost` (`:312-330`). A 2nd call double-records. | §7.3/D-9 — idempotent `markUsageCompleted` UPDATE of the existing row's `job_status`; never re-INSERT. |
| C-2 | CRITICAL | Render detection impossible on current API: `realListArtifacts` lists completed-only (`nlm-artifact-cli.ts:85,:117-119`, refs lack `status_id` `:120-121`); sweep consumes it (`studio-recovery-sweep.ts:344`). | §5.2/§6/G5 — NEW `listArtifactsWithStatus` helper. |
| C-3 | CRITICAL | `runFloorMs` not reachable in sweep; `studio_before_ids.json` is prompt-side; sweep doesn't load workdir (`studio-recovery-sweep.ts:95-104,162-163`; `artifact-timestamps.ts:62-85`). | §5.2/§7.1/G6 — persist `videoTaskId` + `runFloorMs` in payload at park time. |
| M-4 | MAJOR | New `video_rendering` status value needs CHECK+enum+Zod+index+query (`studio-recovery-sweep.ts:577-579`; `migration:78-88,145-147`; `types.ts:37`; `validate.ts:346-351`). | §7.1/D-2 — reuse `'pending'` + payload `recovery_kind`; minimal additive `video_deferred` marker. |
| M-5 | MAJOR | Required `recovery_kind` breaks in-flight pending download rows. | §6/§7.1 — optional, absent ⇒ `'download'`. |
| M-6 | MAJOR | Probe source-contract wrong: `report` is a Studio product; research roles `conventions.json:58-70`; publish from `state.publish_verification` (`publish-gate.ts:309-325`), publish-jobs-only. | §5.1/G11 — corrected role set + `evaluatePublishGateForJob` + publish-only. |
| M-7 | MAJOR | Finalizer fetches only `org,selected_products` (`finalize-recovered-run.ts:80-83,379-395`) — a carve-out needs more. | §7.2 — `finalizeBestEffortRun` fetches payload/state/publish; narrow, non-force. |
| M-8 | MAJOR | Gate-A interception must fire AFTER terminal-error classification (`executor.ts:325-339,351-355,378-400,457`) + synthesize `verdict.state`. | §5.1/§4.2/G2 — ordered after classification. |
| M-9 | MAJOR | Results page reads `/api/state` which carries no recovery fields (`useRunState.ts:86-99`; `api/state route:100-112`). | §7.4 — plumb `video_deferred` to a results-page data source. |
| M-10 | MINOR | Notify copy false for render/best-effort (`notify.ts:136-152,223-237,579-589`). | §7.5 — distinct copy arms. |

Codex "Supported Claims": `JobStatus` enum unchanged is correct; empty-file guards exist; `result_slug=topic_slug` is safe (no standalone `result_slug` uniqueness).

## Round 3 — Codex fidelity-QA on v3 → **VERDICT: BLOCK on 3 citation nits → fixed → CLEARED**
7/10 corrections confirmed FAITHFUL (C-2, C-3, M-4, M-5, M-7, M-8, M-10). 3 NOT-FAITHFUL, all citation/consistency (no design/mechanism impact), now fixed:
- **C-1** — column named `final_job_status`; shipped is `job_status` (`usage-tracking.ts:350-353`). Fixed in §7.3.
- **M-6** — role list contradictory (G11 listed 7 roles incl. `context`/`state`; §0/§5.1 listed 5). Reconciled in G11 (probe targets the 5 research-text deliverables; `context`/`state` excluded).
- **M-9** — API path `api/state/[slug]/route.ts` → `frontend/app/api/state/route.ts` (slug is a query param). Fixed in G12/§11.

## Synthesis / outcome
- **DESIGN gate CLEARED.** Both vendors endorse the direction; **6 CRITICAL + 8 MAJOR** blocking findings across rounds 1–2 resolved in v3; 3 fidelity nits fixed.
- **Value realized:** the gate caught **6 CRITICAL implementability blockers before any code was written** (billing non-idempotency, completed-only artifact API, unreachable run-floor, cross-run contamination, masked phase-6/7 crashes, broken (b)+(c) composability). Cheap at design stage; expensive post-implementation.
- **Product decision:** best-effort + alert (human-owner ruling; Gemini's mandatory dissent recorded + its safety asks folded in). Reversible via the D-1a↔D-7 one-branch swap.
- **Downstream:** implementation requires a separate **FULL tri-vendor MERGE gate** (`agent/` prod → §11 HARD RULE, no substitutes), migration-first deploy order, dark-launch flag. The billing fix (G9/D-11) is independently shippable and retro-fixes the existing S162 mis-billing.

## Disagreement record (§11)
One non-security disagreement: Gemini recommended **mandatory** (D-7); the human owner ruled **best-effort + alert** (D-1a). Rationale recorded in the design doc §4.1. No third-model tiebreaker invoked (per the disagreement procedure — the human owner decides non-security disagreements). The decision is reversible (one-branch swap) and the safety concerns Gemini raised are addressed by the operator alert + honest UI + billing fix.
