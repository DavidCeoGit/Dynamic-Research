"use client";

/**
 * Editable "Research Context" surface for the Customize step (S153 Defect 3).
 *
 * Renders the four provenance-tagged userContext arrays as editable rows:
 * edit-in-place, remove, and add. Reference URLs validate PER ITEM live via
 * isValidUrlItem — each RAW item is validated independently so the inline status
 * maps 1:1 to the row the user sees (closes the preprocess drop/reindex mismatch).
 * Editing an extracted item flips its provenance to user_edited_extracted (D4),
 * which the badge reflects ("from topic · edited").
 */

import { useState } from "react";
import { useFormContext } from "react-hook-form";
import type { FormData } from "@/lib/validate";
import type { ContextArrayField, ContextItem, ContextSource } from "@/lib/context-items";
import { addUserValue } from "@/lib/context-items";
import { isValidUrlItem } from "@/lib/url-normalize";
import { Sparkles, X, Plus } from "lucide-react";

const SECTIONS: Array<{ field: ContextArrayField; label: string; isUrl?: boolean; placeholder: string }> = [
  { field: "domainKnowledge", label: "Domain Knowledge", placeholder: "Add a fact or background detail…" },
  { field: "constraints", label: "Constraints", placeholder: "Add a constraint…" },
  { field: "additionalUrls", label: "Reference URLs", isUrl: true, placeholder: "https://example.com" },
  { field: "claimsToVerify", label: "Claims to Verify", placeholder: "Add a claim to fact-check…" },
];

function ProvenanceBadge({ source }: { source: ContextSource }) {
  if (source === "user") return null;
  const label = source === "user_edited_extracted" ? "from topic · edited" : "from topic";
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#c8a951]/10 border border-[#c8a951]/30 px-1.5 py-0.5 text-[10px] font-medium text-[#c8a951]"
      title="Inferred from your topic. Edit or remove freely."
    >
      <Sparkles className="h-2.5 w-2.5" /> {label}
    </span>
  );
}

export function ResearchContextEditor() {
  const { watch, setValue } = useFormContext<FormData>();
  const userContext = watch("userContext");
  const [drafts, setDrafts] = useState<Partial<Record<ContextArrayField, string>>>({});

  const itemsOf = (field: ContextArrayField): ContextItem[] => userContext?.[field] ?? [];

  const writeField = (field: ContextArrayField, next: ContextItem[], validate = false) => {
    setValue(`userContext.${field}` as const, next, { shouldDirty: true, shouldValidate: validate });
  };

  const updateItem = (field: ContextArrayField, id: string, value: string) => {
    writeField(
      field,
      itemsOf(field).map((it) =>
        it.id === id
          ? { ...it, value, source: it.source === "extracted" ? "user_edited_extracted" : it.source }
          : it,
      ),
    );
  };

  const removeItem = (field: ContextArrayField, id: string) => {
    writeField(field, itemsOf(field).filter((it) => it.id !== id), true);
  };

  const addItem = (field: ContextArrayField) => {
    const v = (drafts[field] ?? "").trim();
    if (!v) return;
    writeField(field, addUserValue(itemsOf(field), v), true);
    setDrafts((d) => ({ ...d, [field]: "" }));
  };

  return (
    <fieldset className="rounded-lg border border-zinc-800 p-4 space-y-4">
      <legend className="flex items-center gap-1.5 px-2 text-sm font-medium text-zinc-300">
        <Sparkles className="h-3.5 w-3.5 text-[#c8a951]" /> Research Context
      </legend>
      <p className="text-xs text-zinc-500 -mt-1">
        Items inferred from your topic appear here. Edit, remove, or add your own. Reference URLs are
        checked as you type — fix or remove any flagged URL before continuing.
      </p>

      {SECTIONS.map(({ field, label, isUrl, placeholder }) => {
        const items = itemsOf(field);
        return (
          <div key={field} className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>

            {items.length === 0 && (
              <p className="text-xs text-zinc-600 italic">None yet.</p>
            )}

            {items.map((it) => {
              const status = isUrl ? isValidUrlItem(it.value) : { ok: true as const, normalized: it.value };
              return (
                <div key={it.id} className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <input
                      value={it.value}
                      onChange={(e) => updateItem(field, it.id, e.target.value)}
                      placeholder={placeholder}
                      aria-invalid={!status.ok}
                      className={`flex-1 rounded-md border bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none ${
                        status.ok
                          ? "border-zinc-700 focus:border-[#c8a951]"
                          : "border-red-500/60 focus:border-red-400"
                      }`}
                    />
                    <ProvenanceBadge source={it.source} />
                    <button
                      type="button"
                      onClick={() => removeItem(field, it.id)}
                      aria-label={`Remove ${label} item`}
                      title="Remove this item"
                      className="shrink-0 rounded p-1 text-zinc-600 hover:text-red-400 hover:bg-red-400/10 transition"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {isUrl && !status.ok && status.message && (
                    <p className="pl-1 text-xs text-red-400">{status.message}</p>
                  )}
                </div>
              );
            })}

            <div className="flex items-center gap-2 pt-0.5">
              <input
                value={drafts[field] ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [field]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addItem(field);
                  }
                }}
                placeholder={placeholder}
                className="flex-1 rounded-md border border-dashed border-zinc-700 bg-zinc-900/60 px-3 py-1.5 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-[#c8a951] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => addItem(field)}
                aria-label={`Add ${label} item`}
                title="Add"
                className="shrink-0 inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 transition"
              >
                <Plus className="h-3.5 w-3.5" /> Add
              </button>
            </div>
          </div>
        );
      })}
    </fieldset>
  );
}
