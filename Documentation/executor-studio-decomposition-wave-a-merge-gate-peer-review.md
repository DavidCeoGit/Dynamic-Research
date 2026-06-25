# Wave A MERGE Gate — Peer Review Synthesis (S174, 2026-06-25)

> **Companion to** `executor-studio-decomposition-design-gate.md` (the S173 tri-vendor UNANIMOUS-cleared DESIGN).
> **Event Gate:** MERGE. **Risk Labels:** ARCHITECTURE (cross-module boundary) + AGENT BEHAVIOR (worker hot-path). **Severity:** NORMAL.
> **Reviewer topology (per `~/CLAUDE.md` §11):** sequential tri-vendor — Gemini holistic-adversarial → integrate → Codex gpt-5.5 xhigh grounded-adversarial → integrate → Claude grounded subagent. UNANIMOUS clear required (agent/ PROD HARD RULE — full tri-vendor BEFORE merge, NO substitutes).
> **Status:** ✅ **GATE CLEARED — UNANIMOUS ENDORSE, ZERO FINDINGS, all three lenses.** No code changed across the gate (the v1 implementation was clean).

---

## What shipped (Wave A — the studio split)

A behavior-preserving **PURE MOVE** extracting two cohesive modules out of `agent/lib/studio-completeness.ts`
(the S129 worker fail-closed studio-completeness gate, 747 → ~421 LOC), with a byte-unchanged production import
surface (`worker.ts → executeJob`; `executor.ts`'s `enforceStudioCompleteness`/`defaultDeps` import unchanged).

- **NEW `agent/lib/nlm-artifact-cli.ts`** (NLM CLI wrapper + download-failure taxonomy): `NLM_BIN`, `NlmArtifactRef`,
  `DownloadResult`, `TERMINAL_DOWNLOAD_PATTERNS`, `classifyDownloadFailure`, `realListArtifacts`,
  `DEFAULT_DOWNLOAD_TIMEOUT_MS`, `DownloadSpawn`, `defaultDownloadSpawn`, `mangleWinPath`, `realDownloadArtifact`.
  Imports ONLY `node:child_process` + `node:fs/promises`. Export visibility **preserved exactly** as in the original.
- **NEW `agent/lib/artifact-timestamps.ts`** (timestamp / anti-stale parsing): `buildCompact`, `parseTimestamp`
  (module-private), `deriveRunStart`, `artifactCreatedAtMs`, `safeMs` (the latter 3 gain `export` — the ONLY
  visibility change in the wave, forced by the new module boundary). Type-only imports (`pickWinners` typeof query,
  `PipelineState`, `NlmArtifactRef`).
- **RETAINED `studio-completeness.ts`**: gate core; imports the moved symbols back; dropped its now-unused `spawnSync` import.
- **Consumer re-points** (EXHAUSTIVE — built by reading every raw import block per [[move_refactor_enumerate_full_raw_imports]]):
  3 production (`studio-recovery-sweep.ts`, `studio-snapshot-diff.ts`, `regenerate-studio-products.ts`) + 4 tests
  (`studio-completeness.test.ts` SPLIT; `regenerate-studio-products.test.ts`, `studio-snapshot-diff.test.ts`,
  `studio-recovery-sweep.test.ts` clean). **The exhaustive grep surfaced 3 test consumers the design §7 table omitted**
  (the 3 latter test files) — caught + re-pointed at implementation; the discipline working as intended.

**Verification (independently re-checkable):** `pnpm test` → storage-path guard PASS, strict `tsc` clean both tiers,
agent **663** / frontend **125**, **0 fail**, ZERO assertion edits (only import-path edits). Move-only diff:
`git diff --numstat` == `--ignore-cr-at-eol` (no CRLF phantom; agent/ + both new files CRLF). studio-completeness.ts −338/+12.

---

## Round 1 — Gemini 3.1 (gemini-3.1-pro-preview) holistic-adversarial (BREADTH) — VERDICT: ENDORSE

**What it saw:** the cleared design doc + the full git diff (agent/, incl. both new files) + both new files in full + the
retained studio-completeness.ts in full + the review-context brief. Did NOT run code (holistic breadth lens).

**Findings: NONE.** Verified at the system level: (1) truly move-only — every line in both new modules extracted
byte-for-byte; default params/strings/regex match; (2) consumer re-points correct incl. the SPLIT (segregates retained
from moved without altering assertions) and all 4 tests; (3) exports exact (3 forced exports justified, 5 internals
private, prior exports unchanged); (4) DAG acyclic — the `artifact-timestamps → nlm-artifact-cli` edge is `import type`,
compile-erased, zero runtime load-order cycle; (5) seams intact — S162 spawn throw-guards, S160/S161 atomic rename-only
promotion, anti-stale run-floor, S158 transient/terminal taxonomy all relocated without alteration. "Textbook pure-move."

## Round 2 — Codex gpt-5.5 (xhigh; banner-asserted `model: gpt-5.5` / `reasoning effort: xhigh` / `provider: openai`) grounded-adversarial (DEPTH) — VERDICT: ENDORSE

**What it saw:** the actual repo working tree (`-s workspace-write`). Ran real probes: `git show HEAD:agent/lib/studio-completeness.ts`
(byte-for-byte per-symbol comparison), `pnpm -C agent exec tsc --noEmit` (EXIT 0), `rg` consumer re-sweep, `git diff --numstat`
vs `--ignore-cr-at-eol`, runtime cycle probe, the focused affected tests (64 pass).

**Findings: NONE.** Grounded-verified, with file:line: per-symbol move byte-identical (modulo the 3 intended `export`s);
consumer map complete (re-points + retained-only importers); exports exact; nlm-artifact-cli imports only node builtins +
artifact-timestamps uses only `import type` → no cycle; `tsc --noEmit` EXIT 0; S162 guards (`nlm-artifact-cli.ts:99`,`:212`),
S160/S161 rename-only (`:193`,`:252`, no `fs.rm(outPath)`/`copyFile`), S158 taxonomy, anti-stale wiring all intact;
numstat == ignore-cr-at-eol. (Temp-write to `C:\tmp` was EPERM-blocked in its sandbox; it adapted by comparing the
`git show` byte stream directly.)

## Round 3 — fresh Claude grounded subagent (zero authoring context, prompted to REFUTE) (DEPTH) — VERDICT: ENDORSE

**What it saw:** the actual repo. Ran: mechanical per-symbol byte-diff vs git HEAD (sed-extract + strip leading `export` +
`tr -d '\r'` + `diff` → 83/83 and 237/237 identical; retained file = 0 `>` lines, pure excision), `Grep` full consumer sweep,
`pnpm -C agent exec tsc --noEmit` (EXIT 0), full `pnpm test` (agent 663 / frontend 125, 0 fail), seam reads, CR-byte counts.

**Findings: NONE** (one INFO: the change touches more files than a loosely-phrased "three" in its brief — all verified-correct
1-line re-points, not a defect). The two prior ENDORSE verdicts held up under a third independent grounded pass.

---

## Synthesis

Three independent lenses (three vendors / three blind spots), run sequentially per §11, on the ACTUAL shipped code, each
performing real grounded verification, **UNANIMOUSLY ENDORSED with zero findings**. The implementation was clean on v1 —
no integration cycles were needed. The pure-move discipline (verbatim byte-slice via an anchor-asserted extraction script,
EOL-matched, exhaustive consumer re-point, green suite with zero assertion edits) produced a textbook behavior-preserving
refactor. **Cleared to merge.** Next: Wave B (worker-config + worker-supabase + claude-spawn + state-evaluation), its own full §11 gate.
