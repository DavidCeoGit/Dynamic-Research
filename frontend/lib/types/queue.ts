/**
 * Shared types for the research job queue.
 *
 * Used by API routes, hooks, form components, and the worker daemon.
 */

// S172 single-source: SelectedProducts is the hermetic frontend canonical
// Record<StudioProductKey, boolean> (lib/studio-products.ts). Imported here for
// this module's OWN internal use (ResearchJobPayload, ResearchJob) and re-exported
// below so existing importers ("@/lib/types/queue") keep working unchanged. The
// "../" is load-bearing: queue.ts lives in lib/types/, the module in lib/.
import type { SelectedProducts } from "../studio-products";

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
  /**
   * MRPF PUBLISH gate (S108). True marks the run's output as bound for
   * external distribution / decision authorization; the worker then refuses
   * completion without a passing publish_verification manifest
   * (agent/lib/publish-gate.ts). Optional: absent means false. No UI sets it
   * yet (dark-launch); zod defaults it false at submit.
   */
  publishRequired?: boolean;
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

// SelectedProducts is imported at the top of this file (hermetic canonical) and
// re-exported here so "@/lib/types/queue" consumers resolve it unchanged.
export type { SelectedProducts };

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

// ── Attachments (S102 file-upload feature) ──────────────────────────

export type AttachmentContentType =
  | "application/pdf"
  | "text/plain"
  | "text/markdown";

/**
 * Metadata for one user-attached source file (PDF/TXT/MD). Stored in the
 * research_queue.attachments jsonb column (migration
 * 20260610_research_queue_attachments.sql); the storage object lives at
 * scopedSourcesPath(orgId, slug, storedName) once the run is submitted.
 *
 * originalName is DISPLAY ONLY and must never be used in a storage path.
 * storedName comes from sanitizeAttachmentName() (lib/attachments-constants)
 * and is re-validated by attachmentMetaSchema at submit. Mirrors
 * agent/types.ts.
 */
export interface AttachmentMeta {
  originalName: string;
  storedName: string;
  sizeBytes: number;
  /* uploadedAt below must be UTC "Z"-form ISO-8601 (new Date().toISOString());
     zod .datetime() rejects timezone offsets. */
  contentType: AttachmentContentType;
  uploadedAt: string;
}

/**
 * Where a payload attachment's bytes currently live, so the submit route
 * knows where to copy FROM:
 *   "staging" — freshly uploaded this draft → <orgId>/uploads/<draftId>/
 *   "parent"  — carried over by Clone & Edit → <orgId>/<parentSlug>/sources/
 * Payload-only; the DB row stores plain AttachmentMeta (origin stripped
 * after the submit-time copy resolves it).
 */
export type AttachmentOrigin = "staging" | "parent";

export interface AttachmentPayloadItem extends AttachmentMeta {
  origin: AttachmentOrigin;
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
  /**
   * S102 file-upload. Attachment refs the submit route verifies + copies
   * into the new run's sources/ folder before inserting the row. Optional
   * so pre-S102 clients keep working; defaulted to [] by zod.
   */
  attachments?: AttachmentPayloadItem[];
  /**
   * S102 — the client-generated draft UUID locating staged uploads at
   * <orgId>/uploads/<draftId>/. Required by the submit route whenever any
   * attachment has origin "staging".
   */
  attachmentsDraftId?: string | null;
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

/**
 * S158 transient-tolerant studio gate — parallel dimension to JobStatus.
 * Mirrors agent/types.ts:StudioRecoveryStatus + the CHECK constraint in
 * supabase/migrations/20260623_studio_recovery_dimension.sql §1. The UI derives
 * the "Finalizing media" treatment from (status='failed' AND
 * studio_recovery_status='pending').
 */
export type StudioRecoveryStatus = "none" | "pending" | "recovered" | "exhausted";

export interface StudioRecoveryProduct {
  product: string;
  artifactId: string;
  nlmType: string;
  filename: string;
  /**
   * S187 P0-2 (Branch (c)) — how the sweep recovers this product. ABSENT ⇒
   * 'download' (backward-compat). 'render' = the Studio video was still rendering
   * at the checkpoint. Mirrors agent/types.ts:StudioRecoveryProduct +
   * frontend/lib/validate.ts:studioRecoveryPayloadSchema (cross-tier parity).
   */
  recovery_kind?: "download" | "render";
  /** S187 P0-2 ('render' only): exact in-progress NLM artifact id (anti-stale identity). */
  videoTaskId?: string;
  /** S187 P0-2 ('render' only): run-start floor (ms) — an older in-progress artifact is foreign. */
  runFloorMs?: number;
}

export interface StudioRecoveryPayload {
  notebookId: string;
  products: StudioRecoveryProduct[];
}

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
  /**
   * S158 transient-tolerant studio gate (migration
   * 20260623_studio_recovery_dimension.sql). Optional so rows from before the
   * migration deserialize cleanly. The detail page polls these via GET
   * /api/queue/[id] (select *); the dashboard list select includes
   * studio_recovery_status so it can derive the "Finalizing media" chip.
   */
  studio_recovery_status?: StudioRecoveryStatus;
  studio_recovery_attempts?: number;
  studio_recovery_first_failed_at?: string | null;
  studio_recovery_next_attempt_at?: string | null;
  studio_recovery_payload?: StudioRecoveryPayload | null;
  studio_recovery_error?: string | null;
  /**
   * S187 P0-2 — true when a run completed BEST-EFFORT with its Studio video
   * deferred (the render exceeded the window). Mirrors agent/types.ts:ResearchJob
   * + migration 20260629_studio_recovery_video_deferred.sql; the results page
   * selects it to surface an honest "video unavailable for this run" banner.
   */
  studio_recovery_video_deferred?: boolean;
  /**
   * S102 file-upload (migration 20260610_research_queue_attachments.sql).
   * Optional so rows from before the migration deserialize cleanly. Plain
   * AttachmentMeta — the payload-level `origin` field is resolved (and
   * stripped) by the submit-time copy.
   */
  attachments?: AttachmentMeta[];
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
