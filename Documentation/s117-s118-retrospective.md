# S117–S118 Today-Retrospective — input/context for the S119 tomorrow design-plan

**Date:** 2026-06-13 · **Session producing this:** S119 · **Status:** AUDIT/summary artifact, NOT a Gemini/Codex review gate.

> **Why this is not routed through Gemini→Codex.** Both S117 and S118 changes were *individually* MERGE-gated (sequential Gemini→Codex, adversarial both-lenses) and shipped to production before this retrospective was written. Re-reviewing already-merged, already-tested, already-deployed code is low-value — the adversarial review budget belongs on the *forward* plan, not on settled history. This document is the **context input** to that forward plan (artifact `(b)`), capturing: what shipped, what the gates caught, what the author missed, and what remains owed. It is deliberately a plain AUDIT.

---

## 1. What shipped

### S117 — Stale-terminal-state fail-open CLOSED (PR #14, main `13aed30`)
- **Defect class:** fail-OPEN in the PUBLISH gate. A reused per-slug workdir could retain a *prior* attempt's terminal `state.json` (potentially a PASSING `publish_verification`). If a new spawn exited without writing its own state, `findStateFile()` returned the stale passing file → the gate would publish-clear a no-work run.
- **Fix:** `archiveStaleStateFiles(workDir)` in `agent/lib/find-state-file.ts` renames every prior `state.json` / `*-state.json` in the workdir ROOT into `.superseded-state/`, called once in `executeJob()` right after `mkdir workDir` — *before* spawn, poller, and the studio_only branch (the single chokepoint both paths share). With the stale file gone, `findStateFile()` returns null → existing null-state guards fail CLOSED. **No new gate logic — the fix removes the input that fooled the gate.**
- **Tests:** +6 (core fail-open repro + non-ENOENT rethrow + idempotent/collision). Suite 390/390 agent.
- **Risk labels:** AGENT BEHAVIOR + DATA. Severity NORMAL. Worker restarted onto the fix (DR-Deploy → `13aed30`, worker PID 57932).

### S118 — MRPF PUBLISH dark-launch UI flag SHIPPED (PR #15, main `ea413bd`)
- **What it does:** surfaces the previously dark-launched `userContext.publishRequired` flag as a UI control in the research-request form. **Key discovery:** the flag was ALREADY plumbed end-to-end (schema default → form defaults → submit spread → queue insert → worker read). The ONLY missing piece was the UI `<input>`. So this was a **pure-additive frontend change, not new plumbing.**
- **Change — frontend-only, 3 files:**
  1. `StepCustomize.tsx` — amber "Publish gate" `<fieldset>` checkbox via `register("userContext.publishRequired")` + `ShieldCheck` icon.
  2. `StepReview.tsx` — review-summary "Options" line when set; extracted `hasCustomOptions` boolean (De-Morgan-equivalent) to drive the "Default settings" placeholder.
  3. `app/api/runs/[slug]/manifest/route.ts` — **the substantive fix:** preserve `publishRequired: uc.publishRequired === true` in the clone-prefill `userContext` (type + body), mirroring the replay route's S108 precedent.
- **Tests:** suite 390/390 agent, frontend tsc clean. **Frontend-only ⇒ no worker restart** (DR-Deploy stays `13aed30`).
- **Risk labels:** AGENT BEHAVIOR. Severity NORMAL.

---

## 2. What the gates CAUGHT (the value-of-process evidence)

| Session | Reviewer / lens | Catch | Disposition |
|---|---|---|---|
| S118 | **Codex grounded-adversarial (C1)** | The **manifest route omitted `publishRequired` entirely** → a "Clone & Edit" of a publish parent silently downgraded to `false` by DEFAULT with **zero user action**. This is the real fail-open. | Fixed v3: preserve-as-editable-default. **This is the single most important catch of the two sessions** — a default-downgrade that neither Gemini nor the author found. |
| S118 | Gemini holistic-adversarial (G3) | Readability: `hasCustomOptions` De-Morgan refactor for the review placeholder. | Integrated. |
| S118 | Gemini (G2) / Codex (C2) | `truthyFlag` "on" / string-`"true"` coercion edge. | **Deferred** (not active — react-hook-form submits a boolean). → carried into tomorrow's plan. |
| S117 | Codex grounded-adversarial | v2 helper's broad `readdir` catch returned `[]` on ANY error → a transient non-ENOENT error (EMFILE/EPERM) after `mkdir` would silently leave the stale manifest → re-opened the exact fail-open. | Fixed v3: ENOENT-only swallow + rethrow + fail-closed call site + test. |

**Takeaway:** the sequential holistic→grounded topology earned its keep both sessions. The *grounded* pass on the *integrated* artifact is what found the load-bearing defects (S118 C1 manifest omission; S117 broad-catch fail-open) — exactly the code-grounded class the topology exists to surface.

---

## 3. What the author MISSED (honest self-audit)

**S118 — I wrongly cleared the clone area on Gemini's mis-framed BLOCK.**
- Gemini holistic-adversarial correctly *smelled* a "clone integrity downgrade" — the right AREA — but **mis-framed the mechanism** ("user unchecks the box") and proposed a **wrong remedy** (sticky + disabled checkbox).
- My round-1 disposition: correctly rejected the sticky-disable remedy — but then **wrongly concluded "no defect"** and cleared the area.
- The REAL defect (manifest route omitting the field → default-downgrade, zero user action) was only found by the Codex grounded pass on the integrated v2.
- **Lesson (now memory [[feedback_holistic_reviewer_can_misframe_mechanism]]):** rejecting a mis-framed *remedy* is NOT the same as clearing the *area*. When a holistic BLOCK names an area, verify the AREA against source independently of whether its proposed remedy is sound, and let the grounded pass confirm. This is the complement to [[feedback_grounded_reviewer_can_be_confidently_wrong]].

**S118 — handoff-recollection drift.** The S117 handoff said to "plumb the flag through the queue insert." In fact the entire data path already existed; only the UI input was missing. **Lesson:** grep a "dark-launched" field end-to-end before building — don't trust a handoff's recollection of what's missing.

---

## 4. What remains OWED (the input to tomorrow's plan)

1. **First UI-flagged publish run end-to-end — ✅ DONE S119, PASSED.** Job `97906d8c` (topic: Mars' moons, single-answer) submitted via the live UI with the Publish gate checkbox checked; Review step confirmed "Publish gate: Enabled". Worker claimed 04:48, ran ~8 min, and at 04:56:48 logged `[publish-gate] publish_verification PASSED — all legs live, all claims verified` → 7 files uploaded incl. `publish_verification.md`. **Manifest verified genuine (not fail-open):** all 3 legs truly live (Perplexity Sonar Pro NASA-domain-filtered; NotebookLM real CLI, conversation `4ed82836`, grounded on attached NASA source `c9ab5cbc`; Claude source-quality pass), both claims full-date-sourced to `science.nasa.gov/mars/moons` (2026-06-13 accessed), `upstreamIndependenceBasis` + verdicts + counter-evidence all populated, verdict=verified. **The S118 UI flag is validated end-to-end: form checkbox → queue → worker → `isPublishRequired` → gate → PASS.** Remaining sub-check: clone-defaults-CHECKED (C1 fix live) — see status below.
   - *Benign note:* the `claude:o` stream showed a non-fatal Git-Bash cp1252 `UnicodeEncodeError` from a Python subprocess print; did not block completion (known encoding quirk).
   - **⚠️ CLONE-DEFAULTS SUB-CHECK FAILED — the S118 C1 fix is INEFFECTIVE (new S119 finding).** Cloning the run via "Clone & Edit" hit `/api/runs/[slug]/manifest`, which returned `userContext.publishRequired: false` — i.e. the clone STILL downgrades a publish parent out of the gate, the exact C1 fail-open class the S118 fix was meant to close. **Root cause:** the manifest route reads `publishRequired` from `state.json`'s nested `userContext` echo (`manifest/route.ts:142,163` — `uc = state.userContext`, `uc.publishRequired === true`), but the worker never writes `publishRequired` into `state.userContext` — verified against the live `state.json`: top-level `publish_required: true` (what the gate reads) is present, but `state.userContext` keys are `[contextFilePath, additionalUrls, claimsToVerify, domainKnowledge, constraints, localSourcePath, attachments, ...]` with **NO `publishRequired`**. So `uc.publishRequired === true` → `undefined === true` → `false`. **The replay route is NOT affected** — `replay/route.ts:119` reads `parent.user_context` from the authoritative DB queue row, so it preserves the flag. **Fix (folds into S120 plan Item 1):** the manifest route already queries the `research_queue` row for attachments (lines 124-129) — read `publishRequired` from `parent.user_context` there (replay's authoritative precedent), not from `state.userContext`.
     - **Meta-lesson:** the S118 MERGE gate passed this fix because Gemini, Codex, AND the author all reasoned about the code (`uc.publishRequired === true` *looks* correct) without verifying that `state.userContext` actually carries the field at runtime. This is [[feedback_verify_feature_reachable_in_real_runstate]] — a fix that targets a field the producer never writes is a no-op the diff can't reveal. The live end-to-end run is the ONLY thing that caught it; this is the strongest possible vindication of the handoff's insistence that the UI flag be exercised live, not just code-reviewed.
2. **`truthyFlag` harmonization** (deferred S118 G2/C2): unify `"on"` / string-`"true"` / boolean coercions across `agent/lib/publish-gate.ts` + replay route + manifest route. agent/-touching ⇒ worker restart.
3. **Cleanup:** prune stale merged remote branches *[S119: DONE — only `main` remains]*; DR-dev folder delete (USER action, needs Antigravity quit).
4. **Dream top-4 remaining:** COST `claude config set -g model sonnet` (GLOBAL — explicit yes); WORKFLOW extract `/end-session` secret-scan → `~/.claude/tools/secret-scan.sh`; SKILLS `/codex-fallback` skill.
5. **Legacy flat-storage cleanup** auto-arms 2026-06-23 (~10 days out).
6. **MEMORY.md size** near the index cap — trim longest lines if it crosses.

---

## 5. Lessons → memory pointers
- [[feedback_holistic_reviewer_can_misframe_mechanism]] — holistic BLOCK can name the right area with wrong mechanism+remedy; verify the area against source.
- [[feedback_grounded_reviewer_can_be_confidently_wrong]] — the complement; a grounded BLOCK can be confidently wrong too (S117 Gemini studio_only).
- [[feedback_stale_terminal_state_fail_open_hazard]] — reused workdir keeps prior terminal state.json.
- Gemini CLI workspace sandbox: prompt INSIDE project, reference `@agent/...`; always `-m gemini-2.5-pro`. Codex: `exec -s read-only - < promptfile`; read-only sandbox blocks its own `tsc` (author runs it).
