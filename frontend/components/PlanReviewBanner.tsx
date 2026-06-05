"use client";

import { Loader2, AlertTriangle, XCircle, RefreshCw } from "lucide-react";

/**
 * S60 — derived-display banner for the plan-review gate.
 *
 * Reads the (status, plan_review_status) tuple per
 * Documentation/final-plan-design-gate.md §9. Returns null when the gate
 * is not user-visible (approved / inherited / no row).
 *
 * Phase 2 will add reviewer-call details + finding rendering (design §9);
 * this banner stays minimal during dark-launch.
 */
export interface PlanReviewBannerProps {
  status: string;
  planReviewStatus: string | null;
  planReviewError?: string | null;
  nextAttemptAt?: string | null;
}

interface BannerSpec {
  tone: "info" | "warn" | "error";
  icon: React.ReactNode;
  title: string;
  body: string;
}

function specFor(
  status: string,
  prs: string | null,
  error: string | null | undefined,
  nextAttemptAt: string | null | undefined,
): BannerSpec | null {
  if (!prs) return null;

  // (running, reviewing) — gate in flight
  if (status === "running" && prs === "reviewing") {
    return {
      tone: "info",
      icon: <Loader2 className="h-5 w-5 animate-spin" />,
      title: "Reviewing your plan…",
      body: "Two reviewers are evaluating the research plan before the pipeline runs (~5 min).",
    };
  }

  // (running, request_changes) — user input needed
  if (status === "running" && prs === "request_changes") {
    return {
      tone: "warn",
      icon: <AlertTriangle className="h-5 w-5" />,
      title: "Plan needs your input",
      body: "The reviewers asked for changes. Email has the full findings; rich in-app view is coming in Phase 2.",
    };
  }

  // (failed, blocked) — terminal plan reject
  if (status === "failed" && prs === "blocked") {
    return {
      tone: "error",
      icon: <XCircle className="h-5 w-5" />,
      title: "Plan rejected",
      body: "Reviewers blocked this plan. See email for the verdict and findings.",
    };
  }

  // (pending|running, system_blocked) — infra failure, auto-retrying
  if (
    (status === "pending" || status === "running") &&
    prs === "system_blocked"
  ) {
    const when = nextAttemptAt ? ` Next attempt: ${nextAttemptAt}.` : "";
    return {
      tone: "warn",
      icon: <RefreshCw className="h-5 w-5" />,
      title: "System issue — auto-retrying",
      body: `Reviewer infrastructure unavailable.${when} ${error ? `Detail: ${error.slice(0, 200)}` : ""}`.trim(),
    };
  }

  // approved, pending (pre-gate), reviewing-already-decorated, etc. → no banner.
  return null;
}

const TONE_CLASSES: Record<BannerSpec["tone"], string> = {
  info: "border-[#3b82f6]/40 bg-[#3b82f6]/10 text-[#93c5fd]",
  warn: "border-[#c8a951]/40 bg-[#c8a951]/10 text-[#e8d18a]",
  error: "border-red-500/40 bg-red-500/10 text-red-300",
};

export default function PlanReviewBanner({
  status,
  planReviewStatus,
  planReviewError,
  nextAttemptAt,
}: PlanReviewBannerProps) {
  const spec = specFor(status, planReviewStatus, planReviewError, nextAttemptAt);
  if (!spec) return null;

  return (
    <div
      className={`mt-6 flex items-start gap-3 rounded-lg border px-4 py-3 ${TONE_CLASSES[spec.tone]}`}
      role={spec.tone === "error" ? "alert" : "status"}
    >
      <div className="mt-0.5 shrink-0">{spec.icon}</div>
      <div className="flex-1 text-sm">
        <p className="font-medium">{spec.title}</p>
        <p className="mt-0.5 text-xs opacity-90">{spec.body}</p>
      </div>
    </div>
  );
}
