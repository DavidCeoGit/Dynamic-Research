/**
 * Unit suite pinning agent/lib/usage-tracking.ts — the S52 #4 Claude CLI usage
 * telemetry recorder. It pins (1) parseUsageSummary's THREE-path extraction
 * (whole-buffer array walk, single-object fallback, lastIndexOf brace-walk
 * recovery for truncated buffers) plus its job_status precedence rules
 * (finalJobStatus override > exit-derived base > parser 'no-summary' veto) and
 * its exact field mapping — critically that raw_json carries ONLY the result
 * event, never the full event array; and (2) recordUsage's best-effort insert
 * contract (maps the parsed row into research_usage, and NEVER throws on insert
 * error or insert-throw, returning { ok:false, reason } instead). These are the
 * load-bearing invariants the audit table depends on; the parser must never
 * throw into the caller's completion path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseUsageSummary, recordUsage } from "../lib/usage-tracking.js";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Fixtures ──────────────────────────────────────────────────────────────

/** A fully-populated result event matching the CLI's --verbose result shape. */
function resultEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    api_error_status: null,
    duration_ms: 12345,
    duration_api_ms: 9876,
    ttft_ms: 432,
    num_turns: 7,
    stop_reason: "end_turn",
    terminal_reason: "ok",
    total_cost_usd: 0.4231,
    usage: {
      input_tokens: 1000,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 50,
      output_tokens: 333,
    },
    modelUsage: {
      "claude-opus-4-8": {
        inputTokens: 1000,
        outputTokens: 333,
        costUSD: 0.4231,
      },
    },
    ...overrides,
  };
}

/** Captures the most recent row passed to .insert() for assertions. */
interface Captured {
  table: string | null;
  row: Record<string, unknown> | null;
}

function makeOkClient(captured: Captured): SupabaseClient {
  return {
    from(table: string) {
      captured.table = table;
      return {
        async insert(row: Record<string, unknown>) {
          captured.row = row;
          return { error: null };
        },
      };
    },
  } as unknown as SupabaseClient;
}

function makeErrorClient(captured: Captured, message: string): SupabaseClient {
  return {
    from(table: string) {
      captured.table = table;
      return {
        async insert(row: Record<string, unknown>) {
          captured.row = row;
          return { error: { message } };
        },
      };
    },
  } as unknown as SupabaseClient;
}

function makeThrowingClient(message: string): SupabaseClient {
  return {
    from(_table: string) {
      return {
        async insert(_row: Record<string, unknown>) {
          throw new Error(message);
        },
      };
    },
  } as unknown as SupabaseClient;
}

// ── parseUsageSummary: empty / whitespace buffer ───────────────────────────

test("parseUsageSummary: empty buffer yields no-summary regardless of finalJobStatus, preserving exit_code", () => {
  const row = parseUsageSummary("", 0, "complete");
  assert.equal(row.job_status, "no-summary");
  assert.equal(row.exit_code, 0);
  assert.equal(row.raw_json, null);
});

test("parseUsageSummary: whitespace-only buffer yields no-summary even with exit 1 and finalJobStatus killed", () => {
  const row = parseUsageSummary("   \n\t  \n", 1, "killed");
  assert.equal(row.job_status, "no-summary");
  assert.equal(row.exit_code, 1);
});

// ── parseUsageSummary: array shape, last result event ──────────────────────

test("parseUsageSummary: exit 0 array whose last result event carries usage maps to complete with full field mapping", () => {
  const arr = [
    { type: "system", subtype: "init" },
    { type: "assistant", text: "some long llm response" },
    resultEvent(),
  ];
  const buf = JSON.stringify(arr);
  const row = parseUsageSummary(buf, 0);

  assert.equal(row.job_status, "complete");
  assert.equal(row.exit_code, 0);
  assert.equal(row.is_error, false);
  assert.equal(row.api_error_status, null);
  assert.equal(row.stop_reason, "end_turn");
  assert.equal(row.terminal_reason, "ok");
  assert.equal(row.duration_ms, 12345);
  assert.equal(row.duration_api_ms, 9876);
  assert.equal(row.ttft_ms, 432);
  assert.equal(row.num_turns, 7);
  assert.equal(row.input_tokens, 1000);
  assert.equal(row.cache_creation_tokens, 200);
  assert.equal(row.cache_read_tokens, 50);
  assert.equal(row.output_tokens, 333);
  assert.equal(row.total_cost_usd, 0.4231);
  assert.deepEqual(row.model_usage, {
    "claude-opus-4-8": { inputTokens: 1000, outputTokens: 333, costUSD: 0.4231 },
  });

  // CRITICAL: raw_json is the RESULT EVENT object only, NOT the whole array.
  assert.ok(!Array.isArray(row.raw_json), "raw_json must not be the array");
  assert.equal((row.raw_json as { type?: string }).type, "result");
  assert.deepEqual(row.raw_json, resultEvent());
});

test("parseUsageSummary: array walks in reverse and selects the LAST result event", () => {
  const arr = [
    resultEvent({ num_turns: 1, stop_reason: "first" }),
    { type: "assistant", text: "between" },
    resultEvent({ num_turns: 99, stop_reason: "last" }),
  ];
  const row = parseUsageSummary(JSON.stringify(arr), 0);
  assert.equal(row.num_turns, 99);
  assert.equal(row.stop_reason, "last");
});

// ── parseUsageSummary: job_status precedence ───────────────────────────────

test("parseUsageSummary: exit 1 with valid result and no finalJobStatus yields failed (result spread does not change job_status)", () => {
  const buf = JSON.stringify([resultEvent()]);
  const row = parseUsageSummary(buf, 1);
  assert.equal(row.job_status, "failed");
  // Field mapping still happens despite failed status.
  assert.equal(row.input_tokens, 1000);
});

test("parseUsageSummary: finalJobStatus complete overrides exit 1 base", () => {
  const buf = JSON.stringify([resultEvent()]);
  const row = parseUsageSummary(buf, 1, "complete");
  assert.equal(row.job_status, "complete");
});

test("parseUsageSummary: finalJobStatus killed overrides exit 0 base", () => {
  const buf = JSON.stringify([resultEvent()]);
  const row = parseUsageSummary(buf, 0, "killed");
  assert.equal(row.job_status, "killed");
});

// ── parseUsageSummary: array with no result event ──────────────────────────

test("parseUsageSummary: array with no result event yields no-summary and raw_json is the full array", () => {
  const arr = [
    { type: "system", subtype: "init" },
    { type: "assistant", text: "hi" },
  ];
  const row = parseUsageSummary(JSON.stringify(arr), 0);
  assert.equal(row.job_status, "no-summary");
  assert.ok(Array.isArray(row.raw_json), "raw_json must be the full array here");
  assert.deepEqual(row.raw_json, arr);
});

// ── parseUsageSummary: single object shapes ────────────────────────────────

test("parseUsageSummary: single result object (no --verbose) maps and raw_json is that object", () => {
  const obj = resultEvent({ num_turns: 3 });
  const row = parseUsageSummary(JSON.stringify(obj), 0);
  assert.equal(row.job_status, "complete");
  assert.equal(row.num_turns, 3);
  assert.equal(row.input_tokens, 1000);
  assert.deepEqual(row.raw_json, obj);
});

test("parseUsageSummary: single object with non-result type yields no-summary and raw_json is the object", () => {
  const obj = { type: "system", subtype: "init", foo: "bar" };
  const row = parseUsageSummary(JSON.stringify(obj), 0);
  assert.equal(row.job_status, "no-summary");
  assert.deepEqual(row.raw_json, obj);
});

// ── parseUsageSummary: truncated-buffer recovery ───────────────────────────

test("parseUsageSummary: truncated buffer containing a balanced result marker recovers via brace-walk", () => {
  const result = resultEvent({ num_turns: 42 });
  // Simulate a head-truncated array: drop the leading "[{...prefix...}," so
  // whole-buffer JSON.parse fails, but a complete {"type":"result",...} object
  // survives in the tail.
  const buf = 'ng response"},' + JSON.stringify(result) + "]";
  const row = parseUsageSummary(buf, 0);

  assert.equal(row.job_status, "complete");
  assert.equal(row.num_turns, 42);
  assert.equal(row.input_tokens, 1000);
  // raw_json is the RECOVERED result object (not the parsedRaw wrapper).
  assert.deepEqual(row.raw_json, result);
  assert.equal((row.raw_json as { type?: string }).type, "result");
});

test("parseUsageSummary: recovery tolerates whitespace in the marker { \"type\" : \"result\" }", () => {
  const buf = 'garbage,{ "type" : "result" , "num_turns": 5, "total_cost_usd": 0.1 }]';
  const row = parseUsageSummary(buf, 0);
  assert.equal(row.job_status, "complete");
  assert.equal(row.num_turns, 5);
  assert.equal(row.total_cost_usd, 0.1);
});

test("parseUsageSummary: parse fails with no result marker yields no-summary with _parse_error and _stdout_tail", () => {
  const buf = "{ this is not valid json at all and has no marker ";
  const row = parseUsageSummary(buf, 0);
  assert.equal(row.job_status, "no-summary");
  const raw = row.raw_json as { _parse_error?: string; _stdout_tail?: string };
  assert.equal(typeof raw._parse_error, "string");
  assert.equal(typeof raw._stdout_tail, "string");
  assert.equal(raw._stdout_tail, buf.slice(-400));
});

test("parseUsageSummary: marker present but braces never close yields no-summary with _recovery_failed true", () => {
  // Open the result object but never close it (depth never returns to 0).
  const buf = 'junk,{"type":"result","usage":{"input_tokens":1';
  const row = parseUsageSummary(buf, 0);
  assert.equal(row.job_status, "no-summary");
  const raw = row.raw_json as { _recovery_failed?: boolean; _stdout_tail?: string };
  assert.equal(raw._recovery_failed, true);
  assert.equal(typeof raw._stdout_tail, "string");
});

test("parseUsageSummary: marker present, braces balance, but sliced text is invalid JSON yields _recovery_parse_error", () => {
  // Balanced braces but the inner content is not valid JSON (bare token).
  const buf = 'x,{"type":"result", bogus }]';
  const row = parseUsageSummary(buf, 0);
  assert.equal(row.job_status, "no-summary");
  const raw = row.raw_json as { _recovery_parse_error?: string };
  assert.equal(typeof raw._recovery_parse_error, "string");
});

// ── parseUsageSummary: sanity ranges (warn, never throw, row still returned) ─

test("parseUsageSummary: negative tokens still return the row with the negative value", () => {
  const obj = resultEvent({
    usage: {
      input_tokens: -5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1,
    },
  });
  const row = parseUsageSummary(JSON.stringify(obj), 0);
  assert.equal(row.job_status, "complete");
  assert.equal(row.input_tokens, -5);
});

test("parseUsageSummary: total_cost_usd over 1000 still returns the row with the value", () => {
  const obj = resultEvent({ total_cost_usd: 5000 });
  const row = parseUsageSummary(JSON.stringify(obj), 0);
  assert.equal(row.total_cost_usd, 5000);
  assert.equal(row.job_status, "complete");
});

test("parseUsageSummary: token field over 10M still returns the row with the value", () => {
  const obj = resultEvent({
    usage: {
      input_tokens: 50_000_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    },
  });
  const row = parseUsageSummary(JSON.stringify(obj), 0);
  assert.equal(row.input_tokens, 50_000_000);
  assert.equal(row.job_status, "complete");
});

// ── parseUsageSummary: missing usage object ────────────────────────────────

test("parseUsageSummary: missing usage object yields null token fields", () => {
  const obj = resultEvent({ usage: undefined });
  const row = parseUsageSummary(JSON.stringify(obj), 0);
  assert.equal(row.input_tokens, null);
  assert.equal(row.cache_creation_tokens, null);
  assert.equal(row.cache_read_tokens, null);
  assert.equal(row.output_tokens, null);
  // Non-usage fields still map.
  assert.equal(row.num_turns, 7);
});

// ── recordUsage: insert ok ──────────────────────────────────────────────────

test("recordUsage: successful insert returns ok true and maps every row field into research_usage", async () => {
  const captured: Captured = { table: null, row: null };
  const sb = makeOkClient(captured);
  const buf = JSON.stringify([resultEvent()]);

  const res = await recordUsage({
    sb,
    researchQueueId: "queue-123",
    organizationId: "org-456",
    stdoutBuf: buf,
    exitCode: 0,
  });

  assert.equal(res.ok, true);
  assert.ok(res.parsed);
  assert.equal(res.reason, undefined);

  assert.equal(captured.table, "research_usage");
  const row = captured.row as Record<string, unknown>;
  assert.equal(row.research_queue_id, "queue-123");
  assert.equal(row.organization_id, "org-456");
  assert.equal(row.job_status, "complete");
  assert.equal(row.exit_code, 0);
  assert.equal(row.input_tokens, 1000);
  assert.equal(row.cache_creation_tokens, 200);
  assert.equal(row.cache_read_tokens, 50);
  assert.equal(row.output_tokens, 333);
  assert.equal(row.total_cost_usd, 0.4231);
  assert.deepEqual(row.model_usage, {
    "claude-opus-4-8": { inputTokens: 1000, outputTokens: 333, costUSD: 0.4231 },
  });
  // raw_json on the inserted row is the result event only.
  assert.equal((row.raw_json as { type?: string }).type, "result");
  assert.ok(!Array.isArray(row.raw_json));
});

test("recordUsage: finalJobStatus is passed through to the parsed row", async () => {
  const captured: Captured = { table: null, row: null };
  const sb = makeOkClient(captured);
  const buf = JSON.stringify([resultEvent()]);

  const res = await recordUsage({
    sb,
    researchQueueId: "q",
    organizationId: "o",
    stdoutBuf: buf,
    exitCode: 1,
    finalJobStatus: "killed",
  });

  assert.equal(res.ok, true);
  assert.equal(res.parsed?.job_status, "killed");
  assert.equal((captured.row as Record<string, unknown>).job_status, "killed");
});

// ── recordUsage: insert returns error ───────────────────────────────────────

test("recordUsage: insert error returns ok false with reason and the parsed row", async () => {
  const captured: Captured = { table: null, row: null };
  const sb = makeErrorClient(captured, "duplicate key value violates unique constraint");
  const buf = JSON.stringify([resultEvent()]);

  const res = await recordUsage({
    sb,
    researchQueueId: "q",
    organizationId: "o",
    stdoutBuf: buf,
    exitCode: 0,
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "duplicate key value violates unique constraint");
  assert.ok(res.parsed);
  assert.equal(res.parsed?.job_status, "complete");
});

// ── recordUsage: insert throws ──────────────────────────────────────────────

test("recordUsage: insert that throws is caught — recordUsage returns ok false and does not throw", async () => {
  const sb = makeThrowingClient("connection reset by peer");
  const buf = JSON.stringify([resultEvent()]);

  const res = await recordUsage({
    sb,
    researchQueueId: "q",
    organizationId: "o",
    stdoutBuf: buf,
    exitCode: 0,
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "connection reset by peer");
  assert.ok(res.parsed);
  assert.equal(res.parsed?.job_status, "complete");
});
