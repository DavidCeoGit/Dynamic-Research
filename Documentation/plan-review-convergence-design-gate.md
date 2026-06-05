# Plan-Review Convergence — Gate-Semantics Design (DESIGN gate)

**Session:** S84 (2026-06-03 UTC)
**Status:** v3 — Gemini round-1 + Codex round-2 integrated; DESIGN gate CLOSED (both APPROVE core ladder). Implementation = follow-on MERGE-gate chunk.
**MRPF:** DESIGN gate × **AGENT BEHAVIOR** (changes the convergence classifier that gates every research job) × NORMAL. Companion artifact: `plan-review-convergence-design-gate-peer-review.md`.
**Author:** Claude (S84)

---

## 1. Problem statement

Job `e18e1931` (auto-detailing business-naming research) failed Phase-0b with
`"Reviewers requested changes after the maximum review rounds."` — `status=failed`,
`plan_review_iterations=2`, zero deliverables. It is the latest of a recurring
class: open-ended / methodology-heavy research plans that never converge.

### Evidence (from `plan_reviews` telemetry, 13 rows, 2 rounds)

| Round | Gemini verdict | Codex verdict | Codex unresolved findings |
|---|---|---|---|
| 1 | **APPROVE** (0 findings) | **REQUEST_CHANGES** | 2 MAJOR (vendor-universe drift, source-strategy), 3 MINOR |
| 2 | **APPROVE** | **REQUEST_CHANGES** | 2 MAJOR ("operationalize success metrics", "add rubric weights"), 6 MINOR |

None of Codex's terminal findings were **CRITICAL**; none were security/data class.
They were quality refinements ("define concrete success proxies", "add explicit
rubric weights"). Genuinely useful — but not safety/correctness blockers.

## 2. Root cause

`reviewPlan()` (`agent/lib/plan-reviewer.ts:489-792`) converges only when, in some
round, **both** available reviewers are approve-like AND no CRITICAL exists:

```
const allApprove = availableCalls.length > 0 && availableCalls.every(isApproveLike);
const anyCritical = availableCalls.some(hasCriticalFinding);
if (allApprove && !anyCritical) return APPROVED;
if (round === maxRounds)        return REQUEST_CHANGES;   // <-- the wall
```

`isApproveLike` = `APPROVE | APPROVE_WITH_CHANGES`. Three compounding factors:

1. **Asymmetric reviewer strictness (primary).** Codex is systematically stricter
   on open-ended plans — the *same* property we deliberately rely on at the code
   MERGE gate. On an under-specifiable topic there are always more methodology gaps,
   so Codex never returns approve-like. A single strict reviewer holds an **absolute
   veto** under the unanimous-approval rule.
2. **Integration doesn't resolve the recurring MAJORs.** The `claude-opus-4-7`
   integration step edits the plan but Codex re-raises "operationalize success
   metrics" in *both* rounds — the bar is effectively unmeetable for this topic's
   budget ($10–30, 30–60 min). (Addressed as future work, §8 — not this design.)
3. **`DEFAULT_MAX_REVIEW_ROUNDS = 2`** caps retries; raising it alone just defers
   the same wall at higher cost (§8).

## 3. Design goal & non-goals

**Goal:** Let a plan converge when it is *good enough* after rounds are exhausted —
i.e. one reviewer approves and nothing safety/correctness-class remains — WITHOUT
opening a bypass that lets genuinely-deficient plans through.

**Non-goals (explicitly out of scope for v1):**
- Strengthening the integration step to better satisfy reviewers (§8, future).
- The double-invocation telemetry anomaly (reviewers persisted 2×/round — separate
  bug, separate fix; §8).
- Changing reviewer prompts or `maxRounds`.

## 4. Proposed design — severity-graded terminal decision

Replace the blunt terminal `if (round === maxRounds) → REQUEST_CHANGES` with a
**severity-graded ladder** that mirrors the human MRPF **Disagreement Procedure**
already in `~/CLAUDE.md` (*"non-security disagreement → record both, proceed;
CRITICAL/security → blocking"*). The automated gate should encode the same policy.

At the terminal round (and ONLY after integration has run for that round), compute
the decision from the unresolved findings across **available** reviewers:

```
// terminal decision (round === maxRounds, not all-approve)
const unresolved = availableCalls.flatMap(c => c.findings);
const anyCritical    = unresolved.some(f => f.severity === "CRITICAL");
const anyAntiBypass  = unresolved.some(f => f.origin === "plan-ambition");   // S58.5/S79 invariant
const anyApproveLike = availableCalls.some(c => isApproveLike(c.verdict));
const unresolvedMajors = unresolved.filter(f => f.severity === "MAJOR").length;

if (anyCritical)                              → REQUEST_CHANGES   // (R1) hard block — unchanged
if (anyAntiBypass)                            → REQUEST_CHANGES   // (R2) anti-bypass — never degrade
if (!anyApproveLike)                          → REQUEST_CHANGES   // (R3) two-reviewer rejection blocks
if (unresolvedMajors > MAX_RESERVATION_MAJORS)→ REQUEST_CHANGES   // (R4) volume bound — deeply contested
else                                          → APPROVED + reservations[]   // (R5) proceed, record findings
```

**Rule (R5) is the only behavioral change.** R1–R4 are all hard gates.

**(R4) volume bound — `MAX_RESERVATION_MAJORS = 2` (Gemini round-1 [MAJOR]).**
A single lax/hallucinated APPROVE from one reviewer must not let a structurally
broken plan (e.g. 6 unresolved MAJORs from the strict reviewer) proceed. Up to
**2** unresolved non-critical MAJORs are acceptable as reservations; **3+** signals
the plan is genuinely contested, not merely subject to asymmetric strictness →
REQUEST_CHANGES. **Calibration:** e18e1931's terminal round had exactly **2**
unresolved MAJORs ("operationalize success metrics", "add rubric weights") → at
threshold 2 it **passes** (ships); the bound blocks only at 3+. The threshold is a
named constant, tunable from telemetry (§5a).

### What (R5) does
- Terminal status = `APPROVED` (the plan spawns), BUT the **final-round** non-critical
  findings (see §6.5 — counted from in-memory final-round `availableCalls`, never DB
  rows) are captured into a new `ReviewResult.reservations: ReviewFinding[]` field.
  **Surfacing is NOT automatic** — see §5b for the required non-silent path (Codex
  round-2 [MAJOR-2]). **Never silent** (cf. no-silent-caps /
  `feedback_shadow_mode_needs_alerting_path`).

### Why this is a floor, not a bypass
- **CRITICAL always blocks** (R1) — the security/data/correctness backstop is untouched.
- **Anti-bypass `plan-ambition` always blocks** (R2) — the S58.5/S79 persona-depth
  gate that prevents reviewers from rubber-stamping generic plans is preserved
  verbatim; a forced `plan-ambition` finding still terminates as REQUEST_CHANGES.
- **Both-reviewers-reject still blocks** (R3) — if neither reviewer is approve-like,
  the plan is genuinely contested by both and does NOT proceed. (R4) requires at
  least one reviewer's independent approval.
- **Only fires at the terminal round**, after integration had every chance to fix.
- The single thing that changes: one asymmetrically-strict reviewer can no longer
  *unilaterally* veto a plan the other reviewer approved, when nothing safety-class
  remains. That is the exact e18e1931 failure and the exact human-policy mapping.

### e18e1931 under the new gate
Round 2 terminal: Gemini APPROVE, Codex REQUEST_CHANGES; unresolved = 2 non-critical
MAJOR + 6 MINOR, no CRITICAL, no `plan-ambition`. → R1 no, R2 no, R3 no (Gemini
approve-like), R4 no (2 MAJORs ≤ 2 threshold) → **R5 APPROVED with 8 reservations
recorded.** The report spawns; the user sees Codex's refinements as advisory notes.

### Why NOT block on `source-strategy` MAJOR (Gemini round-1 [MINOR], Q1) — REJECTED
Gemini suggested expanding R2 to hard-block on `source-strategy` findings of MAJOR
severity (a flawed source strategy burns API budget). **Rejected for v1:** Codex's
*exact* terminal blockers on e18e1931 were `source-strategy` + `scoring-rubric`
MAJORs — making `source-strategy` MAJOR a hard gate would re-break this design's
motivating case and hand the asymmetric-strict reviewer its veto back through a
side door. The concern is instead covered by (a) the R4 volume bound (3+ MAJORs of
*any* origin blocks) and (b) the fact that R5 requires the *other* reviewer to have
independently approved the plan — including its source strategy. If a source
strategy is truly disqualifying it should be scored CRITICAL (R1) or trip the
budget cap, not a MAJOR. **Reviewer Q (Codex):** concur, or is there a factual-
integrity origin that genuinely warrants origin-specific hard-blocking?

## 5. Implementation surface (recommended: minimal blast radius)

**Reuse `APPROVED` + add `reservations` field — do NOT add a new status enum.**
A new terminal status (e.g. `APPROVED_WITH_RESERVATIONS`) would require, in lockstep:
- `REVIEW_RESULTS` TS enum (`plan-types.ts:50`)
- the `plan_review_status` DB CHECK constraint (`20260527_plan_review_gate.sql`) →
  a new migration (DATA-label change, `supabase db push`)
- executor status mapping (`executor.ts:271`)
- frontend status rendering

Reusing `APPROVED` with `ReviewResult.reservations?: ReviewFinding[]` confines the
change to: `plan-types.ts` (add optional field), `plan-reviewer.ts` (`finalize()` +
terminal ladder), `executor.ts` (persist reservations to telemetry + include in the
notify email). **No DB migration, no enum churn.** `plan_review_status` stays
`approved`; a sibling `plan_review_reservations jsonb` column is additive/nullable
(optional — could also live only in `plan_reviews` raw_json).

Touch list (revised after Codex #5 — larger than the v1 ~45-line estimate once the
non-silent surfacing path §5b is counted): `plan-reviewer.ts` (~45 lines: extract
`decideTerminal()`, `MAX_RESERVATION_MAJORS` constant, wire reservations +
`terminal_decision` through `finalize()`), `plan-types.ts` (~5 lines: `reservations?`
+ `terminal_decision?` on `ReviewResult`), `executor.ts` (~20 lines: persist
reservations to a terminal record + advisory `plan_review_error`), `notify.ts`
(~15 lines: advisory reservation summary in the completion email), tests (~10 new
cases in `plan-reviewer.test.ts`). Core classifier change stays small (~45 lines); the
surfacing wiring is the bulk.

## 5b. Non-silent surfacing path — REQUIRED (Codex round-2 [MAJOR-2])

The `reservations[]` field alone does **not** satisfy "never silent." Verified against
code: `executor.ts` maps `APPROVED → approved` and proceeds immediately with **no
email** (`sendPlanReviewEmail` is only called for REQUEST_CHANGES/BLOCKED/
SYSTEM_BLOCKED, and its type signature `notify.ts:165` does not even accept
`APPROVED`); `PlanReviewBanner.tsx:10` intentionally **hides** approved plan-review
states. So an R5 approval with reservations would record the findings into a field
that nothing reads → silent. The implementation MUST add an explicit surfacing path.
**Specified design (all three, cheapest-first):**

1. **Persistence (required).** `reservations` is a *synthesized terminal artifact*,
   not a single reviewer call — `persistReviewerCalls()` (`executor.ts:121`) only
   writes each call's own `raw_json`. Attach `reservations` + `terminal_decision`
   (which rule fired: `R1..R5`) to a dedicated terminal record: either a synthetic
   `reviewer="terminal"` row in `plan_reviews`, OR (simpler) a
   `ReviewResult.terminal_decision` + reservations blob persisted into
   `research_queue.plan_review_error` as an advisory summary string even on the
   approved path (the column is currently null on approval — repurpose it as an
   advisory note, NOT an error).
2. **User email (required).** Surface reservations as advisory notes — either extend
   `sendPlanReviewEmail` to accept an `APPROVED_WITH_RESERVATIONS` advisory variant
   (subject: *"Research proceeding — N optional refinements noted"*), OR fold the
   reservation summary into the existing **completion** email when the run finishes.
   Completion-email folding is lower blast-radius (no new email type, no UI banner
   change) and is the recommended v1 path.
3. **UI (optional, defer).** `PlanReviewBanner` could show an advisory chip on
   approved-with-reservations runs. Deferred — email + persistence satisfy non-silent;
   UI is polish.

The MERGE-gate implementation chunk owns wiring 1+2; 3 is future work. This expands
the touch list beyond the original §5 estimate (executor + notify changes), per Codex
answer #5.

## 5a. Operational telemetry (Gemini round-1 [MINOR], Q5)

R5 is an escape hatch; we must watch its trigger rate from day one to ensure it does
not become the default path (a sign reviewers/integration are mis-calibrated). No new
DB column required — reservations live in `plan_reviews.raw_json` + the notify email.
Ship a dashboard query alongside the change:

```sql
-- R5 trigger rate: jobs that proceeded WITH reservations vs clean approvals
select date_trunc('day', created_at) d,
       count(*) filter (where raw_json -> 'reservations' is not null
                          and jsonb_array_length(raw_json -> 'reservations') > 0) as proceeded_with_reservations,
       count(*) filter (where verdict in ('APPROVE','APPROVE_WITH_CHANGES')) as clean_approvals
from plan_reviews group by 1 order by 1 desc;
```

Telemetry must also distinguish the one-reviewer-down APPROVED state (1 available,
0 reservations) from the R5 override (2 available, N reservations) — both surface as
`plan_review_status=approved` but mean different things (Gemini round-1 [NIT]).

## 6. Edge cases

1. **One reviewer down (UNAVAILABLE) at terminal round — CORRECTED (Codex round-2
   [MAJOR-1]).** When one reviewer is UNAVAILABLE and the other is approve-like,
   `allApprove` (computed over `availableCalls`, which already filters UNAVAILABLE)
   is **true** → the existing **mid-loop early-exit (`plan-reviewer.ts:753`) returns
   plain `APPROVED` BEFORE the terminal ladder runs** — with NO reservations. The
   ladder only executes when `allApprove` is false. So: one-down + available
   approve-like → plain `APPROVED` (unchanged "reduced review" semantics, empty
   reservations). One-down + available REQUEST_CHANGES → ladder runs → R3 blocks (no
   approve-like reviewer). The earlier v1/v2 claim that this case yields "R5 with
   reservations" was wrong; reservations only arise when BOTH reviewers are available
   and they split.
2. **Persona-depth asymmetry.** If reviewer A scores persona-depth fine (approve-like,
   no `plan-ambition`) but reviewer B's `plan-ambition` finding fired → R2 blocks on
   B's finding regardless of A. The anti-bypass gate is intentionally conservative
   (any anti-bypass finding blocks). **Reviewer Q:** is that the desired strictness,
   or should anti-bypass require *both* reviewers to flag it? Recommend keep
   any-reviewer-blocks (safer; persona-depth is the core quality guarantee).
3. **CRITICAL appears only at terminal round.** R1 blocks — unchanged. Good.
4. **`maxRounds` interaction.** The mid-loop `allApprove` early-exit (line 753) is
   unchanged; the ladder only governs the terminal round. A plan that would have
   approved early still does, at the same cost.
5. **Shadow mode (Codex round-2 [NIT]).** `finalize()` (`plan-reviewer.ts:911`)
   forces every non-`SYSTEM_BLOCKED` status to `APPROVED` in shadow mode. So R1–R4's
   hard-blocks bind only in **enforcement** mode. In shadow, the ladder must still
   **compute and log** its decision (`terminal_decision` + would-be reservations)
   into telemetry so the dark-launch can measure R5 trigger-rate and false-block-rate
   BEFORE enforcement (cf. `feedback_dark_launch_for_integration_gates`), even though
   the emitted status is forced APPROVED.

## 6.5 What "unresolved findings" means (Codex round-2 [MINOR])

Integration runs *between* Gemini and Codex within a round, so the two reviewers may
have scored **different plan versions**; a finding raised early in a round may already
be integrated by the terminal verdict. The ladder's `unresolved`/`unresolvedMajors`
MUST be computed from the **in-memory `availableCalls` of the FINAL round only** — NOT
from the cumulative `calls` array, NOT from `plan_reviews` DB rows, NOT from prior
rounds, NOT from `integration` rows (which have no findings). Computing from in-memory
final-round `availableCalls` also sidesteps the §8 double-persist anomaly (DB shows
each reviewer twice; in-memory state holds one call object per reviewer per round).

## 7. Open questions — Gemini round-1 resolutions + remaining for Codex

**Resolved by Gemini round 1:**
- **Q2 → REUSE `APPROVED` + `reservations[]`** (no migration). Confirmed.
- **Q3 → YES, bound unresolved MAJORs** → integrated as R4 (`MAX_RESERVATION_MAJORS=2`).
- **Q4 → DEFER** semantic convergence-detection (too complex for v1).
- **Q5 → raw_json + email sufficient**; ship the dashboard query (§5a), monitor rate.

**Remaining for Codex (code-grounded pass on v2):**

### Original open questions (restated for Codex)

- **Q1 (core).** Is R4 a sound floor, or does it materially weaken the gate? Is there
  a finding class besides CRITICAL + `plan-ambition` that MUST also hard-block at
  terminal (e.g. a specific MAJOR `origin` like `source-strategy` for factual
  integrity)? Severity alone vs. severity×origin.
- **Q2.** Status modeling: reuse `APPROVED` + `reservations[]` (recommended, no
  migration) vs. a distinct `APPROVED_WITH_RESERVATIONS` status (clearer downstream
  semantics, costs a migration + enum churn). Trade-off call.
- **Q3.** Should R4 additionally require the *count*/severity of unresolved findings
  to be bounded (e.g. block if > N unresolved MAJORs even when non-critical), to
  avoid shipping a plan with 6 MAJORs? Or is "one reviewer approves + no CRITICAL"
  sufficient?
- **Q4.** Convergence-detection alternative: instead of (or with) R4, detect when a
  reviewer re-raises the *same* finding (origin+semantic match) across consecutive
  rounds → "integration can't resolve" → terminal-advisory. More precise but more
  complex. Worth v1, or defer?
- **Q5.** Telemetry/observability: is logging reservations to `plan_reviews.raw_json`
  + the notify email enough, or does R4 warrant a distinct dashboard signal /
  operator alert (so we can watch how often the strict-reviewer veto is being
  overridden in practice)?

## 8. Future work (explicitly deferred)
- **Integration strengthening** (root-cause #2): make the integration prompt
  explicitly close prior-round MAJORs so fewer plans reach the terminal ladder.
- **Double-invocation anomaly**: `plan_reviews` shows each reviewer persisted twice
  per round with *different* findings — possible double API call (≈2× plan-review
  cost). Separate investigation.
- **`maxRounds` tuning**: orthogonal lever; revisit only if R4 proves insufficient.

## 9. Test plan
- **R1:** terminal round with a CRITICAL → REQUEST_CHANGES.
- **R2:** terminal round with a `plan-ambition` finding + approve-like other reviewer
  → REQUEST_CHANGES (anti-bypass preserved).
- **R3:** terminal round both REQUEST_CHANGES, no CRITICAL → REQUEST_CHANGES.
- **R4 boundary (Codex #4):** terminal round, one approve-like + 3 unresolved non-
  critical MAJORs → REQUEST_CHANGES; **exactly 2 MAJORs → APPROVED** (guards against
  accidental `>=`). The e18e1931 case = 2 MAJORs → APPROVED.
- **R5:** terminal round Gemini APPROVE / Codex REQUEST_CHANGES (≤2 non-critical
  MAJOR) → APPROVED + reservations populated (the e18e1931 case).
- **R5 final-round counting (Codex [MINOR]):** a MAJOR raised round-1 then integrated,
  with a clean round-2 split, must NOT count toward R4 — assert reservations reflect
  only final-round `availableCalls`, not cumulative `calls`.
- **Early-exit unaffected:** round 1 both approve → APPROVED, no reservations.
- **One-reviewer-down at terminal (Codex [MAJOR-1]):** available approve-like →
  plain APPROVED via early-exit, **empty** reservations; available REQUEST_CHANGES →
  ladder → R3 REQUEST_CHANGES.
- **Preserved pre-terminal hard gates (Codex #5):** reviewer `BLOCK` → BLOCKED;
  cost-cap exceeded → BLOCKED; timeout/abort → SYSTEM_BLOCKED; both reviewers
  UNAVAILABLE → SYSTEM_BLOCKED; S64 terminal-error (credit-out) propagates/exits —
  all unchanged, none reach the new ladder.
- **Shadow mode (Codex [NIT]):** ladder would-be REQUEST_CHANGES → emitted status
  forced APPROVED, but `terminal_decision` logged.
