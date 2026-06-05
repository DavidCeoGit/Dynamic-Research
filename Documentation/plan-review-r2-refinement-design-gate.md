# Plan-Review R2 Anti-Bypass Refinement — Gate-Semantics Design (DESIGN gate)

**Session:** S86 (2026-06-03 UTC)
**Status:** v3 — Codex round-2 (code-grounded) caught a **CRITICAL** that Gemini's
holistic v1 missed: the injection *suppression guards* are also severity-agnostic,
so fix (a) as written (R2-only) reopens the persona-depth bypass. v3 integrates it
— the fix is now a single shared `isAntiBypassFinding()` helper applied at **4**
sites (R2 + 3 injection guards), plus Codex's MAJOR regression test. Pending Codex
fidelity QA on v3. Follow-on to `plan-review-convergence-design-gate.md` (S84 v3) +
the S85 implementation (`03b3a0d`, dark-launched).
**MRPF:** DESIGN gate × **AGENT BEHAVIOR** (refines the convergence classifier
that gates every research job) × NORMAL. Companion artifact:
`plan-review-r2-refinement-design-gate-peer-review.md`.
**Author:** Claude (S86)

---

## 1. Problem statement

S85 shipped the severity-graded terminal ladder (`decideTerminal()` in
`agent/lib/plan-reviewer.ts`) dark-launched behind `PLAN_REVIEW_LADDER_ENFORCE`
(default OFF). The S84 design (§4 "e18e1931 under the new gate") **predicted**
the motivating job `e18e1931` would compute **R5** (proceed-with-reservations)
and therefore ship once enforcement is flipped on.

The S85 live dark-launch validation (~$0.49, re-queued `e18e1931`) **falsified
that prediction**. The worker logged:

```
verdict=REQUEST_CHANGES iters=2 calls=7 cost=$0.42 terminal=R2 reservations=0
```

The ladder computed **R2** (anti-bypass hard-block), **not R5**. Flipping
`PLAN_REVIEW_LADDER_ENFORCE=true` as-is would **NOT** ship `e18e1931` — the
convergence fix fails on its own motivating case.

### Why the S84 prediction was wrong

S84 §4 asserted e18e1931's terminal round had "**no `plan-ambition`**" findings.
That came from the S84 `plan_reviews` telemetry table, which did **not** surface
the `origin` field per finding. The live re-run showed Codex emitted **MINOR**
`plan-ambition` findings — organic quality notes such as *"right-size deliverables
to the 30–60 min / $10–30 budget"* and *"right-size sampling to budget"*. These
are legitimate reviewer refinements, **not** the system-injected persona-depth
finding the R2 anti-bypass rung was built to catch.

## 2. Root cause — R2 predicate is severity-agnostic

`decideTerminal()` (`plan-reviewer.ts:420`):

```js
const anyAntiBypass = unresolved.some((f) => f.origin === "plan-ambition");
...
if (anyAntiBypass) return { rule: "R2", wouldApprove: false, reservations: [] };
```

R2 fires on **any** `plan-ambition` finding regardless of severity. But the
anti-bypass invariant it protects (S58.5 / S79) is exclusively about the
**system-injected** findings, all three of which are hardcoded `severity:
"MAJOR"`:

| Injection site (`plan-reviewer.ts`) | Trigger | Severity |
|---|---|---|
| `ensurePersonaDepthFinding` L301 | persona-depth score below threshold | **MAJOR** |
| `ensurePersonaDepthFinding` L337 | `score === null` + approve-like (S79 punt-bypass) | **MAJOR** |
| `ensurePersonaDepthFinding` L349 | structural hedge-bet pattern | **MAJOR** |

`plan-ambition` is also a **reviewer-authorable** origin (it appears in the
reviewer rubric prompt, `plan-reviewer.ts:213`). So a reviewer can legitimately
tag a **MINOR** budget-right-sizing note as `origin: plan-ambition`. R2 cannot
distinguish "the gate's own injected MAJOR" from "a reviewer's organic MINOR."

**The predicate is broader than the invariant.** That is the first half of the bug.

## 2.1 The injection *suppression* guards are ALSO severity-agnostic (Codex round-2 [CRITICAL])

R2-only is **not** invariant-preserving. `ensurePersonaDepthFinding` suppresses each
MAJOR injection with a severity-agnostic "already present" guard:

```js
// L298, L334, L346 — all three injection branches
const already = findings.some((f) => f.origin === "plan-ambition");
if (!already) findings.push({ severity: "MAJOR", origin: "plan-ambition", ... });
```

**The bypass:** a reviewer returns a *deficient* persona-depth score (`gap < 0`, or
`score === null` + approve-like, or hedge-bet structure) **AND** organically emits a
**MINOR** `plan-ambition` note. The guard sees the MINOR → `already === true` → the
**MAJOR injection is suppressed**. Net findings now contain only a MINOR
`plan-ambition`. Under R2-MAJOR+ that MINOR falls through → R3 (other reviewer
approves) → R5 **proceeds**. A genuinely persona-deficient plan ships. That is
exactly the bypass S58.5/S79 closed, reopened by narrowing R2 alone.

**Why this didn't bite the always-on legacy path:** `adjustVerdictForAmbition`
(severity-agnostic) still flips the reviewer's verdict to REQUEST_CHANGES on the
MINOR, so pre-ladder the per-reviewer gate caught it. The ladder's R2 reads finding
*severity* directly, not verdict — so narrowing R2 without narrowing the guards
exposes the hole only in the ladder.

**Fix:** narrow the suppression guards to the same MAJOR+ predicate as R2, so an
organic MINOR no longer suppresses the MAJOR injection. With a deficient score, a
MAJOR `plan-ambition` is **always** injected → R2 fires correctly. Unify all four
call sites behind one helper (next section) so the predicate cannot drift apart
again ([[feedback_within_artifact_reviewer_blindspot]]: identical logic repeated
across sites must be a single source of truth).

## 3. Options

### (a) — Unified MAJOR+ anti-bypass predicate at all 4 sites  ← RECOMMENDED (v3)
A single shared helper, applied to R2 **and** the three injection suppression guards
(§2.1):
```js
// new module-level helper — single source of truth for "anti-bypass finding"
function isAntiBypassFinding(f: ReviewFinding): boolean {
  return f.origin === "plan-ambition" &&
         (f.severity === "MAJOR" || f.severity === "CRITICAL");
}
// decideTerminal R2:
const anyAntiBypass = unresolved.some(isAntiBypassFinding);
// ensurePersonaDepthFinding ×3 guards:
const already = findings.some(isAntiBypassFinding);
```
- **Cleanest.** The three injected findings are always MAJOR, so the S58.5/S79
  invariant is preserved **verbatim** — every injected anti-bypass finding still
  trips R2, and (v3) the guards no longer let an organic MINOR suppress that
  injection. One predicate, four call sites, zero drift surface.
- Reviewer-authored **MINOR** `plan-ambition` notes fall through R2 and are
  handled by the existing rungs: counted toward the R4 MAJOR-volume bound only
  if MAJOR (MINORs are not), otherwise surfaced as **R5 reservations** — exactly
  where advisory budget-notes belong.
- A reviewer-authored **MAJOR** `plan-ambition` finding still blocks at R2. This
  is correct: a reviewer asserting a *major* ambition/right-sizing defect is a
  real signal, not noise. (It is also indistinguishable in kind from the injected
  MAJOR, and blocking is the safe default.)

### (b) — Sentinel-mark the injected finding
Tag the injected findings (e.g. `origin: "plan-ambition-injected"` or a boolean
`injected: true`) and have R2 match only the sentinel.
- **Rejected.** Adds a parallel origin/flag that every consumer
  (`adjustVerdictForAmbition`, the rubric prompt, telemetry, tests) must learn.
  More state, more drift surface, no behavioral gain over (a) — because the only
  reviewer-authorable case we want to keep blocking (MAJOR ambition) is precisely
  what (a) already keeps. (b) would let a reviewer-authored MAJOR ambition finding
  through, which is *less* safe than (a).

### (c) — Integration strips MINOR `plan-ambition`
Have the integration step delete MINOR `plan-ambition` findings before the
terminal computation.
- **Rejected.** Destroys signal: a MINOR ambition note is still a valid
  reservation the user should see in the completion email (§5b of the S84
  design). Stripping it removes it from the R5 `reservations[]` payload entirely.
  Also widens blast radius into the integration prompt (an LLM step), trading a
  deterministic one-line guard for a non-deterministic one.

**Recommendation: (a).** Minimal, deterministic, invariant-preserving, and it
keeps MINOR notes as advisory reservations rather than discarding them.

## 4. The parallel over-match in `adjustVerdictForAmbition` — DEFER (R2-only this chunk)

`adjustVerdictForAmbition()` (`plan-reviewer.ts:368`) has the **same**
severity-agnostic shape:

```js
const hasAmbition = findings.some((f) => f.origin === "plan-ambition");
if (hasAmbition && isApproveLike(verdict)) return "REQUEST_CHANGES";
```

It flips a reviewer's approve-like verdict to REQUEST_CHANGES on **any**
`plan-ambition` finding, including a MINOR. So in e18e1931, Codex's MINOR
budget-note flips Codex's per-reviewer verdict to REQUEST_CHANGES.

**This does NOT block e18e1931 after fix (a)**, because the trace is:

- Gemini: APPROVE, no `plan-ambition` → stays APPROVE → `anyApproveLike = true`.
- Codex: MINOR `plan-ambition` → flipped to REQUEST_CHANGES (unchanged by (a)).
- `decideTerminal`: R1 no (no CRITICAL), **R2 no (fix a — only MINOR ambition)**,
  R3 no (Gemini approve-like), R4 no (≤2 MAJORs) → **R5**. ✅

**Should `adjustVerdictForAmbition` also narrow to MAJOR+? — NO, not in this
chunk.** Three reasons:

1. **Blast-radius containment.** `decideTerminal` is gated behind the
   `PLAN_REVIEW_LADDER_ENFORCE` dark-launch flag. `adjustVerdictForAmbition`
   feeds the **always-on legacy path** — per-round convergence and the
   `allApprove` early-exit (`plan-reviewer.ts:836`). Narrowing it changes shipped
   behavior **outside** the flag's protection. The dark-launch flag is the entire
   safety story; touching the always-on path in the same chunk breaks containment.

2. **Transparency is *better* if we leave it.** If we narrowed
   `adjustVerdictForAmbition`, a reviewer with a MINOR `plan-ambition` note +
   approve-like raw verdict would stay approve-like → `allApprove` could be true
   → the plan takes the **silent `allApprove` early-exit (APPROVED, no
   reservations recorded)** before ever reaching the ladder. The MINOR concern
   would vanish. Leaving `adjustVerdictForAmbition` as-is routes contested-MINOR
   plans to the terminal ladder, where R5 captures the note as a surfaced
   reservation (§5b). **R2-only is strictly better for surfacing.**

3. **Separable, reviewable on its own merits later.** If the residual edge below
   ever bites, narrowing `adjustVerdictForAmbition` is its own scoped MERGE chunk
   with its own review.

### Residual edge case (documented limitation)

If **both** reviewers emit **only** MINOR `plan-ambition` notes and both would
otherwise be approve-like: `adjustVerdictForAmbition` flips **both** to
REQUEST_CHANGES → `anyApproveLike = false` → **R3 blocks** even after fix (a).

- **Likelihood: low.** Requires both reviewers to converge on minor budget notes
  as their *only* findings while both otherwise approving — and Codex empirically
  never returns approve-like on open-ended plans (S84 root-cause #1), so the
  "both approve-like" precondition is itself rare.
- **Severity if it happens: acceptable.** Two independent reviewers both flagging
  ambition — even minor — is a weak-but-real "this plan is under-scoped" signal;
  R3-blocking is a defensible outcome, not a correctness failure.
- **Action:** documented as a known limitation + S87 carry-forward. Not fixed in
  this chunk.

## 5. e18e1931 under the refined gate

Terminal round (final-round `availableCalls`, per §6.5 of S84 design):
Gemini APPROVE / Codex REQUEST_CHANGES; unresolved = 2 non-critical MAJOR (the
methodology refinements) + several MINOR (incl. MINOR `plan-ambition` budget
notes), no CRITICAL, **no MAJOR `plan-ambition`**.

→ R1 no · R2 **no (fix a)** · R3 no (Gemini approve-like) · R4 no (2 MAJORs ≤ 2)
→ **R5 APPROVED with reservations.** Ships once enforcement is flipped (S87).

This is exactly what S84 §4 intended; fix (a) makes the implementation match the
design's stated intent.

## 6. Implementation surface (minimal blast radius)

| File | Change |
|---|---|
| `agent/lib/plan-reviewer.ts` (new helper) | Add `isAntiBypassFinding(f)` — `origin === "plan-ambition" && severity ∈ {MAJOR, CRITICAL}`. Single source of truth. |
| `agent/lib/plan-reviewer.ts:420` | `anyAntiBypass = unresolved.some(isAntiBypassFinding)`. |
| `agent/lib/plan-reviewer.ts:298,334,346` | Replace the three `already` guards with `findings.some(isAntiBypassFinding)` (Codex CRITICAL — guards must not let organic MINOR suppress MAJOR injection). |
| `agent/lib/plan-reviewer.ts` (doc comment L410) | Update R2 comment: "any MAJOR+ `plan-ambition`". |
| `agent/test/plan-reviewer-convergence.test.ts` | Add boundary tests (§7). |

No new types, no enum change, no DB migration, no `executor.ts` / `notify.ts`
change, no flag change. `decideTerminal` stays a pure function.

**Blast-radius note (the guard change touches the always-on path):**
`ensurePersonaDepthFinding` feeds the non-dark-launched legacy path. The guard
narrowing only *adds a MAJOR `plan-ambition` injection in cases where today a MINOR
exists* — it **strengthens** the gate, never weakens it. In the always-on path,
`adjustVerdictForAmbition` already flipped the verdict on the MINOR, so adding the
MAJOR does not change the per-reviewer verdict outcome; it only gives the ladder the
correct MAJOR finding to act on. Net legacy behavior is unchanged; only the
dark-launched ladder gains correct R2 firing. The dark-launch flag remains the
deploy boundary for the *R5-proceed* behavior; flipping it is S87 work after R5 is
re-confirmed live.

## 7. Test plan (additions to `plan-reviewer-convergence.test.ts`)

1. **MAJOR `plan-ambition` → R2 blocks** (invariant preserved — the injected-style
   finding). Mixed verdicts, one approve-like, MAJOR `plan-ambition` present →
   `decideTerminal` returns `R2`.
2. **CRITICAL `plan-ambition` → R1** (R1 outranks R2; ensures the CRITICAL arm of
   the new predicate never shadows R1). Returns `R1`.
3. **MINOR `plan-ambition` only, one approve-like, ≤2 MAJOR → R5** (the e18e1931
   shape; the new pass-through). Returns `R5`, reservations include the MINOR
   `plan-ambition` finding.
4. **MINOR `plan-ambition` + 3 MAJOR (non-ambition) → R4** (MINOR ambition falls
   through R2 but R4 volume bound still fires on the unrelated MAJORs). Returns
   `R4`.
5. **MINOR `plan-ambition` + no approve-like reviewer → R3** (documents the
   residual edge — both-reject still blocks even with only-MINOR ambition).
   Returns `R3`.
6. **Two-reviewer transparency test (Gemini round-1 [MINOR]) — locks in the §4
   deferred behavior.** `availableCalls = [ {gemini, APPROVE, no findings},
   {codex, REQUEST_CHANGES (the post-`adjustVerdictForAmbition` effective verdict
   for a raw-APPROVE + MINOR `plan-ambition`), findings:[MINOR plan-ambition]} ]`.
   Assert: `decideTerminal` returns **R5**, and `reservations` **includes** the
   MINOR `plan-ambition` finding. This concretely proves the transparency claim:
   the MINOR ambition note falls through R2 (fix a), the plan survives R3 (Gemini
   approve-like), and the note is preserved as a surfaced reservation rather than
   silently discarded. (Note: `decideTerminal` is a pure function over
   already-adjusted `availableCalls`; the verdict flip itself is covered by
   existing `adjustVerdictForAmbition` unit tests — this test asserts the
   ladder's handling of the flip's *output*.)
7. **Guard regression (Codex round-2 [MAJOR]) — the §2.1 bypass.** Exercise
   `ensurePersonaDepthFinding` (or the `reviewPlan` transport path) with a
   **deficient** persona-depth score (`gap < 0` and separately `score === null` +
   approve-like) **plus a pre-existing organic MINOR `plan-ambition`** finding.
   Assert: a **MAJOR** `plan-ambition` finding **is** injected (guard does not
   suppress on the MINOR), and the resulting terminal decision is **R2**. This is
   the test that proves the bypass is closed; without the guard fix it would show
   the MAJOR missing and the ladder reaching R5.
8. **Regression:** the existing 16 S85 tests remain GREEN unchanged (the injected
   findings are MAJOR, so every existing R2 assertion still holds, and the unified
   helper matches MAJOR/CRITICAL identically to the old inline checks for those).

Run: `pnpm test` (storage-path grep + `tsc --noEmit` agent + frontend + node:test).

## 8. Open questions for reviewers

- **Q1 (Gemini, holistic):** Is deferring the `adjustVerdictForAmbition` narrowing
  (§4) the right call, or does leaving the two predicates inconsistent (R2 =
  MAJOR+, per-reviewer gate = any-severity) create a maintenance hazard worth
  paying the blast-radius cost now? My position: defer — the inconsistency is
  *intentional and documented*, and the transparency argument (§4.2) makes them
  correctly different, not accidentally inconsistent.
- **Q2 (Codex, code-grounded):** Verify the trace in §4/§5 against the actual
  control flow — specifically that `availableCalls[].verdict` is the
  **post-`adjustVerdictForAmbition`** effective verdict (L610/L716) and that
  `decideTerminal` reads `.findings` = the **augmented** array (incl. injected
  findings). Confirm fix (a) cannot inadvertently let a *real* injected
  persona-depth bypass through (it can't, since injected = MAJOR, but verify).
- **Q3 (both):** Should the R4 volume bound count MINOR `plan-ambition` toward
  anything? Current design: no (only MAJOR counts toward R4). Concur?

**Codex round-2 resolutions (integrated v3):** [CRITICAL] the suppression guards are
severity-agnostic → R2-only reopens the persona-depth bypass; fixed by narrowing all
three guards behind the shared `isAntiBypassFinding` helper (§2.1, §3a, §6). [MAJOR-2]
the e18e1931 R5 trace is otherwise correct against the code (verdicts post-adjust at
L610/L716, terminal reads final-round `availableCalls`, R5 returns reservations).
[MINOR] §4 deferral + transparency argument confirmed factually correct against the
code (silent early-exit at L827-846 does not pass `terminalDecision`/`reservations`;
only the max-round branch L855-876 does). [MAJOR-4] added the guard regression test
(§7.7). Codex Q2 answered: fix (a) v3 cannot let an injected persona-depth bypass
through — with the guard fix a deficient score always injects a MAJOR.

**Gemini round-1 resolutions (integrated v2):** Q1 — strongly concur with deferring
`adjustVerdictForAmbition` narrowing; the transparency argument is "mathematically
correct and functionally superior" (narrowing would route MINOR-ambition plans to
the silent `allApprove` early-exit, discarding the note before R5). Q3 — concur, R4
must NOT count MINORs of any origin (would break severity semantics). Residual edge
(§4.3) — acceptable to document-and-defer; two independent models flagging scope/
budget is a strong-enough combined signal to justify R3 even when individually MINOR.
Added the two-reviewer transparency test (§7.6) per Gemini's MINOR.

## 9. Decision

Adopt **(a) v3**: a shared `isAntiBypassFinding()` helper (`origin === "plan-ambition"
&& severity ∈ {MAJOR, CRITICAL}`) applied at **4 sites** — `decideTerminal` R2 and the
three `ensurePersonaDepthFinding` suppression guards (Codex CRITICAL). Add the §7
boundary tests incl. the guard regression (Codex MAJOR). Defer `adjustVerdictForAmbition`
narrowing to S87+ as a documented, separable limitation. Re-validate `e18e1931`
dark-launched (expect **R5**) before any enforcement flip.

A persona-deficient plan with only an organic MINOR `plan-ambition` now correctly
injects a MAJOR and blocks at **R2** (bypass closed); a non-deficient plan with an
organic MINOR `plan-ambition` correctly falls through to **R5** with the note as an
advisory reservation (the e18e1931 case). The two outcomes are now distinguished by
*whether the persona gate fired a MAJOR*, which is exactly the invariant.
