"use client";

import { useFormContext } from "react-hook-form";
import type { FormData } from "@/lib/validate";
import type { StepReviewProps } from "@/lib/types/queue";
import { ArrowLeft, Loader2, Send, Music, Video, Presentation, FileText, Image as ImageIcon } from "lucide-react";
import { TimeEstimate } from "./Shared";

const PRODUCT_META: Record<string, { label: string; icon: typeof Music }> = {
  audio: { label: "Audio Overview", icon: Music },
  video: { label: "Cinematic Video", icon: Video },
  slides: { label: "Slide Deck", icon: Presentation },
  report: { label: "Executive Report", icon: FileText },
  infographic: { label: "Infographic", icon: ImageIcon },
};

export function StepReview({ onPrev, isSubmitting, submitError, estMins }: StepReviewProps) {
  const { watch, formState: { errors } } = useFormContext<FormData>();
  const topic = watch("topic");
  const products = watch("selectedProducts");
  const vendor = watch("vendorEvaluation");
  const ajiDna = watch("ajiDnaEnabled");
  const customizations = watch("customizations");
  const notifyEmail = watch("notifyEmail");

  const selectedProducts = Object.entries(products ?? {}).filter(([, v]) => v);

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
        <p className="text-sm text-zinc-200">{topic}</p>
      </div>

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
        {customizations?.notebookLM?.persona && (
          <p className="text-xs text-zinc-400">Persona: <span className="text-zinc-200">{customizations.notebookLM.persona}</span></p>
        )}
        {customizations?.perplexity?.queryFraming && (
          <p className="text-xs text-zinc-400">Query Framing: <span className="text-zinc-200">{customizations.perplexity.queryFraming}</span></p>
        )}
        {notifyEmail && (
          <p className="text-xs text-zinc-400">Notify: <span className="text-zinc-200">{notifyEmail}</span></p>
        )}
        {!vendor?.enabled && !ajiDna && !customizations?.notebookLM?.persona && !customizations?.perplexity?.queryFraming && !notifyEmail && (
          <p className="text-xs text-zinc-500 italic">Default settings</p>
        )}
      </div>

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
