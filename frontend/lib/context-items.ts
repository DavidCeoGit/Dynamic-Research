/**
 * Provenance-tagged context items — FORM STATE ONLY (S153).
 *
 * The four `userContext` arrays (domainKnowledge / constraints / additionalUrls
 * / claimsToVerify) carry provenance while the form is open so re-extraction can
 * replace the machine-extracted subset WITHOUT touching user-entered items, even
 * when an extracted value and a hand-typed value are byte-identical (the data-loss
 * vector Gemini's holistic MERGE-gate pass flagged as CRITICAL).
 *
 * SCOPE BOUNDARY (Gemini divergence, recorded in the design doc): provenance lives
 * only in form state. `serializeUserContext()` flattens back to the wire `string[]`
 * shape at submit, so `/api/queue`, `researchJobPayloadSchema`, the
 * `research_queue.user_context` jsonb, and the worker are UNCHANGED. Provenance is
 * never persisted to the wire.
 *
 * `toFormUserContext()` is the single inbound adapter (Codex MERGE-gate CRITICAL):
 * it accepts BOTH legacy `string[]` (pre-S153 clone manifests + sessionStorage
 * drafts) AND new `ContextItem[]`, so a restored old draft never renders
 * `item.value === undefined`.
 */

import { z } from "zod";

export type ContextSource = "extracted" | "user" | "user_edited_extracted";

export interface ContextItem {
  id: string;
  value: string;
  source: ContextSource;
}

export const contextItemSchema = z.object({
  id: z.string(),
  // Generous cap; per-field URL/length limits enforced at the wire schema after
  // serialization (validate.ts userContextSchema) + per-item UI validation.
  value: z.string().max(10000),
  source: z.enum(["extracted", "user", "user_edited_extracted"]),
});

/**
 * Form-state shape of userContext: the four arrays as provenance items plus the
 * scalar publishRequired flag (NOT an array — must not be swept into the object
 * refactor; Codex MERGE-gate note).
 */
export const formUserContextSchema = z.object({
  domainKnowledge: z.array(contextItemSchema).default([]),
  constraints: z.array(contextItemSchema).default([]),
  additionalUrls: z.array(contextItemSchema).default([]),
  claimsToVerify: z.array(contextItemSchema).default([]),
  publishRequired: z.boolean().default(false),
});

export type FormUserContext = z.infer<typeof formUserContextSchema>;

export const CONTEXT_ARRAY_FIELDS = [
  "domainKnowledge",
  "constraints",
  "additionalUrls",
  "claimsToVerify",
] as const;

export type ContextArrayField = (typeof CONTEXT_ARRAY_FIELDS)[number];

function newId(): string {
  // Available in browsers + Node 18.17+ (Next 16 floor) + Vercel Edge.
  return crypto.randomUUID();
}

export function makeContextItem(value: string, source: ContextSource): ContextItem {
  return { id: newId(), value, source };
}

/**
 * Inbound adapter: coerce a raw userContext array (legacy `string[]` OR new
 * `ContextItem[]` OR anything) into well-formed `ContextItem[]`. Legacy strings
 * default to `source:"user"` (they were user-confirmed in a prior draft / clone).
 */
function toItems(raw: unknown, defaultSource: ContextSource): ContextItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ContextItem[] = [];
  for (const x of raw) {
    if (typeof x === "string") {
      if (x.length > 0) out.push(makeContextItem(x, defaultSource));
    } else if (x && typeof x === "object" && typeof (x as { value?: unknown }).value === "string") {
      const obj = x as { id?: unknown; value: string; source?: unknown };
      const source: ContextSource =
        obj.source === "extracted" || obj.source === "user" || obj.source === "user_edited_extracted"
          ? obj.source
          : defaultSource;
      out.push({ id: typeof obj.id === "string" ? obj.id : newId(), value: obj.value, source });
    }
  }
  return out;
}

/**
 * Build a form-state userContext from a raw object (clone manifest OR restored
 * sessionStorage draft). Preserves `publishRequired`.
 */
export function toFormUserContext(raw: unknown): FormUserContext {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    domainKnowledge: toItems(r.domainKnowledge, "user"),
    constraints: toItems(r.constraints, "user"),
    additionalUrls: toItems(r.additionalUrls, "user"),
    claimsToVerify: toItems(r.claimsToVerify, "user"),
    publishRequired: Boolean(r.publishRequired),
  };
}

/**
 * Outbound adapter: flatten form-state userContext to the wire `string[]` shape
 * the API + worker expect. Drops empty values defensively.
 */
export function serializeUserContext(fc: FormUserContext): {
  domainKnowledge: string[];
  constraints: string[];
  additionalUrls: string[];
  claimsToVerify: string[];
  publishRequired: boolean;
} {
  const vals = (items: ContextItem[]) => items.map((i) => i.value).filter((v) => v.length > 0);
  return {
    domainKnowledge: vals(fc.domainKnowledge),
    constraints: vals(fc.constraints),
    additionalUrls: vals(fc.additionalUrls),
    claimsToVerify: vals(fc.claimsToVerify),
    publishRequired: fc.publishRequired,
  };
}

/**
 * Re-extraction core (Defect 2): replace the machine-extracted subset wholesale,
 * preserving user + user_edited_extracted items. Value-independent — never
 * subtracts a user item even if its value equals an extracted one. Runs
 * UNCONDITIONALLY (Codex MAJOR-2): `null`/`[]` new set still clears prior
 * extracted items.
 */
export function replaceExtracted(current: ContextItem[], newValues: string[] | null | undefined): ContextItem[] {
  const kept = current.filter((it) => it.source !== "extracted");
  const extracted = (newValues ?? []).map((v) => makeContextItem(v, "extracted"));
  return kept.concat(extracted);
}

/**
 * Apply a user-supplied value (dynamic-question answer or direct add). If the
 * value matches an existing `extracted` item, PROMOTE that item to
 * `user_edited_extracted` instead of skipping it as a dup (Codex MAJOR-3) — else
 * a user re-affirming an extracted value leaves the only item `source:"extracted"`
 * and the next re-extraction drops it. Returns the new array (no-op clone if the
 * value already exists as a user/edited item).
 */
export function addUserValue(current: ContextItem[], value: string): ContextItem[] {
  if (!value) return current;
  const idx = current.findIndex((it) => it.value === value);
  if (idx === -1) return current.concat(makeContextItem(value, "user"));
  const hit = current[idx];
  if (hit.source === "extracted") {
    const next = current.slice();
    next[idx] = { ...hit, source: "user_edited_extracted" };
    return next;
  }
  // Already a user / user_edited_extracted item with this value — no duplicate.
  return current;
}
