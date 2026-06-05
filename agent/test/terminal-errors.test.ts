/**
 * S64 terminal-error classifier + circuit-breaker unit tests
 * (preflight-cost-architecture v3.1, §3.5).
 *
 * Covers:
 *   - classifyTerminalError priority 1: structured SDK fields (billing_error,
 *     authentication_error, permission_error, not_found_error+model, 401, 403).
 *   - classifyTerminalError priority 2: regex over stdout/stderr/err.message
 *     (credit-balance-low, invalid-key, authentication-error, 401, 403).
 *   - classifyTerminalError non-terminal: HTTP 429, 5xx, network timeouts,
 *     content-policy errors, EAI_AGAIN, unmatched generic errors.
 *   - classifyTerminalError shape tolerance: string, null, undefined, plain
 *     object, Error subclass.
 *   - markPendingTerminalExit + consumePendingTerminalExit round-trip.
 *   - recordFailureFromTerminalError jumps consecutiveFailures to NOTIFY_THRESHOLD.
 *   - recordFailureFromTerminalError notify predicate: previous<3 -> next>=3 fires;
 *     previous>=3 -> next>=3 does NOT fire.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  classifyTerminalError,
  markPendingTerminalExit,
  consumePendingTerminalExit,
  recordFailure,
  recordFailureFromTerminalError,
  clearBackoff,
  NOTIFY_THRESHOLD,
  type TerminalError,
} from "../lib/preflight-backoff.js";

async function mkTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "preflight-term-"));
}

async function rmTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

// Drain the pending-exit flag between tests (module-level state).
function drainPending(): void {
  consumePendingTerminalExit();
}

// ── Test 1: structured SDK fields ─────────────────────────────────

test("classifyTerminalError priority-1: billing_error -> billing-error", () => {
  drainPending();
  const r = classifyTerminalError({ err: { error: { type: "billing_error" } } });
  assert.deepEqual(r, { kind: "billing-error", signature: "structured:billing_error" });
});

test("classifyTerminalError priority-1: authentication_error -> auth-out", () => {
  const r = classifyTerminalError({ err: { error: { type: "authentication_error" } } });
  assert.deepEqual(r, { kind: "auth-out", signature: "structured:authentication_error" });
});

test("classifyTerminalError priority-1: permission_error -> auth-out", () => {
  const r = classifyTerminalError({ err: { error: { type: "permission_error" } } });
  assert.deepEqual(r, { kind: "auth-out", signature: "structured:permission_error" });
});

test("classifyTerminalError priority-1: not_found_error+model -> model-not-found", () => {
  const r = classifyTerminalError({
    err: { error: { type: "not_found_error", message: "model claude-x.y.z not found" } },
  });
  assert.deepEqual(r, { kind: "model-not-found", signature: "structured:not_found_error" });
});

test("classifyTerminalError priority-1: not_found_error WITHOUT model in msg returns null", () => {
  const r = classifyTerminalError({
    err: { error: { type: "not_found_error", message: "resource not found" } },
  });
  // Not enough evidence to classify as terminal — continue polling.
  assert.equal(r, null);
});

// ── S64 Codex MERGE-gate B1: Anthropic SDK shape fidelity ────────

test("classifyTerminalError handles @anthropic-ai/sdk APIError flat .type field", () => {
  // Anthropic SDK 0.99.0 (agent/node_modules/@anthropic-ai/sdk/src/core/error.ts:23)
  // sets the type FLAT on the error instance, with response body on err.error.
  // Shape: { status: 401, type: "authentication_error", error: <body>, message: "..." }
  const r = classifyTerminalError({
    err: { status: 401, type: "authentication_error", error: { /* body */ }, message: "Invalid API key" },
  });
  // Either structured:authentication_error (flat type) OR structured:status-401 acceptable.
  assert.ok(r);
  assert.equal(r.kind, "auth-out");
  assert.match(r.signature, /authentication_error|status-401/);
});

test("classifyTerminalError handles deeply-nested Anthropic body shape", () => {
  // Real Anthropic 400-credit-low payload (per SDK generate() logic, line 72):
  // err.error is the response body, body is `{ error: { type, message } }`.
  // So error.error.type is the deep-nested path the SDK's own `generate` reads from.
  const r = classifyTerminalError({
    err: {
      status: 400,
      error: { type: "error", error: { type: "billing_error", message: "Credit balance is too low" } },
    },
  });
  assert.ok(r);
  assert.equal(r.kind, "billing-error");
  assert.equal(r.signature, "structured:billing_error");
});

test("classifyTerminalError handles deeply-nested Anthropic not_found_error+model", () => {
  const r = classifyTerminalError({
    err: {
      status: 404,
      error: { type: "error", error: { type: "not_found_error", message: "model claude-x.y.z not available" } },
    },
  });
  assert.ok(r);
  assert.equal(r.kind, "model-not-found");
});

// ── Test 2: status-only signatures ────────────────────────────────

test("classifyTerminalError priority-1: status 401 -> auth-out", () => {
  const r = classifyTerminalError({ err: { status: 401 } });
  assert.deepEqual(r, { kind: "auth-out", signature: "structured:status-401" });
});

test("classifyTerminalError priority-1: status 403 -> auth-out", () => {
  const r = classifyTerminalError({ err: { status: 403 } });
  assert.deepEqual(r, { kind: "auth-out", signature: "structured:status-403" });
});

// ── Test 3: regex signatures over stdout/stderr/err.message ──────

test("classifyTerminalError priority-2 regex: credit-balance-low message", () => {
  const r = classifyTerminalError({
    err: new Error("API call failed: Credit balance is too low. Please add credit."),
  });
  assert.deepEqual(r, { kind: "credit-out", signature: "regex:credit-balance-low" });
});

test("classifyTerminalError priority-2 regex: credit-balance-low in stdoutTail", () => {
  const r = classifyTerminalError({
    err: new Error("Generic spawn failure"),
    stdoutTail: "...some output...credit balance is too low...",
  });
  assert.deepEqual(r, { kind: "credit-out", signature: "regex:credit-balance-low" });
});

test("classifyTerminalError priority-2 regex: invalid API key in stderr", () => {
  const r = classifyTerminalError({
    err: new Error("Spawn exited 1"),
    stderrTail: "Error: Invalid API key provided",
  });
  assert.deepEqual(r, { kind: "auth-out", signature: "regex:invalid-key" });
});

test("classifyTerminalError priority-2 regex: HTTP 401 in stateFailureReason", () => {
  const r = classifyTerminalError({
    err: new Error("..."),
    stateFailureReason: "Provider returned HTTP 401 Unauthorized",
  });
  assert.deepEqual(r, { kind: "auth-out", signature: "regex:http-401" });
});

// ── Test 4: non-terminal classifications return null ─────────────

test("classifyTerminalError returns null for 429, 5xx, network errors, content policy", () => {
  // 429 (no structured type, no matching regex)
  assert.equal(classifyTerminalError({ err: { status: 429, message: "Rate limited" } }), null);
  // 5xx
  assert.equal(classifyTerminalError({ err: { status: 503, message: "Service unavailable" } }), null);
  assert.equal(classifyTerminalError({ err: new Error("HTTP 500 Internal Server Error") }), null);
  // Network
  assert.equal(classifyTerminalError({ err: Object.assign(new Error("getaddrinfo EAI_AGAIN api.anthropic.com"), { code: "EAI_AGAIN" }) }), null);
  assert.equal(classifyTerminalError({ err: new Error("AbortError: signal timed out after 30000ms") }), null);
  // Content policy
  assert.equal(classifyTerminalError({ err: new Error("content_policy_violation: prompt refused") }), null);
  // Generic unmatched
  assert.equal(classifyTerminalError({ err: new Error("something else went wrong") }), null);
  // Empty input
  assert.equal(classifyTerminalError({ err: null }), null);
});

// ── Test 5: shape tolerance ──────────────────────────────────────

test("classifyTerminalError handles string, null, undefined, plain object, Error subclass without throwing", () => {
  assert.doesNotThrow(() => classifyTerminalError({ err: "raw string error" }));
  assert.doesNotThrow(() => classifyTerminalError({ err: null }));
  assert.doesNotThrow(() => classifyTerminalError({ err: undefined }));
  assert.doesNotThrow(() => classifyTerminalError({ err: {} }));
  class CustomError extends Error {}
  assert.doesNotThrow(() => classifyTerminalError({ err: new CustomError("subclass") }));

  // Strings with terminal markers DO classify via priority 2 regex.
  const r = classifyTerminalError({ err: "credit balance is too low again" });
  assert.deepEqual(r, { kind: "credit-out", signature: "regex:credit-balance-low" });
});

// ── Test 6: markPendingTerminalExit + consume round-trip ─────────

test("markPendingTerminalExit + consumePendingTerminalExit round-trip", () => {
  drainPending();
  assert.equal(consumePendingTerminalExit(), null);

  const t: TerminalError = { kind: "credit-out", signature: "test", source: "test-site" };
  markPendingTerminalExit(t);
  const consumed = consumePendingTerminalExit();
  assert.deepEqual(consumed, t);
  // Second consume returns null (already consumed).
  assert.equal(consumePendingTerminalExit(), null);
});

test("markPendingTerminalExit overwrites prior flag (last-write-wins)", () => {
  drainPending();
  markPendingTerminalExit({ kind: "auth-out", signature: "first", source: "a" });
  markPendingTerminalExit({ kind: "credit-out", signature: "second", source: "b" });
  const consumed = consumePendingTerminalExit();
  assert.equal(consumed?.kind, "credit-out");
  assert.equal(consumed?.signature, "second");
});

// ── Test 7: recordFailureFromTerminalError jumps to N=3 ──────────

test("recordFailureFromTerminalError from N=0 jumps to NOTIFY_THRESHOLD (3)", async () => {
  const cwd = await mkTempDir();
  try {
    const r = await recordFailureFromTerminalError(
      { kind: "credit-out", signature: "s", source: "src" },
      cwd,
    );
    assert.equal(r.state.consecutiveFailures, NOTIFY_THRESHOLD);
    assert.equal(r.state.lastFailureKind, "credit-out");
    assert.equal(r.transitionedToNotify, true);
  } finally {
    await rmTempDir(cwd);
  }
});

test("recordFailureFromTerminalError from N=1 jumps to N=3 (skips 0-min tier)", async () => {
  const cwd = await mkTempDir();
  try {
    await recordFailure("env", cwd); // N=1
    const r = await recordFailureFromTerminalError(
      { kind: "auth-out", signature: "s", source: "src" },
      cwd,
    );
    assert.equal(r.state.consecutiveFailures, NOTIFY_THRESHOLD);
    assert.equal(r.transitionedToNotify, true);
  } finally {
    await rmTempDir(cwd);
  }
});

test("recordFailureFromTerminalError escalates beyond 3 if already at threshold", async () => {
  const cwd = await mkTempDir();
  try {
    await recordFailure("env", cwd); // 1
    await recordFailure("env", cwd); // 2
    await recordFailure("env", cwd); // 3 (notify fires)
    const r = await recordFailureFromTerminalError(
      { kind: "credit-out", signature: "s", source: "src" },
      cwd,
    );
    // Already at 3, should escalate to 4 (40-min tier).
    assert.equal(r.state.consecutiveFailures, 4);
    // Notify predicate: previous=3 was NOT < threshold(3), so no fire.
    assert.equal(r.transitionedToNotify, false);
  } finally {
    await rmTempDir(cwd);
  }
});

// ── Test 8: notify predicate (previous<3 AND next>=3) ────────────

test("notify predicate fires ONCE on first crossing of N=3", async () => {
  const cwd = await mkTempDir();
  try {
    let firedCount = 0;
    const tick = async () => {
      const r = await recordFailure("env", cwd);
      if (r.transitionedToNotify) firedCount++;
    };
    await tick(); // 1
    await tick(); // 2
    await tick(); // 3 — fires
    await tick(); // 4 — no re-fire
    await tick(); // 5 — no re-fire
    assert.equal(firedCount, 1);
  } finally {
    await rmTempDir(cwd);
  }
});

test("notify predicate fires on clear-then-rebreach cycle", async () => {
  const cwd = await mkTempDir();
  try {
    let firedCount = 0;
    const tick = async () => {
      const r = await recordFailure("env", cwd);
      if (r.transitionedToNotify) firedCount++;
    };
    await tick(); // 1
    await tick(); // 2
    await tick(); // 3 — fires (1)
    await clearBackoff(cwd);
    await tick(); // 1
    await tick(); // 2
    await tick(); // 3 — fires (2)
    assert.equal(firedCount, 2);
  } finally {
    await rmTempDir(cwd);
  }
});
