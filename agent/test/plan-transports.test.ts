/**
 * S58.5 — unit tests for agent/lib/plan-transports.ts (Codex MAJOR-2 fix).
 *
 * Uses the __overrideSdkLoadersForTesting() seam to inject mocked SDK
 * exports — verifies the downstream shape-handling, JSON parsing, cost
 * accounting, and error paths WITHOUT requiring real Gemini/OpenAI/
 * Anthropic packages to be installed.
 *
 * Run via: pnpm -C agent exec node --import=tsx --test test/plan-transports.test.ts
 */

import { test, describe, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  makeGeminiReviewerTransport,
  makeOpenAIReviewerTransport,
  makeClaudeIntegrationTransport,
  makeClaudeSynthesisTransport,
  makePlanReviewTransports,
  __overrideSdkLoadersForTesting,
  __resetSdkOverridesForTesting,
} from "../lib/plan-transports.js";
import { PLAN_SCHEMA_VERSION, type ResearchPlan } from "../lib/plan-types.js";
import type { ResearchJob } from "../types.js";

// ── Test fixtures ───────────────────────────────────────────────────

function mockJob(): ResearchJob {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    created_at: "2026-05-27T00:00:00.000Z",
    updated_at: "2026-05-27T00:00:00.000Z",
    status: "running",
    claimed_at: null,
    completed_at: null,
    error_message: null,
    topic: "test topic",
    topic_slug: "test-topic",
    user_context: {
      domainKnowledge: [],
      constraints: [],
      additionalUrls: [],
      claimsToVerify: [],
    },
    vendor_evaluation: {
      enabled: false,
      vendorType: "",
      serviceArea: "",
      serviceAddress: "",
      jobDescription: "",
      maxVendorsDiscovered: 0,
      maxVendorsEnriched: 0,
    },
    aji_dna_enabled: false,
    selected_products: {
      audio: false,
      video: false,
      slides: false,
      report: true,
      infographic: false,
    },
    customizations: {
      perplexity: { queryFraming: "", emphasis: [], outputStructure: "" },
      notebookLM: { persona: "", researchMode: "deep", priorities: [] },
      studio: {},
    },
    notify_email: null,
    current_phase: "",
    phase_status: "",
    progress_pct: 0,
    estimated_minutes: null,
    result_slug: null,
    organization_id: "00000000-0000-0000-0000-000000000010",
  };
}

function basePlan(): ResearchPlan {
  return {
    schema_version: PLAN_SCHEMA_VERSION,
    topic_resolved: "Test topic",
    audience: {
      persona: "Tester",
      decision_context: "Validate transports",
      depth_target: "practitioner",
    },
    research_universe: {
      vendor_candidates: ["A", "B", "C"],
      explicit_exclusions: ["X: no relevant"],
      source_priorities: ["industry-analyst"],
    },
    evaluation_framework: {
      tier1_dimensions: ["d1", "d2", "d3", "d4", "d5"],
      tier2_dimensions: ["d6"],
      rubric_rationale:
        "Practitioner pick — operational depth dominates the tier-1 weight.",
    },
    studio_products: { selected: ["report"], per_product_emphasis: {} },
    expected_artifacts: ["report.md"],
    risk_flags: ["test risk"],
  };
}

function validReviewerJson(): string {
  return JSON.stringify({
    verdict: "APPROVE_WITH_CHANGES",
    persona_depth_score: 3,
    findings: [
      { severity: "MINOR", origin: "topic", message: "narrow scope a bit" },
    ],
  });
}

// ── Reset overrides between tests ───────────────────────────────────

afterEach(() => __resetSdkOverridesForTesting());

// ── Factory null-returns when keys absent ───────────────────────────

describe("transport factories — key-absent semantics", () => {
  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  test("makeGeminiReviewerTransport returns null when GEMINI_API_KEY absent", () => {
    assert.equal(makeGeminiReviewerTransport(), null);
  });

  test("makeGeminiReviewerTransport returns function when opts.apiKey provided", () => {
    const t = makeGeminiReviewerTransport({ apiKey: "fake" });
    assert.equal(typeof t, "function");
  });

  test("makeOpenAIReviewerTransport returns null when OPENAI_API_KEY absent", () => {
    assert.equal(makeOpenAIReviewerTransport(), null);
  });

  test("makeOpenAIReviewerTransport returns function when opts.apiKey provided", () => {
    const t = makeOpenAIReviewerTransport({ apiKey: "fake" });
    assert.equal(typeof t, "function");
  });

  test("makeClaudeIntegrationTransport always returns function (defers throw to call time)", () => {
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(typeof makeClaudeIntegrationTransport(), "function");
  });

  test("makeClaudeSynthesisTransport always returns function", () => {
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(typeof makeClaudeSynthesisTransport(), "function");
  });

  test("makePlanReviewTransports returns expected shape", () => {
    const t = makePlanReviewTransports();
    // No API keys: gemini + codex are null; integration + synthesizer always present
    assert.equal(t.gemini, null);
    assert.equal(t.codex, null);
    assert.equal(typeof t.integration, "function");
    assert.equal(typeof t.synthesizer, "function");
  });
});

// ── Anthropic integration/synthesis: throws at call time when key absent ──

describe("anthropic transports — missing-key call-time error", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  test("makeClaudeIntegrationTransport throws clear error on call when key absent", async () => {
    const t = makeClaudeIntegrationTransport();
    await assert.rejects(
      () =>
        t({
          plan: basePlan(),
          reviewer_call: {
            reviewer: "gemini",
            iteration: 1,
            verdict: "APPROVE_WITH_CHANGES",
            findings: [],
            plan_version: basePlan(),
            model_id: "x",
            provider: "google",
            total_cost_usd: 0,
          },
          manifest: mockJob(),
          signal: new AbortController().signal,
        }),
      /ANTHROPIC_API_KEY missing/,
    );
  });

  test("makeClaudeSynthesisTransport throws on call when key absent", async () => {
    const t = makeClaudeSynthesisTransport();
    await assert.rejects(
      () => t({ prompt: "p", signal: new AbortController().signal }),
      /ANTHROPIC_API_KEY missing/,
    );
  });
});

// ── Gemini transport: mocked-SDK happy + sad paths ──────────────────

describe("gemini transport — mocked SDK", () => {
  test("returns parsed verdict + tokens + cost on canonical response", async () => {
    __overrideSdkLoadersForTesting({
      google: async () => ({
        GoogleGenAI: class {
          constructor(_init: { apiKey: string }) {}
          models = {
            generateContent: async (_req: unknown) => ({
              text: validReviewerJson(),
              usageMetadata: {
                promptTokenCount: 1000,
                candidatesTokenCount: 200,
              },
            }),
          };
        },
      }),
    });
    const transport = makeGeminiReviewerTransport({ apiKey: "fake" });
    assert.ok(transport);
    const out = await transport({
      plan: basePlan(),
      manifest: mockJob(),
      iteration: 1,
      signal: new AbortController().signal,
    });
    assert.equal(out.verdict, "APPROVE_WITH_CHANGES");
    assert.equal(out.persona_depth_score, 3);
    assert.equal(out.findings.length, 1);
    assert.equal(out.input_tokens, 1000);
    assert.equal(out.output_tokens, 200);
    assert.ok((out.total_cost_usd ?? 0) > 0);
    assert.equal(out.model_id, "gemini-3.1-pro-preview");
  });

  test("throws on non-JSON response (clear diagnostic)", async () => {
    __overrideSdkLoadersForTesting({
      google: async () => ({
        GoogleGenAI: class {
          constructor(_init: { apiKey: string }) {}
          models = {
            generateContent: async () => ({
              text: "not valid json at all",
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
            }),
          };
        },
      }),
    });
    const transport = makeGeminiReviewerTransport({ apiKey: "fake" });
    assert.ok(transport);
    await assert.rejects(
      () =>
        transport({
          plan: basePlan(),
          manifest: mockJob(),
          iteration: 1,
          signal: new AbortController().signal,
        }),
      /gemini returned non-conformant JSON/,
    );
  });

  // ── S79 G-MIN-1 (S75 carry-forward) — persona_depth_score nullability ──

  test("S79 G-MIN-1: persona_depth_score=null is accepted and surfaced through transport (not coerced to 0)", async () => {
    __overrideSdkLoadersForTesting({
      google: async () => ({
        GoogleGenAI: class {
          constructor(_init: { apiKey: string }) {}
          models = {
            generateContent: async () => ({
              text: JSON.stringify({
                verdict: "APPROVE_WITH_CHANGES",
                persona_depth_score: null,
                findings: [
                  {
                    severity: "MINOR",
                    origin: "topic",
                    message: "scope could narrow",
                  },
                ],
              }),
              usageMetadata: {
                promptTokenCount: 100,
                candidatesTokenCount: 20,
              },
            }),
          };
        },
      }),
    });
    const transport = makeGeminiReviewerTransport({ apiKey: "fake" });
    assert.ok(transport);
    const out = await transport({
      plan: basePlan(),
      manifest: mockJob(),
      iteration: 1,
      signal: new AbortController().signal,
    });
    assert.equal(out.verdict, "APPROVE_WITH_CHANGES");
    // Critical: null must be preserved verbatim, NOT coerced to 0 or undefined.
    // Downstream ensurePersonaDepthFinding distinguishes null (reviewer punted)
    // from a low numeric score (reviewer scored the plan poorly) via the
    // typeof === "number" guard.
    assert.equal(out.persona_depth_score, null);
    assert.equal(out.findings.length, 1);
  });

  test("S79 G-MIN-1: persona_depth_score missing (undefined) is rejected — distinct from explicit null", async () => {
    __overrideSdkLoadersForTesting({
      google: async () => ({
        GoogleGenAI: class {
          constructor(_init: { apiKey: string }) {}
          models = {
            generateContent: async () => ({
              text: JSON.stringify({
                verdict: "APPROVE",
                // persona_depth_score deliberately OMITTED — schema requires
                // the field; reviewer must emit either integer or explicit null.
                findings: [],
              }),
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 5,
              },
            }),
          };
        },
      }),
    });
    const transport = makeGeminiReviewerTransport({ apiKey: "fake" });
    assert.ok(transport);
    await assert.rejects(
      () =>
        transport({
          plan: basePlan(),
          manifest: mockJob(),
          iteration: 1,
          signal: new AbortController().signal,
        }),
      /persona_depth_score is required/,
    );
  });

  test("S79 G-MIN-1: out-of-range integer still rejected (range guard intact)", async () => {
    __overrideSdkLoadersForTesting({
      google: async () => ({
        GoogleGenAI: class {
          constructor(_init: { apiKey: string }) {}
          models = {
            generateContent: async () => ({
              text: JSON.stringify({
                verdict: "APPROVE",
                persona_depth_score: 7, // > 4, must still be rejected
                findings: [],
              }),
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 5,
              },
            }),
          };
        },
      }),
    });
    const transport = makeGeminiReviewerTransport({ apiKey: "fake" });
    assert.ok(transport);
    await assert.rejects(
      () =>
        transport({
          plan: basePlan(),
          manifest: mockJob(),
          iteration: 1,
          signal: new AbortController().signal,
        }),
      /bad persona_depth_score/,
    );
  });

  test("propagates SDK load error with install hint", async () => {
    __overrideSdkLoadersForTesting({
      google: async () => {
        throw new Error("simulated module-not-found");
      },
    });
    // We can't directly call the loader; but the transport will trigger it.
    const transport = makeGeminiReviewerTransport({ apiKey: "fake" });
    assert.ok(transport);
    await assert.rejects(
      () =>
        transport({
          plan: basePlan(),
          manifest: mockJob(),
          iteration: 1,
          signal: new AbortController().signal,
        }),
      /simulated module-not-found/,
    );
  });

  test("custom modelId option overrides default", async () => {
    __overrideSdkLoadersForTesting({
      google: async () => ({
        GoogleGenAI: class {
          constructor(_init: { apiKey: string }) {}
          models = {
            generateContent: async (req: { model: string }) => ({
              text: validReviewerJson(),
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
              _capturedModel: req.model,
            }),
          };
        },
      }),
    });
    const transport = makeGeminiReviewerTransport({
      apiKey: "fake",
      modelId: "gemini-3.5-pro",
    });
    assert.ok(transport);
    const out = await transport({
      plan: basePlan(),
      manifest: mockJob(),
      iteration: 1,
      signal: new AbortController().signal,
    });
    assert.equal(out.model_id, "gemini-3.5-pro");
  });

  // ── S62 Bug 52 fix v3 — config-key wiring tests (Codex MRPF v2 catches) ──

  test("S62 Bug 52 v3: systemInstruction + temperature + thinkingConfig.thinkingLevel propagate to SDK", async () => {
    let capturedConfig: Record<string, unknown> | undefined;
    __overrideSdkLoadersForTesting({
      google: async () => ({
        GoogleGenAI: class {
          constructor(_init: { apiKey: string }) {}
          models = {
            generateContent: async (req: { config?: Record<string, unknown> }) => {
              capturedConfig = req.config;
              return {
                text: validReviewerJson(),
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
              };
            },
          };
        },
      }),
    });
    const transport = makeGeminiReviewerTransport({
      apiKey: "fake",
      thinkingLevel: "medium",
      temperature: 0.5,
      systemInstruction: "custom strict review prompt",
    });
    assert.ok(transport);
    await transport({
      plan: basePlan(),
      manifest: mockJob(),
      iteration: 1,
      signal: new AbortController().signal,
    });
    assert.ok(capturedConfig, "config should have been captured");
    assert.equal(capturedConfig.temperature, 0.5);
    assert.equal(capturedConfig.systemInstruction, "custom strict review prompt");
    assert.deepEqual(capturedConfig.thinkingConfig, { thinkingLevel: "medium" });
  });

  test("S62 Bug 52 v3: env GEMINI_THINKING_LEVEL overrides default; opts override env", async () => {
    let capturedConfig: Record<string, unknown> | undefined;
    __overrideSdkLoadersForTesting({
      google: async () => ({
        GoogleGenAI: class {
          constructor(_init: { apiKey: string }) {}
          models = {
            generateContent: async (req: { config?: Record<string, unknown> }) => {
              capturedConfig = req.config;
              return {
                text: validReviewerJson(),
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
              };
            },
          };
        },
      }),
    });
    const origEnv = process.env.GEMINI_THINKING_LEVEL;
    try {
      process.env.GEMINI_THINKING_LEVEL = "low";
      const tEnv = makeGeminiReviewerTransport({ apiKey: "fake" });
      assert.ok(tEnv);
      await tEnv({
        plan: basePlan(),
        manifest: mockJob(),
        iteration: 1,
        signal: new AbortController().signal,
      });
      assert.deepEqual(capturedConfig?.thinkingConfig, { thinkingLevel: "low" });

      // Opts override env
      const tOpts = makeGeminiReviewerTransport({
        apiKey: "fake",
        thinkingLevel: "high",
      });
      assert.ok(tOpts);
      await tOpts({
        plan: basePlan(),
        manifest: mockJob(),
        iteration: 1,
        signal: new AbortController().signal,
      });
      assert.deepEqual(capturedConfig?.thinkingConfig, { thinkingLevel: "high" });
    } finally {
      if (origEnv === undefined) delete process.env.GEMINI_THINKING_LEVEL;
      else process.env.GEMINI_THINKING_LEVEL = origEnv;
    }
  });

  test("S62 Bug 52 v3: invalid GEMINI_THINKING_LEVEL falls back to default 'high'", async () => {
    let capturedConfig: Record<string, unknown> | undefined;
    __overrideSdkLoadersForTesting({
      google: async () => ({
        GoogleGenAI: class {
          constructor(_init: { apiKey: string }) {}
          models = {
            generateContent: async (req: { config?: Record<string, unknown> }) => {
              capturedConfig = req.config;
              return {
                text: validReviewerJson(),
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
              };
            },
          };
        },
      }),
    });
    const origEnv = process.env.GEMINI_THINKING_LEVEL;
    try {
      process.env.GEMINI_THINKING_LEVEL = "ULTRA"; // not in enum
      const t = makeGeminiReviewerTransport({ apiKey: "fake" });
      assert.ok(t);
      await t({
        plan: basePlan(),
        manifest: mockJob(),
        iteration: 1,
        signal: new AbortController().signal,
      });
      assert.deepEqual(capturedConfig?.thinkingConfig, { thinkingLevel: "high" });
    } finally {
      if (origEnv === undefined) delete process.env.GEMINI_THINKING_LEVEL;
      else process.env.GEMINI_THINKING_LEVEL = origEnv;
    }
  });

  test("S62 Bug 52 v3: thoughtsTokenCount is summed into output_tokens (Codex MRPF v2 MAJOR-2)", async () => {
    __overrideSdkLoadersForTesting({
      google: async () => ({
        GoogleGenAI: class {
          constructor(_init: { apiKey: string }) {}
          models = {
            generateContent: async () => ({
              text: validReviewerJson(),
              usageMetadata: {
                promptTokenCount: 1000,
                candidatesTokenCount: 200,
                thoughtsTokenCount: 1500, // reasoning tokens that prior code missed
                totalTokenCount: 2700,
              },
            }),
          };
        },
      }),
    });
    const transport = makeGeminiReviewerTransport({ apiKey: "fake" });
    assert.ok(transport);
    const out = await transport({
      plan: basePlan(),
      manifest: mockJob(),
      iteration: 1,
      signal: new AbortController().signal,
    });
    assert.equal(out.input_tokens, 1000);
    // output_tokens MUST include thoughts so cost-cap and Bug 52 success
    // criterion see the actual reasoning cost.
    assert.equal(out.output_tokens, 1700, "output_tokens = candidates + thoughts");
  });

  test("S62 Bug 52 v3: thoughtsTokenCount absent → output_tokens equals candidates", async () => {
    __overrideSdkLoadersForTesting({
      google: async () => ({
        GoogleGenAI: class {
          constructor(_init: { apiKey: string }) {}
          models = {
            generateContent: async () => ({
              text: validReviewerJson(),
              usageMetadata: {
                promptTokenCount: 100,
                candidatesTokenCount: 50,
                // No thoughtsTokenCount — backward compat path
              },
            }),
          };
        },
      }),
    });
    const transport = makeGeminiReviewerTransport({ apiKey: "fake" });
    assert.ok(transport);
    const out = await transport({
      plan: basePlan(),
      manifest: mockJob(),
      iteration: 1,
      signal: new AbortController().signal,
    });
    assert.equal(out.output_tokens, 50);
  });

  test("S62 Bug 52: env-var GEMINI_TEMPERATURE overrides default; opts override env", async () => {
    let capturedConfig: Record<string, unknown> | undefined;
    __overrideSdkLoadersForTesting({
      google: async () => ({
        GoogleGenAI: class {
          constructor(_init: { apiKey: string }) {}
          models = {
            generateContent: async (req: { config?: Record<string, unknown> }) => {
              capturedConfig = req.config;
              return {
                text: validReviewerJson(),
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
              };
            },
          };
        },
      }),
    });
    const origEnv = process.env.GEMINI_TEMPERATURE;
    try {
      process.env.GEMINI_TEMPERATURE = "0.7";
      // No opts: env should apply
      const tEnv = makeGeminiReviewerTransport({ apiKey: "fake" });
      assert.ok(tEnv);
      await tEnv({
        plan: basePlan(),
        manifest: mockJob(),
        iteration: 1,
        signal: new AbortController().signal,
      });
      assert.equal(capturedConfig?.temperature, 0.7);

      // Opts present: opts win over env
      const tOpts = makeGeminiReviewerTransport({ apiKey: "fake", temperature: 0.1 });
      assert.ok(tOpts);
      await tOpts({
        plan: basePlan(),
        manifest: mockJob(),
        iteration: 1,
        signal: new AbortController().signal,
      });
      assert.equal(capturedConfig?.temperature, 0.1);
    } finally {
      if (origEnv === undefined) delete process.env.GEMINI_TEMPERATURE;
      else process.env.GEMINI_TEMPERATURE = origEnv;
    }
  });

  test("S62 Bug 52: invalid GEMINI_TEMPERATURE env (out-of-range) falls back to default 0.3", async () => {
    let capturedConfig: Record<string, unknown> | undefined;
    __overrideSdkLoadersForTesting({
      google: async () => ({
        GoogleGenAI: class {
          constructor(_init: { apiKey: string }) {}
          models = {
            generateContent: async (req: { config?: Record<string, unknown> }) => {
              capturedConfig = req.config;
              return {
                text: validReviewerJson(),
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
              };
            },
          };
        },
      }),
    });
    const origEnv = process.env.GEMINI_TEMPERATURE;
    try {
      process.env.GEMINI_TEMPERATURE = "5.0"; // out of [0, 2] range
      const t = makeGeminiReviewerTransport({ apiKey: "fake" });
      assert.ok(t);
      await t({
        plan: basePlan(),
        manifest: mockJob(),
        iteration: 1,
        signal: new AbortController().signal,
      });
      assert.equal(capturedConfig?.temperature, 0.3); // default
    } finally {
      if (origEnv === undefined) delete process.env.GEMINI_TEMPERATURE;
      else process.env.GEMINI_TEMPERATURE = origEnv;
    }
  });
});

// ── OpenAI transport: mocked-SDK happy + sad paths ──────────────────

describe("openai transport — mocked SDK", () => {
  test("uses Responses API with text.format JSON shape (Codex CRITICAL-2)", async () => {
    let capturedRequest: { text?: unknown } | undefined;
    __overrideSdkLoadersForTesting({
      openai: async () => ({
        default: class {
          constructor(_init: { apiKey: string }) {}
          responses = {
            create: async (req: unknown) => {
              capturedRequest = req as { text?: unknown };
              return {
                output_text: validReviewerJson(),
                usage: { input_tokens: 800, output_tokens: 150 },
              };
            },
          };
          chat = { completions: { create: async () => ({ choices: [] }) } };
        },
      }),
    });
    const transport = makeOpenAIReviewerTransport({ apiKey: "fake" });
    assert.ok(transport);
    const out = await transport({
      plan: basePlan(),
      manifest: mockJob(),
      iteration: 1,
      signal: new AbortController().signal,
    });
    assert.equal(out.verdict, "APPROVE_WITH_CHANGES");
    assert.equal(out.input_tokens, 800);
    assert.equal(out.output_tokens, 150);
    // CRITICAL-2 guard: the request MUST carry text.format (NOT top-level response_format)
    assert.ok(
      capturedRequest && typeof capturedRequest.text === "object" && capturedRequest.text !== null,
      "openai responses.create call must include text.format per current SDK",
    );
    // S75: text.format upgraded from json_object → json_schema with strict:true.
    // Assert structural shape (type + name + strict) without snapshotting the
    // full schema body — the schema is built dynamically from plan-types.ts.
    const tf = (capturedRequest.text as { format?: Record<string, unknown> })?.format;
    assert.ok(tf, "text.format must be present");
    assert.equal(tf.type, "json_schema", "text.format.type must be json_schema (S75)");
    assert.equal(tf.name, "reviewer_output");
    assert.equal(tf.strict, true);
    assert.equal(typeof tf.schema, "object");
  });

  test("falls back to chat.completions when responses unavailable", async () => {
    __overrideSdkLoadersForTesting({
      openai: async () => ({
        default: class {
          constructor(_init: { apiKey: string }) {}
          // No responses property
          chat = {
            completions: {
              create: async () => ({
                choices: [{ message: { content: validReviewerJson() } }],
                usage: { prompt_tokens: 600, completion_tokens: 90 },
              }),
            },
          };
        },
      }),
    });
    const transport = makeOpenAIReviewerTransport({ apiKey: "fake" });
    assert.ok(transport);
    const out = await transport({
      plan: basePlan(),
      manifest: mockJob(),
      iteration: 1,
      signal: new AbortController().signal,
    });
    assert.equal(out.input_tokens, 600);
    assert.equal(out.output_tokens, 90);
    assert.equal(out.verdict, "APPROVE_WITH_CHANGES");
  });

  test("strips ```json fence around response", async () => {
    __overrideSdkLoadersForTesting({
      openai: async () => ({
        default: class {
          constructor(_init: { apiKey: string }) {}
          responses = {
            create: async () => ({
              output_text: "```json\n" + validReviewerJson() + "\n```",
              usage: { input_tokens: 100, output_tokens: 50 },
            }),
          };
          chat = { completions: { create: async () => ({ choices: [] }) } };
        },
      }),
    });
    const transport = makeOpenAIReviewerTransport({ apiKey: "fake" });
    assert.ok(transport);
    const out = await transport({
      plan: basePlan(),
      manifest: mockJob(),
      iteration: 1,
      signal: new AbortController().signal,
    });
    assert.equal(out.verdict, "APPROVE_WITH_CHANGES");
  });

  // ── S79 G-MIN-1 v2 (Gemini round 1 G-MIN-2): OpenAI null-acceptance mirror ──

  test("S79 G-MIN-1: OpenAI transport surfaces persona_depth_score=null verbatim (not coerced to 0)", async () => {
    __overrideSdkLoadersForTesting({
      openai: async () => ({
        default: class {
          constructor(_init: { apiKey: string }) {}
          responses = {
            create: async () => ({
              output_text: JSON.stringify({
                verdict: "APPROVE_WITH_CHANGES",
                persona_depth_score: null,
                findings: [
                  {
                    severity: "MINOR",
                    origin: "topic",
                    message: "scope ambiguous",
                  },
                ],
              }),
              usage: { input_tokens: 500, output_tokens: 80 },
            }),
          };
          chat = { completions: { create: async () => ({ choices: [] }) } };
        },
      }),
    });
    const transport = makeOpenAIReviewerTransport({ apiKey: "fake" });
    assert.ok(transport);
    const out = await transport({
      plan: basePlan(),
      manifest: mockJob(),
      iteration: 1,
      signal: new AbortController().signal,
    });
    assert.equal(out.verdict, "APPROVE_WITH_CHANGES");
    // Mirror of the Gemini-side guarantee: null is preserved through the
    // OpenAI parse path. validateReviewerJsonShape is shared between both
    // transports, but the contract should be exercised on each surface so
    // a parse-path-specific regression (e.g. SDK-side coercion in
    // responses.parse) does not silently land on one transport only.
    assert.equal(out.persona_depth_score, null);
    assert.equal(out.findings.length, 1);
  });

  test("S79 G-MIN-1: OpenAI transport rejects persona_depth_score missing — distinct from null", async () => {
    __overrideSdkLoadersForTesting({
      openai: async () => ({
        default: class {
          constructor(_init: { apiKey: string }) {}
          responses = {
            create: async () => ({
              output_text: JSON.stringify({
                verdict: "APPROVE",
                findings: [],
              }),
              usage: { input_tokens: 50, output_tokens: 20 },
            }),
          };
          chat = { completions: { create: async () => ({ choices: [] }) } };
        },
      }),
    });
    const transport = makeOpenAIReviewerTransport({ apiKey: "fake" });
    assert.ok(transport);
    await assert.rejects(
      () =>
        transport({
          plan: basePlan(),
          manifest: mockJob(),
          iteration: 1,
          signal: new AbortController().signal,
        }),
      /persona_depth_score is required/,
    );
  });

  // ── S77 v4 receiver-bound + S78 C-MAJ-3 fallback coverage ──────────

  test("S77 v4: responses.parse() preferred over .create() when present (receiver-bound)", async () => {
    let parseCalled = 0;
    let createCalled = 0;
    let parseThis: unknown = undefined;
    __overrideSdkLoadersForTesting({
      openai: async () => ({
        default: class {
          constructor(_init: { apiKey: string }) {}
          responses = {
            parse: async function (_req: unknown) {
              parseCalled += 1;
              parseThis = this; // capture receiver to confirm method-binding
              return {
                output_text: validReviewerJson(),
                // .parse() populates output_parsed by JSON-parsing the
                // schema-validated text. Mock returns the same as the text
                // so either path yields a valid verdict.
                output_parsed: JSON.parse(validReviewerJson()),
                usage: { input_tokens: 100, output_tokens: 50 },
              };
            },
            create: async () => {
              createCalled += 1;
              return {
                output_text: validReviewerJson(),
                usage: { input_tokens: 100, output_tokens: 50 },
              };
            },
          };
          chat = { completions: { create: async () => ({ choices: [] }) } };
        },
      }),
    });
    const transport = makeOpenAIReviewerTransport({ apiKey: "fake" });
    assert.ok(transport);
    const out = await transport({
      plan: basePlan(),
      manifest: mockJob(),
      iteration: 1,
      signal: new AbortController().signal,
    });
    assert.equal(parseCalled, 1, "responses.parse() must be called when present");
    assert.equal(createCalled, 0, "responses.create() must not be called when .parse() present");
    assert.ok(parseThis && (parseThis as { parse?: unknown }).parse,
      "parse() must be invoked through receiver (this === responses)");
    assert.equal(out.verdict, "APPROVE_WITH_CHANGES");
  });

  test("S77 v4: chat.completions.parse() preferred over .create() when present (receiver-bound)", async () => {
    let parseCalled = 0;
    let createCalled = 0;
    let parseThis: unknown = undefined;
    __overrideSdkLoadersForTesting({
      openai: async () => ({
        default: class {
          constructor(_init: { apiKey: string }) {}
          // No responses property — exercises chat.completions branch
          chat = {
            completions: {
              parse: async function (_req: unknown) {
                parseCalled += 1;
                parseThis = this;
                return {
                  choices: [{
                    message: {
                      content: validReviewerJson(),
                      parsed: JSON.parse(validReviewerJson()),
                    },
                  }],
                  usage: { prompt_tokens: 100, completion_tokens: 50 },
                };
              },
              create: async () => {
                createCalled += 1;
                return {
                  choices: [{ message: { content: validReviewerJson() } }],
                  usage: { prompt_tokens: 100, completion_tokens: 50 },
                };
              },
            },
          };
        },
      }),
    });
    const transport = makeOpenAIReviewerTransport({ apiKey: "fake" });
    assert.ok(transport);
    const out = await transport({
      plan: basePlan(),
      manifest: mockJob(),
      iteration: 1,
      signal: new AbortController().signal,
    });
    assert.equal(parseCalled, 1, "chat.completions.parse() must be called when present");
    assert.equal(createCalled, 0, "chat.completions.create() must not be called when .parse() present");
    assert.ok(parseThis && (parseThis as { parse?: unknown }).parse,
      "parse() must be invoked through receiver (this === chat.completions)");
    assert.equal(out.verdict, "APPROVE_WITH_CHANGES");
  });

  test("S77 G-MIN-3: string-shaped preParsedFromSdk falls through to parseReviewerJson", async () => {
    // Simulate an SDK quirk where .parse() surfaces the raw text in
    // output_parsed (rather than a parsed object). The typeof-object guard
    // must reject the string and fall through to parseReviewerJson — which
    // strips fences + JSON.parses cleanly.
    __overrideSdkLoadersForTesting({
      openai: async () => ({
        default: class {
          constructor(_init: { apiKey: string }) {}
          // .create() must exist to gate the Responses branch; .parse() is
          // the preferred path. The branch gate at `client.responses?.create`
          // routes here only when both surfaces exist on the resource.
          responses = {
            parse: async () => ({
              // text has the JSON wrapped in a markdown fence; output_parsed
              // is a STRING (not an object). Live code must ignore the string
              // preParsed and parse the fenced text via parseReviewerJson.
              output_text: "```json\n" + validReviewerJson() + "\n```",
              output_parsed: validReviewerJson(), // string, not object
              usage: { input_tokens: 100, output_tokens: 50 },
            }),
            create: async () => {
              throw new Error("create() must not be called when .parse() present");
            },
          };
          chat = { completions: { create: async () => ({ choices: [] }) } };
        },
      }),
    });
    const transport = makeOpenAIReviewerTransport({ apiKey: "fake" });
    assert.ok(transport);
    const out = await transport({
      plan: basePlan(),
      manifest: mockJob(),
      iteration: 1,
      signal: new AbortController().signal,
    });
    assert.equal(out.verdict, "APPROVE_WITH_CHANGES",
      "string-shaped preParsed must fall through to text parse path");
  });

  test("S78 C-MAJ-3: chat.completions schema-400 from .parse() falls back to json_object via .create()", async () => {
    let parseCalls = 0;
    let createCalls = 0;
    let capturedStrictReq: Record<string, unknown> | undefined;
    let capturedFallbackReq: Record<string, unknown> | undefined;
    __overrideSdkLoadersForTesting({
      openai: async () => ({
        default: class {
          constructor(_init: { apiKey: string }) {}
          // No responses — chat.completions branch
          chat = {
            completions: {
              parse: async (req: unknown) => {
                parseCalls += 1;
                capturedStrictReq = req as Record<string, unknown>;
                const err: { status: number; error: { type: string; message: string } } = {
                  status: 400,
                  error: {
                    type: "invalid_request_error",
                    message: "Invalid schema for response_format: unsupported keyword 'minimum'.",
                  },
                };
                throw err;
              },
              create: async (req: unknown) => {
                createCalls += 1;
                capturedFallbackReq = req as Record<string, unknown>;
                return {
                  choices: [{ message: { content: validReviewerJson() } }],
                  usage: { prompt_tokens: 100, completion_tokens: 50 },
                };
              },
            },
          };
        },
      }),
    });
    const transport = makeOpenAIReviewerTransport({ apiKey: "fake", modelId: "gpt-5-mini" });
    assert.ok(transport);
    const out = await transport({
      plan: basePlan(),
      manifest: mockJob(),
      iteration: 1,
      signal: new AbortController().signal,
    });
    assert.equal(parseCalls, 1, ".parse() called once with strict json_schema");
    assert.equal(createCalls, 1, ".create() called once for json_object fallback");
    assert.deepEqual(
      capturedFallbackReq?.response_format,
      { type: "json_object" },
      "fallback request must use json_object response_format",
    );
    // S78 Gemini MRPF MAJOR-1 guard: fallback MUST inherit every non-format
    // field from the strict request so future config (temperature, seed,
    // max_tokens) propagates. The spread pattern is the contract.
    assert.equal(
      capturedFallbackReq?.model,
      capturedStrictReq?.model,
      "fallback must inherit model from strict request",
    );
    assert.deepEqual(
      capturedFallbackReq?.messages,
      capturedStrictReq?.messages,
      "fallback must inherit messages from strict request",
    );
    assert.equal(out.verdict, "APPROVE_WITH_CHANGES");
  });

  test("S78 C-MAJ-3: chat.completions schema-400 from .create() falls back to json_object via .create()", async () => {
    let createCalls = 0;
    const captured: Array<{ response_format?: unknown }> = [];
    __overrideSdkLoadersForTesting({
      openai: async () => ({
        default: class {
          constructor(_init: { apiKey: string }) {}
          // No responses, no chat.completions.parse — exercises .create() path
          chat = {
            completions: {
              create: async (req: unknown) => {
                createCalls += 1;
                captured.push(req as { response_format?: unknown });
                if (createCalls === 1) {
                  const err = {
                    status: 400,
                    error: {
                      type: "invalid_request_error",
                      message: "response_format json_schema not supported on this model",
                    },
                  };
                  throw err;
                }
                return {
                  choices: [{ message: { content: validReviewerJson() } }],
                  usage: { prompt_tokens: 100, completion_tokens: 50 },
                };
              },
            },
          };
        },
      }),
    });
    const transport = makeOpenAIReviewerTransport({ apiKey: "fake" });
    assert.ok(transport);
    const out = await transport({
      plan: basePlan(),
      manifest: mockJob(),
      iteration: 1,
      signal: new AbortController().signal,
    });
    assert.equal(createCalls, 2, ".create() called twice: strict then loose");
    const firstRf = (captured[0]?.response_format as { type?: string } | undefined)?.type;
    const secondRf = (captured[1]?.response_format as { type?: string } | undefined)?.type;
    assert.equal(firstRf, "json_schema", "first call uses json_schema");
    assert.equal(secondRf, "json_object", "fallback uses json_object");
    assert.equal(out.verdict, "APPROVE_WITH_CHANGES");
  });

  test("S78 C-MAJ-3: non-schema-400 chat.completions error propagates without fallback", async () => {
    let createCalls = 0;
    __overrideSdkLoadersForTesting({
      openai: async () => ({
        default: class {
          constructor(_init: { apiKey: string }) {}
          chat = {
            completions: {
              create: async () => {
                createCalls += 1;
                // 429 rate-limit — NOT schema-related; isSchema400 returns false
                const err = {
                  status: 429,
                  error: { type: "rate_limit_error", message: "Rate limit exceeded" },
                };
                throw err;
              },
            },
          };
        },
      }),
    });
    const transport = makeOpenAIReviewerTransport({ apiKey: "fake" });
    assert.ok(transport);
    await assert.rejects(
      () =>
        transport({
          plan: basePlan(),
          manifest: mockJob(),
          iteration: 1,
          signal: new AbortController().signal,
        }),
      (err: unknown) => {
        const e = err as { status?: number };
        return e?.status === 429;
      },
      "non-schema-400 errors must propagate untouched (no json_object retry)",
    );
    assert.equal(createCalls, 1, ".create() called exactly once (no retry on non-schema error)");
  });

  test("S78 C-MAJ-3: schema-400 from .create() with no response_format reference returns false → propagates", async () => {
    // Regression guard for isSchema400: a 400 whose message lacks schema
    // anchors must NOT trigger json_object fallback (would otherwise mask
    // unrelated 400s like missing-param).
    let createCalls = 0;
    __overrideSdkLoadersForTesting({
      openai: async () => ({
        default: class {
          constructor(_init: { apiKey: string }) {}
          chat = {
            completions: {
              create: async () => {
                createCalls += 1;
                const err = {
                  status: 400,
                  error: {
                    type: "invalid_request_error",
                    message: "Missing required parameter: 'model'.",
                  },
                };
                throw err;
              },
            },
          };
        },
      }),
    });
    const transport = makeOpenAIReviewerTransport({ apiKey: "fake" });
    assert.ok(transport);
    await assert.rejects(() =>
      transport({
        plan: basePlan(),
        manifest: mockJob(),
        iteration: 1,
        signal: new AbortController().signal,
      }),
    );
    assert.equal(createCalls, 1, "non-schema 400 must not trigger fallback");
  });
});

// ── Anthropic transports: mocked-SDK ────────────────────────────────

describe("anthropic transports — mocked SDK", () => {
  test("synthesis transport returns text + tokens", async () => {
    __overrideSdkLoadersForTesting({
      anthropic: async () => ({
        default: class {
          constructor(_init: { apiKey: string }) {}
          messages = {
            create: async (_req: unknown) => ({
              content: [{ type: "text", text: '{"plan": "stub"}' }],
              usage: { input_tokens: 500, output_tokens: 75 },
            }),
          };
        },
      }),
    });
    const transport = makeClaudeSynthesisTransport({ apiKey: "fake" });
    const out = await transport({
      prompt: "synthesize plan",
      signal: new AbortController().signal,
    });
    assert.equal(out.text, '{"plan": "stub"}');
    assert.equal(out.input_tokens, 500);
    assert.equal(out.output_tokens, 75);
    assert.equal(out.model_id, "claude-opus-4-7");
  });

  test("integration transport parses + validates returned plan", async () => {
    const validPlan = basePlan();
    __overrideSdkLoadersForTesting({
      anthropic: async () => ({
        default: class {
          constructor(_init: { apiKey: string }) {}
          messages = {
            create: async () => ({
              content: [{ type: "text", text: JSON.stringify(validPlan) }],
              usage: { input_tokens: 1000, output_tokens: 800 },
            }),
          };
        },
      }),
    });
    const transport = makeClaudeIntegrationTransport({ apiKey: "fake" });
    const out = await transport({
      plan: basePlan(),
      reviewer_call: {
        reviewer: "gemini",
        iteration: 1,
        verdict: "APPROVE_WITH_CHANGES",
        findings: [{ severity: "MINOR", origin: "topic", message: "n/a" }],
        plan_version: basePlan(),
        model_id: "x",
        provider: "google",
        total_cost_usd: 0,
      },
      manifest: mockJob(),
      signal: new AbortController().signal,
    });
    assert.equal(out.integrated_plan.schema_version, PLAN_SCHEMA_VERSION);
    assert.equal(out.input_tokens, 1000);
  });

  test("integration transport throws on invalid plan JSON output", async () => {
    __overrideSdkLoadersForTesting({
      anthropic: async () => ({
        default: class {
          constructor(_init: { apiKey: string }) {}
          messages = {
            create: async () => ({
              content: [
                { type: "text", text: '{"schema_version": 99}' },
              ],
              usage: { input_tokens: 100, output_tokens: 50 },
            }),
          };
        },
      }),
    });
    const transport = makeClaudeIntegrationTransport({ apiKey: "fake" });
    await assert.rejects(
      () =>
        transport({
          plan: basePlan(),
          reviewer_call: {
            reviewer: "codex",
            iteration: 1,
            verdict: "REQUEST_CHANGES",
            findings: [],
            plan_version: basePlan(),
            model_id: "x",
            provider: "openai",
            total_cost_usd: 0,
          },
          manifest: mockJob(),
          signal: new AbortController().signal,
        }),
      /produced invalid plan/,
    );
  });
});

// ── Fallback cost accounting ────────────────────────────────────────

describe("fallback cost accounting", () => {
  test("returns nonzero cost for known model on gemini call", async () => {
    __overrideSdkLoadersForTesting({
      google: async () => ({
        GoogleGenAI: class {
          constructor(_init: { apiKey: string }) {}
          models = {
            generateContent: async () => ({
              text: validReviewerJson(),
              usageMetadata: {
                promptTokenCount: 1_000_000,
                candidatesTokenCount: 100_000,
              },
            }),
          };
        },
      }),
    });
    const transport = makeGeminiReviewerTransport({ apiKey: "fake" });
    assert.ok(transport);
    const out = await transport({
      plan: basePlan(),
      manifest: mockJob(),
      iteration: 1,
      signal: new AbortController().signal,
    });
    // gemini-3-pro-preview: input $2/Mtok, output $12/Mtok
    // 1Mtok * 2 + 0.1Mtok * 12 = 2 + 1.2 = $3.20
    assert.ok(
      Math.abs((out.total_cost_usd ?? 0) - 3.2) < 0.001,
      `expected ~$3.20, got ${out.total_cost_usd}`,
    );
  });

  test("returns 0 cost for unknown model id (no entry in pricing table)", async () => {
    __overrideSdkLoadersForTesting({
      google: async () => ({
        GoogleGenAI: class {
          constructor(_init: { apiKey: string }) {}
          models = {
            generateContent: async () => ({
              text: validReviewerJson(),
              usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 },
            }),
          };
        },
      }),
    });
    const transport = makeGeminiReviewerTransport({
      apiKey: "fake",
      modelId: "made-up-model-xyz",
    });
    assert.ok(transport);
    const out = await transport({
      plan: basePlan(),
      manifest: mockJob(),
      iteration: 1,
      signal: new AbortController().signal,
    });
    assert.equal(out.total_cost_usd, 0);
  });
});
