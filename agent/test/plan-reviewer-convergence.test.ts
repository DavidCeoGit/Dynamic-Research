/**
 * S85 plan-review convergence — tests for the severity-graded terminal ladder
 * (Documentation/plan-review-convergence-design-gate.md §4 + §9 test plan).
 *
 * Two layers:
 *   1. decideTerminal() pure-function tests — R1..R5 + the 2-vs-3 MAJOR boundary.
 *   2. reviewPlan() integration tests — dark-launch (ladderEnforce off),
 *      enforcement (R5 → APPROVED + reservations), final-round-only counting,
 *      one-reviewer-down early-exit, preserved hard gates, shadow-mode logging.
 *
 * Run: pnpm -C agent exec node --import=tsx --test test/plan-reviewer-convergence.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  reviewPlan,
  decideTerminal,
  MAX_RESERVATION_MAJORS,
  type ReviewerTransport,
  type IntegrationTransport,
  type ReviewerTransportOutput,
} from "../lib/plan-reviewer.js";
import {
  PLAN_SCHEMA_VERSION,
  type ResearchPlan,
  type DepthTarget,
  type ReviewerCall,
  type ReviewFinding,
  type ReviewerVerdict,
} from "../lib/plan-types.js";
import type { ResearchJob } from "../types.js";

// ── Fixtures ────────────────────────────────────────────────────────

function mockJob(): ResearchJob {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    created_at: "2026-06-03T00:00:00.000Z",
    updated_at: "2026-06-03T00:00:00.000Z",
    status: "running",
    claimed_at: "2026-06-03T00:00:00.000Z",
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

// practitioner depth_target → persona-depth threshold 3 (so persona_depth_score
// 3 produces no auto-injected plan-ambition finding).
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

// A structural hedge-bet: >=3 of {>10 vendors+0 exclusions, 0 risk_flags, 0
// exclusions, thin rubric}. Strips basePlan to 0 exclusions + 0 risk_flags + empty
// rubric_rationale (3 flags) so looksLikeHedgeBet() fires. Used to exercise the
// THIRD ensurePersonaDepthFinding injection trigger (no score → structural check).
function hedgeBetPlan(depthTarget: DepthTarget = "expert"): ResearchPlan {
  const p = basePlan(depthTarget);
  return {
    ...p,
    research_universe: { ...p.research_universe, explicit_exclusions: [] },
    evaluation_framework: { ...p.evaluation_framework, rubric_rationale: "" },
    risk_flags: [],
  };
}

// ── decideTerminal() pure-function helpers ──────────────────────────

function mkCall(
  reviewer: "gemini" | "codex",
  verdict: ReviewerVerdict,
  findings: ReviewFinding[],
): ReviewerCall {
  return {
    reviewer,
    iteration: 2,
    verdict,
    findings,
    plan_version: basePlan(),
    model_id: `${reviewer}-mock`,
    provider: reviewer === "gemini" ? "google" : "openai",
    total_cost_usd: 1.0,
  };
}

const MAJOR = (origin: ReviewFinding["origin"], message = "m"): ReviewFinding => ({
  severity: "MAJOR",
  origin,
  message,
});
const MINOR = (origin: ReviewFinding["origin"], message = "m"): ReviewFinding => ({
  severity: "MINOR",
  origin,
  message,
});
const CRIT = (origin: ReviewFinding["origin"], message = "m"): ReviewFinding => ({
  severity: "CRITICAL",
  origin,
  message,
});
// S155: a SYSTEM-injected MAJOR plan-ambition (injected:true) — the R2a anti-bypass
// class (the persona-depth gate). Reviewer-AUTHORED findings use MAJOR()/MINOR()/CRIT()
// (no injected flag) and route to R2b (corroboration-gated) / R4 / R5.
const MAJOR_INJ = (
  origin: ReviewFinding["origin"],
  message = "m",
): ReviewFinding => ({
  severity: "MAJOR",
  origin,
  injected: true,
  message,
});

// ── Mock transports (for reviewPlan integration tests) ──────────────

interface MockCall {
  verdict: ReviewerVerdict;
  findings?: ReviewFinding[];
  persona_depth_score?: number | null;
  cost: number;
}

function mkReviewer(callsByIteration: MockCall[]): ReviewerTransport {
  let n = 0;
  return async ({ iteration }): Promise<ReviewerTransportOutput> => {
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
      model_id: `mock-iter${iteration}`,
    };
  };
}

function mkIntegrator(): IntegrationTransport {
  return async ({ plan }) => ({
    integrated_plan: plan, // passthrough — findings persist on the reviewer call
    total_cost_usd: 0.1,
    input_tokens: 1500,
    output_tokens: 800,
    duration_ms: 700,
    model_id: "claude-mock-integrator",
  });
}

function ac(): AbortController {
  return new AbortController();
}

// ── decideTerminal() — the severity-graded ladder (design §4) ───────

describe("decideTerminal — severity-graded ladder", () => {
  test("R1: any CRITICAL blocks (even with an approve-like reviewer)", () => {
    const d = decideTerminal([
      mkCall("gemini", "APPROVE", []),
      mkCall("codex", "REQUEST_CHANGES", [CRIT("topic")]),
    ]);
    assert.equal(d.rule, "R1");
    assert.equal(d.wouldApprove, false);
    assert.equal(d.reservations.length, 0);
  });

  test("R2a: an INJECTED MAJOR plan-ambition (system anti-bypass) blocks unconditionally even when other reviewer approves", () => {
    const d = decideTerminal([
      mkCall("gemini", "APPROVE", []),
      mkCall("codex", "REQUEST_CHANGES", [MAJOR_INJ("plan-ambition")]),
    ]);
    assert.equal(d.rule, "R2");
    assert.equal(d.wouldApprove, false);
  });

  test("R3: no approve-like reviewer (both reject) blocks", () => {
    const d = decideTerminal([
      mkCall("gemini", "REQUEST_CHANGES", [MAJOR("topic")]),
      mkCall("codex", "REQUEST_CHANGES", [MAJOR("scoring-rubric")]),
    ]);
    assert.equal(d.rule, "R3");
    assert.equal(d.wouldApprove, false);
  });

  test("R4: 3 unresolved non-critical MAJORs (> bound) blocks", () => {
    const d = decideTerminal([
      mkCall("gemini", "APPROVE", []),
      mkCall("codex", "REQUEST_CHANGES", [
        MAJOR("scoring-rubric"),
        MAJOR("source-strategy"),
        MAJOR("vendor-evaluation"),
      ]),
    ]);
    assert.equal(d.rule, "R4");
    assert.equal(d.wouldApprove, false);
  });

  test("R5 boundary: exactly 2 MAJORs (= bound) proceeds — the e18e1931 case", () => {
    assert.equal(MAX_RESERVATION_MAJORS, 2); // guards against accidental retune
    const d = decideTerminal([
      mkCall("gemini", "APPROVE", []),
      mkCall("codex", "REQUEST_CHANGES", [
        MAJOR("scoring-rubric", "operationalize success metrics"),
        MAJOR("source-strategy", "add rubric weights"),
        MINOR("topic"),
        MINOR("persona"),
      ]),
    ]);
    assert.equal(d.rule, "R5");
    assert.equal(d.wouldApprove, true);
    // reservations = ALL final-round findings (2 MAJOR + 2 MINOR), non-critical
    assert.equal(d.reservations.length, 4);
    assert.ok(d.reservations.every((f) => f.severity !== "CRITICAL"));
  });

  test("R5: reachable mixed verdict — one approve-like + one REQUEST_CHANGES w/ 1 MAJOR → proceed", () => {
    // Codex MERGE-gate MINOR: decideTerminal's documented precondition is that
    // the mid-loop all-approve early-exit did NOT fire. Two approve-like calls
    // is an UNREACHABLE input (real reviewPlan would early-exit to plain
    // APPROVED before the ladder runs). Use a reachable terminal state: codex
    // REQUEST_CHANGES → allApprove false → ladder runs. gemini
    // APPROVE_WITH_CHANGES is approve-like → R5, single non-critical MAJOR
    // recorded as a reservation.
    const d = decideTerminal([
      mkCall("gemini", "APPROVE_WITH_CHANGES", []),
      mkCall("codex", "REQUEST_CHANGES", [MAJOR("topic")]),
    ]);
    assert.equal(d.rule, "R5");
    assert.equal(d.reservations.length, 1);
  });

  test("ladder precedence: CRITICAL outranks anti-bypass + volume", () => {
    const d = decideTerminal([
      mkCall("gemini", "APPROVE", []),
      mkCall("codex", "REQUEST_CHANGES", [
        CRIT("topic"),
        MAJOR_INJ("plan-ambition"),
        MAJOR("scoring-rubric"),
        MAJOR("source-strategy"),
        MAJOR("vendor-evaluation"),
      ]),
    ]);
    assert.equal(d.rule, "R1");
  });

  // ── S86 R2 anti-bypass severity refinement (design §3a, §7) ─────────
  // R2 fires only on MAJOR+ `plan-ambition`; organic MINOR notes fall through.

  test("R2a (S86/S155): an INJECTED MAJOR plan-ambition still blocks (persona-depth invariant preserved)", () => {
    const d = decideTerminal([
      mkCall("gemini", "APPROVE", []),
      mkCall("codex", "REQUEST_CHANGES", [MAJOR_INJ("plan-ambition")]),
    ]);
    assert.equal(d.rule, "R2");
  });

  test("R1 (S86): CRITICAL plan-ambition routes to R1, not R2 (CRITICAL arm of predicate never shadows R1)", () => {
    const d = decideTerminal([
      mkCall("gemini", "APPROVE", []),
      mkCall("codex", "REQUEST_CHANGES", [CRIT("plan-ambition")]),
    ]);
    assert.equal(d.rule, "R1");
  });

  test("R5 (S86): MINOR plan-ambition only + approve-like + ≤2 MAJOR → R5, MINOR surfaced as reservation (e18e1931 shape)", () => {
    const d = decideTerminal([
      mkCall("gemini", "APPROVE", []),
      mkCall("codex", "REQUEST_CHANGES", [
        MAJOR("scoring-rubric", "operationalize success metrics"),
        MAJOR("source-strategy", "add rubric weights"),
        MINOR("plan-ambition", "right-size deliverables to the $10-30 budget"),
      ]),
    ]);
    assert.equal(d.rule, "R5");
    assert.equal(d.wouldApprove, true);
    // the MINOR plan-ambition is NOT discarded — it rides through as a reservation
    assert.ok(
      d.reservations.some(
        (f) => f.origin === "plan-ambition" && f.severity === "MINOR",
      ),
    );
  });

  test("R4 (S86): MINOR plan-ambition + 3 non-ambition MAJORs → R4 (MINOR falls through R2; volume bound still fires)", () => {
    const d = decideTerminal([
      mkCall("gemini", "APPROVE", []),
      mkCall("codex", "REQUEST_CHANGES", [
        MINOR("plan-ambition", "right-size sampling to budget"),
        MAJOR("scoring-rubric"),
        MAJOR("source-strategy"),
        MAJOR("vendor-evaluation"),
      ]),
    ]);
    assert.equal(d.rule, "R4");
  });

  test("R3 (S86, residual edge): MINOR plan-ambition + no approve-like reviewer → R3 (documented limitation)", () => {
    const d = decideTerminal([
      mkCall("gemini", "REQUEST_CHANGES", [
        MINOR("plan-ambition", "right-size to budget"),
      ]),
      mkCall("codex", "REQUEST_CHANGES", [
        MINOR("plan-ambition", "trim scope"),
      ]),
    ]);
    assert.equal(d.rule, "R3");
  });

  test("R5 (S86 transparency, Gemini §7.6): one APPROVE + one REQUEST_CHANGES carrying only a MINOR plan-ambition → R5 with note preserved", () => {
    // Mirrors the post-adjustVerdictForAmbition terminal shape: a reviewer whose
    // raw APPROVE was flipped to REQUEST_CHANGES by a MINOR plan-ambition still
    // lands at R5 (the OTHER reviewer is approve-like) and the note survives as a
    // reservation rather than being silently dropped.
    const d = decideTerminal([
      mkCall("gemini", "APPROVE", []),
      mkCall("codex", "REQUEST_CHANGES", [
        MINOR("plan-ambition", "right-size deliverables to budget"),
      ]),
    ]);
    assert.equal(d.rule, "R5");
    assert.equal(d.reservations.length, 1);
    assert.equal(d.reservations[0]!.origin, "plan-ambition");
    assert.equal(d.reservations[0]!.severity, "MINOR");
  });
});

// ── S155 R2 injected-vs-authored split (657161bb over-match fix) ────
// decideTerminal now distinguishes the SYSTEM-injected anti-bypass (R2a,
// unconditional = the persona-depth gate) from a reviewer-AUTHORED MAJOR+
// plan-ambition (R2b, blocks only when corroborated by >=2 reviewers). A LONE
// authored finding (the stochastic-mislabel case that false-blocked job 657161bb)
// falls through to R4/R5 instead of hard-blocking.

describe("decideTerminal — S155 R2 injected-vs-authored split", () => {
  test("R2b: a LONE authored MAJOR plan-ambition no longer blocks — falls to R5 with the note surfaced (657161bb regression)", () => {
    const d = decideTerminal([
      mkCall("gemini", "APPROVE", []),
      mkCall("codex", "REQUEST_CHANGES", [
        MAJOR("plan-ambition", "cites unverified §4628(j)"),
      ]),
    ]);
    assert.equal(d.rule, "R5");
    assert.equal(d.wouldApprove, true);
    assert.ok(
      d.reservations.some(
        (f) => f.origin === "plan-ambition" && f.severity === "MAJOR",
      ),
      "the lone authored MAJOR plan-ambition must survive as a reservation, not vanish",
    );
  });

  test("correctly-labelled accuracy concern (authored MAJOR source-strategy) is advisory → R5", () => {
    const d = decideTerminal([
      mkCall("gemini", "APPROVE", []),
      mkCall("codex", "REQUEST_CHANGES", [
        MAJOR("source-strategy", "verify the §4628(j) citation"),
      ]),
    ]);
    assert.equal(d.rule, "R5");
    assert.ok(d.reservations.some((f) => f.origin === "source-strategy"));
  });

  test("R2b: CORROBORATED authored MAJOR plan-ambition (both reviewers each raise one) still blocks", () => {
    const d = decideTerminal([
      mkCall("gemini", "REQUEST_CHANGES", [
        MAJOR("plan-ambition", "under-scoped for expert depth"),
      ]),
      mkCall("codex", "REQUEST_CHANGES", [
        MAJOR("plan-ambition", "generic vendor list"),
      ]),
    ]);
    assert.equal(d.rule, "R2");
    assert.equal(d.wouldApprove, false);
  });

  test("R4: a lone authored MAJOR plan-ambition + 2 other authored MAJORs (3 total) → R4 volume bound", () => {
    const d = decideTerminal([
      mkCall("gemini", "APPROVE", []),
      mkCall("codex", "REQUEST_CHANGES", [
        MAJOR("plan-ambition", "lone authored ambition note"),
        MAJOR("scoring-rubric"),
        MAJOR("source-strategy"),
      ]),
    ]);
    assert.equal(d.rule, "R4");
  });

  test("R2a outranks R2b: an INJECTED anti-bypass blocks with ONE reviewer (no corroboration required)", () => {
    const d = decideTerminal([
      mkCall("gemini", "APPROVE", []),
      mkCall("codex", "REQUEST_CHANGES", [MAJOR_INJ("plan-ambition")]),
    ]);
    assert.equal(d.rule, "R2");
  });
});

// ── reviewPlan() integration — dark-launch vs enforcement ───────────

describe("reviewPlan — terminal ladder integration", () => {
  // The e18e1931 shape: Gemini APPROVE, Codex REQUEST_CHANGES with 2 non-
  // critical MAJORs, no CRITICAL/anti-bypass → ladder rule R5.
  function e18Transports() {
    return {
      geminiTransport: mkReviewer([
        { verdict: "APPROVE", persona_depth_score: 3, cost: 1.0 },
      ]),
      codexTransport: mkReviewer([
        {
          verdict: "REQUEST_CHANGES",
          persona_depth_score: 3,
          findings: [
            MAJOR("scoring-rubric", "operationalize success metrics"),
            MAJOR("source-strategy", "add rubric weights"),
          ],
          cost: 1.0,
        },
      ]),
      integrationTransport: mkIntegrator(),
    };
  }

  test("dark-launch (ladderEnforce off): R5 computed + recorded but emits legacy REQUEST_CHANGES", async () => {
    const r = await reviewPlan(basePlan(), mockJob(), {
      ...e18Transports(),
      signal: ac().signal,
      maxRounds: 1, // force terminal at round 1
      // ladderEnforce omitted → default dark-launch
    });
    assert.equal(r.status, "REQUEST_CHANGES"); // production behavior unchanged
    assert.equal(r.terminal_decision, "R5"); // ...but the decision is recorded
    assert.equal(r.reservations?.length, 2); // ...and would-be reservations captured
  });

  test("enforcement (ladderEnforce on): R5 → APPROVED + reservations populated", async () => {
    const r = await reviewPlan(basePlan(), mockJob(), {
      ...e18Transports(),
      signal: ac().signal,
      maxRounds: 1,
      ladderEnforce: true,
    });
    assert.equal(r.status, "APPROVED");
    assert.equal(r.terminal_decision, "R5");
    assert.equal(r.reservations?.length, 2);
  });

  test("R4 block holds under enforcement: 3 MAJORs → REQUEST_CHANGES", async () => {
    const r = await reviewPlan(basePlan(), mockJob(), {
      geminiTransport: mkReviewer([
        { verdict: "APPROVE", persona_depth_score: 3, cost: 1.0 },
      ]),
      codexTransport: mkReviewer([
        {
          verdict: "REQUEST_CHANGES",
          persona_depth_score: 3,
          findings: [
            MAJOR("scoring-rubric"),
            MAJOR("source-strategy"),
            MAJOR("vendor-evaluation"),
          ],
          cost: 1.0,
        },
      ]),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
      maxRounds: 1,
      ladderEnforce: true,
    });
    assert.equal(r.status, "REQUEST_CHANGES");
    assert.equal(r.terminal_decision, "R4");
  });

  test("final-round counting: a round-1 MAJOR (integrated) does NOT count toward R4", async () => {
    // Round 1: both REQUEST_CHANGES with 1 MAJOR each (4 cumulative MAJORs
    // across both rounds). Round 2: clean split — Gemini APPROVE, Codex
    // REQUEST_CHANGES with exactly 2 MAJORs. The ladder must see only the
    // round-2 availableCalls (2 MAJORs → R5), not the cumulative 4 (→ R4).
    const r = await reviewPlan(basePlan(), mockJob(), {
      geminiTransport: mkReviewer([
        {
          verdict: "REQUEST_CHANGES",
          persona_depth_score: 3,
          findings: [MAJOR("topic")],
          cost: 0.5,
        },
        { verdict: "APPROVE", persona_depth_score: 3, cost: 0.5 },
      ]),
      codexTransport: mkReviewer([
        {
          verdict: "REQUEST_CHANGES",
          persona_depth_score: 3,
          findings: [MAJOR("persona")],
          cost: 0.5,
        },
        {
          verdict: "REQUEST_CHANGES",
          persona_depth_score: 3,
          findings: [MAJOR("scoring-rubric"), MAJOR("source-strategy")],
          cost: 0.5,
        },
      ]),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
      maxRounds: 2,
      ladderEnforce: true,
    });
    assert.equal(r.status, "APPROVED");
    assert.equal(r.terminal_decision, "R5");
    assert.equal(r.iterations, 2);
    // reservations reflect ONLY the final round (2 MAJORs), not cumulative 4.
    assert.equal(r.reservations?.length, 2);
  });

  test("one-reviewer-down at terminal, available approve-like → plain APPROVED via early-exit (no ladder, no reservations)", async () => {
    const r = await reviewPlan(basePlan(), mockJob(), {
      geminiTransport: mkReviewer([
        { verdict: "APPROVE", persona_depth_score: 3, cost: 1.0 },
      ]),
      codexTransport: null, // unavailable
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
      maxRounds: 1,
      ladderEnforce: true,
    });
    assert.equal(r.status, "APPROVED");
    assert.equal(r.terminal_decision, undefined); // early-exit, ladder never ran
    assert.ok(!r.reservations || r.reservations.length === 0);
    assert.ok(r.user_message?.includes("reduced review"));
  });

  test("one-reviewer-down at terminal, available REQUEST_CHANGES → ladder R3 blocks", async () => {
    const r = await reviewPlan(basePlan(), mockJob(), {
      geminiTransport: mkReviewer([
        {
          verdict: "REQUEST_CHANGES",
          persona_depth_score: 3,
          findings: [MAJOR("topic")],
          cost: 1.0,
        },
      ]),
      codexTransport: null,
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
      maxRounds: 1,
      ladderEnforce: true,
    });
    assert.equal(r.status, "REQUEST_CHANGES");
    assert.equal(r.terminal_decision, "R3");
  });

  test("preserved hard gate: reviewer BLOCK → BLOCKED, ladder never runs", async () => {
    const r = await reviewPlan(basePlan(), mockJob(), {
      geminiTransport: mkReviewer([{ verdict: "BLOCK", cost: 1.0 }]),
      codexTransport: mkReviewer([{ verdict: "APPROVE", cost: 1.0 }]),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
      maxRounds: 1,
      ladderEnforce: true,
    });
    assert.equal(r.status, "BLOCKED");
    assert.equal(r.terminal_decision, undefined);
  });

  test("early-exit unaffected: both APPROVE round 1 → APPROVED, no terminal_decision", async () => {
    const r = await reviewPlan(basePlan(), mockJob(), {
      geminiTransport: mkReviewer([
        { verdict: "APPROVE", persona_depth_score: 3, cost: 1.0 },
      ]),
      codexTransport: mkReviewer([
        { verdict: "APPROVE", persona_depth_score: 3, cost: 1.0 },
      ]),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
      ladderEnforce: true,
    });
    assert.equal(r.status, "APPROVED");
    assert.equal(r.terminal_decision, undefined);
  });

  test("shadow mode: ladder would block (R3) but status forced APPROVED — decision still logged", async () => {
    const r = await reviewPlan(basePlan(), mockJob(), {
      geminiTransport: mkReviewer([
        {
          verdict: "REQUEST_CHANGES",
          persona_depth_score: 3,
          findings: [MAJOR("topic")],
          cost: 1.0,
        },
      ]),
      codexTransport: mkReviewer([
        {
          verdict: "REQUEST_CHANGES",
          persona_depth_score: 3,
          findings: [MAJOR("scoring-rubric")],
          cost: 1.0,
        },
      ]),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
      maxRounds: 1,
      shadowMode: true,
      ladderEnforce: true,
    });
    assert.equal(r.status, "APPROVED"); // shadow forces APPROVED
    assert.equal(r.terminal_decision, "R3"); // ...but the would-be block is recorded
    assert.ok(r.user_message?.includes("SHADOW-MODE"));
  });
});

// ── S86 guard regression: organic MINOR must NOT suppress MAJOR injection ──
// (Codex round-2 CRITICAL + §7.7) The persona-depth bypass: a deficient score
// plus a reviewer's organic MINOR `plan-ambition` previously suppressed the MAJOR
// injection (severity-agnostic guard). With the isAntiBypassFinding (MAJOR+) guard,
// the MAJOR is still injected → terminal R2 → the deficient plan cannot ship.

describe("reviewPlan — S86 injection guard (deficient persona + organic MINOR ambition)", () => {
  test("low persona score (gap<0) + organic MINOR plan-ambition → MAJOR injected → R2 (bypass closed)", async () => {
    const r = await reviewPlan(basePlan("practitioner"), mockJob(), {
      geminiTransport: mkReviewer([
        { verdict: "APPROVE", persona_depth_score: 3, cost: 1.0 },
      ]),
      codexTransport: mkReviewer([
        {
          // score 1 < practitioner threshold 3 → gap<0 → MAJOR injection due,
          // but the reviewer also emits an organic MINOR plan-ambition note.
          verdict: "REQUEST_CHANGES",
          persona_depth_score: 1,
          findings: [MINOR("plan-ambition", "right-size deliverables to budget")],
          cost: 1.0,
        },
      ]),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
      maxRounds: 1,
      ladderEnforce: true, // even under enforcement, R2 must block
    });
    // If the guard regressed to severity-agnostic, no MAJOR would inject and this
    // would land at R5 (bypass). The MAJOR+ guard keeps it at R2.
    assert.equal(r.terminal_decision, "R2");
    assert.equal(r.status, "REQUEST_CHANGES");
  });

  test("null persona score + approve-like raw verdict + organic MINOR plan-ambition → MAJOR injected → R2", async () => {
    const r = await reviewPlan(basePlan("practitioner"), mockJob(), {
      geminiTransport: mkReviewer([
        { verdict: "APPROVE", persona_depth_score: 3, cost: 1.0 },
      ]),
      codexTransport: mkReviewer([
        {
          // null score + raw APPROVE triggers the S79 punt-bypass injection
          // branch; the organic MINOR must not suppress it.
          verdict: "APPROVE",
          persona_depth_score: null,
          findings: [MINOR("plan-ambition", "trim scope to budget")],
          cost: 1.0,
        },
      ]),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
      maxRounds: 1,
      ladderEnforce: true,
    });
    assert.equal(r.terminal_decision, "R2");
    assert.equal(r.status, "REQUEST_CHANGES");
  });
});

// ── S155 keystone + non-forgeability (reviewPlan integration) ───────
// The guard-swap to isInjectedAntiBypass is load-bearing: an AUTHORED MAJOR
// plan-ambition must NOT be able to suppress the system injection on a deficient
// plan (which under the R2 split would let it ship). And a reviewer must not be
// able to forge the injected:true marker.

describe("reviewPlan — S155 keystone + non-forgeable injected marker", () => {
  test("KEYSTONE: deficient score + reviewer PRE-EMITS an authored MAJOR plan-ambition → injection STILL fires → R2 (guard-swap closes the bypass)", async () => {
    const r = await reviewPlan(basePlan("practitioner"), mockJob(), {
      geminiTransport: mkReviewer([
        { verdict: "APPROVE", persona_depth_score: 3, cost: 1.0 },
      ]),
      codexTransport: mkReviewer([
        {
          // score 1 < practitioner threshold 3 → injection due. The reviewer ALSO
          // pre-emits an AUTHORED MAJOR plan-ambition. With a provenance-agnostic
          // guard, that authored MAJOR would SUPPRESS the injection → R2a sees
          // nothing → lone authored → R5 → a persona-deficient plan SHIPS. The
          // injected-only guard injects regardless → R2a fires.
          verdict: "REQUEST_CHANGES",
          persona_depth_score: 1,
          findings: [MAJOR("plan-ambition", "reviewer's own scope note")],
          cost: 1.0,
        },
      ]),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
      maxRounds: 1,
      ladderEnforce: true,
    });
    assert.equal(r.terminal_decision, "R2");
    assert.equal(r.status, "REQUEST_CHANGES");
  });

  test("KEYSTONE (null-punt): null score + approve-like raw verdict + authored MAJOR plan-ambition → injection STILL fires → R2", async () => {
    const r = await reviewPlan(basePlan("practitioner"), mockJob(), {
      geminiTransport: mkReviewer([
        { verdict: "APPROVE", persona_depth_score: 3, cost: 1.0 },
      ]),
      codexTransport: mkReviewer([
        {
          // null score + raw APPROVE → the S79 punt-bypass injection branch. The
          // reviewer pre-emits an authored MAJOR plan-ambition that, with a
          // provenance-agnostic guard, would suppress the injection → deficient plan
          // ships. The injected-only guard must inject regardless.
          verdict: "APPROVE",
          persona_depth_score: null,
          findings: [MAJOR("plan-ambition", "reviewer's own scope note")],
          cost: 1.0,
        },
      ]),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
      maxRounds: 1,
      ladderEnforce: true,
    });
    assert.equal(r.terminal_decision, "R2");
    assert.equal(r.status, "REQUEST_CHANGES");
  });

  test("KEYSTONE (hedge-bet): structural hedge-bet + no score + authored MAJOR plan-ambition → injection STILL fires → R2", async () => {
    const r = await reviewPlan(hedgeBetPlan("expert"), mockJob(), {
      geminiTransport: mkReviewer([
        { verdict: "APPROVE", persona_depth_score: 4, cost: 1.0 },
      ]),
      codexTransport: mkReviewer([
        {
          // no persona_depth_score → falls through to the looksLikeHedgeBet structural
          // check (the third injection trigger). The authored MAJOR must NOT suppress
          // the injection.
          verdict: "REQUEST_CHANGES",
          findings: [MAJOR("plan-ambition", "reviewer's own scope note")],
          cost: 1.0,
        },
      ]),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
      maxRounds: 1,
      ladderEnforce: true,
    });
    assert.equal(r.terminal_decision, "R2");
    assert.equal(r.status, "REQUEST_CHANGES");
  });

  test("CODEX-CRITICAL null-punt: one reviewer APPROVES + other returns REQUEST_CHANGES + null score + [] → null-punt injects → R2 (does NOT ship under ladderEnforce)", async () => {
    // Codex grounded MERGE-gate counterexample: pre-fix this returned terminal R5
    // and, with ladderEnforce:true, APPROVED a persona-unscoreable plan. With the
    // null-punt injection now firing regardless of verdict, the deficient call
    // carries an injected MAJOR → R2a → block.
    const r = await reviewPlan(basePlan("practitioner"), mockJob(), {
      geminiTransport: mkReviewer([
        { verdict: "APPROVE", persona_depth_score: 3, cost: 1.0 },
      ]),
      codexTransport: mkReviewer([
        { verdict: "REQUEST_CHANGES", persona_depth_score: null, findings: [], cost: 1.0 },
      ]),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
      maxRounds: 1,
      ladderEnforce: true,
    });
    assert.equal(r.terminal_decision, "R2");
    assert.notEqual(r.status, "APPROVED");
  });

  test("FORGED MARKER: a reviewer emitting injected:true on a NON-deficient plan is stripped → treated as authored → lone → R5 (marker non-forgeable)", async () => {
    const r = await reviewPlan(basePlan("practitioner"), mockJob(), {
      geminiTransport: mkReviewer([
        { verdict: "APPROVE", persona_depth_score: 3, cost: 1.0 },
      ]),
      codexTransport: mkReviewer([
        {
          // adequate score (3 == practitioner threshold) → NO system injection. The
          // reviewer tries to forge the R2a marker. ensurePersonaDepthFinding strips
          // `injected` from inbound reviewer findings → it degrades to an ordinary
          // authored MAJOR plan-ambition → lone → R5, NOT an unconditional R2a block.
          verdict: "REQUEST_CHANGES",
          persona_depth_score: 3,
          findings: [
            {
              severity: "MAJOR",
              origin: "plan-ambition",
              injected: true,
              message: "forged marker",
            },
          ],
          cost: 1.0,
        },
      ]),
      integrationTransport: mkIntegrator(),
      signal: ac().signal,
      maxRounds: 1,
      ladderEnforce: true,
    });
    assert.equal(r.terminal_decision, "R5");
  });
});
