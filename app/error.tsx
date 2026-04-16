"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("Global boundary caught:", error); }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center p-6 text-center animate-in fade-in">
      <div className="rounded-full bg-red-500/10 p-4 mb-6 border border-red-500/20">
        <AlertTriangle className="h-10 w-10 text-red-400" />
      </div>
      <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 mb-2">Application Error</h2>
      <p className="text-zinc-400 max-w-md mb-8">An unexpected error occurred in the React tree.</p>
      <button
        onClick={() => reset()}
        className="flex items-center gap-2 rounded-md bg-[#c8a951] px-6 py-2.5 text-sm font-medium text-[#1a2744] transition hover:bg-[#d4b85e]"
      >
        <RotateCcw className="h-4 w-4" /> Try Again
      </button>
    </div>
  );
}
