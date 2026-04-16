"use client";

import { use } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Loader2, CheckCircle2, XCircle, ArrowLeft, Clock } from "lucide-react";
import type { ResearchJob } from "@/lib/types/queue";
import { phaseFromProgress } from "@/lib/estimates";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.json();
};

export default function ProgressPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const { data: job, error } = useSWR<ResearchJob>(
    `/api/queue/${id}`,
    fetcher,
    { refreshInterval: 5000 },
  );

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

  if (!job) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-8 w-8 animate-spin text-[#c8a951]" />
      </div>
    );
  }

  const isComplete = job.status === "completed";
  const isFailed = job.status === "failed";
  const pct = job.progress_pct ?? 0;

  return (
    <div className="mx-auto max-w-xl px-6 py-12">
      {/* Status icon */}
      <div className="text-center mb-8">
        {isComplete ? (
          <CheckCircle2 className="mx-auto h-14 w-14 text-emerald-400" />
        ) : isFailed ? (
          <XCircle className="mx-auto h-14 w-14 text-red-400" />
        ) : (
          <Loader2 className="mx-auto h-14 w-14 animate-spin text-[#c8a951]" />
        )}
        <h1 className="mt-4 text-xl font-semibold text-zinc-100">
          {isComplete ? "Research Complete" : isFailed ? "Research Failed" : "Research Queued"}
        </h1>
        <p className="mt-1 text-sm text-zinc-500">{job.topic}</p>
      </div>

      {/* Progress bar */}
      {!isComplete && !isFailed && (
        <div className="mb-8">
          <div className="flex items-center justify-between text-xs text-zinc-500 mb-1.5">
            <span>{phaseFromProgress(pct)}</span>
            <span>{pct}%</span>
          </div>
          <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-[#c8a951] transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          {job.estimated_minutes && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-zinc-600">
              <Clock className="h-3.5 w-3.5" />
              <span>Estimated: ~{job.estimated_minutes} min</span>
            </div>
          )}
        </div>
      )}

      {/* Status details */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-zinc-500">Status</span>
          <span className={`font-medium ${isComplete ? "text-emerald-400" : isFailed ? "text-red-400" : "text-[#c8a951]"}`}>
            {job.status}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-zinc-500">Phase</span>
          <span className="text-zinc-300">{job.current_phase || "Waiting"}</span>
        </div>
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
        <Link href="/" className="flex items-center gap-2 rounded-lg border border-zinc-700 px-5 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 transition">
          <ArrowLeft className="h-4 w-4" /> Dashboard
        </Link>
        {isComplete && job.result_slug && (
          <Link href={`/runs/${job.result_slug}`} className="flex items-center gap-2 rounded-lg bg-[#c8a951] px-5 py-2.5 text-sm font-medium text-[#1a2744] hover:bg-[#d4b85e] transition">
            View Results
          </Link>
        )}
      </div>
    </div>
  );
}
