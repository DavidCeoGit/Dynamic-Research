# DESIGN GATE — Phase-5 NLM-Import-Stop: DETERMINISTIC Fix (v2, post-internal-BLOCK)

**Status:** v4 (DESIGN gate COMPLETE) — integrates the internal Claude grounded-adversarial BLOCK (2 CRITICAL + 3 MAJOR + 3 MINOR + INFO), the external **Gemini 3.1-pro holistic-adversarial BLOCK** (1 CRITICAL + 2 MAJOR + 2 MINOR), **AND the external Codex gpt-5.5 grounded-adversarial BLOCK** (1 CRITICAL + 1 MAJOR + 1 MINOR + 5 grounded-correct confirmations), all 2026-07-01. Full tri-vendor sequential DESIGN gate cleared (Gemini → integrate → Codex → integrate → final). `agent/` PRODUCTION code + live slash-prompt. **Implementation of [C] is the next-session task, through the full §11 tri-vendor MERGE gate.**

**v3 integration log (Gemini holistic-adversarial, verbatim in the peer-review record):**
- **[C1] Partial-batch trap** — "fast-terminalize on SOURCE ERROR" would hard-fail a whole job on ANY single errored source (a 1-bad-PDF-in-100 batch currently succeeds). → §2[D] + §5.1 inv.5 + §6.2: the host wait blocks ONLY while `PROCESSING(1)+PREPARING(5) > 0`; when every source resolves to `READY(2)` OR `ERROR(3)` the wait completes and finalize proceeds with the **partial-success** state (a job fails closed only if ZERO sources are READY).
- **[M2] [C]→[D] migration conflict** — [C]'s relocated in-turn poll and [D]'s dispatch-and-yield are contradictory; if [C] stays when [D] ships, the agent polls in-turn and BYPASSES [D]. → §3.1 step 3 + §2[D]: building [D] REQUIRES removing/disabling [C]'s relocated poll (clean transition "poll in-turn" → "dispatch and yield").
- **[M3] D-i vs D-ii adjudicated → D-ii MANDATORY** — synchronous D-i blocks the single-threaded worker for a tens-of-minutes import → throughput/idle-timeout risk. → §2[D] + §3.3 Q1: D-ii (decoupled sweep) is now the mandated architecture; D-i is rejected.
- **[m4] Tighten the gate, not the prompt** — relying on prompt wording to prevent `"complete (pending…)"` violates the doc's own thesis. → §3.3 Q4 + §5.1 inv.1: `COMPLETE_AUGMENTED` (`state-evaluation.ts:318`) is tightened at the gate to reject parenthetical caveats — a deterministic [D] deliverable.
- **[m5] Empty-source-list race** — if the agent writes `awaiting_import` but the import dispatch failed, `source list` is empty → no 1s/5s → host instantly resumes finalize with 0 sources → garbage report. → §2[D] + §5.1 inv.8: host asserts total source count `> 0` (with a short grace for API lag) before proceeding; 0 after grace ⇒ fail-CLOSED.

**v4 integration log (Codex gpt-5.5 grounded-adversarial, run-banner asserted `model: gpt-5.5 / provider: openai / sandbox: workspace-write / reasoning: xhigh`; verbatim in the peer-review record):**
- **[Codex CRITICAL] The `--allowedTools` structural anti-re-import is FALSE in shipped code — GROUNDED.** `--allowedTools` is *tool*-level, not *command*-level (`claude-spawn.ts:206-224` hardcodes the set incl. `Bash`; there is no `spawnClaude(...profile)` param at `:180-184`). NotebookLM is driven via `Bash` running `notebooklm source add` (`job-manifest.ts:213`; `research-compare.md:4,:723`) → if `Bash` is allowed the finalize agent can STILL re-import; if `Bash` is removed it loses ALL NLM CLI + pandoc + file workflow and cannot finalize at all. → §2[D] rewritten: the anti-re-import boundary must be **command-level** — host-owned NLM source primitives (the host, not the agent, owns source mutation — the cleanest, and [D] already host-owns the WAIT) and/or a restricted-PATH shim that denies `notebooklm source *` mutating subcommands during finalize and/or an MCP/proxy allowlist; PLUS build the missing `spawnClaude(..., allowedToolsOverride)` seam. This CORRECTS the internal M-1 (which named `--allowedTools`, a mechanism that does not exist at the needed granularity).
- **[Codex MAJOR] D-ii `status='awaiting_import'` + "reuse the S162 sweep" is underdesigned against the real queue model — GROUNDED.** `JobStatus` is a CLOSED enum `pending|running|completed|failed|cancelled` (`agent/types.ts:13`) enforced in ≥4 places (`frontend/lib/validate.ts:399-405`; `frontend/app/api/queue/[id]/route.ts:73-89`; `frontend/app/api/queue/claim/route.ts:24-49` claims only `pending`); `studio-recovery-sweep.ts:747-765` selects only `status='failed' + studio_recovery_status='pending'` (a failed-job STUDIO dimension, not a generic parked-job dispatcher). → §2[D]: do NOT add a literal `awaiting_import` status; add a parallel **`import_wait_status` dimension** (mirroring `studio_recovery_status`) with `next_attempt_at` + attempt counters + resume payload + atomic transitions, and a **separate import-readiness sweep** (not a direct studio-recovery-sweep reuse — reuse the *pattern*, not the module).
- **[Codex MINOR] [C] cannot move Step A.1 verbatim — GROUNDED.** The current Step A.1 block assumes the comparison artifact was already uploaded in Step A (`research-compare.md:721-725`); hoisted before Phase 5.5a its instructions become misleading (stale assumptions at `:797,:809`). → §2[C]: place the gate immediately after the Phase-5 state write (`:642`) and before the Phase 5.5a conditional (`:646`), and REWRITE it as a **corpus-only readiness poll** (not a post-upload comparison-source poll).
- **[Codex INFO — 5 grounded-correct confirmations]** C-1 phantom-wall (no repo-shipped outer wall; live Task-Scheduler settings unreadable from the session — residual: a Scheduled-Task time limit cannot be ruled out from code alone, verify at [C]/[D] MERGE); C-2 mutual exclusion (S136 in `executor.ts:315-374` exit-≠0; S193 exit-0 → verify → `failJob :376-450`; Gate-A separate `:400-445`); the `state-evaluation` seams exist + `COMPLETE_AUGMENTED` tightenable without losing legit accepts + `shouldDeferForVideoRender` a good model for `isAwaitingImportYield`; SOURCE vs ARTIFACT enums distinct + the SOURCE enum VERIFIED from installed `notebooklm-py` (`rpc/types.py:334-346`: PROCESSING=1/READY=2/ERROR=3/PREPARING=5; `cli/source.py:153-194` emits `sources[].status_id`); the [C] gate placement (after `:642`, before `:646`) confirmed.
**Decision (USER, S194):** **[C] now → [D] host-side next → DROP [A].** v2 executes that decision; §3 records the analysis that supports it.
**Supersedes:** v1 (`phase5-nlm-import-stop-deterministic-fix-design-gate.md`, recommended [C]→[A]→[D]) and the L1+E disposition in `Documentation/phase5-nlm-import-stop-fix-design-gate.md` (§X-L2 CUT / §X-L3 DEFERRED — calls made on the now-falsified "L1 prompt-only will make the stop rare" premise).
**Author:** design lead (Claude). **Date:** 2026-07-01. **Severity:** NORMAL (fail-forward — L1+E shipped, ineffective, no regression, no rollback urgency).

---

## 0. TL;DR (decision-ready)

- **The problem is CONFIRMED, not hypothetical.** L1+E deployed (`main f2b68dd`). The S193 dogfood (`job 334f58fc`) drifted anyway: the agent ended its turn at the **phase-5 → 5.5 boundary BEFORE it ever entered the Step A.1 poll**. First real run = 100% drift. Prompt-only cannot be trusted for this class — a top-of-prompt CRITICAL lost a salience contest, and the enforcement instrument (Step A.1) sits *downstream* of the decision point where drift fires.
- **Root defect is structural, not persuasive:** the only thing between "phase 5 done" and "turn ends" is a probabilistic prompt directive the agent gets to *decide* whether to honor. **A deterministic fix must move the completion guarantee OUT of the model's discretion into the harness.**
- **DECISION (executes the user's S194 call):**
  1. **Ship [C] immediately** (prompt-only, live-immediately, hours) — relocate the poll gate to the 5→5.5 spine as an unconditional phase-5-exit precondition + harden the anti-stop CRITICAL to negate the agent's actual "await/resume/non-terminal/yielding" reframing **and** premature "complete" narration. Makes the stop *rarer*; explicitly **not** a guarantee.
  2. **Build [D] next** — **host-side deterministic corpus-readiness wait**: the agent dispatches the import and *intentionally* yields; the **worker** deterministically polls source readiness (no LLM, no drift, no per-poll token cost) and re-spawns the agent for finalization with the import already complete. **[D] is the ONLY candidate that actually satisfies the thesis** — it removes the agent from the poll entirely and is duplicate-work-safe by construction.
  3. **DROP [A]** (harness re-spawn / corrected-L2). Once [A]'s corrected cost is booked (§3.2), it converges with [D]'s build size while *retaining* the exact defect the thesis condemns: [A] relocates the *trigger* to the harness but leaves BOTH the re-stop and the re-import decisions inside the resumed model's discretion.
  4. **Keep [B]/L3 deferred** — it is the wrong-shaped net for THIS pre-Studio import-stop class (§2[B]).
- **Sequencing guard (integrates M-2):** ship [C] → open a bounded **[C]-only observation window** on the next real jobs → build [D] through its own full §11 tri-vendor MERGE gate. The observation window does NOT gate *whether* [D] is built (the thesis already settles that: prompt-only can never guarantee) — it (a) quantifies [C]'s residual drift and (b) feeds [D]'s host-wait tuning (upper bound, terminalize thresholds).

---

## 1. Problem statement + dogfood evidence

### 1.1 The failure class (unchanged; grounded-correct)

**Class A:** the `claude -p` pipeline agent ends its turn at phase 5 (Synthesis) or 5.5 (Studio) while an async NotebookLM op (Phase-3 corpus import, or Studio render) is still in flight, writes a "…finalizing/importing/rendering in background" `phase_status`, and stops. The child exits **code 0 / `killReason=NONE`** (`claude-spawn.ts:361-364`), which **skips the entire `exitCode !== 0` recovery block** (`executor.ts:315-374`); the completion gate returns `{success:false}` (phase < 7, `state-evaluation.ts:325-331`); the S187 Gate-A video-defer probe declines (not a video-only gap); terminal `failJob` fires (`executor.ts:447-451`). Work-done-marked-failed. **5 confirmed prod events** (incl. ConQr `3ce18f2c`), all with complete or near-complete deliverables.

### 1.2 The dogfood evidence — L1 prompt-drift is CONFIRMED

`main f2b68dd` shipped **L1** (poll-wait Step A.1 + anti-stop CRITICAL at `job-manifest.ts:226`) + **E** (per-poll heartbeat), on the premise that a top-of-brief CRITICAL + a bounded poll would make the stop rare. **S193 dogfooded it. It drifted.**

Job `334f58fc`, mechanically grounded:
- Reached `phase: "5"` (comparison.md written → `research-compare.md:642`), launched the Phase-3 corpus import of **102 sources** with `wait=False` + `run_in_background:true` (`:543`, `:586`).
- At 05:14 wrote `phase_status: "Phase 5.5 (pre): corpus import in progress ~30/102 … Non-terminal"` and **exited process code 0**.
- Completion gate: `phaseStr="5"` → not in ALLOWED, `phaseNum=5 < 7`, `phase_status` ≠ complete/COMPLETE_AUGMENTED → `isComplete=false` → hard-fail `"Pipeline stopped at phase 5 (…); expected phase_status='complete' OR phase>=7"`. Exactly the predicted Class-A shape.

**The decisive detail:** the agent's own status reads **"Phase 5.5 (pre)"** — it had *left* Phase 5 and stood at the 5→5.5 boundary but **stopped before executing Step A.1's poll** (which physically lives at `research-compare.md:727`, downstream of Phase 5 end `:642` → conditional Phase 5.5a → REVIEW GATE 2 `:709` → Step A upload `:721` → *then* Step A.1 `:727`). **The poll loop the fix relies on was never entered.** The agent narrated intent ("awaiting import completion") and treated that narration as a resumable checkpoint.

### 1.3 WHY the agent stopped before reaching Step A.1 — three compounding mechanisms

**(a) Positional gap — the poll lives DOWNSTREAM of the stop point (primary cause).** Step A.1 is the *instrument* that forces the wait, but you only reach it if you keep going long enough. The "should I continue?" decision fired at the 5→5.5 transition, *before* the code path that hands the agent the poll loop. A fix that lives past the decision boundary cannot govern the decision.

**(b) The "background op → resumable pause" mental model survived the CRITICAL.** The CRITICAL forbids stopping with a "still finalizing/importing/rendering in the background" status. The agent wrote "corpus import in progress … awaiting import completion … **Non-terminal**" — it did not classify its state as "finalizing in the background"; it classified it as a labeled, non-terminal checkpoint it would *resume from*. The word "Non-terminal" is the tell: the prohibition negates "stop"; the agent believed it was *yielding*, not stopping. The prohibition's wording and the agent's self-model never made contact.

**(c) Long-context salience decay of a top-of-prompt directive.** The CRITICAL is at the top of a ~900-line brief; by the decision point the agent is hundreds of tool-calls and tens of thousands of tokens past it. Meanwhile *local* context at the decision point (`research-compare.md:371/375/586` "runs in background" language) reinforces the yield prior with high recency-salience. A single top-of-context directive is the weakest placement against a decision made deep in the run.

### 1.4 Why prompt-only cannot be trusted here (the core finding)

The only thing standing between "phase 5 done" and "turn ends" is a probabilistic prompt directive — the agent gets to decide whether to poll. Prompt directives (even top-of-prompt CRITICAL ones) are advisory; the model can always emit `end_turn`. The prior design's own thesis was that L1 "cannot guarantee the turn doesn't end early" — S193 is that residual made real. Hardening the *wording* attacks (b)/(c) but leaves (a) and the fundamental discretion intact. **A deterministic fix must relocate the completion guarantee into the harness — a control the model cannot narrate its way past.**

---

## 1.5 GROUNDED CORRECTION (integrates internal CRITICAL C-1): the "container SIGKILL wall" is PHANTOM

The v1 doc's §5.2 budget math, and the historical reason L2 was CUT, both rested on a premise that is **false in this codebase**. Verified this session against shipped code:

- **There is no container / host / cgroup wall.** `MAX_JOB_DURATION_MS` (5_400_000 = 90 min) is a **self-imposed software cap enforced inside `waitForProcess`** — a `setInterval` deadline check that, on `activeMs > maxDuration`, fires `child.kill("SIGTERM")` then `SIGKILL` after a 10 s grace (`claude-spawn.ts:328-333`). It kills **only the `claude` subprocess**. `worker-config.ts:12-14` states this verbatim: *"The gate's own runtime is NOT bounded by MAX_JOB_DURATION_MS (that cap only kills the claude subprocess)."* The worker itself is a Windows Scheduled Task (CLAUDE.md §6) — no OS-level job wall.
- **`activeMs` is NOT real wall-clock.** It is sleep-gap-excluded: gaps ≥ `SLEEP_THRESHOLD_MS` (5 min) are logged and NOT counted (`claude-spawn.ts:322-326`). So `Σ activeMs` measures active (non-sleep) child-time, not elapsed time.
- **When the cap fires it produces `exitCode ≠ 0` + `killReason="DURATION"`** — which routes into the **S136 duration-kill recovery block** (`executor.ts:333-357`), a path entirely distinct from the S193 **exit-0** stop.

**Consequences for the design (all fold into the [C]→[D]/drop-[A] decision):**
1. **Retract the "continuation → 157 min → container SIGKILL → stranded job" framing.** No such wall exists. A hypothetical over-budget re-spawn would not be SIGKILL-stranded by a container; it would merely run longer (queue latency + token cost) and each spawn's own self-imposed cap would kill *its own* child. **This removes the single scariest failure mode that motivated [A]'s elaborate budget-threading — and simultaneously removes [A]'s strongest claim to necessity.**
2. **Any real "how long has this JOB run?" budget must use elapsed wall-clock** (`Date.now() − jobStartMs`), NOT `Σ activeMs`. This matters for [D]'s host-wait upper bound (a real-time bound, §5.2), and would have mattered for [A] had it survived.
3. The 90-min cap is **per-spawn** (per `claude` child), not per-job. [D]'s two short spawns each get their own independent per-child cap; the deterministic host wait between them consumes **zero** model time and is bounded separately (§5.2).

---

## 2. Candidate approaches (dispositions updated for v2)

Each: mechanism · seams · cost · risk · fail-modes · **DETERMINISTIC vs PROBABILISTIC** · **v2 disposition**.

Grounded exit-0 asymmetry (load-bearing): a phase-5/5.5 stop exits `{code:0, killReason:"NONE"}` (`claude-spawn.ts:361-364`); there is **no `--max-turns`** (`:199-224`). Exit 0 skips the `exitCode !== 0` recovery block (`executor.ts:315-374`), so `recoveryVerdict` stays `null` and control reaches `verifyPipelineCompletion` → `!success` → `failJob` (`:376-451`). This is why nothing catches the stop today, and it is the seam both [C] (make the agent not stop) and [D] (reclassify the stop as an intentional yield + host-continue) act on.

---

### [D] Host-side DETERMINISTIC corpus-readiness wait — **THE NEXT BUILD (recommended)**

**Mechanism (the textbook fit — `waitForTaskToken` / Temporal-signal / Step-Functions callback pattern).** Invert control. The agent does NOT poll to completion in-turn. It (1) kicks off the Phase-3 import, (2) writes the notebook_id + selected products + an explicit **`awaiting_import`** marker to durable state, (3) ends its turn **cleanly and intentionally**. The **worker** then deterministically polls NotebookLM for SOURCE readiness (a plain `while not ready: sleep; check` loop — no LLM, no drift, no per-poll token cost) and, on readiness, spawns/resumes the agent for finalization with the ready artifacts. This is the industry-standard answer for "a long external async op the agent merely needs the RESULT of."

**Architecture — D-ii (decoupled) MANDATED (Gemini M3 adjudication).** The agent yields; the row is parked and a **separate off-critical-path import-readiness sweep** polls source readiness and re-dispatches finalization when ready. Because control-inversion becomes the *normal* path (every job dispatches-then-yields), the alternative — **D-i, an in-executor synchronous wait** — would block the single-threaded worker for a tens-of-minutes import on EVERY job (a 100+-source import can run an hour), starving other scheduled runs and risking OS idle timeouts. The S129 studio-completeness gate blocks synchronously today, but it does so on the RARE post-generation tail; making that the normal path is a throughput regression. **D-ii is the architecture; D-i is REJECTED.** (The decoupled sweep also keeps the import wait off the 90-min per-child cap entirely — see §5.2.)

**State-model — parallel dimension, NOT a new `JobStatus` (Codex MAJOR, GROUNDED).** Do NOT introduce a literal `status='awaiting_import'`: `JobStatus` is a CLOSED enum `pending|running|completed|failed|cancelled` (`agent/types.ts:13`) enforced in ≥4 places (`frontend/lib/validate.ts:399-405`, `frontend/app/api/queue/[id]/route.ts:73-89`, `frontend/app/api/queue/claim/route.ts:24-49`) — a new status value would break claim/validation/API contracts. Instead add a **parallel `import_wait_status` dimension** (mirroring the proven `studio_recovery_status` shape) carrying `import_wait_status ∈ {pending, resolved, exhausted}` + `import_wait_next_attempt_at` + attempt counters + a resume payload (`notebook_id`, selected products, orig org/slug), with atomic transitions. The existing `studio-recovery-sweep.ts` is a **failed-job STUDIO recovery dimension** (`:747-765` selects `status='failed' + studio_recovery_status='pending'`; `:120-129` studio-only candidate fields), NOT a generic parked-job dispatcher — **reuse its PATTERN (decoupled poll-tick sweep + atomic finalize), author a distinct import-readiness sweep, do NOT bolt onto the studio module.**

**Exact file:line seams (architecture-level; the full build contract is [D]'s own MERGE-gate design):**
| Seam | Change |
|---|---|
| `~/.claude/commands/research-compare.md` | split phase-5 into "dispatch import" (agent spawn #1 — launches import, writes `notebook_id` + an `awaiting_import` **state.json marker**, ends turn) → [host sweep waits] → "finalize" (agent spawn #2). NOTE the state.json marker is durable STATE, distinct from the DB `import_wait_status` dimension. |
| `agent/lib/state-evaluation.ts` (new pure classifier, sibling to `shouldDeferForVideoRender` `:393`) | `isAwaitingImportYield(state)` — recognizes the `awaiting_import` state.json marker as an **intentional yield**, NOT a Class-A `{success:false}` stop. Pure + total; durable-signals-only (never trusts free-text phase). |
| `agent/executor.ts` (exit-0 `!verdict.success` path `:377`, BEFORE `failJob :447-451`) | on an `awaiting_import` yield, PARK the row into the `import_wait_status` dimension (do NOT `failJob`). Mutually exclusive with the S136 exit-≠0 recovery (structurally a different code path — C-2) and with the S187 Gate-A video-defer. |
| `agent/lib/import-wait-sweep.ts` (NEW — mirrors the S162 sweep PATTERN, distinct module) + `agent/worker.ts` wiring | decoupled off-critical-path SOURCE-readiness poll (SOURCE enum; partial-batch completion per Gemini C1; real-wall-clock `IMPORT_WAIT_MAX_MS` bound; empty-list grace per Gemini m5); on ready, re-dispatch finalization (spawn #2). Runs every poll tick like the studio sweep. |
| `agent/lib/nlm-source-cli.ts` (NEW) | **SOURCE-list wrapper.** `notebooklm source list -n <id> --json` — **SOURCE** enum `PROCESSING=1 / READY=2 / ERROR=3 / PREPARING=5`. **Wait-completion is NOT "no errors" — it is "no sources still in flight" (Gemini C1):** the host loop blocks ONLY while `count(1)+count(5) > 0`; once EVERY source has resolved to `READY(2)` OR `ERROR(3)`, the wait completes. `ERROR(3)` sources are counted OUT (excluded from the ready set) but do NOT abort the wait — a partial batch (e.g. 101 READY / 1 ERROR) is the COMMON NLM reality and must NOT hard-fail the job. Finalize (spawn #2) receives the partial-success census (`R ready / E errored / T total`) and proceeds on the READY sources; the job fails CLOSED only if ZERO sources are READY. CONFIRMED absent today (only `nlm-artifact-cli.ts`, which uses the ARTIFACT enum `1=in_progress/3=completed` `:39,:100-133` — using it would treat an errored source as ready). |
| finalization completion | flows through the unchanged `verifyPipelineCompletion` **plus** the m-1 hardening (§below): a finalize spawn must NOT be able to write a premature `"complete (pending import)"` that satisfies the lenient `COMPLETE_AUGMENTED` regex (`state-evaluation.ts:318`). |

**STRUCTURAL anti-re-import — must be a COMMAND-level boundary, NOT `--allowedTools` (Codex CRITICAL, GROUNDED).** The internal M-1 named `--allowedTools` as the deterministic forbid; **that mechanism does not exist at the needed granularity.** `--allowedTools` is *tool*-level (`claude-spawn.ts:206-224`), and NotebookLM is driven by the `Bash` tool running `notebooklm source add` (`job-manifest.ts:213`, `research-compare.md:723`): allowing `Bash` still lets the finalize agent re-import; removing `Bash` strips ALL NLM CLI + pandoc + file workflow and it cannot finalize. The deterministic boundary must be at the COMMAND level, in preference order:
1. **Host-owned source mutation (cleanest, thesis-aligned).** The host — not the agent — owns ALL `source add`/import. [D] already host-owns the WAIT; extend it so dispatch (spawn #1's import launch) is likewise host-driven where feasible, and the finalize spawn (#2) is given a corpus that is ALREADY complete and NEVER needs a source-mutating command. Re-import then cannot happen because the agent has no reason and (per 2/3) no ability to issue it.
2. **Restricted-PATH shim during finalize.** Spawn #2 runs with a `PATH` whose `notebooklm` shim rejects mutating subcommands (`source add`/`import`/`source remove`) and passes through reads/downloads/generate — a deterministic command-level allowlist the agent cannot narrate past.
3. **MCP/proxy allowlist** (if/when NLM moves off Bash-CLI onto the `agent/mcp-proxy` path) denying source-mutating calls during finalize.
Plus: build the **missing `spawnClaude(..., allowedToolsOverride/profile)` seam** (`claude-spawn.ts:180-184` has no such param today) so finalize spawns can be profiled distinctly from the dispatch spawn. Combined with machine-readable `RESUME_FROM_PHASE` / `IMPORT_LAUNCHED` markers in durable state, re-import becomes structurally impossible — via a boundary the harness actually has, not one it doesn't.

**Cost.** HIGH — pipeline decomposition (the ~900-line single prompt becomes two shorter spawns) + a host poll loop + the SOURCE-list wrapper + (D-ii) a new DB state + sweep arm. Weeks, with its own tri-vendor MERGE gate.

**Risk.** Medium. Correct dispatch-once semantics **structurally eliminate the duplicate-import risk** (spawn #1 dispatches once; host waits; there is no re-spawn that re-dispatches) — the single biggest advantage over [A]. Requires an upper wait bound + terminalize-on-failure + an idempotency key on dispatch for crash-during-dispatch safety.

**Fail-modes.** Host-poll timeout tuning (too tight kills a legitimately-slow import; too loose = dead-air, bounded by the real-wall-clock upper bound + partial-batch completion per Gemini C1). No re-drift in the wait (host is deterministic); drift confined to two short bounded spawns, each far below the 33-min drift threshold observed in S193.

**Determinism verdict: FULLY DETERMINISTIC + duplicate-work-safe by construction.** The completion guarantee lives in the harness. This is the only option that satisfies §1.4's thesis.

---

### [C] Stronger-L1 placement (relocate + harden the prompt) — **SHIP NOW, cheap reinforcement**

**Mechanism.** Two prompt-only edits attacking the S193 mechanisms directly:
1. **Relocate the source-readiness gate to the 5→5.5 spine as an unconditional first action (fixes gap (a)).** Place a NEW corpus-readiness gate as the FIRST executable step after the Phase-5 state write (**immediately after `research-compare.md:642`, before the conditional Phase 5.5a at `:646` — Codex-confirmed placement**) — before conditional Phase 5.5a / REVIEW GATE 2 / Step A upload — phrased as "phase 5 is NOT complete until this command returns `CORPUS_IMPORT_READY` or `…_FAIL_FORWARD`." **Do NOT move the existing Step A.1 block verbatim (Codex MINOR):** Step A.1 (`:727-737`) assumes the comparison artifact was already uploaded in Step A (`:721-725`), and it carries stale post-upload assumptions (`:797,:809`); hoisted before the upload those instructions mislead. Author a **corpus-only readiness poll** (poll `source list` for the imported corpus, not the post-upload comparison source). Because the import launches in Phase 3, source-readiness is a phase-5-EXIT precondition regardless of Studio; it must live in the **shared spine**, not downstream in Studio-land where a report-only run's "no Studio → coast to finalization" model skips it. *(This branch-skip is exactly how S193 coasted past.)*
2. **Harden the anti-stop CRITICAL to negate the agent's actual reframing (fixes (b)/(c)) AND premature "complete" (integrates MINOR m-1).** Extend the CRITICAL so "await/resume/**non-terminal**/yielding/in progress" are ALL invalid stop-narrations (not just "background/finalizing/rendering"), AND so a premature `"complete (pending import)"`-style narration is ALSO forbidden — the gate's `COMPLETE_AUGMENTED = /^complete[\s\-:(]/` (`state-evaluation.ts:318`) would otherwise let "complete (…" pass as done. Emit a high-salience **local copy at the phase-5-exit point**, not only top-of-brief.

**Exact file:line seams.**
| Seam | Change |
|---|---|
| `~/.claude/commands/research-compare.md` — insert a NEW corpus-readiness gate after the Phase-5 state write (`:642`), before conditional Phase 5.5a (`:646`) | author a **fresh corpus-only readiness poll** (NOT a verbatim move of Step A.1 `:727-737`, which assumes the Step A upload already ran and carries stale `:797/:809` assumptions); phrase as an unconditional phase-5-exit precondition. |
| `agent/lib/job-manifest.ts:226` (anti-stop CRITICAL) | extend negated-narration set to include await/resume/non-terminal/yielding **and** premature "complete"; add a phase-5-exit-local reminder emission. |

**Cost.** Very low — prompt-only, live-immediately (slash-prompt) + one `job-manifest.ts` string edit. Hours.

**Risk.** Low. Fail-forward preserved. Two watch-items: (i) the relocation must sit in the shared spine before conditional 5.5a so a report-only / vendor-eval-disabled run cannot branch-skip it; (ii) CRITICAL-fatigue — avoid over-stuffing top-of-brief CRITICALs.

**Fail-modes.** **STILL PROBABILISTIC.** It is a directive, not a control-flow gate the harness enforces — a sufficiently drifted agent can route around any wording and still gets to *decide* whether to run the relocated command. It makes the stop *rarer*; it cannot *guarantee* the turn doesn't end early. **This is the exact class that just failed** — ship it, but NEVER as the sole fix.

**Determinism verdict: PROBABILISTIC.** Reinforcement only. Necessary-but-not-sufficient; belongs composed with [D].

---

### [A] Harness re-spawn continuation (corrected-L2) — **REJECTED (v2)**

**Mechanism (for the record).** On an incomplete NON-terminal exit-0 (notebook present, no terminal error, `4 ≤ phase < 7`), the executor re-spawns `claude -p` ONCE against the same prompt/workdir/state to resume from current state through Finalization, bounded by a structural attempt cap + an anti-re-import prompt (v1 also proposed budget-threading; §1.5 shows the wall it guarded against is phantom).

**Why REJECTED (integrates M-3 + the INFO strongest-BLOCK reason + C-1 + C-2):**
1. **It does not satisfy the thesis (INFO, decisive).** §1.4 says: move the guarantee OUT of the model's discretion. [A] relocates the *trigger* (executor decides to re-spawn) but leaves **BOTH** the re-stop decision (the resumed agent can drift-and-stop again) **and** the re-import decision inside the resumed model's discretion. It re-enters the SAME 5→5.5 boundary with the SAME ~900-line brief + SAME local "runs in background" context → correlated draws, so re-drift ≈ p·(corr), **not p²** (MAJOR M-2). "Genuine second chance" was oversold.
2. **Its corrected cost converges with [D]'s (M-3), removing its only advantage.** [A]'s "cheap, all in existing files" pitch survives only if you accept a prompt-guard anti-re-import. Once you book the fixes the internal review requires — C-2 S136 interlock (a `for`-loop wrapping `executor.ts:282-374` puts `shouldContinuePipeline` and `shouldRecoverAfterDurationKill` in one body with overlapping predicates and undefined precedence → double-recovery/completion race; must be made mutually exclusive on `killReason==="NONE" && exitCode===0 && !verdict.success`) + M-1 structural `--allowedTools` forbid + m-1 premature-complete hardening — [A] is no longer a "one prompt string" change. It converges with [D]'s build size while **retaining** the two in-model decisions [D] eliminates.
3. **C-1 removed [A]'s scariest-failure-mode necessity.** The elaborate budget-threading existed to prevent a phantom container SIGKILL. With no wall, [A]'s distinctive engineering (mandatory `remainingBudgetMs` input param) guards against nothing catastrophic — just longer runs — further collapsing its value proposition.

**Determinism verdict: DETERMINISTIC trigger + PROBABILISTIC resumed-agent behavior — insufficient.** Dropped in favor of [D], which is deterministic end-to-end.

---

### [B] Deferred L3 recovery net (park + dedicated off-critical-path recovery primitive) — **KEEP DEFERRED**

**Mechanism.** When the stop leaves research docs + notebook present (salvageable), the worker **parks** the row (`status='failed'` + `studio_recovery_status='pending'` + resume payload) instead of hard-failing; the decoupled S162 sweep later finishes the Studio products off the critical path via a dedicated recovery primitive, then completes atomically via `finalizeRecoveredRun`.

**Why still DEFERRED (unchanged; wrong-shaped net for THIS stop).** The S193 stop is a **pre-Studio, import-wait stop on a report-only run** — no Studio products selected; the *report* is the deliverable, and the pipeline just needs to be *finished* (poll import → generate report → Finalization). **L3's recovery arm re-generates Studio products** — on a report-only run it has nothing to regenerate. L3 salvages the *Studio-render* class; **[D] salvages the *finish-the-pipeline* class, which is what S193 IS.** Codex already BLOCKED the v2 L3 shape twice (clone-only `regenerate-studio-products.ts`; wrong SOURCE/ARTIFACT enum; no-attempt-bump vs sweep-as-written; `attempts>=1` CHECK conflict). Note (MINOR m-2): if L3 is ever built, resolve the `attempts>=1` CHECK (`20260623:104-111`) by choosing change-CHECK vs a separate paid-attempt counter — do not leave it under-analyzed.

**Determinism verdict: DETERMINISTIC but off-target.** The durable net for the Studio-render class, not the import-stop class.

---

## 3. RECOMMENDATION

**Ship [C] immediately as a probabilistic reinforcement; build [D] host-side deterministic corpus-readiness wait next as the guarantee; DROP [A]; keep [B]/L3 deferred.** This executes the user's S194 decision and is the disposition the internal BLOCK predicted once [A]'s corrected cost is booked.

### 3.1 The composition (ordered)

**Right now (hours, prompt-only, live-immediately):**
1. **Ship [C]** — relocate the poll gate to the 5→5.5 spine as an unconditional phase-5-exit precondition + harden the anti-stop CRITICAL to negate "await/resume/non-terminal/yielding" **and** premature "complete." *Why:* attacks the exact S193 mechanisms — positional gap (a) via relocation, reframing (b)/(c) + false-complete (m-1) via wording — at zero new risk surface, making the first-spawn drift rarer. Reinforcement, explicitly **not** a guarantee.

**Observation window (integrates M-2):**
2. **Open a bounded [C]-only observation window** on the next real jobs after [C] deploys. Measure: does the 5→5.5 stop rate drop? does the relocated poll appear on the report-only critical trace? *Why:* quantifies [C]'s residual and feeds [D]'s host-wait tuning. It does NOT gate whether [D] is built — the thesis already settles that.

**Next (the deterministic guarantee — full tri-vendor MERGE gate, weeks):**
3. **Build [D]** — host-side deterministic corpus-readiness wait (D-ii decoupled sweep, mandated); agent dispatches + yields, worker polls + re-spawns finalization; finalize spawn is `--allowedTools`-forbidden from source mutation (structural anti-re-import). *Why:* the only option that moves the completion guarantee out of the model's discretion, and it is duplicate-work-safe by construction. **MIGRATION (Gemini M2 — mandatory):** shipping [D] REQUIRES removing/disabling [C]'s relocated *in-turn* poll from the slash-prompt in the SAME change — [C] tells the agent "phase 5 is NOT complete until you poll to `READY`" (poll in-turn) while [D] tells it "dispatch the import and YIELD"; if both are live the agent polls in-turn and BYPASSES [D]'s host wait, re-introducing the exact drift [D] exists to remove. The prompt must transition cleanly from "poll in-turn" (the [C] era) to "dispatch and yield" (the [D] era) as one atomic slash-prompt edit gated with [D]'s flag flip.

**Skip / keep deferred:**
- **[A]** DROPPED (§2[A]). **[B]/L3** stays deferred (§2[B]).

### 3.2 Why [D] beats [A] once [A]'s cost is corrected (the M-3 re-run)

The v1 doc recommended [A] next on a "cheap, all-in-existing-files" cost basis. That basis does not survive the internal findings:

| Dimension | [A] corrected | [D] |
|---|---|---|
| Satisfies §1.4 thesis (guarantee out of model discretion)? | **No** — re-stop + re-import remain in-model (M-2, M-1) | **Yes** — host owns the poll; agent never decides to stop |
| Duplicate-import safety | Prompt/`--allowedTools` mitigation on a re-spawn (best case structural if M-1 booked) | **Structural by construction** — dispatch-once, no re-dispatch |
| Budget-fail-open (v1's motivating risk) | Was elaborate budget-threading; §1.5 shows the wall is **phantom** → the engineering guards ~nothing | N/A — deterministic host wait consumes no model time; per-spawn caps independent |
| S136 interlock (C-2) | **Required** — must make continuation mutually exclusive with the exit-≠0 duration-kill recovery in the SAME body | **Not needed** — [D] adds a distinct intentional-yield classification on the exit-0 path; never wraps the exit-≠0 recovery block |
| Build size (corrected) | classifier + `waitForProcess` change + loop + S136 interlock + M-1 structural forbid + m-1 hardening | pipeline split + host poll loop + SOURCE-list CLI + (D-ii) DB state + sweep arm |
| Re-drift residual | ≈ p·(corr) (M-2) | none in the wait (host is deterministic) |

Once [A]'s corrected cost is booked it converges with [D]'s build size while retaining the defects [D] eliminates. **[D] strictly dominates [A].** Drop [A].

### 3.3 Open questions — ADJUDICATED (Gemini holistic pass) + remaining for Codex

1. **D-i vs D-ii → RESOLVED: D-ii (decoupled sweep) MANDATED (Gemini M3).** Synchronous D-i would block the single-threaded worker for a tens-of-minutes import on the now-normal yield path → throughput regression + idle-timeout risk. [D] uses the S162 decoupled-sweep pattern; D-i rejected.
2. **Control-inversion as NORMAL path vs fallback → RESOLVED: NORMAL path.** Every job dispatches-then-yields (that is what makes the guarantee deterministic — a fallback-only trigger would itself be a discretion point). D-ii makes the normal-path yield non-blocking, which is exactly why D-i is rejected.
3. **[C] relocation placement → RESOLVED (Codex).** The unskippable gate must sit after the Phase-5 state write (`:642`) and before conditional Phase 5.5a (`:646`); the current Step A.1 (`:727`) is downstream of optional/vendor/report branching (the S193 skip). Step A.1 must NOT be moved verbatim (it assumes the Step A upload ran; stale `:797/:809`); author a fresh corpus-only readiness poll. Integrated into §2[C].
4. **m-1 false-complete → RESOLVED: tighten the GATE, not the prompt (Gemini m4; Codex-confirmed the regex can be tightened without losing legit accepts).** Per the doc's own thesis (§1.4), a prompt guard cannot be trusted for a state guarantee. [D] tightens `COMPLETE_AUGMENTED` (`state-evaluation.ts:318`) at the gate to reject parenthetical caveats (`complete (pending…`, `complete (in progress…`) deterministically while preserving exact-`complete` / `phase>=7` accepts. [C] adds the prompt-level "don't narrate premature complete" as cheap belt-and-suspenders.
5. **Partial-batch + SOURCE enum → RESOLVED (Codex, grounded).** SOURCE enum VERIFIED from installed `notebooklm-py` (`rpc/types.py:334-346`; `cli/source.py:153-194` emits `sources[].status_id`), distinct from the ARTIFACT enum. Partial-batch census plumbing + empty-list grace/fail-closed carried into §2[D] + §5.1 inv.5/inv.8; the SOURCE-list wrapper (`nlm-source-cli.ts`) is confirmed absent and must be built.
6. **REMAINING for the [D] MERGE gate (not blocking this DESIGN gate)** — (a) verify no live Task-Scheduler time limit imposes a real outer wall (Codex could not read live Task-Scheduler settings from its sandbox; C-1 holds from code alone); (b) the exact command-level anti-re-import boundary choice (host-owned primitives vs PATH shim vs MCP-proxy) + the new `spawnClaude(...profile)` seam; (c) the `import_wait_status` migration + CHECK-constraint shape.

---

## 4. MRPF classification

**Event Gate: DESIGN (this doc, external gate now) → MERGE (before any merge).**
- **DESIGN gate (this doc):** agent-turn-control behavior change; irreversible-in-prod once merged; new subsystem seam ([D] pipeline decomposition + host poll). → **Gemini + Codex mandatory, sequential (Gemini holistic-adversarial → integrate → Codex grounded-adversarial on the integrated v2/v3).** Artifact: companion `phase5-nlm-import-stop-deterministic-fix-peer-review.md` (already holds the internal Claude BLOCK; append the external passes).
- **MERGE gate (each ship item):**
  - **[C]** — slash-prompt half is live-immediately; the `job-manifest.ts:226` CRITICAL edit reaches the prod worker spawn brief → **full §11 tri-vendor MERGE BEFORE merge.**
  - **[D]** — pipeline + executor + worker + new SOURCE-list CLI (+ D-ii: migration/state) → its own **full §11 tri-vendor MERGE BEFORE merge.**

**Risk Labels:** **AGENT BEHAVIOR** (changes *when the agent may end its turn* — propagates to every future session) + **INFRA** (touches the prod worker's spawn brief + the worker's poll/dispatch loop). [D]-ii adds **DATA** (a new DB state / migration).

**Severity Mode: NORMAL** — fail-forward. L1+E shipped and ineffective but non-regressing; no rollback urgency; no production-down.

**HARD RULE (project §11) — `agent/` PROD deploy:** the [C]-CRITICAL edit and all of [D] reach the `DynamicResearchWorker` cron → DR-Deploy → live daemon. **The full three-vendor gate (Gemini + Codex + Claude-author) must clear BEFORE merge — never after.** If Codex is quota-out/offline ⇒ **WAIT** or use the §1a API-key flip to get the REAL Codex now — NOT substitute-and-owe. **Codex reviewer-model assertion:** before trusting the Codex pass, assert its `exec` run-banner `model:` equals the expected strongest (membership ≠ runtime entitlement).

**Key adversarial targets for the MERGE reviewers:**
1. **[C] relocation sits in the SHARED 5→5.5 spine** (before conditional Phase 5.5a) — verify a report-only / vendor-eval-disabled run cannot branch-skip it.
2. **[D] `isAwaitingImportYield` is pure/total and trusts ONLY durable signals** (never the free-text phase) — a malformed/garbage marker must fail CLOSED to terminal, never falsely yield-forever.
3. **[D] finalize spawn (#2) `--allowedTools` structurally omits source mutation** — prove re-import is impossible, not merely discouraged.
4. **[D] host wait completion semantics (Gemini C1/m5)** — wait ends when no source is still in flight (`count(1)+count(5)==0`), NOT on first ERROR; partial batches (some ERROR) finalize on the READY set; ZERO-READY or empty-list-after-grace fails CLOSED; the real-wall-clock bound terminalizes a never-completing import (never hangs the worker).
5. **fail-forward never writes a false "complete"** on any timeout/exhaustion path (the m-1 `COMPLETE_AUGMENTED` surface included); terminal exit stays fail-CLOSED.
6. **[D]-vs-S136-vs-Gate-A mutual exclusion** — the intentional-yield path (exit-0) is distinct from the exit-≠0 S136 duration-kill recovery and the video-render defer; prove no path double-fires or races on completion.

---

## 5. Fail-closed invariants + budget/duration math (corrected per C-1)

### 5.1 Fail-closed invariants (all options)

1. **No false-complete.** No continuation/finalize/timeout path may PATCH `status='completed'` unless the FULL S129 obligation set is re-asserted present on disk (`finalizeRecoveredRun`-style). A missing obligation ⇒ terminal fail (the S162 keystone). Fail-CLOSED on first miss. **(m-1 + Gemini m4) The GATE is the guarantee, not the prompt:** `COMPLETE_AUGMENTED` (`state-evaluation.ts:318`) is tightened to reject premature parenthetical caveats (`complete (pending…`, `complete (in progress…`) deterministically, so a finalize spawn cannot narrate its way to `completed` while an obligation is unmet. [C]'s prompt wording is belt-and-suspenders only. *(The tightened regex must still accept the legitimate augmented-complete forms the original `/^complete[\s\-:(]/` was written to pass — verify against real state.json terminal writes.)*
2. **Terminal-error short-circuit.** If the exit carries a terminal-error classification (credit-out / auth-out / billing / model-not-found), NO continuation/yield-resume fires — terminate. (`classifyTerminalError` already gates both the exit-≠0 and post-verify paths, `executor.ts:327/384`.)
3. **Notebook-presence gate.** Yield-resume / park fires ONLY with a non-empty STRING `notebook_id` in state — never re-spawn/park a job that never reached NLM. (Mirror the S168 `recoverableNotebookId` string-coercion guard.)
4. **Intentional-yield window gate.** [D]'s `awaiting_import` yield is honored ONLY for `4 ≤ phase < 7` and only with the explicit marker; any other non-complete exit-0 stays the Class-A terminal fail (no regression vs today).
5. **Bounded host wait + partial-batch completion (Gemini C1).** [D]'s host poll has an upper **real-wall-clock** bound (`IMPORT_WAIT_MAX_MS`); the wait COMPLETES when `count(PROCESSING=1)+count(PREPARING=5) == 0` (every source resolved to READY or ERROR), NOT on the first ERROR. `ERROR(3)` sources are excluded from the READY set but do NOT abort the wait — a partial batch (101 READY / 1 ERROR) proceeds to finalize on the READY sources. The job fails CLOSED only if ZERO sources are READY when the wait completes, or if the real-wall-clock bound is hit while sources are still 1/5 (never hangs the worker).
6. **Dark-launch default OFF.** [D]'s enabling flag defaults OFF; flip-then-monitor rollout; DR-Deploy `.env` set explicitly to engage (MINOR m-3: the untracked `.env` needs a manual sync note in the [D] MERGE gate).
7. **Dispatch idempotency.** [D]'s spawn #1 import dispatch carries an idempotency key so a crash-during-dispatch re-entry does NOT double-dispatch.
8. **Non-empty source assertion before finalize (Gemini m5).** Before the host wait proceeds to finalize it asserts total source count `> 0`. A `source list` that returns EMPTY (the agent wrote `awaiting_import` but the Phase-3 dispatch failed/hallucinated) does NOT instantly resume finalization with zero sources (→ garbage report); it waits a short grace (`IMPORT_DISPATCH_GRACE_MS`, for API-list lag) and, if still empty, fails CLOSED. Never finalize on a 0-source notebook.

### 5.2 Budget / duration math — CORRECTED (C-1)

The v1 §5.2 proved `Σ activeMs ≤ 90 min` to prevent a "container SIGKILL." **§1.5 shows there is no container wall**, so that proof guarded a phantom. The corrected accounting:

- **`MAX_JOB_DURATION_MS` is a per-`claude`-child self-imposed cap** (`claude-spawn.ts:328-333`), enforced on `activeMs` (sleep-gap-excluded, `:322-326`). When it fires it SIGKILLs *that child* → `exitCode≠0` + `killReason="DURATION"` → the S136 recovery path, distinct from the S193 exit-0 stop.
- **[D] has no cumulative-budget hazard.** The deterministic host wait consumes **zero** model active-time (no `claude` child is alive during the wait), so it cannot count against any child cap. The two agent spawns (dispatch, finalize) are each short and each governed by their own independent per-child cap. There is no shared-clock re-spawn, so nothing to thread.
- **The host wait's own bound is REAL wall-clock** (`Date.now() − waitStartMs ≥ IMPORT_WAIT_MAX_MS` ⇒ terminalize), NOT `activeMs` — because the wait is deliberate sleep, and any real "how long have we waited?" question must use elapsed time. This is the C-1 correction (budget the real quantity).
- **What "how long has the JOB run?" would use, if ever needed:** `Date.now() − jobStartMs`, not `Σ activeMs`. Recorded here so a future [D] enhancement (e.g. a total-job wall-clock ceiling) uses the right clock.

---

## 6. Test plan

### 6.1 [C] (prompt-only) — dogfood + assertion
1. **Re-dogfood the S193 scenario** — report-only, vendor-eval-disabled request with a large corpus (≥50 sources) to force a slow Phase-3 import. **Pass:** the run does NOT stop at the 5→5.5 boundary; the relocated poll executes as the first phase-5-exit action; process page stays live; job completes. **Fail:** any `phase:"5"` / `"Non-terminal"` exit-0 stop recurs.
2. **Branch-skip assertion (the S193 root):** by prompt-read + a report-only dry-run trace, verify the relocated gate sits in the shared spine BEFORE conditional Phase 5.5a — a vendor-eval-disabled run MUST hit it.
3. **CRITICAL-wording unit check:** grep `job-manifest.ts` buildPrompt output for the extended negated-narration set (await/resume/non-terminal/yielding **+ premature "complete"**) — always-emitted, not publish-gated.

### 6.2 [D] host-side wait — unit + integration
4. `isAwaitingImportYield` truth table — yields ONLY on the explicit marker + non-empty string notebook_id + `4 ≤ phase < 7`; fail-CLOSED (terminal) on each single miss (no marker, empty/garbage notebook_id, phase<4, phase≥7, terminal-error present). One test per gate.
5. **Host wait completion (Gemini C1 partial-batch):** loop keeps waiting while `count(1)+count(5) > 0`; a census of `{1,1,5}` → wait; `{2,2,2}` → complete (all READY); **`{2,2,3}` → complete (partial: 2 READY / 1 ERROR) → finalize proceeds on the 2 READY, does NOT abort**; `{3,3,3}` → complete but ZERO READY → fail CLOSED; real-wall-clock `IMPORT_WAIT_MAX_MS` hit while any 1/5 remain → terminalize (never hang).
6. **Empty-source race (Gemini m5):** `source list` returns `[]` at yield resume → host waits `IMPORT_DISPATCH_GRACE_MS`, re-lists; still `[]` → fail CLOSED (never finalize on 0 sources).
7. **Gate tightening (Gemini m4):** the tightened `COMPLETE_AUGMENTED` REJECTS `"complete (pending import)"` / `"complete (in progress)"` but still ACCEPTS the legitimate augmented forms the original regex passed (`"complete:"`, `"complete - done"`, `"complete (final)"` if intended) — a table pinning accept/reject against real terminal state.json writes.
8. **Structural anti-re-import** — the finalize spawn's `--allowedTools` set contains NO source-mutation tool; assert by argv inspection (mirrors `claude-spawn.ts:206-224`).
9. **Dispatch idempotency** — a crash-during-dispatch re-entry does NOT double-dispatch the import (idempotency key).
10. **Mutual exclusion** — an `awaiting_import` yield (exit-0) never enters the S136 exit-≠0 recovery nor the Gate-A video-defer; a DURATION kill (exit-≠0) never enters the yield path.
11. **Dark-launch no-regression** — with [D]'s enabling flag OFF, a phase-5 exit-0 stop fails identically-to-today (no regression).

**No-regression:** full `pnpm test` green (agent + frontend); `tsc --noEmit` strict clean; the storage-path grep guard passes.

### 6.3 Prod rollout (both items)
- **[C]:** deploy → observation window; watch the next N real jobs for the 5→5.5 stop rate + relocated-poll presence on report-only traces.
- **[D]:** flip the enabling flag in DR-Deploy `.env` → restart worker → **flip-then-monitor** (self-alerts via `PREFLIGHT_NOTIFY_EMAIL`; no fail-open). Watch for: (i) zero false-completes, (ii) yield firing only on genuine phase-4–6 import-waits, (iii) host wait terminalizing on SOURCE ERROR / bound, (iv) no duplicate-import cost signature in usage telemetry.

---

## 7. Cross-references

- Internal peer-review (the BLOCK this v2 integrates): `sandbox/phase5-nlm-import-stop-deterministic-fix-peer-review.md`.
- Prior deterministic-fix draft (superseded): `sandbox/phase5-nlm-import-stop-deterministic-fix-design-gate.md` (v1, [C]→[A]→[D]).
- Prior gate (superseded disposition): `Documentation/phase5-nlm-import-stop-fix-design-gate.md` (§X-L2 CUT, §X-L3 DEFERRED) — predate the S193 evidence.
- Failure class: `feedback_phase5_nlm_import_stop_failure_class.md`.
- Deployed-but-ineffective L1+E: `main f2b68dd`.
- Load-bearing seams (grounded this session): `agent/lib/claude-spawn.ts` (`:199-224` no-max-turns, `:294-371` waitForProcess incl. `:299` cap read / `:322-326` activeMs sleep-exclusion / `:328-333` DURATION SIGKILL-of-child / `:361-364` exit resolve, `:286-292` shouldRecoverAfterDurationKill), `agent/lib/worker-config.ts` (`:12-14` "cap only kills the claude subprocess", `:26-32` synchronous-blocking-gate precedent), `agent/executor.ts` (`:282-374` spawn+wait+exit-≠0 S136 recovery block, `:333-357` S136 recovery gate, `:376-454` verify + Gate-A video-defer, `:447-451` terminal failJob), `agent/lib/state-evaluation.ts` (`:290-339` completion gate incl. `:318` COMPLETE_AUGMENTED, `:393-442` shouldDeferForVideoRender), `agent/lib/nlm-artifact-cli.ts` (`:39,:100-133` ARTIFACT enum — NOT the SOURCE enum), `agent/lib/job-manifest.ts:226` (anti-stop CRITICAL), `~/.claude/commands/research-compare.md` (`:543` wait=False import, `:642` phase-5 end, `:709` REVIEW GATE 2, `:721` Step A upload, `:727` Step A.1 poll).

---

*End of v2. Next gate action: submit to Gemini (holistic-adversarial) → integrate → Codex (grounded-adversarial) on the integrated revision; capture verbatim in `phase5-nlm-import-stop-deterministic-fix-peer-review.md`; then implement [C] per §3.1 through the full §11 tri-vendor MERGE gate BEFORE any `agent/` merge.*
