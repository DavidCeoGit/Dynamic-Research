/**
 * Unit suite for agent/lib/notify.ts — the Resend-backed email notifier fired
 * on job terminal-state transitions and preflight/studio-recovery operator
 * alerts. It pins the contract that matters operationally: env is read at CALL
 * time (so a missing RESEND_API_KEY / PREFLIGHT_NOTIFY_EMAIL short-circuits the
 * POST), every helper swallows HTTP non-2xx AND a rejecting fetch without ever
 * throwing (a notification failure must never break a research run), and the
 * outbound POST is shaped correctly — Resend endpoint, Bearer auth, JSON body,
 * the per-status subject map, subject newline/whitespace collapse + 97+"..."
 * truncation, HTML escaping of the topic, and the from/to/recipient routing.
 * All assertions are against the module's REAL behavior (e.g. JSON.stringify
 * leaves the literal `<script>` in body.text — only body.html is escaped).
 */

import { test, beforeEach, afterEach, describe } from "node:test";
import assert from "node:assert/strict";

import {
  sendCompletionEmail,
  sendDeliveryDelayedEmail,
  sendPlanReviewEmail,
  sendPreflightBackoffEmail,
  sendPreflightRecoveryEmail,
  sendStudioRecoveryExhaustedEmail,
} from "../lib/notify.js";

const RESEND_API = "https://api.resend.com/emails";
const DEFAULT_FROM = "Dynamic Research <onboarding@resend.dev>";

// Save the three env vars notify.ts reads at call time.
const ORIG_API_KEY = process.env.RESEND_API_KEY;
const ORIG_FROM = process.env.RESEND_FROM_EMAIL;
const ORIG_NOTIFY = process.env.PREFLIGHT_NOTIFY_EMAIL;

const realFetch = globalThis.fetch;

type Capture = { url: string; init: RequestInit }[];

/** Install a fetch stub that records calls and resolves an ok Response. */
function installFetch(opts?: {
  ok?: boolean;
  status?: number;
  text?: string;
  reject?: boolean;
}): Capture {
  const calls: Capture = [];
  const stub = (async (url: unknown, init?: unknown): Promise<Response> => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    if (opts?.reject) {
      throw new Error("network down");
    }
    const res = {
      ok: opts?.ok ?? true,
      status: opts?.status ?? 200,
      text: async () => opts?.text ?? "",
      json: async () => ({ id: "re_test_123" }),
    };
    return res as unknown as Response;
  }) as typeof fetch;
  globalThis.fetch = stub;
  return calls;
}

/** Parse the JSON body of the first captured POST. */
function parseBody(calls: Capture): Record<string, unknown> {
  assert.ok(calls.length >= 1, "expected at least one fetch call");
  const raw = calls[0]!.init.body;
  assert.equal(typeof raw, "string", "body must be a JSON string");
  return JSON.parse(raw as string) as Record<string, unknown>;
}

beforeEach(() => {
  // Start each test from a clean env baseline.
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
  delete process.env.PREFLIGHT_NOTIFY_EMAIL;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (ORIG_API_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIG_API_KEY;
  if (ORIG_FROM === undefined) delete process.env.RESEND_FROM_EMAIL;
  else process.env.RESEND_FROM_EMAIL = ORIG_FROM;
  if (ORIG_NOTIFY === undefined) delete process.env.PREFLIGHT_NOTIFY_EMAIL;
  else process.env.PREFLIGHT_NOTIFY_EMAIL = ORIG_NOTIFY;
});

describe("sendCompletionEmail", () => {
  test("with RESEND_API_KEY deleted, does not call fetch and resolves without throwing", async () => {
    const calls = installFetch();
    await sendCompletionEmail({
      to: "user@example.com",
      slug: "my-slug",
      topic: "A topic",
      status: "completed",
    });
    assert.equal(calls.length, 0, "fetch must not be called without an API key");
  });

  test("with a key (completed), POSTs once to Resend with Bearer auth, JSON content-type, default from, ready subject, and non-empty body", async () => {
    process.env.RESEND_API_KEY = "re_live_key";
    const calls = installFetch();
    await sendCompletionEmail({
      to: "user@example.com",
      slug: "my-slug",
      topic: "Quantum widgets",
      status: "completed",
    });
    assert.equal(calls.length, 1, "exactly one POST");
    assert.equal(calls[0]!.url, RESEND_API);
    assert.equal(calls[0]!.init.method, "POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer re_live_key");
    assert.equal(headers["Content-Type"], "application/json");

    const body = parseBody(calls);
    assert.equal(body.to, "user@example.com");
    assert.equal(body.from, DEFAULT_FROM);
    assert.ok(
      typeof body.subject === "string" &&
        body.subject.startsWith("Your Dynamic Research run is ready:"),
      "subject must start with the ready prefix",
    );
    assert.ok(typeof body.text === "string" && body.text.length > 0);
    assert.ok(typeof body.html === "string" && body.html.length > 0);
  });

  test("with RESEND_FROM_EMAIL set, body.from uses it", async () => {
    process.env.RESEND_API_KEY = "re_live_key";
    process.env.RESEND_FROM_EMAIL = "Custom <noreply@my-domain.com>";
    const calls = installFetch();
    await sendCompletionEmail({
      to: "user@example.com",
      slug: "s",
      topic: "T",
      status: "completed",
    });
    const body = parseBody(calls);
    assert.equal(body.from, "Custom <noreply@my-domain.com>");
  });

  test("subject sanitation: newlines + space-runs collapse and the subject contains no newline", async () => {
    process.env.RESEND_API_KEY = "re_live_key";
    const calls = installFetch();
    await sendCompletionEmail({
      to: "user@example.com",
      slug: "s",
      topic: "Line one\n\nLine    two\twith   spaces",
      status: "completed",
    });
    const body = parseBody(calls);
    const subject = body.subject as string;
    assert.ok(!subject.includes("\n"), "subject must not contain a newline");
    assert.ok(
      subject.includes("Line one Line two with spaces"),
      `whitespace must collapse to single spaces; got: ${subject}`,
    );
  });

  test("subject truncation: a >100-char topic is sliced to 97 chars + '...'", async () => {
    process.env.RESEND_API_KEY = "re_live_key";
    const calls = installFetch();
    const longTopic = "x".repeat(150); // single-token, no whitespace
    await sendCompletionEmail({
      to: "user@example.com",
      slug: "s",
      topic: longTopic,
      status: "completed",
    });
    const body = parseBody(calls);
    const subject = body.subject as string;
    const topicPortion = subject.replace("Your Dynamic Research run is ready: ", "");
    assert.equal(topicPortion.length, 100, "97 chars + '...' === 100");
    assert.ok(topicPortion.endsWith("..."));
    assert.equal(topicPortion.slice(0, 97), "x".repeat(97));
  });

  test("HTML escaping: a <script> topic is escaped in body.html and the literal tag is absent", async () => {
    process.env.RESEND_API_KEY = "re_live_key";
    const calls = installFetch();
    await sendCompletionEmail({
      to: "user@example.com",
      slug: "s",
      topic: "<script>alert(1)</script>",
      status: "completed",
    });
    const body = parseBody(calls);
    const html = body.html as string;
    assert.ok(html.includes("&lt;script&gt;"), "html must escape the script tag");
    assert.ok(!html.includes("<script>"), "raw <script> must not appear in html");
    // Plaintext body is allowed to carry the raw topic — that is correct.
    const text = body.text as string;
    assert.ok(text.includes("<script>"), "plaintext body carries the raw topic");
  });

  test("status 'failed': error subject + escaped error snippet (sliced to 500) in html", async () => {
    process.env.RESEND_API_KEY = "re_live_key";
    const calls = installFetch();
    const longError = "<b>" + "E".repeat(600);
    await sendCompletionEmail({
      to: "user@example.com",
      slug: "s",
      topic: "T",
      status: "failed",
      errorMessage: longError,
    });
    const body = parseBody(calls);
    const subject = body.subject as string;
    assert.ok(subject.startsWith("Your Dynamic Research run hit an error:"));
    const html = body.html as string;
    assert.ok(html.includes("&lt;b&gt;"), "error angle-brackets escaped in html");
    // 500-char slice: "<b>" (3) + 497 E's. The 498th E onward must be dropped.
    assert.ok(html.includes("E".repeat(497)), "snippet keeps up to the 500-char cap");
    assert.ok(!html.includes("E".repeat(498)), "snippet is capped at 500 chars");
  });

  test("reservations: a non-empty reservations[] on a completed email adds 'Advisory notes (' to text and html", async () => {
    process.env.RESEND_API_KEY = "re_live_key";
    const calls = installFetch();
    await sendCompletionEmail({
      to: "user@example.com",
      slug: "s",
      topic: "T",
      status: "completed",
      reservations: [
        { severity: "MINOR", origin: "gemini", message: "consider X" },
        { severity: "MAJOR", origin: "codex", message: "consider Y" },
      ],
    });
    const body = parseBody(calls);
    assert.ok((body.text as string).includes("Advisory notes ("));
    assert.ok((body.html as string).includes("Advisory notes ("));
  });

  test("non-2xx Resend response does not throw and fetch was still called", async () => {
    process.env.RESEND_API_KEY = "re_live_key";
    const calls = installFetch({ ok: false, status: 422, text: "bad" });
    await sendCompletionEmail({
      to: "user@example.com",
      slug: "s",
      topic: "T",
      status: "completed",
    });
    assert.equal(calls.length, 1, "fetch was attempted");
  });

  test("a rejecting fetch is swallowed (no throw)", async () => {
    process.env.RESEND_API_KEY = "re_live_key";
    installFetch({ reject: true });
    await sendCompletionEmail({
      to: "user@example.com",
      slug: "s",
      topic: "T",
      status: "completed",
    });
    // Reaching here without an exception is the assertion.
    assert.ok(true);
  });
});

describe("sendDeliveryDelayedEmail", () => {
  test("with a key, subject starts 'is finalizing:' and carries no failure/error wording", async () => {
    process.env.RESEND_API_KEY = "re_live_key";
    const calls = installFetch();
    await sendDeliveryDelayedEmail({
      to: "user@example.com",
      slug: "s",
      topic: "T",
    });
    const body = parseBody(calls);
    const subject = (body.subject as string).toLowerCase();
    assert.ok(
      (body.subject as string).startsWith("Your Dynamic Research run is finalizing:"),
    );
    assert.ok(!subject.includes("failed"), "subject must not say 'failed'");
    assert.ok(!subject.includes("error"), "subject must not say 'error'");
  });

  test("without a key, does not call fetch", async () => {
    const calls = installFetch();
    await sendDeliveryDelayedEmail({ to: "u@e.com", slug: "s", topic: "T" });
    assert.equal(calls.length, 0);
  });
});

describe("sendPlanReviewEmail", () => {
  test("with to:null, short-circuits before the key check and does not call fetch", async () => {
    process.env.RESEND_API_KEY = "re_live_key";
    const calls = installFetch();
    await sendPlanReviewEmail({
      to: null,
      slug: "s",
      topic: "T",
      status: "BLOCKED",
      user_message: "nope",
      findings: [],
    });
    assert.equal(calls.length, 0, "null recipient must short-circuit");
  });

  test("per-status subjects: REQUEST_CHANGES / BLOCKED / SYSTEM_BLOCKED map correctly", async () => {
    process.env.RESEND_API_KEY = "re_live_key";
    const cases: Array<{
      status: "REQUEST_CHANGES" | "BLOCKED" | "SYSTEM_BLOCKED";
      prefix: string;
    }> = [
      { status: "REQUEST_CHANGES", prefix: "Your research plan needs a quick look —" },
      { status: "BLOCKED", prefix: "Your research plan was rejected —" },
      { status: "SYSTEM_BLOCKED", prefix: "Your research run hit a system issue —" },
    ];
    for (const c of cases) {
      const calls = installFetch();
      await sendPlanReviewEmail({
        to: "user@example.com",
        slug: "s",
        topic: "MyTopic",
        status: c.status,
        user_message: "summary",
        findings: [],
      });
      const body = parseBody(calls);
      assert.ok(
        (body.subject as string).startsWith(c.prefix),
        `status ${c.status}: expected subject prefix "${c.prefix}", got "${body.subject as string}"`,
      );
    }
  });

  test("findings (top 8) appear in the body; a 9th is summarized as 'more'", async () => {
    process.env.RESEND_API_KEY = "re_live_key";
    const calls = installFetch();
    const findings = Array.from({ length: 9 }, (_, i) => ({
      severity: "MAJOR" as const,
      origin: "codex",
      message: `finding number ${i}`,
    }));
    await sendPlanReviewEmail({
      to: "user@example.com",
      slug: "s",
      topic: "T",
      status: "REQUEST_CHANGES",
      user_message: "summary",
      findings,
    });
    const body = parseBody(calls);
    const text = body.text as string;
    const html = body.html as string;
    // top 8 (indices 0..7) present
    for (let i = 0; i < 8; i++) {
      assert.ok(text.includes(`finding number ${i}`), `text missing finding ${i}`);
      assert.ok(html.includes(`finding number ${i}`), `html missing finding ${i}`);
    }
    // 9th (index 8) is not enumerated; rolled into a "more" tail
    assert.ok(!text.includes("finding number 8"), "9th finding must not be enumerated");
    assert.ok(text.includes("1 more"), "text summarizes the overflow count");
  });
});

describe("operator alerts (sendPreflightBackoffEmail)", () => {
  test("PREFLIGHT_NOTIFY_EMAIL unset: no fetch", async () => {
    process.env.RESEND_API_KEY = "re_live_key";
    const calls = installFetch();
    await sendPreflightBackoffEmail({
      origin: "preflight",
      kind: "claude-auth",
      consecutiveFailures: 3,
      backoffUntil: new Date(Date.now() + 20 * 60000).toISOString(),
      detail: "auth failed",
      remediation: "re-login",
    });
    assert.equal(calls.length, 0, "no recipient -> no POST");
  });

  test("PREFLIGHT_NOTIFY_EMAIL set but RESEND_API_KEY unset: no fetch", async () => {
    process.env.PREFLIGHT_NOTIFY_EMAIL = "ops@example.com";
    const calls = installFetch();
    await sendPreflightBackoffEmail({
      origin: "preflight",
      kind: "claude-auth",
      consecutiveFailures: 3,
      backoffUntil: new Date(Date.now() + 20 * 60000).toISOString(),
      detail: "auth failed",
      remediation: "re-login",
    });
    assert.equal(calls.length, 0, "no key -> no POST");
  });

  test("both set: POSTs to the PREFLIGHT_NOTIFY_EMAIL recipient with Bearer auth", async () => {
    process.env.RESEND_API_KEY = "re_live_key";
    process.env.PREFLIGHT_NOTIFY_EMAIL = "ops@example.com";
    const calls = installFetch();
    await sendPreflightBackoffEmail({
      origin: "terminal",
      kind: "claude-auth",
      source: "executor:claude-spawn",
      signature: "regex:credit-balance-low",
      consecutiveFailures: 3,
      backoffUntil: new Date(Date.now() + 20 * 60000).toISOString(),
      detail: "credit out",
      remediation: "top up credits",
    });
    assert.equal(calls.length, 1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer re_live_key");
    const body = parseBody(calls);
    assert.equal(body.to, "ops@example.com");
  });
});

describe("sendPreflightRecoveryEmail", () => {
  test("both env set: subject is the recovery banner", async () => {
    process.env.RESEND_API_KEY = "re_live_key";
    process.env.PREFLIGHT_NOTIFY_EMAIL = "ops@example.com";
    const calls = installFetch();
    await sendPreflightRecoveryEmail({
      consecutiveFailures: 4,
      lastFailureKind: "claude-auth",
      outageDurationMin: 42,
    });
    const body = parseBody(calls);
    assert.equal(body.subject, "[Dynamic Research] Worker preflight recovered");
  });
});

describe("sendStudioRecoveryExhaustedEmail", () => {
  test("both env set: POSTs with subject containing reason+slug and body lists joined products", async () => {
    process.env.RESEND_API_KEY = "re_live_key";
    process.env.PREFLIGHT_NOTIFY_EMAIL = "ops@example.com";
    const calls = installFetch();
    await sendStudioRecoveryExhaustedEmail({
      jobId: "job-1",
      slug: "my-research-slug",
      topic: "T",
      attempts: 8,
      reason: "attempt-cap",
      products: ["audio", "video"],
      ageHours: 50,
    });
    assert.equal(calls.length, 1);
    const body = parseBody(calls);
    const subject = body.subject as string;
    assert.ok(subject.includes("attempt-cap"), "subject must include the reason");
    assert.ok(subject.includes("my-research-slug"), "subject must include the slug");
    const text = body.text as string;
    assert.ok(text.includes("audio, video"), "body lists the joined product names");
  });
});
