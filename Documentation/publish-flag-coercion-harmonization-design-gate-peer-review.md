# DESIGN-gate peer review — publish-flag coercion harmonization (S120 plan)

**Gate:** DESIGN · **Artifact under review:** `Documentation/s120-tomorrow-design-plan.md` (the forward plan; the code it proposes is NOT yet written and gets its OWN MERGE gate when implemented). **Severity:** NORMAL. **Topology:** sequential Gemini (holistic-adversarial) → integrate → Codex (grounded-adversarial) on the integrated v2/v3. **Date:** 2026-06-13 (S119).

## What each reviewer saw
- **Gemini 2.5 Pro (holistic-adversarial breadth):** the full plan v1 inline + the working-tree source files via `@`-refs (`publish-gate.ts`, `executor.ts`, `manifest/route.ts`, `replay/route.ts`, `validate.ts`, `StepReview.tsx`) + the today-retrospective as context. Prompt: "strongest case to BLOCK the whole plan."
- **Codex (grounded-adversarial depth, `codex exec -s read-only`, 126,914 tokens, EXIT=0, no quota issue):** the integrated v3 plan (post-Gemini, post-live-Defect-C) read from disk + the same shipped source files read in its sandbox + the retrospective. Prompt: "try to BLOCK this specific change; run counterexamples against shipped code, file:line." (Its inline Node counterexample was blocked by the read-only shell policy — it continued source-grounded.)
- **Author live evidence (between the two passes):** an end-to-end UI-flagged publish run (job `97906d8c`) that PASSED the gate, and a clone-defaults check that FAILED — surfacing **Defect C** (the S118 C1 fix is a no-op against real runstate). This live finding was folded into the plan BEFORE Codex's pass, so Codex reviewed the Defect-C-aware v3.

## Context: the live-found defect that reframed the plan (Defect C)
The S118 "C1" fix (`manifest/route.ts:163 publishRequired: uc.publishRequired === true`) reads `uc = state.userContext` (line 142). Verified against job `97906d8c`'s `state.json`: top-level `publish_required: true` exists (the gate reads it), but `state.userContext` has NO `publishRequired` key. So the clone-prefill computes `undefined === true` → `false` → **every clone of a publish parent silently downgrades out of the gate.** The S118 fix is a no-op. Caught ONLY by the live run — the diff looked correct to Gemini, Codex, and the author at S118 because none verified the producer writes the field. ([[feedback_verify_feature_reachable_in_real_runstate]])

## Gemini findings (holistic) → disposition
| # | Sev | Finding | Disposition |
|---|---|---|---|
| G1 | BLOCK | Security-critical logic duplication (frontend mirror of agent predicate); passive parity test is structurally unsafe; ideal = shared package. | **PARTIAL-ACCEPT.** Mirror is an established, reviewed project pattern (storage-paths/untrusted-input pairs). Upgraded the guard (see Codex C5 — import-based behavioral parity). Full shared-package refactor recorded as a separate ARCHITECTURE/DESIGN backlog item (§1.7) — disproportionate to this fix. |
| G2 | MAJOR | Lenient-predicate design is inferior to boundary-normalization; broadening chases quirks reactively. | **ADOPT.** Redesigned to HYBRID: normalize at write boundaries + strict core + logging backstop. Resolved open Q1.4(1). |
| G3 | MINOR | The "principled" truthy set `{true,"true","on"}` is arbitrary; don't add `"on"`. | **ADOPT.** Core predicate stays strict `{true,"true"}`; `"on"` normalized at the boundary if a raw-form path ever exists. |
| G4 | NIT | Plan diluted with out-of-scope cleanup/Dream items. | **PARTIAL.** User explicitly requested all 4 groups; kept but demarcated Items 2-4 as execution backlog, not design-review scope. |

## Codex findings (grounded, on the integrated v3) → disposition
| # | Sev | Finding | Disposition |
|---|---|---|---|
| C1 | BLOCK | Defect C fix chose the WRONG single source: DB-only downgrades legacy storage-only runs (`.maybeSingle()`→null); state-only fails for string DB rows (`executor.ts:810` writes false). | **ADOPT (strongest catch).** OR all sources through the canonical predicate: `predicate(parent.user_context?.publishRequired) ‖ predicate(state.publish_required)`. + regression for `attachRow=null` + `state.publish_required=true` → prefill true. |
| C2 | BLOCK | The `[SECURITY]` logging backstop is unplaceable as written — the predicate is PURE (no job id, no logger). | **ADOPT.** Predicate stays pure; diagnostic helper logs from executor/evaluate call-sites carrying `job.id` (`executor.ts:676/1002/553/945`). |
| C3 | BLOCK | Backstop must log REJECTED non-booleans (`"yes"`/`"on"`), not only accepted `"true"` — the rejected value is the silent gate-skip; diagnostics must run BEFORE the applicability early-return. | **ADOPT.** Log trigger inverted to the present-but-rejected non-boolean (the dangerous case). |
| C4 | MAJOR | `executor.ts:1087` wants the durable job-flag decision, not a post-run OR over state (`buildPrompt` runs pre-terminal-state). | **ADOPT** (matches author pre-read): `isPublishRequired(job, null)` + `publish-brief.test` for `"TRUE"` → block present. |
| C5 | MAJOR | Byte-identical mirror guard false-fails on formatting + misses out-of-body divergence; a value matrix only covers enumerated cases. | **ADOPT.** Primary guard = root test importing BOTH real exports + running the matrix; source/AST parity is an optional extra. |
| C6 | MINOR | "Effective gate decision including state" is inaccurate at manifest-write time — `buildManifest` has no terminal state. | **ADOPT.** Reworded: seed `publish_required` from the canonical durable JOB flag; OR semantics remain in the completion gate. |

## Convergence / topology note
Sequential Gemini→Codex earned its keep again: Gemini's breadth set the design direction (boundary-normalization principle G2, scope discipline G4, the duplication concern G1); Codex's grounding on the integrated v3 found **three BLOCKs Gemini's holistic pass could not** — they each require file:line reasoning (C1 `.maybeSingle()` null path, C2 predicate purity, C3 control-flow early-return). Codex also CONVERGED with Gemini on G1 (agreed deferring the shared package is acceptable *if* the guard tests real exports — which downgrades G1's BLOCK to a satisfiable MAJOR). No reviewer disagreement requiring escalation. No SECURITY-CRITICAL unresolved finding.

## Final resolved direction (plan v4)
The harmonization is: (1) **OR all sources** at the clone-prefill (Defect C); (2) **boundary-normalize** to strict boolean at write sites (Defect A); (3) **strict core predicate** `{true,"true"}` exported as `isPublishFlagSet`; (4) **pure predicate + a logging diagnostic** at call-sites that logs present-but-rejected non-booleans with `job.id` (Defect B / silent-skip alarm); (5) `executor.ts:1087` flag-only; (6) **mirror + import-based behavioral-parity root test**; (7) shared-package refactor DEFERRED (ARCHITECTURE backlog). No open BLOCKs. Ready to IMPLEMENT next session under its own MERGE gate (AGENT BEHAVIOR, NORMAL, sequential Gemini→Codex; frontend files via sandbox+promote; agent/-touching ⇒ worker restart).
