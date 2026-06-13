"use client";

import { useFormContext, Controller } from "react-hook-form";
import type { FormData } from "@/lib/validate";
import type { StepProps } from "@/lib/types/queue";
import { ArrowLeft, ArrowRight, Sparkles, ShieldCheck } from "lucide-react";
import { TagInput } from "./Shared";

// Path C (S29): subtle hint above pre-filled fields. Sparkles icon matches
// the FromTopicBadge in StepReview for visual consistency.
function PreFilledHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-1 text-[10px] text-[#c8a951] mb-1">
      <Sparkles className="h-2.5 w-2.5" />
      <span>{children}</span>
    </p>
  );
}

export function StepCustomize({ onNext, onPrev }: StepProps) {
  const { register, control, watch, formState: { errors } } = useFormContext<FormData>();
  const vendorEnabled = watch("vendorEvaluation.enabled");
  const extractedContext = watch("extractedContext");

  const ec = extractedContext;
  const vendorTypeFromTopic = ec?.vendorEvaluation?.vendorType !== null && ec?.vendorEvaluation?.vendorType !== undefined;
  const serviceAreaFromTopic = ec?.vendorEvaluation?.serviceArea !== null && ec?.vendorEvaluation?.serviceArea !== undefined;
  const vendorEnabledFromTopic = ec?.vendorEvaluation?.enabled !== null && ec?.vendorEvaluation?.enabled !== undefined;
  const ajiDnaFromTopic = ec?.ajiDnaEnabled !== null && ec?.ajiDnaEnabled !== undefined;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-zinc-100">Customize Research</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Fine-tune how each research tool operates. All fields are optional.
        </p>
      </div>

      {/* Perplexity */}
      <fieldset className="rounded-lg border border-zinc-800 p-4 space-y-3">
        <legend className="px-2 text-sm font-medium text-zinc-300">Perplexity Search</legend>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Query Framing</label>
          <textarea
            {...register("customizations.perplexity.queryFraming")}
            rows={6}
            placeholder="Frame how Perplexity should approach the research. Paste detailed context, prior findings, or the specific angle you want explored. Up to 25,000 characters."
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-[#c8a951] focus:outline-none resize-y"
          />
          {errors.customizations?.perplexity?.queryFraming?.message && (
            <p className="mt-1 text-xs text-red-400">{errors.customizations.perplexity.queryFraming.message}</p>
          )}
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Emphasis Topics</label>
          <Controller
            control={control}
            name="customizations.perplexity.emphasis"
            render={({ field }) => (
              <TagInput
                tags={field.value ?? []}
                onChange={field.onChange}
                placeholder="Add emphasis topics..."
              />
            )}
          />
        </div>
      </fieldset>

      {/* NotebookLM */}
      <fieldset className="rounded-lg border border-zinc-800 p-4 space-y-3">
        <legend className="px-2 text-sm font-medium text-zinc-300">NotebookLM</legend>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Persona</label>
          <textarea
            {...register("customizations.notebookLM.persona")}
            rows={6}
            placeholder="Describe the persona NotebookLM should adopt. Include role, priorities, vocabulary, audience focus. Up to 25,000 characters."
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-[#c8a951] focus:outline-none resize-y"
          />
          {errors.customizations?.notebookLM?.persona?.message && (
            <p className="mt-1 text-xs text-red-400">{errors.customizations.notebookLM.persona.message}</p>
          )}
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Research Mode</label>
          <select
            {...register("customizations.notebookLM.researchMode")}
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-[#c8a951] focus:outline-none"
          >
            <option value="deep">Deep (recommended)</option>
            <option value="standard">Standard</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Research Priorities</label>
          <Controller
            control={control}
            name="customizations.notebookLM.priorities"
            render={({ field }) => (
              <TagInput
                tags={field.value ?? []}
                onChange={field.onChange}
                placeholder="Add priority topics..."
              />
            )}
          />
        </div>
      </fieldset>

      {/* Vendor Evaluation */}
      <fieldset className="rounded-lg border border-zinc-800 p-4 space-y-3">
        <legend className="px-2 text-sm font-medium text-zinc-300">Vendor Evaluation</legend>
        {vendorEnabledFromTopic && (
          <PreFilledHint>Pre-filled from your topic — uncheck to disable</PreFilledHint>
        )}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            {...register("vendorEvaluation.enabled")}
            className="h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-[#c8a951] focus:ring-[#c8a951]"
          />
          <span className="text-sm text-zinc-300">Enable vendor discovery & scoring</span>
        </label>
        {vendorEnabled && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Vendor Type</label>
              {vendorTypeFromTopic && <PreFilledHint>Inferred from topic — edit if not what you meant</PreFilledHint>}
              <input {...register("vendorEvaluation.vendorType")} placeholder="e.g., SaaS" className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-[#c8a951] focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Service Area</label>
              {serviceAreaFromTopic && <PreFilledHint>Inferred from topic — edit if not what you meant</PreFilledHint>}
              <input {...register("vendorEvaluation.serviceArea")} placeholder="e.g., DevOps tooling" className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-[#c8a951] focus:outline-none" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs text-zinc-500 mb-1">Job Description</label>
              <textarea
                {...register("vendorEvaluation.jobDescription")}
                rows={5}
                placeholder="Describe in detail what the vendor will do, scope, timeline, deliverables, constraints. Up to 10,000 characters."
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-[#c8a951] focus:outline-none resize-y"
              />
              {errors.vendorEvaluation?.jobDescription?.message && (
                <p className="mt-1 text-xs text-red-400">{errors.vendorEvaluation.jobDescription.message}</p>
              )}
            </div>
          </div>
        )}
      </fieldset>

      {/* AJI DNA */}
      <div className="rounded-lg border border-zinc-800 p-4">
        {ajiDnaFromTopic && (
          <PreFilledHint>Pre-filled from your topic — uncheck to disable</PreFilledHint>
        )}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            {...register("ajiDnaEnabled")}
            className="h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-[#c8a951] focus:ring-[#c8a951]"
          />
          <span className="text-sm text-zinc-300">Enable executive communication style (AJI DNA)</span>
        </label>
      </div>

      {/* MRPF PUBLISH gate (S118) — flags a run whose outputs are bound for
          external distribution OR submitted for strategic / capital /
          operational / architectural authorization. When checked, the worker
          refuses job completion until every load-bearing claim passes the
          publish_verification manifest (agent/lib/publish-gate.ts):
          full-date-anchored, sourced, and verified across all live legs.
          Leave OFF for internal or exploratory runs — the gate is strict and
          will hard-block an unverifiable run. Plumbs through
          userContext.publishRequired → research_queue.user_context jsonb. */}
      <fieldset className="rounded-lg border border-amber-700/40 bg-amber-950/10 p-4">
        <legend className="flex items-center gap-1.5 px-2 text-sm font-medium text-amber-300">
          <ShieldCheck className="h-3.5 w-3.5" /> Publish gate
        </legend>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            {...register("userContext.publishRequired")}
            className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-amber-400 focus:ring-amber-400"
          />
          <span className="text-sm text-zinc-300">
            This run is for publication or decision authorization
            <span className="mt-1 block text-xs text-zinc-500">
              Enforces claim verification before completion — the run will not finish until every
              load-bearing claim is sourced, dated (YYYY-MM-DD), and verified across all live research
              legs. Leave off for internal or exploratory research.
            </span>
          </span>
        </label>
      </fieldset>

      {/* Email notification */}
      <div>
        <label className="block text-xs text-zinc-500 mb-1">Notification Email (optional)</label>
        <input
          {...register("notifyEmail")}
          type="email"
          placeholder="you@example.com"
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-[#c8a951] focus:outline-none"
        />
      </div>

      <div className="flex justify-between">
        <button type="button" onClick={onPrev} className="flex items-center gap-2 rounded-lg border border-zinc-700 px-5 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 transition">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <button type="button" onClick={onNext} className="flex items-center gap-2 rounded-lg bg-[#c8a951] px-5 py-2.5 text-sm font-medium text-[#1a2744] hover:bg-[#d4b85e] transition">
          Next <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
