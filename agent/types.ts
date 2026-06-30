/**
 * Shared types for the worker daemon.
 *
 * Mirrors the frontend's lib/types/queue.ts — kept standalone so the
 * agent/ package doesn't depend on the Next.js frontend.
 */

// Type-only import: erased at runtime, so types.ts stays runtime-standalone (no
// conventions.json fs.readFileSync is pulled in just because a module imports a
// type from here). StudioProduct is the canonical union (plan-types.ts).
import type { StudioProduct } from "./lib/plan-types.js";

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
 * S158 transient-tolerant studio gate (parallel dimension to JobStatus — the
 * plan_review_* precedent). Mirrors the CHECK constraint in
 * supabase/migrations/20260623_studio_recovery_dimension.sql §1.
 *   none      -- not in the recovery path (default)
 *   pending   -- artifact confirmed status_id 3 in NLM but download transiently
 *                failed; the decoupled sweep is retrying off the critical path
 *   recovered -- sweep re-downloaded + re-asserted obligations + completed
 *   exhausted -- attempt/age cap breached OR artifact gone (terminal)
 */
export type StudioRecoveryStatus = "none" | "pending" | "recovered" | "exhausted";

/**
 * S158 — one still-pending studio product carried in studio_recovery_payload.
 * artifactId is the confirmed status_id-3 NLM artifact id so the sweep
 * downloads BY ID (never default-latest — feedback_nlm_download_default_latest).
 */
export interface StudioRecoveryProduct {
  product: string;
  artifactId: string;
  nlmType: string;
  filename: string;
  /**
   * S187 P0-2 (Branch (c)): how the decoupled sweep recovers this product.
   * ABSENT ⇒ 'download' (backward-compat for in-flight pre-S187 pending rows —
   * Codex M-5). 'render' = the Studio video was still rendering at the worker
   * checkpoint; the sweep polls a STATUS-AWARE NLM list until status_id 3, then
   * downloads. The render-vs-download distinction lives HERE, not in the status
   * enum (design §7.1/D-2 — studio_recovery_status reuses 'pending').
   */
  recovery_kind?: "download" | "render";
  /**
   * S187 P0-2 ('render' only): the exact in-progress NLM artifact id (==
   * state.artifacts.video.task_id). The sweep matches on this so a foreign /
   * prior-run video rendering in a REUSED notebook can never be attached to
   * this run (Gemini C-3 / Codex C-3 anti-stale identity).
   */
  videoTaskId?: string;
  /**
   * S187 P0-2 ('render' only): the run-start floor in ms (from deriveRunStart).
   * An in-progress artifact created BEFORE this floor belongs to a prior run and
   * is ignored. Persisted in the payload because the sweep cannot recompute it
   * (G6 — the sweep loads only DB columns + payload, never the workdir/state).
   */
  runFloorMs?: number;
}

/**
 * S158 — self-sufficient recovery descriptor (design G8) persisted in the
 * studio_recovery_payload jsonb column. Carries the notebook id + the confirmed
 * artifact ids of every product whose download transiently failed, so the
 * out-of-band sweep can re-download by id without state.json on disk.
 */
export interface StudioRecoveryPayload {
  notebookId: string;
  products: StudioRecoveryProduct[];
}

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
  /**
   * MRPF PUBLISH gate (S108). True marks the job's output as bound for
   * external distribution / decision authorization: the worker then refuses
   * completeJob() unless state.json carries a passing publish_verification
   * manifest (lib/publish-gate.ts), and the orchestrator treats the
   * Perplexity WebSearch fallback as a HARD FAILURE instead of a substitute.
   * Optional so pre-S108 rows deserialize cleanly; absent means false.
   * Lives inside the user_context jsonb column — no migration required.
   */
  publishRequired?: boolean;
}

// ── MRPF PUBLISH verification manifest (S108) ───────────────────────
// Written by the /research-compare orchestrator into state.json for
// publish-required jobs; structurally re-validated at runtime by
// lib/publish-gate.ts (the state file is pipeline-written and untrusted).

export type VendorLegStatus = "ok" | "degraded" | "failed" | "skipped";

export interface VendorLegReport {
  status: VendorLegStatus;
  /** e.g. "sonar-deep-research completed", "WebSearch fallback", "401 insufficient_quota" */
  detail?: string;
}

export interface PublishVendorLegs {
  perplexity: VendorLegReport;
  notebooklm: VendorLegReport;
  claude: VendorLegReport;
}

export type ClaimVerdict = "verified" | "verified_with_caveat" | "refuted" | "unverifiable";

export type SourceQualityClass = "primary" | "official" | "reputable-secondary" | "weak";

export interface VerifiedClaim {
  text: string;
  /** Temporal anchor — a real YYYY-MM-DD calendar date (strictly validated). */
  asOfDate: string;
  /** Parseable http(s) URLs (strictly validated — S108 Codex C5). */
  sourceUrls: string[];
  /** Publication or access date per source; each must contain a YYYY-MM-DD. */
  sourceDates: string[];
  /** Closed set — free-form classes are rejected by the gate (Codex C5). */
  sourceQualityClass: SourceQualityClass;
  /** Why the corroborating sources do NOT trace to the same upstream. */
  upstreamIndependenceBasis: string;
  verdict: ClaimVerdict;
  /** Explicit "none found" required — silence is not evidence of absence. */
  counterEvidenceNotes: string;
}

export type ClaimsExtractionStatus = "populated" | "no_load_bearing_claims";

export interface PublishVerification {
  verification_status: "passed" | "failed" | "not_run";
  claims_extraction_status: ClaimsExtractionStatus;
  vendor_legs: PublishVendorLegs;
  claims: VerifiedClaim[];
  /**
   * REQUIRED (>=20 chars) when claims_extraction_status is
   * "no_load_bearing_claims" — the escape hatch from claim verification must
   * leave an auditable justification (S108 Gemini G4).
   */
  no_claims_justification?: string;
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

/**
 * Studio-product selection booleans, single-sourced (S169) over the canonical
 * StudioProduct union (plan-types.ts -> conventions.json). `Record<StudioProduct,
 * boolean>` is structurally identical to the former 5-field interface today, so
 * every `sel.audio` / `sel[p]` read and `{...} as SelectedProducts` cast is
 * unchanged; adding a product to conventions.json now makes every object literal
 * that omits the new key a compile error here — the single-source enforcement.
 * (The frontend's lib/types/queue.ts twin is a separate, deferred follow-up.)
 */
export type SelectedProducts = Record<StudioProduct, boolean>;

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
   * S158 transient-tolerant studio gate (migration
   * 20260623_studio_recovery_dimension.sql). Optional/defaulted so rows from
   * before the migration deserialize cleanly. The executor writes these on the
   * transient branch via updateJob; the decoupled sweep advances them via
   * direct service-role REST. See
   * Documentation/studio-completeness-transient-tolerance-design-gate.md.
   */
  studio_recovery_status?: StudioRecoveryStatus;
  studio_recovery_attempts?: number;
  studio_recovery_first_failed_at?: string | null;
  studio_recovery_next_attempt_at?: string | null;
  studio_recovery_payload?: StudioRecoveryPayload | null;
  studio_recovery_error?: string | null;
  /**
   * S187 P0-2 — set true when a run completed BEST-EFFORT with its Studio video
   * deferred (the render exceeded the window). Mirrors the additive migration
   * column 20260629_studio_recovery_video_deferred.sql; the results page selects
   * it to surface an honest "video unavailable for this run" banner. Optional so
   * pre-migration rows deserialize cleanly.
   */
  studio_recovery_video_deferred?: boolean;
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
  /**
   * MRPF PUBLISH gate (S108). Seeded by buildManifest from
   * user_context.publishRequired; the orchestrator must carry it forward and
   * populate publish_verification before declaring the pipeline complete.
   * Optional so pre-S108 state files deserialize cleanly. The gate treats the
   * state file as untrusted and re-validates structurally at runtime.
   */
  publish_required?: boolean;
  publish_verification?: PublishVerification | null;
}
