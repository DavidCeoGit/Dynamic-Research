/**
 * Shared types for the research job queue.
 *
 * Used by API routes, hooks, form components, and the worker daemon.
 */

// ── Form step progression ───────────────────────────────────────────

export type FormStep = "topic" | "questions" | "products" | "customize" | "review";

// ── AI-generated question ───────────────────────────────────────────

export interface GeneratedQuestion {
  id: string;
  text: string;
  type: "text" | "boolean" | "multiselect";
  options?: string[];
  /** Which field in userContext or vendorEvaluation this answer maps to. */
  mappedField: string;
}

// ── User context (collected during questions step) ──────────────────

export interface UserContext {
  domainKnowledge: string[];
  constraints: string[];
  additionalUrls: string[];
  claimsToVerify: string[];
}

// ── Vendor evaluation config ────────────────────────────────────────

export interface VendorEvaluation {
  enabled: boolean;
  vendorType: string;
  serviceArea: string;
  serviceAddress: string;
  jobDescription: string;
  maxVendorsDiscovered: number;
  maxVendorsEnriched: number;
}

// ── Product selection ───────────────────────────────────────────────

export interface SelectedProducts {
  audio: boolean;
  video: boolean;
  slides: boolean;
  report: boolean;
  infographic: boolean;
}

// ── Studio customizations ───────────────────────────────────────────

export interface PerplexityCustomization {
  queryFraming: string;
  emphasis: string[];
  outputStructure: string;
}

export interface NotebookLMCustomization {
  persona: string;
  researchMode: "deep" | "standard";
  priorities: string[];
}

export interface Customizations {
  perplexity: PerplexityCustomization;
  notebookLM: NotebookLMCustomization;
  studio: Record<string, Record<string, unknown>>;
}

// ── Form submission payload (POST /api/queue) ───────────────────────

export interface ResearchJobPayload {
  topic: string;
  userContext: UserContext;
  vendorEvaluation: VendorEvaluation;
  ajiDnaEnabled: boolean;
  selectedProducts: SelectedProducts;
  customizations: Customizations;
  notifyEmail?: string;
}

// ── Queue row shape (GET /api/queue/[id]) ───────────────────────────

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface ResearchJob {
  id: string;
  created_at: string;
  updated_at: string;
  status: JobStatus;
  claimed_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  topic: string;
  topic_slug: string;
  user_context: UserContext;
  vendor_evaluation: VendorEvaluation;
  aji_dna_enabled: boolean;
  selected_products: SelectedProducts;
  customizations: Customizations;
  notify_email: string | null;
  current_phase: string;
  phase_status: string;
  progress_pct: number;
  estimated_minutes: number | null;
  result_slug: string | null;
}
