"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRunState } from "@/hooks/useRunState";
import { usePlanReview } from "@/hooks/usePlanReview";
import PhaseTimeline from "@/components/PhaseTimeline";
import CIScoreChart from "@/components/CIScoreChart";
import VendorTabs from "@/components/VendorTabs";
import PlanReviewBanner from "@/components/PlanReviewBanner";
import {
  GalleryHorizontalEnd,
  Loader2,
  RefreshCw,
  AlertCircle,
  AlertTriangle,
  Copy,
  Repeat,
  X,
} from "lucide-react";

// ── Constants ───────────────────────────────────────────────────────

const PRODUCT_KEYS = ["audio", "video", "slides", "report", "infographic"] as const;
type ProductKey = (typeof PRODUCT_KEYS)[number];
type ProductMap = Record<ProductKey, boolean>;

function normalizeProducts(raw: Record<string, boolean> | undefined): ProductMap {
  return {
    audio: !!raw?.audio,
    video: !!raw?.video,
    slides: !!raw?.slides,
    report: !!raw?.report,
    infographic: !!raw?.infographic,
  };
}

// ── Component ───────────────────────────────────────────────────────

export default function RunDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const router = useRouter();
  const { state, isLoading, isError, mutate } = useRunState(slug);
  // S60 — plan-review gate UI: derived display from (status, plan_review_status)
  // tuple. Hook silently no-ops + banner returns null when the row has no
  // plan_review_status (legacy + studio-only runs). S60.3 also returns
  // `topic` so we can show a meaningful pending-pickup view.
  const { review, mutate: mutateReview } = usePlanReview(slug);

  // S60 — Replay state + modal.
  const [replayModalOpen, setReplayModalOpen] = useState(false);
  const [replayProducts, setReplayProducts] = useState<ProductMap>({
    audio: false,
    video: false,
    slides: false,
    report: false,
    infographic: false,
  });
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);

  function openReplayModal() {
    setReplayProducts(normalizeProducts(state?.selectedProducts));
    setReplayError(null);
    setReplayModalOpen(true);
  }

  function closeReplayModal() {
    if (replayLoading) return;
    setReplayModalOpen(false);
  }

  function toggleProduct(key: ProductKey) {
    setReplayProducts((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const anyProductSelected = PRODUCT_KEYS.some((k) => replayProducts[k]);

  async function submitReplay() {
    if (replayLoading || !anyProductSelected) return;
    setReplayLoading(true);
    setReplayError(null);
    try {
      const res = await fetch(
        `/api/runs/${encodeURIComponent(slug)}/replay`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selectedProducts: replayProducts }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
        };
        throw new Error(body.detail || body.error || `HTTP ${res.status}`);
      }
      const { slug: newSlug } = (await res.json()) as { slug: string };
      router.push(`/runs/${newSlug}`);
    } catch (err) {
      setReplayError(err instanceof Error ? err.message : String(err));
      setReplayLoading(false);
    }
  }

  function refreshAll() {
    mutate();
    mutateReview();
  }

  // ── Loading ────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center py-32">
        <Loader2 className="h-8 w-8 animate-spin text-[#3b82f6]" />
        <span className="ml-3 text-sm text-zinc-400">
          Loading run state…
        </span>
      </div>
    );
  }

  // ── Pending pickup (S60.3) ─────────────────────────────────────
  // state.json doesn't exist yet, but the queue row does. Happens between
  // queue-row insert and the worker writing the first state.json. Show a
  // minimal waiting view + the plan-review banner if applicable. SWR
  // auto-refresh (5s) transitions to the main view once state.json lands.
  if ((isError || !state) && review) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-zinc-500">
              Run Detail
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-100">
              {review.topic || slug}
            </h1>
            <p className="mt-1 font-mono text-sm text-zinc-500">{slug}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={refreshAll}
              className="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-300 transition hover:bg-zinc-700 active:scale-95"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>
        </div>

        <PlanReviewBanner
          status={review.status}
          planReviewStatus={review.plan_review_status}
          planReviewError={review.plan_review_error}
          nextAttemptAt={review.plan_review_next_attempt_at}
        />

        <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-zinc-500" />
          <p className="mt-3 text-sm text-zinc-300">
            Waiting for the worker to begin processing this run…
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Queue status: <span className="font-mono text-zinc-400">{review.status}</span>
            {" · "}This page auto-refreshes every 5s.
          </p>
        </div>
      </div>
    );
  }

  // ── True error: no state.json AND no queue row ─────────────────
  if (isError || !state) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-32 text-zinc-400">
        <AlertCircle className="h-10 w-10 text-zinc-600" />
        <p className="text-sm">
          Run not found in your organization, or both /api/state and
          /api/runs/[slug]/plan-review are unreachable.
        </p>
        <p className="font-mono text-xs text-zinc-600">{slug}</p>
        <button
          onClick={refreshAll}
          className="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-300 transition hover:bg-zinc-700"
        >
          <RefreshCw className="h-4 w-4" />
          Retry
        </button>
      </div>
    );
  }

  // ── Show gallery link when artifacts exist ─────────────────────
  const hasArtifacts =
    state.artifacts && Object.keys(state.artifacts).length > 0;

  // ── Main layout ────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-zinc-500">
            Run Detail
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-100">
            {state.topic}
          </h1>
          <p className="mt-1 font-mono text-sm text-zinc-500">{slug}</p>
        </div>

        <div className="flex items-center gap-2">
          {/* S60 — Replay (full pipeline rerun; opens product-selection modal) */}
          <button
            onClick={openReplayModal}
            disabled={replayLoading}
            className="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-300 transition hover:border-[#c8a951] hover:bg-zinc-700 hover:text-[#c8a951] active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
            title="Rerun this run — choose which Studio products to regenerate. ~$5-15, ~30-90 min."
          >
            <Repeat className="h-4 w-4" />
            Replay
          </button>
          {/* S35 Clone & Edit — opens the form pre-filled from this run's manifest */}
          <Link
            href={`/new?clone=${slug}`}
            className="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-300 transition hover:border-[#c8a951] hover:bg-zinc-700 hover:text-[#c8a951] active:scale-95"
            title="Open the form with every field pre-filled from this run — edit what you want and submit to create a linked v2"
          >
            <Copy className="h-4 w-4" />
            Clone &amp; Edit
          </Link>
          <button
            onClick={refreshAll}
            className="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-300 transition hover:bg-zinc-700 active:scale-95"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      {/* ── Replay error toast (outside modal so it survives modal close) */}
      {replayError && !replayModalOpen && (
        <div
          className="mt-4 flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300"
          role="alert"
        >
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="flex-1">
            <p className="font-medium">Replay failed</p>
            <p className="mt-0.5 text-xs opacity-90">{replayError}</p>
          </div>
          <button
            onClick={() => setReplayError(null)}
            className="text-xs text-red-300 underline hover:text-red-200"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Plan-review gate banner (S60) ─────────────────── */}
      {review && (
        <PlanReviewBanner
          status={review.status}
          planReviewStatus={review.plan_review_status}
          planReviewError={review.plan_review_error}
          nextAttemptAt={review.plan_review_next_attempt_at}
        />
      )}

      {/* ── A5: all-attachments-skipped banner ─────────────── */}
      {state.userContext.allAttachmentsSkipped && (
        <div
          className="mt-4 flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-300"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
          <div className="flex-1">
            <p className="font-medium text-amber-200">Attached files could not be used</p>
            <p className="mt-0.5 text-xs opacity-90">
              {state.userContext.attachmentsSkipped?.length ?? 0} file
              {(state.userContext.attachmentsSkipped?.length ?? 0) === 1 ? "" : "s"} were
              submitted but skipped by the worker. Common causes: Windows-1252 or UTF-16
              encoding (re-save as UTF-8), or unsupported binary content in a text file.
              {state.userContext.attachmentsSkipped &&
                state.userContext.attachmentsSkipped.length > 0 && (
                  <span>
                    {" "}Affected:{" "}
                    {state.userContext.attachmentsSkipped.map((s) => s.originalName).join(", ")}.
                  </span>
                )}
            </p>
          </div>
        </div>
      )}

      {/* ── Phase timeline stepper ─────────────────────────── */}
      <div className="mt-8 rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <PhaseTimeline
          phase={state.phase}
          phaseStatus={state.phase_status}
        />
      </div>

      {/* ── Metadata ribbon ────────────────────────────────── */}
      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-zinc-500">
        <span>
          Phase:{" "}
          <span className="font-mono text-zinc-400">{state.phase}</span>
        </span>
        <span>
          Status:{" "}
          <span className="text-zinc-400">
            {state.phase_status.replace(/_/g, " ")}
          </span>
        </span>
        <span>
          Version:{" "}
          <span className="font-mono text-zinc-400">v{state.version}</span>
        </span>
        <span>
          Timestamp:{" "}
          <span className="font-mono text-zinc-400">
            {state.timestamp}
          </span>
        </span>
        {state.topic_half_life && (
          <span>
            Half-life:{" "}
            <span className="text-zinc-400">{state.topic_half_life}</span>
          </span>
        )}
      </div>

      {/* ── Gallery link ───────────────────────────────────── */}
      {hasArtifacts && (
        <div className="mt-4">
          <Link
            href={`/runs/${slug}/gallery`}
            className="inline-flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-300 transition hover:border-[#c8a951] hover:bg-zinc-700 hover:text-[#c8a951]"
          >
            <GalleryHorizontalEnd className="h-4 w-4" />
            Media Gallery
          </Link>
        </div>
      )}

      {/* ── Deep Data Views ────────────────────────────────── */}
      <div className="mt-10 space-y-6">
        {/* CI Score Chart */}
        <CIScoreChart
          tier1Scores={state.tier1_scores}
          passedUrls={state.perplexity_source_urls_passed}
          rejectedUrls={state.perplexity_source_urls_rejected}
          topicHalfLife={state.topic_half_life}
        />

        {/* Source Tabs */}
        <VendorTabs state={state} />
      </div>

      {/* ── Replay modal (S60.1) ─────────────────────────── */}
      {replayModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={closeReplayModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="replay-modal-title"
        >
          <div
            className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <h2
                  id="replay-modal-title"
                  className="text-lg font-semibold text-zinc-100"
                >
                  Replay this run
                </h2>
                <p className="mt-1 text-xs text-zinc-500">
                  Same topic and inputs. Pick which Studio products to regenerate.
                </p>
              </div>
              <button
                onClick={closeReplayModal}
                disabled={replayLoading}
                className="rounded-md p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-40"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-5 space-y-2">
              {PRODUCT_KEYS.map((key) => (
                <label
                  key={key}
                  className="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-300 transition hover:border-zinc-700"
                >
                  <input
                    type="checkbox"
                    checked={replayProducts[key]}
                    onChange={() => toggleProduct(key)}
                    disabled={replayLoading}
                    className="h-4 w-4 cursor-pointer accent-[#c8a951]"
                  />
                  <span className="capitalize">{key}</span>
                </label>
              ))}
            </div>

            {replayError && (
              <div
                className="mt-4 flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300"
                role="alert"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="flex-1">{replayError}</p>
              </div>
            )}

            <p className="mt-4 text-[11px] text-zinc-500">
              ~$5-15 + ~30-90 min depending on selection. Lineage links back to this run.
            </p>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                onClick={closeReplayModal}
                disabled={replayLoading}
                className="rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-300 transition hover:bg-zinc-700 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={submitReplay}
                disabled={replayLoading || !anyProductSelected}
                className="flex items-center gap-2 rounded-md border border-[#c8a951]/60 bg-[#c8a951]/15 px-4 py-2 text-sm text-[#c8a951] transition hover:border-[#c8a951] hover:bg-[#c8a951]/25 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {replayLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Repeat className="h-4 w-4" />
                )}
                {replayLoading ? "Submitting…" : "Replay"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
