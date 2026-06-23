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
// S153 — provenance-tagged context items (form-state only). Adapters bridge the
// legacy/wire string[] shape at the clone, sessionStorage-restore, and submit
// boundaries; replaceExtracted/addUserValue drive the re-extraction state model.
import {
  toFormUserContext,
  serializeUserContext,
  replaceExtracted,
  addUserValue,
} from "@/lib/context-items";
import { isValidUrlItem, normalizeUrlCandidate } from "@/lib/url-normalize";
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
            // S153 — manifest.userContext is the wire string[] shape; adapt to
            // provenance ContextItem[] (legacy strings default to source:"user").
            userContext: toFormUserContext(manifest.userContext),
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
        // S153 Codex MERGE-gate CRITICAL — a draft persisted before the
        // provenance migration holds userContext as string[]; restoring it raw
        // would render item.value === undefined and serialize null at submit.
        // toFormUserContext accepts BOTH legacy string[] and new ContextItem[],
        // so old and new drafts both restore correctly.
        form.reset({ ...parsed, userContext: toFormUserContext(parsed?.userContext) });
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

  // ── Apply extracted context (S153 provenance model) ────────────────
  // Path B (S29): merge LLM-extracted dimensions into form state so they reach
  // userContext at submit without the user re-typing, and Customize/Review show
  // them. Path C (S29): on re-extraction (topic edited), the prior extracted
  // subset must be REPLACED, never accumulated.
  //
  // S153 — replaceExtracted runs UNCONDITIONALLY for each array (Codex MERGE-gate
  // MAJOR-2): even when the new field is null/[] (topic changed to one with no
  // URLs), prior extracted items are cleared. User + user_edited_extracted items
  // are preserved by provenance, not by string identity — so a user-typed value
  // identical to an extracted one is never destroyed (Gemini MERGE-gate CRITICAL).
  // No previousEC read → no race; pruneStaleExtraction is retired.

  const applyExtractedContext = useCallback((ec: ExtractedContext) => {
    form.setValue(
      "userContext.domainKnowledge",
      replaceExtracted(form.getValues("userContext.domainKnowledge") ?? [], ec.domainKnowledge),
    );
    form.setValue(
      "userContext.constraints",
      replaceExtracted(form.getValues("userContext.constraints") ?? [], ec.constraints),
    );
    form.setValue(
      "userContext.additionalUrls",
      replaceExtracted(form.getValues("userContext.additionalUrls") ?? [], ec.additionalUrls),
    );
    form.setValue(
      "userContext.claimsToVerify",
      replaceExtracted(form.getValues("userContext.claimsToVerify") ?? [], ec.claimsToVerify),
    );
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

    // S153 — re-extraction replacement is handled inside applyExtractedContext
    // (replaceExtracted clears the prior extracted subset unconditionally). No
    // separate prune pass, no previousEC read.

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
          // S153 — addUserValue creates a source:"user" item, or promotes a
          // matching source:"extracted" item to user_edited_extracted (so a user
          // re-affirming an extracted value survives the next re-extraction;
          // Codex MERGE-gate MAJOR-3).
          const current = form.getValues("userContext.domainKnowledge") ?? [];
          const val = typeof answer === "string" ? answer : String(answer);
          form.setValue("userContext.domainKnowledge", addUserValue(current, val));
          break;
        }
        case "constraints": {
          const current = form.getValues("userContext.constraints") ?? [];
          const val = typeof answer === "string" ? answer : String(answer);
          form.setValue("userContext.constraints", addUserValue(current, val));
          break;
        }
        case "additionalUrls": {
          const current = form.getValues("userContext.additionalUrls") ?? [];
          const val = typeof answer === "string" ? answer : "";
          // S130/S153: the split lets users paste several space/comma-separated
          // URLs at once; normalizeUrlCandidate (the canonical helper) drops prose
          // tokens and canonicalizes real URLs so a PDF paste can't shatter into
          // hundreds of junk "URLs". Each surviving URL is added via addUserValue.
          let next = current;
          for (const tok of val.split(/[,\s]+/).filter(Boolean)) {
            const url = normalizeUrlCandidate(tok);
            if (url) next = addUserValue(next, url);
          }
          form.setValue("userContext.additionalUrls", next);
          break;
        }
        case "claimsToVerify": {
          const current = form.getValues("userContext.claimsToVerify") ?? [];
          const val = typeof answer === "string" ? answer : String(answer);
          form.setValue("userContext.claimsToVerify", addUserValue(current, val));
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

    // S153 Defect 3 — step-boundary gate. Block advancing out of Customize while
    // any reference URL is invalid, so a bad URL never reaches the (read-only)
    // Review screen and dead-ends the submit. Each row on the Customize editor has
    // an inline remove control, so the user is never wedged (D3). Per-item errors
    // render live in the editor; this sets a summary error + holds the step.
    if (step === "customize") {
      const urls = form.getValues("userContext.additionalUrls") ?? [];
      const firstBad = urls.findIndex((it) => !isValidUrlItem(it.value).ok);
      if (firstBad !== -1) {
        form.setError("userContext.additionalUrls", {
          type: "manual",
          message: "Fix or remove the highlighted reference URL before continuing",
        });
        return;
      }
      form.clearErrors("userContext.additionalUrls");
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

    try {
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
        userContext: _uc,
        ...rest
      } = data;

      // S153 — flatten the provenance-tagged form userContext back to the wire
      // string[] shape (serializeUserContext) so /api/queue, researchJobPayloadSchema,
      // the user_context jsonb, and the worker stay unchanged. Provenance never
      // reaches the wire.
      //
      // S159 — payload construction (incl. serializeUserContext) lives INSIDE the
      // try so any throw here surfaces as a visible submitError instead of
      // stranding the button on "Submitting..." forever (setIsSubmitting(false)
      // only runs in finally, which a pre-try throw would skip — the silent-stuck
      // class the user hit in prod).
      const formPayload = { ...rest, userContext: serializeUserContext(data.userContext) };

      // S35 Clone & Edit — stamp parentSlug if this submission is a clone.
      // Backend resolves slug→id and writes research_queue.parent_run_id.
      // CE-3 — pipelineMode rides alongside parentSlug; never sent without it.
      const payload = cloneSlug
        ? { ...formPayload, parentSlug: cloneSlug, pipelineMode }
        : formPayload;

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
