# Clone & Edit (v2 Regeneration from Saved Brief) — Design (S35)

**Status:** CE-1 + CE-2 SHIPPED S35 (2026-05-11). CE-3 (worker daemon Studio-only mode) DEFERRED — see CE-3 deferral note at the bottom.
**Author:** S35 (2026-05-11).
**Background:** During the S35 CAM AI v4 regeneration (audio + video), the operator had to manually reconstruct the original form values from notebook state and prior state.json files in order to write the NLM Studio CONSTANTS. The proper user-facing flow is: load the original brief back into the wizard, let the user edit specific fields, resubmit. This doc describes that flow.
**Owner files (when implemented):** Listed per phase.

---

## Why this exists

The current form takes 7 wizard steps and ~10-15 minutes of typing to fully populate. When the operator notices a flaw in a v1 deliverable (e.g., stale-future-tense April-2026 framing on CAM AI v3 audio, S35), the only available re-run path today is:

1. Manually open the gallery, copy out values from memory
2. Open a fresh form
3. Retype all 7 steps from scratch, hoping the only-thing-that-changed is correct
4. Submit a "new" run that produces a brand-new slug — no lineage to the original brief
5. Gallery now shows two unrelated runs for what is conceptually the same brief with a tweak

This is wasteful, error-prone, and breaks the audit trail. Clone & Edit replaces it with a single button: **"Clone & Edit this run."**

---

## Goals (v1)

- One-click "Clone & Edit" action on the gallery and run-detail pages.
- New form is pre-filled with EVERY field from the parent run's manifest (topic, persona, queryFraming, jobDescription, all `domainKnowledge[i]`, all `constraints[i]`, all `customizations.*`, all `vendorEvaluation.*`, all `selectedProducts.*`).
- User edits only what they want, hits submit. Cost-of-iteration drops from ~15 min retyping to ~30 seconds of edits.
- New run is **linked to its parent** via `parent_run_id` so the gallery can show lineage ("Cloned from `cam-ai-...-u9el`").
- The clone runs against the **same NLM notebook** (find-or-create reuses it per S30 Phase 0 design) — so artifacts land as v2/v3/v4/... of the same products, automatically picked up by the gallery N-version dropdown.

## Non-goals (v1)

- **No in-place edit of v1.** Cloning preserves the parent as an audit trail. Rollback = "go look at the parent." Sidesteps the "I edited the brief but the old PDFs still say the old thing" inconsistency.
- **No per-field diff view** showing user what they changed vs. parent. Defer to v2 if asked.
- **No partial-product regen UI** (e.g., "just re-do the audio"). v1 ships both granularities (full pipeline vs. studio-only) as a single radio toggle on the review step; per-product is a v2 enhancement.
- **No edit history beyond parent_run_id.** Multi-hop lineage (clone of clone of clone) works mechanically but the UI only surfaces the immediate parent. Deeper threading defers to v2.

---

## Architecture

### Backend

| Component | Change |
|---|---|
| `research_queue` table | Add column `parent_run_id UUID NULL REFERENCES research_queue(id) ON DELETE SET NULL`. Backfill is no-op (existing rows have NULL parent). |
| `GET /api/runs/<slug>/manifest` | NEW endpoint. Returns the full form payload (everything the form wizard needs to pre-fill). Sourced from the state.json `customizations` / `userContext` / `vendorEvaluation` / `selectedProducts` blocks plus the queue row's `topic`. Auth-gated (org-aware per multi-tenancy Phase A). |
| `POST /api/queue/submit` | Accept optional `parent_run_id` in body. If present, the new row stamps it. No other validation change — the form payload is validated identically to fresh submissions. |
| Worker daemon | No change. Phase 0 find-or-create reuses notebook by topic-title match (per S30). v2 artifacts land in the same notebook. NLM Studio versioning picks them up as v2/v3/... automatically. |

### Frontend

| Component | Change |
|---|---|
| `app/runs/[slug]/page.tsx` + gallery page | Add "Clone & Edit" button in the header action bar. Navigates to `/new?clone=<slug>`. |
| `app/new/page.tsx` (form wizard) | On mount, check `searchParams.clone`. If present, fetch `/api/runs/<clone>/manifest`, pre-fill all 7 steps via the existing form state, show a banner: "Cloning from {parent topic} — edit any field and submit to create v2." |
| `app/runs/[slug]/page.tsx` | If row has `parent_run_id`, show "Cloned from `<parent_slug>`" badge with a link back. |
| Review step (Step 7) | Add radio: **"Re-run full pipeline (deep research + Studio)"** [default, ~1-2hr] vs. **"Re-generate Studio products only (use existing notebook)"** [~20-30min, cheap]. Worker reads this from the manifest and either runs Phase 0→7 or jumps straight to Phase 5 (Studio generation) against the existing notebook. |

### Worker daemon — pipeline-skip mode

When the manifest carries `pipeline_mode: "studio_only"`:
1. Phase 0 find-or-create finds the existing notebook (must succeed — fail loudly if the parent's notebook was deleted).
2. Skip Phases 1-4 (deep research, source import, comparison).
3. Jump to Phase 5 (Studio generation) with the new customizations.
4. Phase 5.5b post-Studio reconcile still runs (per S30 workflow-conventions-enforcer design).
5. Phase 7 (upload + lint gate) runs.

This is the cost-saver case — when the research is fine but the framing needs adjustment (exactly the S35 CAM AI scenario). Cuts a $10-15 run down to ~$2-4 and ~25-30 min.

---

## Cost discipline

| Mode | Time | Approx cost | Use case |
|---|---|---|---|
| Full pipeline regen | 1-2 hr | $5-15 | Source set is stale; need fresh Perplexity/NLM research |
| Studio-only regen | 20-30 min | $1-3 | Research is fine; only deliverable framing needs tweaks |

v1 quota (post-multi-tenancy): soft warning at 3 clones/24hr per org, hard cap at 10 clones/24hr per org. Numbers tunable; defaults pulled from S31 multi-tenancy design's $5/day org budget assumption.

Today (operator-only, pre-multi-tenancy): no quota, but log every clone to `enhancement_log` analogue (`clone_log`?) for post-hoc cost attribution when multi-tenancy lands.

---

## Sequencing relative to other planned work

| Order | Item | Why this order |
|---|---|---|
| **Pre-req** | Multi-tenancy Phase A (Supabase Auth + RLS) | Without auth, anyone with a slug guess can clone any run — same data-leak as the deferred adversarial #5. Phase A's `auth.uid() ∈ organization_members(org_id)` gate must cover the manifest endpoint. |
| **Then** | **Clone & Edit (this design)** | Naturally extends the existing form — minimal new surface. Provides immediate value (zero retyping for tweaks). |
| **Then** | Prompt enhancement Part 2 + Floating chat assistant Part 4 | These both operate on the form fields, so Clone & Edit makes them more valuable (user can clone a brief, enhance individual fields, then ask the chat to refine). |

This sequencing means Clone & Edit ships **after** multi-tenancy F (invite CLI) and **before** prompt enhancement G — slotting cleanly between the trilogy's auth foundation and its prompt-quality layer.

---

## Phases

| Phase | Work | Effort | Status |
|---|---|---|---|
| **CE-1** | Backend: schema migration (`parent_run_id`), `GET /api/runs/<slug>/manifest` endpoint, accept `parentSlug` in submit | 0.5 day | **SHIPPED S35** |
| **CE-2** | Frontend: "Clone & Edit" button + `?clone=<slug>` query handling in form mount + banner | 0.5 day | **SHIPPED S35** (lineage badge deferred — see below) |
| **CE-3** | Worker: `pipeline_mode: "studio_only"` skip-to-Phase-5 path. Studio-only mode also gets its own `workflow-conventions-enforcer` Phase 0 check (must find existing notebook — fail loudly if not) | 0.5 day | **DEFERRED** |

Total: 1.5 days. CE-1 + CE-2 took ~1.5hr S35.

### What landed in S35

| File | Change |
|---|---|
| `supabase/migrations/20260511-clone-and-edit-parent-run-id.sql` | NEW. `ALTER TABLE research_queue ADD COLUMN parent_run_id UUID NULL REFERENCES research_queue(id) ON DELETE SET NULL` + partial index. **Operator must apply via Supabase Studio SQL Editor before Clone & Edit submits will succeed.** |
| `frontend/lib/validate.ts` | Added `parentSlug` (optional, max 120 chars) to `researchJobPayloadSchema`. |
| `frontend/app/api/queue/route.ts` | POST resolves `parentSlug` → row id via `.maybeSingle()`, stamps `parent_run_id` on insert. Unknown slug = silent treat-as-fresh (don't fail the user's brief over a stale lineage pointer). |
| `frontend/app/api/runs/[slug]/manifest/route.ts` | NEW. Returns the form-shaped payload sourced from state.json, runtime fields stripped, `aji_dna_enabled` snake-cased back to `ajiDnaEnabled`. |
| `frontend/app/runs/[slug]/page.tsx` | Added "Clone & Edit" link in header that navigates to `/new?clone=<slug>`. |
| `frontend/hooks/useNewResearchForm.ts` | Reads `searchParams.clone`; if present fetches manifest, `form.reset()`s with it, exposes `cloneSlug`, `cloneTopic`, `isLoadingClone`, `cloneError`. On submit stamps `parentSlug` if cloning. SessionStorage restore preserved for non-clone path. |
| `frontend/app/new/page.tsx` | Wrapped in Suspense (`useSearchParams` requirement in Next 16). Added Clone banner with three states: loading, error, loaded-with-lineage. Page title flips to "Clone & Edit" when cloning. |

Validation: `pnpm exec tsc --noEmit` exit 0 on the frontend post-changes.

### CE-3 deferral rationale

The original design assumed Studio-only mode would be a small worker patch — "branch on `manifest.pipeline_mode` and skip to Phase 5." Reality is more complex:

1. **The slash command (`~/.claude/commands/research-compare.md`) is operator-config, not in the repo.** Adding a `pipeline_mode` branch to a 1010-line natural-language prompt is non-deterministic — slash commands interpret instructions and behavior varies between Claude versions. This is exactly the workflow-drift class that `feedback_workflow_drift_layer_3_gap.md` warns about.
2. **The clean implementation is a separate code path: `agent/scripts/regenerate-studio-products.ts`** — a deterministic TypeScript script that takes a notebook ID + manifest, calls NLM CLI directly for each selected product with the customizations from the manifest, downloads, uploads. Bypasses Claude entirely for the Studio-only case. This is genuinely 0.5-1 day of careful work.
3. **The S35 worker daemon is still on pre-S34 code (PID 60148, 3-day uptime).** Any worker changes require a restart, which we deferred to keep the active CAM AI fix-pass stable.

**Today's user-visible behavior:** Clone & Edit always runs the full pipeline. Cost = $5-15, time = 1-2hr per clone. That's the same cost as a fresh submission today — the win for users is "no retyping," not "cheaper regen yet." The cheaper Studio-only path comes in the follow-up.

**CE-3 acceptance criteria (record for next session):**
- `agent/scripts/regenerate-studio-products.ts` — given a notebook_id + selectedProducts + customizations, calls `notebooklm generate <type>` for each selected product with the customizations rendered as PERSONA/PRIORITIES/GOALS/CONSTANTS (per `feedback_nlm_artifact_customization_structure.md`), waits via `artifact poll`, downloads with positional OUTPUT_PATH (per S35 bug), uploads to Supabase with conventions-compliant filename.
- Worker daemon's `executor.ts` reads `pipeline_mode` from the queue row; if `studio_only`, spawns the script instead of Claude.
- Form review step gets a radio: "Full pipeline" (default) vs. "Studio products only" (cheaper, faster).
- workflow-conventions-enforcer gets a `phase-0-existing-notebook` check that fails loudly when Studio-only mode can't find the parent's notebook.

---

## Open questions

1. **Manifest field shape — single payload or per-step?** Form wizard is 7 steps; manifest endpoint could return either a flat object (simple, mirrors current submit payload) or step-grouped object (cleaner UI mapping). **Recommendation: flat object — same shape as the existing submit endpoint accepts, so frontend can `setFormState(manifest)` in one call.**
2. **Clone-of-clone naming.** If user clones run A → A2, then clones A2 → A3, should A3's slug suffix reflect lineage (`...-u9el-c2-c3`) or be a fresh slug with a parent pointer? **Recommendation: fresh slug with parent_run_id pointer. Don't encode lineage in the slug.**
3. **Studio-only mode + selectedProducts changes.** What if the user clones with `pipeline_mode: studio_only` but flips a product from `false` to `true` that wasn't generated in the parent? E.g., parent had `infographic: false`, clone has `infographic: true`. Studio-only mode against existing notebook generates the missing product. **Recommendation: this is fine — NLM Studio can generate any product against a notebook regardless of what was generated before. v1 just needs to enumerate selectedProducts and call generate for any that don't have a v(n)+1 yet.**
4. **What if the parent's notebook was deleted (operator cleanup or user delete)?** Studio-only mode is blocked. Full-pipeline mode is fine — Phase 0 just creates a fresh notebook. **Recommendation: Phase 0 in studio-only mode does a hard fail with an inline message: "Parent notebook deleted — re-run with full pipeline instead." UI surfaces the choice.**
5. **Allow editing immutable fields?** Topic-slug is derived from topic field — if user edits topic, slug changes. New row gets new slug. Is this confusing? **Recommendation: yes, slug regenerates from new topic. Lineage badge is the relationship; slug is the identity. Document this in the UI: "Editing the topic creates a new entry in your gallery."**

---

## Cross-references

- `Documentation/multi-tenancy-and-prompt-enhancement-design.md` — Part 1 (multi-tenancy) is the auth pre-req; Part 2 (enhance-field) operates on form fields and gets more valuable with Clone & Edit; Part 4 (chat assistant) sees the cloned form state.
- `Documentation/workflow-conventions-enforcer-design.md` — Phase 0 find-or-create check must succeed for studio-only mode. The enforcer should add a `clone-and-edit-notebook-resolution` check that runs only when `pipeline_mode: "studio_only"`.
- `feedback_date_aware_constants_every_artifact.md` — Clone & Edit makes date-aware CONSTANTS reusable across clones (the CONSTANTS section of each customization is preserved in the manifest and re-fed to the same NLM Studio prompts).
- `Projects/cam-ai-program-applications-in-the-quick-u9el/` — the run that motivated this design. S35 audio v4 had to be regenerated by re-deriving the original manifest manually; Clone & Edit would have made this a 30-second user action.

---

## Out of scope (explicitly recorded so we don't lose them)

- **Per-prompt enhancement during clone.** "Clone, then enhance each field with ✨" requires Part 2 (enhance-field) to already be shipped. Clone & Edit can stand alone but the combination is the real power-user flow.
- **Diff view (parent vs. clone).** Useful for "what did I actually change?" reviews but adds significant UI surface. v2.
- **Suggested edits.** "AI thinks you should tweak X based on the v1 deliverable's reception." Requires a feedback signal we don't yet capture. Future research.
- **Branching workflow.** "I want to compare three different framings of the same brief side-by-side." Achievable today by cloning three times with edits, but a dedicated UI for branch comparison is v3.
