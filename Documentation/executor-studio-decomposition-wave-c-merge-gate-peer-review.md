# executor.ts Decomposition — Wave C MERGE Gate — Peer Review Synthesis (S176)

> **Event Gate:** MERGE (agent/ PROD code reaching the live worker daemon).
> **Risk Labels:** ARCHITECTURE (cross-module boundaries) + AGENT BEHAVIOR (worker hot-path; a regression silently propagates to every research job).
> **Severity Mode:** NORMAL.
> **Reviewer topology (`~/CLAUDE.md` §11, agent/ PROD HARD RULE):** sequential tri-vendor — Gemini holistic-adversarial → integrate → Codex gpt-5.5 xhigh grounded-adversarial → integrate → fresh Claude grounded subagent. FULL gate cleared BEFORE merge (no substitutes).
> **Verdict:** **UNANIMOUS CLEAR — 0 findings across all three lenses, NO integration cycle.** Gemini 3.1 ENDORSE → Codex gpt-5.5 xhigh ENDORSE → fresh Claude grounded subagent ENDORSE.
> **Author:** Claude (S176). Implements the S173-cleared design (`executor-studio-decomposition-design-gate.md`), Wave C of 4.

---

## What Wave C did — behavior-preserving PURE MOVE (executor.ts 1521 → 1131 LOC)

Extracted 3 deliverable-prep clusters out of `agent/executor.ts` into focused `agent/lib/` modules. `executeJob` (the ONLY runtime symbol `worker.ts:29` imports) does NOT move and is byte-unchanged. Wave A (S174 PR#50) + Wave B (S175 PR#51) already shipped to prod; this is Wave C of 4 (Wave D plan-review-gate remains deferrable).

| New module | Symbols moved (original executor lines) | Export change | Imports added |
|---|---|---|---|
| `lib/terminal-notify.ts` | `notifyTerminal` (102–126) | **private → export** (the ONLY widen this wave; §6.2) | `sendCompletionEmail` (notify), types `ResearchJob`/`ReviewFinding`, local `log` |
| `lib/job-manifest.ts` | `buildManifest` (957–1075) + `buildPrompt` (1245–1382) | none (both already exported) | path/existsSync/ATTACHMENTS/fenceValue/isPublish*/worker-config consts/types |
| `lib/upload-outputs.ts` | `UploadResult`+`Uploader`+`uploadOutputs` (1384–1480) | none (all already exported) | fs/path/getContentType/selectUploadSet/storage-paths/`getSupabase` (worker-supabase)/local `log` |

**§6.2 seam (notifyTerminal):** only the `notifyTerminal` wrapper extracts; its sole caller-dependency `sendCompletionEmail` moves with it. The sibling senders `sendPlanReviewEmail` (executor:353) + `sendDeliveryDelayedEmail` (executor:832) are called DIRECTLY by retained code and STAY imported in executor.

**executor.ts import edits:** dropped 4 whole imports (conventions/ATTACHMENTS+getContentType, upload-set, storage-paths×3, untrusted-input/fenceValue) + 3 partials (existsSync, sendCompletionEmail, isPublishFlagSet) — each used ONLY by moved code (verified by grep; `noUnusedLocals` is OFF so tsc cannot catch a leftover). Kept `isPublishRequired` (executeJob:567, runStudioOnly:1148), `AttachmentDownloadResult` (executeJob:479), the 2 retained senders. Added the 3 new module imports + nothing else.

## Consumer map (verified live — `rg 'from ".*executor(\.js)?"' agent` = exactly 5)
- `worker.ts:29` → `executeJob` — **UNCHANGED** (the entire production import surface).
- 4 tests re-pointed, all SINGLE-module (no split this wave): `attachments`+`publish-brief`+`publish-gate` → `lib/job-manifest.js`; `upload-set` → `lib/upload-outputs.js`. `notifyTerminal` has zero external importers.

---

## Verification evidence (independently re-run by the grounded lenses)

| Check | Result |
|---|---|
| Byte-identity of moved clusters vs `git HEAD` | terminal-notify 25 ln, job-manifest 119+138 ln, upload-outputs 97 ln, both local logs 4 ln — ALL byte-identical (build `verify.mjs` reverse-transform + Codex + Claude-subagent independent byte-diff) |
| Retained code unchanged vs HEAD | Codex byte-diffed executeJob (549 ln) + studio-only (167 ln) + simulator/log tail (40 ln) = line-identical; Claude-subagent reconstruction diff = 35 ln, 100% in the import region, zero retained-body change |
| Zero test delta | `pnpm test` agent **663** / frontend **125**, 0 fail = identical to pre-move baseline; zero assertion edits |
| tsc both tiers | `pnpm -C agent exec tsc --noEmit` + `pnpm -C frontend exec tsc --noEmit` EXIT 0 (re-run by Codex + Claude subagent) |
| Move-only diff | executor `3 added / 394 removed`; each test `1/1`; `git diff --numstat` == `--ignore-cr-at-eol` (no CRLF phantom); 3 new files CRLF |
| Acyclicity | module-load smoke (no cycle, no crash); executor runtime exports = `{executeJob}` only; no new module imports executor.ts (only the `"executor.ts"` audit caller-label string) |
| storage-path grep guard | PASS |

---

## Review rounds (what each lens saw + verdict)

### Round 1 — Gemini 3.1 (gemini-3.1-pro-preview) holistic-adversarial (BREADTH) — ENDORSE, 0 findings
Saw: the full git diff + the 3 new files in full + the cleared design + the review context. Verified pure-move byte-identity (the delicate template literals + the 0-byte refusal + the urgent_signoff existsSync identical), export-widen minimality (only notifyTerminal), the §6.2 seam (sendCompletionEmail moved, siblings stay), import drop/keep correctness, the 4 single-module test re-points, and DAG acyclicity. "The behavior-preservation claim is rock solid."

### Round 2 — Codex gpt-5.5 (xhigh, banner-asserted `model: gpt-5.5` / `reasoning effort: xhigh` / `sandbox: workspace-write`) grounded-adversarial (DEPTH) — ENDORSE, 0 findings
Ran in-repo: `git show HEAD:agent/executor.ts` byte-compare of every moved cluster AND the retained executeJob/studio/tail (all line-identical), export-surface check (executor exports only executeJob), §6.2 seam, import drop/keep grep, consumer-map re-sweep, back-edge check, `--numstat`/`--ignore-cr-at-eol` parity, `tsc --noEmit` both tiers, and the agent suite (663 pass/0 fail). "No CRITICAL, MAJOR, MINOR, or INFO findings. I could not reproduce a blocker."

### Round 3 — fresh Claude grounded subagent (zero authoring context) — ENDORSE, 0 findings
Independently re-ran all 9 checks. Decisive extra probe: mechanically reconstructed the expected post-move executor by deleting exactly the 4 moved blocks from the original, then diffed vs the actual file — residual 35 lines, 100% confined to the import region, zero retained-body change, conclusively ruling out a logic edit disguised as a move. "Findings: none."

---

## Disposition
No findings at any lens → no integration cycle. The cleared design's Wave-C row, the §6.2 seam, the EXHAUSTIVE §7 per-test map (re-built from the live tree), and the move-only/byte-identity/zero-delta proofs all held under three adversarial lineages. **Merged → DR-Deploy pull → worker restart.** Wave D (plan-review-gate) remains deferrable; A–C have shrunk executor 2,247 → 1,131 LOC.
