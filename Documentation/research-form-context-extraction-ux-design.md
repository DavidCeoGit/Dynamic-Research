# Research-Form Context-Extraction UX — Complete Fix (DESIGN)

**Session:** Dynamic Research S153 (2026-06-21)
**Status:** DESIGN v3-FINAL — sequential gate CLEARED. Gemini holistic BLOCK (CRIT data-loss) → integrated v2 → Codex grounded BLOCK (CRIT sessionStorage boundary + 3 MAJOR) → integrated v3-FINAL. Both reviewers' findings closed; architecture validated. Cleared to build. See §7.
**Supersedes / completes:** S152 `bc3ca22` (partial: downstream URL heuristic in `validate.ts` + ✕ remove-buttons on Review). This doc designs the *complete* fix for three distinct defects.
**MRPF classification:** MERGE gate, **frontend-only, reversible, NO hard risk labels** (no SECURITY/DATA/AGENT-BEHAVIOR/PRIVACY/INFRA/DEPENDENCY/ARCHITECTURE). Per §11 this is NOT a mandated tri-vendor gate; the user has elected the single Gemini→Codex round for rigor + validation-UX edge-case de-risking. Severity NORMAL.

---

## 0. The user-visible failure (why this matters)

A real client run (AES) was **blocked at Submit with no recovery path**: the topic's reference text contained `v1.1` and a sentence-final `leginfo.legislature.ca.gov.`, the extractor pulled both into `additionalUrls`, and the strict Zod-4 `.url()` validator rejected them only at final Submit — on a Review screen that, pre-S152, was read-only. S152 unblocked it (remove buttons + a tighter bare-domain heuristic) but left three root defects standing. This doc fixes all three so the class of bug cannot recur.

---

## 1. The three defects (root-cause, not symptom)

### Defect 1 — Extraction over-captures (UPSTREAM)
`POST /api/queue/extract-context` ([route.ts](../frontend/app/api/queue/extract-context/route.ts)) returns `result.object.additionalUrls` **verbatim from the LLM**. The system prompt (line 34) instructs the model to emit `https://`-schemed real URLs, but LLM compliance is best-effort: it emits version labels (`v1.1`), sentence-final tokens with trailing punctuation (`...ca.gov.`), and bare fragments. **No server-side validation gates the response** — invalid values flow straight into `extractedContext` → form state.

**Root cause:** trusting LLM output shape instead of validating at the system boundary (violates the global "sanitize at boundaries" rule for a *self-inflicted* boundary).

### Defect 2 — `additionalUrls` doesn't re-derive on re-extraction (STATE)
`applyExtractedContext` ([useNewResearchForm.ts:184-204](../frontend/hooks/useNewResearchForm.ts#L184)) **unions** (`new Set([...current, ...ec.field])`) extracted items into the live array. `pruneStaleExtraction` ([:164-182](../frontend/hooks/useNewResearchForm.ts#L164)) attempts to remove the *previous* extraction first, but by **exact string match** against `oldEC[field]`. When the user edits Topic and re-extracts:
- prune removes the old extracted set IF every string still matches byte-for-byte, then
- apply unions the new set.

This is fragile on two axes: (a) any drift in an extracted string between runs leaves a stale orphan prune can't find; (b) the two-step prune-then-merge is order- and identity-coupled. Observed symptom: user changed Topic, siblings (domainKnowledge etc.) re-derived, but `additionalUrls` stayed **byte-identical** to the prior bad set.

**Root cause:** extraction-sourced items are not modeled as a *replaceable subset* — they're smeared into the user-typed set with no stable provenance key, so "replace the extracted portion" degrades to "diff two string sets and hope."

### Defect 3 — No editable surface + late validation + index mis-map (UX)
- A bad value surfaces **only at final Submit** (the form-level `zodResolver`), never at the step where it was introduced.
- Review is remove-only (S152); Customize has **no** context-editing surface at all.
- **The hard part:** the Zod `additionalUrls` field ([validate.ts:53-83](../frontend/lib/validate.ts#L53)) `preprocess` **drops** items that fail the bare-domain heuristic and **prepends `https://`**, then validates the survivors with `z.string().url()`. The resulting error path `additionalUrls.<N>` indexes the **post-preprocess** array, but every UI surface renders the **raw** array. Any naive "highlight `additionalUrls.N`" marks the **wrong row** the moment preprocess drops or reorders an earlier item.

**Root cause:** one validation pass that simultaneously *mutates* (drop + normalize) and *validates* the array, so item identity is lost between "what the user sees" and "what the resolver flags."

---

## 2. The unifying model: per-item provenance + per-item validation

Two small model changes dissolve all three defects:

**(A) Per-item validation (kills the index mis-map).** The editable UI validates **each raw item independently** — `urlItemStatus(raw) → { normalized, ok, message }` — and renders that status next to the row the user is actually looking at. Highlight/edit/remove all read from this per-raw-item model, never from a post-preprocess index. The submit-time Zod stays authoritative, but by the time the user reaches Submit they have already resolved every flagged row, so the resolver and the UI never disagree.

**(B) Replace-not-merge with a PROVENANCE-TAGGED item model (kills the stale-state bug AND the data-loss vector Gemini-CRITICAL flagged — v2).** The earlier draft computed `next = (current − previousExtracted) ∪ newExtracted` by **string-value identity**. Gemini's holistic pass proved this silently destroys a user-typed item whose string equals an extracted one (e.g. the user re-affirms "Texas" via a dynamic question, then changes the topic → the manually-confirmed "Texas" is subtracted as if it were the stale extraction). String-set subtraction cannot distinguish "extracted" from "hand-typed-identical." It is also internally inconsistent with `applyDynamicAnswers`, which keeps a plain union.

**Resolved model:** in FORM STATE ONLY, each of the four `userContext` arrays carries provenance items: `Array<{ id: string; value: string; source: "extracted" | "user" | "user_edited_extracted" }>` (`id = crypto.randomUUID()` at creation). Re-extraction becomes a deterministic, value-independent filter:

```
next = current.filter(it => it.source === "user" || it.source === "user_edited_extracted")
              .concat(newExtractedItems.map(v => ({ id: uuid(), value: v, source: "extracted" })))
```

This (a) never subtracts a user item, (b) removes ALL prior extracted items regardless of string drift (the original stale-URL complaint), (c) is order-independent so it needs no `previousExtracted` argument — which **obviates the race condition** Gemini raised as MAJOR (the flow no longer reads the pre/post `extractedContext` at all), and (d) makes the "from topic" badge `it.source === "extracted"` trivial and robust.

**Scope boundary (divergence from Gemini's end-to-end object prescription):** the object model is **confined to form state + the editable UI**. `onSubmit` serializes every `userContext` array back to `string[]` (`.map(it => it.value)`) BEFORE POST, so the `/api/queue` wire contract, `researchJobPayloadSchema`, the `research_queue.user_context` jsonb shape, and the worker's `string[]` consumption are **unchanged**. Provenance is a UI concern; persisting it to the wire would escalate this into a DATA/ARCHITECTURE change touching `agent/` — explicitly out of scope. This keeps the change frontend-only and reversible.

**(C) Upstream sanitation (kills over-capture at the source).** The extract-context route validates+normalizes `additionalUrls` before returning, so nothing invalid ever enters `extractedContext`. This also means (A) rarely has to flag an *extracted* row — only user-typed ones.

These three are layered defense: even if the route's sanitizer (C) misses an edge, the state model (B) keeps re-extraction honest, and the per-item UI (A) gives the user a fix path. No single layer is load-bearing alone.

---

## 3. Design decisions (open questions resolved — recommendation-first)

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D1 | Edit inline on Review vs route to Customize? | **Primary editable surface = Customize** (new "Research Context" fieldset); Review keeps remove-only as the final safety. | Customize is the existing "fine-tune" step and already carries the `PreFilledHint` extraction-provenance idiom. Review stays a confirmation screen. Adding full edit to *both* doubles surface for little gain. |
| D2 | What does "save" mean in react-hook-form? | **No explicit save** — edits write to form state immediately via `Controller`-bound components (`onChange → field.onChange`), mirroring the existing `TagInput` usage on Customize. | Consistency with the established `emphasis`/`priorities` TagInput pattern; avoids a divergent dirty-buffer model. |
| D3 | Validate where? | **Live per-item (onChange) for display** + **block advance at the Customize→next boundary** if any `additionalUrls` item is invalid + keep the final Submit resolver. The user is **never wedged**: every row on the editable surface has an inline remove control, so a value invalid-per-UI is always reachable to fix or drop. | Immediate feedback at the point of edit; a hard gate one step before Review so a bad URL can't reach the (now-thin) Review screen. |
| D4 | Preserve the "from topic" badge after an edit? | **v2 (Gemini-MINOR integrated):** editing an `extracted` item flips its `source` to `user_edited_extracted` and renders a MODIFIED badge ("from topic · edited"), NOT a bare drop. A brand-new typed item is `source:"user"` (no badge). | The provenance model makes this free; distinguishes "corrected a topic-derived URL" (still topic-rooted) from "added something new," which a bare badge-drop conflated. |
| D5 | Change the submit-time Zod preprocess? | **Keep preprocess but make it NON-DROPPING for normalization only** at the boundary the UI owns; the *display* validator is the per-item function in (A). The submit Zod retains its drop (belt-and-suspenders) **because the dynamic-question free-text split still feeds prose tokens** ([useNewResearchForm.ts:299-312](../frontend/hooks/useNewResearchForm.ts#L299)). | Removing the submit-time drop would let prose tokens from the question-answer split block Submit — that filter is load-bearing for a *different* input path. Per-item display validation does not depend on it. |
| D6 | Also fix on a Context step vs only Customize? | **Only Customize** (no separate Context step exists; the 4 arrays live under `userContext`). | Minimal surface; no new step in `FORM_STEPS`. |

---

## 4. Implementation plan (right now → build order — v2)

1. **Shared URL helper (foundation) — SEMANTICS-PRESERVING (Codex MAJOR-4).** New `frontend/lib/url-normalize.ts`: `normalizeUrlCandidate(raw): string | null` with the **scheme split the shipped code already relies on**: (a) if `raw` already has an `http(s)://` scheme, accept it iff `z.string().url().max(2000).safeParse(raw)` passes — **do NOT apply the alphabetic-TLD test to schemed URLs** (that would wrongly reject `http://localhost:3000`, `https://127.0.0.1/a`, currently accepted at `validate.ts:64,82`); (b) only for scheme-LESS candidates: trim, strip trailing punctuation `.,;:)]}>"'`, require a real alphabetic-TLD bare domain, prepend `https://`, then re-validate with `z.string().url().max(2000)`; else null. Plus `isValidUrlItem(raw): { ok; normalized; message? }` for per-item UI status — **enforcing the SAME `.max(2000)`** so the UI never green-lights a URL that fails only at final submit. The route, the submit preprocess, the question-split, and the UI all import it — retires the three divergent copies (`validate.ts` preprocess, `useNewResearchForm.ts` `isUrlish`, `StepReview.tsx` `normalizeUrl` — note `normalizeUrl` is **display-href only**; the helper's prepend-https path covers it). *Why first:* one canonical rule (the S152 bug was three drifting heuristics), and it must not regress the schemed-URL/localhost cases. ~30 min.
2. **Defect 1 — route sanitizer.** In `extract-context/route.ts`, after `generateObject`, map `result.object.additionalUrls` through `normalizeUrlCandidate`, dropping nulls, before returning. Nothing invalid leaves the route. ~15 min.
3. **Provenance item model (form-state only).** Add a form-internal type `ContextItem = { id; value; source }` and a **separate** `formUserContextSchema` (objects) distinct from the wire `userContextSchema` (strings) in `validate.ts`. Update `formDataSchema.userContext` → objects; `FORM_DEFAULT_VALUES` → empty object arrays. *Boundary:* `researchJobPayloadSchema` and `extractedContextSchema` stay `string[]`. ~30 min.
4. **Defect 2 — replace-not-merge on the provenance model (UNCONDITIONAL — Codex MAJOR-2).** Rewrite `applyExtractedContext` to replace each array **outside the old `if (ec.field?.length)` guards** (those guards at `useNewResearchForm.ts:185/190/195/200` would let a topic-change-to-no-URLs `null`/`[]` skip replacement, leaving stale extracted items): `current.filter(it => it.source !== "extracted").concat((ec.field ?? []).map(asExtractedItem))` for each of the four arrays. **Retire `pruneStaleExtraction` (`:164-182`) entirely** AND its `previousEC` call (`:231-232`); the filter subsumes both, no `previousEC` read → no race. Update `applyDynamicAnswers` (`:274-340`): a user answer pushes `{source:"user"}`; **if its value matches an existing `extracted` item, PROMOTE that item to `user_edited_extracted` instead of skipping it as a dup (Codex MAJOR-3)** — otherwise a user re-affirming an extracted value leaves the only item `source:"extracted"`, which the next re-extraction drops. ~35 min.
5. **Boundary adapters — clone-load, sessionStorage restore, submit serialization (Codex CRITICAL-1).** One shared `toFormUserContext(raw): FormUserContext` adapter that accepts BOTH legacy `string[]` and new `ContextItem[]` per array (string → `{id:uuid(), value, source:"user"}`; object → passthrough), generates ids, and **preserves the `publishRequired` boolean** (NOT an array — must not be swept into the object refactor). Use it at: (a) clone `form.reset` (`:78-94`), (b) **the sessionStorage draft restore at `:116-120`** — the shipped miss: pre-v2 drafts hold `string[]` and would otherwise render `item.value === undefined` / serialize `null`. (c) In `onSubmit` (`:407-420`), serialize each array `.map(it => it.value)` back to `string[]` before building the payload, and re-attach `publishRequired`. Bump the draft `STORAGE_KEY`/add a version field so future drafts are unambiguous. ~30 min.
6. **Defect 3 — editable Research Context on Customize.** New fieldset: editable list for `additionalUrls` (per-item live validation via `isValidUrlItem`, inline error, edit-in-place + remove) and the 3 text arrays (add/edit/remove). Render the v2 badge by `it.source`. Bind via `Controller` on the object arrays. ~70 min.
7. **Defect 3 — step-boundary gate.** In `goNext` leaving `customize`, block advance if any `additionalUrls` item fails `isValidUrlItem`; surface the failing rows inline (each row already has a remove control, so the user is never wedged — D3 below). ~20 min.
8. **StepReview adaptation.** `fromTopic` detection now reads `it.source` (not a value-Set); remove buttons operate on object arrays by `id`. ~15 min.
9. **Tests** (`node --test`, frontend suite): URL helper drops `v1.1`/trailing-dot & passes real URLs; route sanitizer integration; replace-not-merge preserves a `user` item whose value equals an `extracted` one (the Gemini data-loss counterexample) and drops stale extracted on re-extraction; clone-load + submit round-trip `string[]`↔objects; per-item validator status. ~50 min.

---

## 5. Risk / blast radius

- **Reversible:** pure frontend (`frontend/`), no schema/migration, no agent/worker, no auth path. A bad deploy is a `git revert` + Vercel redeploy.
- **No new dependencies.**
- **One shared-helper extraction** (`url-normalize.ts`) touches three existing call sites — covered by the grep guard? No (that guard is storage-paths). Covered by `tsc --noEmit` + the new unit tests.
- **Edge to watch (for reviewers):** the dynamic-question free-text split path (Defect-5/D5) must keep working after the helper consolidation — prose tokens still drop, real URLs still pass.

---

## 6. What each reviewer should attack
- **Gemini (holistic-adversarial):** Is the per-item-validation + replace-not-merge model internally consistent across all four `userContext` arrays and both input paths (extraction + dynamic-question split)? Any state path where an extracted item can resurrect, or where D5's retained submit-drop re-introduces the index mis-map? Is "edited item loses badge" (D4) acceptable UX or a silent provenance loss?
- **Codex (grounded-adversarial):** file:line — does the v2 provenance-filter `applyExtractedContext` actually preserve a `user`/`user_edited_extracted` item across re-extraction (Gemini's data-loss counterexample)? Run the AES counterexample (`v1.1`, trailing-dot domain) through the new route sanitizer + `isValidUrlItem`. Does the `string[]`↔`ContextItem[]` boundary hold at BOTH adapters (clone-load in, onSubmit out) with no field where objects leak to the wire or strings leak into the editable UI? Does retiring `pruneStaleExtraction` orphan any caller? Does the `formUserContextSchema`(objects) vs `userContextSchema`(strings) split break the shared `FormData`/`researchJobPayloadSchema` type inference anywhere?

---

## 7. Review-integration log

### Round 1 — Gemini (holistic-adversarial), 2026-06-21, model `gemini-2.5-pro` via SDK → **VERDICT: BLOCK** (integrated → v2)
- **CRITICAL — string-identity replace-not-merge causes data loss + cross-path inconsistency.** A user-typed item equal in value to an extracted item is silently subtracted on re-extraction; the extraction path and `applyDynamicAnswers` would treat identical inputs differently. **Integrated:** §2(B) v2 — provenance-tagged `ContextItem { id, value, source }` model in form state; re-extraction = value-independent filter; serialize to `string[]` at submit (scope-confined, divergence from Gemini's end-to-end prescription, rationale recorded).
- **MAJOR — state-update race: "previous" extracted set read after overwrite.** **Integrated/obviated:** the v2 filter never reads `previousExtracted` (`source`-based), so the race cannot occur; `pruneStaleExtraction` retired.
- **MINOR — edited item silently loses provenance badge.** **Integrated:** D4 v2 — `user_edited_extracted` source + modified "from topic · edited" badge.
- What Gemini saw: design doc v1 + all 5 changed source files (full bodies, inline).
- Verbatim critique: `Documentation/research-form-context-extraction-ux-merge-gate-peer-review.md`.

### Round 2 — Codex (grounded-adversarial) on integrated v2, 2026-06-21, `codex exec -s workspace-write` → **VERDICT: BLOCK** (all integrated → v3-FINAL)
Codex confirmed the v2 provenance architecture as sound and flagged four integration-completeness gaps (no architecture rejection):
- **CRITICAL — sessionStorage restore is a missed `string[]`→`ContextItem[]` boundary** (`:116-120`). Plan covered clone-load but not draft restore; pre-v2 drafts hold `string[]`. **Integrated:** plan §4.5 — one shared `toFormUserContext()` adapter for clone AND draft restore, accepts legacy strings + new objects, preserves `publishRequired`, versions drafts.
- **MAJOR — re-extraction must replace even when the new field is `null`/`[]`** (guards at `:185/190/195/200`). **Integrated:** plan §4.4 — unconditional replace outside the guards.
- **MAJOR — dedup-by-`.value` can fail to promote a user-confirmed extracted item** (`:284-318`). **Integrated:** plan §4.4 — promote matching `extracted`→`user_edited_extracted` on user action instead of skipping as dup.
- **MAJOR — shared URL helper not semantics-preserving**: alphabetic-TLD rule wrongly rejects schemed `localhost`/IP; `.max(2000)` omitted. **Integrated:** plan §4.1 — TLD test scheme-LESS only; keep schemed URLs that pass `z.string().url().max(2000)`; UI helper enforces same max.
- **INFO — `null` vs `[]` in extract-context**: sanitize only `additionalUrls`; state layer treats both as empty new set (covered by MAJOR-2 fix).
- What Codex saw: design v2 + all 5 source files (read in its workspace sandbox) + `tsconfig`/`generate-questions/route.ts` (grounded file:line).

**Convergence:** both reviewers BLOCKED their respective version; every finding integrated. Gemini validated the *need* for provenance; Codex validated the *model* and closed the change-site gaps. Design is **v3-FINAL** — cleared to build. No third round required (no hard risk labels; remaining items were plan-completeness, now closed).
