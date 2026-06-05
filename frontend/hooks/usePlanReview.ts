"use client";

import useSWR from "swr";

/**
 * S60 — plan-review gate state for a run, polled every 5s.
 * Backs the (status, plan_review_status) tuple-render banner on
 * runs/[slug]/page.tsx. Mirrors the SWR pattern of useRunState.
 *
 * S60.3 — `topic` added so the page can render a useful
 * "pending pickup" mini-view when state.json hasn't been written yet.
 */
export interface PlanReviewSummary {
  topic: string;
  status: string;
  plan_review_status: string | null;
  plan_review_iterations: number | null;
  plan_review_attempts: number | null;
  plan_review_next_attempt_at: string | null;
  plan_review_error: string | null;
}

const fetcher = async (url: string): Promise<PlanReviewSummary> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`plan-review fetch failed: ${res.status}`);
  return res.json();
};

export function usePlanReview(slug: string | null | undefined) {
  const url = slug ? `/api/runs/${encodeURIComponent(slug)}/plan-review` : null;

  const { data, error, isLoading, mutate } = useSWR<PlanReviewSummary>(
    url,
    fetcher,
    {
      revalidateOnFocus: true,
      refreshInterval: 5_000,
      onErrorRetry(_err, _key, _config, revalidate, { retryCount }) {
        if (retryCount >= 3) return;
        setTimeout(() => revalidate({ retryCount }), 2_000);
      },
    },
  );

  return {
    review: data ?? null,
    isLoading,
    isError: !!error,
    mutate,
  };
}
