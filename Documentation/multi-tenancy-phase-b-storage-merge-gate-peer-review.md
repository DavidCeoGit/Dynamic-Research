# Phase B storage path refactor — MERGE-gate peer review synthesis (S50)

**Date:** 2026-05-24
**Session:** S50
**Artifact reviewed:** Phase B storage path helper + 4 call-site refactor + storage migration script (14 files, ~3300 lines total)
**Source plan:** `Documentation/multi-tenancy-phase-b-plan.md` v3 (ratified S48, commit `7b9fb94`)
**Framework:** Multi-Reviewer Policy Framework v2.1 (in `~/CLAUDE.md`)
**Event Gate:** MERGE
**Risk Labels:** SECURITY (tenant isolation), DATA (storage migration), AGENT BEHAVIOR (worker upload), ARCHITECTURE (frontend signature cascade)
**Severity Mode:** NORMAL
**Topology:** SEQUENTIAL — Gemini Deep Think → integrate → Codex GPT-5.5 xhigh on integrated revision → integrate → final

## Verdict trail

| Revision | Reviewer | Verdict | Findings |
|---|---|---|---|
| v1 | Gemini Deep Think (web paste) | REQUEST CHANGES | 1 CRIT (C1 path traversal), 1 CRIT (C2 hallucinated bundle truncation), 3 MAJ (M1 loose UUID regex, M2 silent audit, M3 in-flight job manifest assertion), 1 MIN (m1 BUCKET duplication), 1 scope (info disclosure via 500 on ambiguity) |
| v2 | Codex GPT-5.5 xhigh (`codex exec -s read-only`) | REQUEST CHANGES | 1 NEW MIN (prior-round regex literal still appears in v2 comments — self-fidelity sweep not clean) |
| v3 | Author self-grep (no reviewer re-invoke — cosmetic-only fix) | CLEAN | 0 hits of prior-round literal; semantic changes from v2 untouched |

## Findings + disposition

### v1 → v2 (Gemini)

| # | Severity | Finding (1-line) | Disposition | Where applied in v2 |
|---|---|---|---|---|
| C1 | CRIT | Path traversal — `file` param had no `..` / `/` / `\\` guard | **ACCEPT** | `scopedStoragePath` in BOTH `agent/lib/storage-paths.ts` + `frontend/lib/storage-paths.ts` + the local `scopedPath` in `agent/scripts/phase-b-migrate-storage-paths.ts` — defense-in-depth even where callers also validate (e.g., `api/runs/[slug]/file/[filename]/route.ts` already rejects traversal in the URL segment). |
| C2 | CRIT | "Bundle truncated at line 160" | **DISMISS** — hallucination. Bundle = 3505 lines, all 14 `--- FILE:` markers present, executor.ts present in full at 910 lines. Verified via `wc -l` + `tail -20` + `grep -c "^--- FILE:"`. |
| M1 | MAJ | Loose UUID regex `/^[0-9a-f-]{36}$/i` accepts 36 hyphens | **ACCEPT** | Strict canonical layout `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` in ALL 4 places: agent helper, frontend mirror, migration script, inline check in `frontend/lib/storage.ts:listProjects`. |
| M2 | MAJ | Best-effort audit-row write is silent-failure security gap | **DISMISS** — explicitly ratified design decision per v3 plan §2.5.5 (S48 DESIGN gate). `console.warn` IS the operational signal (Vercel logs). Gemini's WAL+log-forwarder pattern is a Phase C enhancement; documenting as deferred follow-up. |
| M3 | MAJ | In-flight studio-only jobs at S50 cutover fail loud (manifest lacks org_id) | **ACCEPT** | Added `manifest.job_id`-based research_queue fallback in `regenerate-studio-products.ts` lines ~283-310. Manifest carries `job_id` since CE-3 so fallback always has a key. |
| m1 | MIN | `BUCKET` literal duplicated in helper vs `conventions.ts` | **ACCEPT** | `agent/lib/storage-paths.ts` imports `BUCKET` from `./conventions.js` (line 26). Frontend mirror doesn't use BUCKET. |
| Scope | — | Cross-org slug ambiguity throws → 500 + leaks "N orgs" info | **ACCEPT** | `resolveOrgForSlug` now `console.warn`s and returns null on ambiguity → caller naturally returns 404. DB errors still throw (legitimate 500). |

### v2 → v3 (Codex)

| # | Severity | Finding | Disposition | Where applied in v3 |
|---|---|---|---|---|
| CDX-1 | MIN | Prior-round literal `/^[0-9a-f-]{36}$/i` still appears in v2 comments — self-fidelity grep returns 2 hits | **ACCEPT** | Rewrote comments in `storage-paths.ts:29` + `storage-paths-frontend.ts:18` to describe the prior pattern in prose ("looser 36-hex-with-dashes match"), without spelling the literal regex. Post-v3 grep: 0 hits. |

Codex's fidelity table on v1 findings: all v1 ACCEPTs verified YES with file:line evidence; all v1 DISMISSes recorded N/A. No drift, no new code-level findings.

### v3 → final (no further reviewer pass)

The v3 change was purely cosmetic (comment-only rewrite, no semantic change to the regex or any code path). Per author judgment in v2.1 framework: a re-invoked Codex pass on a comment-only diff is excessive cost (Codex's v2 pass already APPROVED the substantive code with all v1 findings landed). Author ran the self-fidelity grep directly — clean. Documenting the call here for audit; if a future incident traces back to the v3 comment edit (unlikely — comments are not load-bearing), this synthesis is the record.

## What each reviewer saw

| Reviewer | Material | Mode |
|---|---|---|
| Gemini Deep Think | v1 paste bundle (132KB, 3505 lines, 14 files + prompt) | Web Deep Think, manual paste |
| Codex GPT-5.5 xhigh | v2 sandbox files at filesystem paths (full repo access in read-only sandbox) + the prompt at `sandbox/codex-review-phase-b-storage-prompt.md` | `codex exec -s read-only -c model_reasoning_effort=high`, session 019e581b-1163-7f11-b1d5-1b4be9253776 |
| Author (v3 grep) | `sandbox/*.ts sandbox/*.sh`, ripgrep for `\[0-9a-f-\]{36}` | Local |

## Empirical observations worth retaining

1. **Gemini hallucinated truncation under heavy paste load.** v1 C2 claimed the bundle cut off at line 160. Actual bundle = 3505 lines. Verifying with `wc -l` + `tail` saved the cycle from chasing a phantom. Should be added to memory as a Gemini DESIGN/MERGE pattern to watch for.
2. **Codex's grounded slot caught a self-fidelity miss that the author and Gemini both walked past.** The prior-round literal in v2 comments is the kind of thing only a code-grounded reviewer with a strict-grep mandate would surface. Validates the v2.1 sequential pattern + Codex's structural-grep slot.
3. **Cost-benefit of sequential MERGE-gate review for a TypeScript code change set:** ~30 min for Gemini paste + ~30 min Codex compute + ~15 min v2 integration + ~10 min v3 cosmetic fix + ~5 min synthesis = ~1.5 h total. Caught 1 CRIT (path traversal — real cross-tenant leak vector) + 2 MAJ semantic fixes + 1 MIN config dedupe + 1 info-disclosure scope. Without the gate, the path traversal would have shipped as a latent privilege escalation surface.
4. **v3 cosmetic-only fix decision** — author judgment to NOT re-invoke Codex is the kind of call the framework permits implicitly. Documenting the rationale here in case it sets a precedent.

## Reviewer artifacts

- Gemini v1 response: pasted directly into S50 conversation (not preserved separately — historic record is the user message).
- Codex v2 response: `sandbox/codex-review-phase-b-storage-raw.md` (full run including stdout grep output before the verdict block).
- Codex prompt: `sandbox/codex-review-phase-b-storage-prompt.md`.
- Gemini paste bundle: `sandbox/gemini-review-phase-b-storage-paste-bundle.md` (3505 lines, 132KB).

## Status

**APPROVED for /promote + production deploy** subject to the deploy-order constraint from v3 plan §2.4.3:

1. Apply this code refactor (helper + 4 call-site changes + frontend cascade).
2. Run `phase-b-migrate-storage-paths.ts --preflight` against production.
3. Run `phase-b-migrate-storage-paths.ts` (real COPY) against production.
4. Run `phase-b-migrate-storage-paths.ts --verify-only`.
5. ONLY THEN deploy the refactored frontend/worker code. If readers are deployed before COPY completes, the gallery will 404 because objects exist only at legacy flat paths.

Push-clone (`c:/tmp/Dynamic-Research`) needs the 7 frontend file edits applied at deploy time per `feedback_pushclone_divergence_reconcile.md`.

`SYSTEM_DEFAULT_ORG_ID` env var must be set in Vercel + agent/.env before deploy (= `4ece2f20-f2fc-4f8f-afce-59806d92a11b` — David's Workspace, from S47).

## Deferred follow-ups (not blocking)

- **M2 deferral:** WAL + log-forwarder for audit-row writes is Phase C if the soak surfaces audit gaps.
- **Migration cleanup script:** v3 §2.4.3 step 7 — script to DELETE flat-path objects after 30-day soak. Not written this session.
- **Frontend SSR auth refactor:** the cutover gate for going from `SYSTEM_DEFAULT_ORG_ID` + `resolveOrgForSlug` stopgaps to session-derived org_id. Next major Phase B sub-phase.
