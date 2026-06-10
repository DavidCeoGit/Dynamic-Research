/**
 * Shared types for the worker daemon.
 *
 * Mirrors the frontend's lib/types/queue.ts — kept standalone so the
 * agent/ package doesn't depend on the Next.js frontend.
 */

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/**
 * S58 plan-review gate (parallel to JobStatus — Codex CRITICAL-1 split).
 * Mirrors the CHECK constraint in supabase/migrations/20260527_plan_review_gate.sql §1.
 */
export type PlanReviewStatus =
  | "pending"
  | "reviewing"
  | "approved"
  | "request_changes"
  | "blocked"
  | "system_blocked";

/**
 * Pipeline mode (CE-3). "full" runs the normal deep-research pipeline via
 * Claude. "studio_only" skips research entirely and regenerates Studio
 * products against the parent run's existing notebook — the worker spawns
 * agent/scripts/regenerate-studio-products.ts instead of Claude.
 * See Documentation/clone-and-edit-design.md.
 */
export type PipelineMode = "full" | "studio_only";

export interface UserContext {
  domainKnowledge: string[];
  constraints: string[];
  additionalUrls: string[];
  claimsToVerify: string[];
}

export interface VendorEvaluation {
  enabled: boolean;
  vendorType: string;
  serviceArea: string;
  serviceAddress: string;
  jobDescription: string;
  maxVendorsDiscovered: number;
  maxVendorsEnriched: number;
}

export interface SelectedProducts {
  audio: boolean;
  video: boolean;
  slides: boolean;
  report: boolean;
  infographic: boolean;
}

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

/**
 * S102 file-upload feature — metadata for one user-attached source file
 * (PDF/TXT/MD). The storage object lives at
 * scopedSourcesPath(organization_id, topic_slug, storedName) in the
 * research-projects bucket; the executor downloads it into
 * <workdir>/sources/ before spawning the pipeline.
 *
 * originalName is DISPLAY ONLY (fenced before reaching any prompt) and must
 * never be used in a storage path. storedName is produced by the frontend's
 * sanitizeAttachmentName() and re-validated by zod at submit + the path
 * helpers at every construction. Mirrors frontend lib/types/queue.ts.
 */
export interface AttachmentMeta {
  originalName: string;
  storedName: string;
  sizeBytes: number;
  /* uploadedAt below must be UTC "Z"-form ISO-8601 (new Date().toISOString());
     zod .datetime() rejects timezone offsets. */
  contentType: "application/pdf" | "text/plain" | "text/markdown";
  uploadedAt: string;
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
   * Phase A multi-tenancy (S47) — every queue row carries an org_id, backfilled
   * to system-default for pre-existing rows and DEFAULT'd at insert time. The
   * Phase B helper `scopedStoragePath` requires this for every upload, so it
   * is declared required (not nullable). The /api/queue/claim fallback path
   * does `SELECT *` which always returns it; the unused `claim_next_job` RPC
   * does not exist in production (verified S50).
   */
  organization_id: string;
  /**
   * CE-3. Optional so rows from before the pipeline_mode migration (and
   * any /api/queue/claim payload that predates it) deserialize cleanly.
   * The executor treats undefined as "full".
   */
  pipeline_mode?: PipelineMode;
  /**
   * S35 Clone & Edit. The run this was cloned from. Required for
   * studio_only mode (the worker resolves the parent's notebook from it).
   * Optional/null for fresh full-pipeline submissions.
   */
  parent_run_id?: string | null;
  /**
   * S58 plan-review gate (migration 20260527_plan_review_gate.sql).
   * Optional/defaulted so rows from before the migration deserialize cleanly.
   * See Documentation/final-plan-design-gate.md §5. plan_json is the
   * synthesized ResearchPlan; typed as `unknown` here to keep the canonical
   * type in agent/lib/plan-types.ts (api-client.ts narrows it via cast).
   */
  plan_json?: unknown | null;
  plan_review_status?: PlanReviewStatus;
  plan_review_iterations?: number;
  plan_review_attempts?: number;
  plan_review_next_attempt_at?: string | null;
  plan_review_error?: string | null;
  /**
   * S102 file-upload (migration 20260610_research_queue_attachments.sql).
   * Optional so rows from before the migration deserialize cleanly. The
   * executor treats undefined/empty as "no attachments" and skips the
   * download step entirely (also skipped on the studio_only path).
   */
  attachments?: AttachmentMeta[];
}

/**
 * State file shape written by /research-compare CLI.
 * The worker monitors this for progress updates.
 */
export interface PipelineState {
  timestamp: string;
  topic: string;
  topic_slug: string;
  version: number;
  phase: string;
  phase_status: string;
  notebook_id: string | null;
  notebook_title: string | null;
  projects_path: string | null;
  perplexity_mcp_available: boolean;
  aji_dna_enabled: boolean;
  persona_configured: boolean;
  topic_half_life: string | null;
  userContext: UserContext;
  selectedProducts: SelectedProducts;
  customizations: Customizations;
  vendorEvaluation: VendorEvaluation & {
    vendorsDiscovered: unknown[];
    vendorsShortlisted: unknown[];
    vendorsExcluded: unknown[];
    preScreeningComplete: boolean;
  };
  artifacts: Record<string, unknown>;
  files_written: string[];
}
