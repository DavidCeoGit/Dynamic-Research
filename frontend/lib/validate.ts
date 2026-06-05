/**
 * Input validation and sanitization for the research queue.
 */

import { z } from "zod";

// ── Slug generation ─────────────────────────────────────────────────

/**
 * Generate a URL-safe slug from a topic string.
 *
 * Appends an 8-character cryptographically-random hex hash. Pre-S34 used
 * Math.random().toString(36).slice(2, 6) — 4 base36 chars, ~21 bits, ~1.68M
 * combinations and a non-crypto PRNG. That entropy was enumerable in seconds
 * via slug-guess probing, leaking the existence of every research run across
 * the (currently single-tenant) deployment to anyone who could brute-force
 * the URL space. Adversarial finding #6 from the S33 audit.
 *
 * 8 hex chars = ~32 bits = ~4.29 billion combinations = effectively unguess-
 * able under any practical online-enumeration budget. Per-org gating remains
 * Phase A multi-tenancy work; this fix closes only the entropy half of #6.
 *
 * Uses globalThis.crypto.randomUUID() — available in Node 18.17+ (Next 16
 * requires Node 18.18+) and all modern browsers + Vercel Edge runtime.
 */
export function generateSlug(topic: string): string {
  const base = topic
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40)
    .replace(/-$/, "");

  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${base}-${hash}`;
}

// ── Zod schemas ─────────────────────────────────────────────────────

export const userContextSchema = z.object({
  domainKnowledge: z.array(z.string().max(10000)).default([]),
  constraints: z.array(z.string().max(5000)).default([]),
  additionalUrls: z.preprocess(
    (val) => {
      // Auto-clean URL list: drop empty strings and obvious non-URLs,
      // prepend https:// to bare domains. Lets dynamic-question free-text
      // answers (which get split by whitespace into per-token entries) work
      // even when some tokens are plain prose rather than URLs.
      if (!Array.isArray(val)) return val;
      return val
        .map((u) => (typeof u === "string" ? u.trim() : ""))
        .filter((u) => u.length > 0)
        .map((u) => {
          if (/^https?:\/\//i.test(u)) return u;
          // Bare-domain heuristic: at least one dot, and chars are URL-ish
          if (/^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+(\/[^\s]*)?$/i.test(u)) {
            return `https://${u}`;
          }
          return null;
        })
        .filter((u): u is string => u !== null);
    },
    z.array(z.string().url().max(2000)),
  ).default([]),
  claimsToVerify: z.array(z.string().max(5000)).default([]),
});

export const vendorEvaluationSchema = z.object({
  enabled: z.boolean().default(false),
  vendorType: z.string().max(500).default(""),
  serviceArea: z.string().max(1000).default(""),
  serviceAddress: z.string().max(500).default(""),
  jobDescription: z.string().max(10000).default(""),
  maxVendorsDiscovered: z.number().int().min(1).max(20).default(10),
  maxVendorsEnriched: z.number().int().min(1).max(10).default(5),
});

export const selectedProductsSchema = z.object({
  audio: z.boolean().default(false),
  video: z.boolean().default(false),
  slides: z.boolean().default(false),
  report: z.boolean().default(false),
  infographic: z.boolean().default(false),
}).refine(
  (p) => Object.values(p).some(Boolean),
  { message: "At least one product must be selected" },
);

export const perplexitySchema = z.object({
  queryFraming: z.string().max(25000).default(""),
  emphasis: z.array(z.string().max(2000)).default([]),
  outputStructure: z.string().max(10000).default(""),
});

export const notebookLMSchema = z.object({
  persona: z.string().max(25000).default(""),
  researchMode: z.enum(["deep", "standard"]).default("deep"),
  priorities: z.array(z.string().max(2000)).default([]),
});

export const customizationsSchema = z.object({
  perplexity: perplexitySchema.optional().default({ queryFraming: "", emphasis: [], outputStructure: "" }),
  notebookLM: notebookLMSchema.optional().default({ persona: "", researchMode: "deep" as const, priorities: [] }),
  studio: z.record(z.string(), z.record(z.string(), z.unknown())).optional().default({}),
});

export const researchJobPayloadSchema = z.object({
  topic: z.string().min(10, "Topic must be at least 10 characters").max(10000),
  userContext: userContextSchema.optional().default({ domainKnowledge: [], constraints: [], additionalUrls: [], claimsToVerify: [] }),
  vendorEvaluation: vendorEvaluationSchema.optional().default({ enabled: false, vendorType: "", serviceArea: "", serviceAddress: "", jobDescription: "", maxVendorsDiscovered: 10, maxVendorsEnriched: 5 }),
  ajiDnaEnabled: z.boolean().default(false),
  selectedProducts: selectedProductsSchema,
  customizations: customizationsSchema.optional().default({ perplexity: { queryFraming: "", emphasis: [], outputStructure: "" }, notebookLM: { persona: "", researchMode: "deep" as const, priorities: [] }, studio: {} }),
  notifyEmail: z.string().email().optional().or(z.literal("")),
  // S35 Clone & Edit — set when the form is submitted with ?clone=<slug>.
  // The submit endpoint resolves <slug>→<id> via research_queue.topic_slug
  // and persists the id on the new row's parent_run_id column for lineage.
  // Slug not UUID because the frontend has the slug from the URL; backend
  // does the lookup. NULL/undefined = fresh submission.
  parentSlug: z.string().max(120).nullable().optional(),
  // CE-3 — Studio-only regeneration: "studio_only" tells the worker to skip
  // Claude + the deep-research pipeline and re-run only NLM Studio products
  // against the parent notebook. Only meaningful when parentSlug is present;
  // omitted/"full" = normal pipeline. The agent reads job.pipeline_mode.
  pipelineMode: z.enum(["full", "studio_only"]).optional(),
});

// Path B (S29): structured extraction of dimensions the topic already covers.
// `null` for any dimension the topic does not address. The /api/queue/generate-questions
// endpoint uses non-null fields to mechanically skip questions for already-covered ground.
export const extractedContextSchema = z.object({
  domainKnowledge: z.array(z.string().max(10000)).nullable(),
  constraints: z.array(z.string().max(5000)).nullable(),
  additionalUrls: z.array(z.string().max(2000)).nullable(),
  claimsToVerify: z.array(z.string().max(5000)).nullable(),
  vendorEvaluation: z.object({
    enabled: z.boolean().nullable(),
    vendorType: z.string().max(500).nullable(),
    serviceArea: z.string().max(1000).nullable(),
  }).nullable(),
  ajiDnaEnabled: z.boolean().nullable(),
});

export type ExtractedContext = z.infer<typeof extractedContextSchema>;

export const extractContextRequestSchema = z.object({
  topic: z.string().min(10).max(10000),
});

export const generateQuestionsSchema = z.object({
  topic: z.string().min(10).max(10000),
  extractedContext: extractedContextSchema.nullable().optional(),
});

/** Schema for the AI-generated questions response. */
export const generatedQuestionSchema = z.object({
  id: z.string(),
  text: z.string(),
  type: z.enum(["text", "boolean", "multiselect"]),
  options: z.array(z.string()).optional(),
  mappedField: z.string(),
});

export const questionsResponseSchema = z.object({
  questions: z.array(generatedQuestionSchema).min(2).max(7),
});

/**
 * S58 plan-review gate status enum — mirrors agent/types.ts:PlanReviewStatus
 * and the schema CHECK constraint in
 * supabase/migrations/20260527_plan_review_gate.sql §1.
 */
export const planReviewStatusEnum = z.enum([
  "pending",
  "reviewing",
  "approved",
  "request_changes",
  "blocked",
  "system_blocked",
]);

/**
 * S59 Codex v2 MINOR-2 fix: route-level plan_json schema-version guard.
 *
 * Loose `passthrough` — we enforce the schema_version literal at the route
 * layer; the full ResearchPlan field validation lives in the worker
 * (agent/lib/plan-types.ts:validateResearchPlan). This guard prevents a
 * worker bug from persisting plan_json with a schema_version the UI can't
 * render, while keeping the route shape forward-compatible with future
 * non-breaking ResearchPlan additions.
 */
export const planJsonRouteGuardSchema = z
  .object({
    schema_version: z.literal(1),
  })
  .passthrough();

/** Schema for agent progress updates. */
export const agentUpdateSchema = z.object({
  current_phase: z.string().optional(),
  phase_status: z.string().optional(),
  progress_pct: z.number().int().min(0).max(100).optional(),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]).optional(),
  result_slug: z.string().optional(),
  error_message: z.string().optional(),
  // S58 plan-review gate. Worker writes these via api-client:updatePlanReviewStatus.
  // S59 Codex MINOR-2: plan_json now carries a route-level schema-version
  // guard (schema_version=1 literal) — full field-level validation still
  // lives in agent/lib/plan-types.ts on the worker side; this is forensic
  // insurance against worker-side bugs writing incompatible plan_json shapes.
  plan_json: planJsonRouteGuardSchema.nullable().optional(),
  plan_review_status: planReviewStatusEnum.optional(),
  plan_review_iterations: z.number().int().min(0).optional(),
  plan_review_attempts: z.number().int().min(0).optional(),
  // Codex v2 MINOR-1: ISO datetime — all writers emit `new Date().toISOString()`
  // (worker generates these in agent/lib/plan-reviewer.ts retry logic). Tighter
  // validation here catches schema drift if some new writer omits the format.
  plan_review_next_attempt_at: z.string().datetime().nullable().optional(),
  plan_review_error: z.string().max(500).nullable().optional(),
});

// ── Form-level schema (extends API payload with transient form fields) ──

/** Products schema without .refine() — for react-hook-form field registration */
export const selectedProductsBaseSchema = z.object({
  audio: z.boolean().default(false),
  video: z.boolean().default(false),
  slides: z.boolean().default(false),
  report: z.boolean().default(false),
  infographic: z.boolean().default(false),
});

export const formDataSchema = z.object({
  topic: z.string().min(10, "Topic must be at least 10 characters").max(10000),
  userContext: userContextSchema.default({ domainKnowledge: [], constraints: [], additionalUrls: [], claimsToVerify: [] }),
  vendorEvaluation: vendorEvaluationSchema.default({ enabled: false, vendorType: "", serviceArea: "", serviceAddress: "", jobDescription: "", maxVendorsDiscovered: 10, maxVendorsEnriched: 5 }),
  ajiDnaEnabled: z.boolean().default(false),
  selectedProducts: selectedProductsBaseSchema,
  customizations: customizationsSchema.default({ perplexity: { queryFraming: "", emphasis: [], outputStructure: "" }, notebookLM: { persona: "", researchMode: "deep" as const, priorities: [] }, studio: {} }),
  notifyEmail: z.string().email().optional().or(z.literal("")),
  generatedQuestions: z.array(generatedQuestionSchema).default([]),
  dynamicAnswers: z.record(z.string(), z.union([z.string(), z.boolean(), z.array(z.string())])).default({}),
  extractedContext: extractedContextSchema.nullable().default(null),
  // CE-3 — only used when cloning. Hooks/StepReview gate the radio on cloneSlug.
  pipelineMode: z.enum(["full", "studio_only"]).default("full"),
});

export type FormData = z.infer<typeof formDataSchema>;

export const FORM_DEFAULT_VALUES: FormData = {
  topic: "",
  userContext: { domainKnowledge: [], constraints: [], additionalUrls: [], claimsToVerify: [] },
  vendorEvaluation: { enabled: false, vendorType: "", serviceArea: "", serviceAddress: "", jobDescription: "", maxVendorsDiscovered: 10, maxVendorsEnriched: 5 },
  ajiDnaEnabled: false,
  selectedProducts: { audio: false, video: false, slides: false, report: false, infographic: false },
  customizations: { perplexity: { queryFraming: "", emphasis: [], outputStructure: "" }, notebookLM: { persona: "", researchMode: "deep", priorities: [] }, studio: {} },
  notifyEmail: "",
  generatedQuestions: [],
  dynamicAnswers: {},
  extractedContext: null,
  pipelineMode: "full",
};
