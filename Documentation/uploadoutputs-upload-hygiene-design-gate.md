# uploadOutputs upload-hygiene — DESIGN gate (MERGE-B)

> Status: DRAFT for sequential MRPF (Gemini → integrate → Codex). DESIGN × AGENT BEHAVIOR × NORMAL.
> Origin: Codex S87 MERGE-gate CRITICAL "B2", deferred with risk-acceptance. Dynamic Research S88 (2026-06-04).
> Decision requested of reviewers: choose between **Option A** and **Option B** below (resilience-vs-simplicity tradeoff), or propose a better third shape.

> **Round 2 — Codex (code-grounded, `codex exec -s read-only`): APPROVE_WITH_CHANGES → concurs Option A; B stays withdrawn.** No CRITICAL/blocking findings → **DESIGN gate CLOSED on Option A (v3).** What Codex saw: integrated v2 note + grounded reads of executor.ts (uploadOutputs + sole call site + executeJob finally/studio-only branch), storage-paths.ts (uploadWithAudit/upsert/audit-row), conventions.ts isSkipFile, the RLS migration, and frontend storage/file-route caching. Grounded confirmations: (1) `uploadOutputs` has exactly ONE live caller (executor.ts:551) — other grep hits are docs/sandbox; signature change is safe. (2) `studio_only` branches to `runStudioOnly()` and completes BEFORE `uploadOutputs` (executor.ts:416-422, 735-743) — A doesn't touch it; `regenerate-studio-products.ts` uploads directly (upsert:true) — out of scope. (3) `upsert:true` is safe: audit insert identical for fresh/overwrite (storage-paths.ts:132-142), service-role bypasses RLS, signed URLs per-request (media redirect privately cached 3500s — a UI freshness nuance, not a correctness blocker). Findings integrated into §3/§6/§8 (v3).
>
> **Round 1 — Gemini 3.1 Pro (Deep Think): APPROVE → recommend Option A.** What Gemini saw: the design note + grounded reads of `agent/executor.ts` (uploadOutputs/verify), `conventions.json` skip_files, `find-state-file.ts`, `frontend/lib/files.ts`, the `/research-compare` skill, AND live local `Projects/<slug>/` contents for an independent completed run. **Decisive finding (author-verified against skill lines 926/941/953):** `.docx` and `.pdf` deliverables are *born inside* `Projects/` — Phase 6 **Step C Pandoc Conversion** runs `pandoc "$f" -o "${f%.md}.docx"` on the `.md` files *already copied into Projects/* (line 941), and the **Bug 23** workaround copies `.pptx → .pdf` inside Projects/ (line 953). They **never exist in workDir**. → Option B (workDir-sourced) would silently DROP every `.docx`/`.pdf` deliverable. This refutes B's only claimed advantage (resilience) and makes **A the only correct path**. Gemini findings integrated into §2/§4/§5/§6 below (v2).

---

## 1. Problem statement

`agent/executor.ts:uploadOutputs(job, workDir, projectsDir)` (def @1263, called @551) uploads the union of two directories — `[projectsDir, workDir]` — to Supabase Storage at the scoped prefix `<org>/<slug>/`, deduped by exact filename, with `upsert: false`.

This is wrong on two axes:

1. **Stale + scratch leak.** The per-slug `workDir` (`C:/tmp/research-compare/<slug>`) is **reused across re-queues of the same slug**, so it accumulates files from every prior run. The current skip-list (`agent/lib/conventions.json` → `skip_files`) does NOT exclude:
   - stale prior-run deliverables: `20260602-185318-{brief,report,comparison,...}.md` (timestamp-prefixed, no skip match)
   - scratch the skip-list misses: `persona.txt`, `persona-studio.txt`, `persona-*-<date>.txt`, `research-plan.json`, `research-status.json`, `tier1-passed-urls-<date>.txt`
   - the current run's timestamp-named copies, which **duplicate** the projectsDir slug-named deliverables under a *different* name (dedupe-by-exact-name does not merge them).

   All of these get uploaded and become **user-visible**: `frontend/app/api/runs/[slug]/files/route.ts` → `buildFileInventoryFromStorage()` (`frontend/lib/files.ts:239`) lists **every** storage object with no role/skip filtering (it only classifies by extension). So a re-queued slug's gallery file inventory shows stale runs + scratch.

2. **Re-queue conflict-fail.** With `upsert: false`, re-queuing a slug whose deliverables already exist in scoped storage (from a prior successful run) makes the upload **conflict** → `uploadWithAudit` returns `!ok` → `uploadResult.failed.length > 0` → `failJob` (executor.ts:565). A successfully-re-run job is reported as failed purely because its output filenames already exist.

Neither regresses the **fresh-slug happy path** (fresh slug → fresh empty workDir → empty scoped prefix → no stale siblings, no conflict), which is why this lay dormant until reuse (e18e1931).

---

## 2. Verified data-flow facts (S88, against live code + the e18e1931 workdir/storage)

These are the load-bearing facts behind the options. All verified this session, not recalled.

- **`projectsDir` (`Dynamic Research/Projects/<slug>/`) is the COMPLETE, curated, canonical deliverable set.** The `/research-compare` skill (`~/.claude/commands/research-compare.md`) **Phase 6 Step B "Copy Final Outputs to Projects Folder"** (lines 868–878) copies *all* deliverables — markdown research files **and** studio products — from workDir into `Projects/<slug>/`:
  ```
  cp .../TIMESTAMP-*.md   Projects/<slug>/
  cp .../TIMESTAMP-*.mp3  Projects/<slug>/   # audio
  cp .../TIMESTAMP-*.mp4  Projects/<slug>/   # video
  cp .../TIMESTAMP-*.pptx Projects/<slug>/   # slides
  cp .../TIMESTAMP-*.png  Projects/<slug>/   # infographic
  ```
  On copy the files are **renamed** to canonical slug-prefixed names (research files) / title-prefixed names (report, studio products), per the `files_written` `-> ... in Projects` mappings in state.json.
- **`projectsDir` is overwritten-in-place each run** (slug/title-prefixed names are stable across re-runs of the same slug) → it does NOT accumulate stale siblings the way the timestamp-named workDir does. **Studio re-generate versioning (Gemini-confirmed, RESOLVED):** studio products carry `TIMESTAMP` + `-vN`, so a re-generate leaves BOTH `v1` and `v2` in Projects/ — this is *intended versioning*, not a stale vector: `buildFileInventoryFromStorage` (`frontend/lib/files.ts:239`) parses `version`/`variant`, groups by product, and sorts version-descending so the latest surfaces as the gallery default. Option A faithfully uploading all of projectsDir preserves this version history correctly.
- **`.docx` and `.pdf` deliverables are BORN in `Projects/`, never in workDir (Gemini-found, author-verified):** skill Phase 6 **Step C** runs Pandoc on the `.md` files *already in Projects/* → `.docx` (line 941); the **Bug 23** workaround copies slide `.pptx → .pdf` *in Projects/* (line 953). Consequence: any upload path that sources from workDir (Option B) structurally cannot see docx/pdf. Only a projectsDir-sourced upload (Option A) captures the complete set.
- **e18e1931 ground truth:** workDir held two runs (`20260602-185318-*` stale phase-0, `20260603-215929-*` current phase-6) + ~12 scratch files. `Projects/<slug>/` held exactly the 12 canonical slug-named deliverables. Scoped storage currently holds those same 12 (written by the S87 recovery + skill flat-upload — NOT by uploadOutputs, which never ran for this job).
- **`files_written` (state.json) is UNRELIABLE as a machine manifest** — it is free-text LLM prose, e.g. `"Pandoc-generated .docx companions for brief, perplexity, notebooklm, comparison, vendor-evaluation"` is one array entry and is not a filename. It cannot be parsed into an upload allow-list.
- **The selected state file carries the run's embedded timestamp** (`<YYYYMMDD>-<HHMMSS>-state.json`), already parsed by `agent/lib/find-state-file.ts:embeddedStateTimestampMs()` (S87). The current run's workDir deliverables share that `<YYYYMMDD>-<HHMMSS>-` prefix.
- **`regenerate-studio-products.ts` does NOT use `uploadOutputs`** — it uploads each studio product directly via `uploadWithAudit({ upsert: true })` (line ~623). So the studio-only path is already idempotent and is out of scope for this change.

---

## 3. Option A — projectsDir-only + `upsert:true` + empty-guard  *(author's recommendation)*

Upload **only** `projectsDir`. Drop the `workDir` source from `uploadOutputs` entirely.

```
// was: for (const source of [projectsDir, workDir]) { ... enumerate ... }
// now: enumerate projectsDir directly (collapse the loop — Gemini NIT), so
//      uploadOutputs no longer needs the workDir parameter at all.
const entries = await fs.readdir(projectsDir);   // single source
...
uploadWithAudit({ ..., upsert: true })           // was upsert: false
```
*(Signature change: `uploadOutputs(job, projectsDir)` — drop the now-unused `workDir` param; update the call site @551.)*
Plus an empty-guard, placed **caller-side** (Codex MINOR): `uploadOutputs` returns its `{uploaded, failed}` (and, for the guard, the count of selectable files) but does NOT throw internally — the existing failure contract is `failJob` + `notifyTerminal` + `throw` in `executeJob` (executor.ts:553-570), with `recordUsage` in the `finally` (576-587) preserving failed telemetry. A naked throw inside `uploadOutputs` would skip `failJob`/notification and mis-order telemetry. So: if the selected upload set is **empty**, the caller runs the same `failJob`+`notifyTerminal`+`throw` path with an explicit reason (`"Pipeline verified complete but no uploadable deliverables in Projects/<slug>/ — copy-to-Projects (skill Phase 6 Step B/Pandoc Step C) did not run"`) BEFORE `completeJob` (570).

**Why it's correct:** §2 establishes projectsDir is the complete canonical set, so workDir contributes nothing but leakage + the dupe/scratch/stale problem. Removing it eliminates all three leak vectors *and* the dupe problem in one move. `upsert:true` makes re-queue idempotent (a re-run replaces its own prior deliverables — the desired semantics for "re-run this slug").

**Tradeoff (the resilience cost):** the current `[projectsDir, workDir]` union is an implicit safety net — if the skill reached phase-6-complete but Step B's `cp` partially failed (a deliverable exists in workDir but never made it to Projects/), the workDir source would still upload it. Option A removes that net. The **empty-guard** converts the *total*-copy-failure case into a loud failure; it does NOT catch a *partial* copy failure (some files in Projects/, one missing). Argument for accepting this: Step B is a batch `cp` near the end of a verified-complete pipeline; a partial failure that leaves Projects/ non-empty but missing one deliverable is rare, and `files_written` is too unreliable to detect it anyway.

**Diff size:** ~5 lines in one function + ~6-line guard + tests. Smallest, most legible.

---

## 4. Option B — projectsDir-primary + filtered-workDir fallback + `upsert:true`

Keep both sources but make workDir contribution **current-run-only and non-duplicative**:
- Upload all of `projectsDir` (primary).
- From `workDir`, include a file ONLY if its name starts with the selected state file's `<YYYYMMDD>-<HHMMSS>-` prefix (excludes stale prior-run siblings) AND it is not already represented in projectsDir.

**The hard part — the dupe problem:** the same logical deliverable has two names (`20260603-215929-brief.md` in workDir, `i-am-...-brief.md` in projectsDir). A naive name-dedupe won't merge them, so the workDir copy would upload as a *second* gallery entry. To make B correct you must map each candidate workDir file to its canonical projectsDir name (via the `files_written` `->` mapping — but that's unreliable prose, §2) or by reconstructing the rename rule (slug-prefix for research files, title-prefix for report/studio — duplicating skill logic in the worker). This couples the worker to the skill's naming convention and is fragile.

**Upside:** preserves the safety net for partial-copy-failure (a workDir-only deliverable for the current run still ships).

**Diff size + risk:** materially larger; re-implements naming/rename logic that lives in the skill; higher chance of a subtle mismatch (e.g. report's title-prefix) silently dropping or dupe-shipping a file.

**DISQUALIFYING (Gemini Round 1):** B's claimed upside is illusory. The derived deliverables `.docx` (Pandoc, skill line 941) and `.pdf` (Bug 23, line 953) are generated *inside* `Projects/` and are **never** present in workDir, so B's workDir source cannot ship them — B would systematically DROP every docx/pdf from re-queued runs. B is therefore not a safer-but-complex alternative; it is *incorrect*. Option B is withdrawn.

---

## 5. Recommendation

**Option A.** §2 makes the workDir source provably redundant for the happy path, and the only thing B buys over A is partial-copy resilience — which B cannot deliver cleanly without re-implementing the skill's rename rules in the worker (a worse coupling than the bug we're fixing). A's empty-guard covers the realistic failure (Step B didn't run at all); the residual (Step B ran but dropped one file) is low-probability, undetectable without a reliable manifest, and would surface as a visibly-incomplete gallery the user can re-queue.

**Open question — RESOLVED (Gemini Round 1).** The flip-condition was "a deliverable legitimately workDir-only at upload time." Gemini confirmed there is **none**: every deliverable either lands in Projects/ via Step B's `cp` (md/mp3/mp4/pptx/png) or is *generated inside* Projects/ (docx via Pandoc Step C line 941; pdf via Bug 23 line 953). The only workDir-exclusive files are scratch (`persona.txt`, `research-plan.json`, raw pre-rename artifacts) — all unwanted. Far from being a risk, the docx/pdf-in-Projects fact makes A *strictly more correct* than B (which would drop them). **Recommendation hardened to: Option A, unconditional.**

---

## 6. Test plan (node --test, agent/test/)

1. **stale-sibling exclusion** — workDir with `20260602-*` + `20260603-*`, projectsDir with current slug-named set → uploaded set == projectsDir set only; no `20260602-*`, no `2026*-*` timestamp-named, no scratch.
2. **scratch exclusion** — projectsDir-only path never sees `persona.txt`/`research-plan.json`/etc. (trivially true for A; explicit for B).
3. **re-queue idempotency (upsert:true)** — Codex MAJOR: the pure `selectUploadSet` cannot prove the IO loop passes `upsert:true`. Cover this at the IO-loop level via an **injectable uploader seam** (default = `uploadWithAudit`; tests pass a mock) — assert the loop calls the uploader with `upsert:true`, and that a second upload of an already-present slug yields `failed.length===0` (does not `failJob`).
4. **empty / all-skipped guard** — Codex MINOR: test both (a) empty projectsDir AND (b) projectsDir containing only skip-list/non-file entries → selected set empty → caller fails loudly with the Step-B/Step-C reason (not silent success).
5. **happy path parity** — fresh slug, projectsDir == full canonical set → identical uploaded set to pre-change behavior (no regression for the common case).
6. *(Option B only)* current-run prefix filter + dupe-suppression correctness.

`uploadOutputs` is currently not directly unit-tested (it does real Supabase IO). Plan: extract the *file-selection* logic into a pure helper and keep the IO loop thin (mirrors the S87 `find-state-file.ts` extract-pure-core pattern). Two Codex refinements:
- **Helper input is `Dirent[]`, not `string[]` (Codex NIT):** the current loop filters non-files via `stat.isFile()` (executor.ts:1278-1280); a string-only helper applying just `isSkipFile` could select subdirectories. Signature: `selectUploadSet(entries: {name: string; isFile: boolean}[]) → {remoteName: string}[]` (use `fs.readdir(dir, {withFileTypes:true})`). Assert `selectUploadSet([])` and an all-skipped/all-dir input both return `[]` (Gemini NIT — tested precondition for the caller's empty-guard).
- **Uploader seam for the IO loop (Codex MAJOR):** parameterize the uploader (default `uploadWithAudit`) so a mock can assert `upsert:true` + idempotent re-upload without live Supabase.

---

## 7. MRPF classification

- **Event gate:** this design note = DESIGN (approach decision); the subsequent code change = MERGE.
- **Risk labels:** AGENT BEHAVIOR (worker upload behavior, propagates to every future job + gallery), DATA (what lands in tenant storage). Not SECURITY (path scoping unchanged — still `scopedStoragePath`/`uploadWithAudit`).
- **Severity:** NORMAL.
- **Topology:** sequential **Gemini → integrate → Codex** at both the DESIGN gate (this note) and the MERGE gate (the code).
- **Test mandate (AGENT BEHAVIOR/DATA):** yes — covered by §6; the pure-selection extract makes it unit-testable without live IO.

---

## 8. Scope boundary + residual nuances (Codex Round 2)

- **[MAJOR — scoped OUT, documented] Existing already-polluted galleries are NOT cleaned by this gate.** Option A stops *future* uploadOutputs runs from writing stale/scratch objects, but any such objects already in `<org>/<slug>/` from a prior buggy run remain listed (`listFiles` returns every object; `buildFileInventoryFromStorage` pushes all). Mitigants: (a) historically uploadOutputs rarely ran to completion — credit-outs/verify-fails killed most jobs before upload — so real scoped-path pollution is limited; (b) e18e1931's scoped path is already clean (12 files, written by the S87 recovery, no stale siblings); (c) the legacy-flat-path cleanup script already runs ≥2026-06-23. **Decision: a one-time scoped-path reconcile sweep is a separate AUDIT-gate follow-up, not part of this MERGE** — flagged in the handoff so it isn't lost. If a specific polluted slug surfaces, the S87 recovery-script pattern cleans it ad hoc.
- **[MINOR — accept] Overwrite + media redirect cache.** On re-queue, `upsert:true` overwrites prior media; the file redirect route caches media privately for 3500s (`frontend/app/api/runs/[slug]/file/[filename]/route.ts:88-97`), so a client could briefly see pre-overwrite media. This is a UI freshness nuance, not an upload-correctness issue; re-queue-then-overwrite of the same slug is rare. Accept; no action.
