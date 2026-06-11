# Phase 2 (frontend file-upload) — MERGE-gate peer review synthesis

**Gate:** MERGE · **Risk labels:** SECURITY, DATA, ARCHITECTURE · **Severity:** NORMAL
**Topology:** Sequential — Gemini (holistic-adversarial) → integrate → Claude grounded-adversarial INTERIM → integrate → **Codex (grounded-adversarial) REAL pass** → integrate.
**Change:** PDF/TXT/MD attachments for research submissions. Signed-upload-URL staging (`<orgId>/uploads/<draftId>/`) → submit-time verify+copy into `<orgId>/<slug>/sources/` → row insert. Clone & Edit + Replay carry parent attachments (`origin:"parent"`). UI flag-gated `NEXT_PUBLIC_ATTACHMENTS_ENABLED` (OFF in prod).

**Files reviewed:** `frontend/lib/attachments-copy.ts`, `frontend/lib/storage.ts`, `frontend/app/api/queue/attachments/route.ts`, `frontend/app/api/queue/route.ts`, `frontend/app/api/runs/[slug]/replay/route.ts`, `frontend/app/api/runs/[slug]/manifest/route.ts`, `frontend/components/new-research/StepTopic.tsx`, `frontend/hooks/useNewResearchForm.ts`, `frontend/components/new-research/StepReview.tsx`, `frontend/lib/__tests__/attachments.test.ts`. Phase-1 supporting: `storage-paths.ts`, `attachments-constants.ts`, `validate.ts`.

---

## What each reviewer saw

| Reviewer | Lens | Scope seen | Verdict |
|---|---|---|---|
| **Gemini 3.1 Pro** (S104) | holistic-adversarial (breadth) | Whole Phase-2 diff as text + repo pointers | BLOCK → 4 findings, all integrated |
| **Claude grounded subagent** (S104, LABELED INTERIM) | grounded-adversarial (depth) | Live working-tree files + `@supabase/storage-js` source | APPROVE-WITH-CHANGES → 6 MINOR, integrated; tenant isolation CONFIRMED |
| **Codex gpt-5.5** (S105, REAL) | grounded-adversarial (depth), `codex exec -s read-only` xhigh | Live working-tree files; static counterexamples (sandbox blocked `node`/`pnpm` runtime) | **BLOCK → 4 findings, all integrated** |

The Codex pass was OWED from S104 (ChatGPT auth had died mid-gate, `refresh_token_reused`). Auth recovered by S105; verified with a real `codex exec` returning analysis (not just `login status`, which had lied). This closes the reduced-cross-vendor-independence posture — all three lineages (Claude author + Gemini + Codex) now exercised.

---

## Codex (REAL grounded-adversarial) — BLOCK → 4 findings, ALL integrated (S105)

**Codex CONFIRMED no cross-tenant (org-A→org-B) path escape** in mint, delete, submit, replay, or manifest — every storage path is built from the caller's session/env-resolved `orgId`, and the path helpers reject traversal. It also re-verified the two prior BLOCKING fixes (#1 TOCTOU size re-verify, #2 manifest `.maybeSingle()` error→500) as **correct**. The 4 new findings:

### 1. BLOCKING — clone parent attachment silently dropped on `storedName` collision → FIXED
`sanitizeAttachmentName` lowercases (`Report.pdf`→`report.pdf`) and de-dupes only against the `existingNames` the mint route passes — which were **server-listed staging files only, not parent carry-overs**. So a clone carrying parent `report.pdf` + a fresh upload `Report.pdf` mint the SAME `storedName`; both then resolve to the same submit-time destination, and `removeFromForm(storedName)` filtered ALL form items with that name → removing a staged upload also dropped the parent carry-over. Submit then silently persisted a row missing the parent attachment.
**Fix (defense-in-depth, three layers):**
- **Server, load-bearing:** `buildCopyPlan` now throws on any duplicate `storedName` (same destination `toPath`) → submit fails LOUD (400), independent of client behavior. Unit-tested (`buildCopyPlan: throws on duplicate storedName across origins`).
- **Client UX:** mint route accepts an optional bounded+shape-validated `reservedStoredNames[]`; `StepTopic` sends the current form's storedNames (parent + staged), so a colliding upload gets a `-1` suffix instead of failing at submit.
- **Removal correctness:** `removeFromForm` now scopes to `origin:"staging"` items, so removing a staged chip can never collaterally drop a parent carry-over.

### 2. MAJOR — accepted "24h staging TTL" not in shipped code + staging not deleted post-submit → PARTIALLY FIXED (cheap half now; daemon stays Phase 3)
The copy-to-sources path returned success but never deleted the consumed staging objects, and no sweep existed for `<orgId>/uploads/*`.
**Fix (split):**
- **Now:** new `removeStagedFiles(orgId, draftId, storedNames)` (best-effort, never throws) is called after a successful insert in the submit route, for staging-origin items only — bounds the common case (successful submit) immediately. The plan's "staging best-effort deleted" intent is now real in code.
- **Phase 3 (already planned, item 3):** `agent/scripts/cleanup-staging-uploads.ts` TTL daemon for ABANDONED drafts (minted/uploaded, never submitted). The remaining unbounded surface is bounded by the mint rate-limit until that lands. Documented here so it isn't lost.

### 3. MINOR — Supabase `remove()` `{error}` silently ignored in cleanup paths → FIXED
The SDK's `remove()` RESOLVES `{ data, error }` on storage failure rather than rejecting, so the prior `.remove(paths).catch(...)` and `removeRunSources`'s discarded result swallowed the common failure mode, leaving orphans with no log signal.
**Fix:** new `bestEffortRemove(supabase, paths, context)` helper inspects BOTH the resolved `error` and a thrown exception, logs either (with a call-site `context` for tracing), never throws. All 4 cleanup sites + `removeRunSources` + the new `removeStagedFiles` route through it.

### 4. MINOR — replay second parent lookup ignored its error → silent lineage loss → FIXED
The replay route ran two parent queries: the first proved existence (org-scoped, error-checked) but didn't select `id`; the second fetched `id` but ignored its error, so a transient failure there set `parent_run_id → null`, silently dropping lineage.
**Fix:** select `id` in the single first (org-scoped, error-checked) query; reuse `parent.id`; delete the redundant second lookup (also one fewer DB round-trip).

---

## Prior findings (S104) — carried, all integrated

**Gemini 3.1 Pro holistic-adversarial (4):** (1 BLOCKING) TOCTOU size-spoof → post-copy size re-verify; (2 BLOCKING) manifest silent-drop on DB error → `.maybeSingle()` error→500 (no-row still `[]`); (3 MAJOR) insert-after-copy orphans → `removeRunSources` cleanup in submit+replay; (4 MINOR) mint cap race → accepted (rate-limit + submit re-verify + non-upsert single-use URL).

**Claude grounded INTERIM (6 MINOR):** read `@supabase/storage-js` to confirm `copy()`/`createSignedUploadUrl` non-upsert semantics and traced+CONFIRMED tenant isolation (orgId forced from session, never client). Integrated: replay rate-limit, swallowed-cleanup logging, delete error-taxonomy (400-shape vs 500-storage), non-upsert-as-primary-TOCTOU-guarantee comment. Accepted: within-tenant copy-any-owned-slug.

---

## Test-coverage answer (required for SECURITY/DATA changes)

The security-load-bearing decisions live in pure helpers (`attachments-copy.ts`) that ARE unit-tested: the §3b parent-carry mapping, path resolution, contract throws, and now the **duplicate-storedName dup-guard** (the BLOCKING fix). Route handlers have no frontend test harness; their logic is kept thin and delegates to the tested pure helpers + the zod schemas (also tested). The post-copy re-verify, `bestEffortRemove`, and `removeStagedFiles` are exercised indirectly via the helper contracts; full route-level integration is covered by the Phase-3 end-to-end checklist (real upload → submit → worker). Suite GREEN: **320 tests (263 agent + 57 frontend), dual `tsc --noEmit` clean, grep guard pass, EXIT 0.**

---

## Final verdict

**APPROVE-WITH-CHANGES → all changes integrated → cleared for MERGE.** Three independent lineages exercised (Claude author + Gemini holistic + Codex grounded); the only deferral is the Phase-3 staging-TTL daemon (the cheap post-submit-cleanup half landed now), which is already a planned Phase-3 deliverable and bounded by rate-limit in the interim. No cross-tenant escape found by any reviewer; tenant isolation confirmed twice (Claude-interim trace + Codex grounded). Commit to a feature branch (not `main` — `main` auto-deploys to Vercel prod and the worker doesn't read attachments until Phase 3).
