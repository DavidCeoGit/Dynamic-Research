"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { Resolver } from "react-hook-form";
import { useRouter } from "next/navigation";
import {
  formDataSchema,
  FORM_DEFAULT_VALUES,
  type FormData,
  type ExtractedContext,
} from "@/lib/validate";
import { estimateMinutes } from "@/lib/estimates";
import type { FormStep, GeneratedQuestion } from "@/lib/types/queue";
import { FORM_STEPS } from "@/lib/types/queue";

const STORAGE_KEY = "new-research-draft";

export function useNewResearchForm() {
  const router = useRouter();
  const [step, setStep] = useState<FormStep>("topic");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const isMounted = useRef(false);

  const form = useForm<FormData>({
    resolver: zodResolver(formDataSchema) as unknown as Resolver<FormData>,
    defaultValues: FORM_DEFAULT_VALUES,
    mode: "onTouched",
  });

  // ── Session storage restore ────────────────────────────────────────

  useEffect(() => {
    isMounted.current = true;
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        form.reset(parsed);
      }
    } catch {
      // Ignore parse errors
    }
  }, [form]);

  // ── Session storage save (debounced) ───────────────────────────────

  useEffect(() => {
    if (!isMounted.current) return;
    const sub = form.watch((values) => {
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(values));
      } catch {
        // Storage full or unavailable
      }
    });
    return () => sub.unsubscribe();
  }, [form]);

  // ── Time estimate ──────────────────────────────────────────────────

  const products = form.watch("selectedProducts");
  const vendorEnabled = form.watch("vendorEvaluation.enabled");
  const estMins = estimateMinutes(
    products ?? FORM_DEFAULT_VALUES.selectedProducts,
    vendorEnabled ?? false,
  );

  // ── Apply extracted context to userContext / vendorEvaluation ──────
  // Path B: silently merge LLM-extracted dimensions into the form state so
  // (a) they reach userContext at submit time without the user re-typing,
  // (b) downstream steps (Customize/Review) show the merged values.
  // Path C will add UI affordances for the user to see + edit pre-fills.

  const applyExtractedContext = useCallback((ec: ExtractedContext) => {
    if (ec.domainKnowledge && ec.domainKnowledge.length > 0) {
      const current = form.getValues("userContext.domainKnowledge") ?? [];
      const merged = Array.from(new Set([...current, ...ec.domainKnowledge]));
      form.setValue("userContext.domainKnowledge", merged);
    }
    if (ec.constraints && ec.constraints.length > 0) {
      const current = form.getValues("userContext.constraints") ?? [];
      const merged = Array.from(new Set([...current, ...ec.constraints]));
      form.setValue("userContext.constraints", merged);
    }
    if (ec.additionalUrls && ec.additionalUrls.length > 0) {
      const current = form.getValues("userContext.additionalUrls") ?? [];
      const merged = Array.from(new Set([...current, ...ec.additionalUrls]));
      form.setValue("userContext.additionalUrls", merged);
    }
    if (ec.claimsToVerify && ec.claimsToVerify.length > 0) {
      const current = form.getValues("userContext.claimsToVerify") ?? [];
      const merged = Array.from(new Set([...current, ...ec.claimsToVerify]));
      form.setValue("userContext.claimsToVerify", merged);
    }
    if (ec.vendorEvaluation) {
      if (ec.vendorEvaluation.enabled !== null) {
        form.setValue("vendorEvaluation.enabled", ec.vendorEvaluation.enabled);
      }
      if (ec.vendorEvaluation.vendorType !== null) {
        form.setValue("vendorEvaluation.vendorType", ec.vendorEvaluation.vendorType);
      }
      if (ec.vendorEvaluation.serviceArea !== null) {
        form.setValue("vendorEvaluation.serviceArea", ec.vendorEvaluation.serviceArea);
      }
    }
    if (ec.ajiDnaEnabled !== null) {
      form.setValue("ajiDnaEnabled", ec.ajiDnaEnabled);
    }
  }, [form]);

  // ── AI extract + question generation (chained) ─────────────────────

  const generateQuestions = useCallback(async () => {
    const topic = form.getValues("topic");
    if (!topic || topic.length < 10) return;

    setIsGenerating(true);
    let extracted: ExtractedContext | null = null;

    // Stage 1: extract structured context. Failure here is non-fatal —
    // we fall back to Path A behavior (generate questions without context).
    try {
      const res = await fetch("/api/queue/extract-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      if (res.ok) {
        const data = await res.json();
        extracted = data.extractedContext as ExtractedContext;
        form.setValue("extractedContext", extracted);
        applyExtractedContext(extracted);
      }
    } catch (err) {
      console.error("Context extraction failed (continuing without):", err);
    }

    // Stage 2: generate gap-only questions, passing extracted context.
    try {
      const res = await fetch("/api/queue/generate-questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, extractedContext: extracted }),
      });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      const data = await res.json();
      form.setValue("generatedQuestions", data.questions);
    } catch (err) {
      console.error("Question generation failed:", err);
    } finally {
      setIsGenerating(false);
    }
  }, [form, applyExtractedContext]);

  // ── Apply dynamic answers to userContext / vendorEvaluation ────────

  const applyDynamicAnswers = useCallback(() => {
    const questions: GeneratedQuestion[] = form.getValues("generatedQuestions");
    const answers = form.getValues("dynamicAnswers");

    for (const q of questions) {
      const answer = answers[q.id];
      if (answer === undefined || answer === "") continue;

      switch (q.mappedField) {
        case "domainKnowledge": {
          const current = form.getValues("userContext.domainKnowledge") ?? [];
          const val = typeof answer === "string" ? answer : String(answer);
          if (val && !current.includes(val)) {
            form.setValue("userContext.domainKnowledge", [...current, val]);
          }
          break;
        }
        case "constraints": {
          const current = form.getValues("userContext.constraints") ?? [];
          const val = typeof answer === "string" ? answer : String(answer);
          if (val && !current.includes(val)) {
            form.setValue("userContext.constraints", [...current, val]);
          }
          break;
        }
        case "additionalUrls": {
          const current = form.getValues("userContext.additionalUrls") ?? [];
          const val = typeof answer === "string" ? answer : "";
          const urls = val.split(/[,\s]+/).filter(Boolean);
          form.setValue("userContext.additionalUrls", [...new Set([...current, ...urls])]);
          break;
        }
        case "claimsToVerify": {
          const current = form.getValues("userContext.claimsToVerify") ?? [];
          const val = typeof answer === "string" ? answer : String(answer);
          if (val && !current.includes(val)) {
            form.setValue("userContext.claimsToVerify", [...current, val]);
          }
          break;
        }
        case "vendorEvaluation": {
          if (typeof answer === "boolean") {
            form.setValue("vendorEvaluation.enabled", answer);
          } else if (answer === "yes" || answer === "true") {
            form.setValue("vendorEvaluation.enabled", true);
          }
          break;
        }
        case "ajiDnaEnabled": {
          if (typeof answer === "boolean") {
            form.setValue("ajiDnaEnabled", answer);
          } else if (answer === "yes" || answer === "true") {
            form.setValue("ajiDnaEnabled", true);
          }
          break;
        }
      }
    }
  }, [form]);

  // ── Step navigation ────────────────────────────────────────────────

  const stepIndex = FORM_STEPS.indexOf(step);

  const goNext = useCallback(async () => {
    // Validate current step fields before advancing
    let fieldsToValidate: (keyof FormData)[] = [];

    if (step === "topic") {
      fieldsToValidate = ["topic"];
    }

    if (fieldsToValidate.length > 0) {
      const valid = await form.trigger(fieldsToValidate);
      if (!valid) return;
    }

    // Manual validation: at least one product selected
    if (step === "products") {
      const prods = form.getValues("selectedProducts");
      const hasProduct = Object.values(prods).some(Boolean);
      if (!hasProduct) {
        form.setError("selectedProducts", {
          type: "manual",
          message: "Select at least one product",
        });
        return;
      }
      form.clearErrors("selectedProducts");
    }

    // On leaving topic step, trigger extract + question generation
    if (step === "topic") {
      generateQuestions();
    }

    // On leaving questions step, apply answers to userContext
    if (step === "questions") {
      applyDynamicAnswers();
    }

    const nextIdx = stepIndex + 1;
    if (nextIdx < FORM_STEPS.length) {
      setStep(FORM_STEPS[nextIdx]);
    }
  }, [step, stepIndex, form, generateQuestions, applyDynamicAnswers]);

  const goPrev = useCallback(() => {
    const prevIdx = stepIndex - 1;
    if (prevIdx >= 0) {
      setStep(FORM_STEPS[prevIdx]);
    }
  }, [stepIndex]);

  // ── Submit ─────────────────────────────────────────────────────────

  const onSubmit = useCallback(async (data: FormData) => {
    setIsSubmitting(true);
    setSubmitError(null);

    // Strip transient fields before sending to API
    const {
      generatedQuestions: _gq,
      dynamicAnswers: _da,
      extractedContext: _ec,
      ...payload
    } = data;

    try {
      const res = await fetch("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Submission failed" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const result = await res.json();
      sessionStorage.removeItem(STORAGE_KEY);
      router.push(`/new/${result.id}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setIsSubmitting(false);
    }
  }, [router]);

  const handleFormSubmit = form.handleSubmit(onSubmit);

  return {
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
  };
}
