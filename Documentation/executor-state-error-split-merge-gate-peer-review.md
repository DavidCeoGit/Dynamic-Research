# MERGE-gate peer review — executor.ts transient-vs-corrupt state-error split (DR S166)

**Date:** 2026-06-24 · **Severity mode:** NORMAL · **Event gate:** MERGE · **Risk labels:** AGENT BEHAVIOR (worker correctness / recovery-eligibility-adjacent), ARCHITECTURE (new lib module + discriminated-union contract). agent/ PROD (cron → DR-Deploy → live daemon) → full tri-vendor gate mandatory (CLAUDE.md §11).

## Change
Audit 2026-06-24 two MEDIUMs. `watchStateFile` (5s progress poller) and `readStateForRecovery` (S136 duration-kill recovery read) each used a single bare `catch {}` that swallowed findStateFile/readFile/JSON.parse errors uniformly — a CORRUPT state file was indistinguishable from a benign TRANSIENT miss (no log; silent progress freeze; silent recovery drop).

**Fix:** new tested helper `agent/lib/read-state-file.ts` → `readPipelineState(workDir)` returns a 4-way discriminated union `{kind:"ok"|"absent"|"io-error"|"corrupt"}`, never throws, DI-injectable `findStateFile`+`readFile`. Both sites routed through it. `readStateForRecovery` gains a `job` param for correlated logging; fail-closed (null) on io-error/corrupt with a log. `verifyPipelineCompletion` intentionally NOT migrated (needs finer caller-facing reason strings; PUBLISH-critical) — documented boundary. Shape validation out of scope (separate state-schema.ts initiative).

Files: `agent/executor.ts` (+132/−32: import, caller arg, watchStateFile rewrite + new exported `summarizeStateProgress`, readStateForRecovery rewrite), NEW `agent/lib/read-state-file.ts`, NEW `agent/test/read-state-file.test.ts` (15), NEW `agent/test/watch-state-progress.test.ts` (9). `pnpm test`: agent 611 / frontend 102, 0 fail, strict tsc clean, storage guard pass.

## Topology (sequential, Gemini → Codex → Claude; reviewer order per §11)
| Stage | Reviewer | Saw | Verdict |
|---|---|---|---|
| Holistic-adversarial (breadth), v1 | Gemini `gemini-3.1-pro-preview` (@google/genai) | review-context + executor diff + both new files + find-state-file.ts + verifyPipelineCompletion (pasted) | **ENDORSE** — 0 findings |
| Grounded-adversarial (depth), v1 | Claude subagent (general-purpose, zero authoring context) + mutation testing | shipped working tree; ran tsc + tests; mutated code to prove non-vacuous | **ENDORSE** — 0 findings |
| Grounded-adversarial (depth), v1 | Codex `gpt-5.5` xhigh (`codex exec -s workspace-write`, banner asserted) | shipped working tree; ran node counterexamples | **BLOCK** — 1 CRITICAL |
| Grounded QA re-verify (depth), v2 | Codex `gpt-5.5` xhigh (finding driver) | shipped v2 working tree; ran counterexamples + tsc + tests | **ENDORSE** — CRITICAL fixed, 1 pre-existing INFO |

Codex was quota-exhausted (ChatGPT-OAuth) on the first attempt (failure mode #6 — echoed prompt, exited non-zero "usage limit … try again at 2:47 PM", zero analysis). Per CLAUDE.md §11 HARD RULE (no substitutes for agent/ PROD), the merge was PARKED; user authorized the §1a API-key flip → real `gpt-5.5` xhigh ran (banner asserted `model: gpt-5.5` + `reasoning effort: xhigh`); auth flipped back to ChatGPT immediately after (verified).

## Codex v1 CRITICAL (the catch the holistic + Claude-grounded lenses MISSED)
`watchStateFile` removed the old whole-tick `try/catch`. `readPipelineState`'s structural guard only checks the TOP-LEVEL parsed value is an object, NOT field types. A JSON-representable object like `{"phase":{"toString":null},"phase_status":"running"}` → `kind:"ok"` → `PHASE_MAP[state.phase]` throws `TypeError: Cannot convert object to primitive value` (object-key coercion), escaping the async setInterval as an UNHANDLED REJECTION. Second vector: `{"phase":"1","phase_status":{"toString":null}}` throws at the log template. Both confirmed in Node by Codex. Gemini + Claude both reasoned "JSON can't represent throwing getters" — true, but `{"toString":null}` is a plain object that throws on COERCION, not a getter. The cross-vendor grounded lens earned its keep.

## Fix for the CRITICAL (v2)
Extracted a PURE, TOTAL exported `summarizeStateProgress(state, lastPhase, lastPct)` → `{kind:"malformed"|"unchanged"|"update"}`. It rejects a non-primitive `phase`/`phase_status` (`typeof === "object" && !== null`) as `"malformed"` BEFORE any PHASE_MAP key coercion or string interpolation — never throws. `watchStateFile` routes `malformed` to the deduped `noteCorrupt` path (same as a corrupt parse) and keeps polling; `update`/`unchanged` behavior is byte-identical to the original for normal string states. The helper (`read-state-file.ts`) is unchanged — its structural contract is correct; the defect was the consumer assuming primitive fields. New `watch-state-progress.test.ts` asserts the two exact counterexamples are `malformed` + do-not-throw (sensitivity proofs), plus map-integration/unchanged/over-broad cases.

## Codex v2 verification (ENDORSE)
CRITICAL fixed (both counterexamples → malformed, no throw); `summarizeStateProgress` total over JSON-shaped inputs; normal string behavior preserved (`"5"/"running"` → Synthesis/60, same log + updateJob + lastPhase/lastPct); `loggedCorrupt` re-arm correct (malformed/corrupt return before re-arm; usable parse incl. unchanged re-arms); tests non-vacuous (ran 24/24 + tsc pass).

## Open / deferred (NOT blockers)
- **[pre-existing INFO, Codex]** `executor.ts:714/717` duration-recovery log path interpolates `recoveryState!.notebook_id` unvalidated — a non-coercible `notebook_id` object would throw. PRE-EXISTING (old readStateForRecovery returned unvalidated parsed JSON; caller already interpolated it). Same class as a similar latent exposure in `verifyPipelineCompletion` (`String(phaseRaw)` at ~:1914). Both belong to the separate `state-schema.ts` (Zod field-validation) MEDIUM, not this bounded fix.
- `verifyPipelineCompletion` remains a third inline state reader — deliberate scope boundary (Gemini explicitly endorsed deferring it).

## Disposition
Full tri-vendor gate CLEARED (Gemini holistic + Claude grounded ENDORSE on the design/helper/recovery which the fix left unchanged; Codex grounded BLOCK→fix→ENDORSE). Merged to main; worker deploy (DR-Deploy pull + restart) per CLAUDE.md §4 step 4.
