"use client";

import { useFormContext, Controller } from "react-hook-form";
import type { FormData } from "@/lib/validate";
import type { StepProps } from "@/lib/types/queue";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { TagInput } from "./Shared";

export function StepCustomize({ onNext, onPrev }: StepProps) {
  const { register, control, watch } = useFormContext<FormData>();
  const vendorEnabled = watch("vendorEvaluation.enabled");

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
          <input
            {...register("customizations.perplexity.queryFraming")}
            placeholder="e.g., Focus on enterprise-grade solutions..."
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-[#c8a951] focus:outline-none"
          />
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
          <input
            {...register("customizations.notebookLM.persona")}
            placeholder="e.g., Senior technology analyst at Gartner..."
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-[#c8a951] focus:outline-none"
          />
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
              <input {...register("vendorEvaluation.vendorType")} placeholder="e.g., SaaS" className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-[#c8a951] focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Service Area</label>
              <input {...register("vendorEvaluation.serviceArea")} placeholder="e.g., DevOps tooling" className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-[#c8a951] focus:outline-none" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs text-zinc-500 mb-1">Job Description</label>
              <textarea {...register("vendorEvaluation.jobDescription")} rows={2} placeholder="Describe what you need the vendor to do..." className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-[#c8a951] focus:outline-none resize-none" />
            </div>
          </div>
        )}
      </fieldset>

      {/* AJI DNA */}
      <div className="rounded-lg border border-zinc-800 p-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            {...register("ajiDnaEnabled")}
            className="h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-[#c8a951] focus:ring-[#c8a951]"
          />
          <span className="text-sm text-zinc-300">Enable executive communication style (AJI DNA)</span>
        </label>
      </div>

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
