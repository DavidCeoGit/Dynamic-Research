# Bug 49 — MERGE-gate Peer Review

**Date:** 2026-05-26 (S57)
**Author:** Claude Opus 4.7 (1M context)
**Reviewers:** Gemini 3 Pro Preview, Codex GPT-5.5 (sequential)
**Status:** APPROVED — promote pending live Tesla job 863fa052 completion (mid-flight at review time)

---

## Bug summary

**Bug ID:** 49 (catalog: `research_compare_learnings.md`)
**Surfaced:** S56 2026-05-26 on Tesla CE-3 studio-only acceptance test job `aa2f06d2`
**Severity:** medium — display-only UI bug; deliverables accessible in gallery
**Symptom:** worker classified successful studio-only regeneration as `status: failed`; UI displayed "Execution Failed"

**Root cause:** `verifyPipelineCompletion()` in `agent/executor.ts:795-866` used EXACT MATCH `phase_status === "complete"` (S34 design intent). Claude in studio-only mode emitted `phase_status: "complete (partial-set studio-only regen)"` — augmenting the canonical terminal marker with an LLM-generated clarifier. Exact-match rejected the augmented form.

**Worker log evidence (aa2f06d2):**
```
[20:28:11.393] Phase: Vendor Evaluation (85%) — complete (partial-set studio-only regen)
[20:28:30.592] Pipeline did not complete: Pipeline stopped at phase 6 (Vendor Evaluation);
  expected phase_status="complete" OR phase>=7 (Finalization).
  phase_status: "complete (partial-set studio-only regen)"
```

---

## Risk classification (per multi-reviewer policy v2.2)

- **Event Gate:** MERGE
- **Risk Label:** AGENT BEHAVIOR — silently affects future worker job-completion classification + edits slash command that propagates to every future agent session
- **Severity Mode:** NORMAL
- **Topology:** Sequential Gemini → Codex (correct per v2.2; HARD RULE)
- **Test coverage:** `verifyPipelineCompletion()` has ZERO automated tests (verified via Grep). Pre-existing condition since S34. Adding tests is fast-follow tech debt; accepted as residual.

---

## v1 — initial design (sandboxed)

**Change:** `phaseStatusStr === "complete"` → `phaseStatusStr === "complete" || phaseStatusStr.startsWith("complete (")`. Comment block at executor.ts:829-845 expanded to document the new rule (d).

**Rationale:** parenthesized-clarifier pattern (`complete + space + open paren`) accepts the Tesla aa2f06d2 case while preserving S34's explicit rejection of underscore-suffixed sub-phases (`reconcile_complete`, `complete_without_studio`, `notebooklm_complete`).

---

## v1 → v2 (Gemini findings integrated)

### Gemini verdict: APPROVE-WITH-CHANGES

### Gemini MAJOR 1 — pattern over-fit to one separator
v1's `startsWith("complete (")` would fail on dash or colon variants (`"complete - studio-only"`, `"complete: studio-only"`). Claude is non-deterministic across runs.

**Integrated:** replaced with named regex `COMPLETE_AUGMENTED = /^complete[\s\-:(]/`. Character class covers space, tab, dash, colon, open-paren. Comment block (d) rewritten to document the broader pattern + the deliberate exclusion of underscore and alphanumerics.

### Gemini MAJOR 2 — harden the source
Worker-side defense alone leaves the root cause (LLM prompt drift) un-addressed. Slash command at `~/.claude/commands/research-compare.md:1106` should instruct Claude to write EXACTLY `"complete"`.

**Integrated:** added CRITICAL block-quote after line 1106 explicitly forbidding clarifiers, parenthesized notes, and appended context. Points to optional `state.completion_note` field for extra context.

### Gemini MINOR 1 — false-positive risk `"complete (failed to upload)"`
**Accepted as residual.** Claude would have to explicitly write `complete` for a failure state, contradicting the slash command's own semantics. The slash command hardening (MAJOR 2) further reduces this risk to negligible.

### Gemini MINOR 2 — test coverage
**Accepted as fast-follow.** Function has been zero-coverage since S34. Tech-debt ticket recommended.

---

## v2 — Codex sequential review

### Codex verdict: APPROVE-WITH-CHANGES

### Codex regex review
Validated: `/^complete[\s\-:(]/` matches all 4 target separator variants (space/tab/dash/colon), rejects `complete_without_studio`, `reconcile_complete`, `notebooklm_complete`, `completely done`, `completed`. `[\s\-:(]` is valid JS regex syntax. No ReDoS risk. Input lowercased pre-test so unanchored regex works without `/i` flag.

### Codex MAJOR 1 — failure-path contract still ambiguous in worker mode
The slash command at line 813 says studio artifact gen failures should "Retry or skip, continue with remaining" — but worker mode cannot ask. After v2's regex broadening, a skipped-product run that proceeds to Phase 6 and writes `"complete - skipped video"` would satisfy `COMPLETE_AUGMENTED` and silently render partial success as success. `uploadOutputs()` only fails on attempted-upload failures, not on missing-product gaps.

**Integrated:** rewrote line 813 as a mode-split bullet list:
- NONINTERACTIVE: write `phase_status: "ERROR: Studio generation failed: <product>: <reason>"`, exit 1, no skip, no proceed to Phase 5.5b/6, no terminal `complete` marker
- INTERACTIVE: ask retry/skip, continue only after explicit skip choice

Slight semantic-preserving reformatting (bullet list vs one sentence) for readability. Inline reference to S57 Bug 49 Codex MAJOR + why-it-matters note added.

### Codex MINOR 1 — `state.completion_note` is net-new
**Integrated:** reworded to "(for example, an optional `state.completion_note` field — net-new, no other contract elsewhere)".

### Codex MINOR 2 — test coverage (echoes Gemini MINOR 2)
**Accepted as fast-follow.**

### Codex cross-coverage validation
- No actual `complete_without_studio` emitter in code (verified). Original S34 comment cited it as defensive-rejection example, not a real emitted marker. v2 correctly rejects.
- Zero-Studio-products path at `research-compare.md:1134` uses the canonical `complete` marker — no separate terminal acceptance needed.
- `runStudioOnly()` bypass at `executor.ts:454` is correct: `regenerate-studio-products.ts` exits non-zero on partial-set (verified at script lines 14, 127, 539, 546), so `completeJob()` only fires on full-set success.
- AGENT BEHAVIOR is the correct risk label.

---

## v2 → v3 (Codex findings integrated)

Both Codex MAJOR 1 + MINOR 1 applied to `~/.claude/commands/research-compare.md`. No changes to `sandbox/executor.ts` (Codex APPROVED that file's regex).

---

## v3 — Codex sequential QA (fidelity pass)

### Codex QA verdict: PASS

> "v3 faithfully integrates v2 findings; ship."

No deviation from v2 intent. Bullet-list reformatting of MAJOR 1's diff is semantic-preserving.

---

## Final disposition

**APPROVED.** v3 may proceed to promote + daemon restart.

### Files changed
1. `sandbox/executor.ts` (promote target: `agent/executor.ts`) — +18/-2 net +16
   - Lines 829-848: comment block expansion documenting rule (d)
   - Lines 863-866: `COMPLETE_AUGMENTED` regex const + OR-condition in `isComplete`
2. `~/.claude/commands/research-compare.md` (already live — no sandbox routing needed for `~/.claude/commands/`)
   - Line 813: failure-path mode-split (NONINTERACTIVE vs INTERACTIVE)
   - Line 1106-1108: CRITICAL terminal marker contract block

### Deferred (fast-follow tech debt)
- Test scaffolding for `verifyPipelineCompletion()` covering: exact `complete`, augmented forms (4 separator variants), underscore-suffixed sub-phases, word-extended forms. Defensible to skip for this hotfix per both reviewers.

### What each reviewer saw
- **Gemini Deep Think:** v1 sandbox/executor.ts diff (30-line context region), bug description with worker log, S34 design intent comment. Read backup-claude-config/commands/research-compare.md to map phase_status usage. Took regenerate-studio-products.ts behavior + bug reproduction on faith.
- **Codex GPT-5.5 (v2 pass):** Full repo read with file-grounded grep. Read sandbox/executor.ts, live agent/executor.ts, ~/.claude/commands/research-compare.md, agent/scripts/regenerate-studio-products.ts, agent/scripts/lint-deliverables.ts, project + global CLAUDE.md. No automated tests run (sandboxed read-only).
- **Codex GPT-5.5 (v3 QA pass):** Re-read research-compare.md lines 800-835 + 1098-1115 directly to verify v2 → v3 fidelity.

### Sequencing constraint
Live Tesla studio-only job `863fa052` was claimed by worker at 22:29:05 local before this review completed. The job is using:
- **OLD slash command text** (started before line 813 + 1106 edits) → expected to exhibit Bug 49 (`status: failed` despite successful deliverable upload) UNLESS Claude happens to write canonical `"complete"` this time
- **OLD validator** (executor.ts is loaded in memory; static-imported at worker.ts:19; change does not take effect until daemon restart)

**Cannot restart daemon mid-job** per CLAUDE.md §6 (orphans Supabase rows + storage artifacts). Promote + restart deferred until 863fa052 reaches terminal state.

**Sign-off:**
APPROVED-BY: Claude Opus 4.7 + Gemini 3 Pro Preview + Codex GPT-5.5 (sequential v1 → v2 → v3 → QA) | mode=NORMAL | label=AGENT-BEHAVIOR
