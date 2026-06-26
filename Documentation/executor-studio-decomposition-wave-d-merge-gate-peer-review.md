# executor.ts Decomposition — Wave D MERGE GATE (plan-review-gate) — PEER REVIEW

> **Event Gate:** MERGE (agent/ PROD worker hot-path).
> **Risk Labels:** ARCHITECTURE (cross-module boundary) + AGENT BEHAVIOR (the worker job hot-path; a regression silently propagates to every research job).
> **Severity Mode:** NORMAL.
> **Reviewer topology (per `~/CLAUDE.md` §11 — agent/ PROD HARD RULE):** sequential tri-vendor, FULL gate cleared BEFORE merge, NO substitutes — Gemini 3.1 holistic-adversarial → integrate → Codex gpt-5.5 xhigh grounded-adversarial → integrate → fresh Claude grounded subagent. UNANIMOUS required.
> **Status:** **GATE CLEARED — UNANIMOUS ENDORSE, 0 findings, NO integration cycle (S177, 2026-06-26).** This is the LAST + RISKIEST decomposition wave. After this wave the executor/studio decomposition is COMPLETE (10 modules; executor 2,247 → 850 LOC).
> **Author:** Claude (S177).

---

## §1. What Wave D did (PURE MOVE out of agent/executor.ts, 1,130 → 850 LOC)

A behavior-preserving **pure move** of the S59 plan-review gate cluster (executor lines 94–369 at git HEAD `aa6631c`) into ONE new module. `executeJob` (the only runtime symbol `worker.ts:29` imports) did **not** move — byte-unchanged.

**NEW `agent/lib/plan-review-gate.ts`** ← executor lines 94–369 VERBATIM (the `// ── S59 plan-review gate helper` section divider + 4 symbols):
- `PlanReviewOutcome` (interface) — gains `export`, **forced** by `declaration:true` (return type of the now-exported `runPlanReviewGate`; leaving it private trips TS4023).
- `buildReservationAdvisory` (fn) — stays **PRIVATE**.
- `persistReviewerCalls` (async fn) — stays **PRIVATE**.
- `runPlanReviewGate` (async fn) — gains `export` (executor imports + calls it at executeJob).
- Local `log` — BYTE-IDENTICAL copy of executor's `log` (HEAD lines 1127–1130).
- Imports re-rooted for `agent/lib/`: `fs`/`path` (node), `failJob`+`updatePlanReviewStatus` (`../api-client.js`), `sendPlanReviewEmail` (`./notify.js`), `synthesizePlan`+`PlanSynthesisError` (`./plan-synthesizer.js`), `reviewPlan` (`./plan-reviewer.js`), `makePlanReviewTransports` (`./plan-transports.js`), type `ResearchPlan`+`ReviewerCall`+`ReviewFinding` (`./plan-types.js`), `classifyTerminalError`+`markPendingTerminalExit` (`./preflight-backoff.js`), type `ResearchJob` (`../types.js`), `getSupabase` (`./worker-supabase.js`), `notifyTerminal` (`./terminal-notify.js`).

**RETAINED `agent/executor.ts`** — imports the new module back (`import { runPlanReviewGate } from "./lib/plan-review-gate.js";`, replacing the old 4-line plan-imports block).
- **DROPPED** (each used ONLY by the moved gate): `sendPlanReviewEmail`, `synthesizePlan`+`PlanSynthesisError`, `reviewPlan`, `makePlanReviewTransports`, `ResearchPlan`+`ReviewerCall`+`ReviewFinding`.
- **KEPT — the SHARED-CROSS-IMPORT seam** (executeJob itself uses them, so they must stay): `classifyTerminalError`+`markPendingTerminalExit`, `getSupabase`, `notifyTerminal`, `failJob`+`updatePlanReviewStatus`, `sendDeliveryDelayedEmail`.

**ZERO test re-points + ZERO prod re-points** — live grep confirmed the 4 moved symbols are consumed ONLY by executor.ts; no test or other prod file imports them. (Unlike Waves A–C, nothing to re-point.)

The KEY Wave-D risk class is the **shared-import seam**: 7 symbols are imported by BOTH the new module and retained executor. A wrongly-dropped shared symbol = tsc "cannot find name"; a dropped-but-still-referenced symbol = same; a kept-but-now-unused import = a dead-import MINOR (`noUnusedLocals` is OFF, so tsc won't catch it).

---

## §2. Verification evidence (behavior-preservation)

- `pnpm test`: **agent 663/663, frontend 125/125, 0 fail, ZERO assertion edits** (no test file touched).
- `tsc --noEmit` both tiers: **EXIT 0** (with `declaration:true` — mechanically proves no exported fn leaks a private type).
- storage-path grep guard: **PASS**.
- Move-only diff: `git diff --numstat` executor **1/282** (1 insert = the new import; 282 delete = 276-line cluster + trailing blank + 5 dropped import lines) **== `--ignore-cr-at-eol`** (no CRLF phantom). New file `lib/plan-review-gate.ts` +310.
- Byte-identity: a reverse-transform script un-did the 2 export-widens on the moved block and asserted it **== source slice executor 94–369** (276 lines); local `log` **== executor 1127–1130**. The Claude grounded subagent independently confirmed **identical SHA256** (`791d832d…`) after normalizing the 2 visibility changes.
- Module-load smoke (real tsx import of the chain): no cycle; `executor` runtime exports = **{executeJob}**; `plan-review-gate` runtime exports = **{runPlanReviewGate}** (PlanReviewOutcome type-erased; the 2 private helpers correctly absent).

---

## §3. Round-by-round (sequential, per §11 topology)

### Round 1 — Gemini 3.1 (gemini-3.1-pro-preview) holistic-adversarial (BREADTH) — VERDICT: ENDORSE (0 findings)

What it saw: the full git diff + the new file in full + the shrunken executor.ts in full + the cleared design doc. It adversarially challenged the verbatim claim on the high-risk lines (`buildReservationAdvisory` slice/truncation math, `persistReviewerCalls` row-map, `sendPlanReviewEmail` `.flatMap(findings).slice(0,20)`, the `AbortSignal.timeout` values, the shadow/ladder branches, the S64/S85 comment blocks) and found **every line byte-identical**. It confirmed: (a) no shared symbol wrongly dropped; (b) all 8 dropped imports used ONLY within the moved gate; (c) no kept import now dead; (d) EXACTLY `runPlanReviewGate` + `PlanReviewOutcome` export-widened, the 2 helpers private, the `PlanReviewOutcome` export genuinely forced by `declaration:true`; (e) import paths correctly re-rooted (`./X.js` siblings, `../api-client.js`/`../types.js` parents); (f) DAG intact (no dep back-imports executor); (g) zero broken test/prod consumers. **VERDICT: ENDORSE.**

→ **0 findings → NO integration cycle.** Codex reviewed the same diff.

### Round 2 — Codex gpt-5.5 (xhigh; banner-asserted `model: gpt-5.5` / `reasoning effort: xhigh` / `provider: openai` / `sandbox: workspace-write`) grounded-adversarial (DEPTH) — VERDICT: ENDORSE (0 findings)

Ran in-repo (`-s workspace-write`); read the real files, ran `git show HEAD:agent/executor.ts`, byte-compared the moved cluster vs HEAD lines 94–369, ran `npx tsc --noEmit` (EXIT 0), re-swept importers with `rg`. Grounded confirmations (file:line): the moved cluster matches HEAD modulo the 2 allowed visibility changes (`PlanReviewOutcome` @lib:37, `runPlanReviewGate` @lib:124); `buildReservationAdvisory`/`persistReviewerCalls` private @58/77; local `log` == HEAD executor `log` byte-for-byte; executor exports only `executeJob` @92; **shared-import seam intact** — `updatePlanReviewStatus`@211, `getSupabase`@172, terminal classification @325/358/382/388, `sendDeliveryDelayedEmail`@551 all still imported AND used by retained code; dropped gate-only symbols have no remaining references; consumer sweep found only executor.ts importing `runPlanReviewGate` (call @219) + worker.ts:29 importing executeJob; import paths resolve; no cycle. **VERDICT: ENDORSE.**

→ **0 findings → NO integration cycle.** The fresh Claude lens reviewed the same diff.

### Round 3 — fresh Claude grounded subagent (zero authoring context, prompted to REFUTE) — VERDICT: ENDORSE (0 findings; 1 non-blocking style nit)

Ran read-only in-repo with its own tools. It re-derived every claim from HEAD `aa6631c` and specifically tried to break it on byte-drift, a smuggled slice/timeout edit, a wrongly-dropped shared symbol, and a hidden cycle. Strongest proof: HEAD lines 94–369 (276 lines, 11,831 bytes) vs the moved cluster have **identical SHA256** (`791d832d86f2cbcc302825c3971c4dc6382be1b95a2f06adbb3e12fd6b29c118`) after un-prepending the 2 `export ` keywords; the prepended `log` is byte-identical (diff EXIT 0). Confirmed: exactly 2 widened / 2 private; shared seam fully intact (all 7 shared symbols still imported + used by retained code; all 8 dropped symbols have 0 occurrences in post-move executor); zero re-points; acyclic; `pnpm exec tsc --noEmit` EXIT 0. **One non-blocking MINOR style nit:** the retained `notify` import collapsed to a single-member multi-line brace form — valid TS, zero runtime effect (a deliberate minimal-diff choice, not a behavior change). **VERDICT: ENDORSE.**

---

## §4. Final gate verdict — UNANIMOUS CLEAR

All three independent adversarial lenses (Gemini holistic breadth + Codex grounded depth + fresh Claude grounded depth) **ENDORSED with 0 actionable findings on the first pass** — no integration cycle was required. Each verified the byte-identity of the move, the minimal 2-symbol export-widen (with the 2 private helpers staying private), the integrity of the shared-import seam (the Wave-D-specific risk class), zero broken consumers, an acyclic graph, and `tsc --noEmit` EXIT 0. The single non-blocking style nit (collapsed notify import) is a deliberate minimal-diff choice with no runtime effect.

This is the **4th consecutive 0-findings-first-pass tri-vendor gate** on the anchor-asserted byte-slice + reverse-transform pure-move technique (Waves A, B, C, D). **Wave D completes the executor/studio decomposition**: 10 cohesive `lib/` modules; `executor.ts` 2,247 → 850 LOC; `studio-completeness.ts` 747 → ~421 LOC; byte-unchanged production import surface (`worker.ts → executeJob`); acyclic L0→L4 DAG; zero runtime-behavior change proven by an unmodified-assertion green suite at every wave.
