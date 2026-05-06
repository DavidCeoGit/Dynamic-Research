/**
 * Shared types for the worker daemon.
 *
 * Mirrors the frontend's lib/types/queue.ts — kept standalone so the
 * agent/ package doesn't depend on the Next.js frontend.
 */

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

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
