"use client";

import { useFormContext } from "react-hook-form";
import type { FormData } from "@/lib/validate";
import type { StepProps } from "@/lib/types/queue";
import { ArrowRight } from "lucide-react";

export function StepTopic({ onNext }: StepProps) {
  const { register, formState: { errors }, watch } = useFormContext<FormData>();
  const topic = watch("topic") ?? "";

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
          placeholder="e.g., Compare the top 5 AI code assistants for enterprise TypeScript development, focusing on security, cost, and developer experience..."
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-[#c8a951] focus:outline-none focus:ring-1 focus:ring-[#c8a951] resize-none"
        />
        <div className="mt-1.5 flex items-center justify-between">
          {errors.topic ? (
            <p className="text-xs text-red-400">{errors.topic.message}</p>
          ) : (
            <p className="text-xs text-zinc-600">Minimum 10 characters</p>
          )}
          <span className={`text-xs ${topic.length >= 10 ? "text-zinc-500" : "text-zinc-600"}`}>
            {topic.length}/1000
          </span>
        </div>
      </div>

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
