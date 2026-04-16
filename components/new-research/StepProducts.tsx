"use client";

import { useFormContext } from "react-hook-form";
import type { FormData } from "@/lib/validate";
import type { StepProductsProps } from "@/lib/types/queue";
import { ArrowLeft, ArrowRight, Music, Video, Presentation, FileText, Image as ImageIcon } from "lucide-react";
import { TimeEstimate } from "./Shared";

const PRODUCTS = [
  { key: "audio" as const, label: "Audio Overview", desc: "NotebookLM podcast-style audio deep dive", icon: Music, time: "+8 min" },
  { key: "video" as const, label: "Cinematic Video", desc: "Veo 3 cinematic research summary", icon: Video, time: "+15 min" },
  { key: "slides" as const, label: "Slide Deck", desc: "NotebookLM presentation slides (PDF)", icon: Presentation, time: "+6 min" },
  { key: "report" as const, label: "Executive Report", desc: "Formatted research report (DOCX)", icon: FileText, time: "+5 min" },
  { key: "infographic" as const, label: "Infographic", desc: "Visual data summary", icon: ImageIcon, time: "+10 min" },
] as const;

export function StepProducts({ onNext, onPrev, estMins }: StepProductsProps) {
  const { register, watch, formState: { errors } } = useFormContext<FormData>();
  const selected = watch("selectedProducts");
  const productError = errors.selectedProducts;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-zinc-100">Select Output Products</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Choose which deliverables to generate. Each adds to the total processing time.
        </p>
      </div>

      {productError && "message" in productError && (
        <p className="text-sm text-red-400">{productError.message as string}</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {PRODUCTS.map(({ key, label, desc, icon: Icon, time }) => {
          const isChecked = selected?.[key] ?? false;
          return (
            <label
              key={key}
              className={`flex items-start gap-3 rounded-lg border p-4 cursor-pointer transition ${
                isChecked
                  ? "border-[#c8a951] bg-[#c8a951]/5"
                  : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700"
              }`}
            >
              <input
                type="checkbox"
                {...register(`selectedProducts.${key}`)}
                className="mt-1 h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-[#c8a951] focus:ring-[#c8a951]"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Icon className={`h-4 w-4 ${isChecked ? "text-[#c8a951]" : "text-zinc-500"}`} />
                  <span className="text-sm font-medium text-zinc-200">{label}</span>
                  <span className="text-xs text-zinc-600">{time}</span>
                </div>
                <p className="mt-0.5 text-xs text-zinc-500">{desc}</p>
              </div>
            </label>
          );
        })}
      </div>

      <TimeEstimate minutes={estMins} />

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
