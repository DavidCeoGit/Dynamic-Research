"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import {
  Plus,
  Activity,
  CheckCircle2,
  Clock,
  AlertTriangle,
  ChevronRight,
  Music,
  Video,
  Image as ImageIcon,
  Presentation,
  FileText,
  EyeOff,
  Eye,
  RotateCcw,
} from "lucide-react";
import type { ResearchJob } from "@/lib/types/queue";
import { phaseFromProgress } from "@/lib/estimates";
import { CardSkeleton } from "@/components/Skeleton";

// ── Types ──────────────────────────────────────────────────────────

interface RunSummary {
  slug: string;
  topic: string;
  timestamp: string;
  phase: string;
  phase_status: string;
  version: number;
  selectedProducts: Record<string, boolean>;
  vendorEvaluationEnabled: boolean;
  fileCount: number;
  hidden?: boolean;
}

// /api/runs envelope (S92): wraps the list so the UI can show "N hidden" and
// gate the hide controls from the response body. v4: canHide is org-scoped and
// always true (hide works on the env-fallback path), replacing the v3 `auth`.
interface RunsEnvelope {
  runs: RunSummary[];
  hiddenCount: number;
  canHide: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.json();
};

function phaseLabel(phase: string): string {
  const map: Record<string, string> = {
    "0.5": "Discussion",
    "0": "Preflight",
    "1": "Research",
    "1.5": "CI Scoring",
    "3": "Import",
    "4": "Extraction",
    "5": "Synthesis",
    "5.5a": "Vendors",
    "5.5": "Studio",
    "6": "Complete",
  };
  return map[phase] ?? `Phase ${phase}`;
}

function formatTimestamp(ts: string): string {
  if (ts.length < 8) return ts;
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
}

const PRODUCT_ICONS: Record<string, typeof Music> = {
  audio: Music,
  video: Video,
  infographic: ImageIcon,
  slides: Presentation,
  report: FileText,
};

// ── Component ───────────────────────────────────────────────────────

export default function HomePage() {
  const { data: activeJobs, error: activeError } = useSWR<ResearchJob[]>(
    "/api/queue",
    fetcher,
    { refreshInterval: 5000 },
  );

  // Show-hidden toggle: flips the SWR key so the archived view caches separately.
  const [showHidden, setShowHidden] = useState(false);
  const {
    data: runsData,
    error: runsError,
    mutate: mutateRuns,
  } = useSWR<RunsEnvelope>(
    `/api/runs${showHidden ? "?show_hidden=1" : ""}`,
    fetcher,
    { revalidateOnFocus: true },
  );

  const runs = runsData?.runs ?? [];
  const hiddenCount = runsData?.hiddenCount ?? 0;
  const canHide = runsData?.canHide ?? false;

  const isLoadingActive = !activeJobs && !activeError;
  const isLoadingRuns = !runsData && !runsError;
  const isEmpty =
    !isLoadingActive &&
    !isLoadingRuns &&
    (!activeJobs || activeJobs.length === 0) &&
    runs.length === 0 &&
    hiddenCount === 0;

  // ── Hide / unhide handlers (S92) ──────────────────────────────────
  async function postHide(method: "POST" | "DELETE", body: unknown) {
    try {
      await fetch("/api/runs/hide", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } finally {
      mutateRuns();
    }
  }
  const hideRun = (slug: string) => postHide("POST", { slug });
  const unhideRun = (slug: string) => postHide("DELETE", { slug });

  function hideAllCompleted() {
    const visible = runs.filter((r) => !r.hidden).map((r) => r.slug);
    if (visible.length === 0) return;
    const ok = window.confirm(
      `Hide all ${visible.length} completed run${visible.length === 1 ? "" : "s"} ` +
        `from your view? They stay saved and can be restored from "Show hidden".`,
    );
    if (!ok) return;
    postHide("POST", { slugs: visible });
  }

  const showRunsSection =
    isLoadingRuns || runs.length > 0 || hiddenCount > 0;

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 sm:py-12 animate-in fade-in duration-500">
      {/* ── Page header ──────────────────────────────────────── */}
      <div className="mb-10 flex flex-col items-start justify-between gap-4 border-b border-zinc-800 pb-6 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-zinc-100 flex items-center gap-3">
            <Activity className="h-6 w-6 text-[#c8a951]" />
            Research Dashboard
          </h1>
          <p className="mt-2 text-sm sm:text-base text-zinc-400">
            Manage and monitor your AI-powered research pipelines.
          </p>
        </div>
        <Link
          href="/new"
          className="flex shrink-0 items-center justify-center gap-2 rounded-md bg-[#c8a951] px-5 py-2.5 text-sm font-medium text-[#1a2744] transition-all hover:bg-[#d4b85e] active:scale-95 shadow-lg shadow-[#c8a951]/20"
        >
          <Plus className="h-4 w-4" /> New Research
        </Link>
      </div>

      {/* ── Empty state ──────────────────────────────────────── */}
      {isEmpty && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-zinc-700 bg-zinc-900/30 p-12 text-center">
          <Activity className="mb-4 h-12 w-12 text-zinc-600" />
          <h2 className="text-xl font-medium text-zinc-200">No Research Found</h2>
          <p className="mb-6 mt-2 max-w-md text-zinc-500">
            You haven&apos;t queued any research pipelines yet. Click below to start your first deep dive.
          </p>
          <Link
            href="/new"
            className="flex items-center gap-2 rounded-md bg-[#c8a951] px-6 py-3 text-sm font-medium text-[#1a2744] transition hover:bg-[#d4b85e]"
          >
            <Plus className="h-4 w-4" /> Create First Research
          </Link>
        </div>
      )}

      {/* ── Active Jobs Section ──────────────────────────────── */}
      {(isLoadingActive || (activeJobs && activeJobs.length > 0)) && (
        <section className="mb-12">
          <h2 className="mb-4 flex items-center gap-2 text-lg font-medium text-zinc-300">
            <Clock className="h-5 w-5 text-[#c8a951]" /> Active Pipelines
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {isLoadingActive ? (
              <>
                <CardSkeleton />
                <CardSkeleton />
              </>
            ) : (
              activeJobs?.map((job) => (
                <Link
                  key={job.id}
                  href={`/new/${job.id}`}
                  className="group relative flex flex-col justify-between overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50 p-5 transition-all hover:border-[#c8a951]/50 hover:bg-zinc-800"
                >
                  {/* Progress bar at top */}
                  <div
                    className={`absolute top-0 left-0 h-1 transition-all duration-1000 ease-out ${
                      job.status === "failed" ? "bg-red-500" : "bg-[#c8a951]"
                    }`}
                    style={{ width: `${job.progress_pct}%` }}
                  />

                  <div>
                    <div className="mb-3 flex items-start justify-between gap-4">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                          job.status === "failed"
                            ? "bg-red-500/10 text-red-400"
                            : "bg-[#c8a951]/10 text-[#c8a951]"
                        }`}
                      >
                        {job.status === "failed" ? (
                          <AlertTriangle className="h-3 w-3" />
                        ) : (
                          <Clock className="h-3 w-3 animate-pulse" />
                        )}
                        {job.status}
                      </span>
                      <span className="text-xs font-mono text-zinc-500">
                        {job.progress_pct}%
                      </span>
                    </div>
                    <h3 className="line-clamp-2 text-sm font-medium leading-snug text-zinc-100 group-hover:text-[#c8a951] transition-colors">
                      {job.topic}
                    </h3>
                  </div>

                  <div className="mt-6 flex items-center justify-between border-t border-zinc-800/60 pt-4 text-xs font-medium">
                    <span className="text-zinc-500">
                      {new Date(job.created_at).toLocaleDateString()}
                    </span>
                    <span
                      className={`capitalize ${
                        job.status === "failed" ? "text-red-400" : "text-zinc-400"
                      }`}
                    >
                      {job.status === "failed"
                        ? "Execution Error"
                        : phaseFromProgress(job.progress_pct) || job.current_phase || "Pending"}
                    </span>
                  </div>
                </Link>
              ))
            )}
          </div>
        </section>
      )}

      {/* ── Completed Runs Section ───────────────────────────── */}
      {showRunsSection && (
        <section>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-lg font-medium text-zinc-300">
              <CheckCircle2 className="h-5 w-5 text-emerald-500" /> Completed Runs
            </h2>
            {/* Hide controls — only for a real (signed-in) session */}
            {canHide && (
              <div className="flex items-center gap-2">
                {!showHidden && runs.some((r) => !r.hidden) && (
                  <button
                    onClick={hideAllCompleted}
                    className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200"
                  >
                    <EyeOff className="h-3.5 w-3.5" /> Hide all
                  </button>
                )}
                {(hiddenCount > 0 || showHidden) && (
                  <button
                    onClick={() => setShowHidden((v) => !v)}
                    className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200"
                  >
                    {showHidden ? (
                      <>
                        <Eye className="h-3.5 w-3.5" /> Hide hidden
                      </>
                    ) : (
                      <>
                        <Eye className="h-3.5 w-3.5" /> Show hidden ({hiddenCount})
                      </>
                    )}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* All visible runs hidden, and not showing them → reassurance, not blank */}
          {!isLoadingRuns && runs.length === 0 && hiddenCount > 0 && !showHidden && (
            <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-900/30 p-8 text-center text-sm text-zinc-400">
              {hiddenCount} run{hiddenCount === 1 ? "" : "s"} hidden from your view — they&apos;re still saved.{" "}
              <button
                onClick={() => setShowHidden(true)}
                className="font-medium text-[#c8a951] underline-offset-2 hover:underline"
              >
                Show hidden
              </button>
            </div>
          )}

          <div className="space-y-4">
            {isLoadingRuns ? (
              <>
                <CardSkeleton />
                <CardSkeleton />
                <CardSkeleton />
              </>
            ) : (
              runs.map((run) => {
                const isComplete = run.phase_status === "complete";
                const products = Object.entries(run.selectedProducts).filter(
                  ([, v]) => v,
                );

                return (
                  <Link
                    key={run.slug}
                    href={`/runs/${run.slug}`}
                    className={`group flex items-center gap-4 rounded-lg border p-5 transition ${
                      run.hidden
                        ? "border-zinc-800/60 bg-zinc-900/40 opacity-60 hover:opacity-100"
                        : "border-zinc-800 bg-zinc-900 hover:border-zinc-700 hover:bg-zinc-800"
                    }`}
                  >
                    {/* Status indicator */}
                    <div className="shrink-0">
                      {isComplete ? (
                        <CheckCircle2 className="h-6 w-6 text-emerald-400" />
                      ) : (
                        <Clock className="h-6 w-6 text-[#c8a951]" />
                      )}
                    </div>

                    {/* Content */}
                    <div className="min-w-0 flex-1">
                      <h3 className="text-base font-semibold text-zinc-100 group-hover:text-white">
                        {run.topic}
                        {run.hidden && (
                          <span className="ml-2 rounded-full bg-zinc-700/50 px-2 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wider text-zinc-400">
                            Hidden
                          </span>
                        )}
                      </h3>

                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
                        <span className="font-mono">
                          {formatTimestamp(run.timestamp)}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            isComplete
                              ? "bg-emerald-500/10 text-emerald-400"
                              : "bg-[#c8a951]/10 text-[#c8a951]"
                          }`}
                        >
                          {phaseLabel(run.phase)}
                        </span>
                        <span className="font-mono">v{run.version}</span>
                        <span>{run.fileCount} files</span>
                        {run.vendorEvaluationEnabled && (
                          <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-blue-400">
                            Vendors
                          </span>
                        )}
                      </div>

                      {/* Product icons */}
                      <div className="mt-2 flex items-center gap-2">
                        {products.map(([key]) => {
                          const Icon = PRODUCT_ICONS[key];
                          return Icon ? (
                            <span key={key} title={key}>
                              <Icon className="h-4 w-4 text-zinc-500" />
                            </span>
                          ) : null;
                        })}
                      </div>
                    </div>

                    {/* Hide / Unhide control (signed-in only) — stops link nav */}
                    {canHide && (
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          run.hidden ? unhideRun(run.slug) : hideRun(run.slug);
                        }}
                        title={run.hidden ? "Restore to my view" : "Hide from my view"}
                        aria-label={run.hidden ? "Unhide run" : "Hide run from my view"}
                        className="shrink-0 rounded-md p-2 text-zinc-500 opacity-0 transition hover:bg-zinc-800 hover:text-zinc-200 focus:opacity-100 group-hover:opacity-100"
                      >
                        {run.hidden ? (
                          <RotateCcw className="h-4 w-4" />
                        ) : (
                          <EyeOff className="h-4 w-4" />
                        )}
                      </button>
                    )}

                    {/* Arrow */}
                    <ChevronRight className="h-5 w-5 shrink-0 text-zinc-600 transition group-hover:text-zinc-400" />
                  </Link>
                );
              })
            )}
          </div>
        </section>
      )}
    </div>
  );
}
