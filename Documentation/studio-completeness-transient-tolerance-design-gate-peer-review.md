# S157 — Transient-tolerant studio-completeness gate — DESIGN-gate peer-review synthesis

Companion to `studio-completeness-transient-tolerance-design-gate.md`. Records the multi-reviewer DESIGN gate per `~/CLAUDE.md` §"Multi-Reviewer Policy Framework". **Gate: DESIGN** (new job-recovery control-flow + parallel job-state dimension = ARCHITECTURE; modifies the S129 safety control = AGENT-BEHAVIOR). Severity NORMAL. Topology: sequential both-lenses-adversarial — Gemini holistic → integrate → Codex grounded → integrate → Codex sequential-QA.

**Outcome: CLEARED (v3-FINAL).** Implementation-ready. The full tri-vendor **MERGE** gate (§14 of the design doc) is still owed before any code ships to the prod worker (`agent/` PROD → §11 hold-until-tri-vendor-clears, no substitute-then-owe).

## What each reviewer saw
- **Author pre-gate grounding (this session):** read the S129 gate source, the executor call-site, the worker poll loop + `probeBackoff`, the `staging-sweep` precedent, the `plan_review_gate.sql` data-model precedent, the baseline `status` CHECK + `update_updated_at` trigger, the claim route; plus a 13-agent grounded design judge-panel (workflow `wf_9c4a50c6-d83`: 6 grounding agents → 3 shape designs → 3 adversarial judges → synthesis). Ran an independent reaper/blast-radius grep (clean).
- **Gemini 2.5 Pro (holistic-adversarial, breadth):** design doc v1 + grounding source (`studio-completeness.ts`, executor call-site excerpt, `staging-sweep.ts`, `plan_review_gate.sql`, baseline status-CHECK + trigger). Log: `c:/tmp/dr-s157/gemini.log`.
- **Codex (grounded-adversarial, depth; `codex exec -s workspace-write`, ChatGPT auth, ~221k tok):** design doc v2 + the actual shipped files read in-sandbox (`studio-completeness.ts`, `executor.ts`, `worker.ts`, `staging-sweep.ts`, `api-client.ts`, `notify.ts`, `validate.ts`, `[id]/route.ts`, `finalize-recovered-run.ts`, `plan_review_gate.sql`, `.nonprod-baseline.sql`). Log: `c:/tmp/dr-s157/codex.log`.
- **Codex sequential-QA (fidelity):** design doc v3, spot-checked against the code. Log: `c:/tmp/dr-s157/codex-qa.log`.

## Round 1 — Gemini holistic-adversarial — VERDICT: BLOCK (4 findings, all integrated)
| # | Finding | Resolution |
|---|---|---|
| CRITICAL-1 | Idle-tick-only recovery starves under a sustained backlog (`claimJob()` never null → sweep never runs → age-cap hard-fail = delayed S156). | Sweep moved **before `claimJob` every poll tick** (decoupled from idleness), bounded + per-job-paced. |
| MAJOR-1 | Stringly-typed `error_message` marker is unsound for a safety control; mandate the typed-column `plan_review_*` pattern. | **DECISION-1 → Option A** (typed parallel columns); the marker option removed. |
| MINOR-1 | Reaper/`status='failed'` blast-radius audit framed as an open question, not a prerequisite. | Audit **run + clean** (no destructive reaper on `failed`); converted to a resolved finding + re-confirm-at-MERGE. |
| INFO-1 | Deferred fast-follow ships a red-"Failed"-while-recovering UX. | "Finalizing media" derivation **folded into the MVP**. |

## Round 2 — Codex grounded-adversarial (on the Gemini-integrated v2) — VERDICT: BLOCK (7 MAJOR + 1 MINOR; INFO confirms premises)
| # | Finding (file:line) | Resolution |
|---|---|---|
| MAJOR-1 | `probeBackoff()` `exit(0)`s before `poll()` (worker.ts:109-125) → recovery starves during a provider-backoff window, then wall-clock age-exhausts a never-tried job. | Bounded recovery slice **before the backoff exit** (NLM-only/$0, provider-independent) + **attempts-gated age cap** (`MIN_ATTEMPTS_FOR_AGE_EXHAUST`). |
| MAJOR-2 | The 120s tick budget can't interrupt the atomic `spawnSync timeout:300_000` (studio-completeness.ts:432) → up to 5 min/product claim delay. | Sweep passes a **shorter download timeout** (~90s); per-tick budget caps products *started*; honest ~one-timeout worst-case stated; true async deferred. |
| MAJOR-3 | Invariant over-broad — `completeJob` also at studio_only (executor.ts:1181) + dry-run (1099). | §9 rewritten **per-path** (S129 edge touched; studio_only/dry-run unchanged + out of scope). |
| **MAJOR-4 (keystone)** | `finalize-recovered-run.ts` fetches only `organization_id` (118-127), uploads everything, PATCHes `completed` — **no product-presence check** → reuse = fail-open. | `finalizeRecoveredRun()` **must fetch `selected_products`, `pickWinners`, assert every obliged product present before completing**; dedicated REFUSES-otherwise test. The sweep edge's fail-open guard. |
| MAJOR-5 | `updateJob` (api-client.ts:70-85) + `ResearchJob` (types.ts:161) lack `studio_recovery_*` → won't type-check. | Added `agent/api-client.ts` + `agent/types.ts` to the file list. |
| MAJOR-6 | `notifyTerminal` hardcodes the "failed" body (notify.ts:159-182) → a "softer string" still reads as failure. | Dedicated `sendDeliveryDelayedEmail` (non-terminal) replaces `notifyTerminal('failed')` on the recoverable branch. |
| MAJOR-7 | Terminal classifier too harsh for an **already-confirmed** `status_id 3` winner (a post-confirm 404/auth is almost certainly transient). | §4/§8 reframed: confirmed-winner errors **bias to transient**; only local-disk terminal; the sweep re-list is the real terminality decider. |
| MINOR | Frontend "chip" under-scoped (failed-row assumptions also stop timing + show Retry/Edit + allow hide). | Derive `isRecovering`; branch chip + terminal-treatment + Retry/Edit + hide on it. |
| INFO | Confirms the allowlist drops unknown columns + `first_failed_at` is trigger-immune. | Validates the data model (G6/G7). |

## Round 3 — Codex sequential-QA (fidelity on v3) — VERDICT: BLOCK→fixed→CLEARED
7/8 findings **APPLIED-FAITHFULLY**. Sole block: **MAJOR-7** — a stale v1 sentence in §4 ("fast-fail an obviously-terminal 404/auth") contradicted the v3 reframe. An internal-consistency defect, not a design flaw. **Fixed** exactly as Codex prescribed (§4 now: "fast-fail only truly-local terminal conditions … a 404/auth is transient"); a self-fidelity grep confirmed no other contradiction. A re-run for a one-sentence consistency edit (Codex already verified §8 substance + the other 7 findings) would be disproportionate → **CLEARED**.

## Synthesis
The architecture proposed in v1 — a decoupled recovery sweep + a third "recoverable-pending" outcome that never lets a missing product reach `completed` — **held through both adversarial vendors**. The two lenses caught *different* bug classes exactly as the topology intends: Gemini (breadth) caught the system-level load-starvation + the data-model coherence call; Codex (depth, grounded) caught the fail-open keystone (the existing finalize script has no obligation check), the per-path invariant, the backoff-starvation variant, and the implementation-completeness gaps (types, email helper, classifier scope). Net effect: v3 is materially safer than v1 — the fail-open surface is closed by an explicit obligation re-assertion on the new completion edge, and the recovery path is starvation-proof against both a busy queue and a provider-backoff window. No SECURITY-labeled CRITICAL remained; no disagreement requiring escalation. **DESIGN CLEARED; the code-level MERGE gate (full Gemini→Codex→Claude, before merge) is owed next.**
