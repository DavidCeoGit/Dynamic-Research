"use client";

import Link from "next/link";
import useSWR from "swr";
import {
  Loader2,
  AlertCircle,
  CheckCircle2,
  Clock,
  ChevronRight,
  Music,
  Video,
  Image as ImageIcon,
  Presentation,
  FileText,
} from "lucide-react";

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
  const { data: runs, error, isLoading } = useSWR<RunSummary[]>(
    "/api/runs",
    fetcher,
    { revalidateOnFocus: true },
  );

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center py-32">
        <Loader2 className="h-8 w-8 animate-spin text-[#3b82f6]" />
        <span className="ml-3 text-sm text-zinc-400">
          Loading research runs...
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-32 text-zinc-400">
        <AlertCircle className="h-10 w-10 text-zinc-600" />
        <p className="text-sm">Could not load research runs.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
            Research Runs
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            {runs?.length ?? 0} project{(runs?.length ?? 0) !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      {(!runs || runs.length === 0) && (
        <div className="mt-16 flex flex-col items-center gap-4 text-zinc-400">
          <AlertCircle className="h-10 w-10 text-zinc-600" />
          <p className="text-sm">No research runs yet.</p>
          <p className="text-xs text-zinc-500">
            Run /research-compare in Claude Code to create your first project.
          </p>
        </div>
      )}

      <div className="mt-8 space-y-4">
        {runs?.map((run) => {
          const isComplete = run.phase_status === "complete";
          const products = Object.entries(run.selectedProducts).filter(
            ([, v]) => v,
          );

          return (
            <Link
              key={run.slug}
              href={`/runs/${run.slug}`}
              className="group flex items-center gap-4 rounded-lg border border-zinc-800 bg-zinc-900 p-5 transition hover:border-zinc-700 hover:bg-zinc-800"
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
                <h2 className="text-base font-semibold text-zinc-100 group-hover:text-white">
                  {run.topic}
                </h2>

                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
                  <span className="font-mono">{formatTimestamp(run.timestamp)}</span>
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

              {/* Arrow */}
              <ChevronRight className="h-5 w-5 shrink-0 text-zinc-600 transition group-hover:text-zinc-400" />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
