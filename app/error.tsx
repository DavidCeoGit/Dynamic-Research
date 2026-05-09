"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, RotateCcw, Home, ArrowLeft } from "lucide-react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();

  useEffect(() => { console.error("Global boundary caught:", error); }, [error]);

  // Path C hotfix (S29): error.tsx previously had only "Try Again" — leaving
  // users stranded when a broken link or stale state landed them here. Now
  // offers Try Again + Go Back + Home so the user always has an in-app exit.
  // router.back() is preferred over window.history.back() to stay within
  // Next.js client routing; falls back gracefully when no prior history.

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center p-6 text-center animate-in fade-in">
      <div className="rounded-full bg-red-500/10 p-4 mb-6 border border-red-500/20">
        <AlertTriangle className="h-10 w-10 text-red-400" />
      </div>
      <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 mb-2">Application Error</h2>
      <p className="text-zinc-400 max-w-md mb-8">
        An unexpected error occurred in the React tree.
        {error?.digest && (
          <span className="block mt-2 text-xs font-mono text-zinc-500">ref: {error.digest}</span>
        )}
      </p>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          onClick={() => reset()}
          className="flex items-center gap-2 rounded-md bg-[#c8a951] px-6 py-2.5 text-sm font-medium text-[#1a2744] transition hover:bg-[#d4b85e]"
        >
          <RotateCcw className="h-4 w-4" /> Try Again
        </button>

        <button
          onClick={() => router.back()}
          className="flex items-center gap-2 rounded-md border border-zinc-700 px-5 py-2.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 hover:border-zinc-600"
        >
          <ArrowLeft className="h-4 w-4" /> Go Back
        </button>

        <Link
          href="/"
          className="flex items-center gap-2 rounded-md border border-zinc-700 px-5 py-2.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 hover:border-zinc-600"
        >
          <Home className="h-4 w-4" /> Home
        </Link>
      </div>
    </div>
  );
}
