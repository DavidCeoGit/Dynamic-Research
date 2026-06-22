# Plan-Review R2 Injected-vs-Authored Split — MERGE-gate Peer Review (synthesis)

**Session:** S155 (2026-06-22). **Gate:** MERGE × AGENT BEHAVIOR + SECURITY × NORMAL. agent/ PROD code → §11 HARD RULE (full tri-vendor gate clears BEFORE merge; no substitute-and-proceed).
**Artifact under review:** the diff in `agent/lib/{plan-reviewer,plan-types,plan-transports}.ts` + `agent/test/{plan-reviewer,plan-reviewer-convergence,plan-transports}.test.ts`, design `plan-review-r2-injected-vs-authored-design.md`.
**Topology:** sequential both-lenses-adversarial — Gemini holistic-adversarial (whole artifact) → integrate → Codex grounded-adversarial (file:line, counterexamples) on the integrated v2.
**Reviewer order / what each saw:** Gemini (gemini-2.5-pro via @google/genai SDK) read the design doc + the full diff + the full post-change `plan-reviewer.ts` + `plan-types.ts` (ReviewFinding/isValidFinding). Codex (`codex exec -s workspace-write`, ChatGPT auth) ran in-repo against the shipped TypeScript with the diff + named files. Claude = author.

---

## Round 1 — Gemini holistic-adversarial → BLOCK (integrated)

Logs: `c:/tmp/dr-s155/gemini.log`. (gemini-2.5-pro; 503 capacity on first 2 attempts, succeeded on retry 3 via the in-script backoff.)

- **[CRITICAL] Incomplete keystone guard-swap → persona-depth bypass.** The design's keystone is to swap ALL THREE injection-suppression guards in `ensurePersonaDepthFinding` from `isAntiBypassFinding` to `isInjectedAntiBypass`. The implementation swapped only the FIRST (the `gap<0` branch, line 315). The `score===null`+approve-like (null-punt) and `looksLikeHedgeBet` branches were left as `isAntiBypassFinding`. Consequence: on a deficient plan where the reviewer also emits an AUTHORED MAJOR plan-ambition, that authored finding satisfies the (un-swapped) guard → the system injection is suppressed → R2a sees no injected finding → a lone authored finding falls through R2b → **the persona-deficient plan ships**, reopening the exact S58.5/S79/§2.1 bypass.
  - **Disposition: FIXED.** Root cause was an indentation-mismatched `replace_all` during implementation (the gap<0 guard is 6-space-indented; the other two are 4-space). Both remaining guards (now lines 356, 369) swapped to `isInjectedAntiBypass`. Verified by grep: all three guards are `isInjectedAntiBypass`.
- **[MAJOR] Missing test coverage for the null-punt + hedge-bet injection paths.** The new `KEYSTONE` integration test exercised only the `gap<0` trigger; had tests existed for the other two triggers they would have caught the CRITICAL.
  - **Disposition: FIXED.** Added `KEYSTONE (null-punt)` and `KEYSTONE (hedge-bet)` integration tests (+ a `hedgeBetPlan` fixture). **Sensitivity proven:** with the two guards reverted to `isAntiBypassFinding`, both new tests FAIL (terminal R5 / ships); with the fix they pass (terminal R2). The gap<0 keystone test stayed green under the revert (its guard was correct), isolating the regression precisely.
- **[MINOR] Stripper allocates on the common path.** `call.findings.map(...)` always builds a new array; Gemini suggested skipping the alloc when no finding carries `injected`.
  - **Disposition: DECLINED with rationale (recorded in code + here).** Gemini's suggested `let findings = call.findings; if (some-injected) findings = map(...)` would, in the common case, alias `call.findings`; `ensurePersonaDepthFinding` then **pushes** the injection into `findings`, which would mutate the reviewer's payload (the pre-S155 `[...call.findings]` copy existed precisely to avoid this). The unconditional fresh array is load-bearing, not wasteful. A clarifying code comment was added.
- **[INFO] R2b × reduced-review interaction.** In single-reviewer mode (`availableCalls.length===1`) the R2b corroboration (`>=2`) can never be met, so a genuine organic scope finding from the lone reviewer now falls to R5. Acceptable per design intent (R2a stays independent); worth explicit acknowledgment + telemetry.
  - **Disposition: ACKNOWLEDGED.** Added to the design doc §6; the lone-authored→R5 telemetry follow-on is noted as a separable item.

**Integrated v2 state after Round 1:** all 3 guards `isInjectedAntiBypass`; +2 keystone tests (sensitivity-proven); MINOR declined w/ rationale; INFO acknowledged. `pnpm test` exit 0 (agent 440 / frontend), tsc clean.

---

## Round 2 — Codex grounded-adversarial (on integrated v2) → BLOCK (integrated)

Logs: `c:/tmp/dr-s155/codex.log`. Prompt: `c:/tmp/dr-s155/codex-prompt.txt`. (`codex exec -s workspace-write`, ChatGPT auth, gpt-5.x; ~170k tokens; ran probes against the shipped TypeScript.) **Verified OK by Codex:** all 3 keystone guards ARE `isInjectedAntiBypass` (runtime-probed gap<0 / null+APPROVE / hedge-bet → each produced one authored MAJOR + one injected MAJOR + terminal R2 — confirming the Round-1 keystone fix is complete); `injected:true` is non-forgeable on the gate path (OpenAI strict `additionalProperties:false`; both reviewer call-build sites pass through `ensurePersonaDepthFinding` before assigning `findings`; the stripper does not mutate the input); `tsc --noEmit` + the reviewer/transport test slice pass.

- **[CRITICAL] null-punt anti-bypass only fires on approve-like verdict → unscoreable plan ships under ladderEnforce.** `ensurePersonaDepthFinding`'s null branch was `if (score === null && isApproveLike(call.verdict))`. A reviewer can return `REQUEST_CHANGES` + `persona_depth_score:null` + `findings:[]`; with the OTHER reviewer approving, `decideTerminal` → R5, and with `PLAN_REVIEW_LADDER_ENFORCE:true` (the flag this deploy flips on) the plan is APPROVED. Codex ran it against the shipped TS: `status:"APPROVED", terminal:"R5", injected:0, findings:[]`. The S79 "a non-approve verdict gates by itself" premise holds for the per-reviewer allApprove early-exit but is FALSE at the terminal ladder.
  - **Disposition: FIXED.** Dropped the `&& isApproveLike(call.verdict)` qualifier → `if (score === null)`: a null score (rubric un-appliable) now injects the `injected:true` anti-bypass MAJOR regardless of verdict → R2a → fail closed. Updated the S79 test (`plan-reviewer.test.ts`) that enshrined the old premise; added Codex's exact counterexample (one APPROVE + one REQUEST_CHANGES/null/[] → terminal R2) to the convergence suite. **Sensitivity proven:** the counterexample test FAILS on the pre-fix condition (ships at R5/APPROVED) and PASSES on the fix. `pnpm test` exit 0 (agent 441 / frontend 100). Mid-loop behavior unaffected — a non-terminal null just flips the verdict via `adjustVerdictForAmbition` and the loop integrates/continues; only a TERMINAL null hard-blocks (an unscoreable plan should not ship). This also makes the bundled `ladderEnforce` flip safe.

**Round-2 QA (Codex, post-fix) → ENDORSE.** Logs: `c:/tmp/dr-s155/codex-qa.log` (~93k tokens). Codex verified the fix is live (`if (score === null)`, injected:true at the push); re-ran its exact counterexample → terminal R2 / REQUEST_CHANGES (not R5/APPROVED); ran an inline shipped-TS probe confirming a terminal-round null hard-blocks while a NON-terminal null does NOT get stuck (round-1 injects+integrates, round-2 both approve → APPROVED) — so no new false-block class. Reconfirmed all three keystone guards `isInjectedAntiBypass`, non-forgeability (inbound `injected` stripped; calls store only augmented findings), and that `decideTerminal` is only called from `reviewPlan`. `plan-reviewer-convergence` 34/34, `plan-reviewer` 41/41, `plan-transports` 41/41, tsc + `git diff --check` pass. Non-blocking note (a stale `null+approve` comment in plan-types.ts) — FIXED.

---

## Synthesis / decision — GATE CLEARED (merge approved)

The sequential both-lenses-adversarial gate caught a real, distinct defect at EACH stage — Gemini (holistic) the incomplete keystone guard-swap + the test-coverage gap that hid it; Codex (grounded, against shipped code) the null-punt × ladderEnforce bypass — neither of which the other lens surfaced, and both of which would have shipped a persona-depth bypass to the prod injection-defense. All integrated; both fixes proven sensitive by deliberate revert tests (each new test fails on the buggy code, passes on the fix). Codex's post-fix QA ENDORSED with an inline shipped-TS probe. Claude (author) concurs.

**Verdict: CLEARED before merge** (Gemini integrated + Codex integrated + Codex QA ENDORSE + Claude concur). Full tri-vendor per §11 agent/-prod HARD RULE; no substitutes used. Final state: agent 441 / frontend 100 tests pass, tsc clean, `git diff --check` clean.

**What each reviewer saw:** Gemini — design doc + full diff + full post-change plan-reviewer.ts + plan-types.ts. Codex — the shipped repo (file:line + runtime probes against the actual TypeScript) + the diff + design doc. Claude — author.
