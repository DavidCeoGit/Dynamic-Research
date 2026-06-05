"use client";

import { useEffect, useState } from "react";
import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";

interface MarkdownViewerProps {
  mediaUrl: string;
}

export default function MarkdownViewer({ mediaUrl }: MarkdownViewerProps) {
  const [html, setHtml] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(mediaUrl);
        if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
        const raw = await res.text();
        const rendered = await marked.parse(raw, { async: true, gfm: true });
        if (!cancelled) {
          setHtml(DOMPurify.sanitize(rendered));
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load");
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [mediaUrl]);

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 py-16 text-sm text-zinc-500">
        Loading markdown…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 py-16 text-sm text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 overflow-x-auto">
      <div
        className="prose prose-invert max-w-none prose-headings:text-zinc-200 prose-p:text-zinc-300 prose-a:text-[#3b82f6] prose-strong:text-zinc-200 prose-code:text-[#c8a951] prose-pre:bg-zinc-950 prose-td:text-zinc-300 prose-th:text-zinc-200"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
