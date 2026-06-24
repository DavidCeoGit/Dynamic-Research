/**
 * Unit tests for agent/api-client.ts — the typed HTTP client the worker uses
 * to talk to the Next.js queue API. These pin the wire contract each exported
 * helper produces against a captured `fetch`: the URL it hits, whether the
 * X-Agent-Key auth header is present (claim/update PATCH carry it; the GET
 * `getJob` deliberately does NOT), the exact JSON body shape (status/progress
 * constants for completeJob, the 2000-char failJob truncation, and the
 * undefined-vs-null-vs-omitted field discipline of updatePlanReviewStatus
 * including its 500-char plan_review_error truncation), and the not-ok /
 * 204 / no-body error paths of the shared ensureOk helper. Env is set before
 * a dynamic import because api-client.ts snapshots API_BASE_URL/AGENT_SECRET_KEY
 * at module load.
 */

process.env.AGENT_SECRET_KEY = "test-agent-key";
process.env.API_BASE_URL = "https://api.test.local";

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { ResearchJob } from "../types.js";

const {
  claimJob,
  getJob,
  updateJob,
  completeJob,
  failJob,
  updatePlanReviewStatus,
} = await import("../api-client.js");

const API_BASE = "https://api.test.local";

// ── fetch capture harness ───────────────────────────────────────────

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

const realFetch = globalThis.fetch;
let calls: CapturedCall[] = [];

/**
 * Build a minimal Response-shaped stub. `text` / `json` accept either a value
 * or a thunk (so a test can make text() reject to exercise the no-body path).
 */
function makeResponse(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  text?: string | (() => Promise<string>);
  json?: unknown | (() => Promise<unknown>);
}): Response {
  const status = opts.status ?? 200;
  const ok = opts.ok ?? (status >= 200 && status < 300);
  return {
    ok,
    status,
    statusText: opts.statusText ?? "",
    text: () =>
      typeof opts.text === "function"
        ? opts.text()
        : Promise.resolve(opts.text ?? ""),
    json: () =>
      typeof opts.json === "function"
        ? (opts.json as () => Promise<unknown>)()
        : Promise.resolve(opts.json),
  } as unknown as Response;
}

/** Install a fetch stub that records every call and returns `next`. */
function installFetch(next: () => Response): void {
  const stub = (input: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return Promise.resolve(next());
  };
  globalThis.fetch = stub as unknown as typeof fetch;
}

/** A canonical job fixture (only the fields the tests inspect matter). */
function sampleJob(): ResearchJob {
  return { id: "job-123", status: "running" } as unknown as ResearchJob;
}

/** Parse a captured request body (always a string for these helpers). */
function bodyOf(call: CapturedCall): unknown {
  const body = call.init?.body;
  return JSON.parse(typeof body === "string" ? body : String(body));
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── claimJob ────────────────────────────────────────────────────────

describe("claimJob", () => {
  test("204 No Content returns null without consulting the response body", async () => {
    installFetch(() =>
      makeResponse({
        status: 204,
        // If ensureOk or json() were consulted on 204 these would throw.
        text: () => Promise.reject(new Error("text() must not be called on 204")),
        json: () => Promise.reject(new Error("json() must not be called on 204")),
      }),
    );

    const result = await claimJob();
    assert.equal(result, null);

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, `${API_BASE}/api/queue/claim`);
    assert.equal(call.init?.method, "POST");
    const headers = call.init?.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers["X-Agent-Key"], "test-agent-key");
  });

  test("200 OK returns the parsed job", async () => {
    const job = sampleJob();
    installFetch(() => makeResponse({ status: 200, json: job }));

    const result = await claimJob();
    assert.deepEqual(result, job);
  });

  test("500 not-ok throws an error naming the context and status", async () => {
    installFetch(() =>
      makeResponse({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: "boom",
      }),
    );

    await assert.rejects(
      () => claimJob(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /claimJob/);
        assert.match(err.message, /500/);
        assert.match(err.message, /boom/);
        return true;
      },
    );
  });
});

// ── getJob ──────────────────────────────────────────────────────────

describe("getJob", () => {
  test("GETs the job URL with NO X-Agent-Key header (bare fetch)", async () => {
    const job = sampleJob();
    installFetch(() => makeResponse({ status: 200, json: job }));

    const result = await getJob("abc-1");
    assert.deepEqual(result, job);

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, `${API_BASE}/api/queue/abc-1`);
    // Bare fetch(url) — no init at all, hence no auth/method headers.
    assert.equal(call.init, undefined);
  });

  test("not-ok throws an error naming getJob(<id>)", async () => {
    installFetch(() =>
      makeResponse({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: "missing",
      }),
    );

    await assert.rejects(
      () => getJob("abc-1"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /getJob\(abc-1\)/);
        assert.match(err.message, /404/);
        return true;
      },
    );
  });
});

// ── updateJob ───────────────────────────────────────────────────────

describe("updateJob", () => {
  test("PATCHes with the auth header and a body that round-trips the update", async () => {
    const job = sampleJob();
    installFetch(() => makeResponse({ status: 200, json: job }));

    const update = {
      current_phase: "Phase 2",
      progress_pct: 42,
      status: "running" as const,
    };
    const result = await updateJob("id-9", update);
    assert.deepEqual(result, job);

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, `${API_BASE}/api/queue/id-9`);
    assert.equal(call.init?.method, "PATCH");
    const headers = call.init?.headers as Record<string, string>;
    assert.equal(headers["X-Agent-Key"], "test-agent-key");
    assert.equal(headers["Content-Type"], "application/json");
    // Body is exactly JSON.stringify(update).
    assert.equal(call.init?.body, JSON.stringify(update));
    assert.deepEqual(bodyOf(call), update);
  });
});

// ── completeJob ─────────────────────────────────────────────────────

describe("completeJob", () => {
  test("sends the fixed completed-state body with the supplied result slug", async () => {
    installFetch(() => makeResponse({ status: 200, json: sampleJob() }));

    await completeJob("id-7", "my-slug");

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, `${API_BASE}/api/queue/id-7`);
    assert.equal(call.init?.method, "PATCH");
    assert.deepEqual(bodyOf(call), {
      status: "completed",
      progress_pct: 100,
      current_phase: "Complete",
      phase_status: "All outputs delivered",
      result_slug: "my-slug",
    });
  });
});

// ── failJob ─────────────────────────────────────────────────────────

describe("failJob", () => {
  test("sends status failed with the error message verbatim when short", async () => {
    installFetch(() => makeResponse({ status: 200, json: sampleJob() }));

    await failJob("id-3", "kaboom");

    const body = bodyOf(calls[0]!) as { status: string; error_message: string };
    assert.equal(body.status, "failed");
    assert.equal(body.error_message, "kaboom");
  });

  test("truncates an over-2000-char error message to exactly 2000 chars", async () => {
    installFetch(() => makeResponse({ status: 200, json: sampleJob() }));

    const long = "x".repeat(2500);
    await failJob("id-3", long);

    const body = bodyOf(calls[0]!) as { status: string; error_message: string };
    assert.equal(body.status, "failed");
    assert.equal(body.error_message.length, 2000);
    assert.equal(body.error_message, "x".repeat(2000));
  });
});

// ── updatePlanReviewStatus ──────────────────────────────────────────

describe("updatePlanReviewStatus", () => {
  test("status only => body is exactly { plan_review_status }", async () => {
    installFetch(() => makeResponse({ status: 200, json: sampleJob() }));

    await updatePlanReviewStatus("id-1", "reviewing");

    assert.deepEqual(bodyOf(calls[0]!), { plan_review_status: "reviewing" });
  });

  test("numeric iterations + attempts set the plan_review_* numeric fields", async () => {
    installFetch(() => makeResponse({ status: 200, json: sampleJob() }));

    await updatePlanReviewStatus("id-1", "approved", {
      iterations: 3,
      attempts: 2,
    });

    assert.deepEqual(bodyOf(calls[0]!), {
      plan_review_status: "approved",
      plan_review_iterations: 3,
      plan_review_attempts: 2,
    });
  });

  test("next_attempt_at: null is carried through as an explicit null field", async () => {
    installFetch(() => makeResponse({ status: 200, json: sampleJob() }));

    await updatePlanReviewStatus("id-1", "system_blocked", {
      next_attempt_at: null,
    });

    const body = bodyOf(calls[0]!) as Record<string, unknown>;
    assert.ok("plan_review_next_attempt_at" in body);
    assert.equal(body.plan_review_next_attempt_at, null);
  });

  test("omitting next_attempt_at leaves the field absent from the body", async () => {
    installFetch(() => makeResponse({ status: 200, json: sampleJob() }));

    await updatePlanReviewStatus("id-1", "reviewing");

    const body = bodyOf(calls[0]!) as Record<string, unknown>;
    assert.equal("plan_review_next_attempt_at" in body, false);
  });

  test("error_message over 500 chars is truncated to exactly 500 in plan_review_error", async () => {
    installFetch(() => makeResponse({ status: 200, json: sampleJob() }));

    const long = "e".repeat(800);
    await updatePlanReviewStatus("id-1", "request_changes", {
      error_message: long,
    });

    const body = bodyOf(calls[0]!) as { plan_review_error: string };
    assert.equal(body.plan_review_error.length, 500);
    assert.equal(body.plan_review_error, "e".repeat(500));
  });

  test("error_message: null maps to plan_review_error null (not truncated)", async () => {
    installFetch(() => makeResponse({ status: 200, json: sampleJob() }));

    await updatePlanReviewStatus("id-1", "approved", { error_message: null });

    const body = bodyOf(calls[0]!) as Record<string, unknown>;
    assert.ok("plan_review_error" in body);
    assert.equal(body.plan_review_error, null);
  });

  test("omitting error_message leaves plan_review_error absent", async () => {
    installFetch(() => makeResponse({ status: 200, json: sampleJob() }));

    await updatePlanReviewStatus("id-1", "approved");

    const body = bodyOf(calls[0]!) as Record<string, unknown>;
    assert.equal("plan_review_error" in body, false);
  });

  test("plan_json: null is carried through as an explicit null field", async () => {
    installFetch(() => makeResponse({ status: 200, json: sampleJob() }));

    await updatePlanReviewStatus("id-1", "reviewing", { plan_json: null });

    const body = bodyOf(calls[0]!) as Record<string, unknown>;
    assert.ok("plan_json" in body);
    assert.equal(body.plan_json, null);
  });
});

// ── ensureOk no-body path ───────────────────────────────────────────

describe("ensureOk no-body path", () => {
  test("a not-ok response whose text() rejects throws with '(no body)'", async () => {
    installFetch(() =>
      makeResponse({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        text: () => Promise.reject(new Error("stream broke")),
      }),
    );

    await assert.rejects(
      () => getJob("z-9"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /\(no body\)/);
        assert.match(err.message, /502/);
        return true;
      },
    );
  });
});
