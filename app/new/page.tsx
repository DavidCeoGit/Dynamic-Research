"use client";

import { FormProvider } from "react-hook-form";
import { useNewResearchForm } from "@/hooks/useNewResearchForm";
import { FormStepper } from "@/components/new-research/FormStepper";
import { StepTopic } from "@/components/new-research/StepTopic";
import { StepQuestions } from "@/components/new-research/StepQuestions";
import { StepProducts } from "@/components/new-research/StepProducts";
import { StepCustomize } from "@/components/new-research/StepCustomize";
import { StepReview } from "@/components/new-research/StepReview";

export default function NewResearchPage() {
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
  } = useNewResearchForm();

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-100 mb-2">
        New Research
      </h1>
      <p className="text-sm text-zinc-500 mb-8">
        Configure and queue a new three-way deep research run.
      </p>

      <FormStepper currentStep={step} currentIndex={stepIndex} />

      <FormProvider {...form}>
        <form onSubmit={handleFormSubmit}>
          {step === "topic" && <StepTopic onNext={goNext} onPrev={goPrev} />}
          {step === "questions" && <StepQuestions onNext={goNext} onPrev={goPrev} isGenerating={isGenerating} />}
          {step === "products" && <StepProducts onNext={goNext} onPrev={goPrev} estMins={estMins} />}
          {step === "customize" && <StepCustomize onNext={goNext} onPrev={goPrev} />}
          {step === "review" && <StepReview onPrev={goPrev} isSubmitting={isSubmitting} submitError={submitError} estMins={estMins} />}
        </form>
      </FormProvider>
    </div>
  );
}
