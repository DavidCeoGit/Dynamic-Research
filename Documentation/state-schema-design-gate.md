# state.json Validation Schema — DESIGN gate

> **Status:** v3 — authored S179 (2026-06-26). Sequential §11 tri-vendor DESIGN
> gate CLEARED: Gemini holistic-adversarial (BLOCK on v1 Zod → recommended DEFER)
> + Codex grounded-adversarial (ENDORSE v2 DEFER-lead, every claim grounded with
> executed counterexamples). **Unanimous outcome: DEFER** the build; the audit
> item is closed-with-rationale. Companion review (both verdicts verbatim +
> synthesis) at `Documentation/state-schema-design-gate-peer-review.md`.
> **Scope of this gate:** the DESIGN only. Implementation (the MERGE gate) is a
> deliberately separate follow-on session.
> **Origin:** `Documentation/code-review/2026-06-24-audit.md` MEDIUM —
> *"`state.json` is `JSON.parse`d and cast `as PipelineState` at 4 sites with no
> shape validation; add `agent/lib/state-schema.ts` (Zod) + a `_version` field."*

## v2 changelog — Gemini 3.1-pro-preview holistic-adversarial review (verdict: BLOCK)
Gemini's BLOCK was correct and **pivots the design**. It validated all of §3's
constraints and the D2/D4 recommendations, but blocked v1's two load-bearing
choices:
- **Zod is rejected (D1).** A *new* `zod` dep for a *hyper-lenient* schema is
  gold-plating against the `plan-types.ts` precedent — AND `z.infer` from an
  all-optional schema produces a type whose required fields (`userContext`,
  `selectedProducts`) become optional, **conflicting with the canonical required
  `PipelineState`** → forces a `types.ts` rewrite, `undefined` checks everywhere,
  or an `as PipelineState` cast anyway (defeating the purpose). → **plain-TS.**
- **Eager boundary-validation is rejected (D3/D5/§5).** Two states the pipeline
  writes TODAY would be falsely rejected by a strict read-boundary schema (new
  §3.8/§3.9): a **numeric `phase: 7`** (LLMs write numbers; `evaluateCompletion`
  already coerces via `parseFloat(String())`) and **`publish_required: "yes"`**
  (rejecting at the read boundary both stalls the job AND **silences the S120
  `[SECURITY]` diagnostic** `logPublishFlagDiagnostics` that is *designed* to
  fire on exactly that value). Validating too early regresses recovery and
  disables a security-observability feature.
- **"Defense in depth" is incoherent (D6).** If a boundary filter removes
  non-primitives, the downstream S166/S168 guards become unreachable dead code
  and their 27 tests assert on impossible states.

**Net effect:** v1's "build a lenient Zod schema at the read chokepoint" is
*net-negative*. v2 reframes the gate around the two outcomes that survive
Gemini's critique — **(A) a minimal plain-TS consolidation, or (B) DEFER/CLOSE
the audit item** — and asks Codex to ground-check which. The lead recommendation
is **(B) DEFER**, with (A) tightly scoped as the only build-worthy alternative
(§7a).

## v3 changelog — Codex gpt-5.5 (xhigh) grounded-adversarial review (verdict: ENDORSE)
Codex read the live tree and **executed counterexamples** (ran
`evaluateCompletion({phase:7})` → `success:true`; ran
`logPublishFlagDiagnostics("yes")` → emitted the `[SECURITY]` alarm). All six
verification tasks returned **CONFIRMED**, ratifying the DEFER direction, with
two grounded refinements integrated below:
- **§3.9 strengthened.** The S120 `[SECURITY]` alarm fires on BOTH the
  full-pipeline (`executor.ts:413`) AND studio_only (`executor.ts:774`) paths —
  not studio_only-only as v2 implied. Early read-boundary rejection of a
  non-boolean publish flag would suppress it on the MAIN path too.
- **§5/§6/§7 cost corrected (Codex MINOR, PARTIAL).** Option A is NOT "import
  re-points only": `summarizeStateProgress` shares the private `PHASE_MAP` with
  `evaluateCompletion` (`state-evaluation.ts:8,317`) — moving one without the
  other splits a shared constant — and `watch-state-progress.test.ts` has **9
  more tests** beyond the 27 in `state-coercion-guards.test.ts` (≈36 tests
  relocate, not 27). Still behavior-preserving, but the churn is larger than v2
  stated — which *strengthens* the DEFER lead.
- **§9.6 — one hardening opportunity (not a must-build bug).**
  `enforceStudioCompleteness` reads `state.notebook_id` WITHOUT
  `recoverableNotebookId` (`studio-completeness.ts:224`), but it **fails closed**
  via `realListArtifacts` catching invalid spawn args → `null`
  (`nlm-artifact-cli.ts:99`), so it neither crashes nor passes. A candidate to
  route through the guard IF option A ever proceeds; not a defect today.

Codex confirmed **no latent must-build bug** at any of the 4 cast sites — the
acute crash/fail-open classes are all already guarded. DEFER stands.

---

## 1. Problem

`state.json` is the durable, on-disk runtime state of a research job. It is
**written by the spawned `claude -p` `/research-compare` subprocess** (NOT the
worker) and **read back by the worker** at four sites, each via an unchecked
`JSON.parse(...) as PipelineState` cast:

| # | Site | Consumer | What it reads | On bad data today |
|---|---|---|---|---|
| 1 | `lib/read-state-file.ts:108` | `watchStateFile` (5s progress poll) **and** `readStateForRecovery` (duration-kill recovery) — both flow through `readPipelineState` | `phase`, `phase_status`, `notebook_id` | classified `corrupt`/`io-error`/`absent` (JSON-level only); shape unchecked → `as PipelineState` |
| 2 | `lib/state-evaluation.ts:257` | `verifyPipelineCompletion` → `evaluateCompletion` (gates job success **and** feeds the PUBLISH gate) | `phase`, `phase_status` | own read; `as PipelineState`; pure guards catch non-primitive `phase`/`phase_status`, COERCE numeric phase |
| 3 | `executor.ts:675` | recovery-path read | (state object) | `as PipelineState` |
| 4 | `executor.ts:760` | `studio_only` PUBLISH-gate read | `publish_verification`, `publish_required` | `as PipelineState`; gate re-validates structurally + emits the S120 alarm |

The cast is a **runtime lie**: the type says `PipelineState`, but the bytes are
whatever an LLM-driven subprocess serialized. The team already knows this — the
defense is a *scatter* of point guards (`isNonPrimitiveStateField`,
`recoverableNotebookId`, `evaluateCompletion`'s object guard + `parseFloat`
coercion, `coerceDisplay`/`isPublishFlagSet`/`diagnosePublishFlag` in the publish
gate, the `readPipelineState` "is it a JSON object" check). There is no single
typed contract — but, post-Gemini, that turns out to be **deliberate and
correct**, because different consumers need different tolerance (§3.8).

---

## 2. Goal / non-goal

**Goal.** Decide whether centralizing state-shape validation ADDS net safety, and
if so specify the minimal change that does so WITHOUT regressing any live path.

**Non-goals (this iteration).**
- NOT replacing the publish-gate's hand-rolled `publish_verification` validator
  (§3.5) — hardened + security-load-bearing; out of scope.
- NOT making the worker reject any state the pipeline currently writes (§3.2/3.3/
  3.8/3.9 — hard constraint).
- NOT adding a runtime dependency (Gemini D1) — plain-TS only.
- NOT changing what `/research-compare` writes, except the version field is
  discussed as cross-boundary follow-up only (§3.4/D4).

---

## 3. Critical constraints (verify-first findings; §3.1–3.7 validated by Gemini, §3.8–3.10 added from its review)

### 3.1 The writer is an untrusted LLM subprocess
`lib/job-manifest.ts` instructs the spawned `claude -p` to *"update the
state.json file at every checkpoint."* The worker never writes it. So validation
faces adversarial-ish input: fields can be missing, mistyped, stringified,
non-primitive, or hallucinated. Every existing guard fails *closed* and never
trusts the declared TS type.

### 3.2 The real file is a SUPERSET of `PipelineState`
A live completed `state.json` has **38 top-level keys**; `PipelineState`
declares ~22 (extra: `job_id`, `organization_id`, `mode`, `current_date`,
`urgent_signoff_present`, `tier1_stats`, `completion_note`, …; `userContext`
carries 10 keys vs the interface's 5). → any `.strict()` schema rejects every
real file. Must passthrough.

### 3.3 `watchStateFile` reads PARTIAL, in-flight states
The 5s poll reads `state.json` *while the subprocess is still writing it*. Early
states legitimately lack `artifacts`, `publish_verification`, terminal `phase`,
`selectedProducts`. → almost everything is legitimately absent at some point;
a "required field" check is a false-reject machine.

### 3.4 A `version` field ALREADY exists — and is `2`, not `1`
`PipelineState.version: number`; the manifest seeds `1`, the CLI overwrites to
`2`. There is already a CLI-owned state-format version. A worker-added `_version`
is inert (the worker doesn't write the file). **Gemini: "your reasoning is
entirely correct."** Reuse `version`; a worker-controlled epoch needs a
coordinated `/research-compare` change, tracked separately. (Cf. `plan-types.ts`
`PLAN_SCHEMA_VERSION` — a different, plan-only version; do not conflate.)

### 3.5 The publish-gate validator is hardened + security-load-bearing
`lib/publish-gate.ts` is a complete fail-closed validator of
`publish_verification` carrying accreted reviewer CRITICALs (defect-collection,
`coerceDisplay` S168, control-char stripping S120, `MAX_CLAIMS`, per-claim ISO/
http(s)/closed-set checks S108, the "no live leg even under URGENT bypass"
floor), guarded by 50 tests. Re-expressing it in any new validator risks
regressing a security boundary for no gain. Leave it untouched. **Gemini concurs.**

### 3.6 The existing guards already cover the acute crash class
`isNonPrimitiveStateField` + `evaluateCompletion`'s object guard +
`summarizeStateProgress` already prevent "non-primitive field → `Cannot convert
object to primitive value` → unhandled rejection → orphaned job" (S166/S168, 27
tests). So a new validator's job would be *consolidation*, not closing an open
hole. **Gemini: "the plain-TS S166/S168 guards already handle the acute crash
class perfectly."**

### 3.7 Zod was deliberately avoided in agent/
`agent/package.json` = 7 runtime deps, no `zod`. `plan-types.ts` chose plain-TS
*"to keep the sandbox foundation free of net-new lockfile changes,"* returning
the `{ valid, errors }` shape *"so swapping in Zod later is mechanical."* → the
house style is already plain-TS validators.

### 3.8 (NEW — Gemini CRITICAL 2.1) The existing code is MORE tolerant than a naive schema
`evaluateCompletion` accepts a **numeric** `phase` by coercing
(`parseFloat(String(phaseRaw))`, `state-evaluation.ts:305-312`). LLMs frequently
write `"phase": 7` (number) not `"7"` (string). A boundary schema declaring
`phase: string` would reject a numeric phase as "invalid" → `watchStateFile`
pauses progress, `readStateForRecovery`/`verifyPipelineCompletion` drop a
*completed* run. **A boundary validator must never be stricter than the consumer
it feeds.** This is the core reason eager validation is unsafe here.

### 3.9 (NEW — Gemini CRITICAL 2.2) Early rejection SILENCES a security diagnostic
`publish_required: "yes"` (a non-boolean) is *intentionally* let through to the
publish gate, where `logPublishFlagDiagnostics`/`diagnosePublishFlag` (S120)
emit a `[SECURITY]` alarm flagging a bypassed normalization boundary. If a read-
boundary validator rejected `"yes"` outright, the state never reaches the
executor, the job stalls as "invalid," **and the security alarm never fires.**
Validation *placement* has security-observability consequences — validating too
early removes a feature.

### 3.10 (NEW — Gemini CRITICAL 1.b) `z.infer`-optional vs required-`PipelineState` type conflict
A lenient schema makes every field optional; `z.infer` then yields a
`ValidatedPipelineState` whose `userContext`/`selectedProducts` are `T |
undefined`, which is NOT assignable where the codebase expects the required
`PipelineState`. Resolving it means rewriting `types.ts` (huge blast radius),
adding `undefined` checks at every consumer, or casting `as PipelineState`
anyway. → any validator must NARROW `unknown` to the EXISTING `PipelineState`
type, not emit a new inferred one.

---

## 4. Decision forks — resolved after Gemini

| Fork | v1 lead | Gemini | v2 resolution |
|---|---|---|---|
| **D1** Zod vs plain-TS | Zod (4.3.6) | **BLOCK → plain-TS** (gold-plating + §3.10 type conflict) | **plain-TS**, returning the existing `PipelineState`; no dependency |
| **D2** scope (exclude publish-gate) | exclude | concur ("pragmatic, coherent") | **exclude** — publish-gate untouched |
| **D3** strictness | lenient | **lenient is right, but DON'T validate eagerly at the boundary** (§3.8/3.9) | **no eager boundary reject**; any validator must be ≥ as tolerant as each consumer |
| **D4** versioning | reuse `version` | concur ("entirely correct") | **reuse `version`**; CLI epoch is separate follow-up |
| **D5** `"invalid"` kind | new kind | OK only if it carries `issues[]` AND doesn't cause §3.8/3.9 rejects | **do not add a rejecting `"invalid"` at the read boundary**; see §5 |
| **D6** absorb guards | absorb | absorb ⇒ DELETE originals + migrate the 27 tests, else dead code | absorb ONLY under option (A); behavior-identical; tests migrated |

---

## 5. What can actually be built safely (option A — minimal plain-TS consolidation)

If we build anything, it is the *largest* change that introduces ZERO behavior
change:

- New `agent/lib/state-schema.ts` exporting a single plain-TS
  `validatePipelineState(parsed: unknown): { ok: true; state: PipelineState } |
  { ok: false; issues: string[] }` — returning the EXISTING `PipelineState`
  (§3.10), no `z.infer`, no dependency, mirroring `validateResearchPlan`'s shape.
- It is **coerce-tolerant, not strict**: it accepts everything the four consumers
  accept (numeric `phase`, stringified `publish_required`, superset keys, absent
  optional fields) and returns `ok:false` ONLY for the cases that are *already*
  treated as failures everywhere (top-level non-object). It MUST NOT reject
  numeric phase (§3.8) or non-boolean publish flags (§3.9).
- It **absorbs** `isNonPrimitiveStateField` / `recoverableNotebookId` /
  `summarizeStateProgress`'s field-coercion logic as named helpers, the
  *originals are deleted*, callers re-pointed, and the affected tests (~36 — see
  §6 Codex correction; NOT just the 27 in `state-coercion-guards`) are MOVED to
  test the consolidated module (D6 + Gemini MAJOR 1).
- The four `as PipelineState` casts call the helper so the cast is no longer a
  bare lie — but because the helper is coerce-tolerant, the realized behavior at
  every site is **byte-for-byte the same verdicts as today**.

**Brutally honest read of option A:** after stripping every change that would
alter behavior, what remains is a *pure refactor* — move 3 existing tested
functions into one file, delete the duplicates, re-point imports. It touches 4
hardened files + relocates ~27 tests to buy: one import site instead of three,
and a non-lying cast. That is real but **marginal** value at real (if bounded)
blast radius on the worker hot-path.

## 6. Rollout (only relevant if option A is chosen)
Pure refactor ⇒ the existing 663-test suite IS the safety net (behavior
unchanged). No shadow mode needed because nothing is newly *rejected*. Move-only/
behavior-preserving discipline + the byte-slice proof toolkit (`/c/tmp/dr-s177/`)
apply. **Codex grounded-correction:** the churn is NOT "import re-points only" —
the move must also handle the private `PHASE_MAP` shared by `summarizeStateProgress`
and `evaluateCompletion` (`state-evaluation.ts:8,317`) and relocate ~36 tests
(`state-coercion-guards` 27 + `watch-state-progress` 9), not 27. MERGE gate =
tri-vendor (AGENT BEHAVIOR + ARCHITECTURE).

---

## 7. Value verdict — lead recommendation: DEFER (option B)

Stack it up honestly:
- The audit's literal ask (Zod + `_version`) is **net-negative** (§3.10 type
  conflict; `_version` inert).
- Eager validation — the only version with *new* safety value — is a **prod
  regression** (§3.8/3.9).
- The only safe build (option A) is a **pure refactor** with marginal value and
  real blast radius on hardened hot-path files.
- The acute crash class the audit worried about is **already closed** (§3.6).

**Recommendation: DEFER / CLOSE the audit item** with a written rationale (this
gate's findings) recorded in the audit-remediation tracker, rather than ship
churn on the worker hot-path for a non-lying cast. The status-quo lazy
per-consumer validation is, post-analysis, the *correct* architecture for a
file whose consumers need different tolerance.

### 7a. If the user prefers to build: do option A, tightly scoped
A behavior-preserving plain-TS consolidation (§5) is defensible IF the value of
"one tested contract module + non-lying casts" is judged worth a hot-path
refactor. It must ship as a pure move (no verdict changes), under a full
tri-vendor MERGE gate, relocating ~36 tests (Codex correction, §6) + the shared
`PHASE_MAP`, originals deleted. If it proceeds, fold in the §9.6 hardening
(route `enforceStudioCompleteness`'s `notebook_id` read through the guard) as a
small bonus. Codex confirmed even this minimal helper is "smaller than option A
but not clearly better than closing the audit item with rationale."

**This is a genuine fork for the user.** Lead: DEFER. Alternative: option A.

---

## 8. MRPF classification
- **This gate: DESIGN.** Gemini (done — BLOCK, integrated) + Codex (grounded,
  next) sequential. Artifact: this doc + `state-schema-design-gate-peer-review.md`.
- **If option A proceeds: MERGE, agent/ PROD.** Risk labels: **AGENT BEHAVIOR**
  (touches recovery/progress/completion read paths), **ARCHITECTURE** (new module
  + absorbing guards). NO **DEPENDENCY** (plain-TS). Full tri-vendor BEFORE merge,
  no substitutes (§11 HARD RULE). Severity NORMAL.

## 9. Open questions for the grounded (Codex) reviewer
You read the actual repo. Verify, don't take my word:
1. **Ground Gemini's two regressions (§3.8/3.9).** Confirm against the code:
   (a) does `evaluateCompletion` truly accept a numeric `phase` that a `string`
   schema would reject? (b) does rejecting `publish_required:"yes"` at the read
   boundary truly suppress the `logPublishFlagDiagnostics` S120 alarm at
   `executor.ts:760`+? If either is wrong, the BLOCK's basis weakens.
2. **Option A blast radius.** Trace every consumer of `isNonPrimitiveStateField`,
   `recoverableNotebookId`, `summarizeStateProgress`, and the 4 cast sites. Would
   a behavior-preserving consolidation actually keep all 663 tests green with only
   import re-points, or is there hidden coupling (e.g. `evaluateCompletion`'s own
   inline guards, the studio-recovery path) that makes "pure move" untrue?
3. **DEFER vs option A.** Given the real (not estimated) cost in (2), is DEFER the
   right call, or is option A's value worth it? Is there a THIRD option I missed —
   e.g. a smaller change (just type the `notebook_id`/`phase` reads) that captures
   most of the value at less cost?
4. **Did I miss a real bug?** Is any of the 4 `as PipelineState` casts ACTUALLY
   unsafe today in a way the existing guards DON'T cover (i.e., a latent defect
   that would justify building something regardless of the value calculus)?
5. Anything in §2 non-goals wrongly scoped out (e.g. should `ResearchJob` — also
   cast from DB rows — be in scope)?

End with one final line EXACTLY: "VERDICT: ENDORSE" (the design's direction —
DEFER-lead with option A as the scoped alternative — is sound) or "VERDICT:
BLOCK" (a flaw remains in the analysis/direction).
