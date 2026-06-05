# MERGE-Gate: Preflight Cost + Failure-Loop Architecture v3

**Status:** v3 SHIPPED post-Codex-MERGE-gate-integration. 157/157 plan-* + preflight + terminal-errors tests pass; agent + frontend tsc strict clean; repo storage-paths grep guard clean. Worker daemon restart pending user authorization (CLAUDE.md §6 HARD RULE).
**Author:** Claude (Opus 4.7, S64 2026-05-28)
**MRPF classification:** Event Gate = MERGE. Risk Labels = **AGENT BEHAVIOR** (autonomous health gate + classifier shapes every job execution) + **INFRA** (cron exit-code semantics + file-backed state + operator alerts). Severity = NORMAL. → Sequential Gemini → integrate → Codex on integrated v2 (per `~/CLAUDE.md` HARD RULE).

**Ship contents (final v3):**
- `agent/lib/preflight-backoff.ts` — NEW. Classifier (priority 1 structured / priority 2 regex), state file CRUD, pending-exit flag, Windows EPERM/EBUSY/EACCES rename retry.
- `agent/preflight.ts` — `checkClaudeAuth` + `checkAnthropicAuth` + `runPreflight` (returns `PreflightOutcome`) + `advancePreflightCircuit` orchestrator.
- `agent/worker.ts` — backoff probe at startup + `pollAndContinue()` + `finalizeTerminalExitIfPending()` post-poll handler with try/catch around durable write.
- `agent/executor.ts` — classifier hooks at 2 sites (Claude spawn exit-nonzero + planSynthesis catch) + try/catch around `await reviewPlan(...)` (G-C1 fix).
- `agent/lib/plan-synthesizer.ts` — `PlanSynthesisError` preserves original transport error via ES2022 `Error.cause`.
- `agent/lib/plan-reviewer.ts` — `runIntegration` classifier BEFORE existing UNAVAILABLE swallow; terminal → mark + re-throw, non-terminal → existing UNAVAILABLE (Bug 53a preserved).
- `agent/lib/notify.ts` — `sendPreflightBackoffEmail` + `sendPreflightRecoveryEmail` + internal `postOperatorAlert()` reading new env var `PREFLIGHT_NOTIFY_EMAIL`.
- `agent/.env.example` — documents `PREFLIGHT_NOTIFY_EMAIL` with skip-on-unset behavior.
- `agent/package.json` — `undici@8.3.0` added as explicit dep.
- `agent/test/preflight.test.ts` — NEW. 19 tests covering checkEnv / checkClaudeAuth (4 cases incl. timeout) / checkAnthropicAuth (6 cases) / backoff schedule / state round-trip / clear idempotency / concurrent writes / corrupted JSON / shape-invalid JSON.
- `agent/test/terminal-errors.test.ts` — NEW. 20 tests covering classifier priority-1 structured (incl. 3 Anthropic SDK nested-shape tests post-B1) / priority-2 regex / non-terminal / shape tolerance / markPending+consume / recordFailureFromTerminalError jump-to-3 / notify predicate.

**Total v3 surface:** 9 code files + 2 new test files + 1 env-example update. 157/157 tests pass (115 plan-* + 19 preflight + 20 terminal-errors + 3 Anthropic SDK shape).

---

## v1 → v2 integration record (Gemini round 1, 2026-05-28 PT, REQUEST_CHANGES, 117s wall-clock)

Gemini round 1 read all 9 implementation files + the v3.1 design doc. Verdict REQUEST_CHANGES with 1 CRITICAL + 2 MINOR. All actionable.

| ID | Sev | Disposition |
|---|---|---|
| **G-C1** | **CRITICAL** | **INTEGRATED v2.** `agent/executor.ts:runPlanReviewGate` had no try/catch around `await reviewPlan(...)`. After my S64 plan-reviewer change (RE-THROW on terminal vs silent UNAVAILABLE swallow), the propagated exception bypassed `failJob` and left the job permanently stuck in `running` / `reviewing` status. **Fix:** wrap the reviewPlan call in try/catch; on error → log → updatePlanReviewStatus('system_blocked') → conditional failJob + notifyTerminal → return proceed=false. Pending-exit flag was already markPending'd inside `runIntegration`; worker.ts:finalizeTerminalExitIfPending picks it up after this function returns. |
| G-m1 | MINOR | INTEGRATED v2. Added `PREFLIGHT_NOTIFY_EMAIL=` block to `agent/.env.example` documenting the operator-alert recipient + skip-on-unset behavior. |
| G-m2 | MINOR | **DEFERRED with rationale.** Worker.ts exit-code smoke test (spawn-child + mocked state file). Non-trivial Windows ChildProcess fixture work; current unit tests cover the pure functions feeding worker.ts; not blocking. Captured as follow-on. |

**Reviewer-approved (no findings):**
- Windows EPERM retry in atomicWrite (Gemini explicitly endorsed `renameWithRetry` with jitter as correct concurrency primitive over single-writer queue alternative).
- ES2022 `Error.cause` use in plan-synthesizer.ts (native `super(message, { cause })` + `declare readonly cause?: unknown`).
- `escapeHtml` correctly applied to all untrusted string interpolations in notify.ts HTML payloads.
- Re-throw semantics in plan-reviewer.ts:runIntegration (last-write-wins on the pending flag is harmless).

---

## v2 → v3 integration record (Codex round 2, 2026-05-28 PT, REQUEST_CHANGES, 233s wall-clock)

Codex round 2 read v2 (post-G-C1 integration) + the SDK source under `agent/node_modules/@anthropic-ai/sdk/src/core/error.ts`. Verdict REQUEST_CHANGES with 3 MAJOR + 2 MINOR. All actionable; SDK shape mismatch was the most consequential.

| ID | Sev | Disposition |
|---|---|---|
| **S64-B1** | **MAJOR** | **INTEGRATED v3.** Anthropic SDK 0.99.0 error shape: `err.type` is FLAT (set in constructor via `type ?? null`), `err.error` is the response BODY (containing `{ error: { type, message } }`), and the body discriminator at `err.error.type === "error"` is NOT the real error type. My v2 classifier checked `e.error?.type` first — which on Anthropic returns the literal `"error"` discriminator, bypassing real types. **Fix:** reorder coalescing to `e.type ?? e.error?.error?.type ?? e.error?.type` (deeply-nested before flat-body, so Google/OpenAI flat shapes still match via the last fallback). Updated `ApiErrorShape` interface to declare the nested `error.error.{type,message}` field. Added 3 tests covering: flat `err.type`, deeply-nested billing_error body, deeply-nested not_found_error+model. All pass. |
| **S64-A1** | **MAJOR** | **INTEGRATED v3.** v2's catch in `runPlanReviewGate` returned `proceed:true` in shadow mode after a reviewPlan throw. Codex flagged: a thrown terminal error is semantically a SYSTEM_BLOCKED-class infra signal, and `reviewPlan` already preserves SYSTEM_BLOCKED status even in shadow mode (it does NOT force-approve). Letting the spawn continue after an account-level terminal error has already marked the worker for exit burns the queue against a known-broken state. **Fix:** both shadow + enforce modes now → failJob + notifyTerminal + return proceed=false on reviewPlan throw. Pending-exit flag still consumed by worker.ts:finalizeTerminalExitIfPending. |
| **S64-C1** | **MAJOR** | **INTEGRATED v3.** v2's `finalizeTerminalExitIfPending` called `consumePendingTerminalExit()` (which clears the flag) BEFORE the durable backoff write. If `recordFailureFromTerminalError` threw (disk full, EPERM exhaustion), the flag would be gone with no backoff written. **Fix:** wrap recordFailureFromTerminalError in try/catch; on write failure, log + still exit 1 (next cron tick will re-run preflight; if the same terminal cause persists, the next worker writes backoff cleanly; worst case is one missed backoff window, not infinite queue-burn). |
| S64-D1 | MINOR | INTEGRATED v3. `renameWithRetry` had 5 attempts with delays 10/30/50/70/90ms, but the 90ms sleep fired after the last failed attempt with no sixth retry — wasted. **Fix:** `if (attempt < 4) sleep(10 + attempt * 20)`. Total 10+30+50+70 = 160ms across 5 attempts. Comment updated. |
| S64-E1 | MINOR | **PARTIALLY INTEGRATED v3.** Added 3 new Anthropic SDK shape tests that would have caught S64-B1. `advancePreflightCircuit` + `finalizeTerminalExitIfPending` orchestrator tests **DEFERRED** with rationale: these orchestrators involve `process.exit(1)` which requires either a process-exit mock or extracting to a return-shape-style helper (small refactor). The behavioral contract is small and the underlying primitives (`recordFailure`, `recordFailureFromTerminalError`, `clearBackoff`, `sendPreflightBackoffEmail`) are individually tested. Acceptable post-implementation deferral. |

**Cost / wall-clock:**
- Codex round 1 attempt: 335s, exit 1 (context exhaustion from web-search loop). Prompt was over-scoped; iterated to a tighter focused prompt for round 2.
- Codex round 2: 233s, exit 0. Produced all 5 findings + verdict. 102K tokens used.

---

## Empirical reinforcement of v2.2 sequential topology (Client Pipeline Tracker S11–S13 + Dynamic Research S45 + S64)

S64 dogfooded the sequential MRPF v2.2 topology and produced another data point reinforcing the rule:

| Round | Reviewer | Cost | Findings | Critical catches that the OTHER reviewer could NOT have caught alone |
|---|---|---|---|---|
| 1 | Gemini (holistic v1 on fresh implementation) | $0 (CLI quota), 117s | 1C + 2m | G-C1 (untrapped throw bypassing failJob) — a control-flow correctness bug from reading the whole orchestration path. Codex's code-grounded pass would have caught this too, but Gemini saw it first via top-down trace. |
| 2 | Codex (code-grounded on integrated v2) | $0 (CLI quota), 233s | 3M + 2m | S64-B1 (Anthropic SDK shape mismatch) — required actually reading the installed SDK source at `node_modules/@anthropic-ai/sdk/src/core/error.ts`. Gemini's holistic pass did NOT have this grounding. The classifier would have shipped BROKEN for the exact use case it was designed for (the production failure that triggered the whole architecture). |

**Critical reinforcement:** the same pattern as CP Tracker S11–S13 + DR S45 — post-integration code-grounded review catches gaps that even a strong holistic review will miss, IF AND ONLY IF the integration cycle exists. Parallel-on-v1 would have lost S64-B1 because Gemini's recommendations wouldn't have included the SDK-shape probe, so Codex on v1 would have spent its grounding budget elsewhere.

Sequential cost: 1 extra integration cycle (≈30 min author wall-clock). Sequential benefit: catching the architecture's MOST consequential bug (B1, which would have shipped a placebo classifier).

---

## Final ship verification

| Check | Result |
|---|---|
| `agent/scripts/test-phase-b-storage-paths.sh` | PASS |
| `pnpm -C agent exec tsc --noEmit` | EXIT 0, zero output |
| `pnpm -C frontend exec tsc --noEmit` | EXIT 0, zero output |
| `node --import=tsx --test test/preflight.test.ts test/terminal-errors.test.ts test/plan-*.test.ts` | 157/157 pass, 10.97s |
| Sandbox files promoted + archived `-s64` / `-s64-fix1` | OK (9 files + 1 fix1) |
| `undici` declared in `agent/package.json` + lockfile updated | OK (8.3.0) |
| New env var `PREFLIGHT_NOTIFY_EMAIL` documented in `.env.example` | OK |

**Worker daemon restart NOT executed.** Per CLAUDE.md §6 HARD RULE the daemon restart requires explicit user authorization. Worker PID 10124 still serving pre-S64 code; new code will load on user-triggered `Start-ScheduledTask -TaskName DynamicResearchWorker` (after `Stop-Process` of PID 10124).

---

## Deferred follow-ons (acceptable post-ship)

1. **G-m2** — worker.ts spawn-based smoke test verifying exit codes. Non-trivial Windows ChildProcess fixture; behavior covered by unit tests on the pure feeding functions.
2. **S64-E1 (partial)** — orchestrator-level tests for `advancePreflightCircuit` + `finalizeTerminalExitIfPending`. Requires either a `process.exit` mock or a small refactor to return ExitDecision. The constituent primitives (`recordFailure`, `clearBackoff`, `recordFailureFromTerminalError`, classifier, notify) are all individually tested at unit level.
3. **DESIGN doc update (`Documentation/preflight-cost-architecture-design-gate.md` v3.2)** — document the S64-B1 SDK shape mismatch + the deeply-nested coalescing order, so any future contributor revising the classifier understands the precedence. This is a small post-ship documentation chore.
4. **Dark-launch period** — first ~5 worker restarts under v3 should be observed via tailing `worker.log` for the new `[preflight] backoff-action: running-checks` / `backoff-skip` / `recovered` lines + the per-startup `✓ claude-auth: ...` + `✓ anthropic-auth: ...` lines. Per design §7 verification steps 1-3. Trigger an artificial backoff by deliberately breaking `ANTHROPIC_API_KEY` in `agent/.env` to verify recordFailure + Resend email arrive.

---

## What ships

Code is on disk, tests pass, types check. Bundle commit (S52-S64 carry-forward, deferred 3× since S62) can pick this up together with the S64 ship. Worker restart yours.

Recommend (per CLAUDE.md global instruction): **trigger `Stop-Process -Id 10124` + `Start-ScheduledTask -TaskName DynamicResearchWorker`** to load v3 code, then tail worker.log for one preflight cycle to confirm the new $0 path (`claude auth status` + `GET /v1/models`) replaces the prior $0.24-per-restart `claude -p hello`. Alternative: defer restart until S65; no functional regression in the meantime (the new code is gated behind backoff-state-file presence + executor catch sites that fire only on terminal errors, neither of which exists right now).


---

## S64.1 — Post-MERGE operator-time hotfix (2026-05-29)

After the user-triggered worker restart loaded v3 code in production, the freshly-deployed `checkAnthropicAuth` failed with a generic `fetch failed` on every preflight cycle — even though the API key was valid, the network reached api.anthropic.com cleanly, and a direct `Invoke-WebRequest` from PowerShell with the same key returned `HTTP 200`. The circuit breaker correctly identified this as `anthropic-auth` failures and advanced backoff (N=1 → N=2 → N=3 over three cron ticks); the operator dogfooded the recovery cycle.

**Root cause (S64.1-D1):** Node 22 `globalThis.fetch` silently drops the undici `dispatcher` init field. Even though Node's fetch is implemented on top of undici, the global wrapper does not reliably forward `dispatcher`. The fetch fails before sending the request, surfacing as generic `TypeError: fetch failed` with no HTTP status and no `.cause` chain in the operator log. The misleading "Network error" remediation cost ~20 minutes of operator-time misdiagnosis before the dispatcher-drop hypothesis surfaced.

**Patch (one-line import + one-line wire change in `agent/preflight.ts`):**

```diff
-import { EnvHttpProxyAgent, type Dispatcher } from "undici";
+import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
 ...
-const fetchFn = deps.fetchFn ?? (fetch as CheckAnthropicAuthFetchFn);
+const fetchFn = deps.fetchFn ?? (undiciFetch as unknown as CheckAnthropicAuthFetchFn);
```

Behaviorally identical for `EnvHttpProxyAgent`-with-no-proxy-env (the common case) — just routes through undici's fetch implementation directly so the dispatcher contract is honored. Test surface unchanged (DI signature identical). Archived as `sandbox/validated/preflight.ts-s64.1`.

**Verification:**
- `pnpm -C agent exec tsc --noEmit` — clean
- `node --import=tsx --test test/preflight.test.ts` — 19/19 pass
- Worker restart with `.preflight-backoff` cleared → all 4 checks green (`env-sanity`, `claude-auth`, `anthropic-auth`, `nlm-auth`). PID 40492 polling normally.

**Inadvertent dogfood validation:** the failure-then-recovery sequence dogfooded the entire S64 architecture end-to-end in production conditions. Five cron-tick worker spawns during the Open window each observed the backoff file, logged `backoff-action: backoff-skip` with minutes-remaining countdown, and exited 0 cheaply. Total observed outage: 38 minutes. Zero queue-burn. Zero LastTaskResult escalation noise. The architecture works exactly as designed.

**Codex S64-E1 minor → major reclassification:** the orchestrator-level integration test that would have caught this dispatcher bug was deferred in S64 as MINOR ("E1 partial"). In retrospect, given that this gap was the source of the only post-ship hotfix in S64.1, that deferral should have been MAJOR. Future preflight-class architectures should treat integration smoke tests (that actually hit the production target — api.anthropic.com from inside `runPreflight()`) as MAJOR-mandatory, not optional follow-on.

**Memory artifacts created:**
- `feedback_node22_global_fetch_dispatcher_silent_drop.md` — the bug + fix
- `project_s64_dogfood_recovery_observed.md` — the full dogfood timeline + architecture-behaviors-validated checklist
- MEMORY.md index updated with both entries
