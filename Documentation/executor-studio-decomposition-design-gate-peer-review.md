# executor.ts / studio-completeness.ts Decomposition — DESIGN-gate peer-review synthesis

> Companion to `Documentation/executor-studio-decomposition-design-gate.md`. Per `~/CLAUDE.md` §11 MRPF.
> **Gate:** DESIGN · **Risk:** ARCHITECTURE (+ AGENT BEHAVIOR secondary) · **Severity:** NORMAL · **Topology:** sequential tri-vendor (Gemini holistic → Codex grounded → Claude grounded subagent), each adversarial within its lens.
> **Session:** Dynamic Research S173 · **Date:** 2026-06-25 · **Verdict: UNANIMOUS CLEAR (v4).**

## What each reviewer saw
- **Gemini 3.1 (gemini-3.1-pro-preview), holistic-adversarial (breadth):** the FULL v1 design doc + the FULL `agent/executor.ts` (2,247 LOC) + `agent/lib/studio-completeness.ts` (747) + `agent/worker.ts` (364), pasted into a single 187K-char prompt (Gemini can't read the repo). Ran via the `@google/genai` SDK harness. Prompted to find the strongest system-level case to BLOCK.
- **Codex gpt-5.5 (xhigh, banner-asserted `model: gpt-5.5` / `reasoning effort: xhigh` / `provider: openai`), grounded-adversarial (depth, file:line):** ran IN the repo (`codex exec -s workspace-write`), read the v2 design from `sandbox/`, read the actual files itself with `rg`/`sed`, ran `tsc --noEmit`. Prompted to verify every grounded claim + re-sweep for missed importers/closures.
- **Claude grounded subagent (fresh, zero authoring context), grounded-adversarial:** read the v3 design from `/c/tmp/dr-s173/design-v3.md`, read every test import block + closure in the repo, ran `tsc --noEmit`. Prompted to refute. A SECOND fresh Claude subagent ran the v4 fidelity re-check (verify the fixes landed; guard against new errors).

## Round-by-round

### Round 1 — Gemini holistic — VERDICT: BLOCK (2 CRITICAL + 2 MAJOR), all integrated → v2
- **C1 (CRITICAL):** `spawnClaude` resolves the mcp-proxy config via `import.meta.url`; a verbatim move to `agent/lib/` re-roots it → broken `--mcp-config`, proxy silently bypassed. → **Fix:** principle 9 (re-anchor file-relative paths); executor computes `mcpProxyConfigPath`, passes it in (the one allowed signature change).
- **C2 (CRITICAL):** "one createClient" claim false — a 2nd telemetry `createClient` at executeJob:998; and `executeJob` itself calls `getSupabase()` (line 546), so executor.ts is a consumer the design omitted. → **Fix:** §6.1 corrected — 3 getSupabase callers incl. executor.ts; telemetry client stays; invariant = "one singleton owner."
- **M3 (MAJOR):** `PHASE_MAP` is a static dict, not env config; v1's param-injection of it forces test-call churn. → **Fix:** principle 4a — static maps move WITH their sole consumer (PHASE_MAP → state-evaluation).
- **M4 (MAJOR):** `buildManifest` closes over `WORKING_DIR`/`PROJECTS_DIR` (also used by retained executeJob) → forced signature churn. → **Fix:** new shared `lib/worker-config.ts` owns env config; both sides import; bodies stay verbatim. **This replaced v1's param-injection principle entirely.**
- Verified all 4 against the code before integrating. Net: the decomposition shape held; the "pure move" claim was hardened (v1 under-counted module-context closures + miscounted the Supabase seam).

### Round 2 — Codex grounded — VERDICT: BLOCK (1 CRITICAL + 1 MINOR), integrated → v3
- **C3 (CRITICAL):** §7 wrongly listed `studio-completeness.test.ts` "unchanged"; its import block (`:21-29`) pulls moved CLI symbols (`classifyDownloadFailure`/`realDownloadArtifact`/`DownloadResult`/`DownloadSpawn`/`NlmArtifactRef`) → Wave A breaks the test import. → **Fix:** §7 marks it a SPLIT re-point.
- **C4 (MINOR):** §5 graph omitted the existing `executor.ts → studio-recovery-sweep.ts` (`studioRecoveryBackoffMs`) edge. → **Fix:** §5 augmented; no cycle.
- Codex CONFIRMED (grounded): no missed executor importer (only worker.ts:29); Supabase call-sites correct (3 getSupabase + telemetry createClient); `import.meta.url` claims correct; closures hold (incl. `PUBLISH_RISK_ACCEPT_DIR` ∈ worker-config); `tsc` passes. Q5: scope the "two createClient" wording (done).

### Round 3 — Claude grounded subagent (v3) — VERDICT: BLOCK (1 MAJOR + 3 MINOR), integrated → v4
- **M-1 (MAJOR):** the SYMMETRIC twin of C3 — `state-coercion-guards.test.ts:21-26` is a SPLIT (`isNonPrimitiveStateField`/`recoverableNotebookId`/`evaluateCompletion` → state-evaluation; `shouldRecoverAfterDurationKill` → claude-spawn) the design called single-module. → **Fix:** §7 replaced with an EXHAUSTIVE per-test re-point table (all 8 executor tests); §8 step 3 names both splits.
- **m-1/m-2/m-3 (MINOR):** type-only `artifact-timestamps → nlm-artifact-cli` edge (added to §5); hard-pinned test counts (de-pinned in §8); cluster-local supporting types under-listed (§4.1 note added).
- Subagent CONFIRMED all 7 load-bearing claims (consumer map, acyclicity, closure completeness, signature-churn, Supabase seam, spawn guards, wave safety) + `tsc` clean.

### Round 3b — fresh Claude grounded fidelity re-check (v4) — VERDICT: ENDORSE
- Verified all four v4 fixes land exactly against the repo (re-read every test import; the §7 table is correct for all 8 tests, `state-coercion-guards` SPLIT, no other mislabeled); re-confirmed the unchanged core (sole importer, DAG, 3+2 Supabase seam, single spawnClaude signature change, both `import.meta.url` sites, all studio re-points); `tsc --noEmit` EXIT 0. No regression introduced. One non-blocking path-prefix nit fixed.

## Synthesis
The decomposition's architecture (10 pure-move modules; executor.ts 2,247→~850–950, studio-completeness 747→~320; byte-unchanged production surface; acyclic L0→L4 DAG; 4 lowest-risk-first waves) survived three independent adversarial lenses unchanged. Every BLOCK was a **completeness/correctness** finding, not a soundness flaw: v1 under-counted module-context closures (file-relative paths, static maps, env-config straddling the boundary) + miscounted the Supabase seam (Gemini); the consumer/test map twice elided a *mixed* import that splits across two destination modules (Codex C3 studio-side, Claude M-1 executor-side). Both classes are now closed structurally — a shared `worker-config` + path re-anchoring + corrected Supabase invariant make "pure move, zero signature churn" honest, and an EXHAUSTIVE per-test re-point table (built from raw import blocks, not summaries) removes the elision root-cause. **Result: the design is sound, safe, and complete; UNANIMOUS clear; authoritative input for the Wave-A MERGE gate (future session). NO code, NO merge, NO deploy this session.**

## Raw reviewer artifacts
`/c/tmp/dr-s173/`: `design-v1.md`..`design-v4.md` (snapshots); `review-context.md`; `gemini-v1.mjs` + `gemini-v1.log` (BLOCK); `codex-prompt.txt` + `codex-v2.log` (BLOCK, banner gpt-5.5 xhigh); the two Claude subagent verdicts are in the S173 transcript. Harnesses reusable for the MERGE gate.
