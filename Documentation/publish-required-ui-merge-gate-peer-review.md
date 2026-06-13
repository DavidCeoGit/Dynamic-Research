# MRPF PUBLISH UI Flag — MERGE-gate Peer Review

**Change (S118):** Add the missing UI control for the MRPF PUBLISH gate. The
`userContext.publishRequired` flag was already plumbed end-to-end (zod schema
`z.boolean().default(false)`, queue insert into `research_queue.user_context`
jsonb, worker reads it via `agent/lib/publish-gate.ts isPublishRequired`) but
**dark-launched** — no UI set it (see `~/CLAUDE.md` §PUBLISH "dark-launched
flag" note). This change exposes the control so a UI submission can flag a
publish run.

**Branch:** `feat/publish-required-ui-flag` off `main` @ `13aed30`.

**Files (frontend-only; 2):**
- `frontend/components/new-research/StepCustomize.tsx` — adds a "Publish gate"
  checkbox bound via `register("userContext.publishRequired")` + a `ShieldCheck`
  lucide import. Amber-styled fieldset signalling the strict-gate consequence.
- `frontend/components/new-research/StepReview.tsx` — surfaces the flag in the
  review-summary "Options" section; extracts a `hasCustomOptions` boolean to
  drive the "Default settings" placeholder (replacing a negated `&&`-chain).

**MRPF classification:** Event Gate = MERGE. Risk Label = **AGENT BEHAVIOR**
(exposes the control that toggles the worker's job-completion enforcement
semantics for a run). Severity = NORMAL. Topology = sequential
Gemini (holistic-adversarial) → integrate → Codex (grounded-adversarial).

**No backend change.** The submit path (`useNewResearchForm onSubmit` spreads
full `FormData` minus transient fields → `POST /api/queue` →
`researchJobPayloadSchema.safeParse` → `insert user_context: data.userContext`)
already carries `userContext.publishRequired` automatically. No migration; the
jsonb column already accepts the field.

---

## What each reviewer saw

- **Gemini (gemini-2.5-pro, holistic-adversarial):** the two changed files via
  `@`-reference + context files (`frontend/lib/validate.ts`,
  `agent/lib/publish-gate.ts`). Whole-artifact read; not a file:line pass.
- **Codex (`exec -s read-only`, grounded-adversarial):** the changed files on
  disk + shipped context (`validate.ts`, `useNewResearchForm.ts`,
  `api/queue/route.ts`, `replay/route.ts`, `publish-gate.ts` incl. tests).
  file:line counterexamples against the integrated v2.

---

## Round 1 — Gemini (holistic-adversarial)

**Verdict: BLOCK** (single HIGH finding).

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| G1 | HIGH | "Integrity downgrade on cloned research" — a Clone & Edit of a `publishRequired=true` parent lets the user UNCHECK the box, producing a derivative run with the gate disabled. Proposes making the checkbox **sticky+disabled** when the parent was publish-gated. | **PARTIALLY REJECTED — then OVERTURNED by Codex C1 (see Round 2).** Author's round-1 disposition: rejected the *sticky-disable remedy* (correctly — `publishRequired` is a per-run USER DECLARATION; Clone & Edit deliberately makes every field editable; sticky-disable is novel policy that breaks legitimate internal-followup cloning) BUT WRONGLY concluded "no defect." Author anchored on Gemini's "user unchecks" framing and MISSED the real mechanism. Codex's grounded pass (C1) found that the **manifest route drops `publishRequired` entirely**, so a clone downgrades by DEFAULT with **zero user action** — a genuine fail-open. The correct remedy (preserve as the editable *default*, not sticky-disable) was integrated in v3. **Lesson: a holistic BLOCK can be right about the symptom and wrong about both the mechanism and the remedy — verify the mechanism against source, don't just accept/reject the proposed fix.** |
| G2 | LOW | `truthyFlag` in `agent/lib/publish-gate.ts` accepts `true`/`"true"` but not the HTML checkbox default `"on"`; latent fail-open if a non-RHF path ever submitted `"on"`. | **DEFERRED.** Gemini concedes it is "not an active bug": react-hook-form `register` on a checkbox yields a BOOLEAN in form state, the JSON body carries `publishRequired: true/false`, and `z.boolean()` validates it — `"on"` never reaches the backend. The hardening lives in `agent/`; integrating it would expand this frontend-only PR into `agent/` and force a worker restart. Tracked for a future agent/ touch. |
| G3 | MINOR | The "Default settings" placeholder condition is a long negated `&&`-chain that must be hand-updated per new Option. | **INTEGRATED (v2).** Extracted `hasCustomOptions` boolean (De-Morgan-equivalent: `!A && !B && … === !(A || B || …)`); JSX now reads `{!hasCustomOptions && …}`. Behavior-preserving; one list to update going forward. (Did NOT adopt Gemini's `FORM_DEFAULT_VALUES`-comparison variant — it would change empty-string-vs-default semantics; the truthiness checks are equivalent for the `""` defaults and lower-risk.) |

Integrated v2: StepReview.tsx `hasCustomOptions` extraction. tsc --noEmit clean.

---

## Round 2 — Codex (grounded-adversarial, on integrated v2)

**Verdict: BLOCK** (one HIGH; one LOW caveat; concurred on G2 + G3 dispositions).

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| C1 | HIGH | **Clone & Edit silently drops `publishRequired` with ZERO user action.** The manifest route (`app/api/runs/[slug]/manifest/route.ts:34` type + `:150-155` body) returns `userContext` with only the 4 array fields — `publishRequired` is absent. The clone hook (`useNewResearchForm.ts:81`) replaces the form's whole `userContext` with that incomplete object; on submit zod defaults the missing flag to `false` (`validate.ts:80,362`) and `queue/route.ts:218` inserts the downgraded `user_context`. Counterexample: clone a publish-required parent and submit **without touching the checkbox** → the clone is no longer publish-gated. Codex explicitly distinguished this from Gemini G1's sticky-disable framing: "preserving the parent value as the checkbox **default** still leaves it editable, so this is not a sticky-disable policy." | **INTEGRATED (v3) — Codex correct; overturns the author's round-1 G1 rejection.** Verified against source: the manifest route did drop the field. Fixed by adding `publishRequired: uc.publishRequired === true` to both the `ManifestResponse` type and the returned object, mirroring the replay route's S108 precedent. The clone now defaults the checkbox to the parent's value and stays user-editable. The `ManifestResponse.userContext` interface now structurally REQUIRES `publishRequired: boolean`, giving a compile-time guard against future re-omission. |
| C2 | LOW | Replay preserves the **boolean** publish path (`replay/route.ts:140,239`) but coerces with `=== true`, so a hypothetical out-of-schema DB row carrying the string `"true"` (which the worker's `truthyFlag` at `publish-gate.ts:122,135` WOULD treat as publish-required) would be downgraded to `false` on replay. Not the HTML `"on"` issue. | **ACKNOWLEDGED — out of scope; accepted tradeoff.** Such a row is not producible via the UI/API (both write a real boolean). The v3 manifest fix intentionally matches replay's existing `=== true` coercion for consistency. Closing the string-`"true"` edge would require harmonizing both routes with the worker's `truthyFlag` semantics — a separate, agent-adjacent change. Noted for the same future agent/ touch as G2. |

**Disposition checks Codex concurred on:**
- **G3 (readability):** confirmed `hasCustomOptions` (`StepReview.tsx:83`) is De-Morgan-equivalent to the prior negated chain, includes `publishRequired`, no default-label regression.
- **G2 (HTML `"on"`):** concurred the checkbox follows the existing RHF boolean-checkbox pattern, `onSubmit` strips only transient fields, and the API zod schema requires a boolean — so `"on"` never reaches the backend on the normal path.
- **No regression** for non-publish submissions: defaults remain `false` in `FORM_DEFAULT_VALUES` + both schemas.

> Codex could not run `tsc` itself (read-only sandbox policy blocked the spawn). Author ran `pnpm -C frontend exec tsc --noEmit` → clean on v1, v2, and v3.

---

## Synthesis & decision

**Both reviewers BLOCKED on round 1 / v2; the v3 integration resolves both blocks.**

- The substantive block was **C1** (clone default-downgrade). This is the canonical
  sequential-gate value: Gemini's holistic pass *flagged the area* (clone integrity)
  but mis-framed the mechanism (user-unchecks) and proposed a wrong remedy
  (sticky-disable); the author rejected the remedy AND wrongly cleared the area;
  Codex's grounded pass on the integrated v2 found the *actual* file:line
  fail-open (manifest route omits the field) and the *correct* remedy
  (preserve-as-editable-default). Neither lens alone would have shipped a correct
  fix — exactly why holistic→grounded must stay sequential and not collapse.
- **Activation note:** this gap was dormant under dark-launch (nothing set
  `publishRequired`); the UI flag *activates* it, so closing it is in-scope for
  this PR, not a pre-existing bug to defer.

**Final change set (frontend-only; 3 files):**
1. `StepCustomize.tsx` — "Publish gate" checkbox bound to `userContext.publishRequired`.
2. `StepReview.tsx` — review-summary line + `hasCustomOptions` extraction (G3).
3. `app/api/runs/[slug]/manifest/route.ts` — preserve `publishRequired` on clone prefill (C1).

**Test coverage (AGENT BEHAVIOR MRPF requirement):** the React form components
have no unit-test harness in this suite (node --test, no jsdom/RTL). The manifest
fix is guarded at COMPILE TIME — `ManifestResponse.userContext` now requires
`publishRequired: boolean`, so re-omission fails `tsc`. The value-coercion mirrors
the replay route's already-tested S108 pattern. A full route-handler integration
test would need Supabase-client mocking infrastructure absent from the suite;
deferred as a known gap rather than built ad-hoc for one field.

**Deferred (documented, not blocking):** G2 + C2 — harmonize `truthyFlag` /
route coercions (`"on"`, string `"true"`) on a future `agent/`-touching change
to keep this PR frontend-only (no worker restart).

**Decision: PROCEED to PR.** Both blocks resolved in v3; frontend tsc clean;
no agent/ change; no worker restart required (Vercel auto-build on merge).
