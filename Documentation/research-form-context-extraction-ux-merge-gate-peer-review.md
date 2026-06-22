# Research-Form Context-Extraction UX — MERGE-gate peer review

Companion to `research-form-context-extraction-ux-design.md` (DR S153, 2026-06-21).
Topology: sequential **Gemini (holistic-adversarial) → integrate → Codex (grounded-adversarial) on v2**.
What each reviewer saw is recorded per round.

---

## Round 1 — Gemini holistic-adversarial (model `gemini-2.5-pro` via @google/genai SDK)

**Saw:** design doc v1 + full bodies of `extract-context/route.ts`, `useNewResearchForm.ts`, `validate.ts`, `StepReview.tsx`, `StepCustomize.tsx` (inline in packet).
**Verdict:** BLOCK.

### CRITICAL — Unsafe "replace-not-merge" logic causes data loss and is inconsistent across input paths.
The `next = (current − previousExtracted) ∪ newExtracted` model operates on string value identity, not stable provenance. It cannot distinguish a machine-extracted item from an identical hand-typed one. Attack path: user extracts "Texas" (constraint) → re-affirms "Texas" via a dynamic question → changes topic to "Florida" → re-extraction subtracts "Texas" (matches `previousExtracted`) and the user's manually-confirmed constraint is silently destroyed. Also internally inconsistent: extraction path subtracts-then-unions while `applyDynamicAnswers` (~line 299) keeps a plain union — two parts of the app treat identical inputs differently.
**Fix:** upgrade the four `userContext` arrays to `Array<{ id; value; source: 'extracted' | 'user' }>`; re-extraction becomes `current.filter(i => i.source !== 'extracted').concat(newExtracted)` — unambiguous, no data loss, badge = `source === 'extracted'`.

### MAJOR — "replace-not-merge" vulnerable to a state-update race.
If the consolidated `applyExtractedContext` reads `extractedContext` from form state to get the "previous" set, it reads the NEW value already set at `useNewResearchForm.ts:248`, so the subtraction preserves stale items. Current code avoids this by passing `previousEC` directly into `pruneStaleExtraction`; the rewrite must pass `previousEC` explicitly — OR adopt the CRITICAL object model, which obviates the dependency entirely.

### MINOR — "edited item loses its badge" has a subtle UX flaw.
Dropping the badge on edit fails to distinguish an *edited extracted item* (e.g. typo fix `gogle.com`→`google.com`) from a *brand-new user item*. **Fix:** add `source: 'user_edited_extracted'`; render a distinct modified-badge state.

**Resolution:** all three integrated into design v2 (§2B / D4 / plan). Divergence: the object model is confined to FORM STATE and serialized to `string[]` at submit, keeping the wire contract / DB jsonb / worker unchanged (avoids escalating to a DATA/ARCHITECTURE change). The MAJOR is obviated because the v2 filter is `source`-based and never reads the previous extracted set.

---

## Round 2 — Codex grounded-adversarial on integrated v2 (`codex exec -s workspace-write`)

**Saw:** design v2 + all 5 source files (read in its sandbox) + `frontend/tsconfig.json` + `generate-questions/route.ts` (grounded file:line pass).
**Verdict:** BLOCK — architecture confirmed sound; four integration-completeness gaps. All integrated → v3-FINAL.

### CRITICAL — `sessionStorage` restore is a missed `string[]`→`ContextItem[]` boundary.
`useNewResearchForm.ts:116-120` does `JSON.parse(saved); form.reset(parsed)` with no migration. Pre-v2 drafts hold `userContext.additionalUrls: string[]`; v2 components expect `{id,value,source}[]`. A restored legacy draft renders `item.value === undefined` and `.map(it=>it.value)` serializes `null`, dropping the user's explicit URL. Plan covered clone-load (`:78-94`) but missed draft restore.
**Fix:** one `toFormUserContext()` adapter for BOTH clone manifests and saved drafts; accept legacy strings + new objects; generate ids; legacy → `source:"user"`; preserve `publishRequired`; version future drafts. → **Integrated, plan §4.5.**

### MAJOR — re-extraction must run the provenance filter even when the new extraction field is `null`/`[]`.
If implemented inside the existing guards (`:185/190/195/200`), a topic change to a no-URL topic returns `null`/`[]`, the guard skips, and stale extracted items survive.
**Fix:** unconditional `current.filter(i=>i.source!=="extracted").concat((ec.field ?? []).map(asExtractedItem))`; retire `pruneStaleExtraction` (`:164-182`) + `previousEC` (`:231-232`). → **Integrated, plan §4.4.**

### MAJOR — "dedup by `.value`" can fail to promote a user-confirmed extracted item.
`current=[{value:"Texas",source:"extracted"}]` + a user answer/edit of `"Texas"` gets skipped as a dup, leaving the only item `source:"extracted"` → dropped on next re-extraction, violating the "user survives topic change" invariant.
**Fix:** promote the matching item to `user_edited_extracted` on a user action (or keep a separate `source:"user"` dup + collapse by source priority). → **Integrated, plan §4.4.**

### MAJOR — the shared URL helper as specified is not semantics-preserving.
The "host has a real alphabetic TLD" rule would reject explicit `http://localhost:3000/foo` and `https://127.0.0.1/a`, which schemed URLs currently accept (`validate.ts:64,82`). Helper spec also omits the existing `.max(2000)`; a 2100-char valid URL passes the UI helper then fails only at submit.
**Fix:** alphabetic-TLD check on scheme-LESS candidates only; keep schemed URLs that pass `z.string().url().max(2000)`; UI helper enforces the same max. → **Integrated, plan §4.1.**

### INFO — sanitizing only `additionalUrls` in extract-context is correct, but `null` vs `[]` still matters to state replacement.
`generate-questions` treats `null` and `[]` identically (non-empty length check); the state layer must treat both as "empty new extracted set" and clear prior extracted items. → covered by MAJOR-2 fix.

**Convergence:** both reviewers BLOCKED their respective version; all findings integrated. Gemini validated the *need* for provenance, Codex validated the *model* and closed the change-site gaps. Design is **v3-FINAL**, cleared to build.
