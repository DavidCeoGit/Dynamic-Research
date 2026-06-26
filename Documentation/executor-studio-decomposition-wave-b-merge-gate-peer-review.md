# executor decomposition — Wave B MERGE gate — peer-review synthesis

> **Event Gate:** MERGE (agent/ PROD — the live worker hot-path `worker.ts → executeJob`).
> **Risk Labels:** ARCHITECTURE (cross-module boundaries) + AGENT BEHAVIOR (the worker hot-path; a
> regression silently propagates to every research job).
> **Severity Mode:** NORMAL.
> **Topology (per `~/CLAUDE.md` §11):** sequential tri-vendor — Gemini holistic-adversarial →
> integrate → Codex gpt-5.5 xhigh grounded-adversarial → integrate → fresh Claude grounded subagent.
> **agent/ PROD HARD RULE honored:** the FULL tri-vendor gate cleared BEFORE merge — no substitutes.
> **Status:** **GATE UNANIMOUS-CLEARED, S175 2026-06-26.** Gemini 3.1-pro-preview ENDORSE → Codex
> gpt-5.5 xhigh ENDORSE → fresh Claude grounded subagent ENDORSE. **Zero CRITICAL/MAJOR/MINOR**
> findings across all three lenses; no code change was required at any stage.
> **Author:** Claude (S175). Implements the S173-cleared design (`executor-studio-decomposition-design-gate.md`), Wave B.

---

## What shipped (the actual change reviewed)

A behavior-preserving **PURE MOVE** extracting 4 cohesive clusters out of `agent/executor.ts`
(2,247 → 1,521 LOC) into 4 new `agent/lib/` modules. `executeJob` (the only symbol `worker.ts:29`
imports at runtime) does NOT move; its body is byte-unchanged except ONE call-site argument.

| New module | Moved from executor | New exports | Kept private | Added imports |
|---|---|---|---|---|
| `lib/worker-config.ts` | lines 71-129 | 9 env consts | `envMs` | `path` |
| `lib/worker-supabase.ts` | lines 146-159 | `getSupabase` | `let supabase` | `createClient`/`SupabaseClient`; `SUPABASE_URL/KEY` |
| `lib/claude-spawn.ts` | lines 1443-1803 | `spawnClaude`, `waitForProcess` (+ `buildClaudeSpawnEnv`/`shouldRecoverAfterDurationKill`/`KillReason` already exported) | `estimateInFlightCostCents`, `CLAUDE_SPAWN_ENV_STRIP_KEYS` | `crossSpawn`, `ChildProcess`, `MAX_JOB_COST_CENTS`, `ResearchJob`, local `log` |
| `lib/state-evaluation.ts` | `PHASE_MAP` (131-144) + lines 1805-2108 | `watchStateFile`, `readStateForRecovery`, `verifyPipelineCompletion`, `StateWatcher`, `CompletionVerdict` (+ 5 already exported) | `PHASE_MAP` | `fs`, `updateJob`, `readPipelineState`, `findStateFile`, `PipelineState/ResearchJob`, local `log` |

`executor.ts` imports the 4 modules back; dropped now-unused `crossSpawn` / `type SupabaseClient` /
`readPipelineState`; keeps `createClient` (finally-block telemetry client) + `SUPABASE_URL/KEY`; adds
`MCP_PROXY_CONFIG_PATH` module const passed to spawnClaude.

### The three sensitive seams (design §6) — all verified intact by all 3 lenses
1. **Supabase single owner (§6.1).** ONE lazy-singleton owner (`worker-supabase.ts`). The executeJob
   `finally` telemetry `createClient(SUPABASE_URL, SUPABASE_KEY)` (default auth) stays VERBATIM in
   `executor.ts:939` — NOT folded into the singleton (folding = an auth-config change, out of scope).
   Exactly two `createClient` sites remain in the decomposition surface (the singleton + telemetry).
2. **spawnClaude path re-anchor (§6.4 / principle 9).** The ONLY code change. `executor.ts` computes
   `MCP_PROXY_CONFIG_PATH` from ITS OWN `import.meta.url` (so it resolves to
   `agent/mcp-proxy/mcp-config.json`, not `agent/lib/…`) and passes it to spawnClaude. The original
   `path.join(path.dirname(fileURLToPath(import.meta.url)), …)` block is removed from claude-spawn; the
   body still uses `mcpProxyConfigPath` in the same `--mcp-config` arg + log line. No silent proxy bypass.
3. **SPLIT test re-point (§7).** `state-coercion-guards.test.ts` splits — 3 symbols ← state-evaluation,
   `shouldRecoverAfterDurationKill` ← claude-spawn. Both targets in Wave B → converges green.

---

## Verification proofs (independent of the reviewers)
- **Byte-identity:** a reverse-transform script reversed every sanctioned transform and asserted each
  moved cluster byte-identical to its `executor.ts` source slice (worker-config 59, worker-supabase 14,
  claude-spawn 361, state-evaluation PHASE_MAP 14 + body 304). Both local `log` copies == executor's log.
- **Move-only diff:** `git diff --numstat -- agent/executor.ts` (35/761) == `--ignore-cr-at-eol` (no CRLF
  phantom). Tests 1/1, 1/1, 2/2, 1/1.
- **Green, zero assertion edits:** `pnpm test` → agent **663** / frontend **125**, 0 fail (= pre-wave
  baseline). tsc --noEmit clean BOTH tiers. storage-path grep guard PASS.
- **Runtime module-load smoke:** executor + all 4 new modules import cleanly; executor's runtime export
  set is exactly `{buildManifest, buildPrompt, executeJob, uploadOutputs}` (the 4 retained) — no cycle.

---

## What each reviewer saw + verdict

### Round 1 — Gemini 3.1-pro-preview (holistic-adversarial, BREADTH) — ENDORSE
**Saw:** the full git diff + all 4 new files in full + the cleared design doc + the review context (prompt
134,342 chars). **Verdict: ENDORSE**, 7 system-level checks all confirmed (verbatim/behavior preservation;
Supabase single-owner seam incl. telemetry client correctly left untouched + `SupabaseClient` dropped; path
re-anchor resolves correctly + path imports correctly stripped from claude-spawn; export scope + declaration:true
satisfied; consumer/test re-points incl. the SPLIT; strict DAG, no back-edge; the S129 comment travelling with
the budget consts is acceptable under pure-move). 0 CRITICAL/MAJOR/MINOR — all findings INFO confirmations.
Nothing to integrate → code unchanged for Codex.

### Round 2 — Codex gpt-5.5 xhigh (grounded-adversarial, DEPTH) — ENDORSE
**Saw:** the LIVE repo working tree, `-s workspace-write` (banner asserted: `model: gpt-5.5` / `reasoning effort:
xhigh` / `provider: openai`). Ran its OWN probes: `git show HEAD:agent/executor.ts` byte-compare of every moved
cluster (clean, only allowed normalizations; executeJob byte-clean modulo the one call-site arg), the spawnClaude
surgery (signature/config-root/call-site), the Supabase seam (`rg createClient` → exactly 2), the consumer sweep
(only `worker.ts:29` runtime), `pnpm -C agent exec tsc --noEmit` EXIT 0, `pnpm -C frontend exec tsc --noEmit`
EXIT 0, `pnpm -C agent … --test` 663 pass / 0 fail. **Verdict: ENDORSE.** No CRITICAL/MAJOR.
- **MINOR:** `executor-spawn-env.test.ts:31` is LF in the working tree (git warns LF→CRLF on a future checkout);
  logical diff is still one import-path line; new Wave-B modules are CRLF.
- **INFO:** executor.ts is 1,521 physical lines, not the prompt's "1,522" (a prompt off-by-one; metadata only).

### Round 3 — fresh Claude grounded subagent (zero authoring context, refute mandate, DEPTH) — ENDORSE
**Saw:** the LIVE repo via its own Bash/grep/git probes (vendor-independent third lineage). Independently
byte-compared every moved cluster vs HEAD (identical modulo allowed transforms; executeJob byte-identical save
the one call-site arg), verified the spawnClaude surgery + Supabase seam + consumer map + acyclicity (incl. a
runtime `import('./executor.ts')` load smoke proving no cycle/TDZ), ran tsc both tiers (EXIT 0) + the agent suite
(663/663/0), confirmed no CRLF phantom. **Verdict: ENDORSE.** 0 CRITICAL/MAJOR/MINOR.
- **INFO:** the 2 LF test files (executor-spawn-env, duration-kill-recovery) carry a cosmetic LF→CRLF git
  warning — **pre-existing** (both were LF at HEAD), clean 1-line diffs, flagged only for a future normalization.

---

## Disposition of the (non-blocking) notes
- **LF on `executor-spawn-env.test.ts` (+ `duration-kill-recovery.test.ts`).** Pre-existing condition (both
  files committed LF at HEAD `ea75b52`; this change did not introduce it). Verified: the staged diff is **1/1**
  raw == `--ignore-cr-at-eol`, i.e. committing yields a clean single import-path line, NOT a whole-file phantom
  (no `.gitattributes`; `core.autocrlf=true` keeps the already-LF blob as-is on add). Deliberately LEFT LF —
  converting to CRLF would inject ~175 lines of EOL-only noise into a move-only PR, obscuring the move story.
  A future session may normalize the 2 files as a standalone EOL cleanup.
- **executor.ts line count (1,521 vs the prompt's 1,522).** A prompt off-by-one (line-terminator vs `wc -l`
  counting); not a code issue.

## Final gate verdict — UNANIMOUS CLEAR
All three independent adversarial lenses (Gemini holistic + Codex grounded + Claude grounded) ENDORSED the
actual shipped code with zero CRITICAL/MAJOR/MINOR findings and required no integration cycle — the cleanest
possible outcome for a pure-move wave. The decomposition is behavior-preserving (byte-identical production hot
path save one call-site arg), the 3 seams survive intact, the graph is acyclic at compile AND at load, and the
full suite is green at the pre-wave baseline (663/125). **Cleared to merge → DR-Deploy → worker restart.**

Raw reviewer record: `/c/tmp/dr-s175/review/` (gemini-waveb-v1.mjs + gemini-v1.log; codex-prompt.txt +
codex-v1.log [banner-asserted gpt-5.5/xhigh]; review-context.md; change-executor-and-tests.diff). Build +
verify scripts: `/c/tmp/dr-s175/{wave-b-build.mjs, verify.mjs, promote.mjs}`.
