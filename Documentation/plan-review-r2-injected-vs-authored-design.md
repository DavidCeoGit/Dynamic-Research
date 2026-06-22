# Plan-Review R2 — Injected-vs-Authored Anti-Bypass Split (origin-precision fix)

**Session:** S155 (2026-06-22 UTC)
**Status:** v1 — implemented + unit-green (agent 438/438, full `pnpm test` exit 0, tsc clean). Pending the tri-vendor MERGE gate (Gemini holistic → integrate → Codex grounded).
**MRPF:** MERGE gate × **AGENT BEHAVIOR + SECURITY** (the R2 rung is the S58.5/S79/S86 prompt-injection / scope-ratchet defense; this change is to that classifier and ships to the prod worker) × NORMAL severity. agent/ PROD code → §11 HARD RULE: full tri-vendor gate clears **before** merge; no substitute-and-proceed.
**Author:** Claude (S155). Design pass: a 3-proposal / 3-judge / synthesis workflow (run `weklec4o3`) that rejected prompt-only as insufficient and converged on this design.
**Companion artifact:** `plan-review-r2-injected-vs-authored-merge-gate-peer-review.md`.
**Prior art:** `plan-review-r2-refinement-design-gate.md` (S86 — narrowed R2 to MAJOR+, rejected sentinel-marking and integration-strip).

---

## 1. Problem — the user's recurring "Execution Failed"

Research jobs produce a `ResearchPlan`. `reviewPlan()` (`agent/lib/plan-reviewer.ts`) runs two in-pipeline LLM reviewers (Gemini `gemini-3.1-pro-preview` + Codex `gpt-5`) over up to `MAX_REVIEW_ROUNDS` rounds. On the terminal round, `decideTerminal()` runs a severity-graded ladder (S85): R1 any CRITICAL; **R2 any MAJOR+ `plan-ambition`** (anti-bypass); R3 no approve-like reviewer; R4 unresolved MAJORs > 2; R5 else proceed. A terminal hard-block surfaces to the user as **"Execution Failed — Reviewers requested changes after the maximum review rounds."**

The user hit this wall repeatedly. S154 diagnosed it from prod telemetry: jobs `657161bb` and `9a1b7b30` hit **terminal=R2**. Pulling job `657161bb`'s `plan_reviews` rows (read-only, prod service-role): Codex flagged the plan's reference to an unverified statutory subsection **"§4628(j) perjury sign-off"** as `[MAJOR] origin=plan-ambition` — which trips R2's hard block. **Gemini APPROVED both rounds (0 findings).** The concern is *legitimate* (don't cite an unverified subsection in a med-legal deliverable) but **mislabeled**: it is a citation-accuracy / source-quality issue whose correct origin is `source-strategy` (advisory → falls through R2 to R5), not an anti-bypass scope concern.

## 2. Root cause (two coupled defects)

**(a) The reviewer prompt gives no origin-routing guidance.** `buildReviewerPromptBody()` hands the reviewer the 9-value origin enum but the only origin-specific instruction is *"Plans scoring BELOW threshold MUST be REQUEST_CHANGES with origin=plan-ambition."* So the reviewer reaches for `plan-ambition` as the generic "serious finding" bucket.

**(b) R2 grants a *single* reviewer-authored MAJOR `plan-ambition` unilateral hard-block authority.** `decideTerminal` blocks on `unresolved.some(isAntiBypassFinding)` — it does not distinguish the *system-injected* anti-bypass finding (the actual defense) from a *reviewer-authored* one. So one Codex mislabel = a 100%-user-visible hard fail, with no corroboration required (Gemini approved with zero findings).

## 3. Why prompt-only is insufficient (design-pass finding)

The user-approved direction was prompt-precision (relabel accuracy → `source-strategy`). The design-pass panel proved — from source — that prompt-precision alone is *necessary but insufficient* for a hard-fail surface: the reviewer is a stochastic LLM; crisp guidance lowers the mislabel **rate** but not to zero, and each residual miss fully blocks a legitimate paid job with no corroboration. The fix must also cap the **consequence** deterministically.

A rejected alternative (design-pass Proposal 1) recomputed the injection condition from `call.persona_depth_score` + `call.verdict`. This is **wrong against the code**: the stored `call.verdict` is the *post-*`adjustVerdictForAmbition` effective verdict (`plan-reviewer.ts:631/635`, `:736/740`). On the S79 null-punt path the injected MAJOR has already flipped the verdict off approve-like, so a recompute branch `if (score===null) return isApproveLike(call.verdict)` reads the already-flipped verdict and fails to fire on the very deficient plan it must block. The provenance-stamp design (below) avoids this entirely — it keys on a server-set flag, not on a verdict the system has already mutated.

## 4. Design

### Layer 1 — origin-routing precision (prompt; the user-approved direction)
- `buildReviewerPromptBody`: an "Origin selection rubric" block inserted between the findings-enum line and the `persona_depth_score` line. It states severity and origin are independent axes; reserves `plan-ambition` for persona-depth / scope-ambition / scope-ratchet / instruction-injection; routes ALL accuracy / citation / source-quality / verification findings (incl. an unverified statute/section) to `source-strategy` even at MAJOR severity; gives the decision rule "*if a better/verified source would resolve it → `source-strategy`; if only deeper/wider scope would → `plan-ambition`*"; and explicitly forbids `plan-ambition` as a generic "serious problem" bucket.
- `reviewerJsonInstruction` (`plan-transports.ts`): a one-line mirror. Both reviewer transports concatenate `buildReviewerPromptBody()` + `reviewerJsonInstruction()` (`plan-transports.ts:569-573` Gemini, `:712-716` Codex), so both reviewers receive both.
- No schema/enum change: `source-strategy` is already `ORIGINS[7]` and in the OpenAI strict enum.

### Layer 2 — deterministic backstop (provenance-stamped R2 split)
- **`ReviewFinding.injected?: boolean`** (`plan-types.ts`) — server-only marker.
- **Stamp `injected: true`** on the three system-injected findings in `ensurePersonaDepthFinding` (deficient score / null-punt+approve / hedge-bet). This is the *only* place it is ever set.
- **Sanitize inbound reviewer findings** at the top of `ensurePersonaDepthFinding` — strip any `injected` a reviewer payload might carry, so the marker is non-forgeable. *(Deviation from the synthesis, which put the strip inside `isValidFinding`: that type-guard is used as `findings.every(isValidFinding)` and is pure-read, so mutating it is a smell. `ensurePersonaDepthFinding` is the single chokepoint where reviewer findings + injected findings combine, runs after payload validation, and is non-mutating — a cleaner home. `isValidFinding` stays pure.)*
- **Predicates:** `isInjectedAntiBypass(f) = f.injected === true && isAntiBypassFinding(f)`; `isAuthoredAntiBypass(f) = f.injected !== true && isAntiBypassFinding(f)`. `isAntiBypassFinding` unchanged.
- **KEYSTONE — narrow the three suppression guards** in `ensurePersonaDepthFinding` from `isAntiBypassFinding` to `isInjectedAntiBypass`. Since `injected:true` is set only by this function and at most once per call, the guard now only prevents double-injection; a reviewer-authored MAJOR `plan-ambition` can **no longer suppress** the system injection. (Without this, the R2 split reopens the S86 §2.1 bypass — see §5 Step 3.)
- **`decideTerminal` R2 split:** **R2a** = `unresolved.some(isInjectedAntiBypass)` → unconditional block (the persona-depth gate). **R2b** = ≥2 distinct available reviewers each carry an `isAuthoredAntiBypass` finding → block (corroboration; with the current gemini+codex topology that means BOTH). A **lone** authored MAJOR `plan-ambition` is not consumed by R2 — it flows on as an ordinary unresolved MAJOR (R4 volume bound, else an R5 reservation surfaced to the user). Both rules keep the `"R2"` label.

**Unchanged (minimal blast radius):** `isAntiBypassFinding`; `adjustVerdictForAmbition` (always-on legacy path, S86 §4 deferred — dark-launch containment held); the three hardcoded MAJOR severities; `ladderEnforce` dark-launch; no schema/migration; `decideTerminal` stays pure (no `plan` param). The flag rides into `plan_reviews.findings` jsonb (no migration) and enriches the audit trail.

## 5. Security argument — the persona-depth invariant is preserved (and strengthened)

**Invariant:** a persona-deficient plan (`persona_depth_score` below threshold, OR `null` + approve-like, OR structural hedge-bet) STILL hard-blocks at the terminal round, with **zero** dependence on reviewer cooperation or labeling fidelity.

- **Step 1 — deficiency always injects.** `ensurePersonaDepthFinding` runs after the reviewer returns and before the call is built; each trigger pushes `{severity:MAJOR, origin:plan-ambition, injected:true}` unless the (now injected-only) guard sees a pre-existing *injected* finding. Because `injected:true` is set only here, no reviewer-authored finding can satisfy the guard ⇒ a deficient plan ALWAYS carries an injected MAJOR.
- **Step 2 — R2a fires.** `unresolved.some(isInjectedAntiBypass)` ⇒ block, reviewer-label-independent.
- **Step 3 — the keystone (the adversary's sharpest line).** On a deficient plan, a reviewer pre-emits an AUTHORED MAJOR `plan-ambition`. With the old guard (`isAntiBypassFinding`) it would satisfy `already` and SUPPRESS the injection ⇒ R2a sees nothing ⇒ R2b not corroborated (single reviewer) ⇒ the deficient plan ships — the exact S58.5/S79/S86-§2.1 bypass, reopened by the R2 split. **Closure:** the guard-swap to `isInjectedAntiBypass` means the authored MAJOR no longer satisfies `already`, so the injection ALWAYS fires ⇒ R2a. **Strictly stronger than S86** (which still let an authored MAJOR substitute for the injection). Proven by the `KEYSTONE` integration test — it fails if any guard is left as `isAntiBypassFinding`.
- **Step 4 — non-forgeability.** (1) OpenAI strict path: `additionalProperties:false` at the finding level (`plan-transports.ts:281`) — a reviewer cannot return `injected`. (2) Gemini / json_object fallback: `ensurePersonaDepthFinding` strips any inbound `injected` before re-stamping. (3) `injected` is set exclusively server-side, after payload validation. So no prompt-injection / compromised reviewer / malformed payload can mint `injected:true`, and none can cause the system to SKIP injecting on a deficient score. Proven by the `FORGED MARKER` test.
- **Named ways it could weaken (each handled):** (W1) revert a guard to `isAntiBypassFinding` → Step-3 bypass — caught by the KEYSTONE test. (W2) add `injected` to the schema or drop the strip → a forged marker would *over*-block (R2a on a forged finding) — net SAFE (never under-blocks), and the FORGED test guards it. (W3) loosen R2b below "≥2" → the S154 over-match returns; tightening can never under-block (R2a is independent). (W4) single-reviewer reduced-review: corroboration can't be met, so a lone available authored MAJOR falls to R4/R5 — acceptable per design intent; R2a stays independent.

**CLAUDE.md mandatory question** ("is this change covered by automated tests, and if not why?"): **Yes.** Every R2a branch (gap<0, null+approve, hedge-bet), the keystone authored-suppression attempt, the lone-authored 657161bb regression, corroborated-authored, R4 volume fall-through, forged-marker strip, and both prompt additions have deterministic `node:test` coverage (§7).

## 6. The semantic departure (flagged for the human owner)

The user's literal direction was "keep genuine scope/bypass as `plan-ambition` MAJOR (hard R2 block)." Under R2b, a **lone single-reviewer authored** MAJOR `plan-ambition` no longer hard-blocks — it needs corroboration, else becomes an R5 advisory reservation. This is **necessary** to deterministically fix the bug (a stochastic LLM will occasionally still mislabel; prompt-only leaves a residual hard-fail). The actual anti-bypass **invariant (R2a) is preserved and strengthened**, so this honors "do not weaken real bypass detection" — but it is a behavior change beyond the literal approval, and it is reversible (code-only). Surfaced to the owner for review; the tri-vendor gate stress-tests R2b + the keystone specifically.

**Reduced-review interaction (Gemini INFO):** in single-reviewer mode (`availableCalls.length===1`, one reviewer UNAVAILABLE), the R2b corroboration (`>=2`) can never be met, so a genuine organic scope finding from the lone available reviewer falls to R5 instead of blocking. Acceptable per design intent — R2a (the persona-depth gate) stays fully independent and unconditional — but explicitly noted. Telemetry follow-on: track lone-authored `plan-ambition`→R5 rate segmented by single-reviewer mode (separable, not in this chunk).

## 7. Test coverage (added/changed)
- **Re-baselined** (`plan-reviewer-convergence.test.ts`): the two existing single-reviewer authored-MAJOR-`plan-ambition`→R2 assertions (former test:208, :290) now use a `MAJOR_INJ` helper (`injected:true`) so they assert the **R2a** invariant they were always meant to test. The precedence test now uses `MAJOR_INJ` so it proves R1 outranks a *real* R2a trigger.
- **New pure `decideTerminal` tests:** lone-authored→R5 (657161bb regression, note surfaced); correctly-labelled authored `source-strategy`→R5; corroborated authored→R2b; lone-authored + 2 MAJOR→R4; R2a-with-one-reviewer.
- **New integration tests:** KEYSTONE (deficient + authored MAJOR → injection still fires → R2); FORGED MARKER (reviewer `injected:true` on a non-deficient plan stripped → lone → R5).
- **New prompt-content tests:** `buildReviewerPromptBody` carries the rubric + correct ordering; `reviewerJsonInstruction` carries the mirror.
- **Regression green:** the S86 injection-guard integration tests (deficient score + organic MINOR) stay green — the injected MAJOR now carries `injected:true` and the authored MINOR doesn't satisfy the injected-only guard, so the injection still fires → R2.

## 8. Open questions for the gate
1. **KEYSTONE (Codex grounded, highest priority):** confirm all three guards at `ensurePersonaDepthFinding` are `isInjectedAntiBypass`; construct the deficient-plan + authored-MAJOR counterexample and verify the injected MAJOR is still added and terminal is R2. A guard left as `isAntiBypassFinding` is a CRITICAL persona-depth bypass.
2. **Non-forgeability across ALL paths (Codex grounded):** verify no reviewer-reachable path mints `injected:true` (OpenAI strict reject; the `ensurePersonaDepthFinding` strip on Gemini/json_object; no raw_json/integration passthrough).
3. **Sanitize placement (Codex grounded):** confirm the strip in `ensurePersonaDepthFinding` (vs the synthesis's `isValidFinding`) covers every path that builds `call.findings`, and that `isValidFinding` staying pure is correct.
4. **R2b corroboration threshold (Gemini holistic + Codex):** is "≥2 available reviewers each raise one" the right bar? It can never under-block the persona gate (R2a independent); it is the minimal change that fixes the lone-authored over-fire while preserving S86's two-model-agreement principle.
5. **Re-baseline fidelity (both):** confirm the two re-baselined assertions are correctly reclassified (injected-style), and no test passes for the wrong reason.
6. **Prompt efficacy / residual (Gemini holistic):** is the Layer-1 rubric strong enough that a stochastic reviewer routes accuracy/verification findings to `source-strategy`? A deferred (NOT-in-this-chunk) lever is a score-gated post-review reclassifier; confirm that is the right separable follow-on.

## 9. Decision
Adopt **Layer 1 (prompt-precision) + Layer 2 (provenance-stamped R2 split with the injected-only guard keystone)**. Prompt cuts the mislabel rate; the provenance split caps the consequence deterministically while preserving (and strengthening) the persona-depth anti-bypass invariant. Defer the score-gated post-review reclassifier as a separable, measured follow-on.
