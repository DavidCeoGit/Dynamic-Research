# Studio render-backoff tuning — DESIGN gate (§9 faster render backoff + fast-terminalize on failed status)

> **Status:** DESIGN gate, v1 (S191, 2026-06-30). Author: Claude (Opus 4.8).
> **Gate:** DESIGN → Gemini (holistic-adversarial) → integrate → Codex (grounded-adversarial). Companion synthesis: `studio-render-backoff-tuning-design-gate-peer-review.md`.
> **Extends / closes the deferred backlog of:** `studio-video-best-effort-completion-design-gate.md` §9/§10 ("render backoff faster than download (2m,5m,10m,15m…); render-failed → fast terminality") and `studio-video-best-effort-completion-merge-gate-peer-review.md` §4 deferred items (a) faster render backoff + (b) fast-terminalize on a known-FAILED render status. Read both first.
> **Risk labels (downstream MERGE):** AGENT BEHAVIOR (worker recovery cadence + terminal-decision timing). NOT SECURITY/DATA/PRIVACY. `agent/` PROD → §11 HARD RULE: full tri-vendor MERGE gate BEFORE merge, no substitutes.
> **This gate ships NO code.** The IMPL/MERGE/deploy is gated behind (1) the S190 DR live-runtime freeze all-clear and (2) the full §11 tri-vendor MERGE gate + worker restart. This doc + its peer review are the only artifacts produced now.
>
> **v1.1 (S191) — integrated Gemini 3.1-pro holistic-adversarial (verdict BLOCK):** CRITICAL — removed the illusory stateless `newAttempts>=2` "confirmation gate" (Design B now relies on allowlist strictness + the downstream obligation re-assert; stateful streak = deferred D-B3). MAJOR — render schedule shifted to land the window-crossing tick at **125m** (deliberate margin) instead of exactly 120m (knife-edge jitter). MINOR — mixed-payload cadence scoped honestly (download cadence until the blip clears). INFO — failed-status parser also rejects in_progress. Verbatim findings + dispositions in the companion peer-review doc.
>
> **v1.2 (S191) — integrated Codex gpt-5.5 xhigh grounded-adversarial (verdict BLOCK):** CRITICAL — `attemptRecovery` must return a *structured* non-terminal result so the cap tail can read `renderOnlyRemaining` (otherwise out of scope at the tail). MAJOR — grounded source-research found the real `notebooklm-py` enum (`1=PROCESSING,2=PENDING,3=COMPLETED,4=FAILED`) → parser must also reject `2`, and `4` is the value to arm; purged residual stale `≥2`/`25`/`render-or-mixed` references the v1.1 sweep missed. MINOR — executor park-kind must be computed before `nextIso`; the best-effort operator alert needs a reason/status field. Codex INFO independently re-traced the §3 schedule×cap sequence and confirmed NO attempt-cap regression.

---

## 0. TL;DR

The S187/S188 best-effort still-rendering-video feature is correct and shipped (flag `STUDIO_VIDEO_RENDER_ENABLED` ON since S189), but its **timing is governed by the shared download backoff schedule**, which makes it *materially less responsive* than its own design intent in two ways. This gate designs the deferred §9 tuning:

- **A — dedicated render backoff schedule.** Today the render arm reuses `BACKOFF_SCHEDULE_MS` (5m/15m/45m/2h…), so poll ticks land at ~5, 20, 65, **185 min**. The 120-min render window's *first* best-effort completion therefore fires at ~**185 min**, not ~120 min; and a video that finishes rendering at ~25 min isn't downloaded until the ~65-min tick. A dedicated, front-dense render schedule moves first-best-effort to ~**125 min** (a small deliberate margin past the 120-min window edge, §4.1) and downloads a completed render within ~5–15 min of completion.
- **B — fast-terminalize on a positively-confirmed FAILED render status.** Today the render arm treats *any* matched non-`status_id-3` artifact (including a genuinely **failed** render) as "still rendering — keep waiting," so a failed render waits out the full window before best-effort. A positively-gated failed-status allowlist lets a confirmed-failed render route to best-effort completion in minutes instead of ~120 min.

**The single non-obvious finding (the keystone of this design):** a faster render schedule, left on the **shared `MAX_ATTEMPTS = 8`** cap, sits at **zero margin** against the attempt-cap — and a small schedule change or poll jitter would flip a best-effort completion into an attempt-cap **hard failure** (a regression that strands 4 good products + research docs over one video). Design A therefore **must** decouple the render attempt cap from the download cap. This is the load-bearing design decision; the exact schedule values are secondary tuning.

**Both refinements are responsiveness improvements, not correctness changes.** Every terminal completion still flows through the unchanged `finalizeBestEffortRun`, which re-asserts the full non-video obligation set + research docs + publish/claims before it can PATCH `completed`. Faster ≠ less safe (proof in §6).

---

## 1. Current mechanism (ground truth, with file:line)

### 1.1 How a render-kind recovery is paced
1. **Park (executor).** On the transient studio branch, `executor.ts:559` writes `studio_recovery_next_attempt_at = now + studioRecoveryBackoffMs(1)` (= **5 min**, the shared schedule's first entry), `studio_recovery_attempts = 1`, `studio_recovery_first_failed_at = now` (the trigger-immune age anchor, G6). This is **`recovery_kind`-agnostic** — a render park uses the same 5-min first delay as a download park.
2. **Due-candidate query** (`studio-recovery-sweep.ts:761-763`): a row is due when `studio_recovery_next_attempt_at <= now` and `first_failed_at <= now − GRACE(2m)`, ordered by next-attempt ascending, **one per tick**.
3. **Per sweep tick** (`runStudioRecoverySweepOnce`): `newAttempts = (attempts ?? 0) + 1`; on a non-recovery pass the cap/bump tail (`:336`) writes `next_attempt_at = now + studioRecoveryBackoffMs(newAttempts)` and stores `attempts = newAttempts`.
4. **Render arm** (`:412-458`): polls the **status-aware** list, anti-stale-matches by `videoTaskId` / `runFloorMs`. `status_id 3` → download by the list-canonical id. **Otherwise (`!match || match.status_id !== 3`, `:429`) → "still rendering — keep waiting"** (added to `missing[]`, never artifact-gone-exhausts).
5. **Best-effort completion** (`:573-578`): fires when `renderOnlyRemaining` (every still-missing product is render-kind) **AND** `renderWindowExhausted` (`ageMs >= STUDIO_VIDEO_RENDER_MAX_AGE_MS(120m)` **AND** `newAttempts >= MIN_ATTEMPTS_FOR_AGE_EXHAUST(3)`). Routes to `finalizeBestEffort` → `completed` + `studio_recovery_video_deferred = true` + requester email + operator alert.
6. **Cap tail** (`:324-331`, runs only when `attemptRecovery` returns `null`): `newAttempts > MAX_ATTEMPTS(8)` → `finishExhausted("attempt-cap")` (a **hard FAIL**); `ageMs > MAX_AGE_MS(48h)` and `attempts >= MIN(3)` → `finishExhausted("age-cap")`.

### 1.2 The resulting cadence (shared schedule)
`BACKOFF_SCHEDULE_MS = [5m, 15m, 45m, 2h, 4h, 8h, 12h]` (`:102-110`). Tick *k* is due at the cumulative sum of `backoff(1..k)`; stored `attempts` after tick *k* is *k*+1:

| Tick | Wall-clock (cum.) | `newAttempts` | age ≥ 120m? | Action |
|---|---|---|---|---|
| park | 0 | 1 | — | schedule t=5m |
| t1 | **5 min** | 2 | no | render in progress → wait |
| t2 | **20 min** | 3 | no | wait |
| t3 | **65 min** | 4 | no | wait (a render *completed* at 25m is only **downloaded here**) |
| t4 | **185 min** | 5 | **yes** | **best-effort fires** |

So: **first best-effort ≈ 185 min** (intended ≈ 120 min — a ~65-min overshoot), and **a completed render waits up to ~40 min for download** (finishes 25m, downloaded 65m). Both are latency/responsiveness gaps, not correctness gaps — confirmed by both S188 reviewers (`...merge-gate-peer-review.md` §4: Codex MINOR + INFO).

### 1.3 The NLM status model (the constraint for Design B)
`nlm-artifact-cli.ts:39` documents only **`status_id 1 = in_progress (rendering)`, `3 = completed`, `(other = failed/unknown)`** — its comment conflates "failed" and "unknown." **Codex grounded research (this gate) read the actual underlying CLI source:** `notebooklm-py` v0.3.4 `ArtifactStatus` enum is **`1=PROCESSING, 2=PENDING, 3=COMPLETED, 4=FAILED`** ([rpc/types.py](https://github.com/teng-lin/notebooklm-py/blob/v0.3.4/src/notebooklm/rpc/types.py#L111-L120); the CLI emits `status_id` from it). So **`4=FAILED`** is the candidate terminal-failed value and **`2=PENDING`** is a transitional/queued (NON-terminal) state. **Caveat:** this is an *unofficial* package wrapping undocumented Google APIs — strong evidence, NOT a Google contract. Design B therefore stays fail-safe: it treats *only* an operator-armed, positively-confirmed value as failed (default empty), and the parser hard-rejects the three KNOWN non-failed values `{1,2,3}` so neither a rendering, queued, nor completed status can ever be armed as failed.

---

## 2. Objectives & non-goals

**Objectives**
- **O1** First best-effort completion of a never-finishing render fires near the 120-min intent (target ≤ ~125 min), not ~185 min.
- **O2** A render that *completes* mid-window is downloaded within ~5–15 min of completion (not up to ~40 min late).
- **O3** A render whose status is **positively** confirmed FAILED terminalizes in minutes (best-effort completion of the other 4/5 + research docs + alert), not after the full window.
- **O4** Zero regression to the download arm, to correctness, or to the fail-closed guarantees. No new strand class.

**Non-goals**
- Not changing *what* best-effort completion does (the `finalizeBestEffortRun` obligation re-assert is untouched).
- Not changing the 48h `MAX_AGE_MS` download cap or the download schedule.
- Not attempting to attach a late video to an already-`completed` row (design D-10: out of scope).
- Not introducing a new `studio_recovery_status` enum value or any schema/CHECK change (Design B uses code + env only).

---

## 3. The keystone: render schedule × attempt-cap coupling (why a dedicated cap is required, not optional)

A faster schedule produces **more ticks before age 120m**. Each tick increments `newAttempts`. The cap tail hard-fails at `newAttempts > MAX_ATTEMPTS(8)` whenever `attemptRecovery` returns `null` — which is **exactly** the still-rendering case (age < 120m). So:

> **Hazard:** if any tick lands with `age < 120m` **and** `newAttempts > 8`, the render hits `finishExhausted("attempt-cap")` — a **hard FAIL** — *before* the age window can route it to best-effort. That converts a clean best-effort completion (4/5 + research delivered) into a total job failure.

Worked example on the shared cap (8) with the §4 schedule: the last pre-window tick is t7 = 90 min at `newAttempts = 8` (= cap exactly). best-effort fires at t8 = 125 min (`newAttempts = 9`) **inside** `attemptRecovery`, before the cap check runs. It works — but at **zero margin**: one extra early tick (a denser schedule, or poll jitter producing an off-by-one), and `newAttempts = 9` lands at `age < 120m` → hard fail. A schedule tuned for responsiveness must not be one edit away from a hard-fail regression.

**Decision (D-A1):** give the render path a **dedicated, higher attempt cap** (`STUDIO_VIDEO_RENDER_MAX_ATTEMPTS`, default **12**) used in the cap tail when the candidate is render-only. The age window (120m) remains the **normal** terminal driver for a never-finishing render; the render attempt-cap becomes a pure **backstop** for the pathological case (e.g. repeated best-effort refusal, or clock skew), sized with comfortable margin past the window. This removes the coupling entirely: the schedule can be tuned for O1/O2 without ever risking the O4 regression.

(Alternative considered — exempt render-kind from the attempt-cap and rely solely on the 48h/120m age caps: rejected. The attempt-cap is a cheap, valuable backstop against an unforeseen infinite-retry bug; a sized render cap keeps that protection while creating margin. Decoupling, not removing, is the conservative choice.)

---

## 4. Design A — dedicated render backoff schedule

### 4.1 The schedule
A new module constant, front-dense then coarsening to land a tick on ~120 min:

```
RENDER_BACKOFF_SCHEDULE_MS = [3m, 5m, 7m, 10m, 15m, 20m, 30m, 35m]   // then 35m cap
```

> **Why not sum to exactly 120m? (Gemini MAJOR)** An earlier draft used `…25m,35m` summing to *exactly* 120m at the crossing tick. The best-effort gate is `ageMs >= 120m`; landing the crossing tick on that knife-edge means any negative jitter (clock skew between the park write and the sweep read, or a tick processed a hair early) bumps the crossing to the *next* tick (+35m → ~160m), silently defeating O1. The `…20m,30m,35m` schedule lands the crossing tick at **125m** — a deliberate ~5-min margin past the window edge — so the gate passes regardless of jitter, while the early download-responsiveness band (3/8/15/25/40/60) is unchanged.

`studioRenderBackoffMs(attempts) = RENDER_BACKOFF_SCHEDULE_MS[min(attempts-1, len-1)]`. Resulting cadence (download row shown for contrast):

| Tick | `newAttempts` | Render cadence (cum.) | age ≥ 120m? | Shared/download cadence (cum.) |
|---|---|---|---|---|
| t1 | 2 | **3 min** | no | 5 min |
| t2 | 3 | **8 min** | no | 20 min |
| t3 | 4 | **15 min** | no | 65 min |
| t4 | 5 | **25 min** | no | 185 min |
| t5 | 6 | **40 min** | no | … |
| t6 | 7 | **60 min** | no | |
| t7 | 8 | **90 min** | no | |
| t8 | 9 | **125 min** | **yes → best-effort** | |
| t9 | 10 | 160 min | (n/a, already terminal) | |

- **O1 met:** first best-effort at t8 ≈ **125 min** (was ~185). Residual overshoot ≈ 5 min by construction (a deliberate margin past the 120-min edge, §4.1; real-world a few minutes more due to 30s poll + 5-min cron granularity).
- **O2 met:** a render completing at ~22 min is *seen* at t4 = 25 min and downloaded immediately (was ~65 min); one completing at ~45 min is downloaded at t5 = 60 min. Download latency drops from up to ~40 min to ~5–15 min across the band.
- **Polling cost:** ~8 `notebooklm artifact list` subprocess spawns over the first 120 min (vs ~4 today). No `$` cost (local CLI), bounded, acceptable. Cron is 5-min granular so ticks at 3/8 min effectively coalesce to the next cron edge — the schedule is an *upper bound* on responsiveness, never a tight loop.

### 4.2 The render attempt cap (from §3)
```
STUDIO_VIDEO_RENDER_MAX_ATTEMPTS  (default 12)   // render-only candidates; backstop, not normal path
```
Cap-tail backstop first bites when `newAttempts > 12`: t9≈160m (att10), t10≈195m (att11), t11≈230m (att12), t12≈265m (att13 > 12) → ~**265 min**, comfortably past the 125-min best-effort. The 3-attempt margin (att9 at best-effort → cap 12) absorbs best-effort *refusals* (a transient non-video obligation gap at the window edge → return to the cap tail, re-bump, retry at 35-min cadence) without a premature hard-fail. The **download** path keeps `MAX_ATTEMPTS = 8` unchanged.

### 4.3 Executor first-park (the missed seam)
`executor.ts:559` must schedule the **first** park with the render cadence when (and only when) the payload is **render-only**, else dense polling doesn't start and the first interval is wrong. Rule: **if the park payload is render-ONLY, use `studioRenderBackoffMs(1)` (3 min); otherwise (download-only OR mixed) use `studioRecoveryBackoffMs(1)` (5 min).** A *mixed* payload (a download blip + a still-rendering video) deliberately uses the **download** cadence (see §4.4 / D-A3) — it cannot use the fast render cadence while a download is co-pending without risking the download leg's own 8-attempt cap (the §3 hazard applied to the download). Once the blip clears and only the render remains, the cap tail (§4.4) switches that job to the fast render cadence. **Plumbing note (Codex MINOR):** `executor.ts:559` computes `nextIso` *before* the `payload` is built (`:560`), so the MERGE must compute `parkKind = recoverable.every(rp => rp.recovery_kind === "render") ? "render" : "download"` (absent kind ⇒ download) *before* `nextIso`. The `(first retry ~Nmin)` log line (`:607`) reads from the same chosen function.

### 4.4 Selecting the schedule per tick
The sweep cap-tail (`:336`) and the executor park must pick the schedule by kind. Cleanest signature-compatible shape: extend the existing exported helper with an optional kind —
```
studioRecoveryBackoffMs(attempts: number, kind: "download" | "render" = "download"): number
```
— so all existing callers (and the 4 unit tests at `studio-recovery-sweep.test.ts:701-706`) are unchanged (default `"download"`), and the render seams pass `"render"`. The cap tail then selects `kind = renderOnlyRemaining ? "render" : "download"`.

> **Plumbing correction (Codex CRITICAL).** `renderOnlyRemaining` is computed *inside* `attemptRecovery` (`:576`), but the cap/bump tail runs in `runStudioRecoverySweepOnce` *after* `attemptRecovery` returns `null` (`:313`/`:324`/`:336`) — so as written that variable is **out of scope** at the tail. The MERGE must therefore change `attemptRecovery`'s "not recovered" contract from a bare `null` to a **structured non-terminal result**, e.g. `{ terminal: null, renderOnlyRemaining: boolean, bestEffortReason?: "window" | "failed" }`, and the caller threads that one value into the cap selection, the backoff `kind`, the log line, AND the operator-alert reason (§7 notify). A mixed payload still pending a download product reports `renderOnlyRemaining = false` → stays on the download cadence/cap (correct — the slow product dominates).

### 4.5 Tunables (all env-guarded, NaN/negative-safe via the existing `envInt`/`envMs`; DR-Deploy `.env` needs NO change)
| Env var | Default | Meaning |
|---|---|---|
| `STUDIO_VIDEO_RENDER_MAX_AGE_MS` | 7_200_000 (120m) | render window (unchanged from S187) |
| `STUDIO_VIDEO_RENDER_MAX_ATTEMPTS` | 12 | render-only attempt-cap backstop (NEW) |
| `STUDIO_VIDEO_RENDER_FAILED_STATUS_IDS` | `""` (empty) | Design B failed-status allowlist (NEW; empty ⇒ inert) |

`RENDER_BACKOFF_SCHEDULE_MS` is a **code constant** (like `BACKOFF_SCHEDULE_MS`), not an env CSV — a schedule is a structural choice that should move through the MERGE gate, and keeping it a const avoids a CSV-parse surface. The ops knobs (window, cap, failed-allowlist) are env.

---

## 5. Design B — fast-terminalize on a positively-confirmed FAILED render status

### 5.1 The mechanism
At the render arm (`:429`), when the anti-stale-matched artifact's `status_id` is in a **positively-confirmed failed allowlist**, the product is flagged render-**failed** rather than still-rendering, and the candidate routes to the **best-effort path immediately** — bypassing the `renderWindowExhausted` *age* gate, but **still** requiring `renderOnlyRemaining` + the full `finalizeBestEffortRun` obligation re-assert (§6). A confirmed-failed render will never reach `status_id 3`, so waiting out 120 min is pure dead time; best-effort delivers the 4/5 + research docs + honest "video unavailable" note + operator alert in minutes.

### 5.2 The safety gate (respecting the §1.3 constraint)
Because NLM conflates "failed" and "unknown," fast-terminalize is **fail-safe by construction** — its safety rests on the allowlist + the unchanged downstream obligation re-assert, NOT on counting:
- **Allowlist, default empty.** `STUDIO_VIDEO_RENDER_FAILED_STATUS_IDS` is empty by default ⇒ **no status is ever treated as failed** ⇒ behavior is byte-identical to today (any non-3 → keep waiting). The mechanism ships **inert**.
- **Positively-listed only; `1`/`2`/`3` are rejected (Gemini INFO + Codex MAJOR).** A status is treated as failed *only* if its `status_id` is explicitly enumerated. An *unknown* status (not in the allowlist) keeps waiting — today's conservative behavior; we never infer "failed" from "not-completed." The parser additionally **drops `1` (PROCESSING), `2` (PENDING), and `3` (COMPLETED)** — the three KNOWN non-failed/non-terminal values (§1.3) can never be armed as "failed," so a fat-fingered `.env` cannot fast-fail a rendering, queued, or completed video. The known terminal-failed value to arm is **`4` (FAILED)** (§1.3, unofficial-source caveat).
- **No stateless "confirmation" theatre (Gemini CRITICAL).** An earlier draft gated fast-terminalize on `newAttempts >= 2` and called it "seen on ≥2 attempts." That was **false**: the executor park sets `attempts = 1`, so the *first* sweep tick already has `newAttempts = 2` — the gate is always true on the first sighting, and the stateless worker holds no memory of a *prior* tick's status. We **remove** that illusory gate. Fast-terminalize fires on the **first** armed sighting; its safety does not depend on a count, because (a) the allowlist only ever contains a *positively-confirmed terminal* status (a render does not un-fail), and (b) a wrong fire is still caught downstream (§5.3) and degrades only to a slightly-early *safe* best-effort, never a corrupt completion. If operational experience later shows the failed `status_id` is *transiently* mis-reported, genuine consecutive confirmation needs **persisted** state — a per-job `render_failed_streak` counter — tracked as deferred **D-B3**, not adopted in v1.
- **Arming is deliberate + reversible.** The confirmed terminal-failed `status_id` is learned empirically — from the first real shadow run that hits a failed render, or from the NotebookLM CLI source. Until then the allowlist stays empty. Setting `STUDIO_VIDEO_RENDER_FAILED_STATUS_IDS="<n>"` in DR-Deploy `.env` arms it; clearing it disarms — no redeploy, fully reversible.

### 5.3 Why this can never produce an unsafe completion
Fast-terminalize only short-circuits the **wait**; it does not change the **completion gate**. It still funnels through `finalizeBestEffortRun`, which re-asserts every non-video obligation (4 non-video studio products on disk + all 5 research docs + publish/claims) and refuses on any gap. The worst case of a *wrong* fast-terminalize (a status mis-listed as failed that would actually have completed) is: best-effort-completing video-deferred a bit early — the same safe outcome the 120-min window produces, just sooner — never a corrupt or partial completion. The merge-gate review already validated this class as non-blocking (`...merge-gate-peer-review.md` §4 INFO: "Still cannot complete before finalizeBestEffortRun reasserts non-video obligations").

---

## 6. Invariants preserved + fail-open proof

The S188 HARD INVARIANTS (I1–I7) are **unchanged** — this gate touches *timing*, not *decisions*:
- **I1/I2/I7 (fail-closed):** the completion gate is still `finalizeBestEffortRun`'s obligation re-assert. Neither a faster schedule nor a fast-terminalize can complete a run with any non-video gap, missing research doc, failed publish, never-launched/foreign/stale video, or any terminal-error classification. Design B *adds* a trigger condition (confirmed-failed status) to *enter* the same gate sooner; it cannot relax the gate.
- **I5 (completes exactly once):** unchanged — best-effort still flips `failed → completed` exactly once via the same `finalizeBestEffort` path; the faster cadence changes *when*, not *whether-once*.
- **I6 (billing):** unchanged — `markUsageCompleted` idempotent UPDATE on the completed edge (S186), independent of cadence.
- **No new strand class (O4):** the existing strand-guards are cadence-independent and still cover every seam — the per-dep finalize try/catch (`:524-547`, `:583-600`), the structural backstop around `attemptRecovery` (`:311-321`), and the attempt/age caps. A faster schedule only changes the *interval* between bumps; the bump-or-exhaust tail still runs on every non-recovery tick, so attempts always progress and the caps always eventually trip. The render attempt-cap (D-A1) is an *additional* terminal backstop, strictly reducing strand risk, not adding to it.
- **Fail-open proof delta:** the only new code paths are (A) a different `next_attempt_at` value and a different cap constant for render-only candidates, and (B) one extra branch at the render arm that, on a positively-listed failed status (first armed sighting), sets the same `missing[]`/best-effort routing the age window already uses. Neither path can reach `completed` without the unchanged obligation re-assert. ∎

---

## 7. Files (downstream MERGE — no code shipped in this gate)
- `agent/lib/studio-recovery-sweep.ts` — `RENDER_BACKOFF_SCHEDULE_MS` const + `studioRecoveryBackoffMs(attempts, kind)` extension; **`attemptRecovery` returns a structured non-terminal result** (`{terminal:null, renderOnlyRemaining, bestEffortReason}`) so the cap tail can select cap/cadence/alert-reason (Codex CRITICAL); `STUDIO_VIDEO_RENDER_MAX_ATTEMPTS` env + render-only cap selection in the cap tail; render-failed allowlist check at the render arm (`:429`) firing on the **first armed sighting**; best-effort routing on render-failed (bypass age gate, keep `renderOnlyRemaining` + obligation re-assert).
- `agent/lib/worker-config.ts` (or the sweep's tunables block) — `STUDIO_VIDEO_RENDER_MAX_ATTEMPTS`, `STUDIO_VIDEO_RENDER_FAILED_STATUS_IDS` parse (NaN/negative-safe; CSV → set of finite non-negative ints; **`1`/`2`/`3` are dropped** so PROCESSING/PENDING/COMPLETED can never be armed as failed; empty/all-invalid ⇒ inert).
- `agent/executor.ts:559,607` — render-kind first-park uses `studioRenderBackoffMs(1)`; the `(first retry ~Nmin)` log mirrors it.
- `agent/lib/notify.ts` — distinct operator-alert copy for **render-failed** (fast-terminalized) vs **render-window-exhausted** best-effort, so diagnostics can tell the two apart (both → best-effort completion + "video unavailable" requester note). **A `reason`/`status_id` field must be plumbed into the best-effort alert** (Codex MINOR): the current `sendBestEffortAlert` (`studio-recovery-sweep.ts:198` deps / `notify.ts:475`) hardcodes "render window exceeded" — a fast-failed render must carry its reason so the alert reads "render FAILED (status_id N)," not "window exceeded" (this is the `bestEffortReason` threaded from the §4.4 structured return).
- `agent/lib/nlm-artifact-cli.ts` — (only if a status helper is cleaner) a `videoRenderFailed(status_id, allowlist)` predicate; otherwise inline in the sweep.
- **No migration, no schema/CHECK/enum change. No frontend change** (the results-page surface shipped S189; "video unavailable" copy already covers best-effort regardless of *why* the render didn't land).

## 8. Test strategy (`node --test`; thread consts via params where load-time, per the S188 pattern)
1. **`studioRecoveryBackoffMs(attempts, kind)`:** `"download"` (default) returns the existing 5/15/45/… values (the 4 existing tests at `:701-706` must still pass unchanged); `"render"` returns 3/5/7/10/15/20/**30**/35 with the 35m cap; both clamp negative/huge attempts.
2. **Render cadence → best-effort at the window, not the attempt-cap:** a render-only candidate stepped through the render cadence reaches best-effort at `newAttempts = 9` / age ~125m **before** any attempt-cap fire; assert it does **not** `finishExhausted("attempt-cap")` at `newAttempts > 8` (the §3 regression guard — the highest-value test). Assert the crossing tick has `age >= 120m` with margin (not on the knife-edge — Gemini MAJOR).
3. **Render attempt-cap backstop:** a render-only candidate that *repeatedly refuses* best-effort eventually `finishExhausted("attempt-cap")` at `newAttempts > STUDIO_VIDEO_RENDER_MAX_ATTEMPTS(12)`, not at 8.
4. **Executor render-park cadence:** a render-**ONLY** park schedules `next_attempt_at = now + 3m`; a **mixed** park (download + render) AND a download-only park stay `now + 5m` (Codex MAJOR — mixed parks on the download cadence, §4.3).
5. **Fast-terminalize — armed:** allowlist `{4}`, matched artifact `status_id 4`, render-only, obligations satisfiable → best-effort completes (video deferred) **without** waiting for age ≥ 120m, on the **first** armed sighting; operator alert uses the **render-failed** copy.
6. **Fast-terminalize — fires on first armed sighting (no count gate):** an allowlisted `status_id` on the FIRST armed sweep tick → best-effort immediately (the removed `newAttempts>=2` gate must NOT reappear — Gemini CRITICAL regression guard); inert when the allowlist is empty.
7. **Fast-terminalize — inert default + unknown-status safety:** empty allowlist → any non-3 status keeps waiting (byte-identical to today); a non-listed unknown status (e.g. 2) → keeps waiting even when armed for a different value.
8. **Fast-terminalize respects the obligation gate:** render-failed **plus** a still-missing *download* product → `renderOnlyRemaining` false → best-effort refuses → continued-transient (no premature completion).
9. **NaN/negative/garbage env safety:** `STUDIO_VIDEO_RENDER_MAX_ATTEMPTS=-1`/`abc` → default 12; `STUDIO_VIDEO_RENDER_FAILED_STATUS_IDS="1,2,3"` (someone lists PROCESSING/PENDING/COMPLETED as failed) → guard: **`1`, `2`, and `3` are all dropped** → inert; a valid `"4"` (FAILED) is kept.
10. **No download-arm regression:** a download-kind recovery scenario is byte-identical (same schedule, same MAX_ATTEMPTS=8) — assert via the existing download tests still green.

## 9. Open decisions (for the reviewers)
- **D-A1 (render attempt cap):** RESOLVED → dedicated `STUDIO_VIDEO_RENDER_MAX_ATTEMPTS=12` (§3). Reviewer check: is 12 the right default given the schedule lands best-effort at `newAttempts=9`? (margin = 3 best-effort-refusal retries.)
- **D-A2 (schedule values):** PROPOSED `[3,5,7,10,15,20,30,35]m` (crossing tick at **125m**, a deliberate margin past the 120m window — Gemini MAJOR). Reviewer check: front-density vs CLI-spawn cost; should the early band be even denser (most renders finish 5–25 min) at the cost of more list calls?
- **D-A3 (mixed-payload cadence) — REVISED per Gemini MINOR:** a *mixed* payload (download blip + render) uses the **download** cadence + download cap **while a download is still pending** — it cannot use the fast render cadence then without burning the download leg's 8-attempt cap (the §3 hazard applied to the download). Once the download resolves and only the render remains (`renderOnlyRemaining`), subsequent ticks switch to the fast render cadence + render cap. **Documented limitation:** O2 (fast download of a completed render) is fully met for render-ONLY payloads and for the render *tail* of a mixed payload (after the blip clears), but NOT for a render while a download is co-pending. Mixed payloads are rare (both a non-video download blip AND a still-rendering video at the same checkpoint); safety dominates.
- **D-B1 (failed-status allowlist) — RESOLVED, enum now known (Codex MAJOR):** positively-confirmed allowlist, default empty/inert, fires on first armed sighting (§5.2). Codex source-research found the real enum — `notebooklm-py` v0.3.4 `ArtifactStatus` `4=FAILED` (§1.3). Default stays **empty** (the source is unofficial — strong but not contract-grade); the operator arms `STUDIO_VIDEO_RENDER_FAILED_STATUS_IDS="4"` deliberately once a shadow run confirms `status_id 4` on a real failed render. The parser hard-rejects `{1,2,3}` regardless.
- **D-B2 (failed → best-effort vs hard-fail):** RESOLVED → best-effort completion (deliver 4/5 + research + alert), consistent with the feature philosophy (never strand 4 good products + research over one video). Reviewer check: any case where a *failed* render should instead hard-fail the whole job? (We think no — the non-video deliverables are independently valuable and already on disk.)
- **D-B3 (new — stateful confirmation, DEFERRED, from Gemini CRITICAL):** v1 fast-terminalizes on the *first* armed sighting (no stateless count gate — the removed `newAttempts>=2` was dead code). If a shadow run shows the failed `status_id` is ever *transiently* mis-reported, add a **persisted** per-job `render_failed_streak` counter so fast-terminalize requires N *consecutive* failed sightings. Deferred — allowlist strictness + the downstream obligation re-assert already make a wrong fire safe (a stateless counter cannot give consecutive confirmation, so v1 simply doesn't pretend to).
- **D-A4 (cron granularity floor):** the worker cron is 5-min; a 3-min first interval effectively rounds up to the next cron edge. Does the schedule's sub-5-min head (3m) buy anything, or should the floor be 5m? (We keep 3m: it sets the *upper bound*; when the worker is continuously alive — the post-P0-1 always-on target — the 3m is real.)

## 10. Rollout (downstream, after the freeze all-clear + the MERGE gate)
1. This is `agent/` PROD → **full §11 tri-vendor MERGE gate BEFORE merge**, no substitutes (the S141 HARD RULE). The dark-launch flag `STUDIO_VIDEO_RENDER_ENABLED` already gates the *entire* render path; the new schedule/cap only take effect when that flag is ON (already ON since S189) **and** a render park occurs.
2. Land the schedule + cap (Design A) first; it is the higher-value, lower-risk half (pure cadence + a sized backstop).
3. Ship Design B **inert** (empty allowlist). Arm `STUDIO_VIDEO_RENDER_FAILED_STATUS_IDS` only after a real shadow run (or CLI-source read) confirms the terminal-failed `status_id`. Document the confirmed value in DR-Deploy `.env` + the handoff when learned.
4. No migration; no frontend change; no DR-Deploy `.env` change required to deploy (all defaults preserve current behavior). Worker restart per the §4 deploy flow.

---

## 11. What each reviewer should pressure-test
- **Gemini (holistic-adversarial, breadth):** reading the WHOLE design against the S187/S188 feature — is the §3 attempt-cap-coupling analysis complete, or is there a *second* shared-cap/window interaction (e.g. the 48h `MAX_AGE_MS`, the `MIN_ATTEMPTS_FOR_AGE_EXHAUST` gate, the grace window) that a faster schedule perturbs? Is anything internally inconsistent between the cadence table and the caps? Is best-effort-on-failed ever the *wrong* call at the system level?
- **Codex (grounded-adversarial, depth):** file:line against `studio-recovery-sweep.ts` + `executor.ts` — trace the exact `newAttempts` sequence under the proposed schedule and **try to find a tick where `age < 120m` and `newAttempts > the chosen cap`** (the regression). Verify the `studioRecoveryBackoffMs(attempts, kind)` signature change breaks no caller. Check whether a *mixed* payload can mis-select the cadence/cap. Web-research the `notebooklm` CLI for a real failed `status_id` (D-B1).
