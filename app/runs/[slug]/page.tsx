"use client";

import { use } from "react";
import Link from "next/link";
import { useRunState } from "@/hooks/useRunState";
import PhaseTimeline from "@/components/PhaseTimeline";
import CIScoreChart from "@/components/CIScoreChart";
import VendorTabs from "@/components/VendorTabs";
import {
  GalleryHorizontalEnd,
  Loader2,
  RefreshCw,
  AlertCircle,
} from "lucide-react";

// ── Component ───────────────────────────────────────────────────────

export default function RunDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const { state, isLoading, isError, mutate } = useRunState(slug);

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

  // ── Error / no data ────────────────────────────────────────────
  if (isError || !state) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-32 text-zinc-400">
        <AlertCircle className="h-10 w-10 text-zinc-600" />
        <p className="text-sm">
          {isError
            ? "Could not reach /api/state — is the API route running?"
            : "No run state available."}
        </p>
        <button
          onClick={() => mutate()}
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

        <button
          onClick={() => mutate()}
          className="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-300 transition hover:bg-zinc-700 active:scale-95"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

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
    </div>
  );
}
