# S168 — executor.ts + publish-gate.ts state-field coercion guards — MERGE-gate peer review

**Date:** 2026-06-24 (S168)
**Change:** Guard untrusted-`state.json` field coercion at the two `executor.ts` sites the S166 fix left (the MAX_JOB_DURATION recovery `notebook_id` + `verifyPipelineCompletion`'s `phase`/`phase_status`), and make the downstream PUBLISH gate total over the same untrusted state. Audit chip `task_6e11cb47` (from `Documentation/code-review/2026-06-24-audit.md`), same bug class as the S166 watcher CRITICAL.

## MRPF classification
- **Event Gate:** MERGE (agent/ PROD code: cron → DR-Deploy clone → live worker daemon).
- **Risk Labels:** AGENT BEHAVIOR (changes worker recovery-gate + completion-verification + publish-gate semantics that silently propagate to future worker sessions); brushes SECURITY (publish-gate is the MRPF PUBLISH fail-closed boundary).
- **Severity:** NORMAL.
- **Topology:** sequential Gemini (holistic-adversarial breadth) → Codex (grounded-adversarial depth) → Claude grounded subagent (kept). 3 rounds (two BLOCK→fix cycles, then unanimous ENDORSE).
- **Automated-test answer (mandatory for AGENT BEHAVIOR):** YES. 35 NEW tests added (`agent/test/state-coercion-guards.test.ts` 27 + `agent/test/publish-gate-coercion.test.ts` 8) covering every hazard class — sensitivity proofs (no-throw on `{toString:null}`), fail-closed proofs, fail-OPEN-absent wiring, and behavior-preservation. The existing 9 `watch-state-progress.test.ts` tests guard the `summarizeStateProgress` refactor. `pnpm test` → agent 646 / frontend 111, 0 fail, tsc clean.

## The bug class
`state.json` is `JSON.parse(...) as PipelineState` from an UNTRUSTED child (`claude -p`). The declared types (`phase: string`, `phase_status: string`, `notebook_id: string|null`) are a **runtime lie**: a JSON-representable non-null object (e.g. `{"toString":null}`), an array, or even the literal `null` parses fine but throws `TypeError: Cannot convert object to primitive value` (or a null-deref) on `String(x)` / `` `${x}` `` / `MAP[x]`. These throws are caught at `worker.ts:278` (logs + keeps polling) so they are **INFO-severity for crash**, but a throw on the recovery/verify path happens AFTER a job is claimed and BEFORE `failJob`, so it can ORPHAN the claimed job; and a naive log-only fix at the recovery gate would be a **fail-OPEN** (launder a garbage `notebook_id` into a `{success:true}` recovery verdict).

## The change (final, v3 — 4 files)
- `agent/executor.ts` (+83/−7): NEW pure/total exported `isNonPrimitiveStateField(v)` (single-sourced coercion predicate), `recoverableNotebookId(state)` (recovery gate: non-empty string else null → fail CLOSED), `evaluateCompletion(state)` (extracted pure/total from `verifyPipelineCompletion`, with a top-level non-object guard + the `isNonPrimitiveStateField` phase/phase_status guard + a `String()` wrap on the `.slice` path); `summarizeStateProgress` refactored to single-source the predicate; the site-1 recovery gate now passes `recoverableNotebookId(recoveryState) !== null`.
- `agent/lib/publish-gate.ts` (+~22): `truncate()` made coercion-safe (accepts `unknown` via a new `coerceDisplay()` — strings verbatim, `String()` for primitives/null, `JSON.stringify` for objects/arrays, try/catch; NEVER throws); dropped the `String()` wrappers at the 4 unguarded reasons sites (`sourceQualityClass`, claim `verdict`, `verification_status`, `claims_extraction_status`). Makes `evaluatePublishGate` total over any parsed-JSON `publish_verification`.
- NEW `agent/test/state-coercion-guards.test.ts` (27), NEW `agent/test/publish-gate-coercion.test.ts` (8).

## Review rounds

### What each reviewer saw
- **Gemini 3.1 (`gemini-3.1-pro-preview`, @google/genai SDK):** the full `git diff`, the FULL post-change `agent/executor.ts`, the FULL post-change `agent/lib/publish-gate.ts` (v3), both new test files, the `worker.ts:278` catch context, and the v1 + v3 review-context docs. Holistic whole-artifact read; no repo/tool execution.
- **Codex (`gpt-5.5`, `reasoning effort: xhigh`, `codex exec -s workspace-write`, ChatGPT auth):** the actual repo files in its sandbox; ran its OWN counterexamples (tsx probes), `tsc --noEmit`, and `pnpm test`; reproduced the v2 CRITICAL and re-ran the repro at v3.
- **Claude grounded subagent (general-purpose, zero authoring context):** the staged diff + changed files; ran ~50 hostile inputs via two tsx probes, `tsc --noEmit`, `pnpm test`; drove `enforceStudioCompleteness` through its deepest poisoned-field path.

### v1 — Gemini holistic: BLOCK (CRITICAL)
`evaluateCompletion` claimed "never throws / total" but threw on a parsed **`null`** state: `JSON.parse("null")` returns the primitive `null` (no SyntaxError), `verifyPipelineCompletion` casts it to `PipelineState` and calls `evaluateCompletion(null)`, then `isNonPrimitiveStateField(state.phase)` does `null.phase` → `TypeError` → escapes on the sync path → bypasses `failJob` → orphaned job. The original tests' `mkState` only passed objects, making the totality claim vacuous.
**Integrated:** top-level `state === null || typeof state !== "object" || Array.isArray(state)` guard (fail CLOSED) + 4 explicit non-object-state tests.

### v2 — Codex grounded: BLOCK (CRITICAL, reproduced)
The MAX_JOB_DURATION recovery path forwards the raw `recoveryState` as `{success:true}` (only `notebook_id` validated); for a `publish_required` job that state reaches `evaluatePublishGateForJob` → `evaluatePublishGate` → `String(pv.verification_status)`, which throws on `{toString:null}` → orphaned job. Codex REPRODUCED it (valid `notebook_id` + `publish_required:true` + `verification_status:{toString:null}`); confirmed `evaluateCompletion`, `recoverableNotebookId`, and the `summarizeStateProgress` refactor were all correct. (Gemini v1 had rated this same residue MINOR/theoretical — the grounded depth lens grounded it to a reachable CRITICAL, exactly the S162/S166 pattern.)
**Integrated:** `truncate()` made coercion-safe + `String()` dropped at the 4 publish-gate sites + 8 new publish-gate-coercion tests.

### v3 — unanimous ENDORSE
- **Gemini holistic:** ENDORSE (0). Audited every untrusted-field access in `publish-gate.ts`; confirmed `coerceDisplay` safe, behavior preserved, executor integrations correct, and other `verdict.state` consumers (incl. `readStudioFailureReason`'s try/catch) safe.
- **Codex grounded:** ENDORSE (0). Re-ran its v2 repro (verification_status / verdict / sourceQualityClass / claims_extraction_status / array all → ok:false, no throw); confirmed green manifest → ok:true and `"failed"` → exact reason; tsc + tests clean (646/111/0).
- **Claude grounded subagent:** ENDORSE (0 blockers). ~50 hostile inputs, no throw/fail-open; drove `enforceStudioCompleteness` through its deepest path with poisoned fields → no throw.

## Out-of-scope follow-ups (pre-existing; flagged by the Claude subagent — NOT introduced by S168)
- `studio-completeness.ts:355` `state.notebook_id ?? ""` treats a truthy `{toString:null}` as a usable id (unreachable on the recovery path — the gate guarantees a string; the normal path requires a poisoned-`notebook_id`-but-complete state with a missing product). Candidate for a future bounded chip.
- `executor.ts:1170` `String(state.phase_status ?? "")` in `readStudioFailureReason` would throw on `{toString:null}` but is inside a try/catch that falls through to a generic reason — no orphan.

## Disposition
Clean unanimous tri-vendor ENDORSE on v3 → MERGE. agent/ worker-runtime change → DR-Deploy pull + worker restart required after merge (idle-check first).
