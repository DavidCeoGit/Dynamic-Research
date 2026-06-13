# MERGE-gate peer review — Stale-terminal-state fail-open hardening (S117)

**Change:** `archiveStaleStateFiles()` (new, `agent/lib/find-state-file.ts`) renames every prior-attempt
`state.json` / `*-state.json` in a reused per-slug workdir ROOT into a `.superseded-state/` subdir,
called once in `executeJob()` (`agent/executor.ts`) right after `mkdir workDir` — before the spawn,
the progress poller, and the studio_only branch.

**MRPF classification:** MERGE gate · Risk Labels = AGENT BEHAVIOR (changes worker claim-time behavior
that propagates to every future job) + DATA (PUBLISH-gate integrity / fail-open prevention) · Severity
NORMAL · Topology sequential **Gemini → integrate → Codex → integrate → Codex QA**.

**Bug closed (origin S116, job 9a1b7b30):** per-slug workdirs (`C:/tmp/research-compare/<slug>/`) are
reused across re-queues. A PRIOR attempt's terminal `state.json` (possibly carrying a PASSING
`publish_verification`) survives. If a new spawn exits WITHOUT writing its own state, `findStateFile()`
returns the stale passing file and the PUBLISH gate publish-clears a no-work run — fail-OPEN, the exact
class MRPF PUBLISH exists to prevent. Also a cosmetic symptom: the poller mirrored a stale `complete (0%)`
phase ~5s post-spawn. See `feedback_stale_terminal_state_fail_open_hazard`.

**Fix mechanism:** with the stale file archived out of the root, `findStateFile()` returns null, and the
EXISTING null-state guards fail CLOSED — `verifyPipelineCompletion` ("no state.json was written") on the
full path (executor ~1547) and the null-state read on the studio_only path (executor ~970-978). No new
gate logic; the fix removes the input that fooled the existing gate.

---

## What each reviewer saw
- **Gemini 2.5 Pro (holistic-adversarial, breadth):** whole change in repo context — `find-state-file.ts`,
  `executor.ts` (executeJob, both pipeline paths, verifyPipelineCompletion, gate calls), the new tests.
- **Codex (grounded-adversarial, depth, `exec -s read-only`):** same files PLUS
  `agent/scripts/regenerate-studio-products.ts` and `worker.ts` (claim→gate path), file:line counterexamples.
- **Codex QA pass:** v3 only — fidelity check that its v2 finding was applied correctly.

---

## Gemini v1 — verdict BLOCK → **REFUTED** (documented disagreement)

**Primary BLOCK (studio_only storage-inherited fail-open):** claimed `regenerate-studio-products.ts`
fetches the PARENT run's `state.json` (with its `publish_verification`) from Supabase Storage and writes
it into the local workDir, so a `studio_only` + `publish_required` regen that exits 0 would let the gate
read the parent's PASSING manifest → fail-open; therefore the fix is "incomplete."

**Resolution — REFUTED by code, independently confirmed by Codex:**
- `regenerate-studio-products.ts:412-425` downloads the parent state into MEMORY (`stateBlob.text()` →
  `JSON.parse(parentState)`) and reads **only `notebook_id`**. `parentState` is **never written to disk**.
- `writeState()` (regen, lines 110-122) writes a FRESH clone state object with `pipeline_mode: "studio_only"`
  and **no `publish_verification` field at all**. So a studio_only regen that exits 0 yields a state with
  NO manifest → the studio_only gate (executor ~970-978) treats it as a missing manifest → fail CLOSED.
  This is PRE-EXISTING behavior, not something the fix had to add.
- The storage-inherited passing manifest Gemini describes cannot materialize. Codex independently verified
  the same lines and called the claim "refuted."

Per MRPF Disagreement Procedure (non-security): recorded with rationale; no phantom remediation added.
This is the `feedback_grounded_reviewer_can_be_confidently_wrong` pattern applied to a holistic reviewer.

**Secondary (TOCTOU collision index):** `${idx}-${name}` with `idx = readdir(archiveDir).length` is not
TOCTOU-safe under hypothetical concurrent same-slug runs. **Integrated (v2):** added an inline comment
making the single-process / single-job worker invariant (CLAUDE.md §6) explicit and noting that a
same-index collision is at worst a forensics issue (Windows: rename throws → fail-closed; POSIX: overwrites
an earlier *archived* sibling), never a live-state fail-open. No allocator change — the invariant holds.

**Tertiary (test coverage):** wanted executor-level integration tests for the archive call on all paths.
**Accepted residual:** the archive is at the single shared chokepoint before both branches; archiving has
no per-path code to integration-test. Helper behavior (archive → `findStateFile`→null) is unit-pinned.

---

## Codex v2 — verdict BLOCK → **VALID, integrated (v3)**

**Blocking finding (broad catch → fail-open):** `archiveStaleStateFiles()` caught ANY `fs.readdir(workDir)`
error and returned `[]`. But `executeJob()` already created the workdir at executor.ts:425 before calling
archive at :437, so a non-ENOENT error (transient EMFILE / Windows EPERM / ENOTDIR) is NOT "missing workdir."
**Concrete counterexample:** stale passing `*-state.json` present → archive `readdir` throws EMFILE →
helper returns `[]`, stale file stays in root → child exits 0 without writing state →
`verifyPipelineCompletion` reads the stale state → gate passes the stale `publish_verification`. My own
error handling re-opened the exact fail-open the fix closes.

**Integration (v3):**
1. `find-state-file.ts` — the workDir `readdir` catch now returns `[]` **only on `ENOENT`**; every other
   error is **rethrown**.
2. `executor.ts` — the archive call site wraps the call; on a thrown archive error it logs, `failJob` +
   `notifyTerminal("failed")`, and `throw` (fail CLOSED) before any spawn/gate work — mirroring the existing
   DRY_RUN publish fail-closed block.
3. `find-state-file.test.ts` — new test "non-ENOENT readdir error rethrows" (a file-as-workDir forces
   ENOTDIR) asserts the helper rejects with `code !== "ENOENT"`.

**Codex pressure-test results (all confirmed):** no claim→gate path bypasses the `executeJob` archive call
(worker.ts:239/255; gates only at executor :661 full / :987 studio); ordering correct (archive precedes
DRY_RUN, studio branch, both watchers, both state reads); no legitimate in-workdir resume broken (worker
model is fresh runs); Gemini's studio_only claim **refuted**; the collision index is not a real defect under
the single-job model. Codex's only over-statement (my v2 comment's "never silently corrupts") was corrected
in v3 (POSIX overwrite = forensics loss).

## Codex QA (v3) — **APPLIED-CORRECTLY**
Verified: (1) helper returns `[]` only on ENOENT, rethrows otherwise; (2) call site fails the job CLOSED on
a thrown archive error before spawn/gate; (3) the new test pins the rethrow. "No remaining fail-open in this
specific area that I'd still block on."

---

## Final state
- `agent/lib/find-state-file.ts` (+`archiveStaleStateFiles`, `SUPERSEDED_STATE_DIR`), `agent/executor.ts`
  (import + fail-closed archive call at executeJob), `agent/test/find-state-file.test.ts` (+6 tests).
- Suite **390/390** agent pass, `tsc --noEmit` clean.
- Gate cleared: Gemini holistic (primary BLOCK refuted with code + Codex concurrence; secondary integrated),
  Codex grounded (BLOCK integrated v3), Codex QA (APPLIED-CORRECTLY).
