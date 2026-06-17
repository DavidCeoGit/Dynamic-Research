# S141 — studio_only regen Layer-1 port — MERGE-gate peer review

**Date:** 2026-06-17 (DR S141)
**Change:** Port the S138 "Layer 1 snapshot-diff poll + download-by-id" contract into the
`pipeline_mode === "studio_only"` path (`agent/scripts/regenerate-studio-products.ts`), closing the
two CRITICAL bugs Codex flagged at S138 (CRITICAL-1):
- `:507` pinned `notebooklm artifact poll <taskId>` (lies `in_progress` post-render → S135 cap-stall)
- `:577` bare `notebooklm download <type> <path>` (NLM default-latest → S31 wrong-artifact)

## Classification (MRPF)
- **Event Gate:** MERGE.
- **Risk Labels:** AGENT BEHAVIOR (worker-spawned script that auto-produces deliverables for future
  jobs).
- **Severity:** NORMAL.
- **Topology:** Sequential. **Operating under reduced cross-vendor review** — Codex was
  quota-exhausted (ChatGPT auth; resets ~9:43 PM 6/17). Per the MRPF required-reviewer-unavailable
  fallback hierarchy, ran BOTH opposite-correlation substitutes: **Gemini holistic-adversarial**
  (vendor-independent of author) → integrate → **Claude grounded-adversarial subagent** (zero
  authoring context, prompted to REFUTE, ran counterexamples against the shipped modules;
  vendor-independent of reviewer-1). **Codex's real grounded pass is a MANDATORY <24h follow-up**
  (owed; not satisfied by the substitutes).

## What each reviewer saw
- **Gemini 2.5-pro** (the 3.x previews were capacity-429'd): a self-contained packet — task +
  architectural constraints (studio_only bypasses S136 Layer-2 → fail-closed adaptation) + the
  reused seams (`realListArtifacts`/`realDownloadArtifact`) + the **full diff** (old→new). Holistic
  whole-artifact read.
- **Claude grounded subagent:** the **integrated v2 in the tree** plus the real files it read itself
  — `regenerate-studio-products.ts` (full), `studio-completeness.ts` (full, both seams),
  `executor.ts` (`runStudioOnly`/`waitForProcess`/`watchStateFile`), `conventions.ts`, and the
  frontend consumers (`useRunState.ts`, `VendorTabs.tsx`). Grounded file:line counterexamples.

## Findings & adjudication

### Gemini — verdict BLOCK (1 MAJOR + 2 MINOR)
1. **MAJOR — wrong-artifact (S31) under chained failure.** When the pre-gen snapshot fails 3× (empty
   before-set) AND a stale artifact has a null/unparseable `created_at`, `freshCompleted` admitted it
   (the `created_at == null` path skipped the floor check) → unproven artifact downloadable.
   **ACCEPTED & FIXED.** Added per-product snapshot-reliability tracking (`snapshotOk`). In the
   DEGRADED branch, freshness must now be PROVEN by a parseable `created_at >= floor`; an
   absent/unparseable date is REJECTED (fail-closed). Reliable-snapshot behavior unchanged
   ("not in before-set" already proves newness). Covered by 2 new unit tests.
2. **MINOR — rename `task_id` → `artifact_id` in the persisted state.** **REJECTED (cross-file
   context).** `task_id` is the *shipped* key: the full-pipeline Layer-1 persists
   `state.artifacts[p] = {task_id: poll_id}`, and the reader `expectedArtifactId()`
   (studio-completeness.ts:211-221) consults `task_id` FIRST (then `id`) — **not** `artifact_id`.
   Renaming would make a future studio_only completeness gate fail to find the id. The grounded
   subagent independently confirmed `task_id` is the correct key.
3. **MINOR — bump the 5s skew buffer to 60s.** **REJECTED (misframed mechanism).** Studio generation
   takes minutes, so a real artifact's `created_at` sits minutes above the floor regardless of
   sub-minute clock skew — 5s causes no false-failures (generation latency dominates). A larger
   buffer would slightly *widen* S31 exposure in the degraded path, against the fail-closed goal. The
   shipped full-pipeline reference uses the same 5s. (Logged as INFO-1 below for future debugging.)

### Claude grounded subagent — verdict ENDORSE (1 MINOR + 2 INFO)
- Attacked every false-SUCCESS vector (reused notebook, >1-new ambiguity, degraded snapshot, null
  created_at, concurrent runs) and found **no wrong-artifact path**. Confirmed the Gemini MAJOR fix
  is correct, the `task_id` key matches `expectedArtifactId`, `resolvedArtifacts` serializes
  correctly each `writeState`, `watchStateFile` tolerates the new fields, and the per-product
  timeout (≈45min) fires well under the 90-min cap so the missing Layer-2 never truncates a healthy
  run.
- **MINOR — gallery "Artifacts Completed" would show 0/N.** `VendorTabs.tsx:99-101` counts
  `state.artifacts` entries with `status === "completed"`; the persisted `{task_id}` lacked `status`.
  Not a crash, not a regression (the old script emitted no `artifacts` at all), but a missed
  opportunity now that we populate `artifacts`. **ACCEPTED & FIXED.** On successful UPLOAD the entry
  is upgraded to `{task_id, status:"completed", version:1}` (matching the `ArtifactState` shape in
  `useRunState.ts:7-13`); a resolved-but-not-yet-uploaded product keeps `{task_id}` only (correctly
  not counted).
- **INFO-1 — clock-domain note.** `runFloorMs` is the local worker clock; `created_at` is the
  NLM-server clock. The 5s buffer tolerates the snapshot-read latency only; if studio_only runs ever
  start false-failing, host-vs-server clock skew is the first suspect. Recorded, no code change (see
  Gemini MINOR-3 adjudication).
- **INFO-2 — `notebook_id` emitted as `string | undefined` vs the frontend's declared
  `string | null`.** `JSON.stringify` omits the key when falsy; the frontend never dereferences it
  for studio_only. Harmless; no action.

## Post-review strengthening (behavior-preserving)
After the grounded ENDORSE, the load-bearing resolution logic (`createdAtMs` + `freshCompleted`) was
**extracted verbatim** into `agent/lib/studio-snapshot-diff.ts` so it is importable and unit-testable
(the script self-executes `main()` at import, so the inline version could not be tested directly).
This is a pure move — identical logic — plus the Gemini MAJOR fix. The extraction is what makes the
test-coverage answer below "yes." Codex's <24h follow-up should verify extraction fidelity.

## Automated-test coverage (MRPF requires this answer for AGENT BEHAVIOR)
**Yes, now covered.** New `agent/test/studio-snapshot-diff.test.ts` — **11 cases** exercising exactly
the reviewer-reasoned edges: reliable vs degraded snapshot × null / parseable / stale `created_at` ×
ambiguity (>1 new) × empty-id × the `>= floor` boundary, including a dedicated test for the Gemini
MAJOR fix (degraded + null date → rejected). The reused seams
(`realListArtifacts`/`realDownloadArtifact`) already carry 15 tests via
`studio-completeness.test.ts`. The script's I/O orchestration (spawn/upload) remains integration-only
(no dedicated harness), which is acceptable: the decision logic is the risk surface and it is now
pure + tested.

## Mechanical verification (final v3)
- `tsc --noEmit` (agent) — clean.
- `test-phase-b-storage-paths.sh` grep guard — PASS.
- Full agent suite — **432/432** (was 421; +11 new).

## Verdict
**CLEAR TO MERGE under reduced cross-vendor review.** Both substitute lenses are satisfied (Gemini
BLOCK fully integrated; Claude grounded ENDORSE + its MINOR fixed). No SECURITY/DATA finding; no
unresolved CRITICAL/MAJOR. **OWED: Codex grounded-adversarial pass within 24h** (quota resets
~9:43 PM 6/17) to restore full three-lineage coverage — verify the snapshot-diff fail-closed logic +
the lib extraction fidelity.

## Files
- `agent/scripts/regenerate-studio-products.ts` (rewritten poll loop + download-by-id + state persist)
- `agent/lib/studio-snapshot-diff.ts` (new — pure resolution logic)
- `agent/test/studio-snapshot-diff.test.ts` (new — 11 tests)
- Raw Gemini log: `c:/tmp/s141-gemini.log`. Packet: `c:/tmp/s141-gate-final.md`.
