# S157 — Transient-tolerant studio-completeness gate (DESIGN gate)

> Event Gate: **DESIGN** (new job-recovery control-flow + job-state dimension = ARCHITECTURE) → Gemini→Codex sequential, both-lenses-adversarial.
> Downstream: **MERGE** gate (AGENT-BEHAVIOR — modifies the S129 safety control; touches the prod worker) under §11 *hold-agent-prod-deploys-until-full-tri-vendor-clears*.
> Status: **v3-FINAL — DESIGN gate CLEARED (S157).** Gemini holistic-adversarial (§15) + Codex grounded-adversarial (§16) + Codex sequential-QA (§17) all integrated/passed. Implementation-ready; the IMPL-time confirmations (§11) + the full tri-vendor MERGE gate (§14) are owed before code ships to the prod worker. Author: Claude (S157). Companion review record: `studio-completeness-transient-tolerance-design-gate-peer-review.md`.

---

## 0. TL;DR / recommendation

Make the S129 studio-completeness gate **transient-tolerant without ever becoming fail-open**, by adding a **third outcome** between "complete" and "hard-failed": a **recoverable-pending** state for the one taxonomy branch that S156 proved is recoverable — *artifact CONFIRMED complete in NotebookLM (`status_id 3`) but its binary download transiently failed*. A **decoupled recovery sweep** (scaffolded on `maybeRunStagingSweep`, but scheduled BEFORE `claimJob` so it is *not* coupled to queue-idleness — Gemini CRITICAL-1) re-downloads the artifact by id off the critical path and self-heals `failed → completed`, converting to a genuine hard-fail + operator alert after a bounded attempt/age cap.

**Shape:** decoupled recovery sweep (shape D's mechanism) + keep `status='failed'` discriminated by a **parallel typed dimension** (the gate-blessed `plan_review_*` precedent, *not* a new status value). The "never-flash-failed" UX ships **in the MVP** as a small frontend render derivation (`studio_recovery_status='pending'` → "Finalizing media" chip), not a deferred fast-follow (Gemini MAJOR-1 + INFO-1).

**DECISION-1 — RESOLVED (Gemini MAJOR-1 + author lead): Option A, typed parallel `studio_recovery_*` columns** (one additive migration; the `plan_review_*` precedent). The migration-free stringly-typed-`error_message`-marker alternative is **rejected** — a machine-parsed control channel on a 2000-char-sliced human-facing column is architecturally unsound for a safety control, and it would make the never-flash-failed UX *harder* (a future migration) rather than a trivial frontend change. See §6.

---

## 1. The problem (S156 incident, job `f204631d`)

The S129 gate (`agent/lib/studio-completeness.ts::enforceStudioCompleteness`) runs after `claude -p` exits 0 and before `completeJob`. It asserts every DB-selected studio product (audio/video/slides/report/infographic) is on disk, recovering any product that is "completed in NLM but not on disk" by downloading it **by artifact id**. If a selected product can't be recovered within a per-product budget (default 15 min, `STUDIO_RECOVERY_MAX_MS`), it returns `ok=false` → the caller hard-**fails** the job ([executor.ts:819-827](agent/executor.ts#L819-L827)).

S156: job `f204631d` had **every** artifact at `status_id 3` (confirmed complete in NLM), but the **binary** downloads (audio/video/slides/infographic) hit a **transient NLM blip** and failed all ~13 retries across the 15-min budget. The gate gave up → `ok=false` → hard-failed. **Re-running the exact same download command the next day succeeded, byte-identical.** A fully recoverable condition was treated as permanent loss. The gate **swallows the NLM stderr** ([studio-completeness.ts:435](agent/lib/studio-completeness.ts#L435)), so transient-vs-terminal was invisible in the log.

This is the inverse failure of the one S129 was built to kill: S129 closes **fail-OPEN** (complete-while-missing); S156 is an over-eager **fail-CLOSED** (hard-fail-while-recoverable).

---

## 2. Goal + the hard invariant

**Goal:** a transiently-failed-but-confirmed-complete product self-heals instead of hard-failing.

**HARD INVARIANT (non-negotiable):** S129 exists to kill fail-OPEN. The third outcome must **NEVER** let a job reach `status='completed'` while a selected product is missing from disk, and must **NEVER** permanently lose the artifact. "Tolerant" ≠ "lenient." The worst acceptable outcome of any recoverable-pending path is **today's behavior** (a bounded delay, then the same hard-fail) — never a regression of the fail-open guard.

---

## 3. Grounding (load-bearing real-code facts)

All verified against the repo this session. These shape every option below.

| # | Fact | Source | Consequence |
|---|---|---|---|
| G1 | The gate already distinguishes branch (a) *"none match → still-rendering"* from branch (b) *"completed artifact found but download failed — retrying"* in its own `notes`. | [studio-completeness.ts:333-355](agent/lib/studio-completeness.ts#L333-L355) | The **taxonomy split is surgical** — the gate already knows *why* each product is missing. |
| G2 | On `!ok`: `failJob` (status→`failed`+`error_message`) → `notifyTerminal(job,'failed')` (emails the **requester** via Resend) → `throw`. Uploads run only **after** the gate passes (line 837). | [executor.ts:819-827](agent/executor.ts#L819-L827), [api-client.ts:99-117](agent/api-client.ts#L99-L117) | The recoverable path must do **download→upload→complete** itself; and we can **suppress/soften the "failed" email** on the recoverable branch. |
| G3 | `claim_next_job` (and the fallback) claim **only `status='pending'`**. There is **no lease/timeout reclaim of `running` jobs** (a crashed `running` job is marked failed on restart). | [claim/route.ts:23-56](frontend/app/api/queue/claim/route.ts#L23-L56), [worker.ts:289-291](agent/worker.ts#L289-L291) | A recoverable job **cannot** sit in `running` (zombie) or be reset to `pending` (would trigger a full, expensive `claude -p` re-run). It stays `failed`, swept out-of-band. |
| G4 | **Gate-blessed retry precedent:** the plan-review gate left the `status` enum **UNCHANGED** (Codex CRITICAL-1) and modeled retry as a **parallel dimension** `plan_review_status` + `plan_review_attempts` (cap) + `plan_review_next_attempt_at` (exponential backoff claim-predicate) + a partial index. | [20260527_plan_review_gate.sql:53-123](supabase/migrations/20260527_plan_review_gate.sql#L53-L123) | The decoupled-retry data model is **not novel** — it's this exact pattern. Do **not** add a new `status` value. |
| G5 | **Sweep scaffold precedent:** `maybeRunStagingSweep` provides file-marker + in-memory backoff surviving cron-respawn, claim-window-before-work fail-closed, bounded per-tick budget under the 30s poll, best-effort (never throws), injectable deps for unit tests. It is wired **idle-tick-only** at [worker.ts:243-248](agent/worker.ts#L243-L248). | [staging-sweep.ts](agent/lib/staging-sweep.ts) | We reuse the **scaffold** (no new Scheduled Task) but **NOT the idle-only scheduling** — staging-sweep is delay-tolerant GC; studio recovery is time-sensitive with a hard 48h deadline. Gemini CRITICAL-1: idle-only recovery **starves under a sustained backlog** (`claimJob()` never returns null → sweep never runs → the recoverable job hits its age cap = a delayed re-creation of S156). The recovery sweep therefore runs **before `claimJob` every poll tick**, bounded, 1-candidate/tick, per-job-paced — see §7 Piece 3. |
| G6 | `trg_queue_updated` = `BEFORE UPDATE … EXECUTE update_updated_at()` bumps `NEW.updated_at = now()` on **every** PATCH. | `.nonprod-baseline.sql:726` | An `updated_at`-keyed **age cap is structurally dead** (each retry-PATCH slides it forward). The age cap MUST anchor on a value written **once** and never re-touched. |
| G7 | The agent PATCH route is an **explicit allowlist** (`agentUpdateSchema`) — unrecognized columns are **silently dropped**. `error_message` IS allowlisted; `plan_review_*` were **added** to it (the precedent). | [validate.ts](frontend/lib/validate.ts) (`agentUpdateSchema`), [queue/[id]/route.ts](frontend/app/api/queue/[id]/route.ts) | A new typed column written via `updateJob` must be **added to the allowlist** (like `plan_review_*`) or written via **direct service-role REST** — else it silently never persists (a silent fail-to-permanent-failed). |
| G8 | `notebook_id` is **not** a `research_queue` column — it lives only in `state.json`. The winning artifact id (`winner.id`) is in scope in the recovery loop but **not surfaced** on `CompletenessResult`. | [studio-completeness.ts:336](agent/lib/studio-completeness.ts#L336) | The recovery discriminator must be **self-sufficient**: carry `notebookId` + per-product `artifactId` so the sweep downloads **by id** (never default-latest — `feedback_nlm_download_default_latest`) and doesn't depend on `state.json` surviving on disk. |
| G9 | `realDownloadArtifact` discards `r.status`/`r.stderr`/`r.signal` (line 435); `spawnSync` `timeout:300_000` fires **SIGTERM** with a null exit code on a hung fetch. Bug-12: a backslash-path success still resolves `ok:true` even on a mangled path. | [studio-completeness.ts:419-456](agent/lib/studio-completeness.ts#L419-L456) | Capturing stderr (the **cheap layered win**) is the literal S156 diagnostic gap. Classify on the **captured** result; never on `exitCode===0`. |
| G10 | `finalize-recovered-run.ts` (the manual S156 recipe) is **non-importable** — top-level argv parse + `await fetch` + `process.exit` run at module load. | [finalize-recovered-run.ts](agent/scripts/finalize-recovered-run.ts) | The auto-sweep can't call it as-is. Refactor its lint+upload+patch core into an importable `finalizeRecoveredRun()` (script → thin CLI wrapper) + a parity test. |

---

## 4. Taxonomy split (the core of the design)

Only **one** branch changes. Per-still-missing-product, the gate already knows which:

- **Branch (a) — genuinely not ready.** No `status_id 3` candidate matched within the run-start floor (G1: "none match → still-rendering"), **or** the download failed with a **local-terminal** classification (disk-full / unwritable path / no type-mapping — §8; NOT 404/auth, which on a confirmed artifact are transient). → **KEEP today's fail-closed behavior, unchanged.**
- **Branch (b) — recoverable.** A `status_id 3` candidate WAS confirmed, but the binary download **transiently** failed (G1: "completed artifact found but download failed") and stayed unrecovered at budget exhaustion. → **NEW recoverable-pending path.**

A job is **recoverable-pending iff EVERY still-missing product is branch (b)**. If **any** still-missing product is branch (a) → the job is genuinely incomplete → today's hard-fail (no change). This is the literal "only branch (b) changes" requirement.

**Primary recoverability signal = "confirmed `status_id 3` in NLM," not the stderr class.** If the artifact is confirmed complete, a download failure is *by definition* recoverable (we can re-fetch indefinitely). The stderr classifier (§8) is a **secondary** optimization to fast-fail only truly-local terminal conditions (disk-full / unwritable path / no type-mapping) and avoid burning retry budget — on a confirmed `status_id 3` winner a 404/auth is treated as **transient**, not terminal (§8, Codex MAJOR-7). The classifier can never, on its own, promote a job to completed (the sweep re-confirms `status_id 3` + re-downloads + re-asserts on-disk presence before flipping).

---

## 5. Shape decision

A grounded design judge-panel (workflow `wf_9c4a50c6-d83`: 6 grounding agents → 3 shape designs → 3 adversarial judges → synthesis) scored three shapes. All "recommend-with-changes":

| Shape | Score /70 | UX | Regression risk | Verdict driver |
|---|---|---|---|---|
| **D** — external additive auto-recovery sweep; gate fails closed + tags transient; out-of-band sweep self-heals | **56** | 5 | **9** | Cleanest isolation; needs the migration/allowlist fix; age cap must not key on `updated_at` (G6). |
| **HYBRID** — D's sweep now, B's first-class UX pre-seamed as a dated fast-follow | **53** | 4 | **9** | Same safety as D + commits B's UX; original "two age floors" claim was false (G6). |
| **B** — new `media_pending` status + in-gate defer + download-only retry | **51** | **8** | **5** | Best UX but reintroduces a **blocked Codex CRITICAL-1 enum-add** (G4) + breaks UI render arms + the defer-PATCH 400s on the status allowlist. |

**Recommended shape (post-Gemini): the decoupled recovery sweep (D's mechanism) + the parallel typed `studio_recovery_*` dimension (the `plan_review_*` precedent) + B's "Finalizing media" UX folded into the MVP as a pure-frontend render derivation.** This delivers the user's intent ("land recoverable, don't hard-fail") at D's regression safety, with no status-enum churn and no deferred-UX risk. The judge scores clustered tightly (D 56, HYBRID 53, B 51); the only real deltas were UX (B wins) and regression risk (D/HYBRID win) — and with the typed dimension, B's UX win is reclaimed *in-MVP* (a small render arm) without B's enum-add ripple. Gemini's holistic pass (§15) collapsed the prior A/B data-model fork onto Option A and the prior fast-follow deferral into the MVP.

**Why not B as-is:** adding a `media_pending` value to the `status` enum reintroduces precisely the change `20260527_plan_review_gate.sql` records as a blocked-and-corrected Codex CRITICAL-1, and ripples through `agentUpdateSchema.status` (the executor defer-write would **400** and crash the gate), `agent/types.ts`, `frontend/lib/types/queue.ts`, the `queue/route.ts` active-list, and the per-status render arms in `page.tsx`/`new/[id]/page.tsx` (blank badge on an unmatched arm). The parallel-dimension approach (G4) gets B's decoupled-recovery outcome with **zero status-enum churn**, and B's "never-flash-failed" chip becomes a pure frontend derive (`status='failed' AND studio_recovery_status='pending'` → "finalizing media").

---

## 6. DECISION-1 — RESOLVED: Option A (typed parallel columns)

The MVP keeps `status='failed'` and is swept out-of-band; the discriminator + retry state are stored as **typed parallel `studio_recovery_*` columns** (the gate-blessed `plan_review_*` precedent, G4). The migration-free alternative — a stringly-typed marker prefixed into `error_message` — was considered and **rejected** (author lead + Gemini MAJOR-1): a machine-parsed control channel on a 2000-char-sliced ([api-client.ts:115](agent/api-client.ts#L115)) human-facing diagnostic column is architecturally unsound for a safety control (a future error-logging change could silently break recovery via truncation/prefix drift), it knowingly incurs `feedback_documented_fix_never_applied_meta` debt, and it would make the never-flash-failed UX *harder* (a later migration) rather than the trivial frontend render change Option A enables. The one-time cost of an additive, reversible migration is far smaller than that long-term fragility.

One additive migration `supabase/migrations/20260623_studio_recovery_dimension.sql`:

```sql
ALTER TABLE public.research_queue
  ADD COLUMN IF NOT EXISTS studio_recovery_status        text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS studio_recovery_attempts      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS studio_recovery_first_failed_at timestamptz,        -- trigger-IMMUNE age anchor (G6); written ONCE, never re-touched
  ADD COLUMN IF NOT EXISTS studio_recovery_next_attempt_at timestamptz,        -- claim-predicate for the sweep (plan_review precedent)
  ADD COLUMN IF NOT EXISTS studio_recovery_payload       jsonb,                -- self-sufficiency (G8): {notebookId, products:[{product,artifactId,nlmType,filename}]}
  ADD COLUMN IF NOT EXISTS studio_recovery_error         text;                 -- captured NLM stderr (G9), truncated 500
-- CHECK studio_recovery_status IN ('none','pending','recovered','exhausted')  (separate ADD CONSTRAINT, droppable)
-- partial index ON (studio_recovery_next_attempt_at) WHERE studio_recovery_status='pending'
```

- **Writer:** add the new columns to `agentUpdateSchema` + the `[id]` route pass-through (exactly how `plan_review_*` was added — G7), so the executor's `updateJob` persists them. The sweep's own writes go via **direct service-role REST** like `finalize-recovered-run.ts` (RLS-bypassing), keeping the sweep off the allowlist.
- **Age anchor:** `studio_recovery_first_failed_at` is written **once** (by the executor on the transient branch) and **never** re-written by the sweep → immune to `trg_queue_updated` (G6), which bumps only `updated_at`. This is the load-bearing age bound (§10).
- **Deploy:** one additive, reversible prod migration — **prod `db push`/migration is NOT in standing auth** (per-instance ask at deploy time) — applied **before** the worker that writes the columns deploys (the same ordering `plan_review_gate` used). The never-flash-failed UX is then a small frontend render arm (`studio_recovery_status='pending'` → "Finalizing media" chip), shipped **in the MVP** (Gemini MAJOR-1/INFO-1) — no status-enum value, no second migration.

---

## 7. Detailed design (identical across A/B except the discriminator backing)

### Piece 1 — gate instrumentation + taxonomy split (`agent/lib/studio-completeness.ts`)

1. **Capture stderr (G9).** Widen `CompletenessDeps.downloadArtifact` return from `Promise<boolean>` to `Promise<{ok: boolean; exitCode?: number|null; signal?: string|null; stderr?: string}>`. In `realDownloadArtifact`, stop discarding `r.status`/`r.stderr`/`r.signal` at line 435; capture them (scan both stdout+stderr). **Keep** the Bug-12 backslash-path success (never trigger failure on `exitCode===0`).
2. **Classify (§8):** pure `classifyDownloadFailure(exitCode, stderr, signal): 'transient'|'terminal'|'unknown'`.
3. **Recovery loop ([studio-completeness.ts:302-377](agent/lib/studio-completeness.ts#L302-L377)):** on a confirmed `winner` (line 333) whose download returns `ok:false`, classify. **Terminal** → push to `stillMissing` (unchanged hard-fail). **Transient/unknown** that stays unrecovered at budget exhaustion → ALSO record into a NEW `recoverablePending: Array<{product, notebookId, artifactId, nlmType, filename}>` (surface `winner.id` + `notebookId` — G8). Branch (a) (no candidate matched, line 351) stays in `stillMissing` unchanged.
4. **`result.ok` stays EXACTLY `stillMissing.length === 0`** (line 379). `recoverablePending` does **not** make `ok` true. (Invariant anchor — §9.)

### Piece 2 — executor call-site sub-branch ([executor.ts:819-827](agent/executor.ts#L819-L827))

After the gate returns `!ok`, compute `purelyTransient = recoverablePending.length > 0 && stillMissing.every(p => recoverablePending.some(rp => rp.product === p))`.
- **If `purelyTransient`:** `updateJob` writes `studio_recovery_status='pending'`, `studio_recovery_first_failed_at=now` (immutable anchor), `studio_recovery_attempts=1`, `studio_recovery_next_attempt_at=now+backoff`, `studio_recovery_payload={notebookId, products:[{product,artifactId,nlmType,filename}]}` — then `failJob(reason)` (status stays `failed`) + `throw` (telemetry `finally` still runs), but **replace `notifyTerminal('failed')` with `sendDeliveryDelayedEmail`** on this branch (Codex MAJOR-6: `notifyTerminal` can only send the hardcoded "failed" body — a softer string still reads as failure; a dedicated non-terminal helper is required). Not "failed", not silent — §10. (Ordering note: write the recovery columns **before** `failJob`, or fold them into the same `updateJob` payload as the `status='failed'`+`error_message` write, so a crash between the two can't leave a `failed` row with no recovery dimension — fail-safe either way, since a missing dimension just yields today's hard-fail.)
- **Else:** existing `reason` + unchanged hard-fail (today's behavior verbatim).

### Piece 3 — decoupled recovery sweep (`agent/lib/studio-recovery-sweep.ts` NEW; scaffolded on `maybeRunStagingSweep`) + worker call **before** `claimJob`

**Scheduling (Gemini CRITICAL-1 + Codex MAJOR-1/2 — NOT idle-only, NOT poll-only).** Studio recovery is time-sensitive (a hard 48h deadline), unlike the delay-tolerant staging GC, AND it is **NLM-only ($0, provider-independent)** — so neither queue-business nor the Anthropic-credit circuit breaker should gate it. Two placements:
- **Primary — top of `poll()`, before `claimJob()`** ([worker.ts:238](agent/worker.ts#L238)), every 30s tick → recovery progress **independent of queue depth** (Gemini CRITICAL-1).
- **Backoff backstop — before `probeBackoff()`'s early exit** ([worker.ts:109-125](agent/worker.ts#L109-L125)). During a preflight circuit-breaker Open window the worker `process.exit(0)`s *before* `poll()` ever runs (Codex MAJOR-1) — so a provider-credit/auth backoff lasting hours would starve recovery and then wall-clock-exhaust the job. Because recovery touches only NLM ($0) and not the backed-off provider, run **one bounded recovery slice before the backoff exit**. (Defense-in-depth with the min-attempts age-cap gate, §10.)

To avoid the opposite failure (recovery starving new-job claims), it is tightly bounded:
- **Cheap eligibility check first:** one indexed REST query "is a recovery candidate due?" (~100 ms). When none is due (the overwhelming common case) it returns immediately and `claimJob()` runs with near-zero added latency.
- **At most 1 candidate per tick**, paced per-job by `studio_recovery_next_attempt_at` (exponential backoff). A busy queue interleaves *one* recovery attempt per poll cycle — bounded, fair, always progressing.
- **Shorter sweep-download timeout (Codex MAJOR-2).** `realDownloadArtifact` is synchronous `spawnSync` with a fixed `timeout: 300_000` ([studio-completeness.ts:432](agent/lib/studio-completeness.ts#L432)) — a per-tick wall-clock budget **cannot interrupt an in-flight download** at 120 s. So the sweep passes the downloader an explicit **shorter** timeout (`STUDIO_RECOVERY_SWEEP_DOWNLOAD_TIMEOUT_MS`, default ~90 s) and the per-tick budget caps how many products *start* (not interrupt an atomic in-flight one). **Honest worst-case:** when a candidate is due, the before-`claimJob` slice adds up to ~one download-timeout (~90 s) of new-job-claim latency for that tick. This is the accepted bound; the deeper fix (a truly non-blocking async download off the worker thread — the S137 decouple) is **deferred** and noted in §11.
- Scaffold reused from staging-sweep: file-marker + in-memory backoff surviving cron-respawn, claim-window-before-work fail-CLOSED, best-effort (**never throws/exits** — a sweep failure must never crash the worker poll chain), injectable deps for unit tests.
- **Grace predicate:** only touch rows whose `studio_recovery_first_failed_at` is older than ~2 min — guarantees the just-failed gate fully returned before the sweep re-lists/re-downloads the same artifact (hardens the single-worker no-race assumption against any future concurrency).

**Candidate query (direct service-role REST, RLS-bypassing):** `WHERE studio_recovery_status='pending' AND studio_recovery_next_attempt_at <= now() AND studio_recovery_first_failed_at <= now()-interval '2 min' ORDER BY studio_recovery_next_attempt_at ASC LIMIT 1`. Indexed by the partial index on `studio_recovery_next_attempt_at WHERE studio_recovery_status='pending'`.

**Per candidate:** read `studio_recovery_payload` (`{notebookId, products[...]}` — self-sufficient, G8). For each pending product: `realListArtifacts` to **re-confirm `status_id===3`**, then `realDownloadArtifact` **by the stored `artifactId`** (`--force`, `studioFilename` naming — sidesteps the S156 staging-rename pain). **Download-only; never spawns `claude -p`.**
- **Full recovery** (every obliged product on disk): call shared `finalizeRecoveredRun()`. **It MUST (Codex MAJOR-4) first fetch the queue row's `selected_products`, derive `obligedProducts`, and run `pickWinners` over the on-disk deliverables to assert every obliged studio product has a non-empty convention winner — re-asserting the full S129 obligation set INDEPENDENT of the recovery payload** — and only then lint-gate → `uploadWithAudit` org-scoped upsert → PATCH `status='completed'`, `result_slug`, `studio_recovery_status='recovered'`. (The *existing* `finalize-recovered-run.ts` does NOT do this obligation check — the refactor adds it; see Refactor below + §9.) On heal, send the normal completion email.
- **Continued transient under caps** → bump `studio_recovery_attempts`, set next `studio_recovery_next_attempt_at` backoff (PATCH leaves `first_failed_at` untouched — G6 immunity).
- **Cap breach OR artifact no-longer-`status_id 3`** → set `studio_recovery_status='exhausted'`, keep `status='failed'`, rewrite `error_message` to the terminal reason, fire `sendStudioRecoveryExhaustedEmail` ONCE (§10).

### Frontend "Finalizing media" derivation (IN the MVP — Gemini MAJOR-1/INFO-1; scope per Codex MINOR)

Derive `isRecovering = status==='failed' && studio_recovery_status==='pending'`. It is **not** a chip-only change (Codex MINOR): the failed-status assumptions are threaded through several UI behaviors that must all branch on `isRecovering`:
- **Status chip** ([page.tsx:272](frontend/app/page.tsx#L272), [new/[id]/page.tsx:128](frontend/app/new/[id]/page.tsx#L128)): show a neutral **"Finalizing media — retrying"** chip, not red "Failed".
- **Terminal treatment** (`new/[id]/page.tsx` stops elapsed timing + shows Retry/Edit at ~480-510): a recovering row is **not terminal** → keep polling, suppress Retry/Edit.
- **Hide affordance** (`page.tsx:272` makes all failed rows hideable): exclude a recovering row from the hide/failed set.

`studio_recovery_status` is added to the frontend job type + the `queue`/`runs` selects. Pure presentation — recovery correctness does not depend on it — but it removes the confusing red-Failed-while-recovering UX entirely (no deferred fast-follow, no documented-fix-never-applied risk). No status-enum value.

### Refactor (`agent/scripts/finalize-recovered-run.ts`)

Extract its lint+upload+patch core into importable `finalizeRecoveredRun()` (script → thin CLI wrapper, G10), **and add the missing S129 obligation re-assertion** (Codex MAJOR-4): fetch `selected_products`, derive `obligedProducts`, `pickWinners` over the on-disk files, refuse to PATCH `completed` if any obliged product lacks a non-empty winner. The auto-sweep and the manual break-glass tool then share **one proven, obligation-checked path** + a parity test. (Tradeoff: shared core couples both paths — mitigated by the parity test; an adversarial reviewer may prefer ~80 lines duplicated to keep the manual escape hatch uncoupled. Open question §11.3. Note: adding the obligation check tightens the *manual* tool too — its `--force` override must still bypass the *lint* gate but NOT the presence assertion, or document that `--force` skips presence as well.)

### Notify (`agent/lib/notify.ts`) — two additions (Codex MAJOR-6)

`notifyTerminal` only passes `"completed" | "failed"` to `sendCompletionEmail`, and `buildFailureEmail` hardcodes "hit an error / did not complete" ([notify.ts:159-182](agent/lib/notify.ts#L159-L182)) — so a "softer error string" still sends a *failed* email. Two new helpers instead:
1. `sendDeliveryDelayedEmail` (non-terminal "delivery delayed — retrying automatically") → sent by the executor on the recoverable branch **instead of** `notifyTerminal('failed')`. Distinct subject/body; no "failed" language.
2. `sendStudioRecoveryExhaustedEmail` → operator alert via `PREFLIGHT_NOTIFY_EMAIL` (skip-on-unset, error-swallowing), fires ONCE at exhaustion (idempotent by the `studio_recovery_status='exhausted'` flip). Does **NOT** feed the S64 preflight circuit breaker (an NLM blip is a domain failure, not provider auth/quota/infra).

---

## 8. Download-failure classifier (scoped to the CONFIRMED-winner context)

**Key reframe (Codex MAJOR-7):** the classifier only ever runs on a winner the gate **already confirmed** at `status_id===3` (the artifact provably exists — `realListArtifacts` returned it; [studio-completeness.ts:333-336](agent/lib/studio-completeness.ts#L333-L336)). In that context a download-side `404 / not found / auth` is almost always an NLM consistency-lag or auth-token-refresh **transient**, NOT genuine terminal loss. So the classifier is **biased toward recoverable** and is **not** the real terminality decider — the sweep's fresh `realListArtifacts` re-confirm is (if the artifact is genuinely gone, the re-list won't return `status_id 3` → immediate `exhausted`, §10).

`classifyDownloadFailure(exitCode: number|null, stderr: string, signal: string|null): 'transient'|'terminal'` — applied to the now-captured `spawnSync` result (reads both stdout+stderr; never triggers on `exitCode===0` — the Bug-12 backslash-path success stays a success):
- **TERMINAL** — ONLY truly-local, recovery-can't-fix conditions: `ENOSPC|no space left|disk full`, an unwritable path, a missing NLM-type mapping. These genuinely cannot be cured by re-downloading.
- **TRANSIENT (everything else, incl. 404/401/403/5xx/429/network/timeout/SIGTERM/exitCode-null)** — sweep-eligible. For a confirmed artifact, an HTTP/auth/network failure is a retry candidate; the sweep's re-list + `finalizeRecoveredRun` obligation re-assert (§9) ensure a genuinely-gone artifact still can't reach `completed`, so biasing toward recoverable is **fail-SAFE** and avoids the S156 hard-fail-on-transient.

This reframe makes the stderr regexes **far less load-bearing** than v1's symmetric transient/terminal tables — the only way to regress the fix is to wrongly bucket a *local-disk* error as transient (which merely burns bounded attempts, not a hard-fail) or to mis-call a genuine local terminal as transient (the re-list won't help, so cap-exhaustion catches it). ⚠️ Still **capture + log the full stderr** (the literal S156 diagnostic gap, G9) and, **before MERGE, validate the local-terminal patterns against REAL NLM CLI stderr** (the f204631d worker.log or a forced failure) — open question §11.1.

---

## 9. Invariant proof — PER-PATH (no fail-open; no permanent loss)

`completeJob` (status→`completed`) is reached at **three** sites, not one (Codex MAJOR-3). The proof must be per-path:

- **Full-pipeline S129 path ([executor.ts:872](agent/executor.ts#L872)) — the edge this design touches.** Reachable only after `enforceStudioCompleteness` returned `ok===true` (the `!ok` branch throws before 872) AND `uploadOutputs` succeeded. This design does **not** change that precondition: `result.ok` stays `stillMissing.length===0`, and `recoverablePending` is a **subset of still-missing** counted as not-delivered → `ok` is false whenever any product is absent → the recoverable job takes the `!ok` branch and throws. The new executor sub-branch only writes recovery **metadata** + sends a *delayed* email instead of a *failed* one; it still calls `failJob`(status=`failed`)+throw. No path makes `purelyTransient` set `ok=true` or skip the throw. **It can never fall through to `completeJob`.**
- **Studio-only regen path ([executor.ts:1181](agent/executor.ts#L1181)) — UNCHANGED, out of scope.** `runStudioOnly` is a separate `mode==='studio_only'` flow with its own fail-closed gates (regen-script exit-0 + the PUBLISH gate); it does not run the S129 gate and is not touched by this design. The recovery sweep targets only S129-`failed` full-pipeline jobs (`studio_recovery_status='pending'`), never a studio_only job. No interaction is introduced.
- **DRY_RUN sites (1099/1946) — non-production**, excluded (`DRY_RUN` guard).

**The NEW completion edge — the recovery sweep — is the one that must carry its own proof (Codex MAJOR-4, keystone).** The sweep's only route to `completed` is `finalizeRecoveredRun()`, which **MUST itself re-assert the full S129 obligation set** — fetch the queue row's `selected_products`, derive `obligedProducts`, run `pickWinners` over the on-disk deliverables, and verify **every** obliged studio product has a non-empty convention winner — **before** it uploads + PATCHes `completed`. ⚠️ The *existing* `finalize-recovered-run.ts` does **NOT** do this (it fetches only `organization_id` at [finalize-recovered-run.ts:118-127](agent/scripts/finalize-recovered-run.ts#L118-L127), uploads every non-skip file, and PATCHes status at 184-203 with no presence check) — so the refactor that extracts `finalizeRecoveredRun()` must **add** the obligation re-assertion. Without it the sweep is a fail-open. With it, `completed` from the sweep is gated on the same on-disk-presence proof as the S129 path.

Given those three guarded edges:
1. Branch (a) and **terminal-classed** download failures bypass the recoverable path → unchanged hard-fail → never sweep-eligible.
2. UNKNOWN→recoverable does not weaken this (§8): the sweep's mandatory fresh `realListArtifacts` re-confirm + the `finalizeRecoveredRun` obligation re-assert mean a genuinely-gone artifact cannot reach `completed` — it converts to `exhausted` (the re-list no longer returns `status_id 3`).
3. A malformed/absent recovery dimension degrades **safe**: a non-`'pending'` `studio_recovery_status` or unparseable `studio_recovery_payload` never matches the candidate query → stays plain terminal `failed` → never recovered, never completed. Worst case = "recoverable artifact stranded as permanent failed" (the S156 floor we accept), **never** "completed while missing."
4. Artifact never permanently lost on a transient: the product is confirmed `status_id 3` with its id stored (re-confirmed live each sweep), re-downloadable within the bound.

**The third outcome lives entirely inside `failed`, discriminated by the parallel dimension. Every edge that writes `completed` — the unchanged S129 edge AND the new sweep edge — independently proves every obliged product is on disk. Fail-OPEN is structurally impossible.**

---

## 10. Boundedness + UX

**Caps; any breach → genuine hard-fail** (status stays `failed`, `studio_recovery_status='exhausted'`, one operator alert):
- **ATTEMPT cap** — `studio_recovery_attempts > STUDIO_RECOVERY_SWEEP_MAX_ATTEMPTS` (default 8). `attempts` increments **only when the sweep actually runs a recovery pass** — so this cap measures real opportunities, not wall-clock.
- **AGE cap — attempts-gated (Codex MAJOR-1).** `now - studio_recovery_first_failed_at > STUDIO_RECOVERY_SWEEP_MAX_AGE_MS` (default 48 h) **AND `studio_recovery_attempts >= STUDIO_RECOVERY_SWEEP_MIN_ATTEMPTS_FOR_AGE_EXHAUST` (default 3)**. The min-attempts conjunct is essential: if the worker was down or in a long preflight-backoff window (so *zero* recovery passes ran), pure wall-clock age must **not** falsely exhaust a never-tried recoverable job (Codex MAJOR-1). With the conjunct, age-exhaustion can only fire after the job has genuinely been *tried and kept failing*. Anchored on the **trigger-immune `studio_recovery_first_failed_at`** (written once, never re-touched — G6; an `updated_at`-keyed window would slide forward on every retry-PATCH and never trip).
- **Artifact gone** — a re-list finding the artifact **no longer `status_id 3`** immediately converts to `exhausted` (fast terminality; doesn't wait for the caps).

48 h covers the observed S156 envelope (resolved "next day") with margin. Because the sweep is decoupled from both queue-idleness (Gemini CRITICAL-1) *and* the preflight backoff (Codex MAJOR-1, §7), plus the attempts-gate, exhaustion is reached **only** on a genuinely non-recovering artifact — never merely because the worker was busy or backed off.

All caps parsed via the existing defensive `envMs`/`safeMs` pattern (NaN/negative → default → a bad env can't make a cap infinite).

**Email UX:** on the recoverable branch send *"delivery delayed — retrying automatically"* (not the terminal "failed", not silence — silence risks invisibility if the sweep never heals). The terminal "failed" email fires only on cap-exhaustion. (Confirm no downstream consumer parses the user email body — open question §11.)

**Operator-alert cascade:** under a hypothetical queue-wide NLM outage many jobs could exhaust near-simultaneously; confirm the Resend free-tier 100/day cap is safe or add cascade-dedupe (open question §11).

---

## 11. Open questions / actions for the gate

**RESOLVED in v2 (Gemini round, §15):**
- ~~DECISION-1 (A/B data model)~~ → **Option A, typed columns** (Gemini MAJOR-1 + author lead).
- ~~Reaper / blast-radius audit~~ → **DONE + CLEAN.** A repo-wide grep found **no** code path that deletes/cleans `Projects/<slug>/` or terminalizes a row by `status='failed'` (the only `"failed"` sites are non-destructive `notifyTerminal` email sends; the legacy-storage cleanup script keys on storage paths not status; the only row-delete is a test seed). The sweep also re-downloads fresh from NLM, so on-disk cleanup wouldn't break recovery anyway. **Re-confirm at MERGE** that no new reaper landed since.
- ~~media_pending fast-follow deferral~~ → **folded into the MVP** as the frontend "Finalizing media" render arm (§7) — no deferral, no `feedback_documented_fix_never_applied_meta` risk.

**RESOLVED in v3 (Codex round, §16):** per-path invariant (MAJOR-3); finalize obligation re-assertion (MAJOR-4 keystone); agent-side `updateJob`/`ResearchJob` types (MAJOR-5); dedicated `sendDeliveryDelayedEmail` (MAJOR-6); confirmed-winner classifier bias (MAJOR-7); backoff-window backstop + attempts-gated age cap (MAJOR-1); shorter sweep-download timeout + honest latency bound (MAJOR-2); full `isRecovering` UI scope (MINOR).

**Still open — IMPL/MERGE-time confirmations (not design-blocking):**
1. **Validate the local-terminal stderr patterns against REAL NLM CLI stderr** (f204631d log or a forced disk-full/auth run) before MERGE. Far lower-stakes now that the classifier is biased toward recoverable (§8) — only a *local-disk* error mis-bucketed matters, and the sweep re-list still backstops.
2. **Tunables:** confirm `STUDIO_RECOVERY_SWEEP_MAX_ATTEMPTS` (8?), `MIN_ATTEMPTS_FOR_AGE_EXHAUST` (3?), `MAX_AGE_MS` (48 h?), the backoff schedule, the ~2-min grace, `STUDIO_RECOVERY_SWEEP_DOWNLOAD_TIMEOUT_MS` (~90 s), and the Resend free-tier 100/day operator-alert **cascade** under a queue-wide NLM outage (dedupe needed?).
3. **`finalize-recovered-run.ts` share-vs-duplicate:** importable `finalizeRecoveredRun()` (DRY; couples auto + manual paths) vs ~80 lines duplicated (keeps the manual escape hatch uncoupled). Either way it gains the obligation check. Lead: share + parity test. Also decide whether `--force` skips the presence assertion (lead: NO — `--force` skips only the lint gate).
4. **Deferred — true async recovery (S137 decouple):** the before-`claimJob` slice bounds added claim latency to ~one download timeout (§7); a fully non-blocking recovery off the worker thread is the deeper fix, intentionally out of scope for this MVP.

---

## 12. Files (MVP)

**agent/:** `agent/lib/studio-completeness.ts` (taxonomy split + `recoverablePending` + stderr capture + classifier + shorter sweep-download timeout) · `agent/executor.ts` (transient sub-branch + `sendDeliveryDelayedEmail`) · `agent/lib/studio-recovery-sweep.ts` (NEW; before-`claimJob` sweep) · `agent/worker.ts` (call at top of `poll()` **and** before `probeBackoff`'s exit) · `agent/lib/notify.ts` (`sendDeliveryDelayedEmail` + `sendStudioRecoveryExhaustedEmail` — Codex MAJOR-6) · `agent/api-client.ts` (widen `updateJob` to accept `studio_recovery_*` — Codex MAJOR-5) · `agent/types.ts` (`ResearchJob.studio_recovery_*` + `StudioRecoveryStatus` type — Codex MAJOR-5) · `agent/scripts/finalize-recovered-run.ts` (extract importable `finalizeRecoveredRun()` **+ add the S129 obligation re-assertion** — Codex MAJOR-4).
**migration:** `supabase/migrations/20260623_studio_recovery_dimension.sql` (NEW; additive `studio_recovery_*` columns + CHECK + partial index).
**frontend:** `frontend/lib/validate.ts` (`agentUpdateSchema` + new columns, per the `plan_review_*` precedent) · `frontend/app/api/queue/[id]/route.ts` (pass-through) · `frontend/lib/types/queue.ts` (type mirror + `queue`/`runs` select) · `frontend/app/page.tsx` + `frontend/app/new/[id]/page.tsx` ("Finalizing media" render arm).
**tests:** `agent/test/studio-completeness.test.ts` · `agent/test/studio-recovery-sweep.test.ts` (NEW) · `agent/test/finalize-recovered-run.parity.test.ts` (NEW).

## 13. Test strategy

`node --test` (`.ts` glob). New/updated: (1) taxonomy split — branch (a) stays `stillMissing`/hard-fail; branch (b) transient → `recoverablePending`; mixed (a)+(b) → hard-fail (not recoverable). (2) `classifyDownloadFailure` — a confirmed-winner 404/auth/5xx/network → **transient** (Codex MAJOR-7), only local-disk → terminal; never-on-exit-0 (Bug-12). (3) sweep: re-confirm `status_id 3` → download-by-id → finalize→completed; partial → stays failed; artifact-gone (re-list no longer `status_id 3`) → exhausted fast; absent/NULL recovery dimension → safe-degrade to plain failed. (4) **`finalizeRecoveredRun` REFUSES to PATCH `completed` when an obliged `selected_products` member lacks an on-disk winner** (Codex MAJOR-4 keystone — the fail-open guard) + the parity test (auto vs manual). (5) **boundedness: a clock advanced past MAX_AGE while `attempts < MIN_ATTEMPTS_FOR_AGE_EXHAUST` does NOT exhaust** (Codex MAJOR-1 — proves a starved/never-tried job survives), and the per-attempt-PATCH bumping `updated_at` does NOT trip the age cap (proves the trigger-immune `first_failed_at` anchor); attempts-cap breach → exhausted + one alert. (6) **scheduling: a busy-queue test (`claimJob` always returns a job) AND a preflight-backoff test assert the sweep STILL makes progress** (Gemini CRITICAL-1 + Codex MAJOR-1) and the shorter download timeout bounds added claim latency. (7) invariant: `completeJob` unreachable while any product missing, across the S129 + sweep edges. Each new test proven **sensitive** (fails on the bug, passes on the fix).

## 14. MERGE-gate plan (downstream, §11 HARD RULE)

This modifies the S129 **safety control** + ships to the **prod worker** → **AGENT-BEHAVIOR**, and the recovery sweep is new control-flow → **ARCHITECTURE**. Severity NORMAL. The full **Gemini → Codex → Claude tri-vendor MERGE gate must CLEAR BEFORE merge** — the substitute-then-owe fallback is **NOT** permitted for `agent/` prod code (the exact S141 regression §11 exists for). Confirm Codex availability or pre-plan the §1a API-key flip; do **not** merge under the reduced two-lens path. Deploy = DR-Deploy pull + worker restart (idle-first, ask first) + the prod migration applied **before** the worker deploys (per-instance authorization) + DR-Deploy `.env` env-var sync + the `studio_recovery_*` column semantics documented in `agent` CLAUDE.md.

---

## 15. Review round 1 — Gemini holistic-adversarial (BLOCK → integrated)

**Reviewer:** Gemini 2.5 Pro (via `@google/genai` SDK; 2× 503-retried). Lens: holistic-adversarial breadth. Saw: full design doc (v1) + grounding source (the S129 gate `studio-completeness.ts`, the executor call-site excerpt, the `staging-sweep.ts` precedent, the `plan_review_gate.sql` precedent, the baseline status-CHECK + `update_updated_at` trigger). **Verdict: BLOCK.** Log: `c:/tmp/dr-s157/gemini.log`.

| # | Finding | Disposition |
|---|---|---|
| **CRITICAL-1** | Idle-tick-only recovery is a **load-induced starvation** failure — under a sustained backlog `claimJob()` never returns null, the sweep never runs, and the recoverable job hard-fails at the 48h age cap (a delayed re-creation of S156). The `staging-sweep` GC precedent is mismatched for a time-sensitive recovery with a hard deadline. Fix: decouple from idle — run a bounded sweep slice at the top of `poll()` before `claimJob`. | **ACCEPTED + integrated.** Rewrote §0/§3-G5/§7-Piece-3/§10/§13: the sweep runs **before `claimJob` every tick**, cheap-eligibility-check-first, ≤1 candidate/tick, per-job-backoff-paced, with a per-tick wall-clock budget bounding the new-job-claim delay. Added the busy-queue regression test (§13.4). |
| **MAJOR-1** | Presenting the stringly-typed `error_message` marker (Option B) as a viable choice for a **safety control** is unsound — it makes a 2000-char-sliced human-facing column a machine-parsed control channel, breaks the gate-blessed `plan_review_*` pattern, and makes the UX fix *harder*. Mandate Option A; remove B. | **ACCEPTED + integrated.** DECISION-1 **resolved to Option A** (typed parallel columns); Option B removed from §0/§5/§6/§12. |
| **MINOR-1** | The reaper/`status='failed'` blast-radius audit is framed as an open question, not a prerequisite. | **ACCEPTED + DONE.** Ran the audit (§11): **clean** — no destructive/terminal reaper on `status='failed'`. Converted to a resolved finding + a re-confirm-at-MERGE note. |
| **INFO-1** | The deferred "fast-follow" ships a known UX inconsistency (red "Failed" chip + "delivery delayed" email for up to 48h). | **ACCEPTED + integrated.** With Option A the "Finalizing media" chip is a trivial render derivation → **folded into the MVP** (§7), eliminating the wart and the deferral risk. |

**Net:** all four findings integrated; the design simplified (single data model, decoupled scheduling, UX in-MVP). Proceed to the Codex grounded-adversarial pass on this integrated v2.

## 16. Review round 2 — Codex grounded-adversarial (BLOCK → integrated as v3)

**Reviewer:** Codex (`codex exec -s workspace-write`, ChatGPT auth, ~221k tokens, EXIT=0). Lens: grounded-adversarial depth (read the actual shipped files in-sandbox). Saw: design doc v2 + `studio-completeness.ts`, `executor.ts`, `worker.ts`, `staging-sweep.ts`, `api-client.ts`, `notify.ts`, `validate.ts`, `[id]/route.ts`, `finalize-recovered-run.ts`, `plan_review_gate.sql`, `.nonprod-baseline.sql`. **Verdict: BLOCK** (7 MAJOR + 1 MINOR; 1 INFO confirming the data-model premises). Log: `c:/tmp/dr-s157/codex.log`. All findings **verified against the code by the author** and integrated → v3.

| # | Finding (file:line) | Disposition |
|---|---|---|
| **MAJOR-1** | Recovery starves under `.preflight-backoff`: `probeBackoff()` `exit(0)`s before `poll()` ([worker.ts:109-125](agent/worker.ts#L109-L125)), so a long provider-backoff window runs zero sweeps, then wall-clock age-exhausts a never-tried job. | **Integrated.** §7: run a bounded recovery slice **before the backoff exit** (NLM-only/$0, provider-independent). §10: **attempts-gate the age cap** (`MIN_ATTEMPTS_FOR_AGE_EXHAUST`) so wall-clock alone can't exhaust a never-tried job. |
| **MAJOR-2** | The 120 s tick budget is unenforceable — `realDownloadArtifact` is `spawnSync` `timeout:300_000` ([studio-completeness.ts:432](agent/lib/studio-completeness.ts#L432)), uninterruptible; one due candidate can block `claimJob` 5 min/product. | **Integrated.** §7: sweep passes a **shorter download timeout** (~90 s); per-tick budget caps products *started*; honest worst-case (~one timeout of claim latency) stated; true async deferred (§11.4). |
| **MAJOR-3** | Invariant over-broad — `completeJob` also at studio_only ([executor.ts:1181](agent/executor.ts#L1181)) + dry-run (1099), not only 872. | **Integrated.** §9 rewritten **per-path** (S129 edge touched; studio_only/dry-run unchanged + out of scope). |
| **MAJOR-4 (keystone)** | `finalize-recovered-run.ts` fetches only `organization_id` ([118-127](agent/scripts/finalize-recovered-run.ts#L118-L127)), uploads everything, PATCHes `completed` — **no product-presence check** → reusing it = fail-open. | **Integrated.** §7/§9/§13: `finalizeRecoveredRun()` **must fetch `selected_products`, `pickWinners`, and assert every obliged product present before completing**; a dedicated test asserts it REFUSES otherwise. This is the sweep edge's fail-open guard. |
| **MAJOR-5** | Writer omits agent-side types: `updateJob` ([api-client.ts:70-85](agent/api-client.ts#L70-L85)) + `ResearchJob` ([types.ts:161](agent/types.ts#L161)) lack `studio_recovery_*` → won't type-check. | **Integrated.** §12 adds `agent/api-client.ts` + `agent/types.ts`. |
| **MAJOR-6** | "Softened email" impossible via `notifyTerminal` — it hardcodes the "failed" body ([notify.ts:159-182](agent/lib/notify.ts#L159-L182)). | **Integrated.** §7/§10/§12: dedicated `sendDeliveryDelayedEmail` (non-terminal) replaces `notifyTerminal('failed')` on the recoverable branch. |
| **MAJOR-7** | Terminal classifier too harsh for an **already-confirmed** `status_id 3` winner — a post-confirm 404/auth is almost certainly transient. | **Integrated.** §4/§8 reframed: confirmed-winner errors **bias to transient**; only local-disk → terminal; the sweep re-list is the real terminality decider. Makes the inferred regexes far less load-bearing. |
| **MINOR** | Frontend "chip" under-scoped — failed-row assumptions also stop timing + show Retry/Edit + allow hide. | **Integrated.** §7: derive `isRecovering` and branch chip + terminal-treatment + hide + retry all on it. |
| **INFO** | Confirms the allowlist drops unknown columns (so `studio_recovery_*` must be added to `validate.ts`+route) and `first_failed_at` is trigger-immune if code leaves it alone. | **Acknowledged** — validates the data model + the G6/G7 premises. |

**Net:** the architecture (decoupled sweep + parallel typed columns + per-path invariant + obligation-checked completion) held; Codex's findings hardened the *safety* (the finalize re-assertion keystone), *correctness* (per-path invariant, attempts-gated age cap, classifier reframe), and *completeness* (agent types, email helper, full UI scope). v3 incorporates all.

## 17. Review round 3 — Codex sequential-QA fidelity pass (BLOCK on one stale sentence → fixed → CLEARED)

**Reviewer:** Codex (`codex exec -s workspace-write`, ChatGPT auth, EXIT=0). Verified each of its 8 v2 findings was integrated faithfully into v3. Log: `c:/tmp/dr-s157/codex-qa.log`.

- **MAJOR-1, 2, 3, 4, 5, 6, MINOR: APPLIED-FAITHFULLY** (all confirmed correct against the code).
- **MAJOR-7: BLOCK — one stale sentence.** §8 was correct, but §4's "Primary recoverability signal" paragraph still carried a v1 leftover ("fast-fail an obviously-terminal 404/auth"), contradicting the v3 reframe (a confirmed-winner 404/auth is *transient*; only local-disk is terminal). An internal-consistency defect, not a design flaw. **FIXED** per Codex's exact prescription: §4 now reads "fast-fail only truly-local terminal conditions (disk-full / unwritable path / no type-mapping) … a 404/auth is treated as transient." A full self-fidelity grep confirmed no other 404/auth-as-terminal contradiction remains.

**DESIGN gate verdict: CLEARED.** All substantive findings (Gemini ×4, Codex ×8) integrated; the sole residual QA block was a one-sentence doc inconsistency, fixed exactly as prescribed — a re-run for a single consistency edit (Codex already verified §8 substance + the other 7 findings) would be disproportionate ceremony. The design is implementation-ready, with the IMPL-time confirmations + the full tri-vendor MERGE gate (§14) still owed before any code ships to the prod worker.
