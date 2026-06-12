# Peer Review — Per-sweep budget + breadth-fair circular-ring resume (MERGE gate, DATA label)

Companion to `Documentation/sweep-fanout-budget-design-gate.md` (the DESIGN gate) and the
implementation in `agent/lib/staging-sweep.ts` + `agent/scripts/cleanup-staging-uploads.ts` +
`agent/test/staging-sweep.test.ts`. MRPF MERGE gate, Risk label **DATA** (the module DELETES files
from Supabase Storage). Severity NORMAL. Sequential topology, both lenses adversarial.

## Reviewer roster + what each saw

- **Codex (grounded-adversarial, depth)** — `codex exec -s read-only`, file:line against the shipped
  module + tests + CLI + worker caller + conventions. THREE passes:
  1. MERGE review of the build → **BLOCK** (1 BLOCKING + 1 MAJOR + 2 MINOR).
  2. QA of the integrated fixes → **BLOCK** (1 MAJOR, CLI error-loop) + all prior findings confirmed RESOLVED.
  3. QA-verify of the CLI fix → **ENDORSE** (MAJOR closed, no new defect).
- **Claude general-purpose subagent (holistic-adversarial breadth) — INTERIM SUBSTITUTE for Gemini.**
  The Gemini CLI hung silently on this gate (both `gemini-3.1-pro-preview` and the `gemini-2.5-pro`
  fallback, 0 bytes after ~15 min each, no capacity error — a fresh failure mode vs the working
  DESIGN-gate calls earlier the same session). Per the `~/CLAUDE.md` required-reviewer-unavailable
  fallback hierarchy, a zero-authoring-context Claude subagent ran the **holistic breadth** lens as a
  LABELLED INTERIM. Verdict: **ENDORSE pending F1** (1 MAJOR + 2 MINOR + 3 NIT). It read the whole
  module + CLI + tests + the design doc.
  - ⚠️ **OWED FOLLOW-UP (mandatory, <24h / next session):** the REAL Gemini holistic-adversarial
    MERGE pass. The interim substitute de-risks the merge; it does not discharge the Gemini leg. The
    design itself already received a full Gemini holistic pass (DESIGN gate), which lowers — but does
    not eliminate — the residual cross-vendor-independence gap.

## Outcome

Both reviewers BLOCKed (Codex) / flagged-MAJOR (breadth) the revisions they saw; every BLOCKING +
MAJOR is integrated and re-verified. Final state: **Codex ENDORSE** (QA-verify) + **breadth ENDORSE**
(F1 resolved). No open BLOCKING/MAJOR. Suite 435 (370 agent + 65 frontend), tsc strict clean, EXIT 0.

---

## Round 1 — Codex grounded-adversarial MERGE review (on the build) — VERBATIM
Verdict: **BLOCK**

1. [BLOCKING] `agent/lib/staging-sweep.ts:313`, `agent/lib/staging-sweep.ts:412`, `agent/lib/staging-sweep.ts:448` - raw offset cursors are persisted across deletes, but Supabase Storage listings shrink after `remove()`.
   
   Counterexample: one org, one draft, `50_001` expired files, default `maxRequestsPerOrg=50`. First sweep lists uploads plus 49 file pages, saves `fileOffset=49000`, then deletes those 49,000 paths. The next sweep lists the same draft at offset `49000`, but the remaining 1,001 files have shifted to offsets `0..1000`, so the list returns EOF and clears `orgResume`. The CLI then sees `rootOffset=0` and empty `orgResume` and reports completion while expired files remain.

   Same class exists at root: if a chunk deletes completed orgs whose only objects were staging files, root folders disappear and `cursor.rootOffset = rootOffset + rawIdx` can skip the orgs that shifted left. The static test mock at `agent/test/staging-sweep.test.ts:73-76` never mutates listings on `remove()`, so `agent/test/staging-sweep.test.ts:431-464` proves the mock, not Supabase-like behavior.

   Fix: do not resume by raw numeric offset across prefixes that may have been mutated by deletes. Use a mutating test double and either reset/adjust affected offsets after deletes, avoid deleting from incomplete prefixes, or switch to a stable name/key cursor strategy.

2. [MAJOR] `agent/scripts/cleanup-staging-uploads.ts:83-88`, `agent/scripts/cleanup-staging-uploads.ts:114-138` - the CLI chunk loop treats `orgResume` as pending work even after persistent list errors, so it can retry the same failing prefix up to `100_000` chunks.

   Counterexample: `list()` for one draft prefix throws forever. `listPage()` records the error and returns non-throwing at `agent/lib/staging-sweep.ts:224-229`; `drainOrg()` saves the resume at `agent/lib/staging-sweep.ts:296-297`; root EOF wraps to `0`; CLI sees `orgResume` and loops for hours with 200ms sleeps before exiting.

   Fix: stop the CLI loop on `stats.errors.length > 0` unless the user explicitly requests retry-until-cap, or add a small consecutive-no-progress/error cap.

3. [MINOR] `agent/lib/staging-sweep.ts:266-270`, `agent/lib/staging-sweep.ts:290-294`, `agent/lib/staging-sweep.ts:339-341` - there is no minimum-budget validation.

   At defaults, a normal 3-level tree can progress: root, uploads, file list fit under `maxRequests=300`, `maxRequestsPerOrg=50`, `maxMillis=15000`. If `GLOBAL` trips inside an org's first list with default request budget, the next sweep re-finds that org because `rootOffset` pins to its raw root offset and the fresh request budget can list it.

   But configured floors can livelock: `maxRequests=1` never gets past root; `maxRequests=2` gets root+uploads but never lists files; `maxRequestsPerOrg=1` repeats uploads forever. Wall-clock can also cause zero progress if a root page alone consumes `maxMillis`.

   Fix: clamp or reject `maxRequests < 3`, `maxRequestsPerOrg < 2`, and nonpositive `maxMillis`, or document that those options are test-only unsafe values.

4. [MINOR] `agent/test/staging-sweep.test.ts:239-253`, `agent/test/staging-sweep.test.ts:431-464` - important destructive paths are untested.

   Missing coverage: mutating `remove()` effects on file offsets, draft-folder offsets, and root-folder offsets; persistent ERROR behavior in the CLI loop; low-budget livelock floors. Current assertions would still pass if the shipped logic skipped real Supabase objects after deletes, because the mock's `remove()` only records paths at `agent/test/staging-sweep.test.ts:79-84`.

No over-delete of a fresh/non-expired file found in the changed predicate: candidates still require UUID org and draft, `uploads` scope, `metadata !== null`, parseable timestamp, and `stampMs < cutoffMs` at `agent/lib/staging-sweep.ts:238-253`. The failure is under-delete / false completion caused by mutable offset pagination, not deletion of live non-expired files.
EXIT=0

---

## Round 2 — Codex QA of the integrated fixes — VERBATIM
Verdict: BLOCK

1. [MAJOR] CLI error-streak “no progress” is still wrong. It uses `stats.deleted === 0` as the only progress signal, so dry-run chunks, chunks that advance cursors through fresh/unparseable files, or chunks that make listing progress before later expired files can be counted as “no progress” and abort after 5 errors. See [cleanup-staging-uploads.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/scripts/cleanup-staging-uploads.ts:147>). Also, a transient root list error at cursor `{rootOffset:0, orgResume:{}}` bypasses the 5-streak behavior entirely: `ringComplete()` returns true on cursor shape alone, so the loop breaks after one failed chunk. See [cleanup-staging-uploads.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/scripts/cleanup-staging-uploads.ts:87>) and [cleanup-staging-uploads.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/scripts/cleanup-staging-uploads.ts:156>). This refutes claim (c).

Resolved checks:

- Worker eventual coverage: TRUE for finite trees with successful list calls and production-safe budgets. Stale delete-shift offsets can skip survivors, but EOF clears the org resume and root wraps to 0, so a later from-0 pass re-sees survivors. Key mechanics: [staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:331>), [staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:340>), [staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:450>). Test coverage is at [staging-sweep.test.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/test/staging-sweep.test.ts:660>).

- CLI delete-shift quiescence: correct for successful delete-mode runs. `ringDeleted` is accumulated across the whole ring and reset only after a complete ring that deleted something. See [cleanup-staging-uploads.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/scripts/cleanup-staging-uploads.ts:113>) and [cleanup-staging-uploads.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/scripts/cleanup-staging-uploads.ts:156>). Dry-run terminates after one complete listing ring, which is appropriate because it does not mutate storage.

- Mutating mock: correct for the exact staging layout being tested. Draft folders collapse only when their file list empties; org root collapses when the staging uploads tree empties. See [staging-sweep.test.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/test/staging-sweep.test.ts:604>).

- Safe-budget floor documentation is present, not clamped, as claimed. See [staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:103>).

- S111 invariants remain intact: fail-closed marker claim, marker-before-sweep, completion restamp, and cursor persistence are still present at [staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:634>) and [staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:674>).

I did not run the test suite because this session is read-only and the tests write temp marker files.
EXIT=0

---

## Round 3 — Codex QA-verify of the CLI fix — VERBATIM
Verdict: **ENDORSE**. The MAJOR is closed.

a. **No false complete on transient root error.** `hadErrors` is checked before `ringComplete`; errored chunks go through the branch at [cleanup-staging-uploads.ts:158](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/scripts/cleanup-staging-uploads.ts:158>) and `continue` at [line 168](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/scripts/cleanup-staging-uploads.ts:168>), so the terminal check at [line 172](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/scripts/cleanup-staging-uploads.ts:172>) cannot run on an errored `{rootOffset:0, orgResume:{}}` chunk.

b. **No miscount when cursor moves with zero deletes.** `prevCursor`/`cursor` are captured at [lines 143-144](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/scripts/cleanup-staging-uploads.ts:143>), `movedCursor` is computed at [line 150](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/scripts/cleanup-staging-uploads.ts:150>), and `madeProgress = stats.deleted > 0 || movedCursor` at [line 151](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/scripts/cleanup-staging-uploads.ts:151>). The error streak increments only under `!madeProgress` at [lines 159-162](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/scripts/cleanup-staging-uploads.ts:159>).

c. **Dry-run terminates correctly.** Dry-run is passed into the sweep at [line 128](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/scripts/cleanup-staging-uploads.ts:128>). Since dry-run never increments `deleted`, termination depends on a clean `ringComplete(cursor)` at [line 172](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/scripts/cleanup-staging-uploads.ts:172>) and `!CONFIRM` breaks immediately at [line 175](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/scripts/cleanup-staging-uploads.ts:175>).

d. **No new blocking defect found.** The `continue` does not skip sleep; errored chunks sleep at [line 167](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/scripts/cleanup-staging-uploads.ts:167>) before continuing. It skips the later explicit chunk-cap message at [lines 178-180](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/scripts/cleanup-staging-uploads.ts:178>), but not the actual cap, which is enforced by the `for` bound at [line 125](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/scripts/cleanup-staging-uploads.ts:125>). Error streak reset is scoped correctly at [lines 164-170](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/scripts/cleanup-staging-uploads.ts:164>). The JSON cursor compare is sound for this cursor shape/order.
EXIT=0

---

## Round 1b — Claude holistic-adversarial breadth (INTERIM Gemini substitute) — SUMMARY

Verdict: **ENDORSE pending F1**. Read module + CLI + tests + design doc. Confirmed: design↔impl
faithful (circular ring, raw-offset resume, count-every-list budget, all-pages-EOF prune gate,
listPage never-throws all match §3–§4); multi-tenant fairness delivered by the code (`perOrg` reset
per org entry, cap checked in BOTH draft- and file-list loops); module↔CLI↔test consistent; S111
invariants upheld; eventual coverage proven.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| F1 | MAJOR | `maxMillis` is only sampled BETWEEN `list()` calls (`overGlobalBudget` checks the clock pre-call), so a single hung `list()` (up to the HTTP client's long default timeout) could delay the worker tick past `maxMillis` — design §5 sells `maxMillis` as catching "individually slow `list()` calls," which the impl could not do. | **FIXED** — `listPage` now races each `list()` against the remaining wall-clock budget (`withTimeout`, unref'd+cleared timer); a timeout degrades to `{error:true}` → cursor untouched → retried next sweep. New test "a HUNG list() is bounded by maxMillis". |
| F2 | MINOR | A failed/timed-out `list()` still consumes a budget unit; an error storm can exhaust a sweep's budget with no progress (worker has no error-streak guard, unlike the CLI). | **DOCUMENTED** — `listPage` docstring states erroring pages count against budget BY DESIGN (an error storm can't spin a prefix for free; the worker just waits for the next 24h sweep). Acceptable for a backstop. |
| F3 | MINOR | Design §"test plan" target "≥424" vs CLAUDE.md "415" disagree. | Suite is now 435; the ≥424 target is satisfied. CLAUDE.md §2 test count updated in this PR. |
| F4 | MINOR | Completion re-stamp could move the 24h clock BACKWARD under a non-monotonic (NTP/VM) wall-clock step → next tick sees the sweep due sooner than 24h. | **FIXED** — re-stamp clamped to `Math.max(claimTime, finishedAt)`; monotonic. |
| F5 | NIT | A draft's files can be deleted across two sweeps under two `cutoffMs` values (split-cutoff). | Safe (TTL fixed, `now` only advances; a file fresh in sweep N, expired in N+1 is caught later). No fix. |
| F6 | NIT | `readWalkCursor` validated `typeof === "number"` but not range; a corrupt `rootOffset:-5` would reach `list()`. | **FIXED** — `isValidOffset` requires a non-negative integer for root + draft + file offsets. |

## Synthesis

The two lenses caught DIFFERENT, complementary bug classes — exactly the MRPF thesis:

- **Codex (grounded depth)** caught the load-bearing **DATA correctness** bug: the forward resume
  offset is persisted across deletes that SHRINK the listing (Supabase folders are virtual), so a
  resumed offset can land past delete-shifted survivors. Codex confirmed NO over-delete (the unchanged
  UUID/`uploads`/`metadata`/`stampMs<cutoff` predicate prevents deleting a live file), and the worker
  drains every expired file over successive from-0 rings (EVENTUAL coverage — proven in-suite to 600
  drafts via a mutating mock, and to 50k drafts in manual characterization). The concrete defect was
  the **CLI's completion detection** (false-complete on a delete-shift mid-ring EOF, and treating a
  transient root error as completion) — fixed via per-RING quiescence + never-treating-an-errored-chunk
  as terminal + a no-progress error-streak guard.
- **Breadth (holistic)** caught the system-level **availability** gap: `maxMillis` (the change's
  headline tick-protection guarantee) could not bound a single hung `list()` — a whole-artifact
  design↔impl drift a file:line reviewer staring at one function would not necessarily surface. Fixed
  with a per-call timeout.

Neither pass alone produced a shippable merge. Net deltas across the gate: per-RING CLI quiescence;
error-chunk-never-terminal + progress = delete-or-cursor-moved; per-call list() timeout; monotonic
completion clock; offset range validation; mutating-mock convergence + hung-list tests.

**Confirmed safety floor (Codex, both passes):** a resume-math bug cannot over-delete a live
non-expired file while the destructive predicate + scope guard hold — worst case is a transient miss
reclaimed on the next ring wrap. This is what makes the DATA blast radius acceptable.

**Gate status:** Codex **ENDORSE** (QA-verify) + breadth **ENDORSE** (F1 resolved). No open
BLOCKING/MAJOR. ⚠️ The REAL Gemini holistic MERGE pass remains **OWED** (<24h follow-up) — the
interim Claude breadth substitute de-risked the merge but does not discharge the Gemini leg.
