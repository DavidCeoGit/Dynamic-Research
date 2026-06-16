# MERGE-gate peer review — S129 worker studio-completeness gate

**Change:** Fail-closed worker gate that guarantees every SELECTED NotebookLM
studio product reaches the gallery (or the job fails loudly) — closes the
recurring "video completed in the notebook but never reached the gallery" bug.

**Date:** 2026-06-15 (S129). **Severity mode:** NORMAL.
**Event gate:** MERGE. **Risk labels:** AGENT BEHAVIOR (changes worker
job-completion semantics for all future jobs), INFRA (worker daemon behavior).
**Topology:** sequential Gemini → integrate → Codex → integrate → Codex QA.

## Files

- `agent/lib/studio-completeness.ts` (NEW) — the gate + recovery + injectable deps.
- `agent/test/studio-completeness.test.ts` (NEW) — 15 unit tests.
- `agent/executor.ts` — calls the gate between the publish-gate and uploadOutputs
  on the exit-0 success path; `!ok` → failJob + notifyTerminal("failed") + throw.
- `~/.claude/commands/research-compare.md` (config, not in repo) — in-pipeline
  poll loop switched from the lying `artifact poll` to reliable `artifact list
  --type` (status_id==3) + download-by-id; TIMEOUT moved after detection.

## Root cause (live-verified)

1. The pipeline detected video completion via `notebooklm artifact poll
   <task_id>`, which returns `in_progress` even AFTER the video is fully
   rendered. Reliable signal: `artifact list --type video --json` → status_id==3.
   (Same task_id, simultaneously: poll=in_progress, list=completed.)
2. The pipeline then FAILED OPEN (wrote phase=7/complete with the video still
   in_progress); the worker uploaded only on-disk files → video silently dropped.
   publish-gate checks claims not artifacts; the Phase 6.5 verify gate compares
   notebook-COMPLETED-artifacts vs disk, so a not-yet-completed product is EMPTY
   on both sides → skipped.

## What each reviewer saw

- **Gemini (gemini-3.1-pro-preview), holistic-adversarial:** the full change
  bundle (new module + executor integration diff + slash-command poll loop),
  embedded in the prompt. No repo file access.
- **Codex (gpt-5.x codex via codex-cli 0.130.0, ChatGPT auth), grounded-
  adversarial:** read the actual repo files in a workspace-write sandbox; ran
  live Node reproductions of the timestamp/floor/budget logic.
- **Codex QA:** re-read the integrated v3 files; fidelity-verified each prior
  finding + ran a fake-clock probe of the budget-loop boundary.

## Findings & resolutions

### Gemini
1. **CRITICAL — wrong-artifact recovery in a reused notebook.** `arts[0]`
   (newest completed) could be a parent's OLD video while this run's is still
   rendering → re-introduces the S31 default-latest bug. **Resolved:** recovery
   now requires an exact persisted task_id when present, else `created_at >=
   run-start`; never picks an unrelated newest-completed.
2. **MAJOR — worker starvation.** Synchronous up-to-30-min block on the single
   worker. **Resolved (mitigated + documented):** default budget cut to 15 min;
   dominant case recovers on the first list() (~0 wait); starvation + the
   non-blocking async-recovery alternative documented in executor.ts.
3. **MINOR — coverage-gap doc.** Gate runs only on the exit-0 path; a 90-min-
   capped job fails before it. **Resolved:** documented explicitly in executor.ts.
4. **MINOR — synthesized-timestamp linkage risk.** **Resolved:** folded into the
   Codex CRITICAL-2 fix (never use a synthesized "now" as the floor).

### Codex (grounded, with reproductions)
1. **CRITICAL — 5-min skew re-admitted pre-run artifacts** (reproduced: a video
   created 92s before run-start was recovered). **Resolved:** removed the
   negative skew; floor is strict `created_at >= runStartMs`. Test:
   "STRICT floor … 92s BEFORE start is rejected".
2. **CRITICAL — resolveTimestamp missed the shipped `YYYY-MM-DDTHH-mm-ss` form**
   and synthesized "now" → floor excluded the real artifact (reproduced).
   **Resolved:** `parseTimestamp` accepts compact / colon-ISO / hyphen-ISO;
   `buildCompact` round-trip-validates impossible dates; `deriveRunStart` returns
   null (→ best-effort, never synth-as-floor) when nothing is derivable. Test:
   "hyphen-ISO state.timestamp … parses → floor works".
3. **MAJOR — gate trusted pipeline-written state.selectedProducts.** A
   drift-prone pipeline could omit a product and pass the gate open. **Resolved:**
   obligations now come from the DURABLE `job.selected_products` (executor passes
   it as the first arg). Test: "DURABLE selection drives obligations even if state
   disagrees".
4. **MAJOR — budget loop not NaN-safe; overshoot.** **Resolved:** `safeMs` +
   executor `envMs` sanitize NaN/negative; loop checks remaining and sleeps
   `min(poll, remaining)`; **Codex QA found one residual** — a single list could
   fire AT the deadline. **Resolved in r4:** top-of-loop guard skips a new list
   once `now() >= deadline` (after the guaranteed first attempt). Test: "no
   artifact-list call fires at or after the deadline" (mirrors Codex's repro:
   calls `[0,60]`, none ≥ 100).

## Residual / accepted

- The 90-min-cap coverage boundary (Gemini MINOR-3) is documented, not closed in
  code: a job that BLOCKS to the cap fails before the gate. The in-pipeline poll
  fix makes hitting the cap on a slow video far less likely; manual
  `finalize-recovered-run.ts` remains the recourse. Acceptable for this PR.
- Worker starvation is mitigated (15-min default, instant common case) +
  documented; the non-blocking DB-`recovering` architecture is a future option.

## Validation

- `tsc --noEmit` clean (agent + frontend).
- `pnpm test` green: 414 agent + 74 frontend; storage-path grep guard pass.
- New suite: 15 tests, all passing, covering every finding above.

## Verdict

Gemini: BLOCK → all findings integrated. Codex: BLOCK → 3/4 RESOLVED + 1 PARTIAL
on first QA; the PARTIAL (boundary list) closed in r4 with a direct test mirroring
Codex's reproduction. Net: **APPROVE for merge** — fail-closed, deterministic,
tested; the worker no longer reports success while a selected product is missing.
