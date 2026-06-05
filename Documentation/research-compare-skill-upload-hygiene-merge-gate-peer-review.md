# MERGE-gate peer review — /research-compare skill upload hygiene (S89)

**Date:** 2026-06-04
**Gate:** MERGE × AGENT BEHAVIOR × NORMAL
**Topology:** Sequential Gemini → integrate → Codex (per ~/CLAUDE.md Review Topology table, MERGE / fresh code)
**Outcome:** Gemini **APPROVE** (integrated) → Codex **APPROVE, 0 findings**. Shipped.

## The change

S88 (commit 729ba51) made the worker's `uploadOutputs` (`agent/executor.ts`) the **sole authoritative upload** — it sources the complete `Projects/<slug>/` set and writes to the SCOPED storage path `<org_id>/<slug>/` that the gallery (`frontend/lib/files.ts`) reads.

The `/research-compare` skill's Phase-6 **Step C.6** still uploaded the same deliverables to the **legacy flat path** `research-projects/<slug>/` — wasted (nothing reads it) and un-fixable to scoped (the skill has no `orgId`; only the worker injects org scoping via `scopedStoragePath`).

**Discovered coupling:** Step **C.7** (`verify-gallery-vs-notebook.ts`, the S32 NLM-wrong-artifact gate) verified that same flat path. C.7 runs *inside* `claude -p`, *before* the worker's `uploadOutputs`, so the scoped path is empty at C.7 time — C.7 could not simply be repointed at scoped storage. Its comparison is purely filename-based and the local `Projects/<slug>/` files carry identical title-slug-prefixed names.

**Decision (user-confirmed, Option A):** Drop C.6; relocate C.7 to verify the **local `Projects/<slug>/` dir** via a new `--local-dir` mode. Kills the waste, preserves the wrong-artifact gate, makes `uploadOutputs` authoritative. ("Repoint the skill's upload to scoped" was ruled out architecturally — no orgId in skill context.)

### Files changed
- **NEW** `agent/lib/studio-winner.ts` — pure `pickWinners()` + `VERSIONED_STUDIO` regex + `GalleryWinner` (extracted for unit-testability; mirrors S88's `upload-set.ts` pattern).
- **MODIFIED** `agent/scripts/verify-gallery-vs-notebook.ts` — `--local-dir <path>` mode (fs.readdir → `listLocal`); `--slug` storage mode retained for back-compat; Supabase creds required only in `--slug` mode; imports `studio-winner`; redundant log fixed.
- **NEW** `agent/test/studio-winner.test.ts` — 8 tests (version selection, variant tiebreak, non-studio filtering, empty).
- **MODIFIED** skill `~/.claude/commands/research-compare.md` — C.6 removed (replaced with a do-not-re-add note); C.7 repointed to `--local-dir "../Projects/TOPIC_SLUG"` + reworded header/failure echoes; C.5 wording de-coupled from "Supabase upload"; Step D summary line; error-table rows collapsed.

## What each reviewer saw
- **Gemini** (`gemini-3-flash-preview`): the full review bundle (context + proposed skill diffs) + the full proposed verify script + the current live skill Phase-6 region (lines 958–1092, 1146–1149) — single self-contained 30KB input, no grep needed.
- **Codex** (`gpt-5.5`, `codex exec -s read-only`, xhigh): the live integrated files on disk (`studio-winner.ts`, the modified verify script, the test) + the skill diffs from the bundle (skill lives outside the repo).

## Gemini — APPROVE
1. **MINOR** — `pickWinners` lacked unit tests. → **Integrated:** extracted to pure `agent/lib/studio-winner.ts` + added 8 tests.
2. **NIT** — redundant log (`countTotal` returned key-count = type-count, so "N file(s) across N type(s)" was always-equal). → **Integrated:** reworded to "N studio winner(s) (newest per product type)", removed dead `countTotal`.
3. **NIT** — hardcoded `NLM_BIN` path. → **Not actioned:** pre-existing established Windows pattern, mitigated by `NOTEBOOKLM_BIN` env override; out of scope.

Gemini's answers to the bundle's 3 questions: drop C.6 entirely (markdown note > bash no-op); local-dir verification is *superior* to storage (the S31/S32 bug was a stale download into local `Projects/` — verifying local gives a tighter pre-ship feedback loop); unit test recommended-not-blocker.

## Codex — APPROVE, 0 findings
Verified all six grounded points: `--local-dir`/`--slug` mutual exclusivity; Supabase creds scoped to `--slug` mode only; `listLocal()` correctly filters `readdirSync(..., {withFileTypes:true})` to files before `pickWinners()`; `--slug` back-compat still flows through `listGallery()`; the `../Projects/TOPIC_SLUG` path is correct after `cd "Dynamic Research/agent"` (matches the C.5 lint-gate convention); the skill diff removes C.6 cleanly and leaves no stale upload/env/error-table/summary references. Behavior change (no skill upload; local pre-upload verification; worker-owned scoped upload) is intentional.

## Verification (pre-commit, all GREEN)
- `tsc --noEmit` (agent) clean; root `pnpm test` (grep guard + agent tsc + frontend tsc) PASS.
- New `studio-winner.test.ts` 8/8; full agent suite **248/248**.
- Arg-guards smoke-tested: neither-mode / both-modes / no-notebook all exit 2 with correct messages.

## SECURITY / AGENT-BEHAVIOR self-answer
- **Tests?** Yes — the refactored pure core (`pickWinners`) is now unit-tested; the `--local-dir` IO path is exercised live every run via C.7 `--strict`.
- **New hostile-input surface?** None — `--local-dir` reads a path the skill already controls (`Projects/TOPIC_SLUG`). Skill no longer reads Supabase creds → *smaller* secret-exposure surface.
- **Propagation:** intended; alters every future `/research-compare` Phase-6 run (stops uploading, verifies locally).

## Operator note (CodeX CLI footgun, S89)
`codex exec -s read-only "<prompt>"` blocked ~18 min on `Reading additional input from stdin...` when run without a TTY. Fix: redirect `< /dev/null` and write output directly to a file (not through `| tail`, which buffers until EOF and hides interim progress). → captured in [[feedback_codex_exec_blocks_on_stdin_without_devnull]].
