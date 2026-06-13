# S120 Tomorrow Design-Plan — publish-flag coercion harmonization + validation + cleanup

**Author:** Claude (S119) · **Date authored:** 2026-06-13 · **Gate:** DESIGN (this plan) → routed sequential Gemini→Codex adversarial review.
**Context input:** `Documentation/s117-s118-retrospective.md` (today's shipped work + what the gates caught + what the author missed).

> **What each reviewer should review.** This is a FORWARD plan. The individual code changes it proposes are NOT yet written — each will get its OWN MERGE gate when implemented. Review the *plan*: is the design sound, is the direction-of-safety correct, is the scope right, what's missing, what would BLOCK it. Gemini = holistic-adversarial breadth ("strongest case to BLOCK the whole plan"); Codex = grounded-adversarial depth (file:line against the shipped code on the integrated v2).

---

## Item 1 (DESIGN CORE) — `publishRequired` coercion harmonization

### 1.1 Problem statement
The same logical field `publishRequired` (the MRPF PUBLISH gate trigger) is coerced with **three different semantics** at different read sites. This is the same fail-open CLASS as the S118 Codex C1 catch (silent clone downgrade), but reached via coercion mismatch instead of field omission.

Grounded site inventory (verified against working tree, 2026-06-13):

| Site | Current coercion | Semantics |
|---|---|---|
| `agent/lib/publish-gate.ts:122` `truthyFlag` | `v===true \|\| (string && trim/lower==="true")` | **lenient** — accepts `true`, `"true"`. NOT `"on"`, `"1"`. |
| `agent/lib/publish-gate.ts:135` `isPublishRequired` | `truthyFlag(job) \|\| truthyFlag(state)` | lenient OR (fail-closed) |
| `agent/executor.ts:553,945` gate-engage | `isPublishRequired(job, null)` | lenient ✓ |
| `agent/executor.ts:810` manifest WRITE | `job.user_context.publishRequired === true` | **strict** ✗ |
| `agent/executor.ts:1087` | `job.user_context.publishRequired === true` | **strict** ✗ |
| `frontend/app/api/runs/[slug]/manifest/route.ts:163` clone-prefill | `uc.publishRequired === true` | **strict** ✗ |
| `frontend/app/api/runs/[slug]/replay/route.ts:140` replay-prefill | `uc.publishRequired === true` | **strict** ✗ |
| `frontend/components/new-research/StepReview.tsx:86,209` display | `!!userContext?.publishRequired` | JS-truthy |
| `frontend/lib/validate.ts:80` schema | `z.boolean().default(false)` | boolean (rejects non-bool at API boundary) |

### 1.2 The concrete defects
- **Defect C (fail-OPEN, CONFIRMED LIVE S119 — the priority fix) — clone reads the WRONG SOURCE FIELD.** The S118 C1 fix added `publishRequired: uc.publishRequired === true` to `manifest/route.ts:163`, but `uc = state.userContext` (line 142) — and the worker **never writes `publishRequired` into `state.json`'s `userContext` echo**. Verified against the live `state.json` of job `97906d8c`: top-level `publish_required: true` exists (the gate reads this), but `state.userContext` has keys `[contextFilePath, additionalUrls, claimsToVerify, domainKnowledge, constraints, localSourcePath, attachments, …]` with **no `publishRequired`**. So `uc.publishRequired === true` → `undefined === true` → `false` → **every clone of a publish parent silently downgrades out of the gate.** The S118 C1 fix is a NO-OP against real runstate. **Fix:** the manifest route already queries the `research_queue` row for attachments (lines 124-129) — read `publishRequired` from `parent.user_context` there (the authoritative DB source, matching the replay route's precedent), NOT from `state.userContext`. The **replay route is NOT affected** — `replay/route.ts:119` already reads `parent.user_context` from the DB row.
- **Defect A (fail-OPEN, latent) — coercion downgrade on stringified flag.** `validate.ts` Zod guarantees a clean boolean *only on the API submit path*. The jsonb `user_context` can also be written by direct DB inserts (the S116 `PATCH constraints` script path), LLM-written state, or future non-UI producers — bypassing Zod. If a publish parent stores `publishRequired: "true"` (string), `=== true` → `false` → downgrade. Once Defect C is fixed to read `parent.user_context`, this coercion edge re-applies at the new read site too — hence the harmonization (§1.4) must cover it.
- **Defect B (provenance lie) — manifest records the wrong flag.** `executor.ts:810` writes `publish_required: job.user_context.publishRequired === true` into the state manifest. If the job flag is string `"true"`, the gate (`isPublishRequired`, lenient) still engages, but the manifest field records `false` — untrustworthy for any consumer reading it directly. (Note: also a SECOND reason to populate `state.userContext.publishRequired` would be wrong — the fix is to read the authoritative source, not to add another echo that can drift.)

### 1.3 Latent defect (the deferred G2/C2 item) — `"on"` is not accepted
`truthyFlag` accepts `true`/`"true"` but NOT `"on"` (the value a raw HTML checkbox submits) or `"1"`. Today react-hook-form submits a boolean and Zod coerces, so `"on"` never reaches the gate — **not active**. But it is a latent fail-open: any future path that posts a raw checkbox (`"on"`) would read as NOT-required and silently skip the gate.

### 1.4 Proposed design — HYBRID: boundary-normalization + logging backstop (revised v2, Gemini F2/F3)
**Normalize to a strict boolean at every write boundary; keep a strict core predicate with a fail-closed, LOUD backstop at the gate.** This supersedes the v1 "broaden the predicate" approach — v1 chased producer quirks reactively into an ever-growing string set; the hybrid eliminates ambiguity at the source and turns the remaining fail-safe into an alarm.

1. **Boundary normalization (primary defense — clean the data before it is stored/passed).** At every write or data-shaping path, coerce `publishRequired` to a strict `boolean` using the canonical predicate, so stored/forwarded data is already clean:
   - `/api/queue` submit — Zod already does this (`z.boolean().default(false)`); keep, and confirm it is the *only* sanctioned external write path.
   - `manifest/route.ts` clone-prefill → **OR ALL AVAILABLE SOURCES through the canonical predicate (closes Defect C — Codex C1).** A single source is wrong either way: the route deliberately supports legacy **storage-only runs with no queue row** (`.maybeSingle()` → `data:null`, clone must still proceed; route comment ~116-121) — so DB-only downgrades a legacy publish parent (no row → false); and state-only is insufficient because shipped `executor.ts:810` can write `publish_required:false` for a DB string `"true"`. **Fix:** extend the existing `research_queue` select (lines 124-129) to include `user_context`, then prefill = `predicate(parent.user_context?.publishRequired) || predicate(state.publish_required)` (optionally also legacy `state.userContext.publishRequired`). `replay/route.ts:140` already reads `parent.user_context` (correct source) — route its coercion through the canonical predicate.
   - **Regression tests for Defect C (both legacy cases):** (i) DB `user_context.publishRequired=true` + `state.userContext` lacks the field → prefill `true` (exact runstate of job `97906d8c`); (ii) **`attachRow=null` (no queue row) + `state.publish_required=true` → prefill `true`** (the legacy storage-only case Codex C1 surfaced). Pin both so the no-op fix can never silently return.
   - `executor.ts:810` manifest WRITE → write `publish_required` seeded from the **canonical durable JOB-flag** predicate (Codex C6: `buildManifest` has only the job, no terminal state — so this records the seeded job decision, NOT a "full OR including state"; the OR semantics belong to the *completion* gate, not the write). Closes **Defect B**.
2. **Core predicate stays STRICT (Gemini F3).** Keep `truthyFlag` accepting only `true` and `"true"` (the LLM-stringification case, S108). **Do NOT add `"on"`/`"1"`/`"yes"`** — a raw-HTML-form path, if ever added, normalizes its `"on"` at its own endpoint (per #1), keeping the security core free of producer quirks. Export it as `isPublishFlagSet(v): boolean` for clarity; keep `isPublishRequired` as the OR-combiner.
3. **Logging backstop — placement corrected (Gemini F2 intent, Codex C2/C3 mechanics).** The Gemini "log on coercion" idea is sound but **cannot live in the predicate** — `isPublishFlagSet`/`isPublishRequired` are PURE and have neither a logger nor a `job.id` (Codex C2). And the dangerous case is NOT an accepted `"true"`; it is a **rejected** non-boolean (`"yes"`/`"on"`) that the strict core turns away, causing a SILENT gate-skip (Codex C3). So:
   - Keep the predicate pure.
   - Add a **diagnostic helper** (or callback-bearing wrapper) invoked from the executor/evaluate **call-sites that carry `job.id` + a logger** — the full path (`executor.ts:676`), studio path (`executor.ts:1002`), and DRY_RUN checks (`executor.ts:553`, `945`). It inspects the raw source value BEFORE the applicability early-return and emits `[SECURITY] job=<id> publishRequired source=<where> rawType=<type> rawValue=<…>` whenever a *present, non-boolean* value is seen — **especially one the strict core REJECTS** (the silent-skip alarm), not only one it accepts.
4. **Read sites unified — `executor.ts:1087` uses the FLAG-ONLY form (Codex C4, confirmed by inspection).** `buildPrompt()` runs BEFORE the child produces terminal state, so the publish-block injection must key off the durable job flag, not a later OR over state: `isPublishRequired(job, null)` (state=null collapses to the job flag). Today's strict `=== true` omits the block for a DB `"TRUE"` flag while the completion gate can still fire later — harmonize it. Add `publish-brief.test` coverage for string `"TRUE"` → block present. `StepReview.tsx:86,209` reads react-hook-form state (always a clean boolean via Zod) — display-only, NOT a coercion risk; harmonizing it is cosmetic.
5. **Mirror + STRONG parity enforcement (Gemini F1 + Codex C5).** The frontend cannot import from `agent/` (separate tsconfig roots) — mirroring is an **established, already-reviewed project pattern** here (`storage-paths.ts`, `untrusted-input.ts` pairs). Add `frontend/lib/publish-flag.ts` mirroring `isPublishFlagSet`. **Primary guard = a root test that IMPORTS BOTH real exports** (`agent/lib/publish-gate.ts` + `frontend/lib/publish-flag.ts`) and runs the same value matrix (`true/false/"true"/"TRUE"/" true "/"on"/"1"/"yes"/0/null/undefined/{}`) against the actual functions — behavioral parity on the live exports, NOT a text grep (Codex C5: byte-parity false-fails on formatting and misses divergence outside the compared body; the root tsconfig already sees both subprojects, so the cross-import test is feasible). A source/AST parity check is an OPTIONAL extra, not the primary safety net. See §1.7 for why the full shared-package refactor is deferred.
6. **Tests:** extend `publish-gate.test.ts` (pins `"true"`/`"TRUE"`/junk at 111-120) — assert `"on"`/`"1"`/`"yes"` are now REJECTED by the core (→ false, pinning the strict boundary) and that they are NORMALIZED to the right boolean at each write boundary. Add the clone-downgrade regression: parent jsonb `publishRequired:"true"` → manifest-route prefill yields `true`. Add a backstop-logging assertion: a non-boolean at the gate emits the `[SECURITY]` line.

### 1.5 Direction-of-safety analysis (reviewers will probe this)
- **Write boundaries (normalize) → produce a strict boolean.** A clone/replay of an ambiguously-truthy parent must yield `true` (preserve publish-required; user can uncheck) — never a silent downgrade. The manifest write records the effective gate decision, not a re-coercion.
- **Gate core (strict predicate + logging backstop) → fail CLOSED, and ALARM.** A stored `"true"` still fires the gate (fail-closed preserved), but the `[SECURITY]` log flags that a non-boolean reached the gate — i.e. a normalization boundary was bypassed. A false NEGATIVE = unverified run publishes / publish clone downgrades (the MRPF failure mode); a false POSITIVE = a non-publish run is gated, and worst-case a run that can't satisfy verification HARD-BLOCKS and fails.
- **Why strict core + boundary-normalize beats a broad predicate:** the broad-predicate v1 had to *guess* intent from a growing quirk list and would silently fail open on the first unanticipated value (`"1"`, `1`). The hybrid eliminates ambiguity at known write paths and makes any *unknown* write path LOUD rather than silently-coerced — converting "chase the next coercion bug" into "the alarm tells you which write path to fix."

### 1.7 Deferred (Gemini F1, recorded rationale) — shared-package refactor
Gemini's ideal remedy (extract a shared `common` package both `agent/` and `frontend/` import the predicate from) is **correct in principle but out of scope for this fix.** It is an ARCHITECTURE-labeled change touching both tsconfig roots + build/deploy (Vercel root-dir = `frontend/`, worker builds `agent/` separately) — a multi-file restructuring with its own DESIGN gate. The byte-identical source guard (§1.4.5) gives ~90% of the safety at ~5% of the risk for THIS change. **Recorded as a standalone backlog item:** "Extract shared `@dr/common` predicate package (ARCHITECTURE, DESIGN gate)."

### 1.6 Scope / gate
- **Touches `agent/` ⇒ worker restart required** (DR-Deploy pull + Stop/Start `DynamicResearchWorker`).
- **MERGE gate, Risk = AGENT BEHAVIOR (gate semantics), NORMAL.** Sequential Gemini→Codex. Frontend files via sandbox+promote.
- **Estimated size:** ~6 files, ~30 LOC net, +~6 tests. Half-session.

---

## Item 2 — First UI-flagged publish run end-to-end (VALIDATION)
- **Status at plan-authoring (S119):** IN PROGRESS. Job `97906d8c` submitted via the live UI with the Publish gate checkbox checked; Review step confirmed "Publish gate: Enabled". Plan-review APPROVED ($0.04); executor running. **The live outcome (gate hit / pass-or-block / clone-defaults-CHECKED) is appended to the retrospective at promote time — if it completed in S119 this item is DONE; if not, it carries as the first S120 verification.**
- **Remaining if not closed in S119:** confirm the worker reached the `publish_verification` gate; confirm a "Clone & Edit" of the run defaults the checkbox CHECKED (validates the S118 C1 fix live). No design content — pure validation.

## Item 3 — Cleanup (mechanical)
1. **Stale remote branches** — *[S119: DONE, only `main` remains].*
2. **DR-dev folder delete — USER action.** Quit Antigravity fully → `Remove-Item 'c:\Users\ceo\Documents\AI Training\Anti Gravity\DR-dev' -Recurse -Force`. Blocks nothing (worker on DR-Deploy; memory junctioned; dev branch deleted).
3. **Legacy flat-storage cleanup** auto-arms 2026-06-23 — verify the dated `phase-b-cleanup-legacy-storage-paths.ts` soak script fires; no action until then.
4. **MEMORY.md size** near the index cap — trim longest lines if it crosses.

## Item 4 — Dream top-4 remaining (each is its own small change)
1. **COST — `claude config set -g model sonnet` (GLOBAL).** Explicit user yes required (changes the default model for ALL projects, not just DR). Not a DR-repo change; no MERGE gate but high blast radius — confirm intent before running.
2. **WORKFLOW — extract `/end-session` secret-scan → `~/.claude/tools/secret-scan.sh`.** Reusable shared tool; `~/.claude/` is directly writable (outside sandbox enforcement). Small, no DR gate.
3. **SKILLS — `/codex-fallback` skill** (MRPF §1a Codex-quota API-key flip). `~/.claude/skills/` via `/edit-skill`. No DR gate.

---

## Sequencing recommendation (for S120)
**Right now (highest leverage):**
1. Item 1 coercion harmonization — the one change with real design + fail-open closure. MERGE-gated. ~half session.
2. Item 2 publish-run validation tail (if S119 didn't close it) — quick, gates Item 1's relevance.

**Next:** Item 4 Dream items (independent, small, no DR gate) — batch them.
**Later / user-gated:** Item 3.2 DR-dev delete (needs Antigravity quit); Item 4.1 global model switch (explicit yes).
**Skip until armed:** Item 3.3 legacy storage cleanup (date-armed 2026-06-23).

## Resolved questions (v2)
- **Q1.4(1) broaden-predicate vs boundary-normalize — RESOLVED (Gemini F2): hybrid.** Normalize at write boundaries (clean data at source) AND keep a strict core predicate with a `[SECURITY]`-logging fail-closed backstop. Neither pure approach alone — the hybrid gets source-cleanliness + a loud alarm for any missed write path.
- **Q1.4(2) executor.ts:810 — RESOLVED (Codex C6): seed `publish_required` from the canonical durable JOB flag.** `buildManifest` has no terminal state, so this records the seeded job decision — NOT a "full OR including state" (that phrasing, from v2, was wrong). The OR semantics live in the *completion* gate, which re-evaluates at the end.
- **Q1.4.4 executor.ts:1087 — RESOLVED (Codex C4): flag-only** (`isPublishRequired(job, null)`); see §1.4.4.
- **Q1.4.5 mirror guard — RESOLVED (Codex C5): import-based behavioral parity is primary** (cross-import root test over the value matrix); byte/AST source parity is an optional extra, not the safety net. See §1.4.5.

## All review findings resolved
Gemini (holistic) F1-F4 + Codex (grounded) C1-C6 all integrated (v4). No open BLOCKs remain in the design; the change is ready to IMPLEMENT next session under its own MERGE gate (AGENT BEHAVIOR, NORMAL, sequential Gemini→Codex). Full disposition table: `Documentation/publish-flag-coercion-harmonization-design-gate-peer-review.md`.
