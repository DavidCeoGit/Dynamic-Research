# Studio Product Checker — DESIGN-gate peer review (S196, 2026-07-01)

MRPF record for `Documentation/studio-product-checker-design-gate.md`.

- **Gate:** DESIGN. **Risk labels:** AGENT BEHAVIOR + INFRA. **Severity:** NORMAL.
- **Topology:** sequential — Gemini 3.1-pro (holistic-adversarial, breadth) on v1 → integrate → Codex gpt-5.5 (grounded-adversarial, depth) on v2 → integrate → fresh-Claude grounded lens (S195 standing rule for this failure family) → final.
- **What each reviewer saw:** Gemini — NO repo access; the v1 doc + six agent-authored file:line-anchored grounding digests (sweep / gate / worker-spawn / slash-prompt / design-docs / nlm-signals), bundle 121 KB (`/c/tmp/dr-s196/review/review-bundle.md`). Codex — the v2 doc embedded in the prompt + FULL repo workspace (read the shipped modules + the global slash prompt + the three prior design docs), `codex exec -s workspace-write`, run-banner asserted `model: gpt-5.5`, provider openai, reasoning xhigh. Fresh-Claude — zero authoring context, full repo, prompted to REFUTE.
- **Raw logs:** `/c/tmp/dr-s196/review/gemini-out.log`, `/c/tmp/dr-s196/review/codex-out.log`.

---

## Round 1 — Gemini 3.1-pro-preview (holistic-adversarial) on v1: **BLOCK**

Banner: `model=gemini-3.1-pro-preview, prompt=38252 thoughts=8026 output=1503 finish=STOP`.

### Verbatim findings

> **VERDICT: BLOCK**
>
> **[CRITICAL] 1. Breadcrumb Lifecycle Causes False Positives During Executor Tail**
> - **Concern:** Design §4.2 places the breadcrumb deletion in a `finally` block around the `executeJob` tail. Design §5.2 row 6 alerts `CHILD_DEAD_JOB_RUNNING` if the breadcrumb PID is dead and `updated_at` is stale > 20 min.
> - **Why it matters:** The S129 completeness gate and `uploadOutputs` run *after* the child exits but *before* `executeJob` finishes (Digest 2 §1). The S129 gate can legitimately poll for 15+ minutes per missing product without updating the DB `updated_at`. During this time, the child is dead, the breadcrumb is still present, and `updated_at` becomes stale. This guarantees a false-positive storm during a healthy post-run tail.
> - **Fix:** Move the breadcrumb deletion to immediately after `waitForProcess` resolves (when the child actually exits), rather than the end of `executeJob`. If the breadcrumb is gone, the checker knows the child's exit was already observed by the worker and skips the child-dead check.
>
> **[CRITICAL] 2. Auth-Degraded Detection is Impossible with Specified Primitive**
> - **Concern:** Design §5.2 row 8 relies on seeing the "auth-redirect signature" to detect degraded auth. However, Design §8.4 mandates reusing `nlm-artifact-cli.ts`'s status-aware list "as-is".
> - **Why it matters:** Digest 5 §0 and Digest 2 §1 confirm that the CLI wrappers in `nlm-artifact-cli.ts` are whole-body throw-guarded and return `null` on any failure. The checker will receive a silent `null`, not the stdout/stderr containing the auth-redirect string. It will be completely blind to auth failures.
> - **Fix:** Either the checker must bypass the wrapper and shell out to `NLM_BIN` directly to capture stderr, or `nlm-artifact-cli.ts` must be modified to return a structured error (e.g., `{error: "auth_expired"}`) instead of a silent `null`.
>
> **[MAJOR] 3. [D] Convergence Contradicts Checker's DB Query Scope**
> - **Concern:** Design §8.1 claims that post-[D], the checker will monitor parked sweeps by looking for `*_wait_status='pending'` and alert `SWEEP_WEDGED`.
> - **Why it matters:** Design §5.1 explicitly restricts the checker's DB input to `status='running'`. Parked jobs (both S162 studio recovery and [D] import wait) reside in `status='failed'` rows (Digest 4 §1). The checker will never see these rows, making the [D] convergence claim structurally impossible.
> - **Fix:** Remove the `SWEEP_WEDGED` parked-row monitoring from v1 scope entirely. Keep the checker strictly focused on `status='running'` in-flight jobs.
>
> **[MAJOR] 4. Windows PID-Reuse Guard is Unimplementable as Specified**
> - **Concern:** Design §4.2 requires checking if the process command line matches `claude` and start time matches `spawnedAt`.
> - **Why it matters:** Node.js `process.kill(pid, 0)` cannot retrieve command lines or start times. Furthermore, because `spawnClaude` uses `cross-spawn` (Digest 3 §2), the actual process spawned on Windows is `cmd.exe /c claude`, so the command line won't strictly be `claude`.
> - **Fix:** Explicitly specify shelling out to `wmic process where processid=<pid> get CommandLine,CreationDate` (or using PowerShell) to perform this check, and adjust the command-line match to account for `cmd.exe` wrappers.
>
> **[MINOR] 5. `CAP_APPROACH` Heuristic Ignores Windows Sleep** — wall-clock vastly exceeds `activeMs` after sleep → false alert on every wake. Fix: drop it (see Q1).
>
> **[MINOR] 6. Product Type Mapping for Slides** — the NLM CLI expects `slide-deck`, not `slides`; apply the `studio-completeness.ts:78-84` map.
>
> **[INFO] 7. Handling `null` from CLI Wrappers** — transient CLI failures (e.g. cp1252 emoji crash) must neither false-alert as "no artifact" nor be silently ignored; add a consecutive-nulls `NLM_CLI_BLIND` alert.
>
> **OPEN QUESTIONS:** Q1 DROP `CAP_APPROACH`; Q2 ship §5.4 defaults, tune from logs; Q3 defer generic phase-stall to v2; Q4 keep latch dir under `<cwd>/.studio-checker/`.

### Dispositions (all 7 integrated → v2; doc §13 changelog)

| # | Sev | Disposition |
|---|---|---|
| 1 | CRITICAL | **Accepted verbatim** — breadcrumb deleted at `waitForProcess` resolution; semantics redefined to "exit not yet observed by worker"; matrix row 6 rewritten; `finally` failsafe retained for throw paths (§4.2, §5.2). |
| 2 | CRITICAL | **Accepted, additive-variant form** — new `listArtifactsWithStatusDetailed` structured-error export in `nlm-artifact-cli.ts`; existing null-contract consumers untouched (§5.1). |
| 3 | MAJOR | **Accepted** — `SWEEP_WEDGED` cut from v1; §8.1 now states the post-[D] arm requires a DB-scope widening reviewed in [D]'s own gate. |
| 4 | MAJOR | **Accepted, PowerShell form** — `Get-CimInstance Win32_Process` (not deprecated wmic); loose `CommandLine` match for the cross-spawn `cmd.exe` shim; `CreationDate` ±2 min (§4.2). |
| 5 | MINOR | **Accepted** — `CAP_APPROACH` row + env knob dropped entirely (§5.2, §5.4, §12 Q1). |
| 6 | MINOR | **Accepted** — product→CLI `--type` map imported from `studio-completeness.ts:78-84` (§5.1). |
| 7 | INFO | **Accepted** — new matrix row 9 `NLM_CLI_BLIND` (3 consecutive non-auth structured failures; suppresses per-product conditions) (§5.2). |

---

## Round 2 — Codex gpt-5.5 xhigh (grounded-adversarial) on v2: **BLOCK** (direction endorsed; all findings implementability corrections)

Run-banner asserted: `OpenAI Codex v0.130.0, model: gpt-5.5, provider: openai, sandbox: workspace-write, reasoning effort: xhigh`. 266,500 tokens. Read the shipped modules + the global slash prompt + the three prior design docs.

### Verbatim findings

> **VERDICT: BLOCK**
>
> **[CRITICAL]**
> Concern: Checker/worker runtime state path is underspecified and can point at the wrong directory.
> Grounding: `agent/worker.ts:47` writes `.worker.pid` under `process.cwd()`. The shipped worker launcher first `cd`s into `agent/` and then starts `worker.ts` (`agent/worker-start.bat:13-14`). A checker launched from repo root, as the design sketch implies with `--env-file=agent/.env agent/scripts/...`, will not see the worker PID file or `.run` breadcrumbs written from the worker process.
> Why it matters: This can cause a false-positive storm (`WORKER_DEAD_JOB_RUNNING`) on healthy jobs and also blind `CHILD_DEAD_JOB_RUNNING`.
> Concrete fix: Define one absolute runtime-state dir for `.worker.pid`, `.run`, and `.studio-checker`, or launch the checker with `StartIn=agent` and paths relative to `agent/`. Do not leave this to ambient `process.cwd()`.
>
> **[MAJOR]**
> Concern: The video thresholds are not grounded against the shipped 90-minute cap.
> Grounding: `waitForProcess` defaults `MAX_JOB_DURATION_MS` to `5_400_000` (`agent/lib/claude-spawn.ts:299`) and kills at the active-duration check (`agent/lib/claude-spawn.ts:328-333`). The repo env example also sets `MAX_JOB_DURATION_MS=5400000` (`agent/.env.example:13`). The design assumes 150 minutes and sets video `T_render=75 min` plus two sightings.
> Why it matters: On the shipped/default 90-minute cap, a video that starts after the earlier research phases can hit the cap before the checker ever confirms a stall. That misses the main "silent render stall before cap" goal.
> Concrete fix: Either ground and ship the 150-minute deploy config as part of this design, or make thresholds cap-aware from the actual env and lower/adjust video alerting so it fires before the cap in the real runtime.
>
> **[MAJOR]**
> Concern: The `studio_only` "same checks free of charge" claim is false.
> Grounding: `studio_only` bypasses `spawnClaude` and runs `regenerate-studio-products.ts` via a Node child (`agent/executor.ts:212-218`, `agent/executor.ts:704-715`, `agent/executor.ts:797-800`). The regen script writes `<slug>-state.json` (`agent/scripts/regenerate-studio-products.ts:399`) and only persists `artifacts[product].task_id` after a completed artifact is found (`agent/scripts/regenerate-studio-products.ts:635-643`). There is no `studio_before_ids.json` path in that script, and launch task IDs are not written at launch (`agent/scripts/regenerate-studio-products.ts:557-580`).
> Why it matters: During a healthy long studio-only render, the checker cannot prove the in-progress artifact is ours, cannot reliably detect "launched but no artifact," and would not get the normal Claude-child breadcrumb if only the normal spawn site is instrumented.
> Concrete fix: Either explicitly exclude `pipeline_mode='studio_only'` from v1, or add studio-only instrumentation: breadcrumb with `kind:"studio_only"`, a Node/regenerate PID guard, launch-time task-id persistence, and a run-floor/launch marker.
>
> **[MINOR]**
> Concern: The product-to-CLI map is not currently importable.
> Grounding: `PRODUCT_TO_NLM_TYPE` is a private `const` in `agent/lib/studio-completeness.ts:78-84`, used internally at `agent/lib/studio-completeness.ts:338`. The repo also has a separate regen `PRODUCT_DEFS` map (`agent/scripts/regenerate-studio-products.ts:124-130`).
> Why it matters: The design says to import/re-export the existing map, but implementation would currently have to re-author it or modify an unlisted file.
> Concrete fix: Export a readonly `productToNlmType` helper/map from a shared module and make the checker import it; add a parity test for `slides -> slide-deck`.
>
> **[INFO]** No additional blocker found for alert-only scope, DB read-only posture, or sweep/gate lifecycle separation.
>
> **GROUNDED-CORRECT** (10 confirmations): worker poll blocked during job (`worker.ts:243-288`); `.worker.pid` PID-only (`worker.ts:47-96`); `waitForProcess` sleep-gap-excluded active time, kills only the child (`claude-spawn.ts:316-370`); `crossSpawn("claude", ...)` loose cmdline guard plausible (`claude-spawn.ts:233-237`); `watchStateFile` drops same-phase updates (`state-evaluation.ts:99-101`, `:127-168`); `realListArtifactsWithStatus` returns `null` on any failure — a new detailed result is needed (`nlm-artifact-cli.ts:152-187`); S129 obligations from durable DB `selected_products` (`studio-completeness.ts:177-180`, `executor.ts:510-520`); recovery sweep post-park only (`studio-recovery-sweep.ts:747-765`); `studio_before_ids.json` written before full-pipeline Studio generation (`research-compare.md:977-1004`); Studio poll loop prints but never updates state in-loop (`research-compare.md:1027-1198`).

### Dispositions (all 4 integrated → v3; doc §13 changelog)

| Sev | Disposition |
|---|---|
| CRITICAL | **Accepted** — NEW `agent/lib/runtime-paths.ts` `agentRuntimeDir()` anchored on `import.meta.url` (never cwd) for `.run/` + `.studio-checker/` + reading `.worker.pid`; `worker-start.bat` cwd invariant documented as load-bearing; checker task StartIn=agent (§4.2, §4.3, §10). `.worker.pid` NOT moved (zero worker behavior change). |
| MAJOR (cap) | **Accepted, clamp form** — `T_render_effective(video) = min(T_render_video, MAX_JOB_DURATION_MS − 30 min)` floored at 20 min, read from the same env file the worker loads; wall-clock-vs-activeMs bias noted (alerts EARLY, the safe direction); `.env.example` 150-min sync added as a MERGE-wave line item (§5.4, §10). |
| MAJOR (studio_only) | **Accepted, exclusion form** — `pipeline_mode='studio_only'` rows SKIPPED in v1 (`pipeline_mode` added to the select); dedicated-instrumentation v2 candidate recorded (§5.1, §7). |
| MINOR | **Accepted** — export `PRODUCT_TO_NLM_TYPE` as readonly (one-line visibility change) + `slides → slide-deck` parity test (§5.1, §10). |

---

## Round 3 — fresh-Claude grounded refutation lens on v3: **BLOCK** (1 CRITICAL + 4 MAJOR + 4 MINOR + 4 INFO; architecture endorsed)

Zero-authoring-context subagent, full repo + global slash prompt + live DR-Deploy inspection + installed `notebooklm_py` package source; prompted to REFUTE; 178k tokens, 38 tool uses. **The CRITICAL and two of the MAJORs were missed by BOTH externals — the third consecutive fresh-lens catch in this failure family (S193 state-file naming, S195 tally-outside-try, S196 these).**

### Verbatim findings (fixes abridged where the disposition table repeats them)

> **VERDICT: BLOCK** — 1 CRITICAL + 4 MAJOR findings, all grounded against shipped code. The design's core architecture (independent read-only scheduled task, breadcrumb seam, structured-error list variant) survives scrutiny — every BLOCK item is fixable inside this doc without changing the architecture.
>
> **[CRITICAL] C-1. Stale `studio_before_ids.json` in a reused workdir poisons the launch marker AND the run floor → guaranteed false `NO_ARTIFACT_AFTER_LAUNCH` on healthy re-queued runs (unfixed sibling of S117).** The claim-time archive matches ONLY state files (`isStateFileName` = `state.json`/`*-state.json`, `find-state-file.ts:35-37`; filter `:77-96`; sole call site `executor.ts:136`). Grep of `agent/` for `studio_before_ids`: zero matches — no worker code writes, archives, or deletes it; it is written only by the child (`research-compare.md:990-1002`) and persists forever; per-slug workdirs are intentionally reused across re-queues (`find-state-file.ts:53-56`). Attempt-2 walk: stale marker (old mtime → T_appear long expired) + stale floor matching nothing → matrix #4 fires on a healthy re-run at exactly the post-failure moment the operator most needs to trust the alert; inversely a stale floor resolves attempt-1 artifacts as "ours", masking a genuine attempt-2 stall. Fix: freshness-gate every launch marker vs the row's `claimed_at` (column exists — baseline `:424`; set at claim, `frontend/app/api/queue/claim/route.ts:45`); optional sibling line item extends the archive filter.
>
> **[MAJOR] M-1. Stale breadcrumb on the re-claim path → `CHILD_DEAD_JOB_RUNNING` false positive in the pre-spawn window (twin of C-1 and of Gemini CRITICAL-1).** No `finally` runs on hard worker death; on re-queue of the SAME job id, the pre-spawn window (attachments, manifest, multi-minute plan-review gate `executor.ts:221`; DRY_RUN never spawns) holds row=`running` + stale breadcrumb + dead recorded PID; two sightings fit inside a normal plan-review window. §5.2's "cannot false-fire" note covered only the post-child tail. Fix: delete any existing breadcrumb at TOP of `executeJob`; #6 requires `spawnedAt ≥ claimed_at`.
>
> **[MAJOR] M-2. "Wedged child" (G2, §1.2 #3) is claimed but the matrix cannot detect its canonical presentation.** The S133 signature — all selected products `status_id 3`, child ALIVE, DB frozen — fires NO row (1/2 need status 1-2; 4 needs no match; 6 needs a dead PID). The exact end-state of the phase-5/6 stop family rides silently to the cap — the §1.1 status quo the doc says it fixes. Fix: add `CHILD_WEDGED_POST_STUDIO` row (all products 3 + newest `created_at` ≥ T_wrap + row running + child alive, FYI class).
>
> **[MAJOR] M-3. The §4.3 cwd-independence fix rests on an UNTRACKED local edit — the tracked `worker-start.bat` points at the DEV tree.** Tracked `agent/worker-start.bat:13` cds into the dev tree; the DR-Deploy copy is a git-dirty local modification (` M agent/worker-start.bat`) in a clone whose doctrine is "never edit there". Any `reset --hard`/conflicted pull reverts the prod worker's cwd — `.worker.pid`, `.run/`, `.env` (incl. the 150-min cap!), `worker.log` all silently move — and the checker false-storms `WORKER_DEAD` while losing #6. The scheduled task (verified via `Export-ScheduledTask`) has no StartIn — the bat's `cd` is the only cwd setter. Sibling scenario needing no git accident: a dev-tree worker running a dogfood job while the DR-Deploy worker is absent → same #7 false positive. Fix: `cd /d "%~dp0"` MERGE line item; checker cross-checks for ANY live worker process elsewhere → `WORKER_LOCATION_MISMATCH` instead of `WORKER_DEAD`; document the untracked-edit reality.
>
> **[MAJOR] M-4. v3 left stale `<cwd>/` cross-references in §5.1/§9/§12 that re-introduce the exact Codex CRITICAL the same version fixed.** Fix: editorial sweep to `agentRuntimeDir()`.
>
> **[MINOR] m-1.** "§3: `artifact poll` … never invoked by shipped code" is false — the slash prompt's poll loop retains one use as an auth-expiry probe that can `sys.exit(3)` the child (`research-compare.md:1163-1168`); during a real auth outage the child may exit before #8 reaches 2 sightings. Fix sentence + note the interaction.
> **[MINOR] m-2.** "Uptime-since-wake" is unimplementable — `os.uptime()` counts from boot incl. sleep. Fix: missed-tick detection from the checker's own latch (now − last invocation > 2× cadence ⇒ grace).
> **[MINOR] m-3.** "§9: DB access is a single select" contradicts §5.1's latch close-out (needs a second bounded read). Fix wording.
> **[MINOR] m-4.** Elapsed anchors unspecified. Fix: T_appear from `max(marker mtime, claimed_at)`; T_render from artifact `created_at` (server-side, sleep-immune).
>
> **[INFO]** §10 numbering glitch. Auth interference CLEAN (verified `notebooklm/auth.py:407-459` — CLI only LOADS `storage_state.json`, no write path; checker calls cannot corrupt child auth; ≤5 calls/5 min marginally accelerate staleness the 30-min refresh task resets). Breadcrumb GC unassigned. Report-only (`obligedProducts()`=[] → zero checks) / DRY_RUN (no state file, no breadcrumb, worker alive → no row fires) / plan-review windows CLEAN except M-1.
>
> **RESIDUAL-SWEEP:** Two unfixed siblings found (C-1: state files archived but not the sibling marker; M-1: breadcrumb delete covered normal-exit/cap-kill/throw but not hard-death→re-claim). Checked clean: both state-file naming conventions; workDir vs projectsDir; the second `waitForProcess` call site (`executor.ts:800`, regen — correctly breadcrumb-free since studio_only is excluded); DRY_RUN paths; the S136 duration-kill path (flows through the same `waitForProcess` resolution — single delete point covers both).

GROUNDED-CORRECT: 15 verification clusters, incl. the DB columns attack (`pipeline_mode`/`selected_products`/`claimed_at`/`updated_at` all exist — baseline `:421-447`), the ArtifactStatus enum from the installed package source (doc's L111-120 cite off by 2, immaterial), and every §4.1 rejected-alternative grounding. Full text in the session transcript; the doc's §13 v4 entry records each disposition.

### Dispositions (all integrated → v4; doc §13 changelog)

| # | Sev | Disposition |
|---|---|---|
| C-1 | CRITICAL | **Accepted** — all launch markers freshness-gated vs `claimed_at` (added to §5.1 select); archive-extension sibling line item §10.9. |
| M-1 | MAJOR | **Accepted** — breadcrumb delete at top of `executeJob` + #6 `spawnedAt ≥ claimed_at` (§4.2, §5.2). |
| M-2 | MAJOR | **Accepted** — new matrix row 10 `CHILD_WEDGED_POST_STUDIO` (§5.2). |
| M-3 | MAJOR | **Accepted, all three parts** — `%~dp0` line item §10.8; `WORKER_LOCATION_MISMATCH` belt on #7; untracked-edit reality documented (§4.3). |
| M-4 | MAJOR | **Accepted** — `<cwd>/` sweep to `agentRuntimeDir()` (§5.1, §9, §12). |
| m-1..m-4 | MINOR | **All accepted** (§3, §5.2 notes, §9, §5.1). |
| INFO ×4 | INFO | **All accepted** — §10 renumbered; auth-load sentence §3; GC assigned §10.10; clean-window verifications recorded. |

---

## Synthesis

- **Final: v4 CLEARED — DESIGN gate COMPLETE.** All three passes BLOCKed and every finding was integrated; none contested the architecture: an independent, read-only, alert-only 5-min scheduled task + a minimal worker-side breadcrumb seam survived three adversarial lenses intact. The BLOCKs were implementability and false-positive-hygiene corrections — exactly what a DESIGN gate is for.
- **What each reviewer saw:** Gemini — doc v1 + six file:line-anchored digests, NO repo. Codex — doc v2 embedded + full repo workspace (gpt-5.5 xhigh, banner asserted). Fresh-Claude — doc v3 + full repo + live DR-Deploy + installed notebooklm-py source, zero authoring context.
- **Cross-lens value, concretely:** Gemini (breadth) caught lifecycle/semantics hazards (breadcrumb timing, auth-blind wrapper); Codex (depth) caught deploy-reality gaps (cwd anchoring, 90-vs-150 cap, studio_only, private map); the fresh lens caught what BOTH missed — reuse/staleness pathologies (C-1, M-1), an undetectable-by-construction target class (M-2), and a prod-infrastructure fact neither external inspected (M-3, the untracked DR-Deploy bat edit). Third consecutive gate in this failure family where the fresh-Claude lens caught externally-endorsed defects → the S195 standing rule is re-confirmed and stays mandatory for this family.
- **Agreements:** all three independently endorsed alert-only scope, read-only posture, and the sweep/gate lifecycle separation (Codex INFO said so explicitly; Gemini pressed but did not contest §6; fresh lens called the architecture sound).
- **Disagreements:** none requiring adjudication — findings were disjoint by lens, zero contradictions between reviewers.
- **Forward obligations:** implementation = `agent/` PROD MERGE wave (full §11 tri-vendor BEFORE merge, no substitutes — S141 HARD RULE), deploy order §10; [D] convergence constraints §8 (v2 checker arms — SWEEP_WEDGED, studio_only instrumentation — reviewed inside their own gates).
