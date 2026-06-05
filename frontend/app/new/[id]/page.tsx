"use client";

import { use, useEffect, useState, useRef, useMemo } from "react";
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
  Users,
  Music,
  Video,
  Presentation,
  FileText,
  Image as ImageIcon,
} from "lucide-react";
import type { ResearchJob, SelectedProducts } from "@/lib/types/queue";
import { useToast } from "@/components/ToastProvider";

// ── Phase timeline definition ──────────────────────────────────────

interface Phase {
  key: string;
  label: string;
  icon: React.ReactNode;
  minPct: number;
}

const BASE_PHASES: Phase[] = [
  { key: "preflight",  label: "Preflight",           icon: <Zap className="h-4 w-4" />,        minPct: 0 },
  { key: "research",   label: "Perplexity Research",  icon: <Search className="h-4 w-4" />,     minPct: 10 },
  { key: "scoring",    label: "CI Scoring",           icon: <BarChart3 className="h-4 w-4" />,  minPct: 25 },
  { key: "import",     label: "NotebookLM Import",    icon: <FileDown className="h-4 w-4" />,   minPct: 30 },
  { key: "extraction", label: "Extraction",           icon: <Layers className="h-4 w-4" />,     minPct: 50 },
  { key: "synthesis",  label: "Synthesis",            icon: <Sparkles className="h-4 w-4" />,   minPct: 60 },
  { key: "studio",     label: "Studio Products",      icon: <Package className="h-4 w-4" />,    minPct: 70 },
  { key: "finalize",   label: "Finalization",         icon: <Flag className="h-4 w-4" />,       minPct: 95 },
];

function buildPhases(vendorEnabled: boolean): Phase[] {
  if (!vendorEnabled) return BASE_PHASES;
  // Insert vendor phase after synthesis, push studio/finalize later
  return [
    ...BASE_PHASES.slice(0, 6), // preflight through synthesis
    { key: "vendor", label: "Vendor Evaluation", icon: <Users className="h-4 w-4" />, minPct: 65 },
    { ...BASE_PHASES[6], minPct: 75 }, // studio → 75
    { ...BASE_PHASES[7], minPct: 95 }, // finalize stays 95
  ];
}

function phaseStatus(pct: number, phase: Phase, phases: Phase[]): "done" | "active" | "pending" {
  const idx = phases.indexOf(phase);
  const next = phases[idx + 1];
  if (next && pct >= next.minPct) return "done";
  if (pct >= phase.minPct) return "active";
  return "pending";
}

// ── Deliverables ───────────────────────────────────────────────────

const DELIVERABLES: { key: keyof SelectedProducts; label: string; Icon: typeof Music }[] = [
  { key: "report",      label: "Executive Report", Icon: FileText },
  { key: "infographic", label: "Infographic",      Icon: ImageIcon },
  { key: "slides",      label: "Slide Deck",       Icon: Presentation },
  { key: "audio",       label: "Audio Overview",   Icon: Music },
  { key: "video",       label: "Cinematic Video",  Icon: Video },
];

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

// ── Session storage key (must match useNewResearchForm hook) ───────

const FORM_STORAGE_KEY = "new-research-draft";

// ── Main component ─────────────────────────────────────────────────

export default function ProgressPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { toast } = useToast();
  const [retrying, setRetrying] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const redirectStarted = useRef(false);

  const { data: job, error } = useSWR<ResearchJob>(
    `/api/queue/${id}`,
    fetcher,
    { refreshInterval: 3000 },
  );

  const isComplete = job?.status === "completed";
  const isFailed = job?.status === "failed";
  const isTerminal = isComplete || isFailed;
  const pct = job?.progress_pct ?? 0;
  const elapsed = useElapsed(job?.claimed_at ?? null, isTerminal);
  const phases = useMemo(
    () => buildPhases(job?.vendor_evaluation?.enabled ?? false),
    [job?.vendor_evaluation?.enabled],
  );

  // Formatted elapsed display
  const elapsedDisplay = useMemo(() => {
    const [m, s] = elapsed.split(":");
    const mins = parseInt(m, 10);
    return mins > 0 ? `${mins} min ${s} sec` : `${s} sec`;
  }, [elapsed]);

  // ETA remaining
  const etaRemaining = useMemo(() => {
    if (!job?.estimated_minutes || !job?.claimed_at || isTerminal) return null;
    const startMs = new Date(job.claimed_at).getTime();
    const estimatedEndMs = startMs + job.estimated_minutes * 60_000;
    const remainMs = Math.max(0, estimatedEndMs - Date.now());
    const remainMin = Math.ceil(remainMs / 60_000);
    return remainMin > 0 ? `~${remainMin} min` : "< 1 min";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.estimated_minutes, job?.claimed_at, isTerminal, elapsed]);

  // Selected deliverables
  const selectedDeliverables = useMemo(
    () => DELIVERABLES.filter((d) => job?.selected_products?.[d.key]),
    [job?.selected_products],
  );

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

  // Retry handler (with toast feedback)
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
      if (!res.ok) throw new Error("Failed to create retry job");
      const { id: newId } = await res.json();
      toast("Job restarted successfully", "success");
      router.push(`/new/${newId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Retry failed";
      toast(msg, "error");
      setRetrying(false);
    }
  }

  // Edit Configuration handler (state recovery)
  function handleEditConfig() {
    if (!job) return;

    // Map snake_case DB fields → camelCase form schema
    const draft = {
      topic: job.topic,
      generatedQuestions: [],
      dynamicAnswers: {},
      vendorEvaluation: job.vendor_evaluation,
      ajiDnaEnabled: job.aji_dna_enabled,
      selectedProducts: job.selected_products,
      customizations: job.customizations,
      notifyEmail: job.notify_email ?? "",
    };

    sessionStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(draft));
    toast("Configuration loaded. Ready to edit.", "info");
    router.push("/new");
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
    <div className="mx-auto max-w-5xl px-6 py-12 animate-in fade-in duration-500">
      {/* Header */}
      <div className="mb-8 border-b border-zinc-800 pb-6">
        <div className="flex items-center gap-3">
          {isComplete ? (
            <CheckCircle2 className="h-7 w-7 text-emerald-400" />
          ) : isFailed ? (
            <XCircle className="h-7 w-7 text-red-400" />
          ) : (
            <Loader2 className="h-7 w-7 animate-spin text-[#c8a951]" />
          )}
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
            {isComplete ? "Research Complete" : isFailed ? "Research Failed" : "Research In Progress"}
          </h1>
        </div>
        <p className="mt-2 text-sm text-zinc-500 max-w-2xl">{job.topic}</p>

        {/* Elapsed + estimate (in-progress only) */}
        {!isTerminal && (
          <div className="mt-3 flex items-center gap-4 text-xs text-zinc-500">
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

      {/* Two-column grid */}
      <div className="grid grid-cols-1 gap-8 md:grid-cols-5">

        {/* ── Left column: Pipeline Timeline ─────────────────────── */}
        <div className="md:col-span-2">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5 h-fit">
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-5">
              Pipeline
            </h2>
            <div className="relative pl-8">
              {phases.map((phase, i) => {
                const status = isComplete ? "done" : phaseStatus(pct, phase, phases);
                const isLast = i === phases.length - 1;

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
                      </div>
                    </div>

                    {/* Active phase status */}
                    {status === "active" && job.phase_status && (
                      <p className="mt-1 ml-0 text-xs text-zinc-500 truncate animate-pulse">
                        {job.phase_status}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── Right column: Dashboard ────────────────────────────── */}
        <div className="md:col-span-3 space-y-6">

          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-4">
            {/* Progress */}
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
              <span className="block text-xs font-medium text-zinc-500 mb-2">Progress</span>
              <span className="text-2xl font-bold text-zinc-100">{pct}%</span>
              <div className="mt-2 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ease-out ${
                    isFailed ? "bg-red-500" : isComplete ? "bg-emerald-500" : "bg-gradient-to-r from-[#c8a951] to-[#d4b85e]"
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>

            {/* Elapsed */}
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
              <span className="block text-xs font-medium text-zinc-500 mb-2">Elapsed</span>
              <span className="text-lg font-semibold text-zinc-100 flex items-center gap-1.5">
                <Clock className="h-4 w-4 text-zinc-400" /> {elapsedDisplay}
              </span>
            </div>

            {/* ETA */}
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
              <span className="block text-xs font-medium text-zinc-500 mb-2">ETA</span>
              <span className="text-lg font-semibold text-zinc-100">
                {isComplete ? "Done" : etaRemaining ?? "---"}
              </span>
            </div>

            {/* Current Phase */}
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
              <span className="block text-xs font-medium text-zinc-500 mb-2">Phase</span>
              <span className="text-sm font-semibold text-[#c8a951] truncate block">
                {isComplete ? "Complete" : job.current_phase || "Initializing"}
              </span>
              {!isTerminal && job.phase_status && (
                <span className="text-xs text-zinc-500 truncate block mt-0.5">
                  {job.phase_status}
                </span>
              )}
            </div>
          </div>

          {/* Deliverables checklist */}
          {selectedDeliverables.length > 0 && !isFailed && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
              <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">
                Deliverables
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {selectedDeliverables.map(({ key, label, Icon }) => {
                  const isDone = isComplete || pct >= 95;
                  const isGenerating = !isDone && pct >= 70;

                  return (
                    <div key={key} className="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-900 p-3">
                      {isDone ? (
                        <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
                      ) : isGenerating ? (
                        <Loader2 className="h-5 w-5 animate-spin text-[#c8a951] shrink-0" />
                      ) : (
                        <div className="h-5 w-5 rounded-full border-2 border-zinc-700 bg-zinc-800 shrink-0" />
                      )}
                      <Icon className={`h-4 w-4 shrink-0 ${
                        isDone ? "text-emerald-400" : isGenerating ? "text-[#c8a951]" : "text-zinc-600"
                      }`} />
                      <span className={`text-sm font-medium ${
                        isDone ? "text-zinc-300" : isGenerating ? "text-zinc-200" : "text-zinc-500"
                      }`}>
                        {label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Success panel */}
          {isComplete && job.result_slug && (
            <div className="rounded-lg border border-emerald-800 bg-emerald-500/5 p-6 animate-in fade-in duration-500">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h3 className="text-lg font-medium text-emerald-400 flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5" /> Pipeline Finished
                  </h3>
                  {countdown !== null && countdown > 0 && (
                    <p className="mt-1 text-sm text-emerald-400/80">
                      Redirecting in <strong className="text-emerald-300">{countdown}s</strong>...
                    </p>
                  )}
                </div>
                <Link
                  href={`/runs/${job.result_slug}`}
                  className="flex shrink-0 items-center justify-center gap-2 rounded-lg bg-[#c8a951] px-6 py-2.5 text-sm font-medium text-[#1a2744] hover:bg-[#d4b85e] transition"
                >
                  View Results <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </div>
          )}

          {/* Error panel */}
          {isFailed && (
            <div className="rounded-lg border border-red-800 bg-red-500/5 p-6 animate-in fade-in duration-500">
              <div className="flex items-start gap-4">
                <XCircle className="h-6 w-6 text-red-400 shrink-0 mt-0.5" />
                <div className="w-full">
                  <h3 className="text-lg font-medium text-red-400">Execution Failed</h3>
                  {job.error_message && (
                    <div className="mt-2 rounded bg-zinc-900 p-3 text-sm text-zinc-300 font-mono overflow-x-auto border border-red-800/30">
                      {job.error_message}
                    </div>
                  )}
                  <div className="mt-4 flex flex-wrap gap-3">
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
                    <button
                      onClick={handleEditConfig}
                      className="flex items-center gap-2 rounded-lg border border-zinc-700 px-5 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 transition"
                    >
                      Edit Configuration
                    </button>
                  </div>
                </div>
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
                <span className="text-zinc-300">{elapsedDisplay}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-zinc-500">Job ID</span>
              <span className="font-mono text-xs text-zinc-400">{id}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Actions footer */}
      <div className="mt-8 flex justify-center gap-4">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-lg border border-zinc-700 px-5 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 transition"
        >
          <ArrowLeft className="h-4 w-4" /> Dashboard
        </Link>

        {isComplete && job.result_slug && !countdown && (
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
