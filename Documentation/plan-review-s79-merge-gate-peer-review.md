# MERGE-gate peer review — plan-review S79 (G-MIN-1 persona_depth_score nullability)

**Status:** APPROVED for promote — v3 sandbox + tsc green + 79/79 unit tests pass (40 plan-transports + 39 plan-reviewer; both files) + sequential MRPF complete (Gemini round 1 → integrate to v2 → Codex round 1 on v2 → integrate to v3 → mechanical-narrowing skip).

**Change scope:** Drains the LAST carry-forward from the S75/S77/S78 plan-review MERGE-gate queue — the S75-deferred G-MIN-1.

- `agent/lib/plan-transports.ts` — JSON schema property `persona_depth_score` widened from `{ type: "integer" }` to `{ type: ["integer", "null"] }`; `ReviewerJsonOutput` interface typed `number | null`; `validateReviewerJsonShape` accepts explicit null but rejects missing-field via `"persona_depth_score" in p`; legacy `reviewerJsonInstruction()` prompt updated to declare null as a last-resort signal (not a hedge against uncertainty).
- `agent/lib/plan-reviewer.ts` — `ReviewerTransportOutput.persona_depth_score` widened to `?: number | null`; `buildReviewerPromptBody` line 187 updated to mirror the last-resort wording; `ensurePersonaDepthFinding` new branch: when `score === null` AND verdict is approve-like, force a plan-ambition finding so `adjustVerdictForAmbition` rewrites the verdict to REQUEST_CHANGES (closes the null+APPROVE bypass that pre-S79 was held by the validator's required-integer guard).
- `agent/test/plan-transports.test.ts` — 5 new mocked-SDK tests (3 Gemini-side null acceptance + 2 OpenAI-side null mirror tests from Gemini G-MIN-2).
- `agent/test/plan-reviewer.test.ts` — 2 new full-pipeline tests covering the null+APPROVE bypass-prevention guard (positive case + negative counter-test). `MockCall.persona_depth_score` widened to `number | null` to match the upstream contract.

**MRPF classification:**
- Event Gate: **MERGE**
- Risk Labels: **AGENT BEHAVIOR** (reviewer transport runs on every plan-review pass; this PR changes the accepted reviewer-output contract from "integer required" to "integer-or-null required" + adds a new null+approve gating branch that affects every plan-review verdict)
- Severity Mode: **NORMAL**
- Topology: Sequential **Gemini → integrate → Codex on integrated v2 → integrate → v3 (mechanical-narrowing of Codex C-MAJ-1)**. Loop ends at v3 because the v3 fix is a 1-token-style condition narrowing (`typeof !== "number"` → `=== null`) exactly per Codex's recommendation; no new code surface remains for adversarial critique. Pattern matches S77 v4 fidelity-skip precedent (mechanical fix + tsc-validated + same-reviewer-already-recommended ⇒ skip).

**Author:** Claude Opus 4.7 [1m] | **Reviewers:** Gemini 3 Pro Preview, OpenAI GPT-5-Codex | **Date:** 2026-06-01 UTC

---

## What each reviewer saw

| Reviewer | Pass | Scope provided |
|---|---|---|
| Gemini round 1 | v1 sandbox | Diff (live→v1) + MRPF classification + S75 G-MIN-1 original-finding context + downstream `ensurePersonaDepthFinding` flow narrative |
| Codex round 1 | v2 sandbox (post-Gemini integration) | Diff (live→v2) + Gemini round 1 findings + dispositions + working-directory + read-access to `agent/node_modules/openai/**` SDK source |

---

## Round 1 — Gemini on v1 sandbox

| ID | Severity | Category | Disposition | Notes |
|---|---|---|---|---|
| G-MIN-1 | MINOR | prompt bias | **ACCEPTED → integrated v2** | v1 wording said *"a deliberate null is preferred over a fabricated score"* — heavily weights cautious models toward null even when they could legitimately pick a tier. v2 reframes null as **last resort, not a hedge against uncertainty** + adds the explicit "pick the closer integer between adjacent tiers" guidance. Same wording change applied in two places (the legacy `reviewerJsonInstruction()` text-prompt in `plan-transports.ts` AND the structured-schema-path instruction in `plan-reviewer.ts:buildReviewerPromptBody`). |
| G-MIN-2 | MINOR | test coverage | **ACCEPTED → integrated v2** | v1 only verified null acceptance via the Gemini mocked transport. v2 adds two OpenAI-side tests: (a) `output_text: { ..., persona_depth_score: null, ... }` flows through `responses.create` → assertion `out.persona_depth_score === null` (not coerced to 0/undefined); (b) missing-field rejection mirror for the OpenAI transport. Same `validateReviewerJsonShape` covers both paths, but the symmetric test ensures a parse-path-specific regression (SDK-side coercion in `responses.parse`, etc.) does not silently land on one transport only. |

**Gemini verdict on v1:** REQUEST_CHANGES → integrated to v2.

---

## Round 2 — Codex on v2 sandbox (post-Gemini integration)

| ID | Severity | Category | Disposition | Notes |
|---|---|---|---|---|
| C-MAJ-1 | MAJOR | agent behavior | **ACCEPTED → integrated v3** | Pre-S79, `validateReviewerJsonShape` rejected missing/null persona_depth_score, so the persona-depth gate was BINDING — a reviewer that wanted APPROVE had to score the plan or fail at the transport boundary. Post-S79 v2, explicit null becomes a legitimate punt signal, but `ensurePersonaDepthFinding` treated null + APPROVE like the pre-S79 dead-code defensive path: if `looksLikeHedgeBet` returned false (non-adversarial-looking plan), NO plan-ambition finding was added, `adjustVerdictForAmbition` stayed no-op, and the plan reached APPROVED status without rubric application. Code-grounded grep against `plan-reviewer.ts:268-283` + `:303-314` + `:709-720` validated the bypass chain. **Fix in v3:** when `score === null && isApproveLike(call.verdict)`, force-add a plan-ambition finding so the verdict downgrades to REQUEST_CHANGES. A reviewer that wants to bypass the gate must either score the plan honestly or return a non-approve verdict (which gates by itself). Codex also recommended a full-pipeline test for "APPROVE + null + non-hedge does NOT approve" — added at `plan-reviewer.test.ts:447-485` along with a counter-test "REQUEST_CHANGES + null does NOT add synthetic plan-ambition" at `:487-510`. |

**Codex verdict on v2:** REQUEST_CHANGES → integrated to v3.

### What Codex caught that Gemini missed

This is a textbook code-grounded vs. holistic-context split. Gemini reviewed the diff + context narrative; Codex grep'd the downstream consumer chain (`ensurePersonaDepthFinding` → `adjustVerdictForAmbition` → `reviewPlan` round resolution) to find that null + APPROVE now reached APPROVED status. The author's MRPF prompt to Codex explicitly asked about exactly this: "is there a regression here?" — but the question prompted Codex to do the actual code walk that surfaced the answer.

The empirical lesson: when a PR changes a "required" contract to "required-but-nullable", the downstream consumer must be audited for every site that conditioned behavior on "required". This is the exact kind of cross-file invariant code-grounded review is for.

---

## v3 — mechanical narrowing of Codex C-MAJ-1 fix

**v2 → v3 (mechanical, no MRPF round; recursion skip per S77 precedent):**

Author's initial integration of Codex C-MAJ-1 used `typeof score !== "number"` as the guard — wider than Codex specified (`score === null`). The wider guard broke two pre-existing tests at `plan-reviewer.test.ts:321 + :289` that mock undefined persona_depth_score via `mkReviewer` + assert APPROVED status via design §6 reduced-review fallback. In production, undefined is unreachable (the validator's `"persona_depth_score" in p` check rejects missing fields), so the existing tests were exercising a test-only-mock path. Narrowing the guard from `typeof !== "number"` → `=== null` (exactly per Codex's wording) preserves the test semantics while closing the production-reachable bypass.

**Why mechanical (no MRPF round on v3):** The narrowing is a single-condition change exactly matching Codex's C-MAJ-1 recommendation; tsc + 79/79 unit tests validate the surface; no new code surface for adversarial critique. S77 set the precedent for skipping fidelity QA on mechanical fixes that exactly match a reviewer's recommendation. Decision rationale: avoid recursion; the saved $0.04-0.05 is well below the round-cost-vs-signal threshold for this class of fix.

---

## Test summary

Pre-promote verification (post-v3 swap-into-live, then reverted):

- `pnpm test` (storage-paths antipattern grep + `tsc --noEmit` on agent + `tsc --noEmit` on frontend): **PASS**
- `node --import tsx --test test/plan-transports.test.ts`: **40/40 pass** (35 pre-existing + 3 new Gemini-side G-MIN-1 + 2 new OpenAI-side G-MIN-2 mirrors)
- `node --import tsx --test test/plan-reviewer.test.ts`: **39/39 pass** (37 pre-existing + 2 new full-pipeline Codex C-MAJ-1 tests)

New tests landed in this MERGE:

| Test | Branch covered |
|---|---|
| S79 G-MIN-1: persona_depth_score=null is accepted and surfaced through transport (not coerced to 0) | Gemini parse path + validator null acceptance + null preserved end-to-end (not coerced) |
| S79 G-MIN-1: persona_depth_score missing (undefined) is rejected — distinct from explicit null | Gemini path validator missing-field rejection via `"persona_depth_score" in p` |
| S79 G-MIN-1: out-of-range integer still rejected (range guard intact) | Confirms the new null-acceptance branch did not weaken the 0-4 range guard |
| S79 G-MIN-1: OpenAI transport surfaces persona_depth_score=null verbatim | OpenAI mirror — both transports preserve null through their distinct parse paths |
| S79 G-MIN-1: OpenAI transport rejects persona_depth_score missing | OpenAI mirror — missing-field rejection symmetric across surfaces |
| S79 G-MIN-1 Codex C-MAJ-1: APPROVE + null + non-hedge gets rewritten to REQUEST_CHANGES | Full-pipeline gate-bypass prevention |
| S79 G-MIN-1: REQUEST_CHANGES + null does NOT add synthetic plan-ambition | Counter-test: new guard fires ONLY on approve-like; non-approve verdicts gate themselves |

---

## Promote checklist (post-approval, pre-merge)

- [x] Sandbox v3 reflects all integrated findings (Gemini G-MIN-1 + G-MIN-2 + Codex C-MAJ-1 narrowed)
- [x] pnpm test passes against v3
- [x] 79/79 unit tests pass against v3 (40 plan-transports + 39 plan-reviewer)
- [x] MRPF sequential loop closed at v3 (mechanical narrowing exactly per Codex C-MAJ-1; no v4 round needed)
- [x] MERGE-gate peer-review doc written (this file)
- [ ] unix2dos sandbox/*.ts before /promote (CRLF convention preservation)
- [ ] /promote → live + worker recycle + preflight 4/4 green
- [ ] Bundle commit + push to origin

---

## Carry-forward to S80+ (post-S79)

The S75/S77/S78/S79 plan-review MERGE-gate queue is **DRAINED**. Items remaining on the broader carry-forward list (per S78 handoff §"Carry-forward to S79"):

1. **Investigate per-job sandbox-allowlist gap** (carry from S76) — 3 permission_denials in S76 smoke trace. ~30-60 min if real.
2. **/pre-work-context-check dogfood feedback** — collect after N≥3 fires.
3. **buildPlanReviewEmail TEMPLATE MERGE-gate** — carry-forward 13 sessions now.
4. **Bug 53b** — Phase 4 prerequisite cleanup (carry-forward 12 sessions).
5. **MEMORY.md compaction** — now over 30KB target.
6. **7 failed test jobs accumulated** (carry from S74).
7. **Retroactive redact of S59 false-positive at handoff:1511** — optional cleanup.

---

## Appendix A — sequential MRPF dogfood validation (S79)

S79 is another strong empirical case for the sequential-MRPF topology HARD RULE:

- **Round 1 (Gemini on v1):** caught both findings (prompt bias + test-coverage asymmetry) — both holistic-context observations that a code-walk wouldn't surface as efficiently. Gemini did NOT catch C-MAJ-1 because it lacked file-system access to grep the downstream consumer chain.
- **Round 1 (Codex on v2):** caught C-MAJ-1 with grep against `plan-reviewer.ts:ensurePersonaDepthFinding` + `adjustVerdictForAmbition` + the `reviewPlan` round-resolution path at lines 268-283 / 303-314 / 709-720. This finding was **only reachable** on v2 (v1 didn't have the null-acceptance path implemented yet) — exactly the sequential-topology pattern S77-S78 documented: the second reviewer critiques the LATEST direction, not stale v1 details.
- **v3 mechanical narrowing:** Codex's recommended fix (`score === null`) was wider in the author's initial integration (`typeof !== "number"`) → broke 2 existing tests. The narrowing back to Codex's exact wording fixed both. Lesson: when a reviewer specifies an exact condition, that's the production-reachable boundary; defensive widening risks unintended scope.

Cost asymmetry validated: Gemini ~$0.10 + Codex ~$0.05 = $0.15 for a MAJOR-severity catch that would have shipped silently broken under parallel review (Gemini's pass on v1 wouldn't have seen the null-acceptance code yet).

---

## Appendix B — risk register

| Risk | Mitigation | Residual |
|---|---|---|
| OpenAI strict-mode `type: ["integer", "null"]` rejected at API → schema-400 on every call | S78 C-MAJ-3 fallback already in place: schema-400 → json_object retry. Verified against `agent/node_modules/openai/resources/responses/responses.d.ts` + `client.js:449` (Codex round 2 grounding). Type arrays are the standard OpenAI structured-outputs nullable pattern. | Low. If strict-mode does reject in some future SDK version, the fallback path takes over without functional regression — just a perf/cost increment per call. |
| Reviewer learns the prompt and ALWAYS returns null (over-correction) | v2 prompt language reframes null as last-resort, not a hedge ("pick the closer integer between adjacent tiers"). Both `reviewerJsonInstruction()` and `buildReviewerPromptBody` updated. | Low. Worst case: reviewers return null too often → null+APPROVE branch fires → plan-ambition added → verdict gates correctly. Same defensive depth as the score-below-threshold case. |
| Telemetry/audit-log consumer assumes integer | `raw_json` captures full parsed value (`plan-transports.ts:593, :859`). No downstream consumer was found to deserialize `raw_json.persona_depth_score` as required-integer. | Low. Frontend consumes via signed-URL JSON, schema-flexible. |
| `personaDepthGap()` called from a missing-null-filter site | grep'd `personaDepthGap` across agent + frontend codebase — only called from `ensurePersonaDepthFinding` which has the `typeof === "number"` guard before invocation. | None. |
