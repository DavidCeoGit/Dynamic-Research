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

/**
 * S58 plan-review gate — parallel dimension to JobStatus per Codex CRITICAL-1
 * split. Mirrors agent/types.ts:PlanReviewStatus + the schema CHECK constraint
 * in supabase/migrations/20260527_plan_review_gate.sql §1.
 * UI renders derived display state from the (status, plan_review_status) tuple
 * per Documentation/final-plan-design-gate.md §4.
 */
export type PlanReviewStatus =
  | "pending"
  | "reviewing"
  | "approved"
  | "request_changes"
  | "blocked"
  | "system_blocked";

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
  /**
   * S58 plan-review gate (migration 20260527_plan_review_gate.sql).
   * Optional/defaulted so rows from before the migration deserialize cleanly.
   * `plan_json` is the synthesized ResearchPlan; typed as `unknown` here to
   * keep the canonical type in the agent's lib/plan-types.ts and avoid a
   * cross-package import from frontend → agent.
   */
  plan_json?: unknown | null;
  plan_review_status?: PlanReviewStatus;
  plan_review_iterations?: number;
  plan_review_attempts?: number;
  plan_review_next_attempt_at?: string | null;
  plan_review_error?: string | null;
}

// ── Form step constants & component interfaces ─────────────────────

export const FORM_STEPS: FormStep[] = ["topic", "questions", "products", "customize", "review"];

export interface StepProps {
  onNext: () => void;
  onPrev: () => void;
}

export interface StepQuestionsProps extends StepProps {
  isGenerating: boolean;
}

export interface StepProductsProps extends StepProps {
  estMins: number;
}

export interface StepReviewProps {
  onPrev: () => void;
  isSubmitting: boolean;
  submitError: string | null;
  estMins: number;
  // CE-3 — when present, StepReview renders the pipeline-mode radio. Absent
  // for fresh submissions (no parent notebook to reuse).
  cloneSlug: string | null;
}
