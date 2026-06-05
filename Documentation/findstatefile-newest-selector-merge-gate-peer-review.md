# MERGE-gate peer review — findStateFile newest-selector (S87)

**Date:** 2026-06-04 · **Classification:** MERGE × AGENT BEHAVIOR × NORMAL · **Topology:** sequential Gemini → integrate → Codex (per `~/CLAUDE.md` MRPF).

## What changed
A completed research job (e18e1931) was marked `failed` because `findStateFile()` returned the FIRST `*-state.json` in readdir/list order. Workdirs are reused across re-queues of the same `topic_slug`, so a stale phase-0 `20260602-185318-state.json` shadowed the completed phase-6 `20260603-215929-state.json`; the worker read phase 0 and false-failed before upload. The same first-match pattern existed at 4 sites (executor S83; mirrored to frontend/regenerate/lint S84).

Fix: a single shared primitive `agent/lib/find-state-file.ts` (`isStateFileName`, `embeddedStateTimestampMs`, `selectNewestStateFile`, fs `findStateFile`) + a pure frontend mirror `frontend/lib/find-state-file.ts`. Recency = the run timestamp embedded in the filename; fs mtime / storage `created_at` is a fallback only for plain/slug-named files. Wired into `executor.ts` (local), `regenerate-studio-products.ts` (storage parent lookup), `lint-deliverables.ts` (predicate; lints all), `frontend/lib/storage.ts` (gallery). New test `agent/test/find-state-file.test.ts` (18 cases).

## What each reviewer saw
- **Gemini** (gemini-3.1-pro-preview, holistic): inline artifact — incident, diff of the 3 wirings, the helper, the test, the scope-deferral question.
- **Codex** (`codex exec -s read-only -C <root>`, code-grounded): the LIVE integrated repo files (helper, mirror, 3 wirings, storage.ts, test).

## Findings & resolution
| # | Reviewer | Sev | Finding | Resolution |
|---|---|---|---|---|
| G1 | Gemini | CRITICAL | Deferring the frontend finder regresses the UI (completed reused-workdir runs render as Failed/stale). | **Fixed** — frontend mirror + `storage.ts` finder included in this merge. |
| G2 | Gemini | CRITICAL | Storage selector used `created_at` (upload-completion order), not the filename's logical time. | **Fixed** — embedded filename timestamp is primary; `created_at`/mtime are fallback only. |
| G3 | Gemini | MAJOR | `name >` tiebreak favored plain `state.json` over a fresh timestamped file. | **Fixed** — superseded by clock-bucketing (C-MAJ). |
| C1 | Codex | **CRITICAL (DEFERRED)** | `uploadOutputs` uploads the raw reused workDir with `upsert:false` → re-queue-after-successful-upload fails at upload; stale files leak into the gallery file list. | **Deferred to MERGE-B (upload hygiene).** See risk-acceptance below. |
| C2 | Codex | MAJOR | Cross-clock comparison (UTC-parsed local embedded vs real-epoch fallback) can mis-order same-day mixed sets. | **Fixed** — `selectNewestStateFile` buckets by name shape: if any candidate is timestamped, rank only those by embedded time; fallback used only when none are timestamped. No cross-clock compare. |
| C3 | Codex | MINOR | Timestamp regex not start-anchored; `Date.UTC` normalizes invalid dates. | **Fixed** — anchored `^…$` + round-trip calendar validation. |
| C4 | Codex | NIT | Comments drifted ("by mtime" / "by upload time"). | **Fixed** — comments updated to embedded-primary. |

Codex also verified: `regenerate` uses only `stateObj!.name` (no FileObject field reads); all 3 executor call sites typecheck; `fs`/`path` still used (no dead import); frontend mirror behavior matches the agent module.

## Is this change covered by tests?
Yes for the selector: 18 cases — `isStateFileName`, `embeddedStateTimestampMs` (anchor + invalid-calendar rejection), `selectNewestStateFile` (all-timestamped / all-plain / mixed-bucketing / ties), and fs `findStateFile` (incident reproduction with inverted mtimes, mixed-set, three-timestamped). `pnpm test` (tsc agent + frontend + storage-path grep) GREEN; executor-spawn-env 12/12 no regression. Gap (accepted): no automated cross-package parity test for the frontend mirror (kept in sync by convention, as with storage-paths.ts).

## Deferred: C1 (upload hygiene) — risk-acceptance
`uploadOutputs` uploading the raw reused workDir is a distinct change to the *uploader*, not the finder. It does not regress normal operation (fresh jobs use a fresh slug → empty scoped path → no conflict); only re-queues of already-fully-uploaded slugs hit the `upsert:false` conflict, and reused-workdir completions leak stale siblings into the gallery file list. The finder fix resolves the actual incident and is a strict improvement. C1 will be its own MERGE-B (upload only the current run's files; resolve upsert semantics) with its own Gemini→Codex review.

`RISK-ACCEPTED-BY: David | mode=NORMAL-deferral | reason=B2/C1 upload hygiene is a separable uploader change; finder fix solves the incident with no normal-op regression | followup=MERGE-B own review`
