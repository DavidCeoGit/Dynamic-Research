/**
 * S58 Phase 1 MVP — unit tests for agent/lib/plan-synthesizer.ts.
 *
 * Coverage: extractJsonObject (4 cases), buildSynthesizerPrompt (fence
 * + pipeline digest), synthesizePlan happy/retry/fail/transport-error/abort.
 *
 * Run via: pnpm -C agent exec node --import=tsx --test test/plan-synthesizer.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  extractJsonObject,
  buildSynthesizerPrompt,
  synthesizePlan,
  PlanSynthesisError,
  RESEARCH_COMPARE_PIPELINE_DIGEST,
  type SynthesisTransport,
} from "../lib/plan-synthesizer.js";
import { PLAN_SCHEMA_VERSION } from "../lib/plan-types.js";
import type { ResearchJob } from "../types.js";

// ── Fixtures ────────────────────────────────────────────────────────

function mockJob(): ResearchJob {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    created_at: "2026-05-27T00:00:00.000Z",
    updated_at: "2026-05-27T00:00:00.000Z",
    status: "pending",
    claimed_at: null,
    completed_at: null,
    error_message: null,
    topic: "Carbon-neutral cooling for mid-sized SaaS data centers",
    topic_slug: "carbon-neutral-cooling",
    user_context: {
      domainKnowledge: ["existing colo at PUE 1.4"],
      constraints: ["no full retrofit budget"],
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
      slides: true,
      report: true,
      infographic: false,
    },
    customizations: {
      perplexity: { queryFraming: "", emphasis: [], outputStructure: "" },
      notebookLM: { persona: "VP Infra", researchMode: "deep", priorities: [] },
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

function validPlanJson(): string {
  return JSON.stringify({
    schema_version: PLAN_SCHEMA_VERSION,
    topic_resolved: "Carbon-neutral cooling for mid-sized SaaS data centers",
    audience: {
      persona: "VP Infrastructure",
      decision_context: "Pick a primary vendor for the new colo",
      depth_target: "practitioner",
    },
    research_universe: {
      vendor_candidates: ["Submer", "GRC", "LiquidStack", "Iceotope", "Asperitas"],
      explicit_exclusions: ["Hyperscaler in-house: not licensable"],
      source_priorities: ["industry-analyst", "vendor-docs"],
    },
    evaluation_framework: {
      tier1_dimensions: [
        "PUE under workload mix",
        "Retrofit cost",
        "SLA",
        "Coolant sourcing",
        "Upskilling",
      ],
      tier2_dimensions: ["Decommissioning waste"],
      rubric_rationale:
        "Practitioner-level pick demands operational depth — SLA + sourcing dominate.",
    },
    studio_products: {
      selected: ["slides", "report"],
      per_product_emphasis: { report: "Vendor comparison" },
    },
    expected_artifacts: ["vendor_comparison.md"],
    risk_flags: ["Vendor PUE may be optimistic"],
  });
}

function mockTransport(text: string, cost = 0.75): SynthesisTransport {
  return async () => ({
    text,
    total_cost_usd: cost,
    input_tokens: 1000,
    output_tokens: 500,
    duration_ms: 1234,
    model_id: "claude-opus-mock",
  });
}

function abortableSignal(): AbortController {
  return new AbortController();
}

// ── extractJsonObject ───────────────────────────────────────────────

describe("extractJsonObject", () => {
  test("returns bare JSON object verbatim", () => {
    const j = '{"a":1}';
    assert.equal(extractJsonObject(j), j);
  });

  test("strips markdown json fence", () => {
    const j = '```json\n{"a":1}\n```';
    assert.equal(extractJsonObject(j), '{"a":1}');
  });

  test("strips bare markdown fence", () => {
    const j = '```\n{"x":2}\n```';
    assert.equal(extractJsonObject(j), '{"x":2}');
  });

  test("extracts first {...} from prose preamble", () => {
    const j = 'Sure, here is the plan you asked for:\n{"a":1,"b":[2,3]}\nLet me know!';
    assert.equal(extractJsonObject(j), '{"a":1,"b":[2,3]}');
  });

  test("handles nested braces correctly", () => {
    const j = '{"a":{"b":{"c":1}},"d":2}';
    assert.equal(extractJsonObject(j), j);
  });

  test("ignores braces inside strings", () => {
    const j = '{"k":"value with } brace"}';
    assert.equal(extractJsonObject(j), j);
  });

  test("returns null when no JSON object present", () => {
    assert.equal(extractJsonObject("hello world"), null);
    assert.equal(extractJsonObject(""), null);
  });
});

// ── buildSynthesizerPrompt ──────────────────────────────────────────

describe("buildSynthesizerPrompt", () => {
  test("includes the pipeline digest", () => {
    const p = buildSynthesizerPrompt(mockJob());
    assert.ok(p.includes(RESEARCH_COMPARE_PIPELINE_DIGEST));
  });

  test("fences every untrusted field", () => {
    const p = buildSynthesizerPrompt(mockJob());
    assert.ok(p.includes('<untrusted_input type="topic">'));
    assert.ok(p.includes('<untrusted_input type="user_context">'));
    assert.ok(p.includes('<untrusted_input type="customizations">'));
    assert.ok(p.includes('<untrusted_input type="selected_products">'));
    assert.ok(p.includes('<untrusted_input type="vendor_evaluation">'));
  });

  test("includes the schema hint with schema_version 1", () => {
    const p = buildSynthesizerPrompt(mockJob());
    assert.ok(p.includes('"schema_version": 1'));
    assert.ok(p.includes("depth_target"));
  });

  test("includes the persona depth rubric for synthesizer awareness", () => {
    const p = buildSynthesizerPrompt(mockJob());
    assert.ok(p.includes("Persona Depth"));
    assert.ok(p.includes("executive    = 2"));
    assert.ok(p.includes("expert       = 4"));
  });

  test("includes TOPIC CANONICALIZATION discipline block (S81 #7 v2 G-MIN-2)", () => {
    // S81 #7 regression: e18e1931 system_blocked because the LLM echoed the
    // 603-char user topic into topic_resolved. The discipline block + example
    // are the upstream forcing function. Test asserts both that the block is
    // present AND that it precedes the JSON schema example (G-MIN-1 fix —
    // disciplines must come BEFORE the schema for proper anchoring).
    const p = buildSynthesizerPrompt(mockJob());
    assert.ok(p.includes("TOPIC CANONICALIZATION"));
    assert.ok(p.includes("DO NOT echo the user's full topic verbatim"));
    assert.ok(p.includes("DISTILL to the core decision"));
    assert.ok(p.includes("hard limit 500 chars"));
    // Discipline block precedes the JSON schema example
    const disciplineIdx = p.indexOf("TOPIC CANONICALIZATION");
    const schemaIdx = p.indexOf('"schema_version": 1');
    assert.ok(disciplineIdx >= 0 && schemaIdx >= 0);
    assert.ok(disciplineIdx < schemaIdx, "discipline must precede JSON schema");
  });

  test("schema example references TOPIC CANONICALIZATION as 'above' (S81 #7 v3 COV-2)", () => {
    // Codex COV-2: assert the post-reorder schema-line wording change.
    // Pre-S81 v2 had "See TOPIC CANONICALIZATION below"; G-MIN-1 flipped
    // the discipline above the JSON, so the reference MUST now say "above".
    const p = buildSynthesizerPrompt(mockJob());
    assert.ok(p.includes("See TOPIC CANONICALIZATION above."));
    assert.equal(p.includes("See TOPIC CANONICALIZATION below"), false);
  });

  test("does NOT leak notify_email value", () => {
    const job = mockJob();
    job.notify_email = "secret@example.com";
    const p = buildSynthesizerPrompt(job);
    assert.equal(p.includes("secret@example.com"), false);
    assert.ok(p.includes("Notify email present: yes"));
  });

  test("topic_slug appears as trusted (no fence)", () => {
    const p = buildSynthesizerPrompt(mockJob());
    assert.ok(p.includes("carbon-neutral-cooling"));
    // Should NOT be inside an untrusted_input tag
    const slugIdx = p.indexOf("carbon-neutral-cooling");
    const before = p.slice(0, slugIdx);
    assert.equal(before.includes('<untrusted_input type="topic_slug">'), false);
  });
});

// ── synthesizePlan ──────────────────────────────────────────────────

describe("synthesizePlan", () => {
  test("returns plan on first valid response", async () => {
    const ac = abortableSignal();
    const r = await synthesizePlan(mockJob(), {
      transport: mockTransport(validPlanJson(), 0.8),
      signal: ac.signal,
    });
    assert.equal(r.plan.schema_version, 1);
    assert.equal(r.attempts, 1);
    assert.equal(r.total_cost_usd, 0.8);
    assert.equal(r.model_id, "claude-opus-mock");
  });

  test("retries when first response is malformed, then succeeds", async () => {
    let calls = 0;
    const transport: SynthesisTransport = async () => {
      calls++;
      if (calls === 1) {
        return {
          text: "no json here",
          total_cost_usd: 0.3,
          model_id: "m1",
        };
      }
      return {
        text: validPlanJson(),
        total_cost_usd: 0.5,
        model_id: "m1",
      };
    };
    const ac = abortableSignal();
    const r = await synthesizePlan(mockJob(), {
      transport,
      signal: ac.signal,
      maxAttempts: 2,
    });
    assert.equal(r.attempts, 2);
    assert.equal(r.total_cost_usd, 0.8); // 0.3 + 0.5
  });

  test("throws PlanSynthesisError after maxAttempts of bad JSON", async () => {
    const ac = abortableSignal();
    let calls = 0;
    const transport: SynthesisTransport = async () => {
      calls++;
      return {
        text: "still not valid json",
        total_cost_usd: 0.2,
        model_id: "m1",
      };
    };
    await assert.rejects(
      () =>
        synthesizePlan(mockJob(), {
          transport,
          signal: ac.signal,
          maxAttempts: 3,
        }),
      (err: unknown) => {
        assert.ok(err instanceof PlanSynthesisError);
        const e = err as PlanSynthesisError;
        assert.equal(e.attemptErrors.length, 3);
        // 3 × 0.2 in JS floating-point: avoid strict equality on accumulated sums
        assert.ok(Math.abs(e.total_cost_usd - 0.6) < 1e-9);
        return true;
      },
    );
    assert.equal(calls, 3);
  });

  test("propagates transport error immediately (no retry on network failure)", async () => {
    const ac = abortableSignal();
    let calls = 0;
    const transport: SynthesisTransport = async () => {
      calls++;
      throw new Error("Gemini 503");
    };
    await assert.rejects(
      () =>
        synthesizePlan(mockJob(), {
          transport,
          signal: ac.signal,
          maxAttempts: 3,
        }),
      (err: unknown) => {
        assert.ok(err instanceof PlanSynthesisError);
        const e = err as PlanSynthesisError;
        assert.ok(e.message.includes("transport error"));
        assert.ok(e.message.includes("Gemini 503"));
        return true;
      },
    );
    assert.equal(calls, 1);
  });

  test("returns valid plan on first attempt that retries past schema failures", async () => {
    let calls = 0;
    const transport: SynthesisTransport = async () => {
      calls++;
      if (calls === 1) {
        return {
          text: '{"schema_version": 99}',
          total_cost_usd: 0.1,
          model_id: "m1",
        };
      }
      return {
        text: validPlanJson(),
        total_cost_usd: 0.4,
        model_id: "m1",
      };
    };
    const ac = abortableSignal();
    const r = await synthesizePlan(mockJob(), {
      transport,
      signal: ac.signal,
      maxAttempts: 2,
    });
    assert.equal(r.attempts, 2);
    assert.equal(r.plan.schema_version, 1);
  });

  test("respects abort signal before first call", async () => {
    const ac = abortableSignal();
    ac.abort();
    await assert.rejects(
      () =>
        synthesizePlan(mockJob(), {
          transport: mockTransport(validPlanJson()),
          signal: ac.signal,
        }),
      (err: unknown) => {
        assert.ok(err instanceof PlanSynthesisError);
        assert.ok((err as Error).message.includes("aborted"));
        return true;
      },
    );
  });

  test("rejects maxAttempts < 1", async () => {
    const ac = abortableSignal();
    await assert.rejects(
      () =>
        synthesizePlan(mockJob(), {
          transport: mockTransport(validPlanJson()),
          signal: ac.signal,
          maxAttempts: 0,
        }),
      /maxAttempts/,
    );
  });
});
