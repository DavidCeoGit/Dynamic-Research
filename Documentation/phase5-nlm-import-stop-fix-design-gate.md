# DESIGN GATE — Fix A: Phase-5 NLM-Import-Stop Durable Fix

**Status:** v3 FINAL — Gemini + Codex both BLOCK → integrated. **SHIPS: L1 (poll-wait + anti-stop CRITICAL) + E (heartbeat). DEFERRED: L3 (auto-recovery) + L2 (continuation).** `agent/` PRODUCTION code + live slash-prompt.

### Integration log (v2→v3 FINAL)

Both reviewers returned **BLOCK**. The v2 shipped L1 + E + L3; the gate proved L3-as-designed is infeasible and cut it to a follow-on. The v3 disposition:

- **Gemini (holistic-adversarial) — BLOCK.** Cut L2 (already applied in v2). Flagged L2's `waitForProcess` budget fail-open (moot — L2 already cut) and confirmed the L3 precheck-must-not-burn-attempts fix (already applied as `delayed-precheck` in v2). Gemini's substantive residual: L2 over-engineering vs. the now-safe L3 precheck (endorses the direction v2 already took — cut L2, lean on L1+L3+E). O-adjudications match v2. **No new blocking change to L1/E.**
- **Codex (grounded-adversarial, code-read) — BLOCK, and this is the decisive one.** Codex read the actual `agent/` code and proved **L3-as-designed cannot be built on the primitives v2 named**:
  - **(C1)** `regenerate-studio-products.ts` is **clone-only** — it requires `parent_run_id`, exits without it, and resolves `notebook_id` by downloading the *parent* run's Storage `state.json`, which a phase-5/6-stopped original run **never uploaded**. L3 cannot reuse it. A dedicated recovery primitive is required.
  - **(C2)** the L3 precheck was specified against the **WRONG API + WRONG enum**: v2 said `realListArtifactsWithStatus` (the *artifact* list) with `status_id==3 = ready`. The correct probe is `notebooklm source list -n <id> --json` with the **SOURCE** enum `PROCESSING=1 / READY=2 / ERROR=3 / PREPARING=5` — wait while `1` or `5`, ready is `2`, and `3` is **ERROR not ready**. As written the precheck would treat errored sources as ready and never observe import readiness.
  - **(C3)** the sweep bumps `attempts` on **every** non-terminal path (`studio-recovery-sweep.ts:241-242`), and its payload validator requires `products.length > 0` (`:261-281`) — so the v2 `delayed-precheck` no-bump outcome and the empty-`products` resume payload **do not fit the current sweep as written**.
  - **(M1)** the atomic park writes `attempts=1` and the migration CHECK requires `attempts >= 1` — which **contradicts** "attempts only increment on paid regen."
  - **(M2)** `runStudioOnly` reads a **fresh** bypass snapshot and calls `completeJob` directly (does NOT set `studio_recovery_status`) — so it is **not a sweep-safe atomic completion** (row could go `completed` while `studio_recovery_status` stays `pending`, and the publish bypass read is post-hoc).
  - Codex **INFO** independently CONFIRMED every L1/E seam: the completion-gate reason string, the no-`--max-turns` spawn, the executor ordering (nonzero recovery → Gate-A video-defer → terminal fail → atomic park), the sweep query, and that L2 is already cut from code. It confirmed the L1 prompt insertion point is real and the live slash-prompt still normalizes "background."

**DECISION (design lead's call):** v3 ships **L1 + E** as the fix. **L3 is DEFERRED** to a separate follow-on build with Codex's corrected requirements captured as its spec (§X-L3 below). **L2 stays cut.**

**Rationale:**
- **L1 (poll-wait + anti-stop CRITICAL) + E (heartbeat) directly fix the root cause** — the agent stopping instead of polling to completion — for **ALL 4 observed failures**. Both reviewers validated the L1/E seams: the prompt insertion point is real and always-emitted; the completion gate, spawn, and executor ordering are confirmed (Codex INFO).
- **L1 is prompt-only, $0, fail-forward, zero new risk surface** — it cannot be worse than today (it can only add waiting + heartbeat; the timeout branch proceeds or, at worst, exits exactly as today, which now falls through to the *same manual recovery* we already do).
- **L3 (the auto-recovery net) is only for the rare case L1 drifts**, and Codex proved it needs a **dedicated recovery primitive** — not the clone-only script, not the artifact enum, not the current attempt-bump/validator shape. That is a real build, not a rush. Build it **right after L1+E ship** and we observe whether drift persists in prod.
- **Until L3 lands, a rare drift is recovered manually** — the *same* failure mode as today, now made rare by L1. We are not regressing; we are removing the common case and deferring the net for the residual.

**MRPF classification:** DESIGN gate (agent-turn-control behavior change; irreversible-in-prod). The **L1+E MERGE gate** carries **AGENT BEHAVIOR** (changes when the agent may end its turn — propagates to every future session) + **INFRA** (touches the prod worker's spawn brief). Per project §11 HARD RULE this is `agent/` PROD code → **FULL tri-vendor MERGE gate BEFORE merge; if Codex is quota-out ⇒ WAIT or §1a API-key flip — NEVER substitute-and-owe.** Severity NORMAL.

**Failure class:** `feedback_phase5_nlm_import_stop_failure_class.md`. Class A: the `claude -p` pipeline agent ends its turn at phase 5 (Synthesis) or 5.5 (Studio) while an async NotebookLM op (Phase-3 corpus import, or Studio render) is still in flight, writes a "…finalizing/rendering in background" `phase_status`, and stops. The completion gate (`state-evaluation.ts:317-331`) correctly hard-fails a genuinely-incomplete-per-contract job. **4 confirmed prod events** (`58328a97` phase 5; `eac58954`, `11637e91` phase 5.5; + the S191 recurrence), 2026-06-29→30, all with complete/near-complete deliverables — pure work-done-marked-failed.

---

## 1. Root cause (one paragraph, cross-verified — Codex INFO confirmed)

`claude -p` is spawned single-shot with **no `--max-turns`** (`claude-spawn.ts:199-224`); turn-end is detected only as process exit (`claude-spawn.ts:361-364`). Nothing in the spawn brief (`job-manifest.ts` `buildPrompt`) forbids ending a turn while async NLM work is pending, and the skill body actively *normalizes* "in the background" as a resting state (`research-compare.md:371/375/586/815`). The one wait at the synthesis→studio boundary (`research-compare.md:723` `source wait`) blocks only on the single comparison file just added — **not** on the 50-100+ Phase-3 sources added with `wait=False` (`research-compare.md:543`). So when the corpus import lags, the agent stops. The child exits code 0 / `killReason=NONE`, which **skips the entire `exitCode !== 0` recovery block** (`executor.ts:315-374`), so `recoveryVerdict` stays null; the completion gate returns `{success:false}` (`phase < 7`); the S187 Gate-A video-defer probe declines (video not selected / research docs absent); and the terminal `failJob` fires (`executor.ts:447-451`). The S162 studio-recovery sweep can never engage — it requires a parked `studio_recovery_status='pending'` row (`studio-recovery-sweep.ts:747-765`) that only the post-generation transient-park block writes (`executor.ts:553-592`); a phase-5 stop parks nothing.

**What L1+E change:** the agent is told, in the highest-weight brief placement, that "finalizing in background" is NEVER a valid stop in non-interactive mode — it is a WAIT point — and the slash-prompt gives it a bounded poll-wait (Step A.1) with a per-poll heartbeat so the wait is observable. That directly removes the premature stop for all four observed events, with the process page staying live throughout.

---

## 2. Chosen design (v3): L1 (PRIMARY) + E (CROSS-CUT). L3 deferred, L2 cut.

The candidate approaches were **not** alternatives — each catches a different bug-class at a different altitude. v3 ships the two that directly fix the root cause and carry zero new prod-risk surface; the auto-recovery net (L3) is deferred to a corrected follow-on.

| Layer | Approach | Status in v3 | Role | Cost when it fires | Catches |
|---|---|---|---|---|---|
| **L1 (PRIMARY)** | Prompt poll-wait + global anti-stop CRITICAL | **SHIPS** | Prevent the premature stop at the source | $0 (same turn) | The stop, before it happens — ~all cases |
| **E (CROSS-CUT)** | Progress heartbeat during any poll-wait | **SHIPS** | Keep DB phase-label + process page live | negligible | The "looks stuck / frozen" UX bug |
| **L3 (LAST-RESORT)** | Gate-park → dedicated resume-studio recovery (with $0 source-readiness precheck) | **DEFERRED** (§X-L3) | Park instead of hard-fail; deterministic decoupled resume | $0 while import lags; off-critical-path regen only when sources ready | A stop that survives L1 (research+notebook present) |
| **L2 (continuation loop)** | Bounded harness re-spawn | **CUT** (§X-L2) | (subsumed) | — | — |

**Why L1+E is the complete v1 fix (and L3 is a follow-on, not a co-requisite):**

- **L1 is the direct cure.** The root cause is a premature turn-end while NLM work is pending. L1 forbids exactly that in the drift-resistant top-of-brief placement and gives the agent a bounded poll-wait to do instead. This addresses all 4 observed events.
- **E is mandatory and co-ships.** Without a heartbeat, a legitimate poll-wait freezes the DB phase label and process page — reproducing the exact "stuck" symptom. E makes a long, legitimate wait *observably* progress rather than *look hung*.
- **L1 is probabilistic but fail-forward.** Prompt directives are not enforced; the same model that drifted off the ~900-line publish contract (precedent at `job-manifest.ts:176-184`) *can* drift off a poll-wait directive. L1 raises compliance odds sharply but cannot *guarantee* the turn doesn't end early. The residual is a **rare** drift.
- **The residual is recovered manually today, and L3 is the eventual net.** A rare drift after L1 is the *same failure mode as today* — now rare. We recover it manually (as we do now) until the dedicated L3 recovery primitive ships. L3 is deferred because Codex proved it needs a purpose-built recovery contract (not the clone-only script, not the artifact enum, not the current sweep shape); rushing it risks a fail-open worse than the manual path it replaces.

**Layering invariant (v3):** L1 makes the stop rare; E makes any legitimate wait observable. Both fail **CLOSED** (§7). The auto-recovery net for the residual (L3) is deferred to a correctly-specified follow-on (§X-L3).

### What is REJECTED and why

- **`--max-turns` (Seam A):** REJECTED as a fix. The agent ends its turn *early*; a turn cap makes single-shot stops **more** likely, not less. Documented as a non-fix so reviewers don't mistake its absence for an oversight. (Not added to `claude-spawn.ts:199-224`.)
- **L2 (bounded harness continuation loop):** CUT. A probabilistic re-spawn *duplicates the very L1 risk-class* it is meant to backstop, can duplicate paid work (re-run Perplexity/plan-synth) and re-import NLM sources, and threaded a CRITICAL budget-threading fail-open (a continuation inheriting a fresh 90-min allowance → 90+67=157-min cap breach). Both reviewers independently endorsed cutting it. Full record: §X-L2.
- **L3 as a v1 co-requisite:** DEFERRED. Codex proved it is infeasible on the primitives v2 named and requires a dedicated recovery build (§X-L3). L1+E stand alone as the v1 fix; a rare post-L1 drift is recovered manually until L3 ships.

---

## 3. L1 — Prompt poll-wait + global anti-stop CRITICAL (PRIMARY, $0)

### Change 1.1 — `agent/lib/job-manifest.ts` → `buildPrompt()`, new top-level CRITICAL (ALWAYS-emitted, outside `publishBlock`)

**Seam:** `job-manifest.ts:218-224` — the top-level CRITICAL block, ABOVE the ~900-line skill body (the drift-resistant placement the `publishBlock` comment at `:176-184` already proves). Insert **always-emitted** (NOT publish-gated — Class A struck non-publish jobs), immediately after the untrusted-input CRITICALs at `:224`, **before** `${publishBlock}` (Codex MINOR confirmed this is the correct seam: `buildPrompt()` always emits the no-AskUser + untrusted-data CRITICALs at `:218-224`, then appends `publishBlock` only when publish-required at `:191-216` — the anti-stop block MUST live outside `publishBlock`):

```
CRITICAL — NON-INTERACTIVE SINGLE-SHOT EXECUTION. You run once as `claude -p`; there is
NO human and NO interactive resume. If you end your turn before Finalization (Phase 6,
phase_status "complete"), the worker gate will HARD-FAIL the job even if every deliverable
is written. Therefore you MUST NOT end your turn while ANY asynchronous NotebookLM
operation is pending — this includes (a) the Phase-3 corpus import (sources added with
wait=False) and (b) any Studio render (audio/video/slides/infographic). "Still finalizing /
rendering in background" is NEVER a valid stopping point in this mode — it is a WAIT point.
Poll to completion (bounded — see /research-compare Phase-5.5 Step A.1), emitting a progress
line to state.phase_status on each poll, then continue to Finalization IN THIS SAME TURN.
If a bound elapses with work still pending, FAIL FORWARD (proceed with what is processed) —
do NOT stop with a "finalizing" status. The ONLY permitted early exits are: (i) a fail-closed
ERROR you write to state.phase_status then EXIT (credit-out, auth-out, PUBLISH gate block,
unrecoverable vendor leg), or (ii) reaching Phase 6 complete.
```

### Change 1.2 — `~/.claude/commands/research-compare.md`, bounded corpus-import poll at the synthesis→studio boundary

**Seam:** Phase 5.5 Step A, immediately after `research-compare.md:723` (the existing `source wait`), before Step B. Add **Step A.1**.

> **Codex C2 CORRECTION (applied):** Step A.1 polls **SOURCE import readiness**, so it MUST use the **SOURCE list API + SOURCE status enum**, NOT the artifact API/enum. The correct probe is `notebooklm source list -n <id> --json`, which emits `status_id: src.status` (`.../notebooklm/cli/source.py:175-188`). The SOURCE enum is `PROCESSING=1 / READY=2 / ERROR=3 / PREPARING=5` (`.../notebooklm/rpc/types.py:334-346`): **wait while `status_id` is 1 or 5; ready is 2; 3 is ERROR (terminally failed), NOT ready.** (The v2 text used `realListArtifactsWithStatus` + `status_id==3=ready` — that is the ARTIFACT enum and is wrong for sources; it would treat errored sources as ready and never observe import readiness.)

```
### Step A.1 — BLOCK on full corpus-import completion (bounded, with heartbeat)

Before any `notebooklm generate`, the ENTIRE Phase-3 corpus import (sources added wait=False)
must be READY — not just the comparison file. Poll the SOURCE list (NOT the artifact list):

    notebooklm source list -n <notebook_id> --json

and inspect status_id per source using the SOURCE status enum:
    1 = PROCESSING (in progress — WAIT)
    5 = PREPARING  (in progress — WAIT)
    2 = READY      (done)
    3 = ERROR      (terminally failed — do NOT wait on it; count it out, log it)

Loop every 30s until ZERO sources remain status_id 1 or 5 (i.e., every source is 2 or 3).
Hard bound: 25 minutes.

ON EACH POLL (mandatory — Fix E): update state.json phase_status to
    "Phase 5.5 Step A.1: waiting on corpus import — <P>/<M> sources ready (<S>s elapsed)"
so the worker + process page show live forward progress and never look frozen.

NEVER end your turn while any source is status_id 1 or 5. If the 25-minute bound elapses with
sources still PROCESSING/PREPARING: do NOT stop with a "finalizing" status. Log the stragglers
to phase_status, proceed to Studio generation with the sources already READY (the comparison
file is the primary Studio source and is already present), and continue to Finalization.
Studio quality degrades gracefully; a stranded job does not.

NOTE (O9 — NLM concurrency, live-test-pending): if NotebookLM LOCKS the notebook while a
corpus import is still processing, the fail-forward `notebooklm generate` at the 25-minute
bound may API-error. In that case CATCH the generate error, write an ERROR line to
phase_status, and EXIT (do NOT crash uncaught). Today that EXIT lands on the same terminal
hard-fail as before (recovered manually); once the deferred L3 recovery ships, that EXIT will
instead fall through to L3 park + $0 source precheck. Ground-verify O9 by live-test before
relying on fail-forward-to-Studio during an active import.
```

**Two load-bearing properties:** (a) 25-min inner bound sits **under** the 90-min `MAX_JOB_DURATION` so the poll can never *itself* cause a cap-kill; (b) the timeout branch **fails FORWARD to Studio** where NLM concurrency permits (comparison file already present → proceeding toward Phase 6 is strictly better than stranding at phase 5); where NLM LOCKS during import (O9), the fail-forward-generate errors gracefully → agent writes ERROR + exits → today that is a manual-recovery terminal fail (unchanged from status quo), and once L3 ships it becomes a park + cheap-wait.

### Change 1.3 — `research-compare.md`, gate the "background" language to interactive-only

**Seam:** `research-compare.md:815` ("offer to proceed to Phase 6 while video polls in background") + `:371/:375/:586`. Gate the "offer to proceed while video polls" phrasing to **INTERACTIVE mode only**; in NON-INTERACTIVE mode replace with:

```
In non-interactive mode you MUST NOT hand off. Poll the render to completion within the render
bound (emit a phase_status heartbeat each poll — Fix E); if the render exceeds the bound,
follow the Studio-video best-effort path (the live Mode-A machinery) — do NOT end your turn
with a "rendering in background" status.
```

Closes the mental-model leak without touching interactive UX.

> **Distinct-enum note (keep correct):** the Change 1.2 corpus poll uses the **SOURCE** enum (1/5=wait, 2=ready, 3=error). The **video-render** poll referenced here uses the **ARTIFACT** enum (`realListArtifactsWithStatus` / `notebooklm artifact list`, where the artifact-side `status_id==3` means the render is done). Do NOT conflate them — sources and artifacts have different status mappings. This distinction is exactly the C2 confusion, kept explicit here so the two polls stay correct.

---

## 4. E — Progress heartbeat during poll-wait (CROSS-CUT, mandatory, co-ships with L1)

The bug that made the run "look stuck" is that during any wait the DB `phase_status` froze, so the process page showed no movement. **Every poll-wait in this design MUST emit a heartbeat:**

- **L1 (agent-side):** Change 1.2 / 1.3 mandate a `phase_status` write on *each* poll: `"Phase 5.5 Step A.1: waiting on corpus import — <P>/<M> sources ready (<S>s elapsed)"`. The agent already writes `state.json`; this is a per-iteration update, not new machinery.
- **Frontend:** the process/results page already renders `phase_status`; no change needed (it reads the live label). Verify the page polls often enough (≤30s) that a 30s heartbeat is visible.

**Acceptance for E:** during a 10-minute legitimate import wait, the process page phase label changes at least every ~30s and never displays a static "finalizing" string for >60s. This is the single most user-visible part of the fix.

*(The v2 L3-side heartbeat — `studio_recovery_note` on the sweep precheck — moves with L3 into §X-L3; it is not part of the v3 ship.)*

---

## 5. Every file:line touched (v3 change map — L1+E only)

| File | Line/anchor | Layer | Change |
|---|---|---|---|
| `agent/lib/job-manifest.ts` | `:218-224` (before `${publishBlock}`) | L1 | New always-emitted anti-stop CRITICAL (Change 1.1) |
| `~/.claude/commands/research-compare.md` | after `:723` (Phase 5.5 Step A) | L1+E | New Step A.1 bounded **source-list** corpus poll (SOURCE enum) + per-poll heartbeat + O9 lock-error catch (1.2) |
| `~/.claude/commands/research-compare.md` | `:815`, `:371`, `:375`, `:586` | L1+E | Gate "background" language to interactive-only; non-interactive poll+heartbeat (1.3) |
| `agent/lib/nlm-source-cli.ts` (NEW, small) OR extend `nlm-artifact-cli.ts` | new wrapper | L1 | A real `notebooklm source list -n <id> --json` wrapper returning per-source `status_id` (SOURCE enum). *(Only if the slash-prompt poll is backed by a helper; the prompt itself invokes the CLI directly, so this is optional for L1 and becomes mandatory for L3.)* |
| `agent/test/*.test.ts` | new + extend | L1+E | §6 test plan |

**Explicitly NOT touched (v3):** `claude-spawn.ts:199-224` args (no `--max-turns`, documented non-fix); `publish-gate.ts` (zero change — §8); `executor.ts` (no L3 park in v3); `studio-recovery-sweep.ts` (no resume arm in v3); `state-evaluation.ts` completion gate `:317-331` (the thing being satisfied, not changed); `types.ts` `StudioRecoveryPayload` (no resume descriptor in v3). **No migration.** All L3-touching files move to §X-L3.

---

## 6. Test plan for L1+E (`node --test`, per §2 — NOT vitest; glob `test/*.test.ts` via `pnpm -C agent exec node --import=tsx --test`)

**A. Anti-stop CRITICAL emission (`job-manifest.ts` `buildPrompt`):**
1. The anti-stop CRITICAL string is present in the built prompt for a **non-publish** job (proves ALWAYS-emitted, outside `publishBlock`).
2. Present for a publish-required job too (both branches).
3. Emitted at the top-level CRITICAL region (before the skill body / before `${publishBlock}`), not inside the publish block — assert relative ordering.

**B. Source-list wrapper (if the helper lands for L1 / to pre-stage L3):**
4. Parses `notebooklm source list --json` output → per-source `status_id`.
5. Correct SOURCE-enum classification: 1→waiting, 5→waiting, 2→ready, 3→error.
6. Totality: malformed/empty JSON → fails closed (no throw; treated as "not ready" so the poll keeps waiting or the bound trips, never a crash).

**C. Fix E heartbeat acceptance:**
7. (Agent-side, prompt) — validated by a **live smoke run gated behind the MERGE gate** (cannot unit-test the slash-prompt poll loop). Assert acceptance criterion §4-E: phase label changes ≥ every ~30s, no static "finalizing" >60s during a real import wait.

**D. Regression / parity:**
8. `pnpm test` full suite green (baseline agent 701 / frontend 150). `tsc --noEmit` strict clean (no new agent/ type surface in v3 beyond the optional source-list wrapper's return type). Phase-B storage grep guard unaffected.

**Untestable-in-unit (documented):** the live NLM `source list` poll loop lives in the slash-prompt (L1) — covered by the **live smoke run gated behind DESIGN+MERGE**, per the S189 dark-launch shadow-validation precedent.

---

## 7. Fail-closed invariants for L1+E (must survive the MERGE gate)

- **L1 never fabricates success.** Success comes ONLY from `evaluateCompletion` on a genuinely-finished `state.json`; the completion gate (`state-evaluation.ts:317-331`) and the PUBLISH gate (`:457+`) run exactly as today. L1 can only make the agent *wait longer before* the gate — it cannot satisfy the gate that the work is done.
- **A `classified !== null` failure (credit/auth/billing/model) still exits terminal.** L1's permitted-early-exit (i) is exactly the existing fail-closed ERROR path; the anti-stop CRITICAL explicitly carves it out.
- **The 25-min inner bound is strictly < the 90-min `MAX_JOB_DURATION`** → the poll can never itself cause a cap-kill; the timeout branch fails FORWARD (partial Studio) or exits on an O9 lock-error (manual recovery today — no worse than status quo).
- **L1 is fail-FORWARD, never fail-open on completion.** The timeout branch proceeds toward Phase 6 with what is ready; it never writes a false "complete." If it exits on an error, it exits *terminal* (the same terminal state as today), which is fail-closed.
- **E cannot mask incompleteness.** The heartbeat only writes a human-readable progress `phase_status`; it never advances `phase` or sets `complete`. A heartbeating job that never finishes still hard-fails at the gate.

---

## 8. PUBLISH gate interaction (must NOT bypass) — L1+E

Zero change to `publish-gate.ts`. **L1 never fabricates success** — success comes only from `evaluateCompletion` on a genuinely-finished `state.json`, and the PUBLISH gate at `:457+` then runs exactly as today. L1's fail-forward (proceeding to Studio at the 25-min bound with stragglers) omits late sources, logged to `phase_status`; the PUBLISH gate independently re-verifies claims — it cannot manufacture a false-verified claim from a missing source, only weaken corroboration — so a publish job either verifies against the sources present or fails closed. (O8 — accepted by both reviewers.)

---

## 9. Risk / rollback — L1+E

- **L1 (prompt) is live-immediately (no flag).** Its only rollback is a prompt revert. **L1 is fail-forward and cannot make things *worse* than today** — it can only add waiting + heartbeat; the timeout branch proceeds toward Phase 6, and the worst case (an O9 lock-error exit) is the *same* terminal hard-fail we have today, recovered manually.
- **E co-ships with L1; it is prompt-only + a frontend read-path verification** (the page already renders `phase_status`). No frontend schema change.
- **Blast radius:** L1+E are prompt-only (plus an optional read-only source-list wrapper). No executor change, no sweep change, no migration, no new query.
- **Cost:** L1 = $0 (same turn); E = negligible (per-poll `state.json` write).
- **Staged rollout (S189 flip-then-monitor):** ship L1 + E → observe: do phase-5 stops drop? does the process page stay live? Then, as a **separate follow-on**, build + gate + dark-launch L3 (§X-L3) only if a residual drift rate persists that manual recovery cannot absorb.

---

## 10. Recommendation to the gate

**Implement L1 + E as the durable Fix A v1.** L1 (prompt poll-wait + anti-stop CRITICAL, ALWAYS-emitted outside `publishBlock`) is the primary, $0, fail-forward fix that removes the premature stop for all 4 observed events; E (heartbeat) is mandatory and co-ships so a legitimate wait is observable, not "stuck." Reject `--max-turns` outright. L2 is CUT. **L3 (the auto-recovery net) is DEFERRED to a separate follow-on** with Codex's corrected requirements as its spec (§X-L3) — build it right after L1+E ship, once we observe whether post-L1 drift persists in prod; until then a rare drift is recovered manually (same failure mode as today, now rare).

**Per project §11 HARD RULE:** L1+E are `agent/` PROD-reaching (the anti-stop CRITICAL rides the live worker spawn brief) → **the L1+E MERGE gate is a FULL tri-vendor gate (Gemini + Codex + Claude-author) that must clear BEFORE merge. If Codex is quota-out ⇒ WAIT or §1a API-key flip — do not substitute-and-owe.**

**Key adversarial targets for the L1+E MERGE reviewers:** (1) the anti-stop CRITICAL is ALWAYS-emitted (a publish-gated placement would leave non-publish jobs — the exact Class-A shape — unprotected); (2) the Step A.1 poll uses the **SOURCE** enum (1/5=wait, 2=ready, 3=error), NOT the artifact enum — a wrong-enum poll silently never observes import readiness; (3) the 25-min inner bound stays strictly under `MAX_JOB_DURATION`; (4) the fail-forward branch never writes a false "complete" and the O9-lock exit stays terminal/fail-closed.

---

## X-L3. Deferred: L3 auto-recovery (follow-on design)

**What it is (deferred, not cut).** A last-resort net: when L1 drifts (or L1 exits on an O9 lock-error at fail-forward) AND the stop still has **research docs present + notebook present** (genuinely salvageable), the worker **parks** the row instead of hard-failing, and a **dedicated recovery arm** finishes the Studio products off the critical path. L1 makes this rare; L3 guarantees non-terminality for the residual.

**Why deferred (Codex grounded BLOCK).** Codex read the code and proved L3-as-v2-designed is **infeasible on the primitives v2 named**. The follow-on must be built against the CORRECTED requirements below — each keyed to the Codex finding that generated it. This section is the **spec for when L3 is built**, not a v3 ship item.

### Corrected L3 requirements (the follow-on's build contract)

1. **Dedicated recovery primitive — NOT `regenerate-studio-products.ts` (fixes C1).**
   `regenerate-studio-products.ts` is **clone-only**: it requires `parent_run_id` and exits without it (`:401-407`), and it resolves `notebook_id` by listing/downloading the *parent* run's uploaded Storage `state.json` (`:472-518`). A phase-5/6-stopped original run **never reached the executor upload path** (`executor.ts:639-675`), so that Storage state file does not exist — and faking `parent_run_id=self` still fails because the parent state was never uploaded. Uploads go under `manifestOrgId`+`manifestSlug` (`:729-746`) = the *clone* slug for normal studio-only jobs.
   → **Build a dedicated recovery script/mode** that accepts `{ jobId, original orgId, original slug, notebookId (from the parked payload), selected products }` — resolved from the **parked recovery payload**, NOT via parent lineage or Storage-state resolution. **Generate into the ORIGINAL job's workdir** and upload under the ORIGINAL `<orgId>/<slug>/` prefix (so the existing gallery sees the products — a new-slug upload silently strands).

2. **Source-readiness precheck uses the SOURCE API + SOURCE enum (fixes C2).**
   The precheck must invoke `notebooklm source list -n <id> --json` (emits `status_id: src.status`, `.../notebooklm/cli/source.py:175-188`) and classify by the **SOURCE** enum `PROCESSING=1 / READY=2 / ERROR=3 / PREPARING=5` (`.../notebooklm/rpc/types.py:334-346`): **wait while 1 or 5; ready is 2; 3 is ERROR (do not wait, count out).** It must NOT use `realListArtifactsWithStatus` / the artifact enum (v2's error — that would treat errored sources as ready and never see import readiness). This needs a real source-list wrapper (`agent/lib/nlm-source-cli.ts` or an added export on `nlm-artifact-cli.ts`).

3. **A distinct no-bump precheck outcome dispatched BEFORE the products-array validator (fixes C3).**
   The current sweep computes `newAttempts = attempts + 1` immediately after selecting a due row (`studio-recovery-sweep.ts:241-242`) and every ordinary non-terminal path patches `studio_recovery_attempts: newAttempts` (`:333-344`) — there is **no** no-bump outcome today. The current payload validator requires `products.length > 0` + per-product `artifactId` (`:261-281`), so an empty-`products` resume payload would be classified malformed and exhausted **before** any resume branch at `:395`.
   → **Dispatch/validate `resumeKind:"studio"` BEFORE the products-array validator**; add a distinct `delayed-precheck` (no-bump) path that patches only `studio_recovery_next_attempt_at` (reschedules the tick, leaves `attempts` unchanged); adjust the tests around the current bump tail.

4. **Reconcile the `attempts=1` park with the migration CHECK (fixes M1).**
   The atomic park writes `studio_recovery_attempts: 1` (`executor.ts:583-592`) and the migration CHECK requires pending rows to have `attempts >= 1` (`20260623_studio_recovery_dimension.sql:103-110`) — which **contradicts** "attempts only increment on paid regen" (the park itself would consume attempt 1). → **Either** change the CHECK / initial value for resume-kind rows, **OR** add a **separate paid-attempt counter** distinct from the schema-required `attempts>=1`. Do NOT claim paid-only attempts while mirroring the existing `attempts=1` park.

5. **Atomic sweep-safe completion via `finalizeRecoveredRun`, NOT `runStudioOnly`/`completeJob` (fixes M2).**
   `runStudioOnly` reads a **fresh** `readUrgentBypass` snapshot (`executor.ts:760-764`) and calls `completeJob` directly (`:859-865`); `completeJob` patches `status="completed"` but **not** `studio_recovery_status` (`api-client.ts:115-122`) — leaving a window where the row is `completed` while `studio_recovery_status` stays `pending`, and reading the bypass post-hoc. → **Split "generate products" from "complete job."** The sweep owns completion through `finalizeRecoveredRun(... extraPatch: { studio_recovery_status: "recovered" })` in **one atomic PATCH** (`finalize-recovered-run.ts:382-395` already does `status`+`result_slug`+`extraPatch` in one body), and threads the **ORIGINAL** job's pre-spawn publish/bypass decision (never a fresh post-hoc read — O5).

6. **O9 (NLM generate-during-import concurrency) needs a LIVE-TEST.**
   Codex (reading the NotebookLM CLI Python) could not determine from the wrappers whether the live service permits `generate` while sources are still processing — the CLI does not preflight source readiness before `generate` (`.../notebooklm/cli/generate.py:381-399`, `:493-519`; `_artifacts.py:1953-1987`), though the RPC-layer comments say sources must finish before chat/artifact generation (`.../notebooklm/rpc/types.py:334-339`; `_sources.py:176-213`). → **Live-test** whether `generate` during an active import errors or blocks; the L3 precheck design (cheap-wait until sources ready) is the safe path regardless, and it removes the dependency on the O9 answer for the *sweep* leg (the precheck waits before generating).

**Preserved-from-v2 L3 invariants that remain valid (carry into the follow-on):** park ONLY when notebook present + `publishOk===true` + every research-text deliverable present + ≥1 selected studio product missing (fail-CLOSED on any miss); park PATCH atomic with `status='failed'`+`studio_recovery_status='pending'` (no escape window); mutual-exclusion with the S187 video-defer probe by construction; a reduced resume attempt cap; `finalizeRecoveredRun` re-asserts the FULL obligation set (never PATCH `recovered` with a product missing — the S162 fail-open keystone); dark-launch flag `STUDIO_IMPORT_RESUME_ENABLED` (default OFF) with flip-then-monitor rollout.

**When to build it:** immediately after L1+E ship and we have prod observation of whether a residual post-L1 drift rate persists. If drift is effectively eliminated by L1, L3 remains a low-priority net; if a residual persists at a rate manual recovery cannot absorb, L3 becomes the next MERGE gate (full tri-vendor, per §11).

---

## X-L2. Considered & deferred — L2 harness continuation (CUT)

**What it was.** A "bounded harness continuation loop" backstop: when L1 drifted and the first `claude -p` spawn ended its turn early at phase 4–6 with a notebook present and no terminal error, the executor would **re-spawn the agent ONCE** (default `EXECUTOR_CONTINUATION_MAX_ATTEMPTS=1`, dark-launch flag `EXECUTOR_CONTINUATION_ENABLED=false`) with a minimal anti-re-import continuation prompt pointing at the SAME `promptPath` + `workDir` + `state.json`, to resume from the current state and finish through Finalization. It comprised:
- **Change 2.1** — a pure classifier `shouldContinuePipeline(...)` in `state-evaluation.ts` (sibling to `shouldDeferForVideoRender`), continuing ONLY when ALL held: `!hasTerminalError`; non-empty `notebookId`; `4 <= phaseNum < 7`; `attemptsSoFar < maxAttempts`; `elapsedActiveMs < maxJobDurationMs * CONTINUE_BUDGET_FRACTION` (default 0.75); and `phaseStatus` not matching `/^error[:\s-]/i` nor containing `PUBLISH fail-closed`. Fail-closed on the first miss.
- **Change 2.2** — a bounded continuation loop in `executor.ts` (`for (; continuationAttempts <= maxAttempts; )`, NOT `while(true)`; structural cap assert independent of the probe) wrapping spawn + `waitForProcess` + the exit!=0 block + the `!verdict.success` block, accumulating `cumulativeActiveMs`, with the S187 Gate-A video-defer probe running FIRST. Env tunables: `EXECUTOR_CONTINUATION_MAX_ATTEMPTS` (1), `EXECUTOR_CONTINUATION_BUDGET_FRACTION` (0.75), `EXECUTOR_CONTINUATION_ENABLED` (false).
- **Change 2.3** — a minimal anti-re-import continuation prompt ("DO NOT restart from Phase 0. DO NOT re-add or re-import sources — the notebook ALREADY has them. Resume from current state; poll the pending import/render to completion; finish through Finalization.").
- **Change 2.4** — `waitForProcess` returning `activeMs` (additive) so the loop could accumulate wall-clock across attempts against the shared `MAX_JOB_DURATION` ceiling.

**Why cut (both reviewers).** A probabilistic re-spawn *duplicates the very L1 risk-class* it is meant to backstop — a fresh `claude -p` context can hallucinate, early-stop again, or (despite the anti-re-import clause) re-run paid Perplexity/plan-synth and duplicate NLM sources. It also threaded a **CRITICAL budget fail-open**: Gemini's grounded catch was that Change 2.4 only made `waitForProcess` *return* `activeMs` but never changed its *input* signature to *accept* a dynamic timeout — so a second spawn would receive a *fresh* 90-min allowance (90 + 67.5 = 157.5 min), breaching the container timeout with an ungraceful SIGKILL and a stranded job. A deterministic, off-critical-path resume (the deferred L3, once correctly built) covers the backstop role **safely** — no fresh probabilistic context, no budget-threading fail-open, no duplicate-import risk. Cutting L2 dissolves that CRITICAL entirely and removes an entire probabilistic failure surface. Codex INFO confirmed L2 is already absent from code (`rg` found no `EXECUTOR_CONTINUATION`/`shouldContinuePipeline`).

**Revisit criteria.** Reconsider L2 **ONLY if L1 + (the eventual) L3 prove insufficient in production** — specifically, if phase-4–6 early stops persist at a material rate AFTER L1 ships AND L3 is enabled, indicating a class of stop that L3's studio-resume cannot salvage. If that materializes, re-open L2 with the budget-threading fix (`waitForProcess` accepting `remainingBudgetMs = MAX_JOB_DURATION − cumulativeActiveMs`, never a fresh 90-min) as a hard precondition, behind its own dark-launch flag, and re-run the full tri-vendor gate.
