# uploadOutputs upload-hygiene — DESIGN-gate peer review (verbatim)

> Companion to `uploadoutputs-upload-hygiene-design-gate.md`. Sequential MRPF, DESIGN × AGENT BEHAVIOR × NORMAL.
> Topology: Gemini 3.1 Pro Deep Think (Round 1, holistic) → integrate v2 → Codex `exec -s read-only` (Round 2, code-grounded).
> Outcome: **Gemini APPROVE / Codex APPROVE_WITH_CHANGES — unanimous on Option A, no CRITICAL. Gate CLOSED on Option A (v3).**
> Decision: Option A (projectsDir-only + upsert:true + caller-side empty-guard). Option B WITHDRAWN (would drop docx/pdf — born in Projects/, never in workDir).

## What each reviewer saw
- **Gemini (Round 1):** design note v1 + grounded reads of executor.ts (uploadOutputs/verify), conventions.json skip_files, find-state-file.ts, frontend/lib/files.ts, the /research-compare skill, AND live local Projects/<slug>/ of an independent completed run.
- **Codex (Round 2):** integrated v2 note + grounded reads of executor.ts (uploadOutputs + sole call site + executeJob finally/studio-only branch), storage-paths.ts (uploadWithAudit/upsert/audit-row), conventions.ts isSkipFile, the Phase-B RLS migration, frontend storage.ts + file-route caching.

---

## Round 1 — Gemini 3.1 Pro Deep Think (VERBATIM)

**VERDICT:** APPROVE

### 1. Verdict & Recommendation
**Recommend Option A.** 

Option A is cleanly correct, highly resilient, and avoids fragile coupling to the skill's file-naming logic. By sourcing exclusively from `projectsDir` and enabling `upsert: true`, it treats `Projects/<slug>/` as the canonical build artifact directory and gracefully handles re-queues. Option B introduces complexity that is actively harmful, as it fails to account for deliverables generated *after* the `workDir` copy step.

### 2. Validation of §2 Facts
**Confirmed.** 
- **(a) Canonical Set:** `Projects/<slug>/` is indeed the complete, curated deliverable set. I verified this against live local storage (`Projects/what-are-the-three-primary-colors-in-add-42acc53b`). It contains exactly the renamed `slug`-prefixed and `title`-prefixed files, and ZERO stale timestamp-named duplicates or scratch files.
- **(b) Missing Globs & `.docx` Routing:** Step B's `cp` globs (`*.md *.mp3 *.mp4 *.pptx *.png`) do **not** miss any raw extensions. Crucially, `.docx` and `.pdf` files are **never** in `workDir` to begin with. 
  - **How `.docx` reaches `Projects/`:** In the `~/.claude/commands/research-compare.md` skill, Phase 6 Step C executes Pandoc *inside* the `Projects/` folder (`$PANDOC "$f" -o "${f%.md}.docx"` on the already-copied `.md` files). 
  - **How `.pdf` reaches `Projects/`:** NotebookLM slides are downloaded as `.pptx` in `workDir`. The Bug 23 workaround (in Phase 6 Step C) copies them to `.pdf` natively *inside* `Projects/`.
  - **Conclusion:** Option A natively captures `.docx` and `.pdf` because it reads `ProjectsDir` after the skill finishes. Option B's reliance on `workDir` would completely **drop** these derived deliverables. Option A is not just simpler; it is the only correct path.

### 3. Answer to §5 Open Question (workDir-only deliverables)
**No.** There is no pipeline path where a deliverable is legitimately `workDir`-only at upload time. The only files that remain exclusively in `workDir` are scratch files (`persona.txt`, `research-plan.json`) and raw pre-rename artifacts, all of which are explicitly unwanted leakage. Option A safely leaves them behind.

### 4. Studio Re-generate Accumulation
**It is intended versioning.** A Studio re-generate *does* leave multiple versions (e.g., `-v1`, `-v2`) in `Projects/`. However, this is not a stale-accumulation bug. `frontend/lib/files.ts` (`buildFileInventoryFromStorage` ~line 239) explicitly parses version and variant suffixes (e.g., `-v5a`), groups them by product, and sorts them descending (`b.version - a.version` and `vb.localeCompare(va)`) so the LATEST version surfaces as the default in the UI. Option A faithfully uploading the entirety of `ProjectsDir` correctly preserves this gallery history.

### 5. Leak Vectors, Correctness Bugs & Test-Gaps
- **[MINOR] `executor.ts` Correctness / Empty Guard:** As proposed, your empty-guard is critical. Because Option A removes the `workDir` safety net, if the Phase 6 `cp` completely fails, `projectsDir` will be empty. The `failJob` guard prevents a silent `success: true` with 0 files. 
- **[NIT] `executor.ts` Code Legibility:** With Option A, you can collapse the `for (const source of [projectsDir, workDir])` loop entirely in `uploadOutputs` (~line 1263) and just read from `projectsDir` directly.
- **[NIT] Test-Gap:** When implementing the pure `selectUploadSet` test helper as suggested in §6, ensure you add a test explicitly asserting that an empty `projectsDirEntries` list triggers the empty-guard failure condition.

---

## Round 2 — Codex (code-grounded, exec -s read-only) on integrated v2 (VERBATIM)

VERDICT: APPROVE_WITH_CHANGES

I concur with Gemini and the author on Option A: `Projects/<slug>/` is the correct upload source for the full-pipeline executor path, and Option B should remain withdrawn.

**Findings**
[MAJOR] Existing polluted storage is not cleaned by Option A. Future uploads stop reading `workDir`, but any stale/scratch objects already uploaded under `<org>/<slug>/` will still be listed because `listFiles()` returns every storage object (`frontend/lib/storage.ts:142-168`) and `buildFileInventoryFromStorage()` pushes every file (`frontend/lib/files.ts:244-258`). Add an explicit scope note or a one-time/reconcile cleanup if this gate is meant to fix already polluted galleries.

[MAJOR] The test plan’s pure-helper extract does not verify the `upsert:true` behavior. `selectUploadSet()` can test stale/scratch exclusion, but not that the IO loop calls `uploadWithAudit({ upsert: true })` instead of the current `false` (`agent/executor.ts:1306-1315`; `agent/lib/storage-paths.ts:118-123`). Add an injectable/mock uploader seam or thin IO-loop test so re-queue idempotency is actually covered.

[MINOR] Specify the empty guard as caller-side, after selecting uploadable files and before `completeJob()`. The current good failure pattern is `failJob` + `notifyTerminal` + throw before `completeJob` (`agent/executor.ts:553-570`), with `recordUsage` in `finally` preserving failed telemetry (`agent/executor.ts:576-587`). A naked throw inside `uploadOutputs()` would skip `failJob`/notification. Also test “all entries skipped/non-files”, not only literally empty dirs (`agent/executor.ts:1276-1280`; `agent/lib/conventions.ts:102-110`).

[NIT] If extracting `selectUploadSet(projectsDirEntries)`, either pass `Dirent[]` or pre-filter to files. The current function filters non-files with `stat.isFile()` (`agent/executor.ts:1278-1280`); a string-only helper applying just `isSkipFile()` could accidentally select subdirectories.

**Grounded Checks**
Other callers: live repo code calls `uploadOutputs()` only at `agent/executor.ts:551`; the other grep hits are docs/sandbox snapshots. Dropping `workDir` from the signature only requires updating that call and the private function definition at `agent/executor.ts:1263`.

Studio-only: `executeJob` creates `Projects/<slug>/` (`agent/executor.ts:398-403`) but branches to `runStudioOnly()` before `uploadOutputs()` (`agent/executor.ts:416-422`). `runStudioOnly()` completes directly (`agent/executor.ts:735-743`), while `regenerate-studio-products.ts` uploads directly with `upsert:true` (`agent/scripts/regenerate-studio-products.ts:623-632`) and keeps local named copies in `workDir`, not Projects (`agent/scripts/regenerate-studio-products.ts:606-610`). Option A will not miss studio-only deliverables because that path does not use `uploadOutputs()`.

`upsert:true`: `uploadWithAudit()` passes `opts.upsert` directly to Supabase (`agent/lib/storage-paths.ts:118-123`). The audit insert is identical for fresh writes and overwrites: it records caller/org/queue/path/bytes/status only (`agent/lib/storage-paths.ts:132-142`). RLS is not a blocker because executor uses the service role key (`agent/executor.ts:49`, `agent/executor.ts:84`), and audit RLS allows authenticated select only while service role bypasses insert policy (`supabase/migrations/20260523_phase_b_auth_rls_helpers.sql:498-511`). Signed URL generation is per request (`frontend/lib/storage.ts:226-242`), though media redirects are privately cacheable for 3500s (`frontend/app/api/runs/[slug]/file/[filename]/route.ts:88-97`), so immediate client freshness after overwrite is a UI/cache concern, not an upload correctness blocker.

---

## Synthesis (author)

Unanimous on **Option A**, no blocking/CRITICAL findings → gate CLOSED. Gemini's decisive contribution: docx/pdf are born inside Projects/ (Pandoc Step C / Bug 23), never in workDir → Option B is not merely complex but *incorrect* (would drop them) → B withdrawn. Codex's code-grounded contributions, all integrated into the design note v3 as implementation spec:
- [MAJOR] existing already-polluted scoped storage isn't cleaned by A → scoped OUT to an AUDIT follow-up (§8); real-world pollution limited (uploadOutputs rarely completed historically).
- [MAJOR] pure selectUploadSet can't prove upsert:true → add an injectable uploader seam + IO-loop test (§6).
- [MINOR] empty-guard must be caller-side (failJob+notifyTerminal+throw before completeJob), not a naked throw in uploadOutputs; test all-skipped too (§3/§6).
- [NIT] helper takes Dirent[]/{name,isFile}, not string[] (avoid selecting subdirs) (§6).
- [MINOR/accept] upsert overwrite + 3500s media redirect cache = UI freshness nuance, not correctness (§8).

Implementation proceeds on Option A; the CODE then gets its own MERGE-gate sequential Gemini→Codex review.
