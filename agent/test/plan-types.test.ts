/**
 * S58 Phase 1 MVP — unit tests for agent/lib/plan-types.ts.
 *
 * Coverage: validateResearchPlan (10+ fixture spread), personaDepthGap,
 * looksLikeHedgeBet, isValidFinding.
 *
 * Run via: pnpm -C agent exec node --import=tsx --test test/plan-types.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  validateResearchPlan,
  personaDepthGap,
  looksLikeHedgeBet,
  isValidFinding,
  PERSONA_DEPTH_THRESHOLDS,
  PLAN_SCHEMA_VERSION,
  type ResearchPlan,
  type DepthTarget,
} from "../lib/plan-types.js";

// ── Fixture builders ────────────────────────────────────────────────

function validPlan(overrides: Partial<ResearchPlan> = {}): ResearchPlan {
  const base: ResearchPlan = {
    schema_version: PLAN_SCHEMA_VERSION,
    topic_resolved: "Carbon-neutral data center cooling options for mid-sized SaaS",
    audience: {
      persona: "VP Infrastructure, mid-stage SaaS (200-500 employees)",
      decision_context: "Picking a primary cooling vendor for new West-Coast colo deployment",
      depth_target: "practitioner",
    },
    research_universe: {
      vendor_candidates: [
        "Submer",
        "GRC",
        "LiquidStack",
        "Iceotope",
        "Asperitas",
        "DUG Cool",
      ],
      explicit_exclusions: [
        "Hyperscaler in-house cooling: not licensable to outside ops",
        "DIY immersion: unsupported by our hardware vendors",
      ],
      source_priorities: ["industry-analyst", "vendor-docs", "peer-reviewed"],
    },
    evaluation_framework: {
      tier1_dimensions: [
        "PUE under target workload mix",
        "Retrofit cost vs ground-up",
        "Vendor support contract SLA",
        "Coolant fluid sourcing risk",
        "Operations team upskilling",
      ],
      tier2_dimensions: ["Decommissioning waste-stream"],
      rubric_rationale:
        "Practitioner-level pick demands operational depth — SLA + sourcing risk dominate over capex.",
    },
    studio_products: {
      selected: ["report", "slides"],
      per_product_emphasis: {
        report: "Vendor comparison table with PUE + SLA + sourcing-risk columns",
        slides: "Executive 12-slide briefing for CTO sign-off",
      },
    },
    expected_artifacts: [
      "vendor_comparison.md",
      "slides_briefing.pptx.pdf",
      "audio_overview.mp3",
    ],
    risk_flags: [
      "PUE numbers from vendor docs may be optimistic vs real-world",
      "Coolant supply chain is geographically concentrated",
    ],
  };
  return { ...base, ...overrides };
}

// ── validateResearchPlan ────────────────────────────────────────────

describe("validateResearchPlan", () => {
  test("accepts a fully valid plan", () => {
    const r = validateResearchPlan(validPlan());
    assert.equal(r.valid, true);
    assert.ok(r.value);
    assert.equal(r.errors.length, 0);
  });

  test("rejects non-object input", () => {
    assert.equal(validateResearchPlan(null).valid, false);
    assert.equal(validateResearchPlan("not a plan").valid, false);
    assert.equal(validateResearchPlan([]).valid, false);
    assert.equal(validateResearchPlan(42).valid, false);
  });

  test("rejects wrong schema_version", () => {
    const bad = { ...validPlan(), schema_version: 2 as unknown as 1 };
    const r = validateResearchPlan(bad);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("schema_version")));
  });

  test("rejects empty topic_resolved", () => {
    const r = validateResearchPlan(validPlan({ topic_resolved: "" }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("topic_resolved")));
  });

  test("rejects topic_resolved > 500 chars (S81 #7 cap relax)", () => {
    const r = validateResearchPlan(
      validPlan({ topic_resolved: "a".repeat(501) }),
    );
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("<= 500")));
  });

  test("accepts topic_resolved exactly 500 chars (S81 #7 boundary)", () => {
    const r = validateResearchPlan(
      validPlan({ topic_resolved: "a".repeat(500) }),
    );
    assert.equal(r.valid, true);
  });

  test("accepts topic_resolved 201-499 chars (was rejected pre-S81)", () => {
    // Regression case for S81 #7: e18e1931 production job (auto-detailing
    // business name research) hit the prior 200-char cap. With the new 500
    // cap the LLM has runway to canonicalize without verbatim-echo penalty
    // hitting a hard wall on transient verbosity.
    const r = validateResearchPlan(
      validPlan({
        topic_resolved:
          "Naming patterns of successful auto-detailing businesses: what name structures (e.g., portmanteau, alliteration, service-noun pairing, regional anchoring) convey service identity, drive consumer recognition, and correlate with sustained sales success vs. alternatives like the user's current DTYL portmanteau choice?",
      }),
    );
    assert.equal(r.valid, true);
  });

  test("topic_resolved length boundaries — table-driven (S81 #7 v3 COV-1)", () => {
    // Codex COV-1: pin exact boundaries [200, 201, 499, 500] accept + 501 reject.
    // The prior cap was 200; this verifies no off-by-one regression in the
    // newly-accepted 201-499 range and confirms 500 is inclusive.
    const acceptLengths = [200, 201, 499, 500];
    for (const n of acceptLengths) {
      const r = validateResearchPlan(
        validPlan({ topic_resolved: "x".repeat(n) }),
      );
      assert.equal(
        r.valid,
        true,
        `expected valid at topic_resolved.length=${n}, errors=${JSON.stringify(r.errors)}`,
      );
    }
    const rejectAt501 = validateResearchPlan(
      validPlan({ topic_resolved: "x".repeat(501) }),
    );
    assert.equal(rejectAt501.valid, false);
    assert.ok(rejectAt501.errors.some((e) => e.includes("<= 500")));
  });

  test("rejects bad audience.depth_target", () => {
    const bad = validPlan();
    (bad.audience as { depth_target: string }).depth_target = "novice";
    const r = validateResearchPlan(bad);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("depth_target")));
  });

  test("rejects bad source_priorities member", () => {
    const bad = validPlan();
    (bad.research_universe.source_priorities as string[]).push("blog-comments");
    const r = validateResearchPlan(bad);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("source_priorities")));
  });

  test("rejects bad studio_products.selected member", () => {
    const bad = validPlan();
    (bad.studio_products.selected as string[]).push("hologram");
    const r = validateResearchPlan(bad);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("studio_products.selected")));
  });

  test("rejects missing evaluation_framework", () => {
    const bad: Record<string, unknown> = { ...validPlan() };
    delete bad.evaluation_framework;
    const r = validateResearchPlan(bad);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("evaluation_framework")));
  });

  test("rejects non-array vendor_candidates", () => {
    const bad = validPlan();
    (bad.research_universe as { vendor_candidates: unknown }).vendor_candidates = "not an array";
    const r = validateResearchPlan(bad);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("vendor_candidates")));
  });

  test("rejects non-array risk_flags", () => {
    const bad = { ...validPlan(), risk_flags: "no flags here" as unknown as string[] };
    const r = validateResearchPlan(bad);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes("risk_flags")));
  });

  test("accepts empty arrays where allowed", () => {
    const plan = validPlan({
      risk_flags: [],
    });
    plan.evaluation_framework.tier2_dimensions = [];
    const r = validateResearchPlan(plan);
    assert.equal(r.valid, true);
  });

  test("accumulates multiple errors", () => {
    const bad: Record<string, unknown> = {
      schema_version: 1,
      topic_resolved: "",
      audience: {},
      research_universe: "wrong type",
      evaluation_framework: null,
      studio_products: { selected: ["x"], per_product_emphasis: {} },
      expected_artifacts: "not array",
      risk_flags: [],
    };
    const r = validateResearchPlan(bad);
    assert.equal(r.valid, false);
    assert.ok(r.errors.length >= 5);
  });
});

// ── Parenthetical-stripping + purity (S60 Gemini MAJOR fix) ─────────

describe("validateResearchPlan — parenthetical stripping + purity", () => {
  test("does NOT mutate input: source_priorities + studio_products.selected stay raw", () => {
    const decorated = validPlan();
    // Cast through `string[]` to inject decorated values without TS complaint.
    (decorated.research_universe.source_priorities as string[]) = [
      "vendor-docs (tenancy architecture, DPA, FedRAMP/CMMC)",
      "industry-analyst (Gartner MQ)",
      "peer-reviewed",
    ];
    (decorated.studio_products.selected as string[]) = [
      "report (vendor comparison)",
      "slides",
    ];
    // Snapshot before validation.
    const beforeSourceP = JSON.stringify(
      decorated.research_universe.source_priorities,
    );
    const beforeStudioSel = JSON.stringify(decorated.studio_products.selected);

    const r = validateResearchPlan(decorated);

    assert.equal(r.valid, true);
    // Input untouched.
    assert.equal(
      JSON.stringify(decorated.research_universe.source_priorities),
      beforeSourceP,
      "source_priorities was mutated in-place",
    );
    assert.equal(
      JSON.stringify(decorated.studio_products.selected),
      beforeStudioSel,
      "studio_products.selected was mutated in-place",
    );
  });

  test("returned value has parenthetical-stripped source_priorities", () => {
    const decorated = validPlan();
    (decorated.research_universe.source_priorities as string[]) = [
      "vendor-docs (tenancy architecture)",
      "industry-analyst (Gartner MQ)",
      "peer-reviewed",
    ];
    const r = validateResearchPlan(decorated);
    assert.equal(r.valid, true);
    assert.deepEqual(r.value!.research_universe.source_priorities, [
      "vendor-docs",
      "industry-analyst",
      "peer-reviewed",
    ]);
  });

  test("returned value has parenthetical-stripped studio_products.selected", () => {
    const decorated = validPlan();
    (decorated.studio_products.selected as string[]) = [
      "report (vendor comparison)",
      "slides (executive brief)",
      "audio",
    ];
    const r = validateResearchPlan(decorated);
    assert.equal(r.valid, true);
    assert.deepEqual(r.value!.studio_products.selected, [
      "report",
      "slides",
      "audio",
    ]);
  });
});

// ── personaDepthGap ─────────────────────────────────────────────────

describe("personaDepthGap", () => {
  test("matches threshold per depth_target", () => {
    assert.equal(PERSONA_DEPTH_THRESHOLDS.executive, 2);
    assert.equal(PERSONA_DEPTH_THRESHOLDS.practitioner, 3);
    assert.equal(PERSONA_DEPTH_THRESHOLDS.expert, 4);
  });

  test("returns positive gap when score exceeds threshold", () => {
    assert.equal(personaDepthGap(4, "executive"), 2);
    assert.equal(personaDepthGap(4, "practitioner"), 1);
    assert.equal(personaDepthGap(4, "expert"), 0);
  });

  test("returns negative gap when score below threshold", () => {
    assert.equal(personaDepthGap(0, "executive"), -2);
    assert.equal(personaDepthGap(1, "practitioner"), -2);
    assert.equal(personaDepthGap(2, "expert"), -2);
  });

  test("zero gap means exactly meets", () => {
    for (const t of ["executive", "practitioner", "expert"] as DepthTarget[]) {
      const score = PERSONA_DEPTH_THRESHOLDS[t];
      assert.equal(personaDepthGap(score, t), 0);
    }
  });
});

// ── looksLikeHedgeBet ───────────────────────────────────────────────

describe("looksLikeHedgeBet", () => {
  test("returns false for an opinionated plan", () => {
    assert.equal(looksLikeHedgeBet(validPlan()), false);
  });

  test("returns true for the classic hedge-bet shape", () => {
    const bad = validPlan({
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
      risk_flags: [],
    });
    assert.equal(looksLikeHedgeBet(bad), true);
  });

  test("returns false when only one hedge-bet signal present", () => {
    // Only thin rubric; everything else opinionated.
    const plan = validPlan();
    plan.evaluation_framework.rubric_rationale = "thin";
    assert.equal(looksLikeHedgeBet(plan), false);
  });

  test("returns true with three of four signals", () => {
    const plan = validPlan({
      research_universe: {
        vendor_candidates: Array.from(
          { length: 11 },
          (_, i) => `Vendor ${i + 1}`,
        ),
        explicit_exclusions: [],
        source_priorities: ["vendor-docs"],
      },
      risk_flags: [],
    });
    // tooManyVendorsNoExclusions=true, noRiskFlags=true, noExclusions=true,
    // thinRubric=false (kept from validPlan's full rationale) -> 3/4
    assert.equal(looksLikeHedgeBet(plan), true);
  });
});

// ── isValidFinding ──────────────────────────────────────────────────

describe("isValidFinding", () => {
  test("accepts canonical Origins", () => {
    assert.equal(
      isValidFinding({
        severity: "CRITICAL",
        origin: "topic",
        message: "Topic too broad",
      }),
      true,
    );
    assert.equal(
      isValidFinding({
        severity: "MINOR",
        origin: "scoring-rubric",
        message: "Tier-2 has no entries",
      }),
      true,
    );
  });

  test("accepts answer-N concrete forms", () => {
    assert.equal(
      isValidFinding({
        severity: "MAJOR",
        origin: "answer-3",
        message: "Answer to Q3 narrowed to region but plan stayed global",
      }),
      true,
    );
    assert.equal(
      isValidFinding({
        severity: "MAJOR",
        origin: "answer-12",
        message: "two-digit answer index",
      }),
      true,
    );
  });

  test("rejects bad severity", () => {
    assert.equal(
      isValidFinding({
        severity: "FATAL",
        origin: "topic",
        message: "no such severity",
      }),
      false,
    );
  });

  test("rejects bad origin", () => {
    assert.equal(
      isValidFinding({
        severity: "MAJOR",
        origin: "vibes-check",
        message: "made-up origin",
      }),
      false,
    );
  });

  test("rejects empty message", () => {
    assert.equal(
      isValidFinding({ severity: "MINOR", origin: "topic", message: "" }),
      false,
    );
  });

  test("rejects non-object", () => {
    assert.equal(isValidFinding(null), false);
    assert.equal(isValidFinding("string"), false);
    assert.equal(isValidFinding(["arr"]), false);
  });
});
