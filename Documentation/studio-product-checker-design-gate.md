# Studio Product Checker — 5-minute per-product render-liveness watchdog (DESIGN)

- **Status:** **v4.1 — v4 DESIGN-gate FINAL + S197 MERGE-wave amendments** (see the v4→v4.1 changelog entry; the §5.2 matrix now has 11 rows). Original v4 status (S196, 2026-07-01): Gemini 3.1-pro holistic-adversarial on v1: **BLOCK** (2C/2M/2m/1I) → v2. Codex gpt-5.5 xhigh grounded-adversarial on v2: **BLOCK** (1C/2M/1m, direction endorsed) → v3. Fresh-Claude grounded refutation lens on v3: **BLOCK** (1C/4M/4m — incl. a CRITICAL both externals missed, the third such catch in this failure family) → this v4. ALL findings integrated (changelog §13). No code ships from this doc; implementation is a later `agent/` PROD MERGE wave under the full §11 tri-vendor gate.
- **MRPF classification:** DESIGN gate; Risk Labels **AGENT BEHAVIOR + INFRA** (new host-side scheduled task + a small worker-side breadcrumb seam; read-only against job state). Severity NORMAL. Reviewer topology: sequential Gemini 3.1-pro (holistic-adversarial) → Codex gpt-5.5 (grounded-adversarial), + fresh-Claude grounded lens (S195 standing rule for this failure family).
- **User requirement (S195, verbatim intent):** "an automatic Studio-product checker every 5 min that verifies each selected product's generation/render is ACTUALLY progressing (not silently stalled)."
- **Companion:** `Documentation/studio-product-checker-design-gate-peer-review.md` (reviewer records).

---

## §1 Problem: no one watches a render while the job is alive

### 1.1 The coverage timeline today

Every existing defense acts **at or after** the worker checkpoint (child exit / park). Nothing observes Studio-product progress **during** the run:

| Window | Mechanism | What it sees | Anchor |
|---|---|---|---|
| During run | `watchStateFile` (5s) | phase/pct **change only** — a same-phase `phase_status` update is dropped by the unchanged-check; no mtime/staleness logic; no product status | `state-evaluation.ts:111-177`, `:99-101` |
| During run | `waitForProcess` deadline check (30s) | activeMs vs `MAX_JOB_DURATION_MS` (150 min in DR-Deploy `.env`) + cost cap — kills, doesn't diagnose | `claude-spawn.ts:294-371`, `:299`, `:328-334` |
| During run | Child's unified Studio poll loop | `artifact list` per product every 30s — but backgrounded, stdout-only, **no state.json heartbeat code** (the `:1009` heartbeat directive has no implementing code) and **no in-loop deadline**; an unresolved product rides silently to the duration cap | `research-compare.md:1027-1198`, `:1201`, `:1122` |
| Child exit | S129 completeness gate | per-product presence + bounded in-gate recovery (15 min/product) | `executor.ts:510-520`, `studio-completeness.ts:337-481` |
| Post-park | S162 recovery sweep | `status='failed'` + `studio_recovery_status='pending'` ONLY — **`status='running'` rows are structurally invisible** | `studio-recovery-sweep.ts:759` |

Structural fact: the worker cannot host a per-tick mid-job check — `poll()` **awaits** `executeJob` (`worker.ts:273-275`), so no tick fires while a job runs. Only in-job timers (the two above) run during a job.

### 1.2 The failure classes this leaves invisible (from prod)

1. **Silent render stall / never-launched product** — the child's poll loop prints to stdout nobody reads; a stalled video looks identical to a healthy 40-min render until the cap kills the child (S135 pinned-task stall; ConQr `3ce18f2c` phase-6 variant).
2. **Confirmed-FAILED render (status_id 4)** — today uniformly treated as "keep waiting" (`studio-recovery-sweep.ts:429` post-park; nothing at all during-run); a dead render burns the whole window.
3. **Wedged child** — `claude -p` alive but idle (S133 `51cf68d3`: deliverables on disk, process alive, DB frozen); zero alerts until cap.
4. **Dead child / dead worker with row stuck `running`** — Bug 38 class (Windows sleep + wake-blip → row `running` indefinitely). Nothing external notices.
5. **Auth decay mid-run** — rotated cookies make every NLM call fail quietly inside a backgrounded loop (Bug 5 family).
6. **Operator blindness** — DB `phase_status` lags workdir `state.json` ~7 min (S195 dogfood) and same-phase heartbeats never reach the DB (§1.1 row 1), so the process page can't answer "is it actually moving?"

### 1.3 Why now

[C] (shipped S195) makes the *agent* less likely to abandon a wait; [D] (owed) moves the *corpus-import and video-render waits* host-side. Neither VERIFIES that a wait is progressing. The checker is the observability leg of the same program: [C]/[D] own the wait; the checker proves the wait is alive.

---

## §2 Goals / non-goals

**Goals (v1):**
- G1. Every ~5 min, for every `status='running'` job, verify each **DB-selected** Studio product (audio/video/slides/report/infographic) is progressing on the NLM side, using only trusted signals (§3).
- G2. Detect and classify: stalled render, failed render (status_id 4), launched-but-no-artifact, wedged/dead child, dead worker, degraded NLM auth.
- G3. **Alert-only** (operator email via the existing `notify.ts` operator channel) with per-condition dedup. No kill, no re-render, no DB status writes (§6).
- G4. Survive and detect a hung WORKER — i.e., run as an independent process (§4).
- G5. Zero interference: no shared counters with the sweep, no second completion edge, no prompt-side feedback into the running agent, no NLM mutations.

**Non-goals (v1):**
- N1. No acting on findings (kill/re-render/park/complete) — the act paths already exist post-park (S162 sweep, S185 best-effort, S191 Design B) and any new act edge must join the [D] mutual-exclusion matrix at ITS merge gate, not here.
- N2. No corpus-import (SOURCE-enum) polling — Step 5e/A.1 own that in-turn today; [D] will own it host-side. The checker only reports phase context. (v2 candidate: an import-wait arm once [D]'s `import_wait_status` dimension exists — §8.)
- N3. No content-level verification (Veo3 truncation, chart corruption) — liveness only.
- N4. No schema/migration change, no frontend change, no requester-facing email.
- N5. No modification of Step 5e / Step A.1 / the unified poll loop (crash-hardened, regression-forbidden).

---

## §3 Signal foundation (what the checker may trust)

Grounded doctrine, already paid for in prod incidents:

- **Truth = `notebooklm artifact list -n <nb> --type <t> --json` carrying `status_id`** (the S187 status-aware form, `nlm-artifact-cli.ts:152-187`). `artifact poll` LIES persistently post-render (S129; 13h false `in_progress`) — the checker must never use it. Precision (fresh-Claude m-1): shipped `agent/` code never invokes `artifact poll`, but the slash prompt's unified poll loop DOES retain one use as an auth-expiry probe that can `sys.exit(3)` the child (`research-compare.md:1163-1168`) — so during a real auth outage the CHILD may exit before the checker's auth condition confirms (§5.2 #8 note).
- **The checker's own NLM load is safe but nonzero:** the CLI only LOADS `storage_state.json` (verified read-only — no write path in `auth.py`/`cli/session.py`), so checker calls cannot corrupt the child's auth; but ≤5 extra list calls/5 min marginally accelerate rotated-cookie staleness, which the 30-min `RefreshNotebookLMAuth` task resets (fresh-Claude INFO).
- **ArtifactStatus enum:** 1=PROCESSING, 2=PENDING (queued, non-terminal), 3=COMPLETED, 4=FAILED (`notebooklm-py` v0.3.4 `rpc/types.py` L111-120 — unofficial source, not a Google contract; 4 must be treated as "report, don't act" until a real failed render confirms it).
- **Ours-not-foreign matching:** exact `state.artifacts[<product>].task_id` when persisted (the child's poll loop writes it at alias time, `research-compare.md:1144-1148`), else `created_at >= run_floor_ms` from `studio_before_ids.json` (S138 pre-submit snapshot, `research-compare.md:977-1004`). Snapshot-diff alone proves "new", not "ours" (S142 exact-1 trap) — the checker reports an ambiguous match as AMBIGUOUS, never resolves it.
- **Launch markers, not phase labels:** the slash prompt never writes `phase: "5.5"` (state goes 5 → Step-5e/A.1 heartbeat strings → 5.5b `reconcile_complete`). Studio-started is inferred from workdir artifacts: `studio_before_ids.json` exists ⇒ submits imminent/underway; `state.artifacts[<p>]` present ⇒ that product launched.
- **Launch markers MUST be freshness-gated against the row's `claimed_at` (fresh-Claude CRITICAL C-1).** Workdirs are intentionally reused across re-queues of the same slug, and the claim-time archive sweeps ONLY state files (`isStateFileName`, `find-state-file.ts:35-37`; call site `executor.ts:136`) — `studio_before_ids.json` is written solely by the child and persists forever (zero `agent/` matches). An un-gated stale marker from a prior attempt both false-fires `NO_ARTIFACT_AFTER_LAUNCH` on a healthy re-run (old mtime ⇒ T_appear long expired, stale floor matches nothing) and, inversely, resolves attempt-1 artifacts as "ours" and masks a real attempt-2 stall. Rule: a marker whose mtime (or embedded `run_floor_ms`) predates `claimed_at` is IGNORED as launch evidence and its floor is never used. (Sibling MERGE-wave line item: extend the claim-time archive to also sweep `studio_before_ids.json` into `.superseded-state/` — worker code, so the checker-side gate exists regardless.)
- **state.json mtime is NOT a stall signal during Studio.** The shipped poll loop doesn't heartbeat state.json, so a frozen workdir during a healthy video render is NORMAL (S130 "idle-poll is benign" — a healthy run was nearly killed on that misread). NLM-side artifact status is primary; process liveness is secondary; state.json is phase context only.
- **Selected products come from the DB row** (`research_queue.selected_products`) — the `obligedProducts()` doctrine (`studio-completeness.ts:177-180`): never trust LLM-written `state.selectedProducts`.
- **State-file selection** mirrors `findStateFile` (newest embedded `YYYYMMDD-HHMMSS-state.json` timestamp, mtime fallback — `find-state-file.ts:203-217`); prior-attempt files are archived to `.superseded-state/` at job start.
- **Auth:** cookies rotate; the `RefreshNotebookLMAuth` scheduled task (30-min) keeps `storage_state.json` fresh; a 5-min list cadence is exactly the activity pattern that exposes stale cookies. Auth-redirect / rejection output is a DEGRADED_AUTH classification, never artifact-gone. `auth check --test` false-negatives; the list call itself is the probe.

**Empirical duration table (basis for thresholds §5.4):** report ~1–6 min, infographic ~3–6.5 min, slides ~2–15 min, audio ~9 min (deep-dive long-form), video ~20–60+ min (planning number 20–40; S191 window 120 min; slash-prompt informational timeouts 45/45/20/20/20). No per-product duration constants exist anywhere in repo code today — the checker's thresholds are NEW config.

---

## §4 Architecture: independent 5-minute scheduled task + a worker breadcrumb

### 4.1 Decision

**A standalone script `agent/scripts/studio-product-checker.ts`, fired by a NEW Windows Scheduled Task `DynamicResearchStudioChecker` every 5 minutes, running from the DR-Deploy clone** (same discipline as `DynamicResearchWorker`). One shot per invocation — the Task Scheduler owns the cadence; no long-lived daemon.

Rejected alternatives:

| Option | Why rejected |
|---|---|
| In-worker per-tick sweep (like S162) | Structurally impossible during a job — the tick loop is blocked (`worker.ts:273-275`, §1.1). Would only check between jobs, i.e. exactly when there is nothing to check. |
| In-job timer inside `executeJob` (extend `watchStateFile`) | Runs inside the process it is supposed to distrust: dies with a hung/killed worker (G4 fails), adds NLM spawns to the job-critical path, and pre-empts the executeJob restructuring that belongs to [D]. Kept as a v2 option AFTER [D] reshapes the wait (§8). |
| Piggyback on `probeBackoff`/cron worker spawn | The 5-min cron tick exits immediately when a worker is already alive (PID singleton) — precisely the running-job case. |

Why independent wins, concretely: (a) it observes the worker from OUTSIDE, so hung-worker / dead-worker / Windows-sleep classes (§1.2 #4) are detectable; (b) it is read-only, so it adds NO arm to the [D]/S136/Gate-A mutual-exclusion matrix ([D] doc MERGE target 6); (c) a fresh process every 5 min is immune to the Node timers-don't-tick-in-sleep hazard (Bug 38) — Task Scheduler fires on wake; (d) 5-min cadence matches the platform's existing granularity floor (S191 D-A4).

### 4.2 The job→child-PID breadcrumb (the ONLY worker-side change)

Today the child PID is captured nowhere (`grep child.pid` → only the worker's own `.worker.pid`). Add, at the spawn site in `executor.ts` (immediately after `spawnClaude`, `executor.ts:286`):

- Write `agentRuntimeDir()/.run/<job-id>.json` (dir auto-created; cwd-independent anchor — §4.3): `{ "pid": <child.pid>, "spawnedAt": "<ISO>", "workDir": "<abs>", "projectsDir": "<abs>" }`.
- **Breadcrumb semantics: "child spawned, and its exit has NOT yet been observed by the worker."** Delete it **immediately after `waitForProcess` resolves** (`executor.ts:302`) — NOT at the end of `executeJob`. The S129 gate + uploads can legitimately run 15+ min per product after child exit with no DB movement; a breadcrumb that lingered through that tail would guarantee a `CHILD_DEAD_JOB_RUNNING` false-positive storm on every healthy run (Gemini CRITICAL-1). A `finally` failsafe delete at the end of `executeJob` remains as backup for throw paths. Never throw from breadcrumb IO (write/delete wrapped; a failed write logs and continues — the checker degrades gracefully without it).
- **The hard-death → re-claim twin (fresh-Claude MAJOR M-1):** no `finally` runs on a hard worker death (power loss, kill -9), so an orphaned breadcrumb correctly signals the stranded job — but when the SAME job id is later re-queued, the new claim's pre-spawn window (attachments, manifest, the multi-minute plan-review gate at `executor.ts:221`; DRY_RUN never spawns at all) has the row `running` with the STALE breadcrumb still on disk. Two rules close it: (a) `executeJob` deletes any existing `<job-id>.json` breadcrumb at its TOP (claim time); (b) matrix #6 additionally requires breadcrumb `spawnedAt` ≥ row `claimed_at` — same freshness pattern as the §3 launch-marker gate.
- **Breadcrumb GC (fresh-Claude INFO):** breadcrumbs orphaned by hard death whose jobs later leave `running` would accumulate; the worker deletes breadcrumbs of non-running jobs on idle ticks (cheap, bounded) — recorded so the MERGE wave doesn't ship "accepted dust" silently.
- **PID-reuse guard is the CHECKER's job** (Windows recycles PIDs), and it is explicitly NOT implementable with `process.kill(pid, 0)` (no cmdline/start-time access) — the checker shells `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"` (PowerShell; wmic is deprecated) and requires: process exists AND `CommandLine` contains `claude` (loose match — `cross-spawn` may interpose a `cmd.exe /c` shim wrapper on Windows, so the exact image name is not `claude`; Gemini MAJOR-4) AND `CreationDate` ≈ `spawnedAt` (±2 min). Any miss → treated as child-dead for the matrix.

This is `agent/` PROD code → its implementation wave takes the full §11 tri-vendor MERGE gate. It is deliberately minimal (~15 LOC, write-only, no reads by the worker itself).

### 4.3 Placement of checker state — one CWD-INDEPENDENT runtime anchor (Codex CRITICAL)

Ambient `process.cwd()` is a trap here: the shipped worker launcher `cd`s into `agent/` before starting the worker (`agent/worker-start.bat:13-14`), so `.worker.pid` — written under `process.cwd()` (`worker.ts:47`) — actually lives at `agent/.worker.pid`. A checker launched from repo root would look in the wrong directory, false-storm `WORKER_DEAD_JOB_RUNNING`, and be blind to breadcrumbs. Therefore:

- NEW tiny helper `agent/lib/runtime-paths.ts` exporting `agentRuntimeDir()` anchored on the module's own location (`fileURLToPath(import.meta.url)` → the `agent/` dir), **never** `process.cwd()`. The breadcrumb writer (§4.2) and the checker both resolve `.run/` and `.studio-checker/` through it.
- `.worker.pid` is NOT moved (zero worker behavior change); the checker reads it at `agentRuntimeDir()/.worker.pid`, which equals the worker's cwd by the `worker-start.bat` invariant — that invariant is now DOCUMENTED as load-bearing in the helper's header.
- **⚠️ The invariant currently rests on an UNTRACKED local edit (fresh-Claude MAJOR M-3):** the TRACKED `agent/worker-start.bat:13` hardcodes `cd /d` into the DEV tree; the deployed DR-Deploy copy is a git-dirty local modification pointing at DR-Deploy — in a clone whose doctrine is "never edit there." Any `reset --hard`/conflicted pull reverts the prod worker's cwd (and with it `.worker.pid`, `.run/`, the `.env` with the 150-min cap, `worker.log`) to the dev tree, false-storming the checker. Fixes: (a) MERGE-wave line item — `worker-start.bat` uses `cd /d "%~dp0"` (its own directory), making the invariant structural in tracked code and dissolving the local edit; (b) checker belt — before firing #7, cross-check `Get-CimInstance` for ANY live `node …worker.ts` process; if one exists elsewhere, report `WORKER_LOCATION_MISMATCH` (FYI) instead of `WORKER_DEAD_JOB_RUNNING` (also covers the legitimate dev-tree-worker dogfood pattern).
- Belt-and-braces: the `DynamicResearchStudioChecker` task registers with StartIn = the DR-Deploy `agent/` dir anyway.

The checker owns `agentRuntimeDir()/.studio-checker/`: per-job latch files `<job-id>.json` (conditions seen, alert timestamps, consecutive-sighting counters) + `checker.lock` (singleton; a run that would overlap a still-running prior invocation exits 0 immediately; lock carries PID + start, stale after `STUDIO_CHECKER_LOCK_TTL_MS` default 10 min). It writes NOTHING into job workdirs (child-owned globs like `*-state.json` must never gain surprise matches) and NOTHING into `research_queue`.

---

## §5 The checker pass (per 5-min invocation)

### 5.1 Inputs

1. DB: `research_queue` rows `status='running'` (id, topic_slug, organization_id, selected_products, **pipeline_mode**, **claimed_at**, updated_at, created_at) — service-role envs from the deploy clone's `agent/.env` (same env-file the worker uses). `claimed_at` is the freshness anchor for every workdir/breadcrumb marker (§3, §4.2); columns verified against the baseline schema. **Rows with `pipeline_mode='studio_only'` are SKIPPED in v1** (§7 — Codex MAJOR: the regen path has none of the launch markers this design keys on). A second bounded read (tracked-id list) closes out latches of jobs that left `running` — so "read-only" means "research_queue SELECTs only", not literally one query (fresh-Claude m-3).
2. Workdir (`WORKING_DIR/<slug>`): newest state file (findStateFile mirror) → `notebook_id`, `phase`, `phase_status`, `artifacts.<p>.task_id`; `studio_before_ids.json` (+ `run_floor_ms`) — both freshness-gated vs `claimed_at` (§3); mtimes as context.
3. `agentRuntimeDir()/.run/<job-id>.json` breadcrumb → child PID liveness (with §4.2 guard + freshness vs `claimed_at`).
4. `agentRuntimeDir()/.worker.pid` → worker liveness (same PID-alive + cmdline check; §4.3 location-mismatch belt).
5. NLM: for each selected product with Studio underway — ONE `artifact list -n <nb> --type <t> --json` status-aware call (≤5 spawns/job/invocation, 60s timeout each, $0). The `--type` value goes through the SAME product→CLI map as the gate (`studio-completeness.ts:78-84` — notably `slides` → `slide-deck`; passing the DB name raw would fail the CLI; Gemini MINOR-6). NOTE (Codex MINOR): `PRODUCT_TO_NLM_TYPE` is currently a PRIVATE const — the MERGE wave exports it as a readonly map (one-line visibility change in `studio-completeness.ts`, listed in §10) + a `slides → slide-deck` parity test; the checker imports it, never re-authors it (single-source doctrine; the regen script's separate `PRODUCT_DEFS` map at `regenerate-studio-products.ts:124-130` is prior art for the drift this prevents).

**The structured-error list variant (Gemini CRITICAL-2).** The shipped wrappers (`realListArtifacts`/`realListArtifactsWithStatus`) are whole-body throw-guarded and return a silent `null` on ANY failure — auth-redirect, cp1252 crash, timeout all collapse into `null`, which makes §5.2's auth-degraded classification impossible through them. The checker therefore uses a NEW **additive** export in `nlm-artifact-cli.ts`: `listArtifactsWithStatusDetailed(...)` → `{ ok: true, artifacts } | { ok: false, reason: "auth" | "cli-crash" | "timeout" | "parse", detail }`, classifying the auth-redirect signature ("Authentication expired… accounts.google.com") from captured stderr/stdout. Existing consumers (sweep/gate) keep the null-contract functions UNTOUCHED — no behavior change to shipped paths; NLM_BIN resolution + arg shape stay single-sourced in the module.

### 5.2 Detection matrix (condition → signals → confirmation → alert class)

| # | Condition | Signals | Confirmation | Alert class |
|---|---|---|---|---|
| 1 | Render in progress, healthy | our artifact status 1/2, elapsed < T_render(product) | — | none (log line only) |
| 2 | **Stalled render** | our artifact status 1/2, elapsed ≥ T_render(product) | 2 consecutive sightings (≥5 min apart) | `STALLED_PRODUCT` |
| 3 | **Failed render** | our artifact `status_id == 4` | 1 sighting (but see §6: report-only) | `RENDER_FAILED_STATUS` |
| 4 | **Launched, no artifact** | `state.artifacts[<p>]` or `studio_before_ids.json` present ≥ T_appear, no matching artifact (exact id / ≥ floor) | 2 consecutive sightings | `NO_ARTIFACT_AFTER_LAUNCH` |
| 5 | **Ambiguous match** | >1 candidate post-floor, no exact id | 2 sightings | `AMBIGUOUS_ARTIFACT` (FYI) |
| 6 | **Child dead, job running** | breadcrumb PRESENT (worker never observed child exit — §4.2 semantics) AND `spawnedAt` ≥ `claimed_at` (stale-breadcrumb guard, §4.2) AND PID fails §4.2 guard | 2 sightings | `CHILD_DEAD_JOB_RUNNING` |
| 7 | **Worker dead, job running** | `.worker.pid` process dead/mismatched AND row `running` AND no live worker process found elsewhere (§4.3 belt — else `WORKER_LOCATION_MISMATCH` FYI) | 2 sightings | `WORKER_DEAD_JOB_RUNNING` |
| 8 | **Degraded auth** | detailed-list returns `{ok:false, reason:"auth"}` across ALL products/jobs (§5.1). NOTE: the child's own poll loop may `sys.exit(3)` on auth expiry (§3) before 2 sightings confirm — a normal child-exit/gate-fail presentation is the expected companion, not a contradiction | 2 sightings | `NLM_AUTH_DEGRADED` |
| 9 | **Observability self-failure** | detailed-list returns non-auth `{ok:false}` (cli-crash/timeout/parse — e.g. the cp1252 emoji crash) | 3 consecutive sightings | `NLM_CLI_BLIND` |
| 10 | **Wedged child post-Studio** (the S133 signature — fresh-Claude M-2; **re-anchored v4.1**) | ALL selected products `status_id == 3` AND row still `running` AND child alive (#6 guard passes). ⚠️ v4.1 (S197 MERGE fresh-lens M-2): the quiet period is **checker-observed** — NEVER artifact `created_at` age, which is SUBMIT time (a healthy 40-min render is already ">25 min old" the instant it completes → cry-wolf on every long render) | ceil(T_wedge/cadence)+1 spaced sightings (~25+ min of observed all-complete; T_wedge = 25 min) | `CHILD_WEDGED_POST_STUDIO` (FYI) |
| 11 | **Process-probe blind** (S197 MERGE addition — Codex MAJOR-4, mirrors row 9's "a blind checker must say I am blind") | ≥1 `Get-CimInstance` PID probe failed this invocation (PowerShell error/timeout/CIM access-denied under the task principal); probe failures also FREEZE the affected #6/#7 latch keys (blind ≠ absent) | 3 consecutive sightings | `PROCESS_PROBE_BLIND` |

(There is deliberately NO wall-clock cap-approach row: the real cap runs on sleep-excluded `activeMs`, invisible outside the worker — a wall-clock heuristic false-fires on every wake-from-sleep. Dropped per Gemini MINOR-5 / Q1.)

Notes: #6 cannot false-fire during the legitimate post-child executor tail because the breadcrumb is deleted the moment `waitForProcess` resolves (§4.2), nor during a re-claim's pre-spawn window because of the `spawnedAt ≥ claimed_at` guard; a worker that crashes DURING that tail is caught by #7 instead. #8 must not double-report as #4 (auth failure ⇒ suppress per-product conditions that invocation); #9 likewise suppresses per-product conditions (a blind checker must say "I am blind", not "your product is gone"). **Clock anchors (fresh-Claude m-4):** T_appear counts from `max(studio_before_ids.json mtime, claimed_at)`; T_render counts from the matched artifact's own `created_at` (server-side, sleep-immune, already fetched). A **post-wake grace** applies to soft conditions (#2,#4,#6,#7,#10): "recent wake" is detected from the checker's OWN latch — if now − last-invocation-timestamp > 2× cadence, ticks were missed (sleep/downtime) → require a fresh sighting after the grace. (There is no "uptime-since-wake" API on Windows/Node — `os.uptime()` counts from boot and includes sleep; fresh-Claude m-2.)

### 5.3 Alerting + dedup

- Transport: a new exported `sendStudioStallAlert(args)` in `notify.ts` composing the existing private `postOperatorAlert` (recipient `PREFLIGHT_NOTIFY_EMAIL`, skip-on-unset, swallow-errors — the exact `sendStudioVideoDeferredAlert` S187 pattern, `notify.ts:475-505`). notify.ts has zero dedup primitives by contract — dedup lives in the checker's latch files.
- Dedup: once per (job, product, condition-class); one escalation re-alert if still present at 2× threshold; a `RECOVERED` info line in the next alert if a previously-alerted condition cleared. All alerts for one invocation batch into ONE email.
- Alert body: job id + slug (no topic text beyond the slug — no untrusted user content in operator email), per-product table (status_id, elapsed, threshold), child/worker liveness, phase context, and the operator's next-move hints (e.g. "confirmed status_id 4 + S191 Design B unimplemented ⇒ expect the render window to burn; consider manual intervention").

### 5.4 Thresholds (NEW config; code-constant defaults, env-overridable)

| Product | T_appear | T_render (alert) | Basis |
|---|---|---|---|
| report | 10 min | 30 min | empirical 1–6 min; prompt timeout 20 |
| infographic | 10 min | 30 min | empirical 3–6.5 |
| slides | 10 min | 35 min | empirical 2–15 |
| audio | 10 min | 55 min | empirical ~9; prompt timeout 45 |
| video | 15 min | 75 min, **cap-clamped** | empirical 20–60+; S191 window 120; see clamp below |

**Cap-aware clamp (Codex MAJOR):** the 150-min cap exists ONLY in DR-Deploy `agent/.env` — the shipped default is 90 min (`claude-spawn.ts:299`, `.env.example:13`), and on a 90-min deployment a flat 75-min video threshold + 2 sightings alerts at ~80+ min, i.e. AFTER the cap has effectively decided the job. The checker reads `MAX_JOB_DURATION_MS` from the SAME env file the worker loads (self-consistent per deployment) and applies: `T_render_effective(video) = min(T_render_video, MAX_JOB_DURATION_MS − 30 min)`, floored at 20 min; other products are far below any plausible cap and stay flat. Caveat recorded: the cap runs on sleep-excluded `activeMs` while the checker measures wall-clock from launch markers — the clamp is a lead-time heuristic, biased toward alerting EARLY (wall-clock ≥ activeMs always), which is the safe direction. The MERGE wave should also sync `.env.example` to the deployed 150-min value as a separate line item so repo default and prod stop drifting.

Envs: `STUDIO_CHECKER_ENABLED` (default `true`; the arming act is the task registration itself, the env is the fast disarm), `STUDIO_CHECKER_T_RENDER_<PRODUCT>_MS`, `STUDIO_CHECKER_T_APPEAR_MS`, `STUDIO_CHECKER_LOCK_TTL_MS` — all through the sweep's NaN-safe `envInt/envMs` guard pattern (`studio-recovery-sweep.ts:62-69`). Video's 75-min alert lands ~100–120 min into a typical job — before the 150-min cap kill, by design.

---

## §6 Alert-only vs act: v1 is strictly read-only

The strongest design pressure is AGAINST acting:

1. **The mutual-exclusion matrix.** [D]'s merge gate must prove no double-fire across yield-path / S136 duration-recovery / Gate-A video-defer ([D] doc:233). A checker that kills or re-renders is a 4th arm in that matrix, designed before [D] exists — guaranteed rework.
2. **The attempt-cap hazard class (S191 §3).** Anything that injects extra ticks or shares the sweep's counters recreates the exact regression the render-backoff design exists to prevent. The checker keeps its OWN counters (latch files) and never touches `studio_recovery_*`.
3. **Completes-exactly-once (S185 I5).** No second completion/park edge, ever.
4. **No prompt-side feedback (S185 D-8, resolved "no prompt-side hint").** The checker never signals the running agent; feeding status INTO the child would contradict a reviewed decision and re-open drift surface.
5. **The kill already exists.** `MAX_JOB_DURATION_MS` is the bounded backstop; a checker-initiated earlier kill converts an alert-latency problem into a job-killing false-positive problem (S130: a healthy idle-looking run was nearly killed manually).

v2 act candidates, each behind its own later gate: supply S191's deferred D-B3 persisted `render_failed_streak`; feed [D]'s host-wait telemetry; auto-refresh-auth nudge. None in v1.

---

## §7 Interaction contracts (compose, don't collide)

- **S129 gate:** disjoint by lifecycle — checker watches `running`; the gate runs at child exit inside the worker. Checker latches close when status leaves `running`.
- **S162 sweep:** disjoint by predicate — sweep sees `failed+pending` only; checker sees `running` only. A parked row is the sweep's; the checker's last act for a job is noting the transition in its log. No shared counters, no shared alerts (sweep's exhausted/deferred emails are its own).
- **150-min cap:** thresholds are cap-aware (§5.4); after a cap-kill the S136 → gate → park pipeline takes over and the row leaves `running`.
- **`STUDIO_VIDEO_RENDER_ENABLED`:** checker is flag-independent (observes regardless); alert copy for video stalls states whether best-effort parking is armed, so the operator knows what happens next if the run dies.
- **Step 5e / Step A.1 / unified poll loop:** untouched (N5). The checker is pure observation of their effects.
- **DB `phase_status` lag (S195 owed item):** NOT fixed here — that is a worker `watchStateFile` cadence/unchanged-check issue (`state-evaluation.ts:99-101`), tracked separately. The checker partially compensates by reading the workdir directly (ground truth per S195).
- **`regenerate-studio-products.ts` / studio_only runs: EXCLUDED from v1** (Codex MAJOR — the v1 claim "same checks free of charge" was FALSE). Grounding: studio_only bypasses `spawnClaude` entirely (`executor.ts:212-218`, `:704-715`, `:797-800` — a Node child runs the regen script), the regen script writes `<slug>-state.json` (`regenerate-studio-products.ts:399`), persists `artifacts[product].task_id` only AFTER a completed artifact is found (`:635-643`), and never writes `studio_before_ids.json` — so the checker has no ours-not-foreign proof, no launch marker, and no claude-child breadcrumb. v1 skips `pipeline_mode='studio_only'` rows (§5.1). v2 candidate: dedicated studio_only instrumentation (breadcrumb `kind:"studio_only"` around the regen child, launch-time task-id persistence, a run-floor marker) — its own review.

---

## §8 [D] convergence (the two designs must meet, not race)

User-approved [D] expansion: [D] will own BOTH the corpus-import wait AND the video-render wait (child dispatches + yields; worker polls uncapped; [M2] removes [C]'s Step 5e in-turn poll). The checker is designed to be [D]-invariant:

1. **The checker verifies WHOEVER owns the wait.** Pre-[D]: the child's in-turn poll is the waiter — the checker watches NLM + child liveness. Post-[D]: the worker's import-wait/render-wait sweep is the waiter — a **v2 arm at [D]-time** adds a `SWEEP_WEDGED` row (`*_wait_status='pending'` with `next_attempt_at` overdue by > 2× schedule). Note this is NOT free under v1's query: parked rows live in `status='failed'` (or [D]'s equivalent), which v1's `status='running'` select never returns (Gemini MAJOR-3) — the v2 arm explicitly WIDENS the DB scope to the parked dimension, and that widening is reviewed inside [D]'s own gate, not assumed here. v1 stays strictly `running`-scoped.
2. **Enum discipline ([D] doc:105):** products = ARTIFACT enum (1/2/3/4); any future import arm = SOURCE enum (1/2/3/5); the two tallies never mix. v1 contains no SOURCE polling at all (N2).
3. **No ownership transfer needed at [M2]:** since the checker never acts and never feeds the child, removing Step 5e changes nothing in the checker; its phase-context read simply stops seeing 5e heartbeat strings.
4. **Shared primitive:** [D] specifies `nlm-source-cli.ts` (absent today); the checker adds ONE additive structured-error export to the existing `nlm-artifact-cli.ts` (§5.1) — no new NLM module is authored by this design, and no shipped consumer's contract changes.

---

## §9 Failure containment + security

- **Never throws visibly:** whole-run try/catch → exit 0 always (a crashing checker must not spam Task Scheduler failure states); per-job try/catch so one malformed workdir can't blind the fleet; per-product guards mirror the sweep's L1/L2/L3 no-strand pattern (structurally: guards → structural backstop → payload validation).
- **Read-only enforcement by construction:** the script imports NO write-capable job helpers (`updateJob`/`failJob`/`completeJob` are not imported); DB access is `research_queue` SELECTs only (running rows + tracked-id close-out — §5.1). Its only writes: `agentRuntimeDir()/.studio-checker/*` + its own log `agentRuntimeDir()/studio-checker.log` (size-capped rotation, 5 MB).
- **Secrets:** alert bodies carry ids/slugs/status numbers only; no env values, no URLs with tokens, no user topic text. The script reads the same `agent/.env` the worker does (no new secret surface).
- **Untrusted input:** slugs/paths from the DB are used for filesystem lookups under `WORKING_DIR` only after the same slug-shape validation the sweep applies; state.json fields are parsed defensively (non-object → skip job with log line).
- **Cost:** $0 marginal (NLM list + one DB select per 5 min; no Anthropic/model calls). Worst-case NLM load: jobs×products list calls per invocation — in practice ≤5 (single-worker, one job at a time).

---

## §10 Implementation sketch + test plan (for the later MERGE wave)

**Files:**
1. `agent/scripts/studio-product-checker.ts` — the pass (§5), deps-injected like the sweep for testability (~350 LOC).
2. `agent/lib/runtime-paths.ts` — NEW: `agentRuntimeDir()` cwd-independent anchor (~15 LOC) (§4.3).
3. `agent/lib/notify.ts` — add `sendStudioStallAlert` (~40 LOC, S187 pattern).
4. `agent/lib/nlm-artifact-cli.ts` — additive `listArtifactsWithStatusDetailed` structured-error export (~40 LOC); existing null-contract functions untouched (§5.1).
5. `agent/lib/studio-completeness.ts` — export the currently-private `PRODUCT_TO_NLM_TYPE` as readonly (one line) (§5.1).
6. `agent/executor.ts` — breadcrumb write (post-spawn) + delete (post-`waitForProcess` + `finally` failsafe) seam (~15 LOC) (§4.2).
7. `agent/.env.example` — sync `MAX_JOB_DURATION_MS` to the deployed 150-min value (drift closure, §5.4).
8. `agent/worker-start.bat` — `cd /d "%~dp0"` (own directory) so the cwd invariant is structural in TRACKED code and the DR-Deploy untracked local edit dissolves (fresh-Claude M-3, §4.3).
9. `agent/lib/find-state-file.ts` (or `executor.ts:136` call site) — extend the claim-time archive to also sweep `studio_before_ids.json` into `.superseded-state/` (fresh-Claude C-1 sibling; checker-side freshness gate exists regardless).
10. Worker idle-tick breadcrumb GC for non-running jobs (fresh-Claude INFO, §4.2).
11. Scheduled Task registration (documented command, DR-Deploy paths): `DynamicResearchStudioChecker`, every 5 min, **StartIn = DR-Deploy `agent/`** (§4.3), `node --import=tsx --env-file=.env scripts/studio-product-checker.ts`, console-detached per the Scheduled-Task daemon discipline.
12. Tests `agent/test/studio-product-checker.test.ts`: table-driven detection matrix (§5.2 all rows × healthy/boundary/malformed payloads); freshness gates (stale `studio_before_ids.json`, stale breadcrumb vs `claimed_at`); detailed-list error classification (auth vs cli-crash vs timeout vs parse); PID-reuse guard (recycled PID, cmd.exe shim cmdline, CreationDate drift); worker-location-mismatch belt; lock contention/stale-lock; latch dedup + escalation + recovered; auth/blind suppression of per-product conditions; missed-tick post-wake grace; malformed state.json / missing breadcrumb / missing workdir degrade paths; read-only assertion (no job-mutation helpers imported — a grep-style guard test like the storage-paths pattern).

**Deploy order:** (1) checker script + notify + tests (inert until task registered); (2) breadcrumb seam; (3) register task; observe ≥1 real run; then tune thresholds from observed timings. All `agent/` PROD → full §11 tri-vendor MERGE gate BEFORE merge; no substitutes (S141 HARD RULE).

---

## §11 Adversarial targets for this DESIGN gate's reviewers

1. **False-positive storm** — which §5.2 row fires on a HEALTHY run? (S130 benign-idle is the historical trap; the post-child executor tail is the subtle one.)
2. **False negatives** — a stall mode in §1.2 the matrix misses; signals that lie beyond the documented `artifact poll`.
3. **Breadcrumb soundness** — PID reuse, orphaned breadcrumbs after worker crash, breadcrumb-write failure paths.
4. **Interaction double-fire** — any path where checker + sweep + gate alert or act on the same fact in conflicting ways.
5. **[D] collision** — anything here that [D]'s dispatch-and-yield restructure would have to undo.
6. **Windows reality** — sleep/wake, Task Scheduler misfires, PID semantics, cp1252/emoji in `artifact list` output (known crash), venv path.
7. **Alert fatigue** — is once-per-condition + one escalation the right budget when a video legitimately takes 90 min?
8. **Auth-degraded classification** — can a real auth failure masquerade as artifact-gone and trigger wrong per-product alerts?

## §12 Open questions — RESOLVED (Gemini pass, v2)

- Q1. `CAP_APPROACH` — **DROPPED** (Gemini MINOR-5/Q1: wall-clock false-fires on every wake-from-sleep because the real cap runs on sleep-excluded `activeMs`; T_render alerts land earlier and measure actual product progress).
- Q2. Threshold defaults — **ship §5.4 defaults, tune from checker logs** (alert-only makes them safe to deploy-then-tune; Gemini concurs).
- Q3. Generic phase-stall FYI — **v2** (keep v1 strictly Studio-scoped; prove the read-only independent-checker pattern first; Gemini concurs).
- Q4. Latch dir — **`agentRuntimeDir()/.studio-checker/`** (locality with `.run`/`.preflight-backoff`; wiped with the workspace; Gemini concurs; cwd-independent anchor per §4.3 — the `<cwd>` phrasing this answer originally used was itself the trap, fresh-Claude M-4).

## §13 Changelog

- **v1 → v2 (Gemini 3.1-pro holistic-adversarial BLOCK, all 7 findings integrated):**
  - CRITICAL-1: breadcrumb deleted at `waitForProcess` resolution (not executeJob end); semantics = "exit not yet observed"; kills the executor-tail false-positive storm (§4.2, §5.2 #6).
  - CRITICAL-2: added the additive `listArtifactsWithStatusDetailed` structured-error export — the null-swallowing shipped wrappers made auth-degraded detection impossible (§5.1, §5.2 #8).
  - MAJOR-3: `SWEEP_WEDGED` removed from v1; the post-[D] arm explicitly requires widening the DB query beyond `status='running'` and is reviewed in [D]'s gate (§8.1).
  - MAJOR-4: PID guard spec'd via `Get-CimInstance Win32_Process` (CommandLine loose-match `claude` — cross-spawn `cmd.exe` shim wrapper — + CreationDate ±2 min); `process.kill(pid,0)` explicitly insufficient (§4.2).
  - MINOR-5/Q1: `CAP_APPROACH` row dropped entirely (§5.2).
  - MINOR-6: product→CLI `--type` map single-sourced from `studio-completeness.ts:78-84` (`slides` → `slide-deck`) (§5.1).
  - INFO-7: new `NLM_CLI_BLIND` matrix row — 3 consecutive non-auth structured failures ⇒ "the observability layer itself is failing" alert + per-product suppression (§5.2 #9).
- **v2 → v3 (Codex gpt-5.5 xhigh grounded-adversarial BLOCK, all 4 findings integrated; direction endorsed, 10 grounded-correct confirmations):**
  - CRITICAL: runtime-state paths were cwd-ambiguous (`worker-start.bat:13-14` cds into `agent/`; `.worker.pid` under `process.cwd()` at `worker.ts:47`) → NEW `agent/lib/runtime-paths.ts` `agentRuntimeDir()` anchor (import.meta.url, never cwd) for `.run/` + `.studio-checker/` + reading `.worker.pid`; checker task StartIn=agent (§4.2, §4.3, §10).
  - MAJOR-1: video threshold ungrounded vs the shipped 90-min default cap (`claude-spawn.ts:299`, `.env.example:13` — 150 min is DR-Deploy-only) → cap-aware clamp `min(T_render_video, cap − 30 min)` from the same env file + `.env.example` sync line item (§5.4).
  - MAJOR-2: studio_only "same checks free of charge" was FALSE (no launch markers, no `studio_before_ids.json`, task_id persisted only post-completion, no claude child — `executor.ts:212-218/:704-715/:797-800`, `regenerate-studio-products.ts:399/:557-580/:635-643`) → studio_only EXCLUDED from v1, `pipeline_mode` added to the select, dedicated-instrumentation v2 candidate (§5.1, §7).
  - MINOR: `PRODUCT_TO_NLM_TYPE` is private → export-as-readonly line item + parity test (§5.1, §10).
- **v3 → v4 (fresh-Claude grounded refutation lens BLOCK — 1C/4M/4m/4I, all integrated; the CRITICAL + M-1 + M-3 were missed by BOTH externals):**
  - C-1: stale `studio_before_ids.json` in reused workdirs (only STATE files are archived at claim — `find-state-file.ts:35-37`, `executor.ts:136`) poisoned the launch marker AND the run floor → all launch markers now freshness-gated vs `claimed_at` (added to the select); sibling archive line item (§3, §5.1, §10).
  - M-1: hard-death → re-claim stale breadcrumb false-fired #6 in the pre-spawn window → breadcrumb deleted at top of `executeJob` + #6 requires `spawnedAt ≥ claimed_at` (§4.2, §5.2).
  - M-2: the S133 wedged-child presentation (all products done, child alive, row running) was undetectable → new matrix row 10 `CHILD_WEDGED_POST_STUDIO` (§5.2).
  - M-3: the §4.3 cwd invariant rested on an UNTRACKED DR-Deploy local edit of `worker-start.bat` (tracked copy cds into the DEV tree) → `%~dp0` MERGE line item + `WORKER_LOCATION_MISMATCH` belt on #7 + reality documented (§4.3, §5.2, §10).
  - M-4: stale `<cwd>/` cross-refs in §5.1/§9/§12 re-introduced the fixed Codex CRITICAL → editorial sweep to `agentRuntimeDir()`.
  - m-1: "`artifact poll` never invoked by shipped code" corrected (slash-prompt auth probe `research-compare.md:1163-1168`; child may `sys.exit(3)` before #8 confirms) (§3, §5.2 #8).
  - m-2: "uptime-since-wake" has no Windows/Node API → missed-tick detection from the checker's own latch (§5.2 notes).
  - m-3: "single select" wording → `research_queue` SELECTs only (running + tracked-id close-out) (§5.1, §9).
  - m-4: clock anchors specified — T_appear from `max(marker mtime, claimed_at)`, T_render from artifact `created_at` (§5.2 notes).
  - INFO: §10 renumbered; auth-interference verified clean (CLI read-only on `storage_state.json`) + load sentence added (§3); breadcrumb GC assigned (§4.2, §10); report-only / DRY_RUN / plan-review windows verified clean.
- **v4 → v4.1 (S197 IMPLEMENTATION MERGE-gate amendments — recorded here so the spec and the shipped checker cannot drift; full record in `Documentation/studio-product-checker-merge-gate-peer-review.md`):**
  - **Row 10 RE-ANCHORED (fresh-lens MERGE M-2):** the wedge's 25-min quiet was spec'd against artifact `created_at`, which NLM stamps at SUBMIT time — a healthy 40-min video render satisfied ">25 min ago" the instant it completed, making row 10 cry wolf on every long render (the S130 class the design itself warns about; BOTH external reviewers passed it because the code was spec-faithful — the spec encoded the defect). Now: the quiet period is CHECKER-OBSERVED all-complete time, realized as ceil(T_wedge/cadence)+1 spaced consecutive sightings.
  - **Row 11 ADDED — `PROCESS_PROBE_BLIND` (Codex MERGE MAJOR-4):** persistent PID-probe failure (CIM access/PowerShell health) must alert rather than silently blind rows #6/#7; probe failures freeze the affected liveness latch keys.
  - **Blind ≠ absent generalized (Codex MERGE MAJOR-3 → fresh-lens MERGE MAJOR-1):** any latch key whose check was SKIPPED (list failure, missing state/notebook, probe failure, per-job throw, zero list calls / zero probes for the GLOBAL keys) is FROZEN — neither incremented nor RECOVERED. A real outage whose job dies must not email "recovered" mid-incident.
  - **§5.1's tracked-id close-out read is LOAD-BEARING (Codex MERGE MAJOR-2):** the implementation initially dropped it; a transient running-page read failure would have wiped alerted latches (dedup state) and re-armed alert spam. Restored as `fetchTrackedJobStatuses` (null ⇒ keep every latch).
  - **§3 marker freshness precisified (Codex MERGE CRITICAL-1):** the embedded `run_floor_ms` must EXIST and be ≥ `claimed_at` (AND-gated with mtime when present); a floor is never defaulted to 0 — fail toward NO_ARTIFACT, never toward resolving a prior-run artifact as ours.
  - **Sighting spacing enforced (fresh-lens MERGE m-3):** consecutive sightings count only when ~a cadence apart (0.8×), so a manual run adjacent to the scheduled tick cannot instant-confirm a 2-sighting condition.
  - **Lock semantics (Codex MERGE MAJOR — atomic `wx` create; fresh-lens MERGE m-4 — rename-aside stale takeover, single winner).**
