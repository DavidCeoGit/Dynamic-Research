"use client";

import { Suspense } from "react";
import { FormProvider } from "react-hook-form";
import { useNewResearchForm } from "@/hooks/useNewResearchForm";
import { FormStepper } from "@/components/new-research/FormStepper";
import { StepTopic } from "@/components/new-research/StepTopic";
import { StepQuestions } from "@/components/new-research/StepQuestions";
import { StepProducts } from "@/components/new-research/StepProducts";
import { StepCustomize } from "@/components/new-research/StepCustomize";
import { StepReview } from "@/components/new-research/StepReview";
import { Loader2, GitFork, AlertCircle } from "lucide-react";

function NewResearchInner() {
  const {
    form,
    step,
    stepIndex,
    isGenerating,
    isSubmitting,
    submitError,
    estMins,
    goNext,
    goPrev,
    handleFormSubmit,
    // S35 Clone & Edit
    cloneSlug,
    cloneTopic,
    isLoadingClone,
    cloneError,
  } = useNewResearchForm();

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-100 mb-2">
        {cloneSlug ? "Clone & Edit" : "New Research"}
      </h1>
      <p className="text-sm text-zinc-500 mb-6">
        {cloneSlug
          ? "Every field is pre-filled from the source run. Edit anything you want and submit to create a linked v2."
          : "Configure and queue a new three-way deep research run."}
      </p>

      {/* S35 Clone banner — surfaces lineage to the user while they edit */}
      {cloneSlug && (
        <div className="mb-8">
          {isLoadingClone && (
            <div className="flex items-center gap-3 rounded-md border border-zinc-700 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>
                Loading manifest from{" "}
                <span className="font-mono text-zinc-300">{cloneSlug}</span>…
              </span>
            </div>
          )}
          {cloneError && (
            <div className="flex items-start gap-3 rounded-md border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Could not load source run.</p>
                <p className="mt-1 text-xs text-red-400/80">{cloneError}</p>
                <p className="mt-1 text-xs text-red-400/80">
                  You can still fill in the form manually below.
                </p>
              </div>
            </div>
          )}
          {!isLoadingClone && !cloneError && cloneTopic && (
            <div className="flex items-start gap-3 rounded-md border border-[#c8a951]/40 bg-[#c8a951]/5 px-4 py-3 text-sm text-zinc-300">
              <GitFork className="mt-0.5 h-4 w-4 shrink-0 text-[#c8a951]" />
              <div>
                <p className="text-xs uppercase tracking-widest text-[#c8a951]">
                  Cloning from
                </p>
                <p className="mt-0.5 font-medium text-zinc-100">{cloneTopic}</p>
                <p className="mt-0.5 font-mono text-xs text-zinc-500">
                  {cloneSlug}
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      <FormStepper currentStep={step} currentIndex={stepIndex} />

      <FormProvider {...form}>
        <form onSubmit={handleFormSubmit}>
          {step === "topic" && <StepTopic onNext={goNext} onPrev={goPrev} />}
          {step === "questions" && <StepQuestions onNext={goNext} onPrev={goPrev} isGenerating={isGenerating} />}
          {step === "products" && <StepProducts onNext={goNext} onPrev={goPrev} estMins={estMins} />}
          {step === "customize" && <StepCustomize onNext={goNext} onPrev={goPrev} />}
          {step === "review" && <StepReview onPrev={goPrev} isSubmitting={isSubmitting} submitError={submitError} estMins={estMins} cloneSlug={cloneSlug} />}
        </form>
      </FormProvider>
    </div>
  );
}

export default function NewResearchPage() {
  // useSearchParams() requires a Suspense boundary in Next.js 15+ to satisfy
  // the static-vs-dynamic boundary contract. Wrap the inner component.
  return (
    <Suspense fallback={
      <div className="mx-auto max-w-2xl px-6 py-32 text-center text-sm text-zinc-500">
        <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
        Loading form…
      </div>
    }>
      <NewResearchInner />
    </Suspense>
  );
}
