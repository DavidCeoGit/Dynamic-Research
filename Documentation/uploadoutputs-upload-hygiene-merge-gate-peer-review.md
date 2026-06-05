# uploadOutputs upload-hygiene — MERGE-gate peer review (verbatim)

> Companion to `uploadoutputs-upload-hygiene-design-gate.md`. The CODE implementing Option A (commit pending). MERGE × AGENT BEHAVIOR × NORMAL.
> Sequential topology: Gemini 3.1 Pro Deep Think → (no changes to integrate — Gemini APPROVE, NITs only) → Codex `exec -s read-only`.
> Outcome: **Gemini APPROVE / Codex APPROVE_WITH_CHANGES (NITs only) — unanimous, no blocking. MERGE gate CLOSED.**
> Files reviewed: `agent/executor.ts` diff (uploadOutputs rewrite + call-site empty-guard + imports), new `agent/lib/upload-set.ts`, new `agent/test/upload-set.test.ts`. Verification at review time: full agent suite 239/239, `pnpm test` (tsc agent+frontend+grep) green.

## Codex NITs actioned post-review
- [NIT] unused `BUCKET` import → removed (re-promoted, tsc still green; archive executor.ts-s88b).
- [NIT] code referenced `Documentation/...design-gate.md` only present in sandbox → design-gate doc + both peer-reviews promoted to `Documentation/` in this same change.
- [MINOR] new files untracked → `git add`ed in the ship commit.

---

## MERGE Round 1 — Gemini 3.1 Pro Deep Think (VERBATIM)

This is an excellent, faithful implementation of Option A from the DESIGN gate. The code correctly restricts the upload source to the canonical `Projects/<slug>/` directory, adds the necessary `upsert: true` flag for idempotency, and elegantly delegates selection logic to a pure, testable function.

Here is my MERGE gate review:

### 1. VERDICT
**APPROVE**

### 2. Fidelity
The code implements Option A exactly as agreed:
* **projectsDir-only:** `workDir` was cleanly dropped from the signature and the `readdir` loop. 
* **upsert:true:** Hardcoded securely in the `upload` execution parameters.
* **pure `selectUploadSet`:** Implemented cleanly in `agent/lib/upload-set.ts` using `UploadCandidate` to safely exclude subdirectories and skip-listed artifacts. 
* **uploader seam:** The `Uploader` function type effectively abstracts away Supabase IO, bridging the pure test suite and the actual implementation perfectly. 
* **caller-side empty-guard:** Correctly placed in `executeJob`, accurately reacting to `selected === 0`.

### 3. Correctness
* **Empty-guard placement:** [NIT] Excellent. Throwing the error directly inside `executeJob` safely bubbles up into the `finally` block, ensuring that `recordUsage(sb, {...})` accurately logs the telemetry failure without prematurely marking the job complete.
* **Uploader type:** [NIT] Using `Omit<UploadWithAuditOpts, "sb">` paired with `getSupabase()` is structurally sound. Since `getSupabase()` is a memoized singleton inside `executor.ts`, calling it on each `upload` execution is extremely cheap and completely safe.
* **readdir withFileTypes:** [NIT] Correctly maps node's `Dirent` array to the `UploadCandidate` shape, making it bulletproof against nested directories like `.claude`.
* **UploadResult selected:** [NIT] Exposing `selected: selectedSet.length` allows `uploadOutputs` to safely return zero without throwing internally, preserving the established caller-side fault-handling mechanics.

### 4. Test Adequacy
The new test suite `agent/test/upload-set.test.ts` is exhaustive and exceptionally rigorous.
* **Pure Selection:** The `selectUploadSet` tests definitively prove the exclusion of stale/scratch files and directories, and validate that an empty input safely returns `[]` without error.
* **IO-loop Mocking:** The `makeStore()` mock successfully verifies that the IO loop applies `upsert: true` across all calls, proving re-queue idempotency. 
* **Empty-guard signaling:** It correctly tests that an empty or missing `projectsDir` cleanly returns `selected === 0`. No missing test cases were identified. 

### 5. Anything Else
* **Type Safety:** The TypeScript compiler would instantly catch any discrepancies in the destructured `Uploader` execution (`...args`). It fits `UploadWithAuditOpts` beautifully. 
* **Regression Risks:** There are no leaks. `state.json` inclusion was cleanly addressed by the skill's Phase 6 Step B `cp` behaviors and isn't regressed here.

**MERGE-gate CLOSED on APPROVE.** Clean, safe, and highly idiomatic. You are clear to merge.

---

## MERGE Round 2 — Codex (code-grounded, exec -s read-only) (VERBATIM)

**VERDICT:** APPROVE_WITH_CHANGES

I concur with Gemini + author on the Option A code behavior. The implementation is faithful: `uploadOutputs` now sources only from `Projects/<slug>/`, uses `upsert:true`, delegates filtering to pure `selectUploadSet()`, supports an injected uploader, and the caller-side empty guard fails before `completeJob()`.

**Findings**
- [MINOR] [agent/executor.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/agent/executor.ts:29>) imports the new selector, but `git status --short` shows [agent/lib/upload-set.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/agent/lib/upload-set.ts:1>) and [agent/test/upload-set.test.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/agent/test/upload-set.test.ts:1>) as untracked. Code is correct with current working-tree files present, but the merge must include those new files or the import breaks.
- [NIT] [agent/executor.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/agent/executor.ts:27>) still imports `BUCKET`, now unused after upload storage moved through `uploadWithAudit`.
- [NIT] [agent/executor.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/agent/executor.ts:1306>), [agent/lib/upload-set.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/agent/lib/upload-set.ts:25>), and [agent/test/upload-set.test.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/agent/test/upload-set.test.ts:9>) reference `Documentation/uploadoutputs-upload-hygiene-design-gate.md`, but `rg` only found that doc under `sandbox/`.

**Correctness**
Empty guard ordering is correct: `selected === 0` fails + notifies + throws at [agent/executor.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/agent/executor.ts:564>) before the failed-upload branch and before `completeJob()` at [agent/executor.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/agent/executor.ts:591>). `finalStatus` stays `"failed"` until after completion, and `recordUsage` runs in `finally`, so telemetry is not skipped and there is no double-fail path.

Uploader type and lazy Supabase path are sound: `Omit<UploadWithAuditOpts, "sb">` at [agent/executor.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/agent/executor.ts:1293>), lazy memoized `getSupabase()` through the default uploader at [agent/executor.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/agent/executor.ts:1315>). `readdir(..., { withFileTypes: true })` maps to `{ name, isFile }` correctly at [agent/executor.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/agent/executor.ts:1319>).

Greps show only one live production caller of `uploadOutputs`, and `selected` is only consumed in `executor.ts` plus the new tests. Test coverage is good for selector filtering, upsert/requeue behavior, and empty/all-skipped/missing dirs. I could not run `pnpm -C agent exec tsc --noEmit`; the read-only execution policy rejected it.
