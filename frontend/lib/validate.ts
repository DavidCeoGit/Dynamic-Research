/**
 * Input validation and sanitization for the research queue.
 */

import { z } from "zod";
import {
  ATTACHMENT_ALLOWED_MIME_TYPES,
  ATTACHMENT_EXT_TO_MIME,
  ATTACHMENT_MAX_FILES,
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  ATTACHMENT_STORED_NAME_REGEX,
  isReservedBasename,
} from "./attachments-constants";

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

// ── Attachments (S102 file-upload feature) ──────────────────────────

/**
 * One user-attached source file's metadata as stored on the queue row.
 * storedName must match sanitizeAttachmentName() output exactly — lowercase,
 * safe charset, allowed extension, no leading dot (a leading "." is a
 * skip-prefix in conventions.json), no ".." (charset admits dots, so the
 * refine closes the consecutive-dots hole the regex leaves open). The
 * storage-path helpers re-reject traversal at every path construction
 * (defense in depth — a zod bypass still cannot build a traversal path).
 */
const attachmentMetaBaseSchema = z.object({
  originalName: z.string().min(1).max(255),
  storedName: z
    .string()
    .min(1)
    .max(160)
    .regex(ATTACHMENT_STORED_NAME_REGEX, "invalid stored filename")
    .refine((s) => !s.includes(".."), { message: "stored filename must not contain '..'" })
    // Codex S103 grounded-adversarial MAJOR-2 — a sanitized storedName never
    // hits a Windows reserved device name (sanitizeAttachmentName remaps), so
    // a reserved one here means tampering or a non-sanitizer path; reject it
    // before it can reach the Phase-3 Windows worker's sources/ write.
    .refine((s) => !isReservedBasename(s), { message: "stored filename uses a reserved device name" }),
  sizeBytes: z.number().int().min(1).max(ATTACHMENT_MAX_FILE_BYTES),
  // Gemini-grounded interim MINOR-2 — reference the canonical list so a
  // future type addition cannot drift between constants and validation.
  contentType: z.enum(ATTACHMENT_ALLOWED_MIME_TYPES),
  // NOTE: zod .datetime() accepts UTC "Z"-form only (offsets rejected) —
  // clients must emit new Date().toISOString().
  uploadedAt: z.string().datetime(),
});

// S102 interim-review MAJOR-1 — extension and MIME type are both
// client-supplied; without this cross-check a .md payload could be stored
// and later served as application/pdf (content-type confusion at Phase 2
// upload + Phase 3 worker handling). ATTACHMENT_EXT_TO_MIME is canonical.
// Applied to BOTH the meta schema and the payload variant (the base object
// stays refine-free so .extend() remains available).
const extMatchesContentType = {
  check: (m: { storedName: string; contentType: string }) =>
    ATTACHMENT_EXT_TO_MIME[m.storedName.slice(m.storedName.lastIndexOf("."))] ===
    m.contentType,
  opts: { message: "contentType must match the stored filename's extension", path: ["contentType"] },
};

export const attachmentMetaSchema = attachmentMetaBaseSchema.refine(
  extMatchesContentType.check,
  extMatchesContentType.opts,
);

/**
 * Payload variant: adds `origin` so the submit route knows where to copy
 * bytes FROM ("staging" = this draft's uploads/ area; "parent" = a Clone &
 * Edit carry-over living under the parent run's sources/). origin is
 * stripped before the row is inserted — the DB stores plain AttachmentMeta.
 */
export const attachmentPayloadItemSchema = attachmentMetaBaseSchema
  .extend({
    origin: z.enum(["staging", "parent"]),
  })
  .refine(extMatchesContentType.check, extMatchesContentType.opts);

/**
 * The attachments array as submitted: bounded count, bounded total bytes,
 * and unique storedNames (duplicates would collide at the submit-time copy
 * destination <orgId>/<slug>/sources/<storedName>).
 */
export const attachmentsArraySchema = z
  .array(attachmentPayloadItemSchema)
  .max(ATTACHMENT_MAX_FILES, `at most ${ATTACHMENT_MAX_FILES} attachments`)
  .refine(
    (arr) => arr.reduce((sum, a) => sum + a.sizeBytes, 0) <= ATTACHMENT_MAX_TOTAL_BYTES,
    { message: "total attachment size exceeds the limit" },
  )
  .refine(
    (arr) => new Set(arr.map((a) => a.storedName)).size === arr.length,
    { message: "duplicate stored filenames" },
  );

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
  // S102 file-upload. Defaulted [] so pre-S102 clients keep working. The
  // submit route additionally requires a session-sourced org whenever
  // non-empty (the cross-field origin rules are enforced right here).
  attachments: attachmentsArraySchema.optional().default([]),
  attachmentsDraftId: z.string().uuid().nullable().optional(),
}).superRefine((data, ctx) => {
  // S102 Gemini MERGE MINOR-1 — make the cross-field contract self-enforcing
  // rather than delegating to the Phase 2 route: staged attachments are
  // unlocatable without the draft id (their bytes live at
  // <orgId>/uploads/<attachmentsDraftId>/), and parent carry-overs are
  // unlocatable without the parent run's slug. A payload violating either
  // pairing is malformed at the schema level, not a route concern.
  if (
    data.attachments.some((a) => a.origin === "staging") &&
    !data.attachmentsDraftId
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attachmentsDraftId"],
      message: 'attachmentsDraftId is required when any attachment has origin "staging"',
    });
  }
  if (
    data.attachments.some((a) => a.origin === "parent") &&
    !data.parentSlug
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["parentSlug"],
      message: 'parentSlug is required when any attachment has origin "parent"',
    });
  }
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
  // S102 file-upload. Items carry origin ("staging" for fresh uploads,
  // "parent" for Clone & Edit carry-overs). Files upload at select-time —
  // File objects can't survive the sessionStorage draft persistence, but
  // these metadata refs can.
  attachments: attachmentsArraySchema.default([]),
  attachmentsDraftId: z.string().uuid().nullable().default(null),
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
  attachments: [],
  attachmentsDraftId: null,
};
