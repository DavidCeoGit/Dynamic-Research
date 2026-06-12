# S115 — PUBLISH-gate brief reinforcement — MERGE-gate peer review

**Change:** `agent/executor.ts` `buildPrompt()` injects an exact `publish_verification` contract + NotebookLM-leg clarification into the spawn brief, ONLY for `publishRequired` jobs; new `agent/test/publish-brief.test.ts` (3 cases). Branch `fix/publish-brief-contract` off `main` @ `71d5205`.

**MRPF classification:** MERGE gate · **AGENT BEHAVIOR** label (the brief silently propagates to every future worker `claude -p` spawn) · NORMAL severity · sequential topology Gemini holistic-adversarial → integrate → Codex grounded-adversarial.

**Root cause (job 9a1b7b30, S113):** the `/research-compare` skill specifies the gate contract correctly but ~900 lines deep; the executing model drifted (wrote `status`/flat-string legs instead of `verification_status`/`vendor_legs.{leg}.status`; claims in a separate file) AND proxied the NotebookLM verification leg through Claude (looked for a non-existent NLM MCP). The worker gate (`agent/lib/publish-gate.ts`, unchanged) correctly fail-closed. Fix = brief reinforcement at high prompt-weight.

---

## What each reviewer saw
- **Gemini 2.5-pro (holistic-adversarial, breadth):** the inline review doc (full diff + gate contract + skill contract excerpts + adversarial angles). Did NOT read the repo (capacity-exhausted on default `gemini-3-flash-preview`; fell back to `gemini-2.5-pro` per `feedback_gemini_model_capacity_exhausted_fallback`; the run's file reads failed but all content was embedded inline).
- **Codex (grounded-adversarial, depth):** the SHIPPED post-integration v2 files in the repo (`agent/executor.ts`, `agent/lib/publish-gate.ts`, `agent/test/publish-brief.test.ts`, `agent/types.ts`) via `codex exec -s read-only`.

---

## Round 1 — Gemini holistic-adversarial (v1) → **BLOCK**

**Finding 1 (BLOCKING) — verdict trap / incomplete failing-claim path.** The brief showed only `verified|verified_with_caveat` as the claim verdict but was silent on `refuted`/`unverifiable` claims. The gate's `CLAIM_PASS_VERDICTS` accepts ONLY those two values in `claims[]`, so a model with a claim to refute had no schema-compliant slot → would invent `verdict: "refuted"` → fail on a schema error rather than a meaningful content-level failure.
→ **INTEGRATED (v2).** Added to `publishBlock`: refuted/unverifiable claims must NOT appear in `claims[]`; per Step A.5 repair a refuted claim is corrected/removed + re-verified, an unverifiable claim is removed/reframed as opinion, findings recorded in a related verified claim's `counterEvidenceNotes`; if a load-bearing claim genuinely cannot be verified and cannot be removed → `verification_status: "failed"` + ERROR-exit (absent `urgent_signoff_present`). New test assertions pin `refuted`, `unverifiable`, and the fail-closed exit path.

**Finding 2 (MAJOR) — wrong fix altitude; also fix the skill.** Argued the brief patch creates two competing schema sources of truth and the robust fix is to repair the skill's example.
→ **PARTIALLY ACCEPTED / documented disagreement (MRPF non-security disagreement procedure).** Gemini's premise — that the skill's example is *flawed* — is incorrect: the skill's `publish_verification` shape (commands/research-compare.md lines 136-160) is already byte-correct against the gate. There are NOT two competing schemas; the drift was caused by DEPTH (the correct contract buried 900 lines down), which the brief reinforcement directly addresses by surfacing it at high prompt-weight. The brief is therefore the right altitude for the drift fix. Touching the global skill file (`~/.claude/commands/research-compare.md`) is out of scope for this in-repo PR (separate file, `/edit-skill` workflow, its own gate) and is logged as a discretionary follow-up — its example is not defective, so the follow-up is "consider also surfacing the contract earlier in the skill," not "fix a bug."

---

## Round 2 — Codex grounded-adversarial (integrated v2) → **BLOCK** (process + hardening; core CONFIRMED)

Codex read the shipped v2 files (`codex exec -s read-only`, EXIT=0, 89k tokens, no quota issue). **It confirmed the substance:** "the brief otherwise matches the gate fields in `evaluatePublishGate`/`validateClaim`"; "omitting `refuted`/`unverifiable` from the passing `verdict` example is correct and the repair path is present at executor.ts:1071" (validates the v2 integration); "the publish block is static and gated by `publishRequired === true`; false/unset paths collapse to the old prompt text"; "no stray `${...}` ... NotebookLM backticks are escaped."

**Finding 1 (BLOCKING) — new test file untracked.** `git status` showed `?? agent/test/publish-brief.test.ts`; a commit/diff-based merge would ship `executor.ts` without the test.
→ **RESOLVED at commit:** `git add agent/test/publish-brief.test.ts` (new file, staged in the merge commit). Process artifact, not a code defect.

**Finding 2 (MAJOR) — test under-pins the contract.** Asserted only some substrings; omitted `text`, the `"claims": [` literal, leg `"status"`, `no_claims_justification`, and had no guard against the original top-level-`status` drift shape.
→ **INTEGRATED (v3):** added `text` to the claim-field loop; added explicit assertions for `"claims": [`, `"status"`, `no_claims_justification`; added a negative guard `!/"status":\s*"DEGRADED/` plus a positive `verification_status` assertion so a future reword cannot silently reintroduce the job-9a1b7b30 shape.

**Finding 3 (MINOR) — `no_claims_justification` only in a comment** while the brief says "EXACTLY the shape below."
→ **INTEGRATED (v3):** added an explicit top-level `"no_claims_justification"` line to the JSON skeleton, annotated "OMIT unless claims_extraction_status is no_load_bearing_claims; then REQUIRED, >=20 chars, claims:[] empty."

---

## Synthesis / disposition — **CLEARED to merge**

- **Field fidelity (the core risk): CONFIRMED by both lenses.** Gemini (breadth) found no field mismatch after Finding 1; Codex (depth, file:line vs `publish-gate.ts`) explicitly confirmed the brief matches `evaluatePublishGate`/`validateClaim` and the verdict handling is correct.
- **All BLOCKING/MAJOR findings closed:** Gemini-1 (v2), Codex-1 (git add), Codex-2 (v3), Codex-3 (v3).
- **Documented disagreement (Gemini-2, "wrong altitude"):** rests on an incorrect premise — the skill's `publish_verification` example (commands/research-compare.md:136-160) is already byte-correct against the gate, so there is no competing/flawed schema; the drift was caused by DEPTH, which surfacing the contract at high prompt-weight in the brief directly fixes. Brief is the right altitude. Optional follow-up (surface the contract earlier in the global skill) logged as discretionary, NOT a bug fix.
- **v3 deltas are test-assertions + one clarity annotation only** — they do NOT alter the brief contract Codex validated on v2, so no third reviewer round is required (post-fix-revision is fidelity-only; verified via `tsc --noEmit` clean + full root `pnpm test` EXIT=0, 449 tests).
- **Gemini transport note:** default `gemini-3-flash-preview` was capacity-exhausted (429, EXIT=124, no review); re-ran on `-m gemini-2.5-pro` per `feedback_gemini_model_capacity_exhausted_fallback`.

**Verification:** `tsc --noEmit` clean (agent + frontend); root `pnpm test` EXIT=0 — 384 agent (was 381; +3 publish-brief) + 65 frontend = **449**; storage-path grep guard passed.
