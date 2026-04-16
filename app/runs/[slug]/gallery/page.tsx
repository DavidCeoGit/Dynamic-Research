"use client";

import { use, useState, useMemo } from "react";
import dynamic from "next/dynamic";
import useSWR from "swr";
import { useRunState } from "@/hooks/useRunState";
import AudioPlayer from "@/components/AudioPlayer";
import MarkdownViewer from "@/components/MarkdownViewer";
import {
  ArrowLeft,
  Download,
  FileText,
  Image as ImageIcon,
  Loader2,
  Music,
  Presentation,
  Video,
  AlertCircle,
} from "lucide-react";
import Link from "next/link";

// Dynamic import — skip SSR to avoid DOMMatrix crash in Node.js
const PDFViewer = dynamic(() => import("@/components/PDFViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center py-16 text-sm text-zinc-500">
      Loading PDF Viewer...
    </div>
  ),
});

// ── Types ─────────────────────────────────────────────────────────

type MediaType = "audio" | "video" | "image" | "slides" | "markdown";

/** Mirrors the server FileEntry shape (minus absolute path). */
interface FileEntry {
  filename: string;
  size: number;
  type: string;
  product: string | null;
  version: number;
  titlePrefixed: boolean;
  title: string | null;
  timestamp: string | null;
}

interface MediaFile {
  label: string;
  type: MediaType;
  filename: string;
  url: string;
  product: string | null;
  version: number;
  size: number;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Helpers ───────────────────────────────────────────────────────

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.json();
};

function mediaUrl(slug: string, filename: string): string {
  return `/api/runs/${encodeURIComponent(slug)}/file/${encodeURIComponent(filename)}`;
}

/** Map server file types to renderable media types.
 *  Excludes: state (.json), docx (.docx — available as download from markdown view).
 *  Includes: markdown (.md) rendered inline with Word download option.
 *  FIXME(Bug 23): NLM outputs PDFs disguised as .pptx. react-pdf reads magic bytes
 *  so PDFViewer handles them fine. If backend is fixed to emit real .pptx files,
 *  this will need a dedicated PPTX renderer. Remove workaround when Bug 23 is resolved.
 */
function toMediaType(entry: FileEntry): MediaType | null {
  const ext = entry.filename.split(".").pop()?.toLowerCase();
  switch (entry.type) {
    case "audio":
      return "audio";
    case "video":
      return "video";
    case "image":
      return "image";
    case "slides":
      // PDF and .pptx (actually PDFs per Bug 23) both render via PDFViewer
      return "slides";
    case "markdown":
      return "markdown";
    default:
      return null;
  }
}

function classifyExt(ext: string | undefined): MediaType | null {
  switch (ext) {
    case "mp3":
      return "audio";
    case "mp4":
      return "video";
    case "png":
    case "jpg":
    case "jpeg":
      return "image";
    case "pdf":
      return "slides";
    case "md":
      return "markdown";
    default:
      return null;
  }
}

function labelFromFilename(filename: string): string {
  const stripped = filename.replace(/^\d{8}-\d{6}-/, "");
  const base = stripped.replace(/\.\w+$/, "");
  return base
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Derive the .docx download URL from a .md filename. */
function docxUrl(slug: string, mdFilename: string): string | null {
  if (!mdFilename.endsWith(".md")) return null;
  const docxFilename = mdFilename.replace(/\.md$/, ".docx");
  return `/api/runs/${encodeURIComponent(slug)}/file/${encodeURIComponent(docxFilename)}`;
}

const TYPE_ICON: Record<MediaType, typeof Music> = {
  audio: Music,
  video: Video,
  image: ImageIcon,
  slides: Presentation,
  markdown: FileText,
};

const TYPE_LABEL: Record<MediaType, string> = {
  audio: "Audio",
  video: "Video",
  image: "Infographic",
  slides: "Slides",
  markdown: "Report / Document",
};

// ── Component ─────────────────────────────────────────────────────

export default function GalleryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const { state, isLoading: stateLoading, isError: stateError } = useRunState(slug);

  // Fetch full file inventory from backend
  const { data: inventory } = useSWR<FileEntry[]>(
    `/api/runs/${encodeURIComponent(slug)}/files`,
    fetcher,
  );

  const [selectedFile, setSelectedFile] = useState<MediaFile | null>(null);
  const [versionOverrides, setVersionOverrides] = useState<
    Record<string, number>
  >({});

  // ── Track which .docx files actually exist (for download buttons) ──
  const docxSet = useMemo(() => {
    if (!inventory) return new Set<string>();
    return new Set(
      inventory
        .filter((e) => e.type === "docx")
        .map((e) => e.filename),
    );
  }, [inventory]);

  // ── Build media files from inventory (preferred) or state fallback ──
  const files = useMemo((): MediaFile[] => {
    if (inventory) {
      return inventory.reduce<MediaFile[]>((acc, entry) => {
        const mt = toMediaType(entry);
        if (mt) {
          acc.push({
            label: entry.title ?? labelFromFilename(entry.filename),
            type: mt,
            filename: entry.filename,
            url: mediaUrl(slug, entry.filename),
            product: entry.product,
            version: entry.version,
            size: entry.size,
          });
        }
        return acc;
      }, []);
    }

    // Fallback: derive from state.files_written
    return (state?.files_written ?? []).reduce<MediaFile[]>((acc, filename) => {
      const ext = filename.split(".").pop()?.toLowerCase();
      const mt = classifyExt(ext);
      if (mt) {
        acc.push({
          label: labelFromFilename(filename),
          type: mt,
          filename,
          url: mediaUrl(slug, filename),
          product: null,
          version: 1,
          size: 0,
        });
      }
      return acc;
    }, []);
  }, [inventory, state, slug]);

  // ── Group files by product, then by version ─────────────────
  const productGroups = useMemo(() => {
    const groups = new Map<
      string,
      { type: MediaType; versions: Map<number, MediaFile> }
    >();

    for (const f of files) {
      const key = f.product ?? f.filename;
      const existing = groups.get(key);
      if (existing) {
        existing.versions.set(f.version, f);
      } else {
        groups.set(key, {
          type: f.type,
          versions: new Map([[f.version, f]]),
        });
      }
    }

    return groups;
  }, [files]);

  // ── Derive available versions for the currently selected product ──
  const selectedProduct = selectedFile?.product ?? null;
  const versionsForSelected = useMemo(() => {
    if (!selectedProduct) return [];
    const group = productGroups.get(selectedProduct);
    if (!group) return [];
    return Array.from(group.versions.keys()).sort((a, b) => b - a);
  }, [selectedProduct, productGroups]);

  const activeVersion =
    selectedProduct != null
      ? versionOverrides[selectedProduct] ?? selectedFile?.version ?? 1
      : 1;

  // ── Resolve the actual file to render (respecting version override) ──
  const resolvedFile = useMemo((): MediaFile | null => {
    if (!selectedFile) return null;
    if (!selectedProduct) return selectedFile;

    const group = productGroups.get(selectedProduct);
    if (!group) return selectedFile;

    const versionedFile = group.versions.get(activeVersion);
    return versionedFile ?? selectedFile;
  }, [selectedFile, selectedProduct, productGroups, activeVersion]);

  // ── Group by media type for the listing view ────────────────
  const groupedByType = useMemo(() => {
    const latest: MediaFile[] = [];
    for (const [, group] of productGroups) {
      const maxVersion = Math.max(...group.versions.keys());
      const file = group.versions.get(maxVersion);
      if (file) latest.push(file);
    }

    const map = new Map<MediaType, MediaFile[]>();
    for (const f of latest) {
      const list = map.get(f.type) ?? [];
      list.push(f);
      map.set(f.type, list);
    }
    return map;
  }, [productGroups]);

  // ── Loading ──────────────────────────────────────────────────
  if (stateLoading) {
    return (
      <div className="flex flex-1 items-center justify-center py-32">
        <Loader2 className="h-8 w-8 animate-spin text-[#3b82f6]" />
        <span className="ml-3 text-sm text-zinc-400">Loading gallery...</span>
      </div>
    );
  }

  if (stateError || !state) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-32 text-zinc-400">
        <AlertCircle className="h-10 w-10 text-zinc-600" />
        <p className="text-sm">Could not load run state.</p>
      </div>
    );
  }

  // ── Version change handler ──────────────────────────────────
  function onVersionChange(version: number) {
    if (!selectedProduct) return;
    setVersionOverrides((prev) => ({ ...prev, [selectedProduct]: version }));
  }

  // ── Check if a matching .docx exists for a markdown file ────
  function hasMatchingDocx(mdFilename: string): boolean {
    const docxFilename = mdFilename.replace(/\.md$/, ".docx");
    return docxSet.has(docxFilename);
  }

  // ── Render the viewer for the resolved file ─────────────────
  function renderViewer(file: MediaFile) {
    switch (file.type) {
      case "audio":
        return <AudioPlayer key={file.filename} mediaUrl={file.url} />;
      case "video":
        return (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <video
              key={file.filename}
              src={file.url}
              controls
              className="mx-auto aspect-video max-w-full rounded"
            />
          </div>
        );
      case "image":
        return (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <img
              key={file.filename}
              src={file.url}
              alt={file.label}
              className="mx-auto max-h-[70vh] object-contain rounded"
            />
          </div>
        );
      case "slides":
        return <PDFViewer key={file.filename} mediaUrl={file.url} />;
      case "markdown":
        return <MarkdownViewer key={file.filename} mediaUrl={file.url} />;
    }
  }

  // ── Main layout ──────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      {/* ── Header ───────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <Link
            href={`/runs/${slug}`}
            className="inline-flex items-center gap-1 text-xs text-zinc-500 transition hover:text-zinc-300"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to run
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-100">
            Media Gallery
          </h1>
          <p className="mt-1 text-sm text-zinc-400">{state.topic}</p>
        </div>

        {/* Version selector — shown when viewing a file with multiple versions */}
        {resolvedFile && versionsForSelected.length > 1 && (
          <div className="flex items-center gap-2">
            <label htmlFor="version-select" className="text-xs text-zinc-500">
              Version
            </label>
            <select
              id="version-select"
              value={activeVersion}
              onChange={(e) => onVersionChange(Number(e.target.value))}
              className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 transition hover:bg-zinc-700 focus:outline-none focus:ring-1 focus:ring-[#3b82f6]"
            >
              {versionsForSelected.map((v) => (
                <option key={v} value={v}>
                  v{v}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* ── Selected File Viewer (single-view isolation) ── */}
      {resolvedFile && (
        <div className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSelectedFile(null)}
                className="text-xs text-zinc-500 transition hover:text-zinc-300"
              >
                ← All files
              </button>
              <span className="text-sm font-medium text-zinc-200">
                {resolvedFile.label}
              </span>
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-500">
                v{resolvedFile.version}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {/* For markdown: download .docx (nobody wants raw .md). For others: download raw file. */}
              {resolvedFile.type === "markdown" &&
                hasMatchingDocx(resolvedFile.filename) ? (
                  <a
                    href={docxUrl(slug, resolvedFile.filename)!}
                    download={resolvedFile.filename.replace(/\.md$/, ".docx")}
                    className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 transition hover:bg-zinc-700"
                  >
                    <Download className="h-4 w-4" />
                    Download
                  </a>
                ) : (
                  <a
                    href={resolvedFile.url}
                    download={resolvedFile.filename}
                    className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 transition hover:bg-zinc-700"
                  >
                    <Download className="h-4 w-4" />
                    Download
                  </a>
                )}
            </div>
          </div>
          {renderViewer(resolvedFile)}
        </div>
      )}

      {/* ── File Listing (hidden when viewing a file) ───── */}
      {!resolvedFile && (
        <div className="mt-8 space-y-8">
          {files.length === 0 && (
            <p className="text-center text-sm text-zinc-500">
              No media files available yet.
            </p>
          )}

          {Array.from(groupedByType.entries()).map(([type, typeFiles]) => {
            const Icon = TYPE_ICON[type];
            return (
              <section key={type}>
                <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-400">
                  <Icon className="h-4 w-4" />
                  {TYPE_LABEL[type]}
                </h2>
                <div className="space-y-2">
                  {typeFiles.map((file) => {
                    const group = productGroups.get(
                      file.product ?? file.filename,
                    );
                    const versionCount = group?.versions.size ?? 1;

                    return (
                      <button
                        key={file.filename}
                        onClick={() => setSelectedFile(file)}
                        className="flex w-full items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-left transition hover:border-zinc-700 hover:bg-zinc-800"
                      >
                        <Icon className="h-5 w-5 shrink-0 text-zinc-500" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-zinc-200">
                            {file.label}
                          </p>
                          <p className="truncate font-mono text-xs text-zinc-500">
                            {file.filename}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {versionCount > 1 && (
                            <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-[#c8a951]">
                              {versionCount} versions
                            </span>
                          )}
                          <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-500">
                            v{file.version}
                          </span>
                          <span className="font-mono text-xs text-zinc-500">
                            {formatFileSize(file.size)}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
