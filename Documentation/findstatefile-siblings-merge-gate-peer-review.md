# findStateFile `-state.json` sibling fixes — MERGE-gate peer review

**Session:** S84 (2026-06-03 UTC)
**Change:** Apply the S83 `8b32c97` `findStateFile` fix pattern to the 3 sibling sites Codex flagged during the S83 URGENT review. Also serves as the **retrospective Gemini review of `8b32c97`** (the S83 URGENT follow-up, due 2026-06-04).
**MRPF classification:** MERGE gate × **AGENT BEHAVIOR** (the frontend finder governs whether completed runs render in the gallery → propagates to future sessions) × NORMAL severity.
**Topology:** Sequential Gemini → integrate → Codex (HARD RULE). Reviewer order honored.

---

## The bug class

The research brief (`claude-prompt.md` step 5) instructs `claude -p` to write a state file named exactly **`state.json`**. Multiple helpers located it with `endsWith("-state.json")` (dash-prefixed), which does NOT match the plain name (`"state.json".endsWith("-state.json") === false`). Latent since S25-27 (`6d35086`); masked for months by credit-out failures killing jobs pre-completion; surfaced S82/S83 once a job ran end-to-end. Core finder fixed + shipped in `agent/executor.ts` (`8b32c97`); these are the 3 remaining sibling sites.

## The 3 sites fixed (canonical pattern: prefer exact `state.json`, fall back to legacy `-state.json`)

| Site | File | Semantics | Fix shape |
|---|---|---|---|
| 1 | `frontend/lib/storage.ts` `findStateFile()` | Gallery read path (`/api/runs`, `/api/state`) — completed-run visibility | prefer-exact-then-fallback + `console.warn` when neither matches |
| 2 | `agent/scripts/regenerate-studio-products.ts:~392` | Studio-only re-run; resolves parent `notebook_id` | `candidateFiles` var + prefer-exact-then-fallback; error string `*-state.json`→`state.json` |
| 3 | `agent/scripts/lint-deliverables.ts:~163` | Dev lint tool; sanity-checks state file | COMBINED filter (collects both names) — intentional divergence: linter iterates ALL state files |

## What each reviewer saw
- **Gemini (gemini-3.1-pro-preview):** diff-only — the 3 sibling diffs + the shipped `8b32c97` finder for retrospective context. No full-repo access.
- **Codex (`codex exec -s read-only`):** read the actual sandbox files + `agent/executor.ts` canonical pattern in its sandbox; grep'd the live codebase for other missed sites.

## Round 1 — Gemini (APPROVE; 16,749 tokens, ~26s)
- **Retrospective on `8b32c97`:** APPROVE. [NIT] `fs.readdir` ordering nondeterminism if a workdir held multiple legacy `-state.json` files and no `state.json` — negligible given dedicated per-job workdirs; fix correctly prefers exact match. → no action.
- **Site 1:** [MINOR] add a `console.warn` when neither name matches (silent gallery-invisibility is hard to debug). → **ACCEPTED** (integrated).
- **Site 2:** [NIT] `(parentFiles ?? [])` double-eval/double-iterate. → **ACCEPTED** (extracted `candidateFiles` var).
- **Site 3:** [NIT] filter-vs-find divergence is semantically correct for a linter. → no action (confirmed intentional).
- **Deploy reasoning:** confirmed correct (frontend needs push-clone→Vercel; the two `agent/scripts/` files run as on-demand subprocesses, no daemon restart).
- **Blast radius:** "very low — worst case is previously-invisible jobs now correctly appear."

## Round 2 — Codex (APPROVE; 55,501 tokens) on integrated v2
- **Verdict: APPROVE. Findings: None.**
- Confirmed all 3 fixes match the canonical `agent/executor.ts:1135` pattern.
- Confirmed Site-3 combined-filter divergence is correct (lint iterates all state files).
- Type-safety fine by inspection; matches reported `tsc --noEmit` green.
- **Grep-verified no other production site** still carries the `-state.json`-only bug (only stale references in docs/logs/archived sandbox snapshots — not runtime paths).

## Verification
- `pnpm test` (grep guard + `tsc --noEmit` on agent AND frontend) GREEN with all 3 files swapped into live (run twice: post-fix v1, and post-Gemini-integration v2).
- No new unit tests added: these are 1-line predicate widenings mirroring an already-shipped+verified fix (`8b32c97`, verified end-to-end on job 70240d51). The agent-side core finder change carries the test coverage; these siblings are mechanical mirrors. **Test-coverage answer (required under AGENT BEHAVIOR): covered transitively by the verified core fix; net new test value is low for 1-line mirror predicates.**

## Resolution: APPROVE — promote all 3.

## Deploy plan
- `agent/scripts/regenerate-studio-products.ts`, `agent/scripts/lint-deliverables.ts`: take effect on next on-demand invocation. **No worker restart needed** (verified: neither is statically imported by `worker.ts`; `regenerate` is spawned via `node --import=tsx`, `lint` is a standalone CLI).
- `frontend/lib/storage.ts`: requires push-clone (`Dynamic Research/frontend/` → `c:/tmp/Dynamic-Research/frontend/`) → commit → push → Vercel auto-deploy. 3-way diff reconcile first per `feedback_pushclone_divergence_reconcile`.
