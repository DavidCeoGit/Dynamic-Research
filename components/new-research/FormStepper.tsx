"use client";

import { FORM_STEPS } from "@/lib/types/queue";
import type { FormStep } from "@/lib/types/queue";
import { Check } from "lucide-react";

const STEP_LABELS: Record<FormStep, string> = {
  topic: "Topic",
  questions: "Refine",
  products: "Products",
  customize: "Customize",
  review: "Review",
};

interface FormStepperProps {
  currentStep: FormStep;
  currentIndex: number;
}

export function FormStepper({ currentStep, currentIndex }: FormStepperProps) {
  return (
    <nav aria-label="Progress" className="mb-8">
      <ol className="flex items-center gap-2">
        {FORM_STEPS.map((s, i) => {
          const isCompleted = i < currentIndex;
          const isCurrent = s === currentStep;
          return (
            <li key={s} className="flex items-center gap-2 flex-1">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition ${
                    isCompleted
                      ? "bg-emerald-500 text-white"
                      : isCurrent
                        ? "bg-[#c8a951] text-[#1a2744]"
                        : "bg-zinc-800 text-zinc-500"
                  }`}
                >
                  {isCompleted ? <Check className="h-4 w-4" /> : i + 1}
                </span>
                <span
                  className={`text-sm font-medium truncate ${
                    isCurrent ? "text-zinc-100" : isCompleted ? "text-zinc-400" : "text-zinc-600"
                  }`}
                >
                  {STEP_LABELS[s]}
                </span>
              </div>
              {i < FORM_STEPS.length - 1 && (
                <div
                  className={`h-px flex-1 ${
                    isCompleted ? "bg-emerald-500/50" : "bg-zinc-800"
                  }`}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
