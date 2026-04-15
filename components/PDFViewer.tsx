"use client";

import { useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { ChevronLeft, ChevronRight } from "lucide-react";

// CDN workaround — bypasses Turbopack module resolution for pdf.worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface PDFViewerProps {
  mediaUrl: string;
}

export default function PDFViewer({ mediaUrl }: PDFViewerProps) {
  const [numPages, setNumPages] = useState<number>(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [loading, setLoading] = useState(true);

  const onDocumentLoadSuccess = ({ numPages: n }: { numPages: number }) => {
    setNumPages(n);
    setLoading(false);
  };

  const prev = () => setPageNumber((p) => Math.max(1, p - 1));
  const next = () => setPageNumber((p) => Math.min(numPages, p + 1));

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      {/* Document */}
      <div className="flex justify-center overflow-auto">
        <Document
          file={mediaUrl}
          onLoadSuccess={onDocumentLoadSuccess}
          loading={
            <div className="flex items-center justify-center py-16 text-sm text-zinc-500">
              Loading PDF…
            </div>
          }
          error={
            <div className="flex items-center justify-center py-16 text-sm text-red-400">
              Failed to load PDF.
            </div>
          }
        >
          <Page
            pageNumber={pageNumber}
            width={720}
            renderTextLayer
            renderAnnotationLayer
          />
        </Document>
      </div>

      {/* Controls */}
      {!loading && numPages > 0 && (
        <div className="mt-3 flex items-center justify-center gap-4">
          <button
            onClick={prev}
            disabled={pageNumber <= 1}
            className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 transition hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="h-4 w-4" />
            Prev
          </button>

          <span className="font-mono text-xs text-zinc-400">
            {pageNumber} / {numPages}
          </span>

          <button
            onClick={next}
            disabled={pageNumber >= numPages}
            className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 transition hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
