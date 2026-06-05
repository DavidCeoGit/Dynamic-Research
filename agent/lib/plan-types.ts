/**
 * S58 Phase 1 MVP — Plan-review gate types + plain-TS validators.
 *
 * Implements the contract layer for Documentation/final-plan-design-gate.md §2
 * (ResearchPlan schema), §6 (ReviewResult), §7 (Origin enum), §12 #1
 * (Persona Depth rubric).
 *
 * Plain TS validators (not Zod) are used here intentionally to keep the
 * sandbox foundation free of net-new lockfile changes. The user-facing
 * `validateResearchPlan()` returns the same shape Zod would
 * (`{ valid, errors, plan? }`) so swapping in Zod later is mechanical.
 */

// ── Constants ───────────────────────────────────────────────────────

export const PLAN_SCHEMA_VERSION = 1 as const;

/**
 * 9-value Origin enum (Codex MAJOR-3 — kept consistent across design §7/§10/§12).
 * Findings carry an Origin so the UI can route the user to the fixable input.
 */
export const ORIGINS = [
  "topic",
  "persona",
  "answer-N",
  "studio-selection",
  "decision-context",
  "plan-ambition",
  "scoring-rubric",
  "source-strategy",
  "vendor-evaluation",
] as const;
export type Origin = (typeof ORIGINS)[number];

export const SEVERITIES = ["CRITICAL", "MAJOR", "MINOR"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const REVIEWER_VERDICTS = [
  "APPROVE",
  "APPROVE_WITH_CHANGES",
  "REQUEST_CHANGES",
  "BLOCK",
] as const;
export type ReviewerVerdict = (typeof REVIEWER_VERDICTS)[number];

/**
 * Terminal verdict from the full review cycle (sequential Gemini -> Codex
 * with integration). Distinct from a single reviewer's per-call verdict above.
 */
export const REVIEW_RESULTS = [
  "APPROVED",         // ready to spawn
  "REQUEST_CHANGES",  // user-input needed (plan-quality)
  "BLOCKED",          // plan-quality reject (terminal)
  "SYSTEM_BLOCKED",   // infra failure (auto-retry)
] as const;
export type ReviewResultStatus = (typeof REVIEW_RESULTS)[number];

/**
 * S85 plan-review convergence — which rule of the severity-graded terminal
 * ladder (Documentation/plan-review-convergence-design-gate.md §4) fired at
 * the terminal round. R1–R4 hard-block (→ REQUEST_CHANGES); R5 proceeds with
 * recorded reservations (→ APPROVED). Present on ReviewResult ONLY when the
 * terminal ladder ran — absent for early-exit approvals + pre-terminal hard
 * gates, which is the telemetry signal that distinguishes them (§5a).
 */
export const TERMINAL_RULES = ["R1", "R2", "R3", "R4", "R5"] as const;
export type TerminalRule = (typeof TERMINAL_RULES)[number];

/**
 * plan_review_status enum mirrors the schema CHECK constraint in
 * 20260527_plan_review_gate.sql §1.
 */
export const PLAN_REVIEW_STATUSES = [
  "pending",
  "reviewing",
  "approved",
  "request_changes",
  "blocked",
  "system_blocked",
] as const;
export type PlanReviewStatus = (typeof PLAN_REVIEW_STATUSES)[number];

export const DEPTH_TARGETS = ["executive", "practitioner", "expert"] as const;
export type DepthTarget = (typeof DEPTH_TARGETS)[number];

/**
 * Persona Depth rubric thresholds (design §12 #1 — Codex MAJOR-2 operational).
 * Each depth_target requires a minimum reviewer-assigned Persona Depth score (0-4).
 */
export const PERSONA_DEPTH_THRESHOLDS: Record<DepthTarget, number> = {
  executive: 2,
  practitioner: 3,
  expert: 4,
};

export const SOURCE_PRIORITIES = [
  "peer-reviewed",
  "industry-analyst",
  "vendor-docs",
  "community",
] as const;
export type SourcePriority = (typeof SOURCE_PRIORITIES)[number];

export const STUDIO_PRODUCTS = [
  "audio",
  "video",
  "slides",
  "report",
  "infographic",
] as const;
export type StudioProduct = (typeof STUDIO_PRODUCTS)[number];

// ── Plan schema (design §2) ─────────────────────────────────────────

export interface PlanAudience {
  persona: string;
  decision_context: string;
  depth_target: DepthTarget;
}

export interface PlanResearchUniverse {
  vendor_candidates: string[];
  explicit_exclusions: string[];
  source_priorities: SourcePriority[];
}

/**
 * Topic-specific evaluation rubric (NOT to be confused with the FIXED
 * Confidence Index dimensions per ~/.claude/skills/confidence-index.md —
 * design §2 evaluation_framework field; Codex MAJOR-8 renamed from "scoring").
 */
export interface PlanEvaluationFramework {
  tier1_dimensions: string[];
  tier2_dimensions: string[];
  rubric_rationale: string;
}

export interface PlanStudioProducts {
  selected: StudioProduct[];
  per_product_emphasis: Partial<Record<StudioProduct, string>>;
}

export interface ResearchPlan {
  schema_version: typeof PLAN_SCHEMA_VERSION;
  topic_resolved: string;
  audience: PlanAudience;
  research_universe: PlanResearchUniverse;
  evaluation_framework: PlanEvaluationFramework;
  studio_products: PlanStudioProducts;
  expected_artifacts: string[];
  risk_flags: string[];
}

// ── Review result types (design §6) ─────────────────────────────────

export interface ReviewFinding {
  severity: Severity;
  origin: Origin;
  message: string;
}

export interface ReviewerCall {
  reviewer: "gemini" | "codex" | "integration";
  iteration: number;
  verdict: ReviewerVerdict | "INTEGRATED" | "UNAVAILABLE";
  findings: ReviewFinding[];
  plan_version: ResearchPlan;
  model_id: string;
  provider: "google" | "openai" | "anthropic";
  input_tokens?: number;
  output_tokens?: number;
  total_cost_usd?: number;
  duration_ms?: number;
  raw_json?: unknown;
}

export interface ReviewResult {
  status: ReviewResultStatus;
  final_plan: ResearchPlan;
  iterations: number;
  attempts: number;
  total_cost_usd: number;
  reviewer_calls: ReviewerCall[];
  user_message?: string;
  error?: string;
  /**
   * S85 — terminal ladder rule that fired (R1..R5). Present only when the
   * terminal decision ran (design §4). Absent for early-exit approvals (the
   * mid-loop all-approve path) + pre-terminal hard gates (BLOCK / cost-cap /
   * SYSTEM_BLOCKED). Used by §5a telemetry to distinguish the one-reviewer-down
   * APPROVED state (terminal_decision absent) from the R5 override
   * (terminal_decision="R5", reservations populated).
   */
  terminal_decision?: TerminalRule;
  /**
   * S85 — final-round non-critical findings recorded as advisory reservations
   * when the plan proceeded under R5 (design §4 / §5b). Computed from the
   * in-memory FINAL-round availableCalls only (§6.5), never DB rows or prior
   * rounds. Populated whenever the ladder chose R5, even when ladder
   * enforcement is OFF (dark-launch) so the trigger-rate is measurable; the
   * executor surfaces them (email + advisory persistence) only on the emitted
   * APPROVED path. Non-silent surfacing is REQUIRED (§5b).
   */
  reservations?: ReviewFinding[];
}

// ── Validators (return Zod-shaped {valid, errors, plan?}) ───────────

export interface ValidationResult<T> {
  valid: boolean;
  errors: string[];
  value?: T;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * S59 smoke-test fix: Claude tends to decorate enum values with parenthetical
 * context, e.g. `"vendor-docs (tenancy architecture, DPA, FedRAMP/CMMC)"`.
 * Strip everything from " (" onwards + trim, leaving the bare enum prefix.
 * This is reviewer-side leniency; the synthesizer prompt also explicitly
 * forbids decoration as defense-in-depth.
 */
function stripParenthetical(s: string): string {
  const idx = s.indexOf(" (");
  return (idx >= 0 ? s.slice(0, idx) : s).trim();
}

/**
 * Validate a candidate ResearchPlan parsed from JSON.
 * Returns ValidationResult with detailed errors so the synthesizer can
 * either retry-once or fail loud with diagnostic context.
 *
 * Enforces schema_version=1; non-1 versions are a hard error (design §8 #6).
 *
 * Pure: does NOT mutate `raw`. Normalized enum values (parenthetical-stripped)
 * are returned via a deep clone in `value` (S60 Gemini MAJOR fix).
 */
export function validateResearchPlan(
  raw: unknown,
): ValidationResult<ResearchPlan> {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return { valid: false, errors: ["plan is not a JSON object"] };
  }

  if (raw.schema_version !== PLAN_SCHEMA_VERSION) {
    errors.push(
      `schema_version must be ${PLAN_SCHEMA_VERSION} (got ${JSON.stringify(raw.schema_version)})`,
    );
  }

  if (!isNonEmptyString(raw.topic_resolved)) {
    errors.push("topic_resolved must be a non-empty string");
  } else if ((raw.topic_resolved as string).length > 500) {
    // S81 #7: cap relaxed 200 -> 500. The 200-char target remains the
    // preferred shape (enforced by the synthesizer prompt's TOPIC
    // CANONICALIZATION discipline section); 500 is a fail-safe so a
    // transient model verbosity event doesn't system_block a job.
    errors.push("topic_resolved must be <= 500 chars");
  }

  if (!isPlainObject(raw.audience)) {
    errors.push("audience must be an object");
  } else {
    const a = raw.audience;
    if (!isNonEmptyString(a.persona)) errors.push("audience.persona required");
    if (!isNonEmptyString(a.decision_context))
      errors.push("audience.decision_context required");
    if (!DEPTH_TARGETS.includes(a.depth_target as DepthTarget))
      errors.push(
        `audience.depth_target must be one of ${DEPTH_TARGETS.join("|")}`,
      );
  }

  // Normalized enum values are collected here, applied to a clone at return time.
  let normalizedSourcePriorities: SourcePriority[] | undefined;
  let normalizedStudioSelected: StudioProduct[] | undefined;

  if (!isPlainObject(raw.research_universe)) {
    errors.push("research_universe must be an object");
  } else {
    const u = raw.research_universe;
    if (!isStringArray(u.vendor_candidates))
      errors.push("research_universe.vendor_candidates must be string[]");
    if (!isStringArray(u.explicit_exclusions))
      errors.push("research_universe.explicit_exclusions must be string[]");
    if (
      !Array.isArray(u.source_priorities) ||
      !(u.source_priorities as unknown[]).every(
        (p) =>
          typeof p === "string" &&
          SOURCE_PRIORITIES.includes(
            stripParenthetical(p) as SourcePriority,
          ),
      )
    ) {
      errors.push(
        `research_universe.source_priorities must be subset of ${SOURCE_PRIORITIES.join("|")} (parenthetical decoration like "vendor-docs (context)" is tolerated)`,
      );
    } else {
      normalizedSourcePriorities = (u.source_priorities as string[]).map(
        (p) => stripParenthetical(p) as SourcePriority,
      );
    }
  }

  if (!isPlainObject(raw.evaluation_framework)) {
    errors.push("evaluation_framework must be an object");
  } else {
    const e = raw.evaluation_framework;
    if (!isStringArray(e.tier1_dimensions))
      errors.push("evaluation_framework.tier1_dimensions must be string[]");
    if (!isStringArray(e.tier2_dimensions))
      errors.push("evaluation_framework.tier2_dimensions must be string[]");
    if (!isNonEmptyString(e.rubric_rationale))
      errors.push("evaluation_framework.rubric_rationale required");
  }

  if (!isPlainObject(raw.studio_products)) {
    errors.push("studio_products must be an object");
  } else {
    const sp = raw.studio_products;
    if (
      !Array.isArray(sp.selected) ||
      !(sp.selected as unknown[]).every(
        (p) =>
          typeof p === "string" &&
          STUDIO_PRODUCTS.includes(
            stripParenthetical(p) as StudioProduct,
          ),
      )
    ) {
      errors.push(
        `studio_products.selected must be subset of ${STUDIO_PRODUCTS.join("|")}`,
      );
    } else {
      normalizedStudioSelected = (sp.selected as string[]).map(
        (p) => stripParenthetical(p) as StudioProduct,
      );
    }
    if (!isPlainObject(sp.per_product_emphasis))
      errors.push("studio_products.per_product_emphasis must be an object");
  }

  if (!isStringArray(raw.expected_artifacts))
    errors.push("expected_artifacts must be string[]");

  if (!isStringArray(raw.risk_flags))
    errors.push("risk_flags must be string[]");

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Deep-clone + overwrite normalized fields. Pure: `raw` is untouched.
  const plan = structuredClone(raw) as Record<string, unknown>;
  if (normalizedSourcePriorities) {
    (plan.research_universe as Record<string, unknown>).source_priorities =
      normalizedSourcePriorities;
  }
  if (normalizedStudioSelected) {
    (plan.studio_products as Record<string, unknown>).selected =
      normalizedStudioSelected;
  }
  return { valid: true, errors: [], value: plan as unknown as ResearchPlan };
}

/**
 * Validate a single ReviewFinding object.
 * answer-N origins are allowed since `answer-N` is a TEMPLATE in the enum;
 * concrete findings emit `answer-3` etc. We accept both the literal `answer-N`
 * and any `answer-<digits>` form for forward-compat.
 */
export function isValidFinding(v: unknown): v is ReviewFinding {
  if (!isPlainObject(v)) return false;
  if (!SEVERITIES.includes(v.severity as Severity)) return false;
  const o = v.origin;
  if (typeof o !== "string") return false;
  const okOrigin =
    (ORIGINS as readonly string[]).includes(o) || /^answer-\d+$/.test(o);
  if (!okOrigin) return false;
  if (!isNonEmptyString(v.message)) return false;
  return true;
}

/**
 * Persona Depth rubric checker (design §12 #1).
 *
 * Reviewer-supplied 0-4 score is checked against the threshold for the
 * plan's depth_target. Returns the gap (>= 0 means meets/exceeds threshold;
 * < 0 means falls short by that many points).
 *
 * Use the gap to mint a REQUEST_CHANGES finding with origin "plan-ambition"
 * when negative.
 */
export function personaDepthGap(
  reviewerScore: number,
  depthTarget: DepthTarget,
): number {
  const threshold = PERSONA_DEPTH_THRESHOLDS[depthTarget];
  return reviewerScore - threshold;
}

/**
 * Heuristic "hedge-bet detector" used as a sanity check when the reviewer
 * doesn't return a Persona Depth score (defensive). Returns true if the plan
 * structurally looks like an adversarial-safe-plan per design §12 #1 reject
 * criteria for `expert` persona:
 *   - >10 vendor_candidates with no explicit_exclusions
 *   - empty risk_flags
 *   - empty explicit_exclusions
 *   - rubric_rationale shorter than 50 chars (probable boilerplate)
 *
 * Only consulted as a defense-in-depth signal — the reviewer's structural
 * rubric score is authoritative.
 */
export function looksLikeHedgeBet(plan: ResearchPlan): boolean {
  const u = plan.research_universe;
  const e = plan.evaluation_framework;
  const tooManyVendorsNoExclusions =
    u.vendor_candidates.length > 10 && u.explicit_exclusions.length === 0;
  const noRiskFlags = plan.risk_flags.length === 0;
  const noExclusions = u.explicit_exclusions.length === 0;
  const thinRubric = (e.rubric_rationale ?? "").trim().length < 50;
  // Three+ of four conditions = hedge-bet
  const flags = [
    tooManyVendorsNoExclusions,
    noRiskFlags,
    noExclusions,
    thinRubric,
  ].filter(Boolean).length;
  return flags >= 3;
}
