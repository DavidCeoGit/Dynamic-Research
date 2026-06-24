# S137/S138 MERGE-Gate Peer Review — Layer 1 (snapshot-diff studio poll) + read-scoping reconcile

**Gate:** MERGE. **Risk Labels:** AGENT BEHAVIOR (slash-prompt behavior propagates to every future worker session) + ARCHITECTURE (poll/recovery contract spanning skill ↔ worker). No SECURITY/DATA/PRIVACY. **Severity:** NORMAL. **Topology:** sequential Gemini → integrate → Codex (per MRPF).
**Author:** Claude (DR S138, 2026-06-17). **Design source:** `Documentation/s136-studio-poll-source-import-design-gate.md` v3.

## Scope of this gate
Two `~/.claude/commands/research-compare.md` changes, batched (both AGENT BEHAVIOR, one file):
1. **Layer 1 — snapshot-diff studio-artifact poll** (`c:/tmp/s138-layer1-staged-patch-v2.md`). Fixes the S135 run-3 90-min cap-fail: the submit-returned `task_id` was an ALIAS of the id `artifact list --type <T>` surfaces, so `task_id in completed_ids` never matched.
2. **Read-scoping reconcile** (`c:/tmp/s137-reconcile-readscoping-patch.md` + v2 abort fix). `import_and_dedup.py` READ `research status`/`source list` unscoped (ambient notebook) while WRITING to a hardcoded `notebook_id` → reads-A-writes-B = net-zero import (the source-import gap; mechanism proven sound S137, 3→32 sources).

## What each reviewer saw
- **Gemini (gemini-3.1-pro-preview), holistic-adversarial, round 1:** the full self-contained packet inline (design doc v3 + current live poll block + current import reads + both v1 patches). No repo/tool access (no-tools, stdin-pipe — S134 sub-mode). Verdict on v1.
- **Codex (gpt-5.3-codex via API-key auth flip — see note), grounded-adversarial, round 2 on the Gemini-integrated v2:** the inline v2 patch + LIVE read of the shipped repo (`agent/executor.ts`, `agent/lib/studio-completeness.ts`, `agent/scripts/regenerate-studio-products.ts`, `find-state-file.ts`) via `-s workspace-write`. Verdict on v2.
- **Codex auth note:** the ChatGPT-OAuth quota was exhausted mid-gate (failure mode #6 — "You've hit your usage limit … try again at Jun 17 9:43 PM", zero analysis). Per MRPF §1a the Codex CLI was flipped to OpenAI API-key auth (`codex-use-apikey.sh`) to keep the REAL Codex lineage live (strictly better than substitutes), ran on **gpt-5.3-codex** (the codex-class ceiling — a subtly different reviewer than the ChatGPT-default gpt-5.5), then flipped back to ChatGPT auth (verified "Logged in using ChatGPT"). Recorded per guardrail (c).

## Round 1 — Gemini holistic-adversarial: VERDICT BLOCK (2 CRITICAL + 2 MAJOR) — ALL INTEGRATED into v2
- **[CRITICAL-1] Decision-A (`exit 1`) defeats Layer-2 recovery.** Failing fast on alias-capture failure kills `claude` before the 90-min DURATION cap, so the worker's `shouldRecoverAfterDurationKill` never engages → a recoverable stall becomes a guaranteed hard failure. **Integrated:** unresolvable products are now LEFT UNRESOLVED → the loop rides to the DURATION cap → Layer-2 recovers via its `created_at` floor. The loop NEVER `exit 1`s on a studio detection failure; only `AUTH_EXPIRED` exits early (3). (The poll loop is `sleep`+cheap CLI — no LLM tokens — so "ride to cap" is wall-clock-bound, cheap.)
- **[CRITICAL-2] Omitted `created_at` sanity floor.** v3 mandated it; v1 dropped it. **Integrated:** snapshot records `run_floor_ms` (captured BEFORE the generates, 5s skew buffer); capture discards any candidate whose `created_at < run_floor_ms`.
- **[MAJOR-3] Snapshot `None` dooms product on a transient flake.** **Integrated:** snapshot retries 3×; definitive failure → empty set (not None) → degrades safely to created_at-floor guard, never a hard fail.
- **[MAJOR-4] Read-scoping `return` exits 0 (silent success).** `return` from async `main()` → process exits 0 → pipeline proceeds with no import = the exact bug. **Integrated:** changed to `raise SystemExit(1)` (halts the pipeline).

## Round 2 — Codex grounded-adversarial on v2: VERDICT BLOCK (1 CRITICAL + 2 MAJOR)
**Validated (non-blocking) — all 4 open-item checks PASS against shipped code:**
1. Layer-2 reachability correct: `waitForProcess` sets `killReason="DURATION"`; `shouldRecoverAfterDurationKill` requires `DURATION && !terminal && hasNotebookId` (`executor.ts:1645,1601,690`).
2. Recovery WITHOUT a persisted id is load-bearing + implemented via the run-floor filter when `expectedArtifactId` is null (`studio-completeness.ts:211,327`).
3. `SystemExit(1)` through `asyncio.run(main())` exits non-zero; worker treats non-zero child exit as failure on both full + studio-only paths (`executor.ts:663,1120`).
4. Full-pipeline false-success window closed by `enforceStudioCompleteness` before upload/complete (`executor.ts:790,819,872`).

**Findings (drive the BLOCK) + disposition:**
- **[CRITICAL-1] studio_only / Re-generate Studio path is NOT covered.** Confirmed real: `regenerate-studio-products.ts:507` polls a pinned `artifact poll taskId` (the S135 stall bug) and `:577` downloads bare `download <type>` WITHOUT `-a <id>` (the S31 wrong-artifact bug). **Disposition: OUT OF SCOPE for this gate, tracked as a high-priority follow-up.** This gate's scope was the two slash-prompt changes (full-pipeline path). `regenerate-studio-products.ts` is separate `agent/` TS, a separate deploy path (DR-Deploy pull + worker restart), and is NOT on the critical path for the full-pipeline Aero deliverable run. The slash-prompt changes do not touch or worsen it. **A separate agent/ MERGE gate must port snapshot-diff + by-id download + persisted poll-id into the studio_only path.**
- **[MAJOR-2] Cost cap can preempt Layer-2 DURATION recovery.** Estimator is token-based (confirmed). **Disposition: non-issue at the current default `MAX_JOB_COST_CENTS=$15`** — a stalled poll loop adds ~0 tokens and typical full-run spend is ~$1–2 ≪ $15, so the DURATION cap binds first. Documented; monitor if run cost ever approaches the cap.
- **[MAJOR-3] research-compare.md / import_and_dedup.py not repo-enforced.** The slash prompt lives outside the repo (no compile/test signal → drift risk; the known "Layer-3 gap"). **Disposition: known architectural limitation, tracked.** Long-term remedy = move safety-critical checks into repo-owned code; large refactor, out of scope.

## Gate outcome — APPLY the two slash-prompt changes; open one follow-up
**Zero outstanding findings against the v2 slash-prompt code itself** — Gemini's 4 were integrated; Codex's 4 grounded checks on the patch logic all passed. Codex's BLOCK is driven by adjacent/out-of-scope items (studio_only worker code, a config value, an architectural property), none of which are defects in or regressions from the reviewed change. Per the MRPF disagreement procedure (non-SECURITY), the synthesis records both positions: **the slash-prompt Layer 1 + read-scoping changes are CLEAR TO APPLY**, and **Codex CRITICAL-1 (studio_only poll-drift + wrong-artifact) becomes a mandatory tracked follow-up** (separate agent/ MERGE gate).

**Mandatory follow-up (new):** port Layer 1's snapshot-diff + `-a <id>` download + persisted poll-id into `agent/scripts/regenerate-studio-products.ts` (studio_only / Re-generate Studio path), gated as an agent/ MERGE change (DR-Deploy pull + worker restart). Until then, the Re-generate Studio path retains the S135 stall + S31 wrong-artifact risk.

## Raw reviewer outputs
- Gemini: `c:/tmp/s138-gemini-out.txt`
- Codex (gpt-5.3-codex): `c:/tmp/s138-codex-out.log`
- Packets: `c:/tmp/s138-gate-packet.md` (Gemini), `c:/tmp/s138-codex-prompt.md` (Codex)
- Patches: `c:/tmp/s138-layer1-staged-patch-v2.md`, `c:/tmp/s137-reconcile-readscoping-patch.md`
