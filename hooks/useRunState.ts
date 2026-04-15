"use client";

import useSWR from "swr";

// ── State shape (mirrors CLI state.json) ────────────────────────────

export interface ArtifactState {
  task_id: string;
  status: "generating" | "polling" | "completed" | "failed" | "timeout";
  version: number;
  format?: string;
  alternate_tasks?: string[];
}

export interface RunState {
  timestamp: string;
  topic: string;
  topic_slug: string;
  phase: string;
  phase_status: string;
  notebook_id: string | null;
  notebook_title: string | null;
  version: number;
  projects_path: string | null;
  perplexity_mcp_available: boolean;
  perplexity_source_urls_passed: string[];
  perplexity_source_urls_rejected: string[];
  tier1_scores: Record<string, number>;
  aji_dna_enabled: boolean;
  persona_configured: boolean;
  topic_half_life: string | null;
  auth_verified_at: string | null;
  queued_urls_for_notebooklm: string[];
  userContext: {
    contextFilePath: string | null;
    additionalUrls: string[];
    claimsToVerify: string[];
    domainKnowledge: string[];
    constraints: string[];
    localSourcePath: string | null;
  };
  selectedProducts: Record<string, boolean>;
  customizations: {
    perplexity: { queryFraming: string; emphasis: string[]; outputStructure: string };
    notebookLM: { persona: string; researchMode: string; priorities: string[] };
    studio: Record<string, Record<string, unknown>>;
  };
  vendorEvaluation: {
    enabled: boolean;
    vendorType: string;
    serviceArea: string;
    serviceAddress: string;
    jobDescription: string;
    maxVendorsDiscovered: number;
    maxVendorsEnriched: number;
    vendorsDiscovered: string[];
    vendorsShortlisted: string[];
    vendorsExcluded: string[];
    preScreeningComplete: boolean;
  };
  artifacts: Record<string, ArtifactState>;
  files_written: string[];
}

// ── Fetcher ─────────────────────────────────────────────────────────

const fetcher = async (url: string): Promise<RunState> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`State fetch failed: ${res.status}`);
  return res.json();
};

// ── Hook ────────────────────────────────────────────────────────────

/**
 * SWR-powered hook that polls `/api/state` for the current run state.
 *
 * - `revalidateOnFocus` re-fetches when the browser tab regains focus.
 * - `refreshInterval` polls every 5 s while the run is active.
 * - Transient fetch errors (e.g., CLI locking state.json mid-write) are
 *   silently suppressed for the first two retries to avoid console spam.
 */
export function useRunState() {
  const { data, error, isLoading, mutate } = useSWR<RunState>(
    "/api/state",
    fetcher,
    {
      revalidateOnFocus: true,
      refreshInterval: 5_000,
      onErrorRetry(err, _key, _config, revalidate, { retryCount }) {
        // Suppress transient errors (CLI momentarily locks the file).
        // Silently retry up to 3 times, then let SWR surface the error.
        if (retryCount >= 3) return;
        setTimeout(() => revalidate({ retryCount }), 2_000);
      },
    },
  );

  return {
    state: data ?? null,
    isLoading,
    isError: !!error,
    mutate,
  };
}
