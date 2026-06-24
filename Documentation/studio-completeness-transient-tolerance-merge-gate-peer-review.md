# Studio-Completeness Transient-Tolerance — MERGE-Gate Peer Review (S159)

**Artifact under review:** S158 implementation of the transient-tolerant S129 studio-completeness gate
(design v3-FINAL, `Documentation/studio-completeness-transient-tolerance-design-gate.md`).
**Diff:** 14 modified + 4 new files, +1105/−233. Baseline `ebfd528` (S158 diff identical to the prior
`efd9713` baseline; `ebfd528` is the S159 frontend submit-stuck fix on unrelated files).
**Event Gate:** MERGE. **Risk Labels:** AGENT BEHAVIOR (modifies the S129 safety control) + ARCHITECTURE
(new job-recovery control-flow). **Severity:** NORMAL.
**Topology (§11, sequential, both-lenses adversarial):** Gemini holistic-adversarial → (integrate) →
Codex grounded-adversarial → (integrate) → Codex QA → Claude-author final. Per the §11 HARD RULE for
`agent/` PROD code, all three vendors clear BEFORE merge — no substitute-then-owe.

**Verify-first (S159):** `pnpm test` green — agent 465 / frontend 100, 0 fail; `tsc --noEmit` clean both
packages; storage-path grep guard passed.

---

## What each reviewer saw

| Reviewer | Lens | Inputs |
|---|---|---|
| Gemini 2.5 Pro (SDK) | Holistic-adversarial (breadth) | Design doc + full `git diff HEAD` + 4 new files + full post-change studio-completeness.ts / finalize-recovered-run.ts / studio-recovery-sweep.ts / executor.ts / worker.ts (351K-char prompt) |
| Codex (codex-cli 0.130.0, ChatGPT auth, `-s workspace-write`) | Grounded-adversarial (depth) | Live working tree — read all changed + new files + tests + design doc directly |
| Claude grounded subagent (general-purpose, zero authoring context) | Grounded-adversarial (depth, author lineage) | Live working tree — same file set |

---

## Round 1 — Gemini holistic-adversarial (breadth)

**VERDICT: ENDORSE** (no findings). model: gemini-2.5-pro. Log: `c:/tmp/dr-s159/gemini.log`.

Gemini attacked all 6 load-bearing invariants and found each UPHELD in the implementation:

1. **Fail-open invariant — UPHELD.** `result.ok = stillMissing.length === 0` only; `recoverablePending`
   is a subset of `stillMissing`. Gate returns `ok=false`; executor `purelyTransient` branch sets
   `status='failed'` + `throw` (structurally cannot reach `uploadOutputs`/`completeJob`; write-fail
   degrades to terminal). Sweep's only completion route is `finalizeRecoveredRun`, guarded by the keystone.
2. **Keystone (re-assert obligations) — UPHELD.** `finalizeRecoveredRun()` fetches durable
   `selected_products`, `pickWinners` over on-disk, refuses (`ok:false, refused:true`) on `missingObliged`;
   `--force` bypasses lint only, not presence; auto (sweep) and manual (CLI) share the one function; parity
   test proves it.
3. **Age anchor (G6) — UPHELD.** Retry PATCH updates only attempts + next_attempt_at; trigger-immune
   `studio_recovery_first_failed_at` untouched. Age cap attempts-gated (`ageMs>MAX && attempts>=FLOOR`);
   test-proven.
4. **Executor transient branch — UPHELD.** Single atomic `updateJob`; fail-safe + final `throw`; cannot
   fall through to completion.
5. **Classifier bias — UPHELD.** Transient bias safe because the sweep re-lists artifacts every attempt;
   a genuinely-gone artifact → `exhausted (artifact-gone)` fast terminality, no fragile stderr reliance.
6. **Decoupled sweep — UPHELD.** Before `claimJob` + before `probeBackoff` exit (no starvation);
   GRACE_MS predicate prevents just-failed races; service-role REST scoping correct; `LIMIT 1` + per-job
   pacing bound throughput impact.
7. **Blast radius / spec-vs-impl / tests — UPHELD.** Frontend `isRecovering` correct on both surfaces;
   high spec fidelity; tests sensitive (target the invariants, not happy path).

> Integration after Round 1: **none required** (clean ENDORSE, zero findings) — code unchanged into Round 2.

---

## Round 2 — grounded-adversarial (depth) — BOTH VENDORS BLOCK

Two independent grounded passes ran in parallel. **Both returned VERDICT: BLOCK**, each catching real
issues the holistic ENDORSE missed (the §11 grounded-class lesson — a clean breadth pass does not cover the
depth class). Findings disagree with Gemini; the author adjudicated each against the shipped code.

### Codex grounded-adversarial (gpt-5.5, xhigh, ChatGPT auth, ~268k tok). Log: `c:/tmp/dr-s159/codex.log`. VERDICT: BLOCK.

- **[CRITICAL] C1 — transient `artifact list` failure is mis-classified as "artifact-gone".**
  `realListArtifacts` (studio-completeness.ts:531) returns `null` on CLI status≠0 / parse error; the sweep
  does `listArtifacts(...) ?? []` (studio-recovery-sweep.ts:196) then exhausts (`artifact-gone`, :198) when
  the id isn't found. A transient list blip on a still-valid artifact ⇒ job permanently exhausted — a delayed
  re-creation of the exact S156 class the feature exists to prevent. **AUTHOR-VERIFIED REAL.** Fix:
  distinguish list-FAILURE (null ⇒ retry/backoff, do NOT exhaust) from list-SUCCESS-without-id (⇒ artifact-gone).
- **[CRITICAL] C2 — recovery completes after a storage UPLOAD failure (fail-open).** finalize-recovered-run.ts
  counts `failed++` on `!result.ok` (:243) but PATCHes `status='completed'` (+ result_slug) unconditionally
  (:252-256) — no `failed`-guard. The on-disk presence keystone passes, the Supabase upload then fails, and
  the row is marked completed/recovered with the product missing from the gallery. The normal executor path
  blocks this (executor.ts:947 hard-fails on `uploadResult.failed.length>0`). **AUTHOR-VERIFIED REAL.** Fix:
  when `status==='completed'`, return `{ok:false}` before the PATCH if `failed>0`; let the sweep retry/exhaust.
- **[CRITICAL→MAJOR] C3 — malformed `pending` rows can stay non-terminal forever (latent).** The sweep
  candidate query requires `studio_recovery_first_failed_at <= graceIso` (:353); a `pending` row with NULL
  `first_failed_at` is invisible to the sweep (never progresses, never exhausts) while the UI suppresses
  terminal controls. Migration enforces only the status enum CHECK; route accepts null. **AUTHOR ADJUDICATION:
  real defensive gap but LOW current reachability** — the executor is the sole `pending`-writer and always
  sets `first_failed_at` atomically; no current path creates a malformed pending. Treat as MAJOR (defense-in-
  depth). Fix: DB CHECK (`pending ⇒ first_failed_at/next_attempt_at/payload NOT NULL & attempts>=1`) +
  sweep quarantine of any malformed pending.
- **[MAJOR] M4 — exhaustion-alert idempotency is false when the exhaust PATCH fails.** sweep:296 ignores the
  `patchRecovery` boolean, then sends requester+operator emails (:301). A 500 on the PATCH leaves the row
  pending ⇒ every tick re-sends alerts (Resend cascade). Fix: send emails only after a successful `exhausted`
  PATCH. (Author: plausible/grounded; verify at fix time.)
- **[MAJOR] M5 — partial recovery can be lost after a crash / across two ticks.** The sweep re-confirms
  EVERY payload product via list before considering already-downloaded files (:193); if product A downloaded
  on tick 1 but its id no longer lists on tick 2 (while A is on disk), it exhausts before `finalizeRecoveredRun`
  can prove obligations from disk. Fix: check on-disk winners FIRST; skip already-present products; finalize if
  the full obligation set is already present. (Related to C1 — both stem from treating a list miss as terminal.)
- **[MAJOR] M6 — the new tests are not sensitive to the blocking edges.** The sweep harness always returns
  successful patch (test:82) + finalize (test:78); no upload-failure / list-null / patch-failure / busy-queue /
  backoff tests despite the design promising them — which is WHY C1/C2/M4/M5 slipped past a green suite. Fix:
  add sensitive tests for every edge fixed below.
- **[MINOR] m7 — progress page status-details card renders raw `{job.status}` for a recovering job**
  (new/[id]/page.tsx:547). Fix: show "Finalizing media" there too.

### Claude grounded subagent (general-purpose, zero authoring context, ~197k tok). VERDICT: BLOCK.

- **[CRITICAL] C-A — S158's `realDownloadArtifact` return-type widening (boolean → `DownloadResult` object)
  silently broke an UNCHANGED consumer.** `regenerate-studio-products.ts:683` does
  `const ok = await realDownloadArtifact(...); if (!ok)` — `!object` is always `false`, so the studio_only
  download-failure guard is DEAD CODE. Compiles clean (`!object` is legal TS), untested, and ships to the
  prod studio_only regen pipeline (`runStudioOnlyJob`). A truncated non-empty download now uploads as success
  (only `buf.length===0` survives). **AUTHOR-VERIFIED REAL.** Fix: `const dl = await realDownloadArtifact(...);
  if (!dl.ok) {...}` (surface `dl.stderr` in the reason).
- Invariants #1–#7 otherwise confirmed UPHELD by Claude (fail-open subset proof, keystone presence re-assert +
  parity test, immutable age anchor, executor transient branch, classifier bias, sweep mechanics, migration/
  frontend) — consistent with Gemini, EXCEPT the upload-failure hole (C2) which the presence-only check misses.

---

## Consolidated blocker set (author synthesis)

The gate is a genuine **BLOCK** (PARK per §11 — agent/ PROD code, never bypass). Net unique findings:
**3 confirmed CRITICAL** (C-A regression, C1 list-fail→exhaust, C2 complete-after-upload-fail = fail-open),
**4 MAJOR** (C3 malformed-pending defense, M4 alert idempotency, M5 partial-recovery, M6 test sensitivity),
**1 MINOR** (m7 status card). C1/C2/C-A are fail-open or feature-defeating on a safety control — exactly
the class the holistic ENDORSE could not see. This would have shipped a fail-open had the §11 grounded passes
been skipped.

---

## Round 3 — Codex sequential QA (fidelity of integration)

<!-- TODO after fixes integrated -->

## Claude-author final

<!-- TODO after re-review -->

## Final verdict

**ROUND 2: BLOCKED — parked for fix + re-review.** (Not merged.)
