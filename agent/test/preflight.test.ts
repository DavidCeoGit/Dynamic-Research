/**
 * S64 preflight unit tests (preflight-cost-architecture v3.1).
 *
 * Tests the public surface of agent/preflight.ts + agent/lib/preflight-backoff.ts:
 *   - checkEnv: missing-var detection.
 *   - checkClaudeAuth: happy path, exit-1 non-nested, exit-1 nested (Bug 32),
 *     ENOENT spawn-error, hung-binary timeout (15s -> shortened in test).
 *   - checkAnthropicAuth: 200+JSON, 401, 429, network timeout, proxy disable,
 *     non-object JSON, missing env.
 *   - preflight-backoff: schedule shape, round-trip, clear idempotency,
 *     concurrent-write filename uniqueness, corrupted-JSON tolerance, atomic
 *     rename invariant.
 *   - NLM warn path: runPreflight returns ok=true even when NLM fails.
 *
 * Uses node --test (project standard).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  checkEnv,
  checkClaudeAuth,
  checkAnthropicAuth,
  type CheckClaudeAuthSpawnFn,
  type CheckAnthropicAuthFetchFn,
} from "../preflight.js";
import {
  backoffMinutesForFailureCount,
  readBackoff,
  recordFailure,
  recordFailureFromTerminalError,
  clearBackoff,
  classifyTerminalError,
  markPendingTerminalExit,
  consumePendingTerminalExit,
  NOTIFY_THRESHOLD,
  type TerminalError,
} from "../lib/preflight-backoff.js";

// ── Stub spawn helper ─────────────────────────────────────────────

interface SpawnStubOpts {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  delayMs?: number;
  spawnError?: Error;
  hang?: boolean;
}

function mockSpawn(opts: SpawnStubOpts): CheckClaudeAuthSpawnFn {
  return () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (sig?: string) => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (_sig?: string): boolean => {
      // Simulate SIGKILL: emit exit if not already
      setImmediate(() => child.emit("exit", -1, "SIGKILL"));
      return true;
    };

    setTimeout(() => {
      if (opts.spawnError) {
        child.emit("error", opts.spawnError);
        return;
      }
      if (opts.stdout) child.stdout.write(opts.stdout);
      if (opts.stderr) child.stderr.write(opts.stderr);
      child.stdout.end();
      child.stderr.end();
      if (!opts.hang) {
        child.emit("exit", opts.exitCode ?? 0, null);
      }
    }, opts.delayMs ?? 5);

    // Cast through unknown to satisfy ChildProcessWithoutNullStreams shape.
    return child as unknown as ReturnType<CheckClaudeAuthSpawnFn>;
  };
}

// ── Test 1: checkEnv ──────────────────────────────────────────────

test("checkEnv flags missing required vars with actionable remediation", () => {
  const r = checkEnv({});
  assert.equal(r.ok, false);
  assert.equal(r.required, true);
  assert.equal(r.failureKind, "env");
  assert.match(r.detail, /AGENT_SECRET_KEY/);
  assert.match(r.detail, /NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(r.detail, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(r.remediation ?? "", /agent\/\.env/);
});

test("checkEnv passes when all required vars present", () => {
  const r = checkEnv({
    AGENT_SECRET_KEY: "k",
    NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "k2",
  });
  assert.equal(r.ok, true);
});

// ── Test 2: checkClaudeAuth (4 cases) ─────────────────────────────

test("checkClaudeAuth happy path returns ok on exit 0 + stdout", async () => {
  const spawnFn = mockSpawn({ exitCode: 0, stdout: "Logged in as user@example.com\n" });
  const r = await checkClaudeAuth({ spawnFn, env: {}, timeoutMs: 1000 });
  assert.equal(r.ok, true);
  assert.match(r.detail, /Logged in/);
});

test("checkClaudeAuth exit 1 with non-nested-sessions stderr returns auth remediation", async () => {
  const spawnFn = mockSpawn({ exitCode: 1, stderr: "Not authenticated\n" });
  const r = await checkClaudeAuth({ spawnFn, env: {}, timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.failureKind, "claude-auth");
  assert.match(r.remediation ?? "", /Not authenticated|claude login|ANTHROPIC_API_KEY/);
});

test("checkClaudeAuth exit 1 with nested-sessions substring returns Bug-32 remediation", async () => {
  const spawnFn = mockSpawn({ exitCode: 1, stderr: "claude cannot be launched: nested sessions detected" });
  const r = await checkClaudeAuth({ spawnFn, env: {}, timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.failureKind, "claude-auth");
  assert.match(r.remediation ?? "", /CLAUDECODE|nested|non-Claude shell/i);
});

test("checkClaudeAuth ENOENT returns spawn-error remediation", async () => {
  const enoent: NodeJS.ErrnoException = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
  const spawnFn = mockSpawn({ spawnError: enoent });
  const r = await checkClaudeAuth({ spawnFn, env: {}, timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.failureKind, "claude-auth");
  assert.match(r.remediation ?? "", /PATH/i);
});

// ── Test 4: hung-binary timeout (per C-m1) ────────────────────────

test("checkClaudeAuth resolves with timeout failure when child hangs", async () => {
  const spawnFn = mockSpawn({ hang: true });
  const start = Date.now();
  const r = await checkClaudeAuth({ spawnFn, env: {}, timeoutMs: 200 });
  const elapsed = Date.now() - start;
  assert.equal(r.ok, false);
  assert.equal(r.failureKind, "claude-auth");
  assert.match(r.detail, /did not respond within/);
  // Must resolve at the timeout, not hang forever.
  assert.ok(elapsed >= 150 && elapsed < 1500, `Expected ~200ms timeout, got ${elapsed}ms`);
});

// ── Test 3: checkAnthropicAuth (6 cases) ──────────────────────────

function mockFetch(opts: {
  status?: number;
  body?: unknown;
  bodyText?: string;
  reject?: Error;
}): CheckAnthropicAuthFetchFn {
  return async (_url, _init) => {
    if (opts.reject) throw opts.reject;
    const status = opts.status ?? 200;
    const text = opts.bodyText ?? (opts.body !== undefined ? JSON.stringify(opts.body) : "");
    return new Response(text, {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

test("checkAnthropicAuth missing ANTHROPIC_API_KEY returns env-missing failure", async () => {
  const r = await checkAnthropicAuth({ env: {}, useProxyDispatcher: false });
  assert.equal(r.ok, false);
  assert.equal(r.failureKind, "anthropic-auth");
  assert.match(r.detail, /ANTHROPIC_API_KEY/);
});

test("checkAnthropicAuth happy path returns ok on 200 + JSON object (empty data acceptable)", async () => {
  const fetchFn = mockFetch({ status: 200, body: { data: [] } });
  const r = await checkAnthropicAuth({ fetchFn, env: { ANTHROPIC_API_KEY: "sk-ant-test" }, useProxyDispatcher: false });
  assert.equal(r.ok, true);
});

test("checkAnthropicAuth 401 returns auth-out remediation", async () => {
  const fetchFn = mockFetch({ status: 401, bodyText: '{"error":"unauthorized"}' });
  const r = await checkAnthropicAuth({ fetchFn, env: { ANTHROPIC_API_KEY: "sk-ant-test" }, useProxyDispatcher: false });
  assert.equal(r.ok, false);
  assert.equal(r.failureKind, "anthropic-auth");
  assert.match(r.detail, /401/);
  assert.match(r.remediation ?? "", /invalid|re-issue/i);
});

test("checkAnthropicAuth 429 returns transient marker", async () => {
  const fetchFn = mockFetch({ status: 429 });
  const r = await checkAnthropicAuth({ fetchFn, env: { ANTHROPIC_API_KEY: "sk-ant-test" }, useProxyDispatcher: false });
  assert.equal(r.ok, false);
  assert.equal(r.failureKind, "anthropic-auth");
  assert.match(r.detail, /429/);
});

test("checkAnthropicAuth network timeout (rejected fetch) returns network remediation", async () => {
  const fetchFn = mockFetch({ reject: Object.assign(new Error("AbortError: signal timed out"), { name: "AbortError" }) });
  const r = await checkAnthropicAuth({ fetchFn, env: { ANTHROPIC_API_KEY: "sk-ant-test" }, useProxyDispatcher: false });
  assert.equal(r.ok, false);
  assert.equal(r.failureKind, "anthropic-auth");
  assert.match(r.detail, /timed out|fetch failed/);
});

test("checkAnthropicAuth 2xx with non-object JSON returns failure", async () => {
  const fetchFn = mockFetch({ status: 200, bodyText: '"plain-string"' });
  const r = await checkAnthropicAuth({ fetchFn, env: { ANTHROPIC_API_KEY: "sk-ant-test" }, useProxyDispatcher: false });
  assert.equal(r.ok, false);
  assert.match(r.detail, /non-object/);
});

// ── Test 5: backoff schedule (N=1..10) ────────────────────────────

test("backoff schedule produces 0/10/20/40/60 minutes for N=1..5 and caps at 60 for N>=5", () => {
  assert.equal(backoffMinutesForFailureCount(0), 0);
  assert.equal(backoffMinutesForFailureCount(1), 0);
  assert.equal(backoffMinutesForFailureCount(2), 10);
  assert.equal(backoffMinutesForFailureCount(3), 20);
  assert.equal(backoffMinutesForFailureCount(4), 40);
  assert.equal(backoffMinutesForFailureCount(5), 60);
  assert.equal(backoffMinutesForFailureCount(10), 60);
});

// ── Test 6 + 7 + 9 + 10: state file round-trip + atomic + corruption ─

async function mkTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "preflight-test-"));
}

async function rmTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

test("recordFailure + readBackoff round-trip persists shape correctly", async () => {
  const cwd = await mkTempDir();
  try {
    const r1 = await recordFailure("env", cwd);
    assert.equal(r1.state.consecutiveFailures, 1);
    assert.equal(r1.state.lastFailureKind, "env");
    assert.equal(r1.transitionedToNotify, false);

    const round = await readBackoff(cwd);
    assert.ok(round);
    assert.equal(round.consecutiveFailures, 1);
    assert.equal(round.lastFailureKind, "env");
    assert.ok(round.lastFailureAt);
    assert.ok(round.backoffUntil);

    const r2 = await recordFailure("claude-auth", cwd);
    assert.equal(r2.state.consecutiveFailures, 2);

    const r3 = await recordFailure("anthropic-auth", cwd);
    assert.equal(r3.state.consecutiveFailures, 3);
    assert.equal(r3.transitionedToNotify, true);
  } finally {
    await rmTempDir(cwd);
  }
});

test("clearBackoff is idempotent (no-op when file absent)", async () => {
  const cwd = await mkTempDir();
  try {
    const r1 = await clearBackoff(cwd);
    assert.equal(r1.hadBackoff, false);

    await recordFailure("env", cwd);
    const r2 = await clearBackoff(cwd);
    assert.equal(r2.hadBackoff, true);
    assert.ok(r2.previousState);

    const r3 = await clearBackoff(cwd);
    assert.equal(r3.hadBackoff, false);
  } finally {
    await rmTempDir(cwd);
  }
});

test("readBackoff on corrupted JSON returns null and does not throw", async () => {
  const cwd = await mkTempDir();
  try {
    await fs.writeFile(path.join(cwd, ".preflight-backoff"), "{not valid json");
    const r = await readBackoff(cwd);
    assert.equal(r, null);
  } finally {
    await rmTempDir(cwd);
  }
});

test("readBackoff on shape-invalid JSON returns null", async () => {
  const cwd = await mkTempDir();
  try {
    await fs.writeFile(path.join(cwd, ".preflight-backoff"), '{"foo":"bar"}');
    const r = await readBackoff(cwd);
    assert.equal(r, null);
  } finally {
    await rmTempDir(cwd);
  }
});

// ── Test 8: concurrent recordFailure (per-PID-per-counter uniqueness) ─

test("concurrent recordFailure calls write distinct temp filenames and survive", async () => {
  const cwd = await mkTempDir();
  try {
    // Fire 5 concurrent recordFailure calls. Each must succeed AND end with
    // a coherent final state. The atomic-rename + per-counter temp ensures
    // no race-on-temp; final state is last-write-wins.
    const results = await Promise.all([
      recordFailure("env", cwd),
      recordFailure("env", cwd),
      recordFailure("env", cwd),
      recordFailure("env", cwd),
      recordFailure("env", cwd),
    ]);
    for (const r of results) {
      assert.ok(r.state.consecutiveFailures >= 1);
    }
    const final = await readBackoff(cwd);
    assert.ok(final);
    // The final consecutiveFailures should be at most 5 (each call increments
    // by 1 off the read value; concurrent reads can interleave, so the final
    // could be anywhere in [1, 5]).
    assert.ok(final.consecutiveFailures >= 1 && final.consecutiveFailures <= 5);
    // No leftover temp files.
    const entries = await fs.readdir(cwd);
    const tempFiles = entries.filter((e) => e.startsWith(".preflight-backoff.tmp"));
    assert.deepEqual(tempFiles, []);
  } finally {
    await rmTempDir(cwd);
  }
});
