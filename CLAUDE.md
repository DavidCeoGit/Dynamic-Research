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
- **Runtime:** Node ≥ 22; `tsx` is the loader for all TypeScript at runtime (`tsx scripts/foo.ts`, `tsx --import worker.ts`, `node --import=tsx worker.ts`).
- **Frontend:** Next 16, React 19, Tailwind 4, AI SDK 6.0 (`maxOutputTokens` param name).
- **Backend:** Node.js daemon in `agent/`; Supabase (Postgres + Storage + Auth magic-link).
- **Tests:** `node --test` (NOT vitest). Root `pnpm test` runs `bash agent/scripts/test-phase-b-storage-paths.sh && pnpm -C agent exec tsc --noEmit && pnpm -C frontend exec tsc --noEmit` — the grep guard against legacy flat-layout storage paths + strict TypeScript across both subprojects (wired S52 #C, 2026-05-25).
- **TypeScript:** strict mode in every subproject.

---

## 3. Repo + git layout (HEADS UP — frequent footgun)

**The git repo is at the PARENT directory `Anti Gravity/`, NOT at `Dynamic Research/`.** Every `git` command must `cd` to the parent or use `git -C "C:/Users/ceo/Documents/AI Training/Anti Gravity"`. Running `git status` from inside `Dynamic Research/` works but the diff scope is the whole parent (which contains other unrelated projects).

To scope a status check to this project only:

```bash
git -C "C:/Users/ceo/Documents/AI Training/Anti Gravity" status --short "Dynamic Research/"
```

GitHub remote: `DavidCeoGit/Dynamic-Research` (the *push-clone*, see §4).

---

## 4. Push-clone deploy path (CRITICAL)

**The SoT (source of truth) is `Dynamic Research/frontend/`** — but Vercel does NOT deploy from there. Vercel deploys from a SEPARATE git repo at `c:/tmp/Dynamic-Research/` whose `origin` points to GitHub `DavidCeoGit/Dynamic-Research`.

**Deploy flow:**
1. Edit files in `Dynamic Research/frontend/` (SoT)
2. Run sync script that copies `Dynamic Research/frontend/` → `c:/tmp/Dynamic-Research/frontend/`
3. `cd c:/tmp/Dynamic-Research && git add . && git commit && git push`
4. Vercel auto-builds and deploys

**Known footgun:** the push-clone can silently diverge from SoT when prior sessions edit the push-clone directly. Memory file `feedback_pushclone_divergence_reconcile.md` documents the pattern. Before any deploy, **`diff -rq frontend/ c:/tmp/Dynamic-Research/frontend/`** and reconcile.

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
- **Multi-tenancy state:** Phase B-1 (auth helpers + RLS policy definitions + `audit_storage_writes`) LANDED. Phase B-2 (DROP DEFAULT + `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on the 4 existing tenant tables) PENDING. Service-role bypasses RLS, so the worker daemon still functions normally pre-B-2.

---

## 9. Storage paths

After Phase B refactor (S50), all storage paths MUST go through `scopedStoragePath(orgId, slug, file?)` from `agent/lib/storage-paths.ts` (frontend mirror at `frontend/lib/storage-paths.ts` — path helper only). Layout: `<org_id>/<slug>/<file>`. Legacy flat layout `<slug>/<file>` exists for objects pre-S50; cleanup script `agent/scripts/phase-b-cleanup-legacy-storage-paths.ts` runs on/after **2026-06-23** (30-day soak).

Direct path concatenation (e.g. `` `${slug}/${file}` ``) is blocked by `agent/scripts/test-phase-b-storage-paths.sh` grep test.

For uploads from the worker, use `uploadWithAudit()` from the same helper — wraps the upload + appends a row to `public.audit_storage_writes` (best-effort).

---

## 10. SECURITY notes (everything else in `~/CLAUDE.md` applies)

- **All user-supplied data interpolated into LLM prompts MUST use the `untrusted_input` fence pattern** (`agent/lib/untrusted-input.ts` + `frontend/lib/untrusted-input.ts` pair). Closes prompt-injection at frontend AND agent layers. See `feedback_untrusted_input_fence_pattern.md`.
- **Rate-limit on unauth Anthropic-call routes:** `frontend/app/api/queue/extract-context/route.ts` + `frontend/app/api/queue/generate-questions/route.ts` use `frontend/lib/rate-limit.ts` (per-IP token bucket, 20 tokens, refill 1/180s). `maxOutputTokens` caps further bound per-call cost.
- **6 SSR-auth stopgap sites** exist across `frontend/app/api/runs/route.ts`, `state/route.ts`, `runs/[slug]/files/route.ts`, `manifest/route.ts`, `file/[filename]/route.ts`. Tagged `// STOPGAP(SSR-auth):` for grep. SSR auth refactor is S53+ work; do not extend the stopgap pattern.
- **CVE posture:** 15/17 closed in S52 #2 sweep. Two postcss XSS findings deferred and cataloged at `Documentation/dependency-exceptions.md`.

---

## 11. Multi-reviewer policy (HARD RULE — see `~/CLAUDE.md`)

This project is a frequent producer of DESIGN + MERGE-gate artifacts. Honor the Event Gate × Risk Label × Severity Mode framework verbatim. Reviewer ORDER is **Gemini → integrate → Codex** (sequential). Codex catches code-grounded gaps Gemini missed on the integrated v2 every time. Do not invert this order without explicit reason.

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
- Per-job worker workdir conventions → `agent/AGENTS.md` (if present) + the per-job `.claude/sandbox-allowlist`.
- Global rules (security, communication style, model preferences, end-session protocol) → `~/CLAUDE.md`.
