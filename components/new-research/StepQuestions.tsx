"use client";

import { useFormContext, Controller } from "react-hook-form";
import type { FormData } from "@/lib/validate";
import type { StepQuestionsProps, GeneratedQuestion } from "@/lib/types/queue";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";

export function StepQuestions({ onNext, onPrev, isGenerating }: StepQuestionsProps) {
  const { control, watch, setValue } = useFormContext<FormData>();
  const questions = watch("generatedQuestions") ?? [];
  const answers = watch("dynamicAnswers") ?? {};

  const setAnswer = (qId: string, value: string | boolean | string[]) => {
    setValue("dynamicAnswers", { ...answers, [qId]: value });
  };

  if (isGenerating) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-[#c8a951]" />
        <p className="text-sm text-zinc-400">Generating refinement questions for your topic...</p>
      </div>
    );
  }

  if (questions.length === 0) {
    return (
      <div className="space-y-6">
        <div className="text-center py-12">
          <p className="text-sm text-zinc-400">Questions could not be generated. You can go back to edit your topic or skip ahead.</p>
        </div>
        <div className="flex justify-between">
          <button type="button" onClick={onPrev} className="flex items-center gap-2 rounded-lg border border-zinc-700 px-5 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 transition">
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
          <button type="button" onClick={onNext} className="flex items-center gap-2 rounded-lg bg-[#c8a951] px-5 py-2.5 text-sm font-medium text-[#1a2744] hover:bg-[#d4b85e] transition">
            Skip <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-zinc-100">Refine Your Research</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Answer these AI-generated questions to help narrow scope and improve results. All are optional.
        </p>
      </div>

      <div className="space-y-5">
        {questions.map((q: GeneratedQuestion) => (
          <div key={q.id} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <label className="block text-sm font-medium text-zinc-200 mb-2">{q.text}</label>

            {q.type === "text" && (
              <input
                type="text"
                value={(answers[q.id] as string) ?? ""}
                onChange={(e) => setAnswer(q.id, e.target.value)}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-[#c8a951] focus:outline-none"
                placeholder="Type your answer..."
              />
            )}

            {q.type === "boolean" && (
              <div className="flex gap-3">
                {["Yes", "No"].map((opt) => {
                  const boolVal = opt === "Yes";
                  const isSelected = answers[q.id] === boolVal;
                  return (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setAnswer(q.id, boolVal)}
                      className={`rounded-md px-4 py-2 text-sm font-medium transition ${
                        isSelected
                          ? "bg-[#c8a951] text-[#1a2744]"
                          : "border border-zinc-700 text-zinc-400 hover:bg-zinc-800"
                      }`}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            )}

            {q.type === "multiselect" && q.options && (
              <Controller
                control={control}
                name="dynamicAnswers"
                render={() => {
                  const selected = (answers[q.id] as string[]) ?? [];
                  return (
                    <div className="flex flex-wrap gap-2">
                      {q.options!.map((opt) => {
                        const isSelected = selected.includes(opt);
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => {
                              const next = isSelected
                                ? selected.filter((s) => s !== opt)
                                : [...selected, opt];
                              setAnswer(q.id, next);
                            }}
                            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                              isSelected
                                ? "bg-[#c8a951] text-[#1a2744]"
                                : "border border-zinc-700 text-zinc-400 hover:bg-zinc-800"
                            }`}
                          >
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  );
                }}
              />
            )}
          </div>
        ))}
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
