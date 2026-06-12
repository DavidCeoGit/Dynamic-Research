# MERGE-gate peer review — S116 PUBLISH source-date precision

**Change:** `agent/executor.ts buildPrompt()` — add one high-prompt-weight `CRITICAL` directive to the `publishBlock` (emitted ONLY for `publishRequired === true` jobs) requiring every `sourceDates` entry to carry a full `YYYY-MM-DD`, with a quality-preserving remediation order. Plus 6 strengthened assertions in `agent/test/publish-brief.test.ts`. Non-publish briefs byte-identical.

**MRPF classification:** Event Gate = **MERGE**. Risk Label = **AGENT BEHAVIOR** (changes the brief that propagates to every future publish-required `claude -p` spawn). Severity = **NORMAL**. Topology = **sequential Gemini → integrate → Codex**.

**Motivation:** Job `9a1b7b30` re-run (S115) produced a correct manifest, all 3 vendor legs LIVE (real NotebookLM CLI), 8 sourced claims — but the gate fail-closed on ONE claim whose `sourceDates` entry was `"2022-09 (Search Engine Land …)"` (month precision). `agent/lib/publish-gate.ts containsRealIsoDate` requires a full `YYYY-MM-DD` substring + real-calendar validation. The S115 brief never told the model the date must carry the day. This closes that drift.

**Tests covered?** Yes — `agent/test/publish-brief.test.ts` (6 new assertions pin the directive's unique tokens + the Gemini-fix guardrails). Full agent suite 384/384 green, tsc clean. The gate side (`publish-gate.ts`) is UNCHANGED.

---

## What each reviewer saw
- **Gemini (gemini-2.5-pro, holistic-adversarial):** the diff + gate regex + schema example + 5 targeted attack questions, embedded inline (sandbox docs are gitignored). Whole-artifact lens.
- **Codex (`codex exec -s read-only`, grounded-adversarial):** the SHIPPED files in-repo — `agent/executor.ts` (v2 publishBlock), `agent/lib/publish-gate.ts` (`containsRealIsoDate`/`isRealIsoDate`/per-claim validation), `agent/test/publish-brief.test.ts`, plus `agent/types.ts` + existing `publish-gate.test.ts` fixtures. Could not execute `node`/`pnpm` (read-only policy) — review by source inspection + existing fixtures. file:line grounded.

## Round 1 — Gemini holistic-adversarial → **BLOCK** (integrated)
**Blocking reason:** v1's remediation "drop that source and cite a different one with a full date" created a perverse incentive — a model could discard an authoritative primary source dated month-only in favor of a weaker secondary source that happens to carry a full `YYYY-MM-DD`, trading **source quality for date-format compliance**. That solves a detectable formatting issue by introducing an undetectable, more damaging one (research-quality / source-integrity degradation), defeating the gate's purpose.

**Integration (v2):** replaced the "drop and swap" guidance with an ordered, quality-preserving path:
1. use the source's exact PUBLICATION day if determinable (bylines/metadata often expose it);
2. else record the ACCESS date (the day actually retrieved) in full `YYYY-MM-DD` annotated `(accessed)` — always known to the day, KEEPS the original authoritative source;
3. optionally ADD a corroborating full-dated source, keeping the original.

Explicit guardrails added: "NEVER drop or swap a stronger source for a weaker one … preserving source quality and independence outranks date-format convenience" + "NEVER fabricate or guess a day." The access-date path removes the incentive entirely — a truthful full-date is ALWAYS available without touching the source set.

## Round 2 — Codex grounded-adversarial on integrated v2 → **ENDORSE (minor nits)** (integrated)
**No blocking issue.** Confirmed against shipped code:
- Brief↔gate fidelity holds: `sourceDates` array + every entry satisfies `containsRealIsoDate()` (`publish-gate.ts:166-170`), which extracts a `YYYY-MM-DD` substring then `isRealIsoDate()` round-trip-validates (`publish-gate.ts:90-92`, `69-75`).
- Access-date path is SAFE against the current consumer: the gate treats dates as publication/access (`publish-gate.ts:20-22`; `types.ts:77-78` "Publication or access date per source"); `(accessed)` is annotation only — no gate path parses beyond the date substring. Existing green fixture already uses `"2026-06-10 (accessed)"` (`publish-gate.test.ts:37-43`).
- Semantic fabrication (stamping today's date for a source never retrieved) remains the gate's blind spot but is **pre-existing, not a regression**; the new prompt mitigates with "day you actually retrieved" + "NEVER fabricate or guess."

**Nit 1 (fidelity):** v2 said the gate "matches `/\d{4}-\d{2}-\d{2}/`" but the gate ALSO validates a real calendar date — a model could infer `2026-13-40` would pass. **Integrated (v3):** reworded to "extracts a `YYYY-MM-DD` substring per entry AND validates it as a REAL calendar date, so an impossible date like `2026-13-40` is ALSO rejected."

**Nit 2 (test rigor):** `p.includes("YYYY-MM-DD")` was already true from the schema example — pinned nothing. **Integrated (v3):** replaced the 3 weak assertions with 6 scoped to tokens unique to the new directive — `EVERY entry in each claim's \`sourceDates\` array MUST contain a FULL calendar date`, `2022-09`, `annotated "(accessed)"`, `NEVER drop or swap a stronger source for a weaker one`, `NEVER fabricate or guess a day`, `validates it as a REAL calendar date`.

## Disposition
Gemini BLOCK resolved in v2; Codex ENDORSE with both nits integrated in v3. No open findings. No SECURITY-labeled finding. **Cleared to merge.**

**Final:** main branch `fix/publish-sourcedate-precision`; executor.ts +1 directive (reworded), publish-brief.test.ts +6 assertions; suite 384/384, tsc clean. Gate (`publish-gate.ts`) untouched.
