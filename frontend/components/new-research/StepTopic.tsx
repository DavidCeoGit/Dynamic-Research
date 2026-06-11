"use client";

import { useCallback, useRef, useState } from "react";
import { useFormContext } from "react-hook-form";
import type { FormData } from "@/lib/validate";
import type { StepProps } from "@/lib/types/queue";
import type { AttachmentPayloadItem } from "@/lib/types/queue";
import {
  ATTACHMENT_ALLOWED_EXTENSIONS,
  ATTACHMENT_EXT_TO_MIME,
  ATTACHMENT_MAX_FILES,
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  type AttachmentContentType,
} from "@/lib/attachments-constants";
import { ArrowRight, Upload, FileText, X, Loader2, CheckCircle2, AlertCircle } from "lucide-react";

// S102 file-upload — the entire attachments zone is gated behind this flag.
// MUST be accessed as this EXACT static expression so the Next 16 Edge runtime
// inlines the NEXT_PUBLIC_* value at build time. Do not destructure or compute.
const ATTACHMENTS_ENABLED = process.env.NEXT_PUBLIC_ATTACHMENTS_ENABLED === "1";

type UiStatus = "uploading" | "ready" | "error";

interface UiAttachment {
  /** Stable UI key. For ready items this is the storedName; for in-flight/error
   * items (no storedName yet) it's a client temp id. */
  tempId: string;
  originalName: string;
  sizeBytes: number;
  status: UiStatus;
  errorMessage?: string;
  /** Present once the mint+PUT succeeds — the storedName the DELETE route needs. */
  storedName?: string;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

export function StepTopic({ onNext }: StepProps) {
  const { register, formState: { errors }, watch, setValue, getValues } =
    useFormContext<FormData>();
  const topic = watch("topic") ?? "";
  const attachments = watch("attachments") ?? [];

  // Per-file UI status (uploading/ready/error). The persisted form array holds
  // only successfully-uploaded items; this local state drives chips + in-flight
  // and error rows that never reach the form.
  const [uiItems, setUiItems] = useState<UiAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const ensureDraftId = useCallback((): string => {
    const existing = getValues("attachmentsDraftId");
    if (existing) return existing;
    const id = crypto.randomUUID();
    setValue("attachmentsDraftId", id, { shouldDirty: true });
    return id;
  }, [getValues, setValue]);

  const removeFromForm = useCallback(
    (storedName: string) => {
      const current = (getValues("attachments") ?? []) as AttachmentPayloadItem[];
      // Codex MERGE-gate BLOCKING — remove ONLY the staging-origin item with this
      // storedName. This row-remove path is reached only from a staged-upload
      // chip (removeItem), so a parent carry-over that happens to share a
      // storedName must never be collaterally dropped. (The mint suffix +
      // submit-time dup-guard make a shared storedName unreachable, but scoping
      // the removal is the cheap correctness backstop.)
      setValue(
        "attachments",
        current.filter(
          (a) => !(a.storedName === storedName && a.origin === "staging"),
        ),
        { shouldDirty: true },
      );
    },
    [getValues, setValue],
  );

  // ── Upload one file: mint → PUT raw bytes → append to form on success ──
  const uploadFile = useCallback(
    async (file: File) => {
      const ext = extensionOf(file.name);
      const contentType = ATTACHMENT_EXT_TO_MIME[ext] as AttachmentContentType | undefined;
      const tempId =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${file.name}-${Date.now()}-${Math.random()}`;

      // Client-side advisory pre-validation (server re-checks authoritatively).
      if (!contentType || !(ATTACHMENT_ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
        setUiItems((prev) => [
          ...prev,
          { tempId, originalName: file.name, sizeBytes: file.size, status: "error", errorMessage: "Unsupported file type (allowed: .pdf, .txt, .md)" },
        ]);
        return;
      }
      if (file.size > ATTACHMENT_MAX_FILE_BYTES) {
        setUiItems((prev) => [
          ...prev,
          { tempId, originalName: file.name, sizeBytes: file.size, status: "error", errorMessage: `File exceeds ${humanSize(ATTACHMENT_MAX_FILE_BYTES)} limit` },
        ]);
        return;
      }
      const existingItems = (getValues("attachments") ?? []) as AttachmentPayloadItem[];
      if (existingItems.length + 1 > ATTACHMENT_MAX_FILES) {
        setUiItems((prev) => [
          ...prev,
          { tempId, originalName: file.name, sizeBytes: file.size, status: "error", errorMessage: `At most ${ATTACHMENT_MAX_FILES} files` },
        ]);
        return;
      }
      const existingTotal = existingItems.reduce((s, a) => s + a.sizeBytes, 0);
      if (existingTotal + file.size > ATTACHMENT_MAX_TOTAL_BYTES) {
        setUiItems((prev) => [
          ...prev,
          { tempId, originalName: file.name, sizeBytes: file.size, status: "error", errorMessage: `Total size exceeds ${humanSize(ATTACHMENT_MAX_TOTAL_BYTES)}` },
        ]);
        return;
      }

      // Show an uploading chip immediately.
      setUiItems((prev) => [
        ...prev,
        { tempId, originalName: file.name, sizeBytes: file.size, status: "uploading" },
      ]);

      try {
        const draftId = ensureDraftId();

        // Names already attached to this draft (parent carry-overs from a clone
        // + any prior staged uploads), so the mint route's collision-suffix
        // de-dupes against them too (Codex MERGE-gate BLOCKING). Without this a
        // freshly-uploaded "Report.pdf" could be assigned a storedName a parent
        // attachment already owns, which the submit-time dup-guard would then
        // reject with a 400. Sending them lets the upload succeed with a suffix.
        const reservedStoredNames = (
          (getValues("attachments") ?? []) as AttachmentPayloadItem[]
        ).map((a) => a.storedName);

        // (1) Mint a signed-upload URL + token.
        const mintRes = await fetch("/api/queue/attachments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            draftId,
            originalName: file.name,
            sizeBytes: file.size,
            contentType,
            reservedStoredNames,
          }),
        });
        if (!mintRes.ok) {
          const err = await mintRes.json().catch(() => ({ error: `HTTP ${mintRes.status}` }));
          throw new Error(err.error || `Upload rejected (HTTP ${mintRes.status})`);
        }
        const { storedName, signedUrl } = (await mintRes.json()) as {
          storedName: string;
          signedUrl: string;
          token: string;
          path: string;
        };

        // (2) PUT the raw bytes to the signed URL.
        const putRes = await fetch(signedUrl, {
          method: "PUT",
          headers: { "Content-Type": contentType },
          body: file,
        });
        if (!putRes.ok) {
          throw new Error(`Upload failed (HTTP ${putRes.status})`);
        }

        // (3) Append the successful item to the persisted form array.
        const item: AttachmentPayloadItem = {
          originalName: file.name,
          storedName,
          sizeBytes: file.size,
          contentType,
          uploadedAt: new Date().toISOString(),
          origin: "staging",
        };
        const current = (getValues("attachments") ?? []) as AttachmentPayloadItem[];
        setValue("attachments", [...current, item], { shouldDirty: true });

        setUiItems((prev) =>
          prev.map((u) =>
            u.tempId === tempId ? { ...u, status: "ready", storedName } : u,
          ),
        );
      } catch (err) {
        setUiItems((prev) =>
          prev.map((u) =>
            u.tempId === tempId
              ? { ...u, status: "error", errorMessage: err instanceof Error ? err.message : "Upload failed" }
              : u,
          ),
        );
      }
    },
    [ensureDraftId, getValues, setValue],
  );

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      for (const file of Array.from(files)) void uploadFile(file);
    },
    [uploadFile],
  );

  // Remove a row: for ready items, DELETE the staged object then drop from form
  // + UI. For error/uploading rows (no storedName) just drop the UI row.
  const removeItem = useCallback(
    async (ui: UiAttachment) => {
      if (ui.status !== "ready" || !ui.storedName) {
        setUiItems((prev) => prev.filter((u) => u.tempId !== ui.tempId));
        return;
      }
      const storedName = ui.storedName;
      // Optimistically drop from form so the chip + caps update immediately.
      removeFromForm(storedName);
      setUiItems((prev) => prev.filter((u) => u.tempId !== ui.tempId));
      try {
        const draftId = getValues("attachmentsDraftId");
        if (draftId) {
          await fetch("/api/queue/attachments", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ draftId, storedName }),
          });
        }
      } catch {
        // Best-effort delete; the staging TTL sweep reclaims orphans.
      }
    },
    [getValues, removeFromForm],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  const acceptAttr = ATTACHMENT_ALLOWED_EXTENSIONS.join(",");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-zinc-100">What do you want to research?</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Describe your research topic in detail. The more specific, the better the results.
        </p>
      </div>

      <div>
        <textarea
          {...register("topic")}
          rows={4}
          placeholder="Describe your research topic. Detailed topics (full briefs, requirements, context) work best — paste up to 10,000 characters of context if you have it. The clarifying questions adapt to what you provide."
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-[#c8a951] focus:outline-none focus:ring-1 focus:ring-[#c8a951] resize-none"
        />
        <div className="mt-1.5 flex items-center justify-between">
          {errors.topic ? (
            <p className="text-xs text-red-400">{errors.topic.message}</p>
          ) : (
            <p className="text-xs text-zinc-600">Minimum 10 characters. Detailed topics get smarter clarifying questions.</p>
          )}
          <span className={`text-xs ${topic.length >= 10 ? "text-zinc-500" : "text-zinc-600"}`}>
            {topic.length}/10000
          </span>
        </div>
      </div>

      {ATTACHMENTS_ENABLED && (
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500 mb-2">
            Attach files <span className="text-zinc-600 normal-case font-normal">(optional)</span>
          </h3>

          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
            onDrop={onDrop}
            className={`rounded-lg border border-dashed px-4 py-6 text-center transition ${
              isDragging
                ? "border-[#c8a951] bg-[#c8a951]/5"
                : "border-zinc-700 bg-zinc-900/40"
            }`}
          >
            <Upload className="mx-auto h-5 w-5 text-zinc-500" />
            <p className="mt-2 text-sm text-zinc-400">
              Drag &amp; drop, or{" "}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="text-[#c8a951] hover:underline font-medium"
              >
                browse
              </button>
            </p>
            <p className="mt-1 text-xs text-zinc-600">
              PDF, TXT, MD · up to {ATTACHMENT_MAX_FILES} files · {humanSize(ATTACHMENT_MAX_FILE_BYTES)} each
            </p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={acceptAttr}
              onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }}
              className="hidden"
            />
          </div>

          {/* Current attachments — uploaded (ready) + in-flight/error UI rows. */}
          {uiItems.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {uiItems.map((ui) => (
                <li
                  key={ui.tempId}
                  className="flex items-center gap-2.5 rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2"
                >
                  <FileText className="h-4 w-4 shrink-0 text-zinc-500" />
                  <span className="flex-1 min-w-0 truncate text-sm text-zinc-300" title={ui.originalName}>
                    {ui.originalName}
                  </span>
                  <span className="shrink-0 text-xs text-zinc-600">{humanSize(ui.sizeBytes)}</span>
                  {ui.status === "uploading" && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">
                      <Loader2 className="h-2.5 w-2.5 animate-spin" /> uploading
                    </span>
                  )}
                  {ui.status === "ready" && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 text-[10px] text-emerald-400">
                      <CheckCircle2 className="h-2.5 w-2.5" /> ready
                    </span>
                  )}
                  {ui.status === "error" && (
                    <span
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-500/10 border border-red-500/30 px-2 py-0.5 text-[10px] text-red-400"
                      title={ui.errorMessage}
                    >
                      <AlertCircle className="h-2.5 w-2.5" /> error
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => void removeItem(ui)}
                    className="shrink-0 rounded p-0.5 text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition"
                    aria-label={`Remove ${ui.originalName}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {attachments.length > 0 && (
            <p className="mt-1.5 text-[11px] text-zinc-600">
              {attachments.length} file{attachments.length === 1 ? "" : "s"} attached
            </p>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onNext}
          className="flex items-center gap-2 rounded-lg bg-[#c8a951] px-5 py-2.5 text-sm font-medium text-[#1a2744] hover:bg-[#d4b85e] transition"
        >
          Next <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
