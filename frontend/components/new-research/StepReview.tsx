"use client";

import { useFormContext } from "react-hook-form";
import type { FormData } from "@/lib/validate";
import type { ContextSource } from "@/lib/context-items";
import type { StepReviewProps } from "@/lib/types/queue";
import { ArrowLeft, Loader2, Send, Music, Video, Presentation, FileText, Image as ImageIcon, Sparkles, RefreshCw, Repeat, X } from "lucide-react";
import { TimeEstimate } from "./Shared";

const PRODUCT_META: Record<string, { label: string; icon: typeof Music }> = {
  audio: { label: "Audio Overview", icon: Music },
  video: { label: "Cinematic Video", icon: Video },
  slides: { label: "Slide Deck", icon: Presentation },
  report: { label: "Executive Report", icon: FileText },
  infographic: { label: "Infographic", icon: ImageIcon },
};

// S29 hotfix: bare-domain href like "cloud.google.com/x" gets resolved as a
// RELATIVE URL by the browser, navigating to /new/cloud.google.com/x and
// triggering the [id] catch-all (which fails the UUID lookup and surfaces
// the error boundary). Always prepend https:// when no scheme is present.
function normalizeUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (/^\/\//.test(url)) return `https:${url}`;
  return `https://${url}`;
}

// S102 file-upload — human-readable byte size for the Attached Files review row.
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

// Path C (S29) / S153: "from topic" pill marks items the LLM extracted from the
// topic field, distinguishing them from items the user typed. An item edited on
// the Customize step shows "from topic · edited" (source user_edited_extracted).
function FromTopicBadge({ source }: { source: ContextSource }) {
  if (source === "user") return null;
  const label = source === "user_edited_extracted" ? "from topic · edited" : "from topic";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-[#c8a951]/10 border border-[#c8a951]/30 px-1.5 py-0.5 text-[10px] font-medium text-[#c8a951]"
      title="Inferred from your topic. Edit on the Customize step to change this."
    >
      <Sparkles className="h-2.5 w-2.5" /> {label}
    </span>
  );
}

type ContextListField = "domainKnowledge" | "constraints" | "additionalUrls" | "claimsToVerify";

// Per-item remove control on the Review screen. Lets the user drop a
// mis-extracted Research Context item (e.g. a non-URL "v1.1" that leaked into
// the reference URLs and fails strict URL validation, blocking submit) and
// decide for themselves whether it matters to the research.
function RemoveButton({ onRemove, label }: { onRemove: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      aria-label={`Remove ${label}`}
      title="Remove this item"
      className="shrink-0 rounded p-0.5 text-zinc-600 hover:text-red-400 hover:bg-red-400/10 transition"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );
}

export function StepReview({ onPrev, isSubmitting, submitError, estMins, cloneSlug }: StepReviewProps) {
  const { watch, setValue, formState: { errors } } = useFormContext<FormData>();
  const topic = watch("topic");
  const products = watch("selectedProducts");
  const vendor = watch("vendorEvaluation");
  const ajiDna = watch("ajiDnaEnabled");
  const customizations = watch("customizations");
  const notifyEmail = watch("notifyEmail");
  const userContext = watch("userContext");
  const extractedContext = watch("extractedContext");
  const pipelineMode = watch("pipelineMode") ?? "full";
  const attachments = watch("attachments");

  const selectedProducts = Object.entries(products ?? {}).filter(([, v]) => v);

  // Let the user drop a mis-extracted Research Context item from the Review
  // screen. The auto-extractor / dynamic-question split can leak non-URL prose
  // (e.g. a version label "v1.1") into additionalUrls, which then fails the
  // strict URL validator and BLOCKS submit with no edit path. Removing the
  // item re-validates immediately so the submit-block clears. The user decides
  // whether the item materially affects the research.
  const removeContextItem = (field: ContextListField, index: number) => {
    const current = userContext?.[field] ?? [];
    const next = current.filter((_, i) => i !== index);
    setValue(`userContext.${field}`, next, { shouldValidate: true, shouldDirty: true });
  };

  // S153 — provenance now lives on each item (it.source); no value-Set needed.

  const hasContext =
    (userContext?.domainKnowledge?.length ?? 0) > 0 ||
    (userContext?.constraints?.length ?? 0) > 0 ||
    (userContext?.additionalUrls?.length ?? 0) > 0 ||
    (userContext?.claimsToVerify?.length ?? 0) > 0;

  // True when the user has set any non-default Option. Drives the
  // "Default settings" placeholder below. Extracted to a single boolean so
  // adding a new Option means updating ONE list, not a long negated &&-chain
  // in JSX (S118 Gemini MERGE-gate readability finding #3).
  const hasCustomOptions =
    !!vendor?.enabled ||
    !!ajiDna ||
    !!userContext?.publishRequired ||
    !!customizations?.notebookLM?.persona ||
    !!customizations?.perplexity?.queryFraming ||
    !!notifyEmail;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-zinc-100">Review & Submit</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Confirm your research configuration before submitting to the queue.
        </p>
      </div>

      {/* Topic */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500 mb-2">Topic</h3>
        <p className="text-sm text-zinc-200 whitespace-pre-wrap">{topic}</p>
      </div>

      {/* Research Context — extracted from topic + answers to dynamic questions */}
      {hasContext && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Research Context</h3>
            {extractedContext && (
              <span className="text-[10px] text-zinc-500" title="Items marked 'from topic' were inferred from your topic field.">
                <Sparkles className="inline h-2.5 w-2.5 text-[#c8a951] mr-1" />
                Auto-extracted items shown
              </span>
            )}
          </div>

          {(userContext?.domainKnowledge?.length ?? 0) > 0 && (
            <div>
              <p className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">Domain Knowledge</p>
              <ul className="space-y-1">
                {userContext!.domainKnowledge.map((it, i) => (
                  <li key={it.id} className="flex items-start gap-2 text-sm text-zinc-300">
                    <span className="text-zinc-500 mt-0.5">•</span>
                    <span className="flex-1">{it.value}</span>
                    <FromTopicBadge source={it.source} />
                    <RemoveButton onRemove={() => removeContextItem("domainKnowledge", i)} label="domain knowledge item" />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(userContext?.constraints?.length ?? 0) > 0 && (
            <div>
              <p className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">Constraints</p>
              <ul className="space-y-1">
                {userContext!.constraints.map((it, i) => (
                  <li key={it.id} className="flex items-start gap-2 text-sm text-zinc-300">
                    <span className="text-zinc-500 mt-0.5">•</span>
                    <span className="flex-1">{it.value}</span>
                    <FromTopicBadge source={it.source} />
                    <RemoveButton onRemove={() => removeContextItem("constraints", i)} label="constraint" />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(userContext?.additionalUrls?.length ?? 0) > 0 && (
            <div>
              <p className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">Reference URLs</p>
              <ul className="space-y-1">
                {userContext!.additionalUrls.map((it, i) => (
                  <li key={it.id} className="flex items-start gap-2 text-sm text-zinc-300">
                    <span className="text-zinc-500 mt-0.5">•</span>
                    <a href={normalizeUrl(it.value)} target="_blank" rel="noopener noreferrer" className="flex-1 text-zinc-300 hover:text-[#c8a951] hover:underline truncate">
                      {it.value}
                    </a>
                    <FromTopicBadge source={it.source} />
                    <RemoveButton onRemove={() => removeContextItem("additionalUrls", i)} label="reference URL" />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(userContext?.claimsToVerify?.length ?? 0) > 0 && (
            <div>
              <p className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">Claims to Verify</p>
              <ul className="space-y-1">
                {userContext!.claimsToVerify.map((it, i) => (
                  <li key={it.id} className="flex items-start gap-2 text-sm text-zinc-300">
                    <span className="text-zinc-500 mt-0.5">•</span>
                    <span className="flex-1">{it.value}</span>
                    <FromTopicBadge source={it.source} />
                    <RemoveButton onRemove={() => removeContextItem("claimsToVerify", i)} label="claim" />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Products */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500 mb-2">Products</h3>
        <div className="flex flex-wrap gap-2">
          {selectedProducts.map(([key]) => {
            const meta = PRODUCT_META[key];
            if (!meta) return null;
            const Icon = meta.icon;
            return (
              <span key={key} className="inline-flex items-center gap-1.5 rounded-md bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300">
                <Icon className="h-3.5 w-3.5 text-[#c8a951]" /> {meta.label}
              </span>
            );
          })}
        </div>
      </div>

      {/* Options */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500 mb-2">Options</h3>
        {vendor?.enabled && (
          <p className="text-xs text-zinc-400">Vendor Evaluation: <span className="text-zinc-200">{vendor.vendorType || "Enabled"}</span></p>
        )}
        {ajiDna && (
          <p className="text-xs text-zinc-400">Executive Style (AJI DNA): <span className="text-emerald-400">Enabled</span></p>
        )}
        {userContext?.publishRequired && (
          <p className="text-xs text-zinc-400">Publish gate: <span className="text-amber-400">Enabled — claim verification required before completion</span></p>
        )}
        {customizations?.notebookLM?.persona && (
          <p className="text-xs text-zinc-400">Persona: <span className="text-zinc-200">{customizations.notebookLM.persona}</span></p>
        )}
        {customizations?.perplexity?.queryFraming && (
          <p className="text-xs text-zinc-400">Query Framing: <span className="text-zinc-200">{customizations.perplexity.queryFraming}</span></p>
        )}
        {notifyEmail && (
          <p className="text-xs text-zinc-400">Notify: <span className="text-zinc-200">{notifyEmail}</span></p>
        )}
        {!hasCustomOptions && (
          <p className="text-xs text-zinc-500 italic">Default settings</p>
        )}
      </div>

      {/* S102 file-upload — Attached Files (only when at least one attached).
          Items carried from a cloned parent run carry origin:"parent" and get
          a "cloned from original run" badge. */}
      {attachments && attachments.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500 mb-2">Attached Files</h3>
          <ul className="space-y-1.5">
            {attachments.map((a, i) => (
              <li key={a.storedName ?? i} className="flex items-center gap-2.5 text-sm text-zinc-300">
                <FileText className="h-4 w-4 shrink-0 text-zinc-500" />
                <span className="flex-1 min-w-0 truncate" title={a.originalName}>{a.originalName}</span>
                {a.origin === "parent" && (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#c8a951]/10 border border-[#c8a951]/30 px-1.5 py-0.5 text-[10px] font-medium text-[#c8a951]"
                    title="Carried over from the run you cloned."
                  >
                    <Repeat className="h-2.5 w-2.5" /> cloned from original run
                  </span>
                )}
                <span className="shrink-0 text-xs text-zinc-600">{humanSize(a.sizeBytes)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* CE-3 — Pipeline mode (only shown when cloning). studio_only skips
          Claude + deep research; the worker spawns regenerate-studio-products
          directly against the parent notebook for faster re-cuts. */}
      {cloneSlug && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
          <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Pipeline mode</h3>
          <label className="flex items-start gap-3 cursor-pointer rounded-md border border-transparent hover:border-zinc-700 p-2 -m-2 transition">
            <input
              type="radio"
              name="pipelineMode"
              value="full"
              checked={pipelineMode === "full"}
              onChange={() => setValue("pipelineMode", "full", { shouldDirty: true })}
              className="mt-1 h-4 w-4 accent-[#c8a951]"
            />
            <span className="flex-1">
              <span className="flex items-center gap-2 text-sm text-zinc-200">
                <RefreshCw className="h-3.5 w-3.5 text-[#c8a951]" /> Re-run full pipeline
              </span>
              <span className="block text-xs text-zinc-500 mt-0.5">
                Re-do every phase: deep research, NLM ingest, Studio products. Use when the topic or context changed.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3 cursor-pointer rounded-md border border-transparent hover:border-zinc-700 p-2 -m-2 transition">
            <input
              type="radio"
              name="pipelineMode"
              value="studio_only"
              checked={pipelineMode === "studio_only"}
              onChange={() => setValue("pipelineMode", "studio_only", { shouldDirty: true })}
              className="mt-1 h-4 w-4 accent-[#c8a951]"
            />
            <span className="flex-1">
              <span className="flex items-center gap-2 text-sm text-zinc-200">
                <Repeat className="h-3.5 w-3.5 text-[#c8a951]" /> Re-generate Studio products only
              </span>
              <span className="block text-xs text-zinc-500 mt-0.5">
                Skip research; reuse the parent notebook and regenerate the selected NLM Studio products (audio, video, slides, report, infographic).
              </span>
            </span>
          </label>
        </div>
      )}

      <TimeEstimate minutes={estMins} />

      {Object.keys(errors).length > 0 && (
        <div className="text-sm text-red-400 bg-red-400/10 rounded-lg px-4 py-3 space-y-1">
          <p className="font-medium">Please fix these issues before submitting:</p>
          <ul className="list-disc list-inside space-y-0.5 text-red-300">
            {flattenFieldErrors(errors).map((e, i) => (
              <li key={i}><span className="font-mono text-xs">{e.path}</span>: {e.message}</li>
            ))}
          </ul>
        </div>
      )}

      {submitError && (
        <p className="text-sm text-red-400 bg-red-400/10 rounded-lg px-4 py-2">{submitError}</p>
      )}

      <div className="flex justify-between">
        <button type="button" onClick={onPrev} disabled={isSubmitting} className="flex items-center gap-2 rounded-lg border border-zinc-700 px-5 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 transition disabled:opacity-50">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <button
          type="submit"
          disabled={isSubmitting}
          className="flex items-center gap-2 rounded-lg bg-[#c8a951] px-6 py-2.5 text-sm font-semibold text-[#1a2744] hover:bg-[#d4b85e] transition disabled:opacity-50"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Submitting...
            </>
          ) : (
            <>
              <Send className="h-4 w-4" /> Submit Research
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function flattenFieldErrors(
  errs: Record<string, unknown>,
  prefix = "",
): Array<{ path: string; message: string }> {
  const out: Array<{ path: string; message: string }> = [];
  for (const [key, val] of Object.entries(errs)) {
    if (!val || typeof val !== "object") continue;
    const v = val as Record<string, unknown>;
    if (typeof v.message === "string") {
      out.push({ path: prefix ? prefix + "." + key : key, message: v.message });
    } else {
      out.push(...flattenFieldErrors(v as Record<string, unknown>, prefix ? prefix + "." + key : key));
    }
  }
  return out;
}
