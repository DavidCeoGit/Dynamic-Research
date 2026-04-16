/**
 * Input validation and sanitization for the research queue.
 */

import { z } from "zod";

// ── Slug generation ─────────────────────────────────────────────────

/**
 * Generate a URL-safe slug from a topic string.
 * Appends a 4-character random hash to prevent collisions.
 */
export function generateSlug(topic: string): string {
  const base = topic
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40)
    .replace(/-$/, "");

  const hash = Math.random().toString(36).slice(2, 6);
  return `${base}-${hash}`;
}

// ── Zod schemas ─────────────────────────────────────────────────────

export const userContextSchema = z.object({
  domainKnowledge: z.array(z.string().max(500)).default([]),
  constraints: z.array(z.string().max(500)).default([]),
  additionalUrls: z.array(z.string().url().max(2000)).default([]),
  claimsToVerify: z.array(z.string().max(500)).default([]),
});

export const vendorEvaluationSchema = z.object({
  enabled: z.boolean().default(false),
  vendorType: z.string().max(100).default(""),
  serviceArea: z.string().max(200).default(""),
  serviceAddress: z.string().max(300).default(""),
  jobDescription: z.string().max(1000).default(""),
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
  queryFraming: z.string().max(500).default(""),
  emphasis: z.array(z.string().max(200)).default([]),
  outputStructure: z.string().max(500).default(""),
});

export const notebookLMSchema = z.object({
  persona: z.string().max(1000).default(""),
  researchMode: z.enum(["deep", "standard"]).default("deep"),
  priorities: z.array(z.string().max(200)).default([]),
});

export const customizationsSchema = z.object({
  perplexity: perplexitySchema.optional().default({ queryFraming: "", emphasis: [], outputStructure: "" }),
  notebookLM: notebookLMSchema.optional().default({ persona: "", researchMode: "deep" as const, priorities: [] }),
  studio: z.record(z.string(), z.record(z.string(), z.unknown())).optional().default({}),
});

export const researchJobPayloadSchema = z.object({
  topic: z.string().min(10, "Topic must be at least 10 characters").max(500),
  userContext: userContextSchema.optional().default({ domainKnowledge: [], constraints: [], additionalUrls: [], claimsToVerify: [] }),
  vendorEvaluation: vendorEvaluationSchema.optional().default({ enabled: false, vendorType: "", serviceArea: "", serviceAddress: "", jobDescription: "", maxVendorsDiscovered: 10, maxVendorsEnriched: 5 }),
  ajiDnaEnabled: z.boolean().default(false),
  selectedProducts: selectedProductsSchema,
  customizations: customizationsSchema.optional().default({ perplexity: { queryFraming: "", emphasis: [], outputStructure: "" }, notebookLM: { persona: "", researchMode: "deep" as const, priorities: [] }, studio: {} }),
  notifyEmail: z.string().email().optional().or(z.literal("")),
});

export const generateQuestionsSchema = z.object({
  topic: z.string().min(10).max(500),
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
  questions: z.array(generatedQuestionSchema).min(5).max(7),
});

/** Schema for agent progress updates. */
export const agentUpdateSchema = z.object({
  current_phase: z.string().optional(),
  phase_status: z.string().optional(),
  progress_pct: z.number().int().min(0).max(100).optional(),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]).optional(),
  result_slug: z.string().optional(),
  error_message: z.string().optional(),
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
  topic: z.string().min(10, "Topic must be at least 10 characters").max(500),
  userContext: userContextSchema.default({ domainKnowledge: [], constraints: [], additionalUrls: [], claimsToVerify: [] }),
  vendorEvaluation: vendorEvaluationSchema.default({ enabled: false, vendorType: "", serviceArea: "", serviceAddress: "", jobDescription: "", maxVendorsDiscovered: 10, maxVendorsEnriched: 5 }),
  ajiDnaEnabled: z.boolean().default(false),
  selectedProducts: selectedProductsBaseSchema,
  customizations: customizationsSchema.default({ perplexity: { queryFraming: "", emphasis: [], outputStructure: "" }, notebookLM: { persona: "", researchMode: "deep" as const, priorities: [] }, studio: {} }),
  notifyEmail: z.string().email().optional().or(z.literal("")),
  generatedQuestions: z.array(generatedQuestionSchema).default([]),
  dynamicAnswers: z.record(z.string(), z.union([z.string(), z.boolean(), z.array(z.string())])).default({}),
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
};
