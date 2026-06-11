"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { Resolver } from "react-hook-form";
import { useRouter, useSearchParams } from "next/navigation";
import {
  formDataSchema,
  FORM_DEFAULT_VALUES,
  type FormData,
  type ExtractedContext,
} from "@/lib/validate";
import { estimateMinutes } from "@/lib/estimates";
import type { FormStep, GeneratedQuestion } from "@/lib/types/queue";
import { FORM_STEPS } from "@/lib/types/queue";
// S102 file-upload — carry the parent run's attachments into a cloned draft
// as origin:"parent" payload items so the submit route copies their bytes
// from the parent run's sources/ folder.
import { mapDbAttachmentsToParentPayload } from "@/lib/attachments-copy";

const STORAGE_KEY = "new-research-draft";

export function useNewResearchForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [step, setStep] = useState<FormStep>("topic");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // S35 Clone & Edit — when the form is opened via /new?clone=<slug>, pre-fill
  // from /api/runs/<slug>/manifest and stamp parentSlug on submit so the new
  // row's parent_run_id FK points back to the source run.
  const [cloneSlug, setCloneSlug] = useState<string | null>(null);
  const [cloneTopic, setCloneTopic] = useState<string | null>(null);
  const [isLoadingClone, setIsLoadingClone] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const isMounted = useRef(false);
  // A2 — prevent a late upload setValue from resurrecting the draft after the
  // user has already submitted. The form.watch handler checks this flag and
  // skips the sessionStorage write once submission is underway.
  const isSubmittedRef = useRef(false);

  const form = useForm<FormData>({
    resolver: zodResolver(formDataSchema) as unknown as Resolver<FormData>,
    defaultValues: FORM_DEFAULT_VALUES,
    mode: "onTouched",
  });

  // ── Initial form population: ?clone=<slug> OR sessionStorage restore ───
  //
  // S35 Clone & Edit precedence: a `?clone=<slug>` URL param wins over any
  // sessionStorage draft. The cloned manifest replaces the form state and
  // clears the prior draft so a stale auto-save can't poison the clone.
  // If clone fetch fails, we fall back to sessionStorage so the user
  // doesn't lose unsaved work.

  useEffect(() => {
    isMounted.current = true;
    const clone = searchParams?.get("clone");

    if (clone) {
      setCloneSlug(clone);
      setIsLoadingClone(true);
      setCloneError(null);
      void (async () => {
        try {
          const res = await fetch(`/api/runs/${encodeURIComponent(clone)}/manifest`);
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            throw new Error(err.error || `HTTP ${res.status}`);
          }
          const manifest = await res.json();
          setCloneTopic(manifest.parentTopic ?? null);
          // Drop manifest fields that aren't part of formDataSchema (parentSlug,
          // parentTopic) and merge with form defaults to satisfy transient
          // fields (generatedQuestions, dynamicAnswers, extractedContext).
          form.reset({
            ...FORM_DEFAULT_VALUES,
            topic: manifest.topic ?? "",
            userContext: manifest.userContext ?? FORM_DEFAULT_VALUES.userContext,
            vendorEvaluation:
              manifest.vendorEvaluation ?? FORM_DEFAULT_VALUES.vendorEvaluation,
            ajiDnaEnabled: manifest.ajiDnaEnabled ?? false,
            selectedProducts:
              manifest.selectedProducts ?? FORM_DEFAULT_VALUES.selectedProducts,
            customizations:
              manifest.customizations ?? FORM_DEFAULT_VALUES.customizations,
            notifyEmail: manifest.notifyEmail ?? "",
            // S102 — carry parent attachments as origin:"parent". The draft id
            // stays null (default) for clone; staged uploads in the new draft
            // get their own draft id lazily when the user adds files.
            attachments: mapDbAttachmentsToParentPayload(manifest.attachments),
          });
          // Don't pollute sessionStorage with the cloned manifest — the watch
          // handler will overwrite it on the next form interaction anyway.
          try {
            sessionStorage.removeItem(STORAGE_KEY);
          } catch {
            // ignore
          }
        } catch (err) {
          setCloneError(
            err instanceof Error
              ? err.message
              : "Failed to load source run manifest",
          );
        } finally {
          setIsLoadingClone(false);
        }
      })();
      return;
    }

    // No ?clone — fall back to sessionStorage restore (pre-S35 behavior).
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        form.reset(parsed);
      }
    } catch {
      // Ignore parse errors
    }
  }, [form, searchParams]);

  // ── Session storage save (debounced) ───────────────────────────────

  useEffect(() => {
    if (!isMounted.current) return;
    const sub = form.watch((values) => {
      // A2 — after submit succeeds, a late in-flight upload can fire setValue
      // which would re-persist the form to sessionStorage — resurrecting a
      // "draft" (with the orphaned staged attachment) on the next /new visit.
      // Skipping the write once submitted closes the resurrection window.
      if (isSubmittedRef.current) return;
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

  // ── Apply / prune extracted context ────────────────────────────────
  // Path B (S29): silently merge LLM-extracted dimensions into form state so
  // (a) they reach userContext at submit time without the user re-typing,
  // (b) downstream steps (Customize/Review) show the merged values.
  // Path C (S29): when user re-edits the topic and triggers re-extraction,
  // prune previously-extracted items from userContext so they don't linger
  // as stale data. Items the user typed via dynamic-question answers are
  // preserved (we only remove what matches the OLD extractedContext exactly).

  const pruneStaleExtraction = useCallback((oldEC: ExtractedContext | null) => {
    if (!oldEC) return;
    const pruneArray = (
      field: "domainKnowledge" | "constraints" | "additionalUrls" | "claimsToVerify",
      items: string[] | null,
    ) => {
      if (!items || items.length === 0) return;
      const toRemove = new Set(items);
      const current = form.getValues(`userContext.${field}`) ?? [];
      form.setValue(`userContext.${field}`, current.filter((x) => !toRemove.has(x)));
    };
    pruneArray("domainKnowledge", oldEC.domainKnowledge);
    pruneArray("constraints", oldEC.constraints);
    pruneArray("additionalUrls", oldEC.additionalUrls);
    pruneArray("claimsToVerify", oldEC.claimsToVerify);
    // Scalar fields (vendor*, ajiDnaEnabled) aren't pruned — once user has
    // potentially edited them, reverting on re-extraction is more disruptive
    // than leaving them. The new extraction will overwrite via applyExtractedContext.
  }, [form]);

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

    // If user is re-extracting (came back to topic step, edited, advanced),
    // remove items that came from the previous extraction before applying
    // the new one. Avoids stale "Houston Texas" lingering after the user
    // pivoted the topic to Dallas.
    const previousEC = form.getValues("extractedContext");
    pruneStaleExtraction(previousEC);

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
  }, [form, applyExtractedContext, pruneStaleExtraction]);

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

    // Strip transient fields before sending to API. pipelineMode is also
    // stripped here so non-clone submissions don't ship a "full" default
    // that ends up persisted to research_queue.pipeline_mode — keep that
    // column NULL for fresh runs (CE-3 invariant: studio_only only with
    // a parent_run_id).
    const {
      generatedQuestions: _gq,
      dynamicAnswers: _da,
      extractedContext: _ec,
      pipelineMode,
      ...formPayload
    } = data;

    // S35 Clone & Edit — stamp parentSlug if this submission is a clone.
    // Backend resolves slug→id and writes research_queue.parent_run_id.
    // CE-3 — pipelineMode rides alongside parentSlug; never sent without it.
    const payload = cloneSlug
      ? { ...formPayload, parentSlug: cloneSlug, pipelineMode }
      : formPayload;

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
      // A2 — set BEFORE removeItem so any late upload setValue that fires
      // between here and the navigation is suppressed by the watch guard.
      isSubmittedRef.current = true;
      sessionStorage.removeItem(STORAGE_KEY);
      router.push(`/new/${result.id}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setIsSubmitting(false);
    }
  }, [router, cloneSlug]);

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
    // S35 Clone & Edit — surfaces to the form page for the banner.
    cloneSlug,
    cloneTopic,
    isLoadingClone,
    cloneError,
  };
}
