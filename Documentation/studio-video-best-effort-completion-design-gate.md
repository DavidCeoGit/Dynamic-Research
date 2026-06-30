# S185 — Best-effort completion for a still-rendering Studio video (DESIGN gate)

> **Gate:** DESIGN → (downstream) MERGE. **Status:** v3-FINAL — **DESIGN gate CLEARED.** Gemini round-1 (holistic-adversarial, BLOCK → integrated v2) → Codex round-2 (grounded-adversarial, BLOCK → integrated v3) → Codex round-3 (fidelity-QA, BLOCK on 3 citation nits → fixed → CLEARED). Both vendors endorse the DIRECTION; all blocking findings resolved. Implementation is a separate FULL tri-vendor MERGE gate (§13).
> **Severity:** NORMAL. **Risk labels (downstream MERGE):** AGENT BEHAVIOR (worker completeness/finalize logic propagates to every run), DATA (run-status transitions; a `completed` row deliberately missing the video; billing-ledger correctness), ARCHITECTURE (cross-cutting executor ↔ state-evaluation ↔ studio-completeness ↔ recovery-sweep ↔ finalize ↔ nlm-artifact-cli ↔ usage-tracking ↔ schema ↔ frontend), INFRA (one additive migration). **§11 HARD RULE applies to the eventual `agent/` prod merge — FULL Gemini + Codex + Claude BEFORE merge, no substitutes.**
> **Extends:** `studio-completeness-transient-tolerance-design-gate.md` (S157, v3-FINAL CLEARED). Amends its §2/§4/§7/§9/§10. Read it first.
> **v3 mechanism corrections (Codex-grounded — supersede any v2 phrasing):** (1) **No new `video_rendering` status value** — reuse `studio_recovery_status='pending'` for the render-park; the render-vs-download distinction lives in a per-product payload `recovery_kind` (optional, default `'download'`). (2) **Detection needs a NEW status-aware list helper** — the shipped `realListArtifacts` is completed-only (`nlm-artifact-cli.ts:117-119`) and cannot see a rendering artifact. (3) **Anti-stale via payload** — persist exact `videoTaskId` + `runFloorMs` into `studio_recovery_payload` at park time (the sweep cannot recompute the run floor). (4) **Billing fix = idempotent UPDATE of the existing `research_usage` row**, NOT a second `recordUsage` (which is a plain INSERT and lacks the token/cost inputs at sweep time). (5) **Probe contract corrected** — `report` is a Studio product; research-text roles are brief/perplexity/comparison/vendor-evaluation/notebooklm (`conventions.json:58-70`); claims live in `state.publish_verification` (`publish-gate.ts:309-325`) and apply **only to publish jobs**. (6) **Gate-A interception fires AFTER the existing terminal-error classification** (`executor.ts:378-400`/`:325-339`) and must synthesize `verdict.state`. Full findings + dispositions: §14.2.

---

## 0. TL;DR / recommendation

A run whose **only** outstanding deliverable is the **Studio video — still rendering in NotebookLM at the worker checkpoint** is today **hard-failed**, though the 4 other Studio products + research docs are done and claims PASSED (S184 incident, run `eac58954`, Meridian). The video completes in NLM minutes later; the run is already `failed`.

**Product decision (user, re-confirmed after Gemini round-1): BEST-EFFORT + ALERT.** A still-rendering video must never fail an otherwise-complete run; on a genuine render outage the run still completes with the 4 products + research docs, the video is marked **unavailable honestly**, an **operator alert fires**, and **billing records `completed`**. (Gemini recommended *mandatory*; recorded as dissent §4.1/§14.1; human-owner ruled best-effort+alert; D-1a↔D-7 kept a one-branch swap.)

**Resolved shape:** a new taxonomy branch **(c) — "selected video still rendering at checkpoint"**, handled by a **worker-authoritative render-window hybrid**:
1. **Detect** from durable signals, never trusting LLM `phase`/`phase_status`: video selected, **every non-video deliverable present non-empty** (4 non-video selected studio products + the research-text docs), **publish/claims passed where applicable**, and the video is **provably *this run's* render** (an exact persisted `videoTaskId`, cross-checked against a **status-aware** NLM list, with a `runFloorMs` anti-stale floor so a prior run's video can't be mistaken for this one).
2. **Park, don't fail.** The run stays `status='failed'` + `studio_recovery_status='pending'` (reusing the S162 dimension + "Finalizing media" UI, copy tuned to rendering), with a payload tagged `recovery_kind:'render'` carrying `videoTaskId` + `runFloorMs`. The decoupled sweep polls a **status-aware** NLM list until the video reaches `status_id 3`, downloads it, and finalizes with all 5 (common case).
3. **Single terminal completion.** The run completes **once**: video lands within the **render window** → `completed` all 5; or the window exhausts → **best-effort `completed`** with 4 + research docs, video marked unavailable, **operator alert + corrected billing**. No "attach to an already-completed run" (the sweep query pins `status='failed'`).

**Composability:** Branch (b) [download-blip] and (c) [render] **compose** — recoverable iff every still-missing product is (b) **or** (c); each pending product carries `recovery_kind` so the sweep dispatches per-product.

The cost: this **relaxes the parent invariant** ("never `completed` while a selected product missing") **for the video, on the outage tail only**. §8 reframes it (I1–I7); the implementation MERGE gate (full tri-vendor) re-verifies against code.

---

## 1. The problem — S184 incident, run `eac58954` (Meridian), grounded in the real `state.json`

Reached Studio, downloaded report+infographic+slides+audio, wrote all research docs, **passed claims** — then `claude -p` exited at ~50 min (NOT the 90-min cap) with the video rendering. Hard-failed ~54 s later.

Real `state.json` (`…/migrating-meridian-operations-group-mog-56397f88/20260628-214430-state.json`): `phase:"5.5"`; `phase_status` a descriptive non-`complete` string ("…video rendering (background watcher); claim verification … complete and PASSING…"); `notebook_id` present; `selectedProducts` all 5; `artifacts.video.task_id = c2dfc378-…`; `publish_verification` PASSING. On disk: all research docs + 4 non-video studio products + `publish_verification.json` — everything but the video. `titles_video.json` (the prompt's NLM snapshot): the video artifact `status:"in_progress", status_id:1, created_at:"2026-06-28T22:16:17"`.

**Which gate fired: Gate A**, `evaluateCompletion()` (`state-evaluation.ts:285`), at `executor.ts:398` — `Pipeline stopped at phase 5.5 (Studio Products); expected phase_status="complete" OR phase>=7`. The pipeline never wrote phase 7 (its `video_watch.py` polls by `task_id`; `notebooklm artifact poll` lies `in_progress` post-render — S129 — and the watcher is orphaned when `claude -p` exits). **S162 doesn't catch it:** the video was never `status_id 3` at the checkpoint → no `winner` → no `recoverablePending` → no dimension → `studio_recovery_status='none'`, never selected. The parent deliberately routes this to fail-closed. **That exclusion is the gap.**

---

## 2. Relationship to the parent (unchanged from v2)

Branch (b) = confirmed-`status_id 3`-but-download-blipped (parent). Branch (c) = not-yet-`status_id 3`, still rendering (this design). (b) manifests at Gate B; (c) at Gate A *or* B. (b) re-downloads; (c) poll-for-render-then-download. (b) completes with all products; (c) may complete with the video deferred on the outage tail. **(b) and (c) compose.** Reuses: typed `studio_recovery_*` dimension, sweep scheduling, "Finalizing media" UI, caps/backoff, `finalizeRecoveredRun` keystone. Adds (all Codex-grounded): a deliverable-presence Gate-A interception (after terminal-classification), a **status-aware** NLM list helper, a render-poll sweep action, per-product `recovery_kind` + persisted `videoTaskId`/`runFloorMs`, a best-effort completion edge, an **idempotent billing-row update**, and an honest results-page "video unavailable" surface.

---

## 3. Grounding (load-bearing real-code facts — Codex-verified file:line)

- **G1 — Two gates:** Gate A `evaluateCompletion` (`state-evaluation.ts:285`, `executor.ts:374`→`:398`); Gate B `enforceStudioCompleteness` (`studio-completeness.ts:178`, `executor.ts:458`, guarded `if (verdict.state)` `:457`).
- **G2 — Gate-A bypass precedent + ORDERING:** S136 duration-kill classifies subprocess errors FIRST (`executor.ts:325-339`), synthesizes a recoveryVerdict with `state` (`:351-355`) → Gate B runs. After a normal Gate A, terminal publish/auth/credit/model failures are classified before failing (`:378-400`). **Our interception MUST fire only after that classification, and synthesize `verdict.state`** (Codex MAJOR-8).
- **G3 — Obligation = durable `selected_products`** (`studio-completeness.ts:149`, `executor.ts:459`); 0-byte filtered (`:196`).
- **G4 — Branch (a) still-rendering = terminal today** (`studio-completeness.ts:327-331` → `purelyTransient` false → `executor.ts:566`).
- **G5 — Detection API LIMIT (Codex CRITICAL-2):** `realListArtifacts` lists **completed-only** (`nlm-artifact-cli.ts:85`, filters `status_id===3||undefined` `:117-119`, refs lack `status_id` `:120-121`); `CompletenessDeps.listArtifacts` is "COMPLETED artifacts" (`studio-completeness.ts:83-85`); the sweep consumes that completed-only list (`studio-recovery-sweep.ts:344`). **A rendering video is invisible to current code** — a new status-aware list helper is required (the underlying `notebooklm artifact list` CLI returns `status_id`, proven by the prompt's `titles_video.json`).
- **G6 — Anti-stale source (Codex CRITICAL-3):** `studio_before_ids.json` is a **prompt-side** file, NOT read by worker code. `deriveRunStart` derives from on-disk winners / `state.artifacts.*.file` / `state.timestamp` (`artifact-timestamps.ts:62-85`). The sweep carries only DB fields + payload (`studio-recovery-sweep.ts:95-104`), resolves `Projects/<topic_slug>` (`:162-163,:311`), does NOT load the workdir/state; current payload has only `notebookId` + completed download refs (`executor.ts:507-515`). **⇒ persist `videoTaskId` + `runFloorMs` INTO the payload at park time.**
- **G7 — `finalizeRecoveredRun` keystone** (`finalize-recovered-run.ts:192-215`, `--force` bypasses lint only `:141-156`); fetches only `organization_id, selected_products` (`:80-83,:379-395`). **A best-effort carve-out needs more data** (Codex MAJOR-7).
- **G8 — Sweep query pins `status='failed' + studio_recovery_status='pending'`** (`studio-recovery-sweep.ts:577-579`); partial index pending-only (`migration:145-147`); CHECK allows `none|pending|recovered|exhausted` (`migration:78-88`); enums match (`types.ts:37`, `validate.ts:346-351`). **⇒ reuse `'pending'`, don't add a status value** (Codex MAJOR-4).
- **G9 — Billing leak + non-idempotency (Codex CRITICAL-1):** `executor.ts:273` default `failed`; `:615-619` set `complete`; `recordUsage` in `finally` `:621-632`; recovery branch throws at `:523-561` → recorded `failed`. `recordUsage` is a plain INSERT (`usage-tracking.ts:344-370`) into `research_usage` with NO unique constraint on `research_queue_id` (`20260525_research_usage_telemetry.sql:46-76,100-101`), and needs `stdoutBuf/exitCode/model/tokens/duration/cost` (`:312-330`) absent at sweep time. **⇒ idempotent UPDATE of the existing row's status; never re-INSERT from sweep/finalize.** (Retro-fixes existing S162 mis-billing.)
- **G10 — Payload product shape:** `{product, artifactId, nlmType, filename}` (`executor.ts:507-515`, `types.ts:44-49`, `validate.ts:358-367`); `productsWellFormed` validates those only (`studio-recovery-sweep.ts:213-224`); CHECK requires non-null payload, not element shape (`migration:102-112`). **⇒ `recovery_kind` OPTIONAL, default `'download'`** (Codex MAJOR-5 backward-compat).
- **G11 — Deliverable contract (Codex MAJOR-6):** `conventions.json:58-70` lists 7 research roles — brief/perplexity/comparison/vendor-evaluation/notebooklm/**context**/**state**. The deliverable-presence probe (§5.1) targets only the **5 research-text DELIVERABLES** (brief/perplexity/comparison/vendor-evaluation/notebooklm); **`context`** is pipeline INPUT and **`state`** is the internal state file — both are excluded from the probe (their absence is not a deliverable gap). **`report` is a Studio product** (`:44-49`), NOT research-text. `uploadOutputs` uploads all non-skip files (`upload-set.ts:46-55`); lint enforces Studio coverage, not research-doc coverage (`lint-deliverables.ts:269-291`). Publish read from `state.publish_verification` via `evaluatePublishGate*` (`publish-gate.ts:309-325`), **only for publish jobs**.
- **G12 — Frontend results data path (Codex MAJOR-9):** results page reads `state.json` via `useRunState` (`useRunState.ts:86-99`); `/api/state` returns normalized state only (`frontend/app/api/state/route.ts:100-112` — slug is a query param, not a path segment); plan-review API selects no recovery fields (`plan-review/route.ts:44-48,:67-78`). Dashboard duplicates the `failed+pending` predicate (`page.tsx:269-275`) vs the helper (`run-status.ts:14-20`). **⇒ recovery/best-effort metadata must be plumbed to a results-page data source.**
- **G13 — Supported (Codex):** `JobStatus` stays unchanged (`types.ts:13`); empty-file guards exist (`studio-completeness.ts:187-197`, `upload-outputs.ts:75-84`, `finalize:248-263`); `result_slug=topic_slug` safe (`topic_slug` unique `20260522_phase_a_multi_tenancy.sql:169-175`; no standalone `result_slug` uniqueness).

---

## 4. Decision + taxonomy extension (Branch (c))

### 4.1 Product decision — BEST-EFFORT + ALERT (re-confirmed; Gemini dissent recorded)
Unchanged from v2 §4.1. Gemini round-1 recommended mandatory (D-7); human-owner ruled best-effort+alert; concerns addressed by operator alert (§7.5) + honest UI (§7.4) + billing fix (§7.3); D-1a↔D-7 a one-branch swap. Codex round-2 confirmed best-effort is "mechanically feasible, but must not ship before billing and anti-stale are fixed" (D-7) — both now fixed in v3.

### 4.2 Branch (c) + composability (Gemini C-2 + Codex)
> **Branch (c):** video **selected**, **not yet `status_id 3`** (rendering, via the new status-aware list), **provably this run's render** (exact `videoTaskId` match, else an in-progress artifact with `created_at >= runFloorMs` — never stale/foreign), **every non-video deliverable present** (4 non-video studio + research-text docs per G11), **publish/claims passed where applicable** (G11 — only publish jobs). Does not fail-closed.

**Composability rule (replaces parent iff):** recoverable-pending iff **every** still-missing obliged product is (b) **or** (c); each pending product tagged `recovery_kind:'download'|'render'`. Terminal-fail only when some still-missing product is neither.

**Hard exclusions (terminal-fail unchanged):** any non-video deliverable missing/0-byte; video not selected; not provably this run's render (no `videoTaskId` match AND no in-progress artifact `>= runFloorMs`, or artifact `failed`); publish/claims failed (publish jobs); no studio progress (early crash, §5.1); **any terminal-error classification present** (G2/§5.1).

### 4.3 Mechanism — render-window hybrid (D-1 RESOLVED → D-1a)
Park `status='failed' + studio_recovery_status='pending'` (reuse dimension + UI; payload `recovery_kind:'render'` + `videoTaskId` + `runFloorMs`). Sweep polls the status-aware list until `status_id 3`, downloads, finalizes all 5. Run completes once. **D-1b rejected** (Gemini M-1: sweep can't re-claim a `completed` row).

### 4.4 Invariant cost (MERGE gate: attack)
Relaxes the parent invariant for the video on the outage tail only. §8 (I1–I7). Fallback = one-branch swap to mandatory (D-7).

---

## 5. Detection (worker-authoritative)

### 5.1 Gate-A interception — gated on DELIVERABLE PRESENCE, AFTER terminal-classification (Codex C-1/M-6/M-8, D-4)
When `evaluateCompletion` → `success:false`: **first** run the existing terminal-error classification (credit/auth/billing/model) exactly as `executor.ts:378-400`/`:325-339` do today — if any terminal error is classified, **fail fast, unchanged** (never park a credit/auth failure as rendering). Only if NO terminal error AND the phase is non-terminal, run a **deliverable-presence probe** (worker-side, durable, built from `conventions.json` roles G11):
- all research-text docs (brief/perplexity/comparison/vendor-evaluation/notebooklm) present non-empty; all **non-video** selected Studio products present non-empty; for **publish jobs only**, `evaluatePublishGateForJob` over `state.publish_verification` passes; `notebook_id` present.
- probe passes AND only the video is missing → synthesize a verdict carrying `state` (G2) → flow into Gate B.
- else → terminal-fail at Gate A, unchanged (a genuine phase-2/phase-6 crash, a missing research doc, or a failed publish never reaches best-effort).

### 5.2 Branch-(c) classification in Gate B — via a NEW status-aware list + anti-stale (Codex C-2/C-3, D-5)
Add `listArtifactsWithStatus(notebookId, nlmType)` to `nlm-artifact-cli.ts` returning artifacts WITH `status_id` + `created_at` (the existing `realListArtifacts` stays completed-only for its current callers). For `video ∈ stillMissing`:
- exact `videoTaskId` match in the list → this run's video: `status_id 3` → Branch (b) (download now); not-`failed`/not-3 → Branch (c); `failed` → terminal.
- else an in-progress artifact with `created_at >= runFloorMs` → Branch (c); **older than `runFloorMs` → foreign/prior-run → ignored.**
- no matching artifact AND no `videoTaskId` → terminal. list `null` (CLI blip) AND `videoTaskId` present → render-status-unknown → keep-waiting (§5.3).

At park time the executor writes `studio_recovery_payload` with `recovery_kind:'render'`, the exact `videoTaskId`, and `runFloorMs` (from `deriveRunStart`, available in the executor context) so the sweep needs no workdir reload (G6).

### 5.3 Transient-list safety
`listArtifactsWithStatus` → `null` with a persisted `videoTaskId` ⇒ keep-waiting (bounded by render-window caps §9), never terminal. Exact-match `videoTaskId` + `runFloorMs` is the spoof guard.

---

## 6. Sweep action — per-product dispatch (Codex C-2/M-4/M-5)
Each pending product carries `recovery_kind` (absent ⇒ `'download'`, backward-compat). Dispatch:
- **`download` (b, existing):** confirmed `status_id 3` → `downloadArtifact(by id)`.
- **`render` (c, new):** `listArtifactsWithStatus` re-check with the same anti-stale filter (§5.2) using the payload's `videoTaskId`+`runFloorMs`:
  - reached `status_id 3` → `downloadArtifact(by the list-canonical id`, S138 Layer-1).
  - still rendering under caps → bump attempts, backoff, keep waiting.
  - `failed` / render-window exhausted → best-effort completion (§7.2).
Finalize fires only when every pending product (both kinds) is present non-empty → `finalizeRecoveredRun` (all 5). Render-only-remaining + window exhausted → `finalizeBestEffortRun` (§7.2). Sweep selection unchanged (reuses `failed+pending`, G8).

---

## 7. Data model + completion edge

### 7.1 Data model — REUSE `'pending'`, payload discriminator, minimal additive marker (Codex M-4/M-5, D-2 REVISED)
- **No new `studio_recovery_status` value** for the render-park: reuse `'pending'` (sweep query, UI predicate, partial index, CHECK all already work). Render-vs-download = the payload `recovery_kind`.
- **Payload:** add `recovery_kind?: 'download' | 'render'` (optional; absent ⇒ `'download'`) + persist `videoTaskId: string` + `runFloorMs: number` for `'render'` products. Extend `productsWellFormed` to accept these (and validate `recovery_kind ∈ {download,render}` when present). No CHECK change needed (element shape is code-validated, G10).
- **Video-deferred-on-completed marker:** the best-effort completion needs to mark a `completed` run as missing-its-video for the results-page banner. Minimal additive options (MERGE-time pick, no CHECK churn): (a) a new nullable column `studio_recovery_video_deferred boolean DEFAULT false`; (b) a payload flag read post-completion. **Lean (a)** — a typed column the results-page query can select directly (vs `'video_unavailable'` as a new status value, which Codex M-4 showed costs CHECK+enum+Zod+index+query). `studio_recovery_status` on a best-effort completion = `'recovered'` + `video_deferred=true`.

### 7.2 The single terminal completion edge (D-3, Codex M-7)
Run completes once, from the sweep:
- **All present (video landed):** `finalizeRecoveredRun` (unchanged keystone) → `completed`, `studio_recovery_status='recovered'`.
- **Render window exhausted:** a **separate** `finalizeBestEffortRun({ deferred: 'video' })` (NOT a broad `deferredProducts` param — Codex M-7/D-3 prefer a narrow, separately-auditable function; `video` is the only deferrable value, never `--force`-bypassable). It fetches the extra data the current finalizer lacks (G7): `selected_products`, the recovery payload (proves render was launched via `videoTaskId`), and — for publish jobs — `state.publish_verification`. It then:
  1. Re-asserts obligations over `obligedProducts(selected_products) \ {video}` — every non-video obliged product present non-empty.
  2. Re-asserts research-text docs present (G11) + publish/claims passed (publish jobs only).
  3. Requires `selected.video===true` + a persisted exact `videoTaskId` — refuse otherwise.
  4. Lint + non-empty inventory + failed-upload guard C2 unchanged.
  5. PATCH `status='completed'`, `result_slug=topic_slug` (G13), `studio_recovery_status='recovered'`, `studio_recovery_video_deferred=true`, `studio_recovery_error='video render exceeded window'`.
  6. Fire operator alert + **update billing** (§7.3).
Fenced by (1)+(2)+(3)+(4) — cannot fire for any non-video gap, missing research doc, failed publish, never-launched video, or lint/upload failure.

### 7.3 Billing fix — idempotent row UPDATE (Codex C-1, D-9) + no attach-after-complete (Gemini M-1)
- **Billing:** add an idempotent `markUsageCompleted(researchQueueId)` to `usage-tracking.ts` that **UPDATEs** the existing `research_usage` row's **`job_status`** column to `complete` (the column is `job_status`, `usage-tracking.ts:350-353` / `20260525_research_usage_telemetry.sql:52-53` — the `finalJobStatus` opt name maps to it; keyed by `research_queue_id`), called from both finalize edges. Do NOT call `recordUsage` (plain INSERT, lacks sweep-time inputs, would double-bill, G9). If no row exists yet (edge), no-op + log. Idempotent across sweep retries. (Retro-fixes existing S162 recovery mis-billing — independently shippable, §13.)
- **No attach-after-complete:** the run is `failed`+parked until the *single* terminal completion (§4.3), so no `completed` row ever awaits a video (G8). A video that lands after a best-effort completion is NOT attached (the run already shipped honestly as `video_deferred`). A future completed-row attach path is **out of scope** (D-10).

### 7.4 Frontend — results-page plumbing, not just predicate reuse (Codex M-9)
- In-flight detail + dashboard: predicate fires for `failed`+`pending`; for `recovery_kind:'render'` show "video still rendering" copy (not "download hiccup"). Dedup the duplicated dashboard predicate to the `run-status.ts` helper + parity guard (G12).
- **Results page (`runs/[slug]/`):** plumb `studio_recovery_video_deferred` (+ `studio_recovery_status`) into a results-page data source — either extend `/api/state` output or add a small recovery-fields endpoint (G12: the results page reads `/api/state`, which today carries no recovery fields). Render a non-blocking banner "🎬 The video was unavailable for this run" when `video_deferred`.

### 7.5 Notify — distinct copy arms (Codex M-10)
Current copy is wrong for the new paths (completion email asserts video available `notify.ts:136-152`; delayed-delivery says download-hiccup `:223-237`; exhausted says confirmed-complete `:579-589`). Add: **render-wait** ("your media is finalizing"), **best-effort completion** (normal success email + "your video was unavailable for this run" + a distinct **operator outage alert**), and **render-exhausted** copy.

---

## 8. Reframed HARD INVARIANT + fail-open proof
**(I1)** Never `completed` while any non-video selected product, or any research-text deliverable, is missing/0-byte, or (publish jobs) claims not passed (§5.1 probe + §7.2 1-2). **(I2)** Video absent on `completed` only when selected + render provably launched (exact `videoTaskId`) + non-video deliverables satisfied + publish/claims passed + render window exhausted (§7.2 1-3). **(I3)** Video absence surfaced honestly (results-page banner via `video_deferred` + email note) (§7.4-5). **(I4)** Genuine outage fires an operator alert (§7.5). **(I5)** Completes exactly once (failed+parked until one terminal decision; never un-completes; no orphaned attach row) (§4.3/§7.3/G8). **(I6)** Billing records `completed` via idempotent UPDATE — no ledger divergence, no double-bill (§7.3/G9). **(I7)** Fail-closed unchanged for any non-video gap, missing research doc, failed publish, never-launched/`failed` video, foreign/stale artifact, early crash, or any terminal-error classification (§4.2/§5.1).

**No-fail-open proof:** (1) interception runs only after terminal-classification + a passing deliverable-presence probe (§5.1) → no early/mid crash or credit/auth failure masked (Codex C-1/M-8 closed). (2) render classification requires exact `videoTaskId` + `runFloorMs` anti-stale via the status-aware list (§5.2) → no foreign video (Codex C-2/C-3 closed). (3) composability routes mixed (b)+(c) to recovery (§4.2). (4) best-effort edge re-asserts the full non-video obligation set + research docs + publish + `videoTaskId` (§7.2). (5) single completion avoids the dead attach-after-complete query (§7.3/G8). (6) honesty + alert + idempotent billing (I3/I4/I6). Reject I2 → one-branch swap to mandatory (D-7).

---

## 9. Boundedness + caps
**Render window** `STUDIO_VIDEO_RENDER_MAX_AGE_MS` default 120 min from `first_failed_at`, attempts-gated; render backoff faster than download (2m,5m,10m,15m…). Render-failed/artifact-gone → fast terminality → best-effort + alert. Env-tunable, NaN/safe; DR-Deploy `.env` unchanged.

---

## 10. Open decisions (post-Gemini + Codex)
- **D-1 — RESOLVED → D-1a** render-window hybrid (D-1b rejected).
- **D-2 — REVISED → reuse `'pending'` + payload `recovery_kind` + a minimal additive `video_deferred` marker** (Codex M-4/M-5; NOT a new `video_rendering`/`video_unavailable` status value).
- **D-3 — RESOLVED → separate `finalizeBestEffortRun`** (narrow, only-`video`, non-force; Codex M-7).
- **D-4 — RESOLVED → deliverable-presence probe AFTER terminal-classification**, using corrected `conventions.json` roles + `evaluatePublishGateForJob`, publish-only claims (Codex M-6/M-8).
- **D-5 — RESOLVED → persist `videoTaskId` + `runFloorMs` in the payload** + a status-aware list helper (Codex C-2/C-3; the sweep cannot recompute the floor).
- **D-6 — render TTL 120 min** (needs the status-aware list; Codex no conflict).
- **D-7 — mandatory fallback** kept as a one-branch swap; not adopted (user). Codex: feasible, must not ship before billing+anti-stale fixed → both fixed in v3.
- **D-8 — RESOLVED → no prompt-side hint** (worker-authoritative; both reviewers concur).
- **D-9 — REVISED → idempotent `research_usage` row UPDATE** (`markUsageCompleted`), NOT `recordUsage` (Codex C-1).
- **D-10 — late video after best-effort: OUT of scope** (no completed-row attach; Codex supports given the failed-row-pinned sweep).
- **D-11 (new) — billing fix is independently shippable** and retro-fixes S162 — consider landing first as a small standalone MERGE (§13).

---

## 11. Files (MVP — downstream MERGE)
- `agent/lib/nlm-artifact-cli.ts` — **NEW `listArtifactsWithStatus`** (status-aware; `realListArtifacts` unchanged).
- `agent/lib/state-evaluation.ts` — Gate-A interception AFTER terminal-classification (defer-vs-terminal via the probe).
- `agent/lib/studio-completeness.ts` — Branch-(c) classify via the status-aware list + `videoTaskId`/`runFloorMs` anti-stale + composability + `videoStillRendering`.
- `agent/executor.ts` — park sub-branch writing `recovery_kind:'render'` + `videoTaskId` + `runFloorMs`; compose (b)+(c).
- `agent/lib/studio-recovery-sweep.ts` — per-product `recovery_kind` dispatch; render-poll; best-effort completion at exhaustion; render caps; alert; default-`download` for legacy rows.
- `agent/scripts/finalize-recovered-run.ts` — `finalizeBestEffortRun` (extra data fetch + video-excluded + research/publish re-assert).
- `agent/lib/usage-tracking.ts` — `markUsageCompleted` idempotent UPDATE.
- `agent/lib/notify.ts` — render-wait / best-effort / render-exhausted copy + operator alert.
- `agent/lib/worker-config.ts` (+types) — render-window caps.
- `supabase/migrations/<date>_studio_video_deferred.sql` — additive `studio_recovery_video_deferred boolean DEFAULT false` (no CHECK change).
- `frontend/lib/run-status.ts` — render copy + dedup + parity guard.
- `frontend/app/api/state/route.ts` (slug is a query param; or a new recovery-fields source) — expose `video_deferred`/`studio_recovery_status` to the results page.
- `frontend/app/runs/[slug]/…` — `video_deferred` banner.
- `frontend/app/new/[id]/page.tsx`, `frontend/app/page.tsx` — render-vs-download copy.
- Tests (§12).

## 12. Test strategy
1. **Gate-A interception:** terminal-error (credit/auth) at phase 5.5 → fail fast (not parked, Codex M-8); phase 5.5 + all research docs + 4 non-video studio + (publish) claims passed + video missing → defer; missing a research doc / failed publish / early phase-2 crash → terminal.
2. **Branch-(c) + anti-stale:** in-progress artifact matching `videoTaskId` → (c); foreign in-progress artifact `< runFloorMs` → NOT (c) → terminal (Codex C-3); never-launched → terminal; `failed` → terminal; list-`null` + `videoTaskId` → keep-waiting.
3. **Status-aware list helper:** returns `status_id`/`created_at`; `realListArtifacts` callers unaffected (Codex C-2).
4. **Composability + backward-compat:** audio download-blip (b) + video render (c) → both recovered, per-`recovery_kind` dispatch; a legacy pending row with NO `recovery_kind` → treated as `download`, NOT exhausted (Codex M-5).
5. **Render-poll sweep:** render→3 → download by list-canonical id → finalize all 5. Exhaustion → best-effort `completed` + `video_deferred=true` + operator alert.
6. **Best-effort carve-out (keystone):** completes video-excluded only with 4 non-video studio + research docs + (publish) claims + `videoTaskId` + lint 0; refuses on any non-video gap, missing research doc, failed publish, missing `videoTaskId`, lint≠0, upload-failed.
7. **Billing (Codex C-1):** `markUsageCompleted` UPDATEs the existing row to `complete`, idempotent across repeated ticks, no double-INSERT; the existing S162 path is retro-fixed.
8. **No attach-after-complete:** a late video does NOT re-claim the `completed` row (G8).
9. **Frontend:** results page banner from a data source that actually carries `video_deferred` (Codex M-9); render copy; predicate parity guard.
10. **Caps / NaN-safe env / idempotency** (parent precedents).

## 13. MERGE-gate plan (downstream — §11 HARD RULE)
`agent/` → prod worker → **FULL Gemini + Codex + Claude BEFORE merge, no substitutes** (S141). Deploy order: migration first, then worker. Frontend results-page = a separate frontend MERGE; ship close. **Dark-launch:** Branch (c) behind an env flag default OFF; enable after a shadow-observed run. **Land the billing fix (G9/D-11) first** as a small standalone MERGE — it retro-fixes S162 mis-billing independent of Branch (c).

---

## 14. Review rounds

### §14.1 Round 1 — Gemini holistic-adversarial (BLOCK → v2)
Model `gemini-3.1-pro-preview`. **BLOCK.** C-1 Gate-A masks phase-6/7 crashes → §5.1 deliverable-presence probe. C-2 (b)/(c) don't compose + no discriminator → §4.2 + `recovery_kind`. C-3 cross-run contamination → `runFloorMs` anti-stale. M-1 late-attach dead (sweep pins `failed`) → single-completion hybrid; D-1b rejected. M-2 billing leak → verified + fixed. D-1/D-7 recommended mandatory → recorded dissent; human ruled best-effort+alert. (Full table was in v2 §14.1; all integrated.)

### §14.2 Round 2 — Codex grounded-adversarial (BLOCK → v3)
Model `gpt-5.5`, reasoning xhigh (run-banner asserted: `model: gpt-5.5`, `provider: openai`, `sandbox: workspace-write`, `reasoning effort: xhigh`). **VERDICT: BLOCK** — all findings are implementability corrections; direction endorsed (D-3/D-7/D-8/D-10 supported).

| # | Sev | Finding (file:line) | Disposition in v3 |
|---|---|---|---|
| C-1 | CRITICAL | Billing fix infeasible: `recordUsage` plain INSERT, no unique key on `research_queue_id` (`usage-tracking.ts:344-370`; `20260525…:46-76,100-101`), sweep lacks token/cost inputs (`:312-330`) | **Fixed** §7.3/D-9 — idempotent `markUsageCompleted` UPDATE; never re-INSERT. |
| C-2 | CRITICAL | Render detection impossible: `realListArtifacts` completed-only (`nlm-artifact-cli.ts:117-121`); sweep consumes it (`studio-recovery-sweep.ts:344`) | **Fixed** §5.2/§6 + G5 — NEW `listArtifactsWithStatus` helper. |
| C-3 | CRITICAL | `runFloorMs` not reachable in sweep; `studio_before_ids.json` is prompt-side; sweep doesn't load workdir (`studio-recovery-sweep.ts:95-104,162-163`; `artifact-timestamps.ts:62-85`) | **Fixed** §5.2/§7.1 + G6 — persist `videoTaskId`+`runFloorMs` in payload. |
| M-4 | MAJOR | New `video_rendering` value needs CHECK+enum+Zod+index+query (`studio-recovery-sweep.ts:577-579`; `migration:78-88,145-147`; `types.ts:37`; `validate.ts:346-351`) | **Fixed** §7.1/D-2 — reuse `'pending'` + payload `recovery_kind`; minimal additive `video_deferred` marker. |
| M-5 | MAJOR | Required `recovery_kind` breaks in-flight pending rows (`executor.ts:507-515`; `studio-recovery-sweep.ts:213-224`) | **Fixed** §6/§7.1 — `recovery_kind` optional, absent ⇒ `'download'`. |
| M-6 | MAJOR | Probe source-contract wrong: `report` is Studio not research-text; roles `conventions.json:58-70`; publish from `state.publish_verification` (`publish-gate.ts:309-325`), publish-only | **Fixed** §5.1 + G11 — corrected role list + `evaluatePublishGateForJob` + publish-only claims. |
| M-7 | MAJOR | Finalizer lacks data for a carve-out (fetches only `org,selected_products` `finalize:80-83,379-395`) | **Fixed** §7.2 — `finalizeBestEffortRun` fetches payload/state/publish; narrow + non-force. |
| M-8 | MAJOR | Interception must run AFTER terminal-classification + synthesize `verdict.state` (`executor.ts:325-339,351-355,378-400,457`) | **Fixed** §5.1/§4.2/G2 — ordered after classification; synthesizes `state`. |
| M-9 | MAJOR | Results page reads `/api/state` which carries no recovery fields (`useRunState.ts:86-99`; `api/state:100-112`) | **Fixed** §7.4 — plumb `video_deferred` to a results-page data source. |
| M-10 | MINOR | Notify copy false for render/best-effort (`notify.ts:136-152,223-237,579-589`) | **Fixed** §7.5 — distinct copy arms. |
| Supported | — | enum unchanged; empty-file guards exist; `result_slug=topic_slug` safe (G13) | Adopted. |

### §14.3 Round 3 — Codex fidelity-QA on v3 (BLOCK on 3 citation nits → fixed → CLEARED)

Model `gpt-5.5` xhigh (run-banner asserted). Verified each round-2 correction was applied faithfully against shipped code. **7/10 FAITHFUL** (C-2, C-3, M-4, M-5, M-7, M-8, M-10 — all confirmed sound). **3 NOT-FAITHFUL — all citation/consistency nits, no design/mechanism impact (sibling to the parent doc's §17 "BLOCK on one stale sentence → fixed → CLEARED"):**

| # | Nit (Codex) | Fix applied |
|---|---|---|
| C-1 | §7.3 named the column `final_job_status`; the shipped column is `job_status` (`usage-tracking.ts:350-353`, `20260525_research_usage_telemetry.sql:52-53`) — the named UPDATE would fail | §7.3 corrected to `job_status` (the `finalJobStatus` opt maps to it). Direction (idempotent UPDATE, no re-INSERT) was already FAITHFUL. |
| M-6 | Role list contradictory — G11 cited 7 conventions roles (incl. `context`/`state`) while §0/§5.1 list the 5 research-text deliverables | G11 reconciled: conventions lists 7 roles; the probe targets only the 5 research-text DELIVERABLES; `context` (input) + `state` (internal) excluded. |
| M-9 | API path mis-cited as `api/state/[slug]/route.ts`; shipped is `frontend/app/api/state/route.ts` (slug = query param) | §3 G12 + §11 corrected. Substance (results page lacks recovery fields → must plumb) was FAITHFUL. |

**Gate outcome: CLEARED.** Both vendors engaged adversarially and endorse the DESIGN DIRECTION (best-effort + render-window hybrid + worker-authoritative detection); all CRITICAL/MAJOR blocking findings (6 CRITICAL + 8 MAJOR across rounds 1–2) are resolved in v3, and the 3 fidelity nits are fixed. **The DESIGN gate caught 6 CRITICAL implementability blockers before any code was written** — the cheap-at-design-stage payoff. Implementation requires a separate FULL tri-vendor MERGE gate (§13) re-verifying against actual code, with the migration-first deploy order and the dark-launch flag.
