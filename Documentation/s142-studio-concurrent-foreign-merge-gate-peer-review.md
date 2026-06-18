# S142 — studio_only concurrent-foreign exact-1 fix — MERGE-gate peer review

**Date:** 2026-06-17 (DR S142)
**Change:** Fix the Codex S141 CRITICAL — a concurrent/foreign NotebookLM artifact on a
SHARED parent notebook being resolved as this run's product in the `studio_only` regen path.
**Branch:** `fix/s142-studio-concurrent-foreign-exact1` (PR to `main`).
**Files:** `agent/lib/studio-snapshot-diff.ts`, `agent/scripts/regenerate-studio-products.ts`,
`agent/test/studio-snapshot-diff.test.ts`. (`agent/lib/studio-completeness.ts` was touched in
v1–v2 then reverted to `main` in v3 — net unchanged.)

## MRPF classification
- **Event Gate:** MERGE (agent/ code adopted to the production worker).
- **Risk Labels:** DATA (wrong-artifact = wrong deliverable uploaded under a run's slug) +
  the project §11 **agent/-prod rule** (full Gemini+Codex+Claude gate must CLEAR *before*
  merge — no substitute-and-proceed; this rule was born from S141 itself).
- **Severity:** NORMAL (no active exposure: studio_only only triggers concurrent same-parent
  generation; the deployed S141 code is a net improvement over pre-S141).
- **Topology:** sequential Gemini → integrate → Codex, run on each revision (both lenses
  adversarial). Three rounds, because Codex's grounded findings drove two redesigns.

## The bug (Codex S141 grounded CRITICAL)
S141 resolved each product's artifact by SNAPSHOT-DIFF: the new COMPLETED artifact of a type
since a pre-gen snapshot, created_at-floor-filtered. studio_only runs against a SHARED parent
notebook, so a FOREIGN generation of the same type completing while ours renders is the only
"new" completed id → resolved as ours, downloaded by the wrong id, uploaded, run reported
complete. `>1 new` fail-closed; `exactly-1-but-foreign` did not.

## Gate evolution (3 rounds)
| Rev | Approach | Gemini | Codex |
|---|---|---|---|
| v1 `dc76db1` | C+ : ALL-STATUS snapshot (exclude foreign already in-flight at snapshot) + fully fail-closed degraded path | ENDORSE | **BLOCK** — residual: a foreign generation that STARTS *after* the snapshot is still exactly-1; noted submit `task_id` == `Artifact.id` |
| v2 `07f922d` | id-PRIMARY match + snapshot-diff kept as fallback for unparsed ids | ENDORSE | **BLOCK** — the unparsed-id FALLBACK still accepted a foreign exactly-1; grounded-verified `task_id == Artifact.id` for ALL types; confirmed the primary path closes the original CRITICAL |
| v3 `5ff5765` (final) | id-match is the SOLE resolver; snapshot apparatus REMOVED; unparsed id FAILS CLOSED at launch | **ENDORSE** | **ENDORSE** — CRITICAL/MAJOR/MINOR: none |

## Final design (v3)
`resolveBySubmitId(arts, submitTaskId)` returns the COMPLETED artifact whose `id` ===
our `generate --json` submit task_id, else null. Because that id is unique per generation, a
concurrent/foreign artifact can never match → immune to the entire concurrent-foreign class
(both the in-flight-at-snapshot and starts-after-snapshot cases). A generate that yields no
parseable task_id FAILS CLOSED at launch (never a snapshot-diff guess). The S141 snapshot-diff
apparatus (`freshCompleted`, `createdAtMs`, the all-status pre-gen snapshot,
`realListAllArtifactIds`/`rawListArtifacts`) was removed; `studio-completeness.ts` reverted to
`main`.

## Load-bearing premise — empirically + source verified
`generate <type> --json` task_id IS the eventual `artifact list` id for EVERY product type:
- **Empirical:** a live run's `submit-{audio,video,slides,report,infographic}.json` task_ids
  vs the artifact-list ids — 4/5 matched directly; report's apparent mismatch was a v1→v2
  REGENERATION (v1 rejected for fabricated EBITDA), and the full-pipeline `poll_loop_v3.py`
  resolves report v2 by exact `id == task_id`.
- **Source (notebooklm CLI, both reviewers + author):** all types route through
  `_call_generate`; `_parse_generation_result` returns `task_id = result[0][0]`;
  `Artifact.from_api_response` sets `id = data[0]`. The S129/S135 "lying poll" was the
  `artifact poll` ENDPOINT returning stale `in_progress` — it never meant the id differed.

This corrects long-standing project memory that framed the submit id as an "alias" that
differs from the list id (see [[feedback_studio_only_regen_poll_drift_followup]] /
[[feedback_nlm_download_default_latest]] — to be amended).

## Automated-test coverage (MRPF requires this answer)
**Yes.** `agent/test/studio-snapshot-diff.test.ts` — 7 cases on the resolver: exact match,
the concurrent-foreign no-match (the S141 CRITICAL counterexample), not-yet-completed → null,
unparsed/empty/null → null (fail-closed), strict-equality-no-prefix, and exact pick among
many. Codex ran v1's and v2's CRITICAL counterexamples through v3 and confirmed both closed.
Full agent suite **428/428**, `tsc --noEmit` clean, storage-path grep guard PASS.

## Verdict
**CLEAR TO MERGE.** Full tri-vendor gate cleared BEFORE merge per §11: Claude (author) +
Gemini ENDORSE + Codex ENDORSE on v3, sequential, both lenses adversarial. No
SECURITY/DATA/CRITICAL/MAJOR/MINOR open. One non-blocking INFO (a stale S141 header comment)
was tidied post-ENDORSE (comment-only; re-verified tsc + tests unchanged).

## Raw logs
Gemini: `c:/tmp/s142-gemini.log` (v1), `s142-gemini-v2.log`, `s142-gemini-v3.log`.
Codex: `c:/tmp/s142-codex.log` (v1), `s142-codex-v2.log`, `s142-codex-v3.log`.
Packets: `s142-gate-packet.md` (rewritten per round). Premise evidence: live workdir
`C:/tmp/research-compare/-authoritative-ground-truth-use-these-ex-d99f3fde/submit-*.json`.

## Meta-lesson (MRPF validation)
The cross-vendor gate earned its keep three times: Codex's grounded source-reading supplied
the key fact (`task_id == Artifact.id`) that turned a *narrowing* (C+) into a *deterministic
close* (id-only), and each round its counterexample exposed the next residual that the
holistic lens had endorsed. This is the §11 rule (real Codex pass owed BEFORE merge, not
substitutable) paying off on the very change born from violating it at S141.
