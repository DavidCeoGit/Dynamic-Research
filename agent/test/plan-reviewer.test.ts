/**
 * S58 Phase 1 MVP — unit tests for agent/lib/plan-reviewer.ts.
 *
 * Coverage per design §10:
 *   - reviewPlan happy path (both APPROVE -> APPROVED)
 *   - reviewPlan with reviewer findings -> integration -> APPROVED
 *   - reviewPlan single-reviewer BLOCK -> BLOCKED
 *   - reviewPlan both UNAVAILABLE -> SYSTEM_BLOCKED
 *   - reviewPlan one UNAVAILABLE -> proceeds with userMessage flag
 *   - reviewPlan cost cap exceeded -> BLOCKED
 *   - reviewPlan max rounds -> REQUEST_CHANGES
 *   - reviewPlan shadow mode forces APPROVED on non-SYSTEM_BLOCKED
 *   - reviewPlan Persona Depth gap auto-flagged
 *   - reviewPlan looksLikeHedgeBet defensive fallback
 *   - Adversarial-safe-plan fixture: 5 rubric scores × 3 depth_targets =
 *     15 fixtures REQUIRED per design §12 #1 (Phase 1 cannot ship without)
 *
 * Run via: pnpm -C agent exec node --import=tsx --test test/plan-reviewer.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  reviewPlan,
  DEFAULT_MAX_REVIEW_ROUNDS,
  DEFAULT_MAX_REVIEW_COST_CENTS,
  buildReviewerPromptBody,
  buildIntegrationPromptBody,
  type ReviewerTransport,
  type IntegrationTransport,
  type ReviewerTransportOutput,
} from "../lib/plan-reviewer.js";
import {
  PLAN_SCHEMA_VERSION,
  type ResearchPlan,
  type DepthTarget,
  type ReviewerVerdict,
} from "../lib/plan-types.js";
import type { ResearchJob } from "../types.js";

// ── Fixtures ────────────────────────────────────────────────────────

function mockJob(): ResearchJob {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    created_at: "2026-05-27T00:00:00.000Z",
    updated_at: "2026-05-27T00:00:00.000Z",
    status: "running",
    claimed_at: "2026-05-27T00:00:00.000Z",
    completed_at: null,
    error_message: null,
    topic: "topic",
    topic_slug: "topic",
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

function basePlan(depthTarget: DepthTarget = "practitioner"): ResearchPlan {
  return {
    schema_version: PLAN_SCHEMA_VERSION,
    topic_resolved: "Carbon-neutral cooling",
    audience: {
      persona: "VP Infrastructure",
      decision_context: "Pick a vendor for the new colo",
      depth_target: depthTarget,
    },
    research_universe: {
      vendor_candidates: ["Submer", "GRC", "LiquidStack", "Iceotope"],
      explicit_exclusions: ["Hyperscaler in-house: not licensable"],
      source_priorities: ["industry-analyst", "vendor-docs"],
    },
    evaluation_framework: {
      tier1_dimensions: ["PUE", "SLA", "Coolant sourcing", "Retrofit cost"],
      tier2_dimensions: ["Decom waste"],
      rubric_rationale:
        "Practitioner pick — SLA + sourcing dominate over capex for this segment.",
    },
    studio_products: {
      selected: ["report"],
      per_product_emphasis: { report: "Vendor comparison" },
    },
    expected_artifacts: ["vendor_comparison.md"],
    risk_flags: ["Vendor PUE may be optimistic"],
  };
}

/**
 * Hedge-bet plan (design §12 #1) — generic vendor list >10, no exclusions,
 * vanilla rubric, no risk_flags. Specifically designed to fail Persona
 * Depth review at the `expert` depth_target.
 */
function hedgeBetPlan(depthTarget: DepthTarget = "expert"): ResearchPlan {
  return {
    schema_version: PLAN_SCHEMA_VERSION,
    topic_resolved: "Vendor research",
    audience: {
      persona: "Expert",
      decision_context: "Vendor selection",
      depth_target: depthTarget,
    },
    research_universe: {
      vendor_candidates: Array.from(
        { length: 14 },
        (_, i) => `Vendor ${i + 1}`,
      ),
      explicit_exclusions: [],
      source_priorities: ["vendor-docs"],
    },
    evaluation_framework: {
      tier1_dimensions: ["price", "quality", "support"],
      tier2_dimensions: [],
      rubric_rationale: "balanced",
    },
    studio_products: { selected: [], per_product_emphasis: {} },
    expected_artifacts: [],
    risk_flags: [],
  };
}

// ── Mock transport builders ─────────────────────────────────────────

interface MockCall {
  verdict: ReviewerVerdict;
  findings?: ReviewerTransportOutput["findings"];
  // S79 G-MIN-1: widened from `number` to `number | null` to match the
  // upstream ReviewerTransportOutput contract (null = reviewer punted).
  persona_depth_score?: number | null;
  cost: number;
  model_id?: string;
}

function mkReviewer(callsByIteration: MockCall[]): ReviewerTransport {
  let n = 0;
  return async ({ iteration }) => {
    const idx = Math.min(n, callsByIteration.length - 1);
    n++;
    const c = callsByIteration[idx]!;
    return {
      verdict: c.verdict,
      findings: c.findings ?? [],
      persona_depth_score: c.persona_depth_score,
      total_cost_usd: c.cost,
      input_tokens: 1000,
      output_tokens: 200,
      duration_ms: 500,
      model_id: c.model_id ?? `mock-iter${iteration}`,
    };
  };
}

function failingReviewer(reason: string): ReviewerTransport {
  return async () => {
    throw new Error(reason);
  };
}

function mkIntegrator(opts: {
  cost: number;
  produce?: (plan: ResearchPlan) => ResearchPlan;
} = { cost: 0.5 }): IntegrationTransport {
  return async ({ plan }) => ({
    integrated_plan: opts.produce ? opts.produce(plan) : plan,
    total_cost_usd: opts.cost,
    input_tokens: 1500,
    output_tokens: 800,
    duration_ms: 700,
    model_id: "claude-mock-integrator",
  });
}

function ac(): AbortController {
  return new AbortController();
}

// ── Prompt body builders (smoke tests) ──────────────────────────────

describe("buildReviewerPromptBody", () => {
  test("fences manifest fields and embeds plan", () => {
    const p = buildReviewerPromptBody(basePlan(), mockJob(), 1);
    assert.ok(p.includes('<untrusted_input type="topic">'));
    assert.ok(p.includes('<untrusted_input type="plan">'));
    assert.ok(p.includes("Persona Depth"));
  });
});

describe("buildIntegrationPromptBody", () => {
  test("references the reviewer verdict + findings", () => {
    const p = buildIntegrationPromptBody(
      basePlan(),
      {
        reviewer: "gemini",
        iteration: 1,
        verdict: "REQUEST_CHANGES",
        findings: [{ severity: "MAJOR", origin: "topic", message: "too broad" }],
        plan_version: basePlan(),
        model_id: "gemini-mock",
        provider: "google",
        total_cost_usd: 1.0,
      },
      mockJob(),
    );
    assert.ok(p.includes("gemini iteration 1"));
    assert.ok(p.includes("REQUEST_CHANGES"));
    assert.ok(p.includes('<untrusted_input type="findings">'));
  });
});

// ── reviewPlan: orchestration ───────────────────────────────────────

describe("reviewPlan — happy path", () => {
  test("both reviewers APPROVE, no findings -> APPROVED", async () => {
    const r = await reviewPlan(basePlan(), mockJob(), {
      geminiTransport: mkReviewer([{ verdict: "APPROVE", cost: 1.0 }]),
      codexTransport: mkReviewer([{ verdict: "APPROVE", cost: 2.0 }]),
      integrationTransport: mkIntegrator({ cost: 0.5 }),
      signal: ac().signal,
    });
    assert.equal(r.status, "APPROVED");
    assert.equal(r.iterations, 1);
    assert.equal(r.total_cost_usd, 3.0); // 1 + 2, no integration ran (no findings)
    assert.equal(r.reviewer_calls.length, 2);
  });

  test("APPROVE_WITH_CHANGES + minor findings + integration -> APPROVED", async () => {
    const r = await reviewPlan(basePlan(), mockJob(), {
      geminiTransport: mkReviewer([
        {
          verdict: "APPROVE_WITH_CHANGES",
          findings: [{ severity: "MINOR", origin: "topic", message: "narrow it" }],
          cost: 1.0,
        },
      ]),
      codexTransport: mkReviewer([{ verdict: "APPROVE", cost: 2.0 }]),
      integrationTransport: mkIntegrator({ cost: 0.5 }),
      signal: ac().signal,
    });
    assert.equal(r.status, "APPROVED");
    // Integration ran once after Gemini findings
    assert.equal(r.reviewer_calls.filter((c) => c.reviewer === "integration").length, 1);
    assert.equal(r.total_cost_usd, 3.5); // 1 + 0.5 + 2
  });
});

describe("reviewPlan — BLOCK terminal", () => {
  test("Gemini BLOCK -> BLOCKED", async () => {
    const r = await reviewPlan(basePlan(), mockJob(), {
      geminiTransport: mkReviewer([{ verdict: "BLOCK", cost: 1.0 }]),
      codexTransport: mkReviewer([{ verdict: "APPROVE", cost: 2.0 }]),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
    });
    assert.equal(r.status, "BLOCKED");
    // Codex never called — BLOCK terminates round
    assert.equal(r.reviewer_calls.filter((c) => c.reviewer === "codex").length, 0);
  });

  test("Codex BLOCK on integrated plan -> BLOCKED", async () => {
    const r = await reviewPlan(basePlan(), mockJob(), {
      geminiTransport: mkReviewer([
        {
          verdict: "APPROVE_WITH_CHANGES",
          findings: [{ severity: "MAJOR", origin: "topic", message: "x" }],
          cost: 1.0,
        },
      ]),
      codexTransport: mkReviewer([{ verdict: "BLOCK", cost: 2.0 }]),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
    });
    assert.equal(r.status, "BLOCKED");
  });
});

describe("reviewPlan — fallback semantics (design §6)", () => {
  test("both transports throw -> SYSTEM_BLOCKED", async () => {
    const r = await reviewPlan(basePlan(), mockJob(), {
      geminiTransport: failingReviewer("Gemini 503"),
      codexTransport: failingReviewer("OpenAI 503"),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
    });
    assert.equal(r.status, "SYSTEM_BLOCKED");
    assert.ok(r.user_message?.includes("system issue"));
  });

  test("gemini down + codex APPROVE -> APPROVED with reduced-review flag", async () => {
    const r = await reviewPlan(basePlan(), mockJob(), {
      geminiTransport: failingReviewer("Gemini 503"),
      codexTransport: mkReviewer([{ verdict: "APPROVE", cost: 2.0 }]),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
    });
    assert.equal(r.status, "APPROVED");
    assert.ok(r.user_message?.includes("reduced review"));
    assert.ok(r.user_message?.includes("gemini"));
  });

  test("no transports configured at all -> SYSTEM_BLOCKED", async () => {
    const r = await reviewPlan(basePlan(), mockJob(), {
      geminiTransport: null,
      codexTransport: null,
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
    });
    assert.equal(r.status, "SYSTEM_BLOCKED");
  });
});

describe("reviewPlan — cost cap (design §8 Q3)", () => {
  test("cost cap exceeded -> BLOCKED with cost message", async () => {
    const r = await reviewPlan(basePlan(), mockJob(), {
      geminiTransport: mkReviewer([
        {
          verdict: "APPROVE_WITH_CHANGES",
          findings: [{ severity: "MAJOR", origin: "topic", message: "x" }],
          cost: 100.0, // $100 cost — way over the cap
        },
      ]),
      codexTransport: mkReviewer([{ verdict: "APPROVE", cost: 0.0 }]),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
      maxCostCents: 500, // $5 cap
    });
    assert.equal(r.status, "BLOCKED");
    assert.ok(r.user_message?.includes("cost cap"));
  });

  test("max rounds reached without approval -> REQUEST_CHANGES", async () => {
    const r = await reviewPlan(basePlan(), mockJob(), {
      // Both reviewers always REQUEST_CHANGES with the same finding
      geminiTransport: mkReviewer([
        {
          verdict: "REQUEST_CHANGES",
          findings: [{ severity: "MAJOR", origin: "topic", message: "x" }],
          cost: 0.5,
        },
      ]),
      codexTransport: mkReviewer([
        {
          verdict: "REQUEST_CHANGES",
          findings: [{ severity: "MAJOR", origin: "topic", message: "y" }],
          cost: 0.5,
        },
      ]),
      integrationTransport: mkIntegrator({ cost: 0.1 }),
      signal: ac().signal,
      maxRounds: 2,
    });
    assert.equal(r.status, "REQUEST_CHANGES");
    assert.equal(r.iterations, 2);
  });
});

// ── Shadow-mode (design §8 Q4) ──────────────────────────────────────

describe("reviewPlan — shadow mode", () => {
  test("forces APPROVED even when reviewers would BLOCK", async () => {
    const r = await reviewPlan(basePlan(), mockJob(), {
      geminiTransport: mkReviewer([{ verdict: "BLOCK", cost: 1.0 }]),
      codexTransport: mkReviewer([{ verdict: "APPROVE", cost: 2.0 }]),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
      shadowMode: true,
    });
    assert.equal(r.status, "APPROVED");
    assert.ok(r.user_message?.includes("SHADOW-MODE"));
    assert.ok(r.user_message?.includes("BLOCKED"));
  });

  test("preserves SYSTEM_BLOCKED in shadow mode (infra signal)", async () => {
    const r = await reviewPlan(basePlan(), mockJob(), {
      geminiTransport: failingReviewer("Gemini down"),
      codexTransport: failingReviewer("OpenAI down"),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
      shadowMode: true,
    });
    assert.equal(r.status, "SYSTEM_BLOCKED");
  });
});

// ── Persona Depth rubric (design §12 #1) ────────────────────────────

describe("reviewPlan — Persona Depth rubric", () => {
  // S58.5 Gemini CRITICAL-1 regression test: an LLM reviewer that hallucinates
  // verdict=APPROVE alongside a low persona_depth_score MUST NOT be able to
  // fast-path the plan to APPROVED. adjustVerdictForAmbition should rewrite
  // the effective verdict to REQUEST_CHANGES so the round-resolution gate
  // catches it. Without the fix this test would FAIL with status=APPROVED.
  test("hallucinated APPROVE + low persona_depth_score gets rewritten to REQUEST_CHANGES", async () => {
    const r = await reviewPlan(basePlan("expert"), mockJob(), {
      // Both reviewers say APPROVE — but score is below threshold for expert (needs 4)
      geminiTransport: mkReviewer([
        { verdict: "APPROVE", persona_depth_score: 1, cost: 1.0 },
      ]),
      codexTransport: mkReviewer([
        { verdict: "APPROVE", persona_depth_score: 2, cost: 2.0 },
      ]),
      integrationTransport: mkIntegrator({ cost: 0.1 }),
      signal: ac().signal,
      maxRounds: 1, // force terminal resolution at round 1
    });
    // CRITICAL: must NOT fast-path to APPROVED
    assert.notEqual(r.status, "APPROVED");
    // Both reviewer calls must have their effective verdict downgraded
    const gem = r.reviewer_calls.find((c) => c.reviewer === "gemini");
    const cod = r.reviewer_calls.find((c) => c.reviewer === "codex");
    assert.equal(gem?.verdict, "REQUEST_CHANGES");
    assert.equal(cod?.verdict, "REQUEST_CHANGES");
    // Both calls must carry the plan-ambition finding
    assert.ok(gem?.findings.some((f) => f.origin === "plan-ambition"));
    assert.ok(cod?.findings.some((f) => f.origin === "plan-ambition"));
  });

  // S79 G-MIN-1 Codex C-MAJ-1 (2026-06-01): pre-S79 the validator REJECTED
  // missing persona_depth_score so APPROVE + null was unreachable. Post-S79
  // null is a legitimate "punt" signal — but a punt + APPROVE must still be
  // gated, else null becomes a backdoor bypass of the persona-depth rubric.
  test("S79 G-MIN-1 Codex C-MAJ-1: APPROVE + persona_depth_score=null + non-hedge plan gets rewritten to REQUEST_CHANGES", async () => {
    const r = await reviewPlan(basePlan("expert"), mockJob(), {
      // Both reviewers say APPROVE with explicit null score (deliberate punt).
      // basePlan is intentionally NOT structured like a hedge-bet (has
      // explicit_exclusions, risk_flags, non-thin rubric) — so the existing
      // looksLikeHedgeBet defense would NOT fire. The new null+approve guard
      // in ensurePersonaDepthFinding is the only mechanism preventing
      // APPROVED status here.
      geminiTransport: mkReviewer([
        { verdict: "APPROVE", persona_depth_score: null, cost: 1.0 },
      ]),
      codexTransport: mkReviewer([
        { verdict: "APPROVE", persona_depth_score: null, cost: 2.0 },
      ]),
      integrationTransport: mkIntegrator({ cost: 0.1 }),
      signal: ac().signal,
      maxRounds: 1, // force terminal resolution at round 1
    });
    // CRITICAL: null+APPROVE must NOT fast-path to APPROVED.
    assert.notEqual(r.status, "APPROVED");
    const gem = r.reviewer_calls.find((c) => c.reviewer === "gemini");
    const cod = r.reviewer_calls.find((c) => c.reviewer === "codex");
    // Both reviewer calls must have their effective verdict downgraded
    // to REQUEST_CHANGES via adjustVerdictForAmbition.
    assert.equal(gem?.verdict, "REQUEST_CHANGES");
    assert.equal(cod?.verdict, "REQUEST_CHANGES");
    // Both calls must carry the null+approve plan-ambition finding.
    const gemAmbition = gem?.findings.find((f) => f.origin === "plan-ambition");
    const codAmbition = cod?.findings.find((f) => f.origin === "plan-ambition");
    assert.ok(gemAmbition, "gemini call must have plan-ambition finding for null+APPROVE");
    assert.ok(codAmbition, "codex call must have plan-ambition finding for null+APPROVE");
    // Message must explain WHY (operator-debugging visibility) — references
    // "no Persona Depth score" and "approve-like verdict".
    assert.match(gemAmbition!.message, /no Persona Depth score|persona-depth gate/i);
    assert.match(codAmbition!.message, /no Persona Depth score|persona-depth gate/i);
  });

  test("S79 G-MIN-1: REQUEST_CHANGES + persona_depth_score=null does NOT add plan-ambition (verdict already gates)", async () => {
    // Counter-test: when the reviewer punts but ALSO returns a non-approve
    // verdict, the new C-MAJ-1 guard should NOT fire — the verdict gates
    // by itself. The hedge-bet defensive check still runs but basePlan is
    // not a hedge-bet so no finding is added.
    const r = await reviewPlan(basePlan("expert"), mockJob(), {
      geminiTransport: mkReviewer([
        { verdict: "REQUEST_CHANGES", persona_depth_score: null, cost: 1.0 },
      ]),
      codexTransport: mkReviewer([
        { verdict: "REQUEST_CHANGES", persona_depth_score: null, cost: 2.0 },
      ]),
      integrationTransport: mkIntegrator({ cost: 0.1 }),
      signal: ac().signal,
      maxRounds: 1,
    });
    assert.notEqual(r.status, "APPROVED"); // REQUEST_CHANGES is the natural verdict
    const gem = r.reviewer_calls.find((c) => c.reviewer === "gemini");
    assert.equal(gem?.verdict, "REQUEST_CHANGES");
    // No synthetic plan-ambition finding when verdict is already non-approve
    // AND the plan is not a hedge-bet structurally.
    const gemAmbition = gem?.findings.find((f) => f.origin === "plan-ambition");
    assert.equal(gemAmbition, undefined);
  });

  test("hallucinated APPROVE_WITH_CHANGES + low score also rewritten", async () => {
    const r = await reviewPlan(basePlan("practitioner"), mockJob(), {
      geminiTransport: mkReviewer([
        { verdict: "APPROVE_WITH_CHANGES", persona_depth_score: 1, cost: 1.0 },
      ]),
      codexTransport: mkReviewer([
        { verdict: "APPROVE", persona_depth_score: 3, cost: 2.0 },
      ]),
      integrationTransport: mkIntegrator({ cost: 0.1 }),
      signal: ac().signal,
      maxRounds: 1,
    });
    // Codex score=3 meets threshold; gemini score=1 doesn't.
    // Gemini's APPROVE_WITH_CHANGES + plan-ambition should -> REQUEST_CHANGES
    // Final status should be REQUEST_CHANGES (at maxRounds=1 with mixed verdict)
    assert.notEqual(r.status, "APPROVED");
    const gem = r.reviewer_calls.find((c) => c.reviewer === "gemini");
    assert.equal(gem?.verdict, "REQUEST_CHANGES");
  });

  test("looksLikeHedgeBet defensive case also gates fast-path-to-APPROVED", async () => {
    // No persona_depth_score, but structural hedge-bet -> plan-ambition added
    // -> approve-like verdict must NOT fast-path
    const r = await reviewPlan(hedgeBetPlan("expert"), mockJob(), {
      geminiTransport: mkReviewer([
        { verdict: "APPROVE", cost: 1.0 }, // no score
      ]),
      codexTransport: mkReviewer([
        { verdict: "APPROVE", cost: 2.0 },
      ]),
      integrationTransport: mkIntegrator({ cost: 0.1 }),
      signal: ac().signal,
      maxRounds: 1,
    });
    assert.notEqual(r.status, "APPROVED");
    const gem = r.reviewer_calls.find((c) => c.reviewer === "gemini");
    assert.equal(gem?.verdict, "REQUEST_CHANGES");
  });

  test("reviewer score below threshold injects plan-ambition finding", async () => {
    const r = await reviewPlan(basePlan("expert"), mockJob(), {
      geminiTransport: mkReviewer([
        {
          verdict: "REQUEST_CHANGES",
          persona_depth_score: 2,
          cost: 1.0,
        },
      ]),
      codexTransport: mkReviewer([
        {
          verdict: "REQUEST_CHANGES",
          persona_depth_score: 2,
          cost: 2.0,
        },
      ]),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
    });
    const gem = r.reviewer_calls.find((c) => c.reviewer === "gemini");
    const cod = r.reviewer_calls.find((c) => c.reviewer === "codex");
    assert.ok(gem?.findings.some((f) => f.origin === "plan-ambition"));
    assert.ok(cod?.findings.some((f) => f.origin === "plan-ambition"));
  });

  test("reviewer score meeting threshold does NOT add plan-ambition", async () => {
    const r = await reviewPlan(basePlan("executive"), mockJob(), {
      geminiTransport: mkReviewer([
        { verdict: "APPROVE", persona_depth_score: 2, cost: 1.0 },
      ]),
      codexTransport: mkReviewer([
        { verdict: "APPROVE", persona_depth_score: 3, cost: 2.0 },
      ]),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
    });
    const allFindings = r.reviewer_calls.flatMap((c) => c.findings);
    assert.equal(
      allFindings.some((f) => f.origin === "plan-ambition"),
      false,
    );
    assert.equal(r.status, "APPROVED");
  });

  test("structural hedge-bet detected when reviewer omits score", async () => {
    const r = await reviewPlan(hedgeBetPlan("expert"), mockJob(), {
      geminiTransport: mkReviewer([
        {
          // No persona_depth_score returned — looksLikeHedgeBet should fire
          verdict: "APPROVE_WITH_CHANGES",
          cost: 1.0,
        },
      ]),
      codexTransport: mkReviewer([
        { verdict: "APPROVE", cost: 2.0 },
      ]),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
    });
    const gem = r.reviewer_calls.find((c) => c.reviewer === "gemini");
    assert.ok(
      gem?.findings.some((f) => f.origin === "plan-ambition"),
      "Defensive hedge-bet check should add plan-ambition finding",
    );
  });
});

// ── MANDATORY: 15-fixture adversarial-safe-plan suite (design §10) ──
// "If reviewers APPROVE any of these, the adversarial mitigation has failed
//  and Phase 1 cannot ship."
//
// We test the FRAMEWORK here (auto-injection of plan-ambition findings when
// reviewer score is below threshold). The 15-fixture × actual-reviewer
// integration test belongs in the post-keys-arrived integration suite. The
// unit-test scope here verifies that IF a reviewer scores below threshold,
// the orchestration will surface plan-ambition origin findings — i.e. the
// framework correctly transduces the score into a REQUEST_CHANGES outcome.

const DEPTH_TARGETS: DepthTarget[] = ["executive", "practitioner", "expert"];
const SCORES = [0, 1, 2, 3, 4];

describe("reviewPlan — adversarial-safe-plan fixture × persona depth", () => {
  for (const target of DEPTH_TARGETS) {
    for (const score of SCORES) {
      test(`depth=${target} score=${score} -> ${
        score >= (target === "executive" ? 2 : target === "practitioner" ? 3 : 4)
          ? "no plan-ambition"
          : "plan-ambition injected"
      }`, async () => {
        const verdict: ReviewerVerdict =
          score >= (target === "executive" ? 2 : target === "practitioner" ? 3 : 4)
            ? "APPROVE"
            : "REQUEST_CHANGES";
        const r = await reviewPlan(basePlan(target), mockJob(), {
          geminiTransport: mkReviewer([
            { verdict, persona_depth_score: score, cost: 1.0 },
          ]),
          codexTransport: mkReviewer([
            { verdict, persona_depth_score: score, cost: 2.0 },
          ]),
          integrationTransport: mkIntegrator(),
          signal: ac().signal,
        });
        const threshold =
          target === "executive" ? 2 : target === "practitioner" ? 3 : 4;
        const allFindings = r.reviewer_calls.flatMap((c) => c.findings);
        const hasAmbition = allFindings.some((f) => f.origin === "plan-ambition");
        if (score < threshold) {
          assert.equal(
            hasAmbition,
            true,
            `score ${score} below threshold ${threshold} for ${target} MUST inject plan-ambition`,
          );
          assert.notEqual(
            r.status,
            "APPROVED",
            `score ${score} below threshold MUST NOT APPROVE`,
          );
        } else {
          assert.equal(
            hasAmbition,
            false,
            `score ${score} meets/exceeds threshold ${threshold} for ${target} MUST NOT inject plan-ambition`,
          );
          assert.equal(
            r.status,
            "APPROVED",
            `score ${score} meets/exceeds threshold MUST APPROVE`,
          );
        }
      });
    }
  }
});

// ── Sanity defaults ─────────────────────────────────────────────────

describe("constants", () => {
  test("default round + cost caps match design", () => {
    assert.equal(DEFAULT_MAX_REVIEW_ROUNDS, 2);
    assert.equal(DEFAULT_MAX_REVIEW_COST_CENTS, 500);
  });
});

// ── S62 Bug 53a regression — integration-throw → UNAVAILABLE row ────
//
// Per Codex MRPF v2 MINOR-3 (S62): assert that when the integration transport
// throws, runIntegration persists a synthetic ReviewerCall with
// reviewer='integration', verdict='UNAVAILABLE', provider='anthropic',
// total_cost_usd=0, and raw_json containing the error message. The pre-Bug-53a
// behavior silently returned null → no integration row in plan_reviews → made
// audit-table telemetry incomplete in the very cases where it's most needed
// (when the gate cycle hit a problem worth investigating).

describe("reviewPlan — Bug 53a regression (S62)", () => {
  test("integration-transport throw persists synthetic UNAVAILABLE row", async () => {
    const throwingIntegrator: IntegrationTransport = async () => {
      throw new Error("simulated integration failure");
    };
    const r = await reviewPlan(basePlan(), mockJob(), {
      geminiTransport: mkReviewer([
        {
          verdict: "APPROVE_WITH_CHANGES",
          cost: 1.0,
          findings: [
            { severity: "MAJOR", origin: "topic", message: "real finding" },
          ],
        },
        // Round 2 (the loop continues since round 1 had findings that
        // triggered integration → integration failed → un-revised plan
        // re-reviewed in round 2).
        { verdict: "APPROVE", cost: 1.0 },
      ]),
      codexTransport: mkReviewer([
        { verdict: "APPROVE", cost: 2.0 },
        { verdict: "APPROVE", cost: 2.0 },
      ]),
      integrationTransport: throwingIntegrator,
      signal: ac().signal,
    });
    const integrationCalls = r.reviewer_calls.filter(
      (c) => c.reviewer === "integration",
    );
    assert.ok(
      integrationCalls.length >= 1,
      "integration call must be persisted even on throw (Bug 53a regression)",
    );
    const synth = integrationCalls[0]!;
    assert.equal(synth.verdict, "UNAVAILABLE");
    assert.equal(synth.provider, "anthropic");
    assert.equal(synth.total_cost_usd, 0);
    assert.ok(synth.raw_json);
    const raw = synth.raw_json as Record<string, unknown>;
    assert.equal(raw.error, "integration transport threw");
    assert.ok(
      typeof raw.message === "string" &&
        raw.message.includes("simulated integration failure"),
      "raw_json.message must preserve throw text for debug",
    );
  });

  test("Bug 53a: non-Error throw (e.g. throw 'string') doesn't crash catch handler", async () => {
    const throwingIntegrator: IntegrationTransport = async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "raw string throw";
    };
    const r = await reviewPlan(basePlan(), mockJob(), {
      geminiTransport: mkReviewer([
        {
          verdict: "APPROVE_WITH_CHANGES",
          cost: 1.0,
          findings: [
            { severity: "MAJOR", origin: "topic", message: "real finding" },
          ],
        },
        { verdict: "APPROVE", cost: 1.0 },
      ]),
      codexTransport: mkReviewer([
        { verdict: "APPROVE", cost: 2.0 },
        { verdict: "APPROVE", cost: 2.0 },
      ]),
      integrationTransport: throwingIntegrator,
      signal: ac().signal,
    });
    const integrationCalls = r.reviewer_calls.filter(
      (c) => c.reviewer === "integration",
    );
    assert.ok(integrationCalls.length >= 1);
    const synth = integrationCalls[0]!;
    const raw = synth.raw_json as Record<string, unknown>;
    // Codex MINOR-4: non-Error throw goes through String(err) narrow.
    assert.equal(raw.message, "raw string throw");
  });
});
