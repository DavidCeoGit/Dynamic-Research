/**
 * Worker daemon pre-flight checks.
 *
 * Runs once at worker startup before the polling loop begins. Fails with
 * actionable remediation if any check fails, so the operator can fix the
 * issue before the worker claims a job and wastes a slot on a run that
 * can never succeed.
 *
 * v3.1 (S64, MERGE-gate of preflight-cost-architecture-design-gate.md):
 *   - Replaces billable `claude -p hello` (~$0.24/restart) with
 *     `claude auth status` ($0) + GET /v1/models ($0) via EnvHttpProxyAgent.
 *   - Returns PreflightOutcome instead of process.exit(1)-ing directly;
 *     worker.ts advances the file-backed circuit breaker via
 *     advancePreflightCircuit() and decides whether to exit.
 *   - NLM warn path explicitly bypasses recordFailure() per design §3.2.A
 *     (NLM warnings DO NOT advance backoff; only required-check failures do).
 *
 * Exit semantics: orchestrator (worker.ts) exits 1 on hard fail with backoff
 * advanced; otherwise begins polling. NLM warn-only never exits or advances.
 */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crossSpawn from "cross-spawn";
import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import {
  recordFailure,
  clearBackoff,
  NOTIFY_THRESHOLD,
  remediationForKind,
  type PreflightFailureKind,
  type BackoffState,
} from "./lib/preflight-backoff.js";
import { sendPreflightBackoffEmail, sendPreflightRecoveryEmail } from "./lib/notify.js";

interface CheckResult {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
  remediation?: string;
  /** Set when ok=false to wire the failure into the circuit breaker. */
  failureKind?: PreflightFailureKind;
}

// ── 1. Env sanity ───────────────────────────────────────────────────

export function checkEnv(env: NodeJS.ProcessEnv = process.env): CheckResult {
  const missing: string[] = [];
  if (!env.AGENT_SECRET_KEY) missing.push("AGENT_SECRET_KEY");
  if (!env.NEXT_PUBLIC_SUPABASE_URL) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");

  if (missing.length > 0) {
    return {
      name: "env-sanity",
      ok: false,
      required: true,
      detail: `Missing required env vars: ${missing.join(", ")}`,
      remediation: "Populate agent/.env from agent/.env.example",
      failureKind: "env",
    };
  }

  if (process.platform === "win32") {
    const ghostPathRe = /^\/[a-zA-Z]\//;
    const workingDir = env.WORKING_DIR ?? "";
    const projectsDir = env.PROJECTS_DIR ?? "";
    if (ghostPathRe.test(workingDir) || ghostPathRe.test(projectsDir)) {
      return {
        name: "env-sanity",
        ok: false,
        required: true,
        detail: `Windows-style path required but got MSYS-style: WORKING_DIR=${workingDir} PROJECTS_DIR=${projectsDir}`,
        remediation: "Change /c/tmp/... to C:/tmp/... in agent/.env (drive-letter, not MSYS mount)",
        failureKind: "env",
      };
    }
  }

  return { name: "env-sanity", ok: true, required: true, detail: "all required env vars present" };
}

// ── 2. Claude auth state ────────────────────────────────────────────

/**
 * Injectable spawn for testability. Production wires `crossSpawn` directly.
 * Mocked tests pass a fake that returns a stub ChildProcess controlling
 * exit code + stdout/stderr + error event timing.
 */
export type CheckClaudeAuthSpawnFn = (
  cmd: string,
  args: string[],
  opts: { stdio: ["ignore", "pipe", "pipe"]; env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

export interface CheckClaudeAuthDeps {
  spawnFn?: CheckClaudeAuthSpawnFn;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * v3.1 (Codex C-M1): use `claude auth status` not `claude --version`.
 * --version only prints a banner and does NOT initialize the auth state
 * machine; auth status DOES initialize it, exercising the same nested-
 * session error path (Bug 32) that the previous billable `claude -p`
 * check covered. Same cost ($0, local), strictly better coverage.
 */
export function checkClaudeAuth(deps: CheckClaudeAuthDeps = {}): Promise<CheckResult> {
  const spawnFn = deps.spawnFn ?? (crossSpawn as unknown as CheckClaudeAuthSpawnFn);
  const procEnv = deps.env ?? process.env;
  const timeoutMs = deps.timeoutMs ?? 15_000;

  return new Promise((resolve) => {
    const childEnv = { ...procEnv } as NodeJS.ProcessEnv;
    delete childEnv.CLAUDECODE;
    delete childEnv.CLAUDE_CODE_SSE_PORT;
    delete childEnv.CLAUDE_CODE_SESSION_ID;

    const child = spawnFn("claude", ["auth", "status"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    let settled = false;
    const settle = (r: CheckResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      settle({
        name: "claude-auth",
        ok: false,
        required: true,
        detail: `claude auth status did not respond within ${Math.round(timeoutMs / 1000)}s`,
        remediation: "Check `claude auth status` from your shell. If it hangs, reinstall Claude Code.",
        failureKind: "claude-auth",
      });
    }, timeoutMs);

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const combined = stderr + "\n" + stdout;
        const nested = /nested sessions/i.test(combined);
        settle({
          name: "claude-auth",
          ok: false,
          required: true,
          detail: `claude auth status exited code=${code}. stdout=${stdout.slice(0, 200)} stderr=${stderr.slice(0, 200)}`,
          remediation: nested
            ? "CLAUDECODE env var is inherited from a parent Claude session — preflight stripped it but the auth state machine still hit it. Re-run worker from a non-Claude shell."
            : "Not authenticated. Run `claude login` from your shell OR set ANTHROPIC_API_KEY in agent/.env.",
          failureKind: "claude-auth",
        });
        return;
      }
      settle({
        name: "claude-auth",
        ok: true,
        required: true,
        detail: `claude auth status OK (${stdout.trim().slice(0, 80)})`,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      settle({
        name: "claude-auth",
        ok: false,
        required: true,
        detail: `claude spawn error: ${err.message}`,
        remediation: "Is `claude` on PATH? Run `where claude` (Windows) or `which claude` (POSIX) to verify.",
        failureKind: "claude-auth",
      });
    });
  });
}

// ── 3. Anthropic API auth ───────────────────────────────────────────

/**
 * Injectable fetch for testability. Tests pass a stub returning Response
 * objects directly. Production uses Node 22 built-in fetch + undici
 * EnvHttpProxyAgent.
 */
export type CheckAnthropicAuthFetchFn = (
  url: string,
  init: RequestInit & { dispatcher?: Dispatcher },
) => Promise<Response>;

export interface CheckAnthropicAuthDeps {
  fetchFn?: CheckAnthropicAuthFetchFn;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Default true. Tests can disable to skip EnvHttpProxyAgent construction. */
  useProxyDispatcher?: boolean;
}

/**
 * v3.1 (per C-M2 + C-m3): GET https://api.anthropic.com/v1/models with
 * x-api-key + anthropic-version headers. The models-list endpoint is not
 * billed; verifies the key is present + authenticatable but NOT credit
 * balance (that signal is reserved for the execution-side classifier).
 *
 * Success criterion (per C-m3): res.ok (HTTP 2xx) AND JSON parses to a
 * non-null object. Empty `data: []` is acceptable — we are verifying auth,
 * not model presence.
 *
 * Proxy handling: undici.EnvHttpProxyAgent reads HTTP_PROXY/HTTPS_PROXY/
 * NO_PROXY natively and no-ops when env absent. Always-on dispatcher.
 * Wrapped in try/catch — on construction failure, falls back to default fetch
 * with a logged warning (acceptable degradation: false-negative under proxy).
 */
export async function checkAnthropicAuth(deps: CheckAnthropicAuthDeps = {}): Promise<CheckResult> {
  const fetchFn = deps.fetchFn ?? (undiciFetch as unknown as CheckAnthropicAuthFetchFn);
  const procEnv = deps.env ?? process.env;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const useProxy = deps.useProxyDispatcher ?? true;

  const apiKey = procEnv.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      name: "anthropic-auth",
      ok: false,
      required: true,
      detail: "ANTHROPIC_API_KEY env var not set",
      remediation: "Add ANTHROPIC_API_KEY=sk-ant-... to agent/.env (or rely on `claude` OAuth subscription if your install supports it).",
      failureKind: "anthropic-auth",
    };
  }

  let dispatcher: Dispatcher | undefined;
  if (useProxy) {
    try {
      dispatcher = new EnvHttpProxyAgent();
    } catch (err) {
      console.warn(`[preflight] EnvHttpProxyAgent construction failed; falling back to default fetch: ${(err as Error).message}`);
      dispatcher = undefined;
    }
  }

  const init: RequestInit & { dispatcher?: Dispatcher } = {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (dispatcher) init.dispatcher = dispatcher;

  let res: Response;
  try {
    res = await fetchFn("https://api.anthropic.com/v1/models", init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const aborted = msg.toLowerCase().includes("abort") || msg.toLowerCase().includes("timeout");
    return {
      name: "anthropic-auth",
      ok: false,
      required: true,
      detail: aborted
        ? `Anthropic API request timed out after ${Math.round(timeoutMs / 1000)}s: ${msg}`
        : `Anthropic API fetch failed: ${msg}`,
      remediation: aborted
        ? "Network slow or firewall blocking. Check DNS + outbound HTTPS to api.anthropic.com."
        : "Network error contacting Anthropic API. Check connectivity + HTTPS_PROXY config.",
      failureKind: "anthropic-auth",
    };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401) {
      return {
        name: "anthropic-auth",
        ok: false,
        required: true,
        detail: `Anthropic API returned 401 Unauthorized. body=${body.slice(0, 200)}`,
        remediation: "ANTHROPIC_API_KEY is invalid. Re-issue at https://console.anthropic.com/.",
        failureKind: "anthropic-auth",
      };
    }
    if (res.status === 403) {
      return {
        name: "anthropic-auth",
        ok: false,
        required: true,
        detail: `Anthropic API returned 403 Forbidden. body=${body.slice(0, 200)}`,
        remediation: "Key revoked or scope-restricted. Re-issue at https://console.anthropic.com/.",
        failureKind: "anthropic-auth",
      };
    }
    if (res.status === 429) {
      return {
        name: "anthropic-auth",
        ok: false,
        required: true,
        detail: `Anthropic API returned 429 Rate Limited. Transient.`,
        remediation: "Backing off — next cron tick will retry.",
        failureKind: "anthropic-auth",
      };
    }
    return {
      name: "anthropic-auth",
      ok: false,
      required: true,
      detail: `Anthropic API returned HTTP ${res.status}. body=${body.slice(0, 200)}`,
      remediation: "Transient upstream issue or network firewall. Check https://status.anthropic.com.",
      failureKind: "anthropic-auth",
    };
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    return {
      name: "anthropic-auth",
      ok: false,
      required: true,
      detail: `Anthropic API returned 2xx but body was not parseable JSON: ${(err as Error).message}`,
      remediation: "Transient upstream contract drift; treating as failure. Will retry next cron tick.",
      failureKind: "anthropic-auth",
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return {
      name: "anthropic-auth",
      ok: false,
      required: true,
      detail: "Anthropic API returned non-object JSON response",
      remediation: "Transient upstream contract drift; treating as failure.",
      failureKind: "anthropic-auth",
    };
  }
  return {
    name: "anthropic-auth",
    ok: true,
    required: true,
    detail: "anthropic /v1/models reachable + key valid",
  };
}

// ── 4. NotebookLM auth (warn-only, NEVER advances backoff) ─────────

function checkNotebookLMAuth(): Promise<CheckResult> {
  return new Promise((resolve) => {
    const nlmBin = process.env.NOTEBOOKLM_BIN
      ?? (process.platform === "win32"
        ? `${process.env.USERPROFILE}\\.notebooklm-venv\\Scripts\\notebooklm.exe`
        : `${process.env.HOME}/.notebooklm-venv/bin/notebooklm`);

    const child = nodeSpawn(nlmBin, ["list", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        name: "nlm-auth",
        ok: false,
        required: false,
        detail: "notebooklm list did not respond within 30s",
        remediation: "Run `notebooklm list` manually to check. If it hangs, re-run `notebooklm login`.",
      });
    }, 30_000);

    child.on("exit", (code) => {
      clearTimeout(timeout);
      const combined = stdout + "\n" + stderr;
      const authBroken = /not logged in|login|auth|unauthorized|session expired/i.test(combined);
      if (code !== 0 || authBroken) {
        resolve({
          name: "nlm-auth",
          ok: false,
          required: false,
          detail: `nlm auth check failed (code=${code}): ${combined.slice(0, 200)}`,
          remediation: "Open PowerShell, run `~/.notebooklm-venv/Scripts/Activate.ps1` then `notebooklm login`, complete the browser flow.",
        });
        return;
      }
      resolve({ name: "nlm-auth", ok: true, required: false, detail: "notebooklm session valid" });
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        name: "nlm-auth",
        ok: false,
        required: false,
        detail: `nlm spawn error: ${err.message}`,
        remediation: "notebooklm CLI not found — is the venv at ~/.notebooklm-venv? Skipping as non-required.",
      });
    });
  });
}

// ── Orchestrator ────────────────────────────────────────────────────

export interface PreflightOutcome {
  ok: boolean;
  failureKind?: PreflightFailureKind;
  /** Set on failure for use in notification body. */
  detail?: string;
  remediation?: string;
}

/**
 * v3.1: returns PreflightOutcome instead of process.exit(1)-ing directly.
 * Caller (worker.ts) calls advancePreflightCircuit() to advance the
 * circuit-breaker state + fire notification, then decides on exit.
 *
 * Logs include the `backoff-action` grep-friendly lines per design §3.3.
 */
export async function runPreflight(): Promise<PreflightOutcome> {
  const log = (msg: string): void => {
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
    console.log(`[${ts}] [preflight] ${msg}`);
  };

  log("backoff-action: running-checks");
  log("Starting pre-flight checks...");

  const results: CheckResult[] = [];

  results.push(checkEnv());
  if (!results[0].ok) {
    emit(results, log);
    return {
      ok: false,
      failureKind: results[0].failureKind,
      detail: results[0].detail,
      remediation: results[0].remediation,
    };
  }

  results.push(await checkClaudeAuth());
  if (!results[1].ok && results[1].required) {
    emit(results, log);
    return {
      ok: false,
      failureKind: results[1].failureKind,
      detail: results[1].detail,
      remediation: results[1].remediation,
    };
  }

  results.push(await checkAnthropicAuth());
  if (!results[2].ok && results[2].required) {
    emit(results, log);
    return {
      ok: false,
      failureKind: results[2].failureKind,
      detail: results[2].detail,
      remediation: results[2].remediation,
    };
  }

  results.push(await checkNotebookLMAuth());

  emit(results, log);

  const hardFail = results.some((r) => !r.ok && r.required);
  if (hardFail) {
    const failed = results.find((r) => !r.ok && r.required);
    return {
      ok: false,
      failureKind: failed?.failureKind,
      detail: failed?.detail,
      remediation: failed?.remediation,
    };
  }

  log("All required checks passed — worker will begin polling.");
  return { ok: true };
}

function emit(results: CheckResult[], log: (m: string) => void): void {
  for (const r of results) {
    const mark = r.ok ? "✓" : r.required ? "✗" : "⚠";
    log(`${mark} ${r.name}: ${r.detail}`);
    if (!r.ok && r.remediation) {
      log(`   → remediation: ${r.remediation}`);
    }
  }
}

// ── State-advance orchestrator ──────────────────────────────────────

export interface AdvancePreflightCircuitResult {
  shouldExit: boolean;
  transitionedToNotify: boolean;
  failureKind?: PreflightFailureKind;
}

/**
 * Worker.ts wraps runPreflight() then this. Centralizes the
 * circuit-breaker advance + notification glue.
 *
 * On success: clears any prior backoff state + fires recovery email if
 * outage was in progress.
 * On failure: records the failure (advances consecutiveFailures) +
 * fires backoff email iff this write crossed N=3 (NOTIFY_THRESHOLD) per
 * design §3.4.
 *
 * Notification calls are best-effort (notify.ts swallows fetch errors).
 */
export async function advancePreflightCircuit(
  outcome: PreflightOutcome,
): Promise<AdvancePreflightCircuitResult> {
  if (outcome.ok) {
    const cleared = await clearBackoff();
    if (cleared.hadBackoff && cleared.previousState) {
      const previous: BackoffState = cleared.previousState;
      const now = new Date();
      const lastFailure = new Date(previous.lastFailureAt);
      const durationMin = Math.max(0, Math.round((now.getTime() - lastFailure.getTime()) / 60000));
      console.log(
        `[preflight] backoff-action: recovered (after ${previous.consecutiveFailures} consecutive failures, outage ~${durationMin} min)`,
      );
      await sendPreflightRecoveryEmail({
        consecutiveFailures: previous.consecutiveFailures,
        lastFailureKind: previous.lastFailureKind,
        outageDurationMin: durationMin,
      }).catch((err) => {
        console.warn(`[preflight] recovery email send threw (non-fatal): ${(err as Error).message}`);
      });
    }
    return { shouldExit: false, transitionedToNotify: false };
  }

  const failureKind = outcome.failureKind ?? "env";
  const { state, transitionedToNotify } = await recordFailure(failureKind);
  console.log(
    `[preflight] backoff-state: failures=${state.consecutiveFailures} until=${state.backoffUntil} kind=${state.lastFailureKind}`,
  );
  if (transitionedToNotify) {
    console.log(
      `[preflight] backoff-state: crossed N=${NOTIFY_THRESHOLD} threshold — notification will fire`,
    );
    await sendPreflightBackoffEmail({
      origin: "preflight",
      kind: failureKind,
      consecutiveFailures: state.consecutiveFailures,
      backoffUntil: state.backoffUntil,
      detail: outcome.detail ?? "",
      remediation: outcome.remediation ?? remediationForKind(failureKind),
    }).catch((err) => {
      console.warn(`[preflight] backoff email send threw (non-fatal): ${(err as Error).message}`);
    });
  }
  return { shouldExit: true, transitionedToNotify, failureKind };
}
