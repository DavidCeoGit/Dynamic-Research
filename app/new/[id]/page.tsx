"use client";

import { use, useEffect, useState, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  ArrowLeft,
  Clock,
  RefreshCw,
  ArrowRight,
  Zap,
  Search,
  BarChart3,
  FileDown,
  Layers,
  Sparkles,
  Package,
  Flag,
} from "lucide-react";
import type { ResearchJob } from "@/lib/types/queue";

// ── Phase timeline definition ──────────────────────────────────────

interface Phase {
  key: string;
  label: string;
  icon: React.ReactNode;
  minPct: number;
}

const PHASES: Phase[] = [
  { key: "preflight",  label: "Preflight",           icon: <Zap className="h-4 w-4" />,        minPct: 0 },
  { key: "research",   label: "Perplexity Research",  icon: <Search className="h-4 w-4" />,     minPct: 10 },
  { key: "scoring",    label: "CI Scoring",           icon: <BarChart3 className="h-4 w-4" />,  minPct: 25 },
  { key: "import",     label: "NotebookLM Import",    icon: <FileDown className="h-4 w-4" />,   minPct: 30 },
  { key: "extraction", label: "Extraction",           icon: <Layers className="h-4 w-4" />,     minPct: 50 },
  { key: "synthesis",  label: "Synthesis",            icon: <Sparkles className="h-4 w-4" />,   minPct: 60 },
  { key: "studio",     label: "Studio Products",      icon: <Package className="h-4 w-4" />,    minPct: 70 },
  { key: "finalize",   label: "Finalization",         icon: <Flag className="h-4 w-4" />,       minPct: 95 },
];

function phaseStatus(pct: number, phase: Phase): "done" | "active" | "pending" {
  const idx = PHASES.indexOf(phase);
  const next = PHASES[idx + 1];
  if (next && pct >= next.minPct) return "done";
  if (pct >= phase.minPct) return "active";
  return "pending";
}

// ── Fetcher ────────────────────────────────────────────────────────

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.json();
};

// ── Elapsed time hook ──────────────────────────────────────────────

function useElapsed(startIso: string | null, stop: boolean): string {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!startIso || stop) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startIso, stop]);

  if (!startIso) return "0:00";
  const diff = Math.max(0, Math.floor((now - new Date(startIso).getTime()) / 1000));
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── Main component ─────────────────────────────────────────────────

export default function ProgressPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const redirectStarted = useRef(false);

  const { data: job, error, mutate } = useSWR<ResearchJob>(
    `/api/queue/${id}`,
    fetcher,
    { refreshInterval: 3000 },
  );

  const isComplete = job?.status === "completed";
  const isFailed = job?.status === "failed";
  const isTerminal = isComplete || isFailed;
  const pct = job?.progress_pct ?? 0;
  const elapsed = useElapsed(job?.claimed_at ?? null, isTerminal);

  // Auto-redirect on completion
  useEffect(() => {
    if (!isComplete || !job?.result_slug || redirectStarted.current) return;
    redirectStarted.current = true;
    setCountdown(3);
  }, [isComplete, job?.result_slug]);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      router.push(`/runs/${job!.result_slug}`);
      return;
    }
    const t = setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown, router, job]);

  // Retry handler
  async function handleRetry() {
    if (!job) return;
    setRetrying(true);
    try {
      const res = await fetch("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: job.topic,
          userContext: job.user_context,
          vendorEvaluation: job.vendor_evaluation,
          ajiDnaEnabled: job.aji_dna_enabled,
          selectedProducts: job.selected_products,
          customizations: job.customizations,
        }),
      });
      if (!res.ok) throw new Error("Retry failed");
      const { id: newId } = await res.json();
      router.push(`/new/${newId}`);
    } catch {
      setRetrying(false);
    }
  }

  // ── Error state (no job found) ──────────────────────────────────

  if (error) {
    return (
      <div className="mx-auto max-w-xl px-6 py-16 text-center">
        <XCircle className="mx-auto h-12 w-12 text-red-400" />
        <h1 className="mt-4 text-xl font-semibold text-zinc-100">Job Not Found</h1>
        <p className="mt-2 text-sm text-zinc-500">Could not find research job {id}</p>
        <Link href="/" className="mt-6 inline-flex items-center gap-2 text-sm text-[#c8a951] hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to Dashboard
        </Link>
      </div>
    );
  }

  // ── Loading state ───────────────────────────────────────────────

  if (!job) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-8 w-8 animate-spin text-[#c8a951]" />
      </div>
    );
  }

  // ── Main render ─────────────────────────────────────────────────

  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      {/* Header */}
      <div className="text-center mb-10">
        {isComplete ? (
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-emerald-500/10 animate-in fade-in zoom-in duration-500">
            <CheckCircle2 className="h-10 w-10 text-emerald-400" />
          </div>
        ) : isFailed ? (
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-red-500/10">
            <XCircle className="h-10 w-10 text-red-400" />
          </div>
        ) : (
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-[#c8a951]/10">
            <Loader2 className="h-10 w-10 animate-spin text-[#c8a951]" />
          </div>
        )}
        <h1 className="mt-5 text-xl font-semibold text-zinc-100">
          {isComplete ? "Research Complete" : isFailed ? "Research Failed" : "Research In Progress"}
        </h1>
        <p className="mt-1.5 text-sm text-zinc-500 max-w-md mx-auto">{job.topic}</p>

        {/* Elapsed time + estimate */}
        {!isTerminal && (
          <div className="mt-3 flex items-center justify-center gap-4 text-xs text-zinc-500">
            <span className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              Elapsed: {elapsed}
            </span>
            {job.estimated_minutes && (
              <span>Est. ~{job.estimated_minutes} min</span>
            )}
          </div>
        )}

        {/* Auto-redirect countdown */}
        {countdown !== null && countdown > 0 && (
          <p className="mt-3 text-sm text-emerald-400 animate-pulse">
            Redirecting to results in {countdown}s...
          </p>
        )}
      </div>

      {/* Phase Timeline */}
      {!isFailed && (
        <div className="mb-10">
          <div className="relative pl-8">
            {PHASES.map((phase, i) => {
              const status = isComplete ? "done" : phaseStatus(pct, phase);
              const isLast = i === PHASES.length - 1;

              return (
                <div key={phase.key} className="relative pb-6 last:pb-0">
                  {/* Vertical connector line */}
                  {!isLast && (
                    <div className={`absolute left-[-20px] top-7 w-0.5 h-full transition-colors duration-500 ${
                      status === "done" ? "bg-emerald-500/60" : "bg-zinc-800"
                    }`} />
                  )}

                  {/* Phase node */}
                  <div className="flex items-start gap-3">
                    {/* Icon circle */}
                    <div className={`absolute left-[-28px] flex items-center justify-center h-[18px] w-[18px] rounded-full border-2 transition-all duration-500 ${
                      status === "done"
                        ? "border-emerald-500 bg-emerald-500/20 text-emerald-400"
                        : status === "active"
                          ? "border-[#c8a951] bg-[#c8a951]/20 text-[#c8a951] ring-2 ring-[#c8a951]/30"
                          : "border-zinc-700 bg-zinc-900 text-zinc-600"
                    }`}>
                      {status === "done" ? (
                        <CheckCircle2 className="h-3 w-3" />
                      ) : status === "active" ? (
                        <div className="h-2 w-2 rounded-full bg-[#c8a951] animate-pulse" />
                      ) : (
                        <div className="h-1.5 w-1.5 rounded-full bg-zinc-700" />
                      )}
                    </div>

                    {/* Phase content */}
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`transition-colors duration-300 ${
                        status === "done"
                          ? "text-zinc-400"
                          : status === "active"
                            ? "text-[#c8a951]"
                            : "text-zinc-600"
                      }`}>
                        {phase.icon}
                      </span>
                      <span className={`text-sm font-medium transition-colors duration-300 ${
                        status === "done"
                          ? "text-zinc-400"
                          : status === "active"
                            ? "text-zinc-100"
                            : "text-zinc-600"
                      }`}>
                        {phase.label}
                      </span>
                      {status === "active" && job.phase_status && (
                        <span className="text-xs text-zinc-500 truncate">
                          — {job.phase_status}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Overall progress bar */}
      {!isTerminal && (
        <div className="mb-8">
          <div className="flex items-center justify-between text-xs text-zinc-500 mb-1.5">
            <span>Overall Progress</span>
            <span>{pct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#c8a951] to-[#d4b85e] transition-all duration-700 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {/* Status details card */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-zinc-500">Status</span>
          <span className={`font-medium ${
            isComplete ? "text-emerald-400" : isFailed ? "text-red-400" : "text-[#c8a951]"
          }`}>
            {job.status}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-zinc-500">Phase</span>
          <span className="text-zinc-300">{job.current_phase || "Waiting"}</span>
        </div>
        {isTerminal && (
          <div className="flex justify-between">
            <span className="text-zinc-500">Duration</span>
            <span className="text-zinc-300">{elapsed}</span>
          </div>
        )}
        <div className="flex justify-between">
          <span className="text-zinc-500">Job ID</span>
          <span className="font-mono text-xs text-zinc-400">{id}</span>
        </div>
        {isFailed && job.error_message && (
          <div className="pt-2 border-t border-zinc-800">
            <p className="text-xs text-red-400">{job.error_message}</p>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="mt-8 flex justify-center gap-4">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-lg border border-zinc-700 px-5 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 transition"
        >
          <ArrowLeft className="h-4 w-4" /> Dashboard
        </Link>

        {isFailed && (
          <button
            onClick={handleRetry}
            disabled={retrying}
            className="flex items-center gap-2 rounded-lg bg-[#c8a951] px-5 py-2.5 text-sm font-medium text-[#1a2744] hover:bg-[#d4b85e] transition disabled:opacity-50"
          >
            {retrying ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Retry Research
          </button>
        )}

        {isComplete && job.result_slug && (
          <Link
            href={`/runs/${job.result_slug}`}
            className="flex items-center gap-2 rounded-lg bg-[#c8a951] px-5 py-2.5 text-sm font-medium text-[#1a2744] hover:bg-[#d4b85e] transition"
          >
            View Results <ArrowRight className="h-4 w-4" />
          </Link>
        )}
      </div>
    </div>
  );
}
