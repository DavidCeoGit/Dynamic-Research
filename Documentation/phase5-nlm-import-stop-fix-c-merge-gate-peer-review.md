# MERGE-Gate Peer Review — Phase-5 NLM-Import-Stop Fix [C] (prompt-only reinforcement)

**Session:** DR S195 (2026-07-01) · **Gate:** MERGE (§11 tri-vendor, agent/ PROD) · **Severity:** NORMAL · **Risk labels:** AGENT BEHAVIOR + INFRA
**Change under review:** branch `s195-phase5-import-stop-fix-c` — `agent/lib/job-manifest.ts` (anti-stop CRITICAL hardening) + `agent/test/publish-brief.test.ts` (+3 emission tests) + the global slash-prompt `~/.claude/commands/research-compare.md` NEW **Step 5e** corpus-readiness gate (not in repo, live-immediately).
**Topology:** sequential — Gemini 3.1-pro (holistic-adversarial) → integrate → Codex gpt-5.5 xhigh (grounded-adversarial, on the integrated version) → fresh Claude grounded-adversarial subagent (defense-in-depth) → author synthesis. Both external lenses prompted to try-to-BLOCK within their lens.

## What each reviewer saw
- **Gemini (holistic-adversarial, breadth):** the full change bundle — the agent/ diff, the complete post-edit anti-stop CRITICAL (line 226 verbatim), and the NEW slash-prompt Step 5e section. No repo access (bundle only).
- **Codex (grounded-adversarial, depth):** the SHIPPED code in-repo (`job-manifest.ts`, `state-evaluation.ts`, `find-state-file.ts`, `publish-brief.test.ts`) read directly in a `-s workspace-write` sandbox + the slash-prompt Step 5e + 5→5.5 spine staged at `sandbox/_s195_slash_context.md`. Ran `pnpm test` itself (707/707 + 150/150) and a live Node regex probe. Run-banner asserted: `model: gpt-5.5`, reasoning `xhigh`.
- **Claude subagent (grounded-adversarial, fresh/zero-context):** the same in-repo files + Step 5e content; prompted to REFUTE; permitted throwaway node/python probes. [VERDICT PENDING — fill on completion.]

---

## Round 1 — Gemini 3.1-pro (holistic-adversarial) → VERDICT: BLOCK

**Model banner:** gemini-3.1-pro-preview · thinkingLevel high · prompt=7692 thoughts=23040 output=800 finish=STOP

### [CRITICAL] Windows-venv path (`Scripts/activate`) would fail on a Linux worker → **REJECTED (platform-wrong)**
- **Gemini's concern:** Step 5e's bash uses `source ~/.notebooklm-venv/Scripts/activate`; on Linux the path is `bin/activate`, so on a Linux/Docker worker the `&&` chain short-circuits, the poll never runs, and the agent could stop early — re-triggering Class-A.
- **Disposition — REJECTED on ground truth (same finding S193 rejected identically):** the worker is a **Windows** Scheduled Task (`DynamicResearchWorker` → DR-Deploy clone), not Linux/Docker. Verified this session: `~/.notebooklm-venv/Scripts/activate` **EXISTS**, `~/.notebooklm-venv/bin/activate` is **ABSENT** (a Windows venv has no `bin/`), and the **shipped, live** Step A.1 corpus poll uses the identical `Scripts/activate` path in **10 places** in the same slash prompt. If the path were wrong, prod would already be broken — it is not (the S193 dogfood reached the poll invocation; the drift was the agent not entering it, not a venv error). Gemini lacks the grounding that the host is Windows; this is a recurring holistic blind spot ([[live_test_refutes_confident_reviewer_on_external_service]]). Adding a Linux fallback would DIVERGE from the shipped Step A.1 (a mirror-parity smell) to guard a deployment that does not exist. **No change.**

### [MINOR] Stale legacy poll-reference in `job-manifest.ts:226` → **INTEGRATED**
- **Gemini's concern:** the CRITICAL still said "see Phase 5.5 Step A.1 for the corpus-import poll … writing a fresh progress line on EACH poll," now slightly stale since Step 5e is the primary corpus poll and the Step 5e/A.1 polls auto-write heartbeats.
- **Disposition — INTEGRATED (commit 2 on the branch):** updated the poll-reference clause to point at **Phase 5 Step 5e** (primary corpus-readiness poll at the 5→5.5 boundary) + **Phase 5.5 Step A.1** (pre-generate re-check), and to note the Step 5e/A.1 polls write their own `state.phase_status` heartbeat each tick (the agent hand-writes progress only while driving the Studio render loop). Kept the "Phase 5.5 Step A.1" token so the existing test still passes. Single-line substring edit; CRLF preserved; `pnpm test` re-green (707/707).

### [INFO] Double-wait compounding (~50 min: Step 5e 25-min bound + Step A.1 25-min bound) → **ACKNOWLEDGED, tracked for [D]**
- Gemini itself rates it acceptable ("a cap-kill on a terminally stuck job is not worse than the current immediate hard-fail; worth tracking for the [D] migration"). Bounded and rare (requires a >25-min import STILL unfinished after the first bound). The Step 5e contract already notes Step A.1 is an idempotent second check that returns immediately if the import finished in the interim. When [D] ships, [C]'s in-turn poll is removed (the [C]→[D] migration), dissolving the compounding. **No [C] change.**

---

## Round 2 — Codex gpt-5.5 xhigh (grounded-adversarial, on the integrated version) → VERDICT: ENDORSE

**Run banner:** model: gpt-5.5 · provider: openai · sandbox: workspace-write · reasoning effort: xhigh. Ran `pnpm test` (707/707 agent, 150/150 frontend) + a local Node probe on `COMPLETE_AUGMENTED`.

**0 CRITICAL · 0 MAJOR · 2 MINOR · 6 INFO grounded-correct confirmations.**

### Grounded-correct confirmations (INFO — the load-bearing adversarial targets, all verified against shipped code):
1. **Template-literal integrity + always-emitted** — the anti-stop CRITICAL is in the unconditional returned prompt BEFORE `${publishBlock}` (`job-manifest.ts:218`/`:226`); `publishBlock` conditional at `:191`; non-publish + ordering pinned by tests at `publish-brief.test.ts:178`/`:202`.
2. **Premature-complete coherence vs the UNCHANGED gate** — a local Node probe confirmed `/^complete[\s\-:(]/` (`state-evaluation.ts:318`, used `:323`) matches `complete (pending import)`; [C]'s prompt-level forbiddance is accurate and non-contradictory with the deliberately-unchanged regex.
3. **Branch-skip protection** — Phase-5 state write `research-compare.md:642`, Step 5e immediately follows `:644`, the vendor-eval skip is LATER `:743`, REVIEW GATE 2 / Phase 5.5 later `:806`/`:816` → a report-only / `vendorEvaluation.enabled=false` run MUST hit Step 5e before any Finalization path.
4. **Worker-only / interactive** — `buildPrompt` is used only in `executor.ts:267`/`:286` before `spawnClaude … -p` (`claude-spawn.ts:180`/`:199`); interactive skip is explicit at `research-compare.md:739`.
5. **Test adequacy** — the 3 S195 tests (`publish-brief.test.ts:225`/`:234`/`:241`) pin non-publish emission, drift vocabulary, premature-complete forbiddance, and the Step 5e/CORPUS_IMPORT_READY pointer.

### [MINOR] `resolve_state()` not byte-faithful for the empty-candidate case → **ACKNOWLEDGED (safe + unreachable; mirror-parity preserved)**
- **Codex's concern:** the worker selector returns `null` on no candidates; Step 5e returns `"state.json"`. The "byte-faithful mirror" comment slightly overstates.
- **Disposition — ACKNOWLEDGED, no change.** Codex itself confirms this "does not land on the wrong file or fail open after the Phase 5 state write" — the case is **unreachable** at Step 5e (a state file always exists after the `phase:"5"` write) and behaviorally safe (heartbeat READS first → `FileNotFoundError` → `except: pass` → no-op; never a wrong write). Both fix options have a downside: returning `None` would DIVERGE Step 5e from the shipped Step A.1 (breaking the intended byte-mirror parity), and touching Step A.1 is out-of-scope shipped code. Preserving Step 5e ≡ Step A.1 outranks the comment-precision nit. The "faithful mirror" claim holds for every reachable case.

### [MINOR] `CORPUS_IMPORT_EMPTY_FAIL_FORWARD` proves "no observable sources after 3 min," not "no server-side import exists" → **DEFERRED to [D] (Codex's own scoping)**
- **Codex's concern:** a report-only run may not reach the Step A.1 backstop; if NLM ever returns a real empty source list >3 min while registration is hidden, the job could finalize early.
- **Disposition — DEFERRED to [D], per Codex's explicit recommendation** ("I do not classify this as blocking … an explicit fail-forward tradeoff … does not make [C] worse than the prior no-poll report-only path. Fix: in [D], persist Phase 3 expected/add-success source count and allow empty fail-forward only when expected count is zero"). The robust fix requires plumbing Phase-3's expected-import count into durable state — host-side [D] work, out of scope for the prompt-only [C]. [C] is strictly better than the status-quo (which had NO poll at all on this path).

---

## Round 3 — Fresh Claude grounded-adversarial subagent (defense-in-depth) → VERDICT: ENDORSE (with a pre-merge MAJOR that BOTH externals missed)

Zero-authoring-context, prompted to REFUTE, ran throwaway node/python probes. **This lens earned its keep — exactly the S193 pattern (a fresh Claude lens caught the decisive Fix-E MAJOR both externals missed on this same failure class).**

### [MAJOR] Step 5e poll: status-tally lines OUTSIDE the try/except → uncaught crash on a non-list / non-dict `sources` → NO sentinel printed → **FIXED pre-merge (fold-in, not owed)**
- **Finding:** the `try/except` wrapped only `subprocess.run` + `json.loads(...).get('sources', [])`. The four `sum(1 for s in srcs if s.get('status_id') …)` tally lines were unguarded. A well-formed JSON whose `sources` is a non-list (`"importing"`, `5`) or a list of non-dicts (`["a",2]`) raises `AttributeError`/`TypeError`, killing the `python -c` process with NO `CORPUS_IMPORT_*` sentinel — landing the agent in the exact ambiguous no-sentinel state the gate exists to remove, and the traceback is a plausible NEW stop-narration trigger. **This is the one path where [C] could make a specific run WORSE than the no-poll baseline.** Graded MAJOR (not CRITICAL) because reachability of a non-list `sources` from `notebooklm source list --json` is unproven.
- **Reproduced:** all four malformed payloads crash the OLD tally uncaught (verified this session).
- **FIX (applied to Step 5e, the subagent's own recommended combined fix):** coerce defensively — `raw = srcs if isinstance(srcs, list) else None` (non-list → keep waiting to the bound); `items = [s for s in raw if isinstance(s,dict)]`; count only dicts; **`waiting = rawlen - ready - errored`** so 1/5/unknown-status/unparseable-element ALL count as pending → fail SAFE (wait → bounded FAIL_FORWARD), never crash, never false-READY. Removed the now-unused `WAIT = {1,5}` set.
- **Deterministic verification:** `py_compile` clean; a **17-case payload battery ALL PASS** — no crash on any malformed input; every case fail-safe (non-list/non-dict → WAIT→BOUND_FF; unknown/missing status_id → WAIT with no false READY; empty [] → EMPTY only post-grace; all-ready / all-errored / resolved-mix → READY; processing/preparing/mixed → WAIT).

### [MINOR] Unknown/missing `status_id` counted as "not waiting" → all-unknown list falsely reports READY → **FIXED in the same edit**
- The old `waiting = count(status_id in {1,5})` treated a missing or future-enum `status_id` as not-waiting → with `len>0` and `waiting==0`, READY fired on iteration 1. The combined fix (`waiting = rawlen - ready - errored`) makes any non-{2,3} status count as pending → fail-safe wait. Verified in the battery (unknown-99 & missing-status_id → WAIT).

### Grounded-correct confirmations (the fresh lens independently re-verified, INFO):
- **Completion-gate:** ran `COMPLETE_AUGMENTED` itself — `"complete (pending import)"`, `"complete (studio rendering)"`, even `"complete pending import"` all `isComplete: true`; `"awaiting…"`/`"Non-terminal…"` correctly do NOT match. The forbiddance is accurate + necessary.
- **resolve_state mirror:** ran the Python mirror vs the TS `selectNewestStateFile` over 8 discriminating cases (timestamp bucketing, mtime fallback, lexicographic tie-break, invalid-calendar `20261301` reject) — every pick matched; write is atomic (`tmp` + `os.replace`); foreground poll → no concurrent-writer clobber.
- **No branch-skip** (Step 5e at `:644`, unconditional, before conditional 5.5a). **No interactive leak** (`buildPrompt` sole prod caller `executor.ts:267`; Step 5e skips for `mode==INTERACTIVE`). **No hang / no cap-starvation** (worst-case ~26.5 min absolute << 90-min `MAX_JOB_DURATION_MS=5_400_000`, `claude-spawn.ts:299`). **Tests non-vacuous** (every asserted token provably ABSENT from pre-S195 `job-manifest.ts` per `git show 0962f79`).

**Sequential-QA (post-fix) → VERDICT: ENDORSE.** The same lens verified the Step 5e fix closes both findings with no regression: confirmed the 7 crash-class payloads all resolve to WAIT→BOUND_FF (a sentinel is always emitted); confirmed both coordinator sanity-checks (ALL-ERRORED→READY is correct per "count it out and log it" — a terminally-failed source is *resolved*, so proceeding with it counted-out beats stalling the bound; mixed [ready-dict, non-dict-junk]→WAIT because the junk element holds the gate open); proved `waiting` can never go negative (`ready+errored ≤ len(items) ≤ rawlen`); noted a bonus fail-safe (a JSON-string `status_id "2"` counts as pending, not a false READY).

### [MAJOR — residual, same defect class] The sibling **Step A.1** pre-generate corpus re-check carried the IDENTICAL unguarded tally → **FIXED in the same wave (completeness)**
- **QA finding:** Step A.1 (the Studio-bearing pre-generate re-check) was structurally identical to the *pre-fix* Step 5e — the same non-list/non-dict crash + unknown-status false-READY, still fully live. Fixing only Step 5e would leave the exact Class-A crash path live one phase later, on the highest-value (Studio-bearing) runs.
- **Disposition — FIXED (per "fix robustness issues immediately, don't backlog" + the reviewer's own recommendation).** Applied the identical guard block to Step A.1 (defensive `isinstance` coercion + `waiting = rawlen - ready - errored`; preserved its no-EMPTY-branch semantics — empty→wait-to-bound, since its comparison file is source-wait'd); removed its now-unused `WAIT` set. `py_compile` clean; a 13-case Step A.1 battery ALL PASS (no crash, no false READY; empty→WAIT→BOUND_FF). Both twin polls now carry a sync comment ("keep the two blocks in sync; both removed when [D] ships") since a slash prompt cannot factor a shared function.

---

## Synthesis & final direction

- **Gemini (holistic):** BLOCK → the sole CRITICAL is a platform-wrong false positive refuted on ground truth (Windows host, matches 10 live uses incl. shipped Step A.1); the MINOR is integrated; the INFO is acknowledged/tracked-for-[D].
- **Codex (grounded):** ENDORSE → 0 CRITICAL/MAJOR; both MINORs non-blocking (one safe+unreachable, one Codex-scoped to [D]); 6 grounded-correct confirmations of the load-bearing targets.
- **Claude subagent (grounded, fresh):** ENDORSE + a real MAJOR (Step 5e unguarded-tally crash) BOTH externals missed → FIXED + battery-verified; MINOR (unknown-status false-READY) → FIXED; fidelity-QA ENDORSE + a residual MAJOR (the Step A.1 twin) → FIXED + battery-verified.

**No unresolved CRITICAL or MAJOR remains.** The one Gemini CRITICAL is refuted by verified ground truth (a platform assumption that does not hold); the two Codex MINORs are dispositioned (acknowledged-safe / deferred-to-[D] by the reviewer's own recommendation); the Gemini MINOR is integrated; **the fresh-Claude MAJOR + MINOR + residual-MAJOR are all FIXED before merge and deterministically verified (`py_compile` + two payload batteries, 30 cases, all fail-safe).** The fresh Claude grounded lens re-earned the tri-vendor discipline (the S193 pattern): it caught a crash both externals missed. `pnpm test` green (707 agent / 150 frontend, 0 fail; strict tsc; grep-guard); the agent/ code (`job-manifest.ts` + tests) is byte-unchanged since Codex's grounded ENDORSE. **[C] is a DESIGN-blessed PROBABILISTIC reinforcement, not the guarantee — [D] is the deterministic guarantee and its own later MERGE gate.**

**Verdict: CLEAR — unanimous (Gemini holistic + Codex grounded + fresh Claude grounded), all blocking findings resolved. Cleared to merge the agent/ change + deploy; the slash-prompt Step 5e + Step A.1 hardening is live-immediately (global file).**
