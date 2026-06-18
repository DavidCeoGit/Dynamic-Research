# Dynamic Research — Project Instructions

> Project-level overlay to `~/CLAUDE.md`. Lives at the project root. Read this BEFORE doing any work in this directory.

---

## 1. What this project is

`/research-compare` — three-way deep-research orchestrator (Perplexity Pro + NotebookLM Ultra + Claude Baseline) → CI-filtered analysis + NotebookLM Studio outputs. Live web frontend submits research requests; a Node.js worker daemon claims them from a Supabase queue and runs the pipeline via `claude -p`.

**Production URL:** https://dynamic-research.vercel.app

**Architecture:** Web Form (Next 16 / React 19) → Supabase Queue → Node.js Worker Daemon (`agent/`) → Claude CLI (spawns `claude -p`) → Supabase Storage → Web Gallery.

**Per-session memory + handoff:** `~/.claude/projects/c--Users-ceo-Documents-AI-Training-Anti-Gravity-Dynamic-Research/memory/` — `MEMORY.md` index + per-topic markdown. `dryrun_handoff.md` is the most load-bearing file in that directory.

---

## 2. Tech stack (canonical — pinned by package.json files)

- **Package manager:** pnpm everywhere. Never use `npm`/`yarn`. Lockfiles enforce this.
- **Runtime:** Node ≥ 22.19 (transitive floor from `undici` 8.x `engines.node`; encoded in `agent/package.json` engines field S98 — host runs Node 24.x); `tsx` is the loader for all TypeScript at runtime (`tsx scripts/foo.ts`, `tsx --import worker.ts`, `node --import=tsx worker.ts`).
- **Frontend:** Next 16, React 19, Tailwind 4, AI SDK 6.0 (`maxOutputTokens` param name).
- **Backend:** Node.js daemon in `agent/`; Supabase (Postgres + Storage + Auth magic-link).
- **Tests:** `node --test` (NOT vitest). Root `pnpm test` runs: (1) `bash agent/scripts/test-phase-b-storage-paths.sh` grep guard against legacy flat-layout storage paths, (2) strict `tsc --noEmit` on agent + frontend, (3) **the 502 unit tests** (S145 measured: `pnpm test` reports `tests 428` agent + `tests 74` frontend = 502) — `pnpm -C agent exec node --import=tsx --test "test/*.test.ts"` (428 agent) + the frontend suites via agent's tsx (74: hidden-runs + attachments + storage-attachments + publish-flag + publish-flag-parity). Unit-test wiring added S96 (2026-06-05); `storage-attachments.test.ts` (8 tests) added S110; `staging-sweep.test.ts` grew through S112/S113 to 47 tests by S145. (Prior counts "446 / 381 agent / 65 frontend / staging-sweep 40" were a frozen S113 snapshot, corrected S145.) NOTE: Node 22 `node --test` only auto-discovers `*.test.js`; passing an explicit glob arg (`"test/*.test.ts"`) is what makes it find the `.ts` tests.
- **TypeScript:** strict mode in every subproject.

---

## 3. Repo + git layout (standalone repo since S90)

**`Dynamic Research/` is its OWN git repo** (fresh `git init`, S90 2026-06-04 — extracted from the former shared `Anti Gravity/` monorepo; see `Documentation/dr-repo-extraction-design-gate.md`). Run `git status` / `git commit` / `git push` directly from this directory — no `cd` to a parent, no `git -C`.

The folder did NOT move — it still physically lives under `Anti Gravity/`, but it no longer uses the parent's `.git`. The parent `.git` is being retired as the other entangled stragglers extract; the full pre-split history is archived at `c:/tmp/dr-extraction-backup/anti-gravity-parent-20260604.bundle` (HEAD `11321ac`, restorable via `git clone <bundle>`).

GitHub remote: `origin` = `DavidCeoGit/Dynamic-Research` (the WHOLE project — frontend + agent + supabase + Documentation). `git push origin main` deploys (see §4).

**(Historical footgun, RESOLVED S90)** Pre-S90 the git repo was the PARENT `Anti Gravity/` shared across ~34 projects, causing branch-contention + a concurrent force-push that erased DR commits from the shared remote. Gone — DR owns its history now. The `feedback_shared_monorepo_concurrency_stash_hazard` + `feedback_pushclone_divergence_reconcile` patterns no longer apply to DR.

**Branch work happens in this folder directly** — the `DR-dev` linked worktree (added S109, retired S114) has been removed. Feature branches are created and worked on in `Dynamic Research/` itself. The load-bearing constraint (the cron task respawning the worker from whatever branch this folder has checked out) is solved by a **dedicated deploy-only clone** at `C:\Users\ceo\Projects\DR-Deploy\` — the `DynamicResearchWorker` scheduled task points to that clone's `worker-start.bat`, so dev branches checked out here never reach the prod Supabase worker. Workflow: create branch → sandbox+promote edits → commit → `gh pr create --base main` → merge → pull DR-Deploy + restart worker (see §4 and §6).

---

## 4. Deploy path (standalone — push-clone RETIRED S90)

**The SoT is `Dynamic Research/frontend/` and Vercel deploys it directly.** Vercel project `dynamic-research` builds from GitHub `DavidCeoGit/Dynamic-Research` with **Root Directory = `frontend/`** (set via the project's settings; the whole project lives in the repo, the Next app is the `frontend/` subdir).

**Deploy flow:**
1. Edit files in `frontend/` or `agent/` (SoT).
2. `git add . && git commit && git push origin main`.
3. Vercel auto-builds (`cd frontend` → `pnpm install` → `next build`) and deploys to `dynamic-research.vercel.app`.
4. **For `agent/` changes only** — pull to the worker deploy clone and restart:
   ```
   git -C "C:\Users\ceo\Projects\DR-Deploy" pull origin main
   Stop-ScheduledTask -TaskName DynamicResearchWorker
   Start-ScheduledTask -TaskName DynamicResearchWorker
   ```
   Skip step 4 for frontend-only merges. Verify new worker PID via `worker.log` in `DR-Deploy/agent/`.

**Worker deploy clone:** `C:\Users\ceo\Projects\DR-Deploy\` is a permanent, main-only mirror — never branch or edit there. Its `agent/.env` must be kept in sync manually whenever env vars change (it is not tracked by git).

**No more push-clone, no sync script, no 3-way diff.** The old `c:/tmp/Dynamic-Research` push-clone is RETIRED. The `feedback_pushclone_divergence_reconcile` footgun no longer applies.

**Sandbox writes are required for `frontend/` edits** — see §5.

---

## 5. Sandbox-required writes (enforce-sandbox.sh)

A pre-tool hook at `~/.claude/hooks/enforce-sandbox.sh` blocks direct `Write`/`Edit` to most of this project. Writable directly:
- `.claude/`
- `CLAUDE.md` (this file)
- `sandbox/`

Everything else (`agent/`, `frontend/`, `supabase/`, `Documentation/`) requires the **sandbox + /promote workflow**:
1. Write the file to `sandbox/<name>` (auto-creates `sandbox/<name>.meta` with the intended path)
2. Verify the content
3. Invoke `/promote` (the user-invocable skill) to copy to live + archive sandbox originals to `sandbox/validated/`

Per `feedback_sandbox_archive_session_suffix.md`: append `-s<N>` suffix when archiving (e.g. `sandbox/validated/foo.ts-s52`).

Per `feedback_sandbox_meta_sidecar_root.md`: the `.meta` file is auto-created at sandbox ROOT.

**Exception:** Inside per-job worker workdirs (e.g. `Projects/<slug>/`), a `.claude/sandbox-allowlist` permits direct writes so the executor can write state.json + deliverables.

---

## 6. Worker daemon

- **Runs as Scheduled Task `DynamicResearchWorker`** which fires **every 5 minutes** and starts a worker process if none is running. **NOT a crash-supervisor** — `RestartCount=0`, `RestartInterval=(empty)`. If the worker crashes mid-poll, expect up to a 5-minute gap before the next cron tick spawns a replacement. To force-restart sooner, run `Start-ScheduledTask -TaskName DynamicResearchWorker` manually. See `feedback_scheduled_task_is_cron_not_supervisor.md` (S61).
- **Polls every 30s** via `claimJob()` against Supabase.
- **Treat PID as observational, not load-bearing.** PIDs change between sessions whenever the prior worker exits and the cron tick spawns a new one — when handoffs document a specific PID, expect it to have rotated by next session.
- **Log:** `agent/worker.log` (relative to repo root: `Dynamic Research/agent/worker.log`). Tail this to verify polling.
- **NEVER kill the daemon without explicit user authorization.** Killing it during a research job mid-execution will leave Supabase rows + storage artifacts orphaned.
- **S64 preflight + file-backed circuit breaker (preflight-cost-architecture v3):** preflight uses local-only probes — `claude auth status` ($0) + `GET /v1/models` ($0) via `undici.EnvHttpProxyAgent`. A file-backed circuit breaker at `<cwd>/.preflight-backoff` JSON opens for 10/20/40/60-min windows on consecutive preflight failures OR mid-execution terminal-error classification (credit-out / auth-out / billing-error / model-not-found at executor.ts:claude-spawn, executor.ts:plan-synthesis, or plan-reviewer.ts:integration). During Open state, cron-fired workers exit 0 cheaply (no LastTaskResult ≠ 0 escalation). Resend operator-alert fires ONCE on N=3 transition + once on recovery, recipient = `PREFLIGHT_NOTIFY_EMAIL` env var (skip-on-unset). To force-rerun preflight ignoring backoff: `rm <cwd>/.preflight-backoff` (PowerShell or bash). See `Documentation/preflight-cost-architecture-design-gate.md` (v3.1 design) + `Documentation/preflight-cost-architecture-merge-gate-peer-review.md` (S64 MERGE-gate synthesis) + [[feedback_preflight_circuit_breaker]].

Find current PID via PowerShell:

```bash
cat > /tmp/find-worker.ps1 << 'EOF'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match 'worker' } | Select-Object -ExpandProperty ProcessId
EOF
powershell -NoProfile -ExecutionPolicy Bypass -File /tmp/find-worker.ps1
```

Avoid `tasklist /FI` from Git Bash — `/FI` gets interpreted as a path and the command fails (see [[feedback_pushclone_divergence_reconcile]] sibling pattern).

---

## 7. Conventions source-of-truth

`agent/lib/conventions.json` is the canonical data file for slugify rules, filename patterns, skip lists, bucket name, and any other constants the worker + scripts need. `agent/lib/conventions.ts` (wrapper) reads it ONCE at module load via `fs.readFileSync` (line 54-55).

**Consequence:** `agent/worker.ts:19` static-imports executor at startup. **Any change to `conventions.json` OR `conventions.ts` requires a daemon restart** for the worker to pick up new values. This applies to e.g. adding `MODEL_PRICING` for S52 #4 telemetry.

---

## 8. Supabase

- **Project ref:** `mfjgoghlpqgxcycxoxio` (Dynamic Research; standalone from GravityClaw).
- **Bucket:** `research-projects` (private; signed URLs).
- **Migrations:** `supabase/migrations/`. Apply via `supabase db push` (CLI).
- **Filename convention:** **underscore between digit-prefix and name** (`20260523_phase_b_auth_rls_helpers.sql`). The CLI silently skips dash-named files (`20260523-phase-b.sql` → never applied). See `feedback_supabase_db_push_filename_underscore.md`.
- **No `BEGIN`/`COMMIT` in migration files.** The CLI ExecBatch wraps each file + the schema_migrations history insert in an implicit transaction; explicit BEGIN/COMMIT breaks atomicity. See `feedback_supabase_db_push_no_begin_commit.md`.
- **No `SET LOCAL` either** — fires WARNING 25P01 and has no effect inside the wrapper transaction.
- **Multi-tenancy state:** Phase B-1 (auth helpers + RLS policy definitions + `audit_storage_writes`) LANDED. **Phase B-2 (`supabase/migrations/20260602_phase_b_2_rls_enable.sql`, S80) is APPLIED to prod — verified live S97 (2026-06-05):** RLS enabled on all 4 tenant tables, `research_queue.organization_id` DEFAULT dropped, CHECK constraint `research_queue_org_id_not_null` present, migration `20260602` recorded in `supabase_migrations.schema_migrations`. **Prior handoffs through S96 wrongly listed B-2 as "authored, not pushed, deployment PENDING, coupled to the cross-project window" — that was STALE; corrected S97** (see [[feedback_verify_handoff_blockers_against_live_system]]). The "coupled to GravityClaw / off-limits window" framing is likewise void: an S97 read-only audit of `mfjgoghlpqgxcycxoxio` (every schema) found ONLY DR tables + the single `research-projects` bucket and **zero GravityClaw objects** — GravityClaw's `audit_writes` table is absent here despite GravityClaw's own handoff claiming it was created in this project. So this project is genuinely DR-standalone at the database level; no DR Supabase op can touch GravityClaw. Phase C (`SET NOT NULL` canonicalization) is tracked separately.

---

## 9. Storage paths

After Phase B refactor (S50), all storage paths MUST go through `scopedStoragePath(orgId, slug, file?)` from `agent/lib/storage-paths.ts` (frontend mirror at `frontend/lib/storage-paths.ts` — path helper only). Layout: `<org_id>/<slug>/<file>`. Legacy flat layout `<slug>/<file>` exists for objects pre-S50; cleanup script `agent/scripts/phase-b-cleanup-legacy-storage-paths.ts` runs on/after **2026-06-23** (30-day soak).

Direct path concatenation (e.g. `` `${slug}/${file}` ``) is blocked by `agent/scripts/test-phase-b-storage-paths.sh` grep test.

For uploads from the worker, use `uploadWithAudit()` from the same helper — wraps the upload + appends a row to `public.audit_storage_writes` (best-effort).

---

## 10. SECURITY notes (everything else in `~/CLAUDE.md` applies)

- **All user-supplied data interpolated into LLM prompts MUST use the `untrusted_input` fence pattern** (`agent/lib/untrusted-input.ts` + `frontend/lib/untrusted-input.ts` pair). Closes prompt-injection at frontend AND agent layers. See `feedback_untrusted_input_fence_pattern.md`.
- **Rate-limit on unauth Anthropic-call routes:** `frontend/app/api/queue/extract-context/route.ts` + `frontend/app/api/queue/generate-questions/route.ts` use `frontend/lib/rate-limit.ts` (per-IP token bucket, 20 tokens, refill 1/180s). `maxOutputTokens` caps further bound per-call cost.
- **SSR-auth STOPGAP sites — RESOLVED (verified S96 audit, 2026-06-05).** The former 6 `// STOPGAP(SSR-auth):` sites have all been migrated to `getOrgContextDualPath()` (now used across 10 API routes incl. `runs/route.ts`, `state/route.ts`, `runs/[slug]/{files,manifest,file/[filename]}/route.ts`). **Zero** `STOPGAP(SSR-auth)` markers remain in `frontend/`. Do not reintroduce the pattern; derive org context via `getOrgContextDualPath()` before any DB/storage lookup.
- **CVE posture:** 15/17 closed in S52 #2 sweep. Two postcss XSS findings deferred and cataloged at `Documentation/dependency-exceptions.md`.

---

## 11. Multi-reviewer policy (HARD RULE — see `~/CLAUDE.md`)

This project is a frequent producer of DESIGN + MERGE-gate artifacts. Honor the Event Gate × Risk Label × Severity Mode framework verbatim. Reviewer ORDER is **Gemini → integrate → Codex** (sequential). Codex catches code-grounded gaps Gemini missed on the integrated v2 every time. Do not invert this order without explicit reason.

**HARD RULE (user, S141) — hold `agent/` PROD deploys until the FULL three-vendor gate clears BEFORE merge.** Any `agent/` change that reaches the production worker (`DynamicResearchWorker` cron → DR-Deploy clone → live daemon) must have **Gemini + Codex + Claude-author all reviewed and cleared BEFORE the merge/deploy — never after.** The MRPF "required-reviewer-unavailable fallback" (run substitutes now, proceed, owe the real Codex pass as a <24h follow-up) is **NOT acceptable for `agent/` prod code** — if Codex is quota-out/offline, **WAIT** (or use the §1a API-key flip to get the REAL Codex now), do not merge with substitutes. Origin: S141 deployed an `agent/` worker fix under the reduced two-lens path (Gemini + Claude-grounded both ENDORSED); the owed Codex pass then BLOCKED on a CRITICAL the two lenses missed — already LIVE in prod. Substitutes de-risk the WAIT; they never replace the gate. This tightening is specific to `agent/` PROD deploys — slash-prompt edits (live-immediately) and DESIGN/AUDIT gates keep normal MRPF latitude. See `feedback_hold_agent_prod_deploys_until_full_tri_vendor_gate.md` + `feedback_studio_snapshot_diff_concurrent_foreign_exact1.md`.

Synthesis artifacts live under `Documentation/` named `<topic>-peer-review.md` or `<topic>-merge-gate-peer-review.md`.

---

## 12. Common runtime quirks (Windows + Git Bash)

- **Pandoc:** in PATH usually, but fallback at `/c/Users/ceo/AppData/Local/Pandoc/pandoc.exe`. Don't use `-H <(...)` process-sub — fails on Git Bash. Inject CSS post-gen via Python (memory `feedback_pandoc_header_flag_windows.md`).
- **Python stdout:** Git Bash is cp1252 by default; Unicode `print()` crashes. Set `PYTHONIOENCODING=utf-8` or stick to ASCII.
- **`subprocess.run(["notebooklm", ...])`:** WinError 2. Use the full `.exe` path. See `feedback_nlm_subprocess_requires_full_exe_path.md`.
- **`Start-Process -FilePath "pnpm"`:** fails because pnpm/npx/tsx/next/vercel are `.cmd` shims. Wrap in `cmd.exe /c`. See `feedback_powershell_start_process_cmd_shims.md`.
- **Vercel `env add` stdin trailing newline:** `echo "value" | vercel env add` stores the trailing `\n`. Use `printf "%s"` OR add `.trim()` in the consumer. See `feedback_vercel_env_add_stdin_trailing_newline.md`.
- **`Bash(run_in_background:true)` SIGTERMs at ~2 min** — don't use for daemons. Use Scheduled Task or `Start-Process -WindowStyle Hidden`.

---

## 13. Memory hygiene

At end of each session, update `dryrun_handoff.md` (status log) + `MEMORY.md` (index) per the global `/end-session` skill. Per-topic feedback files live alongside in the memory directory. Keep `MEMORY.md` index lines under ~150 chars; detail goes in the topic file.

---

## 14. Things this file does NOT cover

- Per-session bug log → `~/.claude/projects/.../memory/research_compare_learnings.md` + `dryrun_handoff.md` per-session sections.
- ASC-specific (government-contracting intelligence) → `Projects/ASC-Government-Projects/Documentation/handoff.md`.
- Per-job worker workdir conventions → the per-job `.claude/sandbox-allowlist` (NOTE: `agent/AGENTS.md` referenced here pre-S96 does NOT exist; `frontend/AGENTS.md` is a Next.js boilerplate stub — neither is load-bearing).
- MCP proxy subsystem (`agent/mcp-proxy/`: `index.ts` + `mcp-config.json` + `upstreams.json`) → design + policy at `Documentation/sprint3-mcp-proxy-design-gate.md` (L5 input-sig dedup, per-upstream `idempotent` flag).
- Global rules (security, communication style, model preferences, end-session protocol) → `~/CLAUDE.md`.
