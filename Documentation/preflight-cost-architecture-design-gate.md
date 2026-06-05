# DESIGN-Gate: Preflight Cost + Failure-Loop Architecture

**Status:** v3.1 APPROVED — post-Codex-QA fidelity fix. Ship-ready for MERGE-gate implementation under a separate code-diff review.
**Author:** Claude (Opus 4.7, S63 2026-05-28)
**MRPF classification:** Event Gate = DESIGN + MERGE. Risk Labels = **AGENT BEHAVIOR** (preflight is autonomous health gate that determines whether worker claims jobs; terminal-error misclassification cascades) + **INFRA** (cron-spawn cadence + circuit-breaker semantics). Severity = NORMAL. → Sequential Gemini → integrate → Codex required.
**Target artifacts on ship (v3, EXPANDED from v2 per C-C2 + C-M2):**
- `agent/preflight.ts` — replace `checkClaudeSpawn` with `checkClaudeAuth` (using `claude auth status` per C-M1), add `checkAnthropicAuth` with `EnvHttpProxyAgent` (per C-M2)
- `agent/worker.ts` — Tier C backoff bookkeeping in `main()` + post-`poll()` terminal-exit handler (per C-C1)
- `agent/executor.ts` — call `classifyTerminalError()` in catch paths (Claude spawn + plan synthesis catches per C-C2)
- `agent/lib/plan-synthesizer.ts` — terminal-error classification before existing throw (per C-C2)
- `agent/lib/plan-reviewer.ts` — terminal-error classification before `UNAVAILABLE` swallow in `runIntegration` (per C-C2)
- `agent/package.json` + `pnpm-lock.yaml` — add `undici` as explicit dependency (per C-M2)
- new file `agent/lib/preflight-backoff.ts` — `classifyTerminalError()` + state-file CRUD + pending-exit flag pattern
- `agent/test/preflight.test.ts` (new)
- `agent/test/terminal-errors.test.ts` (new; renamed from v2's `executor-terminal-errors.test.ts` since logic now spans 3 callsites)
- `agent/.env.example` — no new vars; backoff is file-state, proxy is standard env vars

**v1 → v2 integration record (Gemini round 1, 2026-05-28 13:41, verdict REQUEST_CHANGES, depth 5/5, 106s wall-clock):**
| ID | Sev | Disposition |
|---|---|---|
| G-C1 | CRITICAL | INTEGRATED v2: NEW §3.5 — executor.ts terminal-provider-error catch + feedback to backoff. Scope expanded to include `agent/executor.ts`. |
| G-M1 | MAJOR | INTEGRATED v2: §3.1.B — conditional `undici.ProxyAgent` when proxy env present. (SUPERSEDED v3 by C-M2: now `EnvHttpProxyAgent` always-on + explicit `undici` dep.) |
| G-m1 | MINOR | INTEGRATED v2: §3.2 reframed as file-backed circuit breaker. |
| G-m2 | MINOR | NO-ACTION: confirms Tier B drop. |
| G-m3 | MINOR | INTEGRATED v2: NEW §3.6 — atomic-write contract. (REFINED v3 by C-M3.) |
| G-m4 | MINOR | INTEGRATED v2: trimmed §3.1.C + removed §3.2.E. |

**v2 → v3 integration record (Codex round 2, 2026-05-28 13:58, verdict REQUEST_CHANGES, depth 5/5, 554s wall-clock):**
| ID | Sev | Disposition |
|---|---|---|
| C-C1 | CRITICAL | INTEGRATED v3: §3.5 rewritten — classifier is SIDE-EFFECT-FREE (returns `TerminalError \| null`); enriched input shape includes `(err, stdoutTail, stderrTail, stateFailureReason)`; pending-exit flag pattern lets `executeJob()` finally complete + telemetry write before worker.ts decides to exit. Existing `failJob`/`notifyTerminal`/telemetry paths preserved. |
| C-C2 | CRITICAL | INTEGRATED v3: §3.5.D extended — classifier called at all Anthropic-touching catch sites: `executor.ts` (Claude spawn + planSynthesis catch), `plan-synthesizer.ts` (Anthropic synthesis throw), `plan-reviewer.ts` (`runIntegration` swallow path BEFORE `UNAVAILABLE` substitution). Scope expanded by 2 files. |
| C-M1 | MAJOR | INTEGRATED v3: §3.1.A — replaced `claude --version` with `claude auth status`; this DOES exercise the auth state machine + nested-session path, while `--version` does not per docs. Still $0 + local. |
| C-M2 | MAJOR | INTEGRATED v3: §3.1.B — added `undici` to explicit deps; switched to `EnvHttpProxyAgent` (handles HTTP_PROXY/HTTPS_PROXY/NO_PROXY semantics natively, always-on). |
| C-M3 | MAJOR | INTEGRATED v3: §3.6 — temp filename is `.preflight-backoff.tmp.<pid>.<monotonic-counter>` so same-process concurrent writes don't collide. |
| C-M4 | MAJOR | INTEGRATED v3: §3.2.A failure-kind enum no longer includes `nlm-auth-warn`. NLM warnings explicitly bypass `recordFailure()`. |
| C-M5 | MAJOR | INTEGRATED v3: §3.5.A taxonomy restructured — structured SDK fields (`status`, `error.type`) checked FIRST, regex fallback SECOND. Added `billing_error` + `not_found_error` (model deprecated/disabled) classes. |
| C-m1 | MINOR | INTEGRATED v3: §4.1 test list — added explicit hung-binary timeout test. |
| C-m2 | MINOR | INTEGRATED v3: §3.4 — notification predicate is "previous<3 AND next>=3" (covers executor jump-to-3 case). |
| C-m3 | MINOR | INTEGRATED v3: §3.1.B — explicit `res.ok && parseable JSON` ack criterion; empty `data` accepted. |
| C-m4 | MINOR | INTEGRATED v3: §7 rollout adds explicit project `CLAUDE.md` §6 update + `dryrun_handoff.md` next-session-section update + new memory file `feedback_preflight_circuit_breaker.md`. |

**v3 → v3.1 Codex QA fidelity pass (round 3, 2026-05-28 14:10, verdict REQUEST_FIXES → fixed, depth 5/5, 196.7s wall-clock):**

9 dispositions returned FIDELITY-OK. 2 returned FIDELITY-FAIL — both leftover-literal misses, same class as S62's "1-character fix" pattern:

| ID | Fail detail | v3.1 fix |
|---|---|---|
| C-M1 | §3.1.A + §6.A.bis fixed but §3.1.C, §3.1.D, §5 still referenced `checkClaudeBinary` / `claude --version` | Replaced all 3 remaining occurrences with `checkClaudeAuth` / `claude auth status` |
| C-M4 | §3.2.A enum fixed but §3.2.D + §8 still listed `nlm-auth-warn` in the failure-kind enumeration | §3.2.D now lists `env, claude-auth, anthropic-auth` only with explicit NLM-bypass note; §8 reworked to list preflight + terminal kinds separately |

All fixes are pure prose/literal replacements — no semantic drift, no design change. Re-grep clean (verified post-fix).

**Total MRPF cost for this design:** 3 reviewer rounds, ~14 min wall-clock total (Gemini 106s + Codex 554s + Codex QA 196s), $0 (all CLI OAuth subscription quota).

---

## 1. Problem statement

Two costs are bleeding out of the worker daemon's preflight pattern. Discovered during S63 startup when an Anthropic credit-out triggered a `Credit balance is too low` failure loop:

### Cost 1 — billable preflight on every worker startup (real money)
`agent/preflight.ts:78-155` runs `crossSpawn("claude", ["-p", "hello"])` as its second check (`checkClaudeSpawn`). This is a fully billable `claude -p` invocation. Per memory file [feedback_claude_cli_cache_priming_cost.md](../../../.claude/projects/c--Users-ceo-Documents-AI-Training-Anti-Gravity-Dynamic-Research/memory/feedback_claude_cli_cache_priming_cost.md), the first `claude -p` call within a 1h cache window primes ~38K `cache_creation` tokens ≈ **$0.24**. Every worker startup pays this cost, even though everything the check verifies (binary spawn, PATH, cross-spawn `.cmd` shim resolution, `CLAUDECODE` env-strip, API key validity) can be verified for $0 via local commands + `GET /v1/models`.

### Cost 2 — wasteful failure churn during credit-out / outage windows (operational waste, not direct $)
The worker is spawned by Scheduled Task `DynamicResearchWorker` every 5 minutes (cron model, NOT crash-supervisor — see [feedback_scheduled_task_is_cron_not_supervisor.md](../../../.claude/projects/c--Users-ceo-Documents-AI-Training-Anti-Gravity-Dynamic-Research/memory/feedback_scheduled_task_is_cron_not_supervisor.md)). When preflight fails (e.g. credit-out), the worker exits 1. The next cron tick spawns another worker that fails identically. Observed during S63: **6 consecutive identical failures over 30 minutes** in `worker.log` (20:00:39 → 20:05 → 20:10 → 20:15 → 20:20 → 20:25). Projected over a multi-hour outage: ~288 failed spawns/day.

Anthropic billing telemetry confirms HTTP 400 `credit balance is too low` rejections are NOT billed (per `/v1/models` docs + SDK issue anthropics/anthropic-sdk-typescript#618), so this isn't dollar waste — but it pollutes `worker.log`, hides legitimate failure signal (a real spawn bug would look identical to the 288 noise lines), and represents an obvious "system not recognizing it shouldn't run" anti-pattern that contradicts the broader regenerative-systems goal.

### What we are NOT trying to solve
- **Credit-balance prediction without an Admin API key.** No public Anthropic endpoint reports credit balance for a standard `sk-ant-...` key. The credit canary is the first real `claude -p` invocation of a research job; that failure is free + already handled by existing `executor.ts` error paths + Resend notification.
- **Idle-exit ephemeralization of the worker (formerly Tier B).** Initially in scope; dropped after analysis showed it would convert the long-lived 30s-poll daemon into a 5min-cadence ephemeral process, regressing job-pickup latency from <30s to up-to-5min. The preflight cost is already a per-restart event under the current model (preflight runs ONCE per worker lifetime, NOT per poll), so queue-first short-circuiting saves little: a healthy worker restarts rarely. See §6.B for the explicit rejection rationale.

---

## 2. Current state (verified against code as of commit-tip 2026-05-28)

### 2.1 `agent/preflight.ts` (full file read in §1 grep context)

Three checks, run sequentially in `runPreflight()`:

| # | Check | Implementation | Cost | What it verifies |
|---|---|---|---|---|
| 1 | `checkEnv` | Inline env var presence + Windows MSYS-path guard | $0 | `AGENT_SECRET_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` set; no `/c/…` ghost paths |
| 2 | `checkClaudeSpawn` | `crossSpawn("claude", ["-p", "hello"])` with `CLAUDECODE`-stripped env | **~$0.24/run** | (a) binary spawns through `.cmd` shim, (b) PATH resolves `claude`, (c) `CLAUDECODE` strip prevents "nested sessions" error, (d) API key valid + has credit |
| 3 | `checkNotebookLMAuth` | `spawn(notebooklm, ["list", "--json"])` | $0 (local OAuth probe) | NLM venv binary present + session not expired; `required: false` (warn-only) |

Exit semantics: required-check failure → `process.exit(1)`; warn-check failure → log + continue.

### 2.2 `agent/worker.ts:main()` startup flow (lines 99-120)

```typescript
ensureSingleton();             // PID-file singleton guard
if (!DRY_RUN) {
  await runPreflight();        // exits 1 on required-check failure
}
await poll();                  // first poll, then setTimeout loop every 30s
```

### 2.3 Cron config

Scheduled Task `DynamicResearchWorker`, repeat-every 5 min, `RestartCount=0` (not a crash supervisor). LastTaskResult=0 means the prior worker exited cleanly (or has been replaced by a successor). When the prior worker is still alive, the singleton check in `worker.ts:52-82` makes the new spawn refuse with exit 2.

### 2.4 Why the current preflight model leaks $0.24 only on RESTART

`runPreflight()` is called from `main()`, NOT from the `poll()` loop. So when the worker is healthy and long-running, preflight cost is amortized over the worker's entire lifetime. Real cost depends on restart cadence:
- Healthy week with one OS reboot + 2 ad-hoc restarts → 3 preflight runs/week → ~$0.72/week ≈ ~$37/yr
- Failure loop week (credit-out, expired API key) → 288 runs/day × $0 (failed calls free) = $0 in direct cost, but massive log + alerting noise

The dollar cost is not catastrophic. The behavioral pattern is wrong, though, and Cost 2 (failure churn) is what motivates Tier C even more than dollars.

---

## 3. Proposed change

### 3.1 Tier A — Replace billable preflight with free probes

Decompose the bundled-billable `checkClaudeSpawn` into two free checks:

#### 3.1.A `checkClaudeAuth` (replaces `checkClaudeSpawn`; renamed in v3 per C-M1)
- Run `crossSpawn("claude", ["auth", "status"], {env: childEnvWithoutClaudecode})`
- Verifies: binary on PATH + `.cmd` shim resolution + `CLAUDECODE` env-strip + auth state machine initialization. Per Claude Code CLI docs (https://code.claude.com/docs/en/cli-reference), `claude auth status` is documented for scripting/CI with exit-code semantics: exit 0 = authed (via OAuth subscription OR `ANTHROPIC_API_KEY`), exit 1 = not authed.
- **Why not `claude --version` (rejected per C-M1):** `--version` only prints the version banner; per docs it does NOT initialize the auth/session machinery, so it does NOT exercise the same `CLAUDECODE` nested-session error path that `claude -p` did. `auth status` does initialize it (it has to, in order to report status). This is the closest free-cost replacement for the original coverage.
- Cost: $0 (local-only auth-state check; no API call)
- Expected stdout: short status line (`Logged in as ...` or similar) on exit 0
- Failure modes:
  - ENOENT spawn error → binary not on PATH (existing remediation)
  - Exit 1 with `nested sessions` substring → CLAUDECODE leaked through env-strip (Bug 32 regression)
  - Exit 1 otherwise → not authed (no env key + no OAuth)
- Timeout: 15s (shrunken from 60s — auth check is local, should respond <2s)

#### 3.1.B `checkAnthropicAuth` (NEW; revised v3 per C-M2)
- Direct HTTPS request: `GET https://api.anthropic.com/v1/models` with `x-api-key: $ANTHROPIC_API_KEY` and `anthropic-version: 2023-06-01` headers
- Uses Node 22 built-in `fetch` + **`undici.EnvHttpProxyAgent`** (always-on dispatcher; no-op when proxy env absent)
- Cost: $0 (models-list endpoint is not billed; verifies auth only, not credit balance)
- Verifies: API key is present + authenticatable. Does NOT verify credit balance (intentional — see §1 "What we are NOT trying to solve")
- Timeout: 10s
- **Success criterion (per C-m3):** `res.ok` (i.e. HTTP 2xx) AND response body parses as JSON object. Empty `data: []` is acceptable — we are verifying auth, not model availability.
- Failure modes: 401 → key invalid, 403 → key revoked/scoped wrong, missing-env → fail with clear "ANTHROPIC_API_KEY not set" remediation, network error → DNS/firewall issue, JSON parse error → upstream API contract drift (log + treat as transient).
- **`ANTHROPIC_API_KEY` is NOT added to `checkEnv`'s required list** (Decision B, §10). The check handles its own missing-env path with a more specific remediation message than `checkEnv` could produce.
- **Proxy handling (revised v3 per C-M2):** `undici.EnvHttpProxyAgent` is the canonical dispatcher for proxy-env handling. It reads `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (and lowercase variants) natively, falls back to direct connect when env vars absent, and respects `NO_PROXY` patterns. Pattern:
  ```typescript
  import { EnvHttpProxyAgent } from "undici";
  const dispatcher = new EnvHttpProxyAgent();
  const res = await fetch(url, { headers, dispatcher, signal: AbortSignal.timeout(10_000) });
  ```
  **Dependency note:** `undici` MUST be added as explicit `dependencies` in `agent/package.json` even though Node 22's built-in `fetch` is implemented on top of it. Per pnpm hoisting semantics, relying on transitive availability is not acceptable. Lockfile update is part of the ship artifact list.

#### 3.1.C Coverage delta (G-m4 trimmed)

Local-spawn coverage (binary + PATH + cross-spawn shim + CLAUDECODE strip + nested-session error + auth state machine init) → all moved to `checkClaudeAuth` via `claude auth status`. API-side coverage (key present + key valid) → `checkAnthropicAuth`. The one coverage drop is **credit-balance verification**, intentionally moved to the executor canary path (see §3.5 for the feedback loop that prevents queue-burning when the canary fires).

#### 3.1.D Cost delta

| Metric | Before | After |
|---|---|---|
| Per-startup preflight cost | ~$0.24 | $0 |
| Per-failed-startup cost | $0 (call rejected free) | $0 (no API call needed; `claude auth status` is local) |
| Per-startup wall time | ~5-8s (claude -p spin-up + LLM reply) | ~1-2s (version banner + HTTPS round-trip) |

### 3.2 Tier C — File-backed circuit breaker (exponential backoff on consecutive failures)

Per Gemini G-m1: this pattern IS a file-backed circuit breaker, mapped onto the cron-driven daemon lifecycle. The three classic states correspond to:

| Classic state | Our implementation | Trigger |
|---|---|---|
| **Closed** | No `.preflight-backoff` file | Healthy operation. Preflight runs every worker startup. |
| **Open** | `.preflight-backoff` exists + `backoffUntil` is in future | Worker exits 0 immediately at startup. Cron continues to fire every 5 min; each tick observes Open + exits cheaply. |
| **Half-Open** | `.preflight-backoff` exists + `backoffUntil` is in past | First cron tick after the window. Preflight runs; success → Closed (delete file), failure → Open with longer window (increment `consecutiveFailures` + recompute `backoffUntil`). |

This framing is load-bearing for §3.5 (executor.ts feedback loop) since the executor needs to be able to push the circuit from Closed → Open without going through preflight.

#### 3.2.A State file
- Path: `<cwd>/.preflight-backoff` (same dir as `.worker.pid`)
- Schema (JSON):
  ```json
  {
    "consecutiveFailures": 3,
    "lastFailureAt": "2026-05-28T20:00:00.000Z",
    "backoffUntil": "2026-05-28T20:30:00.000Z",
    "lastFailureKind": "claude-binary"
  }
  ```
- Lifecycle: written on every preflight failure, deleted on every preflight success.
- Helper module: `agent/lib/preflight-backoff.ts` with these exports — `readBackoff()`, `recordFailure(kind)`, `recordFailureFromTerminalError(t)`, `clearBackoff()`, `classifyTerminalError(input)`, `markPendingTerminalExit(t)`, `consumePendingTerminalExit()`.
- Failure `kind` enum (per C-M4 — NLM warn explicitly excluded):
  - Preflight kinds: `env` | `claude-auth` | `anthropic-auth`
  - Terminal-error kinds (per §3.5.A): `credit-out` | `auth-out` | `billing-error` | `model-not-found`
  - **NLM warnings DO NOT increment backoff.** Per `agent/preflight.ts:184` + `:247`, `nlm-auth` is explicitly `required: false`. The warn path logs + continues without touching the circuit breaker. This is explicit per C-M4 to prevent a future implementer from accidentally promoting a warn to a circuit-open event.

#### 3.2.B Backoff schedule

Cron fires every 5 min. Backoff in minutes-from-`lastFailureAt`:

| Consecutive failures | Backoff window | Effective next-attempt cadence |
|---|---|---|
| 1 | 0 min (no backoff yet) | next cron tick (~5 min) |
| 2 | 10 min | every other cron tick (~10 min) |
| 3 | 20 min | ~every 4th cron tick |
| 4 | 40 min | ~every 8th cron tick |
| 5+ | 60 min (cap) | ~every 12th cron tick |

Rationale for the schedule:
- N=1 produces no backoff: transient failures are common (network blip, race with a credential refresh); don't penalize first failure.
- Powers of 2 starting at 10 min: industry-standard exponential pattern; 10/20/40/60 fits comfortably inside the 5-min cron granularity (no point in 7-min or 13-min backoff; cron only sees multiples of 5).
- 60-min cap: stays responsive to manual fixes (top-off credits, fix env var) within an hour of recovery. Most credit-outs in practice are resolved <30 min from human noticing.

#### 3.2.C Flow change in `worker.ts:main()`

```typescript
ensureSingleton();
if (!DRY_RUN) {
  const backoff = await readBackoff();
  if (backoff && new Date(backoff.backoffUntil) > new Date()) {
    log(`Backoff active until ${backoff.backoffUntil} (${backoff.consecutiveFailures} consecutive failures, last: ${backoff.lastFailureKind}). Exiting cleanly.`);
    releasePidFile();
    process.exit(0);   // exit 0, NOT 1 — we don't want cron escalation
  }
  await runPreflight();   // unchanged signature; throws on failure (see §3.2.D)
}
await poll();
```

#### 3.2.D Flow change in `runPreflight()`

Currently `runPreflight()` calls `process.exit(1)` directly on failure. New behavior:
- Failure → call `recordFailure(kind)` to write backoff state, THEN exit 1
- Success → call `clearBackoff()` to delete state file
- `kind` is one of: `env`, `claude-auth`, `anthropic-auth`. Used for log clarity + future telemetry. (Per §3.2.A + C-M4: NLM warnings are explicitly NOT in this enum — the warn path bypasses `recordFailure()` entirely.)

#### 3.2.E Exit-code semantics (consolidated into §3.2.C above)

The flow change in §3.2.C is explicit: backoff-active → exit 0 (clean idle); preflight failure → exit 1 (signals cron). Critical for `LastTaskResult ≠ 0` alerting to fire only on NEW failures, not on every cron tick during a known back-off window.

### 3.3 Telemetry / observability additions

Two log lines per preflight cycle for grep-friendliness:
```
[preflight] backoff-state: failures=N until=ISO_TIMESTAMP
[preflight] backoff-action: backoff-skip | running-checks | recovered
```

No new Supabase telemetry table — the `worker.log` grep + LastTaskResult are sufficient. (A future-S `preflight_runs` table could be considered if we want trend analysis, but YAGNI for now.)

### 3.4 Resend notification on entering backoff (Decision D)

Reuse existing `agent/lib/notify.ts` Resend channel. Fire ONCE when `recordFailure()` advances `consecutiveFailures` from 2 → 3 (the first failure that produces a non-trivial backoff window — 20 min). Subsequent failures within the same outage do NOT re-notify (avoid alert fatigue); recovery (next successful preflight → `clearBackoff`) fires a recovery email so the operator gets closure.

Notification payload (subject + short body):
- Subject: `[Dynamic Research] Worker preflight backoff active (N=3)`
- Body: failure kind (e.g. `claude-binary` / `anthropic-auth`), backoff window in minutes, remediation hint based on kind, link to `worker.log` tail command
- Recovery subject: `[Dynamic Research] Worker preflight recovered`
- Recovery body: count of consecutive failures observed before recovery, total outage duration (`lastFailureAt → clearBackoff time`)

This trades zero new alert channels for latency-of-recognition guarantee. Per `feedback_resend_free_tier_own_email_only.md` the verified-domain path is already in use for executor notifications, so no new email-deliverability surface.

### 3.5 Execution-side feedback to backoff (G-C1 + C-C1 + C-C2 + C-M5)

**The problem Gemini caught (G-C1):** Tier A drops in-preflight credit-balance verification (no public free endpoint for that signal). Without execution-side feedback, the worker would claim job 1 → executor fails → claim job 2 → 30s later same thing → entire queue chewed through, Resend spammed per job, Tier C bypassed entirely.

**The expansion Codex caught (C-C2):** Phase 0a/0b of `executeJob()` uses direct Anthropic API transports (not the `claude -p` spawn). Credit/auth failures there get swallowed:
- `plan-synthesizer.ts` throws → `executor.ts:208` catches + marks job failed but doesn't propagate signal
- `plan-reviewer.ts:runIntegration` catches transport exceptions + converts them to `UNAVAILABLE` audit rows (S62 Bug 53a fix) — the executor never sees the original Anthropic error
- Result: the same queue-burning happens even at the plan-review-gate layer

**The refinement Codex caught (C-C1):** A naive inline `process.exit(1)` in the catch block would bypass the `finally` clause at `executor.ts:486` that writes usage telemetry, AND would lose `stdout`/`stderr` evidence that lives only in the spawn-side buffer (not in the thrown `err` object — which carries only the generic `Claude process exited with code ${exitCode}` message at `executor.ts:434`).

**The fix (v3 architecture):** A three-part pattern:

#### 3.5.A Terminal-error taxonomy (revised v3 per C-M5: structured-fields-first)

The classifier checks fields in priority order. First match wins. All other errors → `null` (not terminal; existing behavior preserved).

**Priority 1 — Structured SDK fields** (when the caught error is an `APIError`-shaped object from `@anthropic-ai/sdk` or `@google/genai` or `openai`):

| Source field | Value | → kind | Why terminal |
|---|---|---|---|
| `error.type` | `billing_error` | `billing-error` | Account-level credit/billing problem |
| `error.type` | `authentication_error` | `auth-out` | Key invalid |
| `error.type` | `permission_error` | `auth-out` | Key revoked or scope-restricted |
| `error.type` | `not_found_error` + message matches `model` | `model-not-found` | Configured model deprecated/disabled; every subsequent call fails identically |
| `status` | `401` (any provider) | `auth-out` | Same as above |
| `status` | `403` (any provider) | `auth-out` | Same as above |

**Priority 2 — Regex on enriched evidence** (for `claude -p` spawn failures, where the error message text is in the stdout/stderr buffer, not a structured field — per C-C1's enriched-input requirement):

| Source | Pattern (case-insensitive) | → kind |
|---|---|---|
| stdout/stderr/err.message | `credit balance is too low` | `credit-out` |
| stdout/stderr/err.message | `invalid.{0,5}(api.?)?key` OR `authentication.?error` | `auth-out` |
| stdout/stderr/err.message | `HTTP 401\|status 401` | `auth-out` |
| stdout/stderr/err.message | `HTTP 403\|status 403\|permission.?error` | `auth-out` |

Explicitly **NOT** terminal (continue polling):
- HTTP 429 (rate limit) — recoverable with request-layer backoff
- HTTP 5xx — Anthropic-side transient
- Network timeout / DNS / EAI_AGAIN — local network blip
- Single-job content errors (context overflow, content policy refusal, malformed prompt)
- Any non-matching error — default to continue polling

Rationale for SDK issue #618: credit-low may surface as HTTP 400 with the `credit balance is too low` message body string. Priority 2 catches this when `error.type` isn't set (some SDK versions don't populate it on 400 responses).

#### 3.5.B Classifier signature (side-effect-free per C-C1)

NEW helper in `agent/lib/preflight-backoff.ts`:
```typescript
export interface TerminalError {
  kind: 'credit-out' | 'auth-out' | 'billing-error' | 'model-not-found';
  signature: string;  // human-readable: e.g. "structured:billing_error" | "regex:credit-balance-low"
  source: string;     // call-site identifier: "executor:claude-spawn" | "plan-synthesizer" | "plan-reviewer:integration"
}

export function classifyTerminalError(input: {
  err: unknown;
  stdoutTail?: string;   // up to ~4KB of recent stdout (Claude CLI catch sites)
  stderrTail?: string;   // up to ~4KB of recent stderr
  stateFailureReason?: string;  // job's state.json failure reason if known
}): TerminalError | null
```

The classifier **does not** call `recordFailure()`, write any file, mutate any state, or call `process.exit`. It is a pure function: input shape → optional TerminalError. This satisfies C-C1's "preserve finally + telemetry" requirement.

#### 3.5.C Pending-exit flag pattern (per C-C1)

Module-level state in `agent/lib/preflight-backoff.ts`:
```typescript
let _pendingTerminalExit: TerminalError | null = null;
export function markPendingTerminalExit(t: TerminalError): void;
export function consumePendingTerminalExit(): TerminalError | null;  // reads + clears
```

This decouples detection (at any of the 3 call-sites in §3.5.D) from the exit decision (made by `worker.ts` AFTER `executeJob()` returns + its `finally` has run).

#### 3.5.D Call-site integration (per C-C2)

**Three sites detect terminal errors and call `markPendingTerminalExit()` instead of exiting:**

1. **`agent/executor.ts`, Claude spawn catch (~line 416/434):** classifier receives `(err, stdoutTail = getStdout().slice(-4096), stderrTail = recentStderrBuffer.slice(-4096))`. Site identifier: `"executor:claude-spawn"`.

2. **`agent/executor.ts`, planSynthesis catch (~line 208):** classifier receives `(err)` (no spawn buffers). Site identifier: `"executor:plan-synthesis"`. If terminal: `markPendingTerminalExit()` BEFORE the existing `failJob` + `notifyTerminal` calls run (so the existing teardown completes naturally).

3. **`agent/lib/plan-reviewer.ts`, `runIntegration` catch:** the current behavior swallows the exception and writes an `UNAVAILABLE` audit row. v3 inserts a classifier check FIRST: if terminal → `markPendingTerminalExit()` AND propagate the error up (don't swallow into UNAVAILABLE). If not terminal → existing UNAVAILABLE swallow behavior (Bug 53a fix preserved). Site identifier: `"plan-reviewer:integration"`. Note: the synthetic UNAVAILABLE row pattern is the right answer for transient reviewer outages; the carveout is specifically for account-level terminal errors that should NOT be silently treated as "reviewer offline".

**`worker.ts` exit decision (post-`poll`):**
```typescript
await executeJob(job);   // existing path; finally block runs; telemetry preserved
const pending = consumePendingTerminalExit();
if (pending) {
  await recordFailureFromTerminalError(pending);  // writes backoff state (atomic per §3.6)
  log(`Terminal provider error: ${pending.kind} from ${pending.source} (${pending.signature}). Exiting worker; cron-backoff active.`);
  releasePidFile();
  process.exit(1);
}
// else: normal poll loop continues
```

#### 3.5.E `recordFailureFromTerminalError()` behavior

Same state-file write logic as `recordFailure()` (per §3.6) but:
1. The `kind` field uses the terminal taxonomy (`credit-out` / `auth-out` / `billing-error` / `model-not-found`) instead of preflight kinds (`env` / `claude-auth` / `anthropic-auth`).
2. Jumps `consecutiveFailures` directly to **3** (= 20-min backoff) rather than incrementing from current value. Rationale: a terminal-classified error mid-execution is high-confidence — no point in the 0-min "transient blip" tier when we know the cause.
3. Notification predicate per C-m2: fires Resend email iff previous-state `consecutiveFailures < 3` AND new value `>= 3` (so the jump-to-3 from any prior state triggers it).

#### 3.5.F Notification semantics (per C-m2 + §3.4)

The N=3 Resend email subject distinguishes preflight vs terminal-error origin:
- Preflight: `[Dynamic Research] Worker preflight backoff active (N=3)`
- Terminal: `[Dynamic Research] Worker exited on terminal provider error (<kind>)` — body includes `source` field so operator knows which Anthropic call layer surfaced it
- Recovery (any origin): `[Dynamic Research] Worker preflight recovered`

### 3.6 Atomic-write contract for `.preflight-backoff` (G-m3 + C-M3)

`recordFailure()` and `recordFailureFromTerminalError()` MUST follow this exact sequence:

1. Build the new JSON state object
2. Generate a temp filename: `.preflight-backoff.tmp.<pid>.<monotonic-counter>` where `<monotonic-counter>` is a module-level int that increments on every write call. This satisfies C-M3: even same-process concurrent writes get unique temp paths.
3. `await fs.writeFile(<cwd>/<temp>, JSON.stringify(state))` — write to per-PID-per-counter temp
4. `await fs.rename(temp, <cwd>/.preflight-backoff)` — atomic on NTFS within the same volume per POSIX-on-Windows semantics
5. Return only after the rename promise resolves
6. All callers MUST `await` the `recordFailure*()` call before any subsequent `process.exit(N)` or function return that could let the process unwind

The singleton guard (`worker.ts:52-82`) prevents two workers running concurrently across processes. The per-PID-per-counter temp filename adds defense-in-depth for same-process concurrency (e.g. if two terminal-error catch sites both fire before the worker exits — unlikely but possible if Phase 0a + Phase 0b both throw on the same Anthropic outage).

`readBackoff()` MUST tolerate JSON.parse errors gracefully (treat as "no backoff", log warning). A corrupted state file should self-heal on the next successful preflight via `clearBackoff()`.

`clearBackoff()` MUST be idempotent — `fs.unlink` with ENOENT swallowed.

**Codex QA pass must verify:** every `process.exit` call on the failure path has an `await` on its preceding `recordFailure*()` call. A missed `await` would let the process exit before the rename flushes, leaving the next cron tick to see a stale state. Specifically: `worker.ts:main()` backoff-check exit, `worker.ts:poll()` post-executeJob terminal-exit, and `runPreflight()` failure exits.

---

## 4. Test strategy

### 4.1 Unit tests — `agent/test/preflight.test.ts` (NEW)

Use `node --test` (project standard per CLAUDE.md §2):

1. `checkEnv` — missing required vars produces actionable remediation (no regression from current behavior)
2. `checkClaudeAuth` — happy path (exit 0) returns ok; exit 1 with non-`nested sessions` stderr returns auth remediation; exit 1 with `nested sessions` substring returns Bug-32 regression remediation; missing binary (ENOENT) returns spawn-error remediation
3. `checkAnthropicAuth` — mocked fetch returns 200 + valid JSON → ok; 401 → fail with auth-remediation; 429 → fail-but-treat-as-transient; network timeout → fail with network-remediation; `HTTPS_PROXY` env set → fetch dispatcher receives `EnvHttpProxyAgent`; JSON parse error → fail with transient remediation
4. **Hung-binary test (per C-m1):** mocked spawn that never exits — `checkClaudeAuth` MUST resolve with timeout failure within 15s; child must receive SIGKILL; single resolution (no double-resolve race)
5. Backoff schedule — N=1,2,3,4,5,10 produce 0/10/20/40/60/60 min windows
6. `recordFailure` + `readBackoff` round-trip
7. `clearBackoff` is idempotent (no-op when file absent)
8. Concurrent `recordFailure` calls don't corrupt the JSON — verify per-PID-per-counter temp filename uniqueness (per C-M3)
9. `readBackoff` on corrupted JSON returns null + logs warning (graceful degradation)
10. State-file write uses per-PID-per-counter temp filename + atomic rename (verify against fs spy)
11. NLM warn path does NOT call `recordFailure()` — verify with notify-spy that no state-file write occurs

### 4.2 Unit tests — `agent/test/terminal-errors.test.ts` (NEW per §3.5, renamed in v3)

1. `classifyTerminalError` priority 1 — each structured-field signature in §3.5.A row 1 classifies correctly (billing_error, authentication_error, permission_error, not_found_error+model)
2. `classifyTerminalError` priority 1 — status-only signatures (401/403 with no error.type) classify as auth-out
3. `classifyTerminalError` priority 2 — each regex signature in §3.5.A row 2 classifies correctly across stdout/stderr/err.message inputs
4. `classifyTerminalError` non-terminal — HTTP 429, 5xx, network timeout, content policy, EAI_AGAIN, model-overload all return null
5. `classifyTerminalError` shape tolerance — handles `unknown` inputs (string, null, undefined, plain object, Error subclass) without throwing
6. `markPendingTerminalExit` + `consumePendingTerminalExit` round-trip — set, read, returns + clears, second read returns null
7. `recordFailureFromTerminalError` jumps `consecutiveFailures` directly to 3 (NOT increment from current)
8. `recordFailureFromTerminalError` notification predicate — previous N=0 + new N=3 → fires; previous N=3 + new N=3 → does NOT fire (no re-notify)
9. Notification subject distinguishes preflight vs terminal origin (verify via notify-spy)

Coverage target: 100% of new code paths in `preflight.ts` + `preflight-backoff.ts`.

### 4.3 Integration tests

1. Manual: `pnpm -C agent start` with a deliberately bad `ANTHROPIC_API_KEY` → confirm backoff state advances correctly across 3 consecutive cron-emulated runs.
2. Manual: restore correct key → confirm backoff file is deleted on next successful preflight.
3. Manual: dry-run worker startup with `DRY_RUN=true` skips both preflight AND backoff write (preserves current DRY_RUN semantics).
4. Manual (per §3.5): submit a research job, then deliberately exhaust credit during execution (e.g. by setting a $0 sub-key) → confirm worker exits 1 with `recordFailureFromTerminalError({kind: 'credit-out', source: 'executor:claude-spawn', ...})` written, AND the next cron tick observes Open state + exits 0.
5. Manual (per §3.5): submit a research job that fails with HTTP 429 → confirm worker does NOT exit, continues polling (verifies non-terminal classification).
6. Manual (per §3.5.D site 3 / C-C2): break the GEMINI_API_KEY mid-job during plan-review → confirm `plan-reviewer.ts:runIntegration` classifies as `auth-out`, propagates rather than swallowing into UNAVAILABLE, marks worker for terminal exit.
7. Manual (per §3.6 / C-M3): induce two concurrent terminal-error catches in the same process (e.g. Phase 0a + Phase 0b both throw on same outage) — confirm both temp files have unique names + the second rename wins cleanly without corrupting state.

### 4.4 Existing test suite must still pass

Per CLAUDE.md §2: `pnpm test` from repo root runs the storage-paths grep guard + tsc across both subprojects. Expect 115/115 plan-tests still passing (S62 baseline) + new preflight + executor-terminal-errors test counts on top.

---

## 5. Failure modes considered

| Failure mode | Mitigation |
|---|---|
| `.preflight-backoff` file corrupted | `readBackoff()` catches JSON.parse errors, treats as "no backoff" + logs warning. Self-heals on next success. |
| Clock skew / time-travel | `backoffUntil` is absolute ISO timestamp. If system clock jumps forward, backoff ends early (acceptable). If clock jumps backward, backoff lengthens (acceptable — fail-safe). |
| Two cron ticks racing on backoff file write | Singleton guard prevents two workers running simultaneously; only one will attempt the write. Even without singleton, the failure case writes to temp + atomic rename. |
| Credit-out detected only on first real job | §3.5 feedback loop: classifier at any of the 3 sites flags terminal, worker.ts records backoff post-finally + exits. Next cron tick observes Open + exits 0. Single DLQ row + email per credit-out — NOT 288/day, NOT one-per-queued-job. |
| Credit-out mid-day with multiple jobs queued | §3.5 feedback loop fires on the first job's failure; remaining jobs stay in `pending` status until the credit-out is resolved + backoff window expires. Pending jobs are NOT marked failed (avoid false-negative cascade). |
| Credit-out fires during Phase 0 plan synthesis (NOT claude -p spawn) | §3.5.D site 2: `executor.ts:208` planSynthesis catch classifies; site 3: `plan-reviewer.ts:runIntegration` classifies BEFORE UNAVAILABLE swallow. Covers all Anthropic-touching surfaces, not just the CLI spawn path. (Codex C-C2.) |
| Classifier misclassifies a transient error as terminal | §3.5.A taxonomy is allow-list, structured-fields-first then regex: only listed signatures match. 429/5xx/network/policy explicitly return null. Codex QA pass should re-verify regex strictness. |
| Two concurrent terminal-error catches in same process | §3.6 per-PID-per-counter temp filename prevents collision. The pending-exit flag is last-write-wins, which is acceptable since the worker.ts exit decision happens once after `executeJob()` returns; whichever terminal-error kind was set last wins. (No semantic problem — both kinds would trigger the same backoff window.) |
| Proxy env var set but `undici.EnvHttpProxyAgent` throws on construction | Wrapped in try/catch; fallback to no-dispatcher fetch + log warning. Worse case: false-negative on proxied environment, surfaces as `checkAnthropicAuth` timeout → caller treats as transient. Acceptable degradation. |
| Inline `process.exit(1)` bypasses telemetry `finally` block | §3.5.C pending-exit flag pattern explicitly defers the exit decision to `worker.ts` AFTER `executeJob()` completes (including its finally clause). No `process.exit` in any classifier call-site. (Codex C-C1.) |
| `runIntegration` swallows the wrong class of error | §3.5.D site 3 inserts classifier BEFORE the existing UNAVAILABLE swallow. Non-terminal reviewer-transport failures still get UNAVAILABLE-rowed (Bug 53a fix preserved); terminal errors propagate instead of being silently masked as "reviewer offline". |
| `GET /v1/models` returns 200 with empty data list | Treat 200-anything as ok (auth verified). The data list contents are not load-bearing. |
| Anthropic API down (5xx) but key valid | `checkAnthropicAuth` fails → backoff kicks in. Acceptable — if Anthropic is down, we can't run jobs anyway. |
| Network firewall blocks api.anthropic.com but not the binary | `checkAnthropicAuth` fails → backoff + clear remediation message pointing at firewall/proxy. |
| `claude auth status` succeeds but actual `claude -p` would fail (auth-only doesn't exercise the full LLM call path) | This is the trade-off for moving to free probes. Mitigation: the FIRST job after a recovery still exercises the full path; if it fails, §3.5 executor classifier handles it. Acceptable. |

---

## 6. Decisions made + alternatives considered

### 6.A Decision: Use `fetch` + explicit `undici` dep for `checkAnthropicAuth` (v3, revised per C-M2)
Node 22 has `fetch` built-in (on top of undici). But `EnvHttpProxyAgent` lives in the undici package surface, not Node's globals. Per pnpm hoisting semantics, transitive availability is unreliable — so `undici` is added as an explicit `dependencies` entry. The `fetch` shape itself remains unchanged. v2 had a conditional ProxyAgent on env-var presence; v3 always uses EnvHttpProxyAgent (handles NO_PROXY natively, no-op when env absent).

### 6.A.bis Decision: `claude auth status` not `--version` for `checkClaudeAuth` (v3, per C-M1)
`--version` was the original v2 choice but per Claude Code CLI docs it does NOT initialize the auth/session machinery, so it does NOT exercise the `CLAUDECODE` nested-session error path that `claude -p` did. `auth status` IS documented for scripts/CI with exit-code semantics + exercises the auth state machine. Same cost ($0, local-only), better coverage.

### 6.B Decision: DROP Tier B (queue-first short-circuit / idle-exit)
Initially proposed in S63 deep research. Dropped after determining:
- Preflight runs ONCE per worker lifetime, not per poll
- Healthy worker restarts are rare (1-3/week typical)
- Converting to ephemeral 5-min process trades 30s job-pickup latency for up-to-5min
- Adding a "peek" endpoint to `frontend/app/api/queue/claim` for non-claiming work-check is a small but real frontend surface expansion
- Net savings: ~$0/week (preflight savings ≈ 0 since healthy restarts are rare) vs. real UX regression
- If a future "completely idle for hours" cost becomes meaningful, revisit with a different design (e.g. systemd-style activation-on-queue-insert via Supabase realtime).

### 6.C Decision: No new env vars
The backoff schedule is hardcoded constants in `preflight-backoff.ts`. If operators need to tune later, refactor to env vars then. YAGNI for now.

### 6.D Decision: Backoff file is per-cwd (next to `.worker.pid`), not global
Matches the existing singleton-PID pattern. Survives reboots (cron's working directory is stable). Doesn't pollute `~`/`%APPDATA%`.

### 6.E Decision: Exit 0 on backoff-skip, exit 1 on actual failure
Distinguishes "knowingly idle" from "newly broken" in `LastTaskResult` monitoring. Critical for any future Grafana alert: alert on `LastTaskResult != 0`, not `!= 0 OR worker.log contains "fail"`.

### 6.F Considered + rejected: Tier C without Tier A
You COULD add backoff without changing the billable preflight (just stop pummeling during credit-out). But then steady-state cost stays at $0.24/restart, which is the bigger architectural smell. Tier A is the higher-leverage half. Keep them bundled.

### 6.G Decision: No manual `/preflight-reset` override mechanism (Decision C)
Operator escape hatch is already `Disable-ScheduledTask -TaskName DynamicResearchWorker + Enable-ScheduledTask` (clean slate next tick) OR manual `rm .preflight-backoff` from PowerShell. Adding a documented `/preflight-reset` command would be one more user-invocable surface that needs docs, tests, and a permissions story. YAGNI.

### 6.H Considered + rejected: Replace `claude -p hello` with `claude -p --tokens=1 hi` to make the canary cheap-but-real
A 1-token `claude -p` invocation would still verify credit balance for ~$0.0003/check. Rejected because:
- Still bills SOMETHING; over a year of restarts that's noise, not a meaningful canary
- Doesn't eliminate the "claude is binary that costs money to verify" anti-pattern
- `--tokens=1` is not a documented CLI flag; would be fragile
- The credit canary on first real job is already free + already handled by existing notify path

---

## 7. Rollout plan

1. **MRPF round 1 — Gemini holistic review** (this v1 doc). Focus areas in §9.
2. **Integrate Gemini findings → v2.**
3. **MRPF round 2 — Codex code-grounded review on v2.** Focus areas in §9.
4. **Integrate Codex findings → v3 (final). Synthesis doc:** `Documentation/preflight-cost-architecture-design-gate-peer-review.md`.
5. **Implementation (separate session segment).** Sandbox-route all edits per CLAUDE.md §5.
6. **MERGE-gate review.** Re-run Gemini + Codex on the actual code diff. Sequential. Risk labels carry forward.
7. **Promote sandbox → live via `/promote`.**
8. **Deploy:** worker daemon restart picks up new preflight + executor code (no Vercel deploy needed — this is agent-side only). Manual restart: `Start-ScheduledTask -TaskName DynamicResearchWorker` after restart of the existing worker via PID-kill or graceful SIGTERM.
9. **Verification (post-deploy):**
   - Tail `worker.log` for first preflight: expect `✓ claude-binary` + `✓ anthropic-auth` lines instead of `✓ claude-spawn`
   - Manually break `ANTHROPIC_API_KEY` in agent/.env → wait 3 cron ticks → confirm backoff state advances to N=3 + backoff window = 20 min + Resend email arrives
   - Restore key → confirm backoff file deleted on next preflight success + recovery Resend email arrives
   - NEW per §3.5: submit a test job with deliberately-low credit → confirm executor catches the terminal error + writes backoff + exits 1; subsequent cron tick observes Open + exits 0; pending jobs stay `pending` not `failed`
10. **Backout plan:** revert the promoted commit. No DB migrations, no env var changes, no Vercel impact. Worker daemon picks up reverted code on next restart. The `.preflight-backoff` file (if any exists at backout time) is harmless — old code ignores it, so reverted preflight runs normally. The `undici` dep stays in `agent/package.json` after a revert (harmless; future re-introduction skips the install step).

### 7.B Companion doc updates (per C-m4)

These land WITH the ship commit, not separately:

1. **Project `CLAUDE.md` §6** — update worker daemon description to mention the circuit breaker:
   > Pre-flight check uses local-only probes (`claude auth status` + `GET /v1/models` with `EnvHttpProxyAgent`); a file-backed circuit breaker at `.preflight-backoff` opens for 10/20/40/60-min windows on consecutive preflight or terminal-execution failures.
2. **`memory/dryrun_handoff.md`** — S63 close section MUST note the executor.ts + plan-synthesizer.ts + plan-reviewer.ts scope expansions for cross-session traceability.
3. **NEW memory file `feedback_preflight_circuit_breaker.md`** — capture the pattern (Closed/Open/Half-Open state mapping, classifier signature, pending-exit flag) as a memoized regenerative-systems pattern. Useful for the next time we add an Anthropic-touching subsystem (the classifier site list needs to grow).

---

## 8. Out of scope (future S64+ items)

- Credit balance prediction via Admin API key (would require provisioning + secrets management for a second `sk-ant-admin-...` key — separate decision).
- Telemetry table `preflight_runs` for trend analysis. Defer until we have evidence the worker.log grep is insufficient.
- Failure-kind taxonomy beyond the 3 preflight + 4 terminal listed (preflight: env, claude-auth, anthropic-auth; terminal: credit-out, auth-out, billing-error, model-not-found). Will emerge organically.
- Tier B (queue-first short-circuit / idle-exit) — see §6.B for explicit deferral rationale.
- Supabase realtime subscription as worker activation mechanism (replaces cron-polling entirely). Architecturally interesting but a much larger rewrite.

---

## 9. Reviewer focus areas

### 9.A For Gemini (round 1, holistic long-context)
Use `agent/preflight.ts` + `agent/worker.ts` + `agent/api-client.ts` + `agent/lib/notify.ts` + this doc as the read-context. Specifically critique:

1. **Backoff state file race conditions** under cross-cron-tick contention. Singleton guard helps but does it eliminate? What if cron tick N+1 fires the instant tick N is in the middle of `recordFailure()`?
2. **Edge cases in the schedule.** Is "no backoff on N=1" the right call? Should we use jitter to avoid cron-tick-aligned thundering herd if there are eventually multiple workers (unlikely but worth a thought)?
3. **`fetch` vs `https` choice.** Is there a TLS / proxy edge case where Node 22 built-in fetch behaves differently from the older `https` module that would surface in a Windows-Scheduled-Task context?
4. **Coverage gap from dropping the in-preflight credit check.** Is "let the first real job be the canary" actually acceptable, or is there a class of customer pain we're papering over?
5. **The architectural worry behind Tier C.** Is exponential backoff the right pattern, or should we instead use circuit-breaker semantics (open / half-open / closed) with explicit health probes? Defend the choice or push us toward the more sophisticated pattern.
6. **Anything in the broader regenerative-systems pattern this design contradicts or accidentally moves AWAY from.**
7. **The DROPPED Tier B rationale in §6.B.** Was it dropped for the right reason, or should we have considered a hybrid (e.g. queue-first short-circuit only on N≥3 consecutive empty polls)?

### 9.B For Codex (round 3 — fidelity QA on v3)
v3 has Codex round-2 CRITICAL + MAJOR + MINOR findings integrated. This pass is **fidelity-only**: verify each v2-flagged finding was applied correctly. NOT novel critique. Per MRPF revision-state policy + the "the reviewer who caught more last round verifies fidelity" rule, Codex caught 2C+5M+4m vs Gemini's 1C+1M+4m, so Codex owns the QA.

Specifically verify each disposition row in the v2→v3 integration record (top of doc) reflects the actual section content:

1. **C-C1:** §3.5.B (classifier signature) is side-effect-free pure function; §3.5.C pending-exit flag pattern is defined; §3.5.D shows `worker.ts` calls `consumePendingTerminalExit()` AFTER `executeJob()` finally completes (no inline `process.exit` in catch sites).
2. **C-C2:** §3.5.D enumerates all 3 call-sites (executor:claude-spawn, executor:plan-synthesis, plan-reviewer:integration). Each site's prose specifies the integration point precisely.
3. **C-M1:** §3.1.A uses `claude auth status` not `--version`; §6.A.bis records the decision rationale.
4. **C-M2:** §3.1.B uses `EnvHttpProxyAgent` always-on; `agent/package.json` + `pnpm-lock.yaml` in target artifacts list; §6.A records the decision.
5. **C-M3:** §3.6 step 2 specifies per-PID-per-counter temp filename.
6. **C-M4:** §3.2.A failure-kind enum excludes `nlm-auth-warn` with explicit prose carveout.
7. **C-M5:** §3.5.A taxonomy is restructured as Priority 1 (structured) → Priority 2 (regex); `billing_error` + `not_found_error` (model deprecated) present in Priority 1 table.
8. **C-m1:** §4.1 test 4 is the hung-binary timeout case.
9. **C-m2:** §3.5.E notification predicate is "previous<3 AND next>=3".
10. **C-m3:** §3.1.B success criterion is `res.ok && parseable JSON object`; empty `data` accepted.
11. **C-m4:** §7.B explicit companion-doc rollout artifacts (project CLAUDE.md §6 + dryrun_handoff.md + new memory file).

For any disposition where the fidelity check fails: emit a single line `FIDELITY-FAIL [ID] : <expected> vs <found>`. For clean fidelity: emit `FIDELITY-OK [ID]`. Do NOT introduce novel findings — those go in a separate S64 ticket.

The QA pass is approved as soon as all 11 IDs return FIDELITY-OK. Implementation can then begin under a separate MERGE-gate review on the actual code.

---

## 10. Decisions confirmed by human owner (pre-round-1)

The 5 open questions presented at v1 draft time are resolved as follows:

| # | Question | Decision | Where applied |
|---|---|---|---|
| A | Backoff cap = 60 min vs 4h | **60 min** — keeps responsive to manual fixes; 4h encourages "wait it out" complacency | §3.2.B (already 60-min cap) |
| B | Add `ANTHROPIC_API_KEY` to `checkEnv` required list | **No** — `checkAnthropicAuth` handles its own missing-env path with a more specific remediation | §3.1.B + §3.1.C |
| C | Manual `/preflight-reset` override mechanism | **No** — `Disable-ScheduledTask + Enable-ScheduledTask` is the operator escape hatch; YAGNI | §6.G |
| D | Resend email at N=3 backoff threshold | **Yes** — reuse existing notify.ts channel; one alert on 2→3 transition + one recovery email | §3.4 (NEW) |
| E | 5-tier (0/10/20/40/60) vs 3-tier (0/15/60) schedule | **5-tier** — marginal complexity over 3-tier; cleaner exponential pattern | §3.2.B (already 5-tier) |

These decisions are baked into the design above. Reviewers should treat them as locked-in inputs, NOT as additional open questions. If a reviewer wants to challenge a decision, frame it as a "MAJOR — REVISIT" finding with explicit reasoning.
