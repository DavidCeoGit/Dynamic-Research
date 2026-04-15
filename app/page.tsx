"use client";

import { useRunState } from "@/hooks/useRunState";
import {
  Loader2,
  RefreshCw,
  Globe,
  BookOpen,
  Brain,
  CheckCircle2,
  Clock,
  AlertCircle,
} from "lucide-react";

// ── Helpers ─────────────────────────────────────────────────────────

/** Map a phase string to a human-readable label. */
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

/** Derive a colour class from phase_status. */
function statusColor(status: string): string {
  if (status === "complete") return "text-emerald-400";
  if (status === "aborted_by_user") return "text-red-400";
  return "text-[#c8a951]"; // gold = in-progress
}

/** Check whether a source file pattern appears in files_written. */
function hasFile(files: string[], pattern: string): boolean {
  return files.some((f) => f.includes(pattern));
}

type SourceStatus = "complete" | "pending" | "error";

function deriveSourceStatus(
  files: string[],
  pattern: string,
): SourceStatus {
  if (hasFile(files, pattern)) return "complete";
  return "pending";
}

const STATUS_ICON = {
  complete: CheckCircle2,
  pending: Clock,
  error: AlertCircle,
} as const;

const STATUS_STYLE = {
  complete:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
  pending:
    "border-[#c8a951]/30 bg-[#c8a951]/10 text-[#c8a951]",
  error:
    "border-red-500/30 bg-red-500/10 text-red-400",
} as const;

// ── Component ───────────────────────────────────────────────────────

export default function Dashboard() {
  const { state, isLoading, isError, mutate } = useRunState();

  // ── Loading state ──────────────────────────────────────────────
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

  // ── Error / no data state ──────────────────────────────────────
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

  // ── Derive source statuses ─────────────────────────────────────
  const sources: {
    name: string;
    icon: typeof Globe;
    status: SourceStatus;
  }[] = [
    {
      name: "Perplexity",
      icon: Globe,
      status: deriveSourceStatus(state.files_written, "perplexity"),
    },
    {
      name: "NotebookLM",
      icon: BookOpen,
      status: deriveSourceStatus(state.files_written, "notebooklm"),
    },
    {
      name: "Claude Baseline",
      icon: Brain,
      status: deriveSourceStatus(state.files_written, "comparison"),
    },
  ];

  // ── Dashboard ──────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      {/* ── Header row ─────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
            Dashboard
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Run state for the active /research-compare session
          </p>
        </div>

        <button
          onClick={() => mutate()}
          className="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-300 transition hover:bg-zinc-700 active:scale-95"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh State
        </button>
      </div>

      {/* ── Global status card ─────────────────────────────── */}
      <div className="mt-8 rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <div className="flex items-center gap-3">
          <span
            className={`text-xs font-medium uppercase tracking-widest ${statusColor(state.phase_status)}`}
          >
            {state.phase_status.replace(/_/g, " ")}
          </span>
          <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs font-mono text-zinc-400">
            {phaseLabel(state.phase)}
          </span>
          <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs font-mono text-zinc-400">
            v{state.version}
          </span>
        </div>

        <h2 className="mt-3 text-xl font-semibold text-zinc-100">
          {state.topic}
        </h2>

        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-zinc-500">
          <span>
            Timestamp:{" "}
            <span className="font-mono text-zinc-400">
              {state.timestamp}
            </span>
          </span>
          <span>
            Slug:{" "}
            <span className="font-mono text-zinc-400">
              {state.topic_slug}
            </span>
          </span>
          {state.topic_half_life && (
            <span>
              Half-life:{" "}
              <span className="text-zinc-400">
                {state.topic_half_life}
              </span>
            </span>
          )}
        </div>
      </div>

      {/* ── Research source status grid ────────────────────── */}
      <h3 className="mt-10 text-sm font-medium uppercase tracking-widest text-zinc-500">
        Research Sources
      </h3>

      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {sources.map(({ name, icon: Icon, status }) => {
          const StatusIcon = STATUS_ICON[status];
          return (
            <div
              key={name}
              className={`flex items-center gap-4 rounded-lg border p-4 ${STATUS_STYLE[status]}`}
            >
              <Icon className="h-6 w-6 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium">{name}</p>
                <div className="mt-0.5 flex items-center gap-1.5 text-xs opacity-80">
                  <StatusIcon className="h-3.5 w-3.5" />
                  <span className="capitalize">{status}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Quick stats ────────────────────────────────────── */}
      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          {
            label: "Tier 1 Passed",
            value: state.perplexity_source_urls_passed.length,
          },
          {
            label: "Tier 1 Rejected",
            value: state.perplexity_source_urls_rejected.length,
          },
          {
            label: "Files Written",
            value: state.files_written.length,
          },
          {
            label: "Products",
            value: Object.values(state.selectedProducts).filter(Boolean)
              .length,
          },
        ].map(({ label, value }) => (
          <div
            key={label}
            className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3"
          >
            <p className="text-xs text-zinc-500">{label}</p>
            <p className="mt-1 text-2xl font-semibold text-zinc-100">
              {value}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
