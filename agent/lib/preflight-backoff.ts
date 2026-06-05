/**
 * Preflight circuit breaker — file-backed state for the worker daemon.
 *
 * Implements Tier C of the preflight cost + failure-loop architecture
 * (Documentation/preflight-cost-architecture-design-gate.md v3.1).
 *
 * State file `.preflight-backoff` next to `.worker.pid`. Lifecycle:
 *   - Closed:    no file. Preflight runs normally on each worker start.
 *   - Open:      file present + backoffUntil > now. Worker exits 0 cheaply.
 *   - Half-Open: file present + backoffUntil <= now. First worker after the
 *                window runs preflight; success clears the file, failure
 *                records a longer backoff.
 *
 * Schedule (consecutive failures -> backoff minutes from lastFailureAt):
 *   1 -> 0    2 -> 10    3 -> 20    4 -> 40    5+ -> 60 (cap)
 *
 * Also hosts the terminal-error classifier called from three execution-side
 * catch sites (executor.ts: claude-spawn + planSynthesis, plan-reviewer.ts:
 * runIntegration). The classifier is SIDE-EFFECT-FREE (per C-C1) — it
 * returns null or a TerminalError but does NOT touch fs, exit, or backoff
 * state. Catch sites call markPendingTerminalExit() after classification;
 * worker.ts consumes the flag after executeJob() completes (preserves the
 * existing finally block + telemetry write).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

// ── Schedule + thresholds ───────────────────────────────────────────

const BACKOFF_SCHEDULE_MINUTES: Record<number, number> = {
  1: 0,
  2: 10,
  3: 20,
  4: 40,
};
const BACKOFF_CAP_MINUTES = 60;
/** Failure count at which Resend notification fires (transition predicate). */
export const NOTIFY_THRESHOLD = 3;

// ── State file location ─────────────────────────────────────────────

const STATE_FILE_NAME = ".preflight-backoff";

function stateFilePath(cwd: string = process.cwd()): string {
  return path.join(cwd, STATE_FILE_NAME);
}

// ── Public types ────────────────────────────────────────────────────

export type PreflightFailureKind = "env" | "claude-auth" | "anthropic-auth";

export type TerminalErrorKind =
  | "credit-out"
  | "auth-out"
  | "billing-error"
  | "model-not-found";

export type FailureKind = PreflightFailureKind | TerminalErrorKind;

export interface BackoffState {
  consecutiveFailures: number;
  lastFailureAt: string;
  backoffUntil: string;
  lastFailureKind: FailureKind;
}

export interface TerminalError {
  kind: TerminalErrorKind;
  /** Human-readable signature, e.g. "structured:billing_error" | "regex:credit-balance-low". */
  signature: string;
  /** Call-site identifier set by the caller, e.g. "executor:claude-spawn". */
  source: string;
}

export interface ClassifyTerminalErrorInput {
  err: unknown;
  stdoutTail?: string;
  stderrTail?: string;
  stateFailureReason?: string;
}

// ── State read/write ────────────────────────────────────────────────

export async function readBackoff(cwd?: string): Promise<BackoffState | null> {
  try {
    const raw = await fs.readFile(stateFilePath(cwd), "utf-8");
    const parsed = JSON.parse(raw) as Partial<BackoffState>;
    if (
      typeof parsed.consecutiveFailures === "number" &&
      typeof parsed.lastFailureAt === "string" &&
      typeof parsed.backoffUntil === "string" &&
      typeof parsed.lastFailureKind === "string"
    ) {
      return parsed as BackoffState;
    }
    console.warn(
      `[preflight-backoff] state file shape invalid; treating as no backoff`,
    );
    return null;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    if (err instanceof SyntaxError) {
      console.warn(
        `[preflight-backoff] state file JSON.parse failed; treating as no backoff (${err.message})`,
      );
      return null;
    }
    console.warn(
      `[preflight-backoff] state file read failed; treating as no backoff (${(err as Error).message})`,
    );
    return null;
  }
}

/**
 * Atomic-write contract (G-m3 + C-M3):
 *   1. Build state object
 *   2. Write to per-PID-per-monotonic-counter temp filename
 *   3. fs.rename to canonical path (atomic on NTFS within same volume)
 *
 * The per-PID-per-counter temp name prevents same-process concurrent writes
 * from colliding (e.g. if Phase 0a + Phase 0b both throw on the same outage,
 * recordFailureFromTerminalError can be called twice before the worker exits).
 *
 * Windows quirk: fs.rename uses MoveFileEx(REPLACE_EXISTING). When two
 * concurrent renames target the same destination, the second can EPERM/EBUSY
 * if the destination file handle is briefly held. Retry-with-jitter handles
 * this transparently; failures are last-write-wins which is the intended
 * semantic for the pending-exit-flag pattern (worker exits on the latest
 * terminal-error kind seen).
 */
let _tempCounter = 0;

async function renameWithRetry(src: string, dest: string): Promise<void> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (err) {
      lastErr = err;
      const e = err as NodeJS.ErrnoException;
      // Only retry on Windows transient-lock signatures.
      if (e.code !== "EPERM" && e.code !== "EBUSY" && e.code !== "EACCES") {
        throw err;
      }
      // Backoff before next attempt only — skip sleep after the last try
      // (S64 Codex MERGE-gate D1). Total wait: 10+30+50+70 = 160ms across
      // attempts 0..3; attempt 4 is final.
      if (attempt < 4) {
        await new Promise<void>((r) => setTimeout(r, 10 + attempt * 20));
      }
    }
  }
  // Clean up the orphan temp file before re-throwing the final error.
  await fs.unlink(src).catch(() => undefined);
  throw lastErr;
}

async function atomicWrite(state: BackoffState, cwd?: string): Promise<void> {
  const dir = cwd ?? process.cwd();
  const counter = ++_tempCounter;
  const tempPath = path.join(
    dir,
    `${STATE_FILE_NAME}.tmp.${process.pid}.${counter}`,
  );
  const finalPath = stateFilePath(dir);
  await fs.writeFile(tempPath, JSON.stringify(state, null, 2));
  await renameWithRetry(tempPath, finalPath);
}

function computeBackoffWindowMs(consecutiveFailures: number): number {
  const minutes =
    BACKOFF_SCHEDULE_MINUTES[consecutiveFailures] ?? BACKOFF_CAP_MINUTES;
  return minutes * 60 * 1000;
}

/** Exported for tests. */
export function backoffMinutesForFailureCount(n: number): number {
  if (n <= 0) return 0;
  return BACKOFF_SCHEDULE_MINUTES[n] ?? BACKOFF_CAP_MINUTES;
}

export interface RecordFailureResult {
  state: BackoffState;
  /** True iff this write crossed previous<NOTIFY_THRESHOLD -> next>=NOTIFY_THRESHOLD. */
  transitionedToNotify: boolean;
}

export async function recordFailure(
  kind: PreflightFailureKind,
  cwd?: string,
): Promise<RecordFailureResult> {
  const existing = await readBackoff(cwd);
  const previousFailures = existing?.consecutiveFailures ?? 0;
  const consecutiveFailures = previousFailures + 1;
  const now = new Date();
  const backoffMs = computeBackoffWindowMs(consecutiveFailures);
  const state: BackoffState = {
    consecutiveFailures,
    lastFailureAt: now.toISOString(),
    backoffUntil: new Date(now.getTime() + backoffMs).toISOString(),
    lastFailureKind: kind,
  };
  await atomicWrite(state, cwd);
  return {
    state,
    transitionedToNotify:
      previousFailures < NOTIFY_THRESHOLD &&
      consecutiveFailures >= NOTIFY_THRESHOLD,
  };
}

/**
 * Per design §3.5.E: a terminal-classified error mid-execution is
 * high-confidence — skip the 0-min "transient blip" tier. Jump straight
 * to NOTIFY_THRESHOLD (= 20-min backoff) on the first occurrence, or
 * escalate naturally if already at or above threshold.
 *
 *   previous=0,1,2 -> next=3 (20 min)
 *   previous=3     -> next=4 (40 min)
 *   previous=4     -> next=5 (60 min cap)
 *   previous=5+    -> next=previous+1 (60 min cap)
 *
 * The notification predicate (previous<3 AND next>=3) still fires
 * cleanly on the jump from 0/1/2 -> 3 per C-m2.
 */
export async function recordFailureFromTerminalError(
  err: TerminalError,
  cwd?: string,
): Promise<RecordFailureResult> {
  const existing = await readBackoff(cwd);
  const previousFailures = existing?.consecutiveFailures ?? 0;
  const consecutiveFailures = Math.max(NOTIFY_THRESHOLD, previousFailures + 1);
  const now = new Date();
  const backoffMs = computeBackoffWindowMs(consecutiveFailures);
  const state: BackoffState = {
    consecutiveFailures,
    lastFailureAt: now.toISOString(),
    backoffUntil: new Date(now.getTime() + backoffMs).toISOString(),
    lastFailureKind: err.kind,
  };
  await atomicWrite(state, cwd);
  return {
    state,
    transitionedToNotify:
      previousFailures < NOTIFY_THRESHOLD &&
      consecutiveFailures >= NOTIFY_THRESHOLD,
  };
}

export interface ClearBackoffResult {
  hadBackoff: boolean;
  previousState: BackoffState | null;
}

export async function clearBackoff(cwd?: string): Promise<ClearBackoffResult> {
  const existing = await readBackoff(cwd);
  try {
    await fs.unlink(stateFilePath(cwd));
    return { hadBackoff: existing !== null, previousState: existing };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return { hadBackoff: false, previousState: null };
    }
    console.warn(
      `[preflight-backoff] clearBackoff unlink failed (non-fatal): ${(err as Error).message}`,
    );
    return { hadBackoff: false, previousState: existing };
  }
}

// ── Pending exit flag (executor catch sites -> worker.ts) ──────────

let _pendingTerminalExit: TerminalError | null = null;

export function markPendingTerminalExit(t: TerminalError): void {
  _pendingTerminalExit = t;
}

export function consumePendingTerminalExit(): TerminalError | null {
  const v = _pendingTerminalExit;
  _pendingTerminalExit = null;
  return v;
}

// ── Terminal error classifier (side-effect-free; pure function) ────

interface ApiErrorShape {
  status?: number;
  /** Flat type set by @anthropic-ai/sdk APIError constructor. */
  type?: string;
  /**
   * Response body. Anthropic SDK puts the API JSON body here; the body itself
   * carries `{ error: { type, message } }` so we look at both `.error.type`
   * (Google/OpenAI flat) and `.error.error.type` (Anthropic nested) below.
   */
  error?: {
    type?: string;
    message?: string;
    error?: { type?: string; message?: string };
  };
  message?: string;
}

const REGEX_TAXONOMY: Array<{
  pattern: RegExp;
  kind: TerminalErrorKind;
  signature: string;
}> = [
  { pattern: /credit balance is too low/i, kind: "credit-out", signature: "regex:credit-balance-low" },
  { pattern: /invalid.{0,5}(api.?)?key/i, kind: "auth-out", signature: "regex:invalid-key" },
  { pattern: /authentication.?error/i, kind: "auth-out", signature: "regex:authentication-error" },
  { pattern: /HTTP 401|status 401/i, kind: "auth-out", signature: "regex:http-401" },
  { pattern: /HTTP 403|status 403|permission.?error/i, kind: "auth-out", signature: "regex:http-403" },
];

/**
 * Classify an arbitrary thrown value as a terminal provider error, or null
 * for "continue polling" semantics.
 *
 * Priority 1 — structured SDK fields (@anthropic-ai/sdk, @google/genai,
 * openai all emit APIError-shaped objects with .status + .error.type).
 * Priority 2 — regex over enriched evidence (stdout/stderr/err.message/
 * stateFailureReason). Catches `claude -p` spawn failures where the cause
 * text lives in the spawn buffer, not a structured field.
 *
 * Explicitly NON-terminal (returns null): HTTP 429, 5xx, network timeouts,
 * EAI_AGAIN, content policy refusals, single-job context overflow.
 *
 * Return shape: { kind, signature } without source — the CALLER sets
 * source when building the TerminalError to pass to markPendingTerminalExit.
 */
export function classifyTerminalError(
  input: ClassifyTerminalErrorInput,
): Pick<TerminalError, "kind" | "signature"> | null {
  const err = input.err;

  // Priority 1: structured SDK fields.
  // S64 Codex MERGE-gate B1: @anthropic-ai/sdk@0.99.0 stores the flat type on
  // err.type and the response body on err.error. The nested error.error.type
  // pattern is the JSON the API actually returns. Check all three positions
  // so the classifier catches both Anthropic, Google genai, and openai shapes:
  //   Anthropic: { type: "...", error: { error: { type, message } } }
  //   Google:    { error: { type, message } }            (flat-ish)
  //   OpenAI:    { error: { type, code, message } }
  if (err && typeof err === "object") {
    const e = err as ApiErrorShape;
    // Priority order (per S64 Codex MERGE-gate B1 + post-fix verification):
    //   1. e.type — Anthropic SDK APIError flat field (most reliable when set)
    //   2. e.error.error.type — Anthropic response-body deeply-nested
    //      (preferred over e.error.type, which on Anthropic is the wrapper
    //      discriminator literal "error", not the real type)
    //   3. e.error.type — Google genai / openai flat body shape
    const errorType = e.type ?? e.error?.error?.type ?? e.error?.type;
    const errorMessage =
      e.error?.error?.message ?? e.error?.message ?? "";
    const status = e.status;

    if (errorType === "billing_error") {
      return { kind: "billing-error", signature: "structured:billing_error" };
    }
    if (errorType === "authentication_error") {
      return { kind: "auth-out", signature: "structured:authentication_error" };
    }
    if (errorType === "permission_error") {
      return { kind: "auth-out", signature: "structured:permission_error" };
    }
    if (errorType === "not_found_error" && /model/i.test(errorMessage)) {
      return { kind: "model-not-found", signature: "structured:not_found_error" };
    }
    if (status === 401) {
      return { kind: "auth-out", signature: "structured:status-401" };
    }
    if (status === 403) {
      return { kind: "auth-out", signature: "structured:status-403" };
    }
  }

  // Priority 2: regex over enriched evidence.
  const errMsg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : err && typeof err === "object" && "message" in err
          ? String((err as { message?: unknown }).message ?? "")
          : "";
  const haystack = [
    input.stdoutTail ?? "",
    input.stderrTail ?? "",
    errMsg,
    input.stateFailureReason ?? "",
  ].join("\n");

  if (haystack) {
    for (const entry of REGEX_TAXONOMY) {
      if (entry.pattern.test(haystack)) {
        return { kind: entry.kind, signature: entry.signature };
      }
    }
  }

  return null;
}

// ── Remediation hint by kind (used by notify + log) ────────────────

export function remediationForKind(kind: FailureKind): string {
  switch (kind) {
    case "env":
      return "Populate missing env vars in agent/.env (see agent/.env.example).";
    case "claude-auth":
      return "Run `claude auth status` from your shell. If unauthed, run `claude login` or set ANTHROPIC_API_KEY.";
    case "anthropic-auth":
      return "Verify ANTHROPIC_API_KEY is set and valid. Test with: curl -H \"x-api-key: $ANTHROPIC_API_KEY\" -H \"anthropic-version: 2023-06-01\" https://api.anthropic.com/v1/models";
    case "credit-out":
      return "Top up Anthropic credit balance at https://console.anthropic.com/.";
    case "auth-out":
      return "API key invalid, revoked, or scope-restricted. Re-issue at https://console.anthropic.com/.";
    case "billing-error":
      return "Account-level billing problem. Check https://console.anthropic.com/billing.";
    case "model-not-found":
      return "Configured model deprecated/disabled. Update model id in agent/.env or transports.";
  }
}
