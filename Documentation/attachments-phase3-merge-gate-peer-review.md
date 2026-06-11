# MERGE-gate peer review — Attachments Phase 3 (worker + pipeline intake) — S106, 2026-06-10/11

## Classification (MRPF)

- **Event Gate:** MERGE
- **Risk Labels:** SECURITY (hostile file content reaching the `claude -p` prompt surface; storage deletion code) + AGENT BEHAVIOR (research-compare.md orchestrator edits — propagates to every future worker run)
- **Severity:** NORMAL
- **Topology:** Sequential, fresh code — Gemini holistic-adversarial → integrate → Codex grounded-adversarial on the integrated v2 → integrate. Both lenses prompted to BLOCK.

## Scope

NEW `agent/lib/attachments.ts` (sniffAttachment magic-byte verification + downloadAttachments SKIP-AND-RECORD intake), NEW `agent/lib/staging-sweep.ts` + `agent/scripts/cleanup-staging-uploads.ts` (24h staging-TTL sweep: lib + CLI + worker idle-tick), MOD `agent/executor.ts` (executeJob download stage; buildManifest localSourcePath/attachments/attachmentsSkipped/attachmentsPolicy; buildPrompt fenced attachments block + CRITICAL ./sources/ untrusted-DATA directive), MOD `agent/worker.ts` (idle-tick sweep), 5 edits to `~/.claude/commands/research-compare.md` (per-file Source Context Digests, digests-only to downstream legs, untrusted-DATA contract, failure-mode row), NEW tests `attachments.test.ts` (35) + `staging-sweep.test.ts` (9).

## Round 1 — Gemini 3.1 Pro (holistic-adversarial): BLOCK → 3 findings

| # | Severity | Finding | Disposition |
|---|---|---|---|
| G1 | BLOCKING | `buildManifest` localSourcePath (`WORKING_DIR/slug/sources`) could diverge from the actual download dir (`workDir`), claimed cross-job/cross-tenant bleed on slug collision | **Severity REJECTED with evidence** — `workDir` IS `path.join(WORKING_DIR, slug)` (executor.ts executeJob) so the paths were identical, and `generateSlug()` appends a per-submission random 8-hex suffix (no collision). **Structural fix still INTEGRATED:** buildManifest now takes `workDir` as a parameter and joins from it; test asserts exact equality. |
| G2 | MAJOR | OOM vector: downloadAttachments buffered the whole object via `download()`/`arrayBuffer()` trusting DB-declared sizeBytes — forged row + oversized storage object could OOM the worker | **INTEGRATED** — one `storage.list()` of sources/ per job BEFORE any download; listed metadata size must exactly equal declared sizeBytes; list failure = fail-CLOSED (all skipped, run proceeds without sources); post-download length check retained. |
| G3 | MINOR | Sweep used one 1000-entry alphabetical page — >1000 drafts permanently starve the expired tail | **INTEGRATED** — offset pagination up to MAX_PAGES=20; cap hit sets `truncated` + records an error line (no silent shortfall). |

## Round 2 — Codex gpt-5.5 (grounded-adversarial, on the integrated v2): BLOCK → 4 findings, ALL INTEGRATED

Auth note: ChatGPT-Codex was logged out at gate time (token did not survive since S105). Per the MRPF fallback hierarchy §1a the API-key toolkit was used (`codex-use-apikey.sh`; key verified; auto-restore scheduled). **Model: gpt-5.5 via API key — the real Codex lineage, not a substitute.** Transcript: `/c/tmp/s106-codex-run.log` (~159k tokens used).

| # | Severity | Finding | Fix |
|---|---|---|---|
| C1 | BLOCKING | `sources/` is append-only but the orchestrator digests EVERY file in the directory — a reused per-slug workdir (documented stale-workdir bug class) lets stale files from a prior attempt flow into this run's digests | downloadAttachments now `rm -rf` + recreates `<workDir>/sources/` before intake; test pins that a planted stale file does not survive. |
| C2 | MAJOR | Worker never revalidated element shape — forged row contentType (`payload.pdf` + `text/plain`) re-routes the sniffer; DB CHECK only guarantees "is array" | New exported `validateAttachmentMeta()`: contentType allowlist, extension↔MIME match (map built from the parallel conventions arrays), positive-safe-integer sizeBytes, originalName ≤255. Runs before any storage call. 3 new tests. |
| C3 | MAJOR | A REJECTED (thrown) `list()` escaped `listPrefix`, contradicting the sweep's never-throws contract; manual CLI treated it as fatal with no partial stats | try/catch inside the pagination loop → recorded in `stats.errors`, accumulated items returned. Test injects a throwing list(). |
| C4 | MINOR | The only new code that DELETES storage objects had zero unit coverage | New `agent/test/staging-sweep.test.ts` (9 tests): TTL math, non-UUID root folders untouchable, unparseable timestamps left in place, dry-run never removes, resolved `{error}` recorded, thrown list contained, 1500-entry pagination + 100-path delete batching, marker gate, missing-creds bail. |

Codex also explicitly verified: **G1 threading correct and tested; G2 gate fail-closed; G3 pagination math correct** — and confirmed no cross-tenant path escape in the worker/sweep path assembly.

## What each reviewer saw

- **Gemini:** full new-file contents + executor/worker unified diff + the 5 orchestrator edits verbatim + contracts summary (one assembled prompt via stdin; it cannot read the repo).
- **Codex:** the live repo read-only (`codex exec -s read-only` from repo root) — read both new libs, the CLI, both test files, executor.ts, worker.ts, storage-paths.ts, conventions.json, untrusted-input.ts, the Phase-2 frontend routes/validators/tests, the attachments migration, AND the live research-compare.md outside the repo. Diff via `git diff HEAD`.

## Automated-test answer (required for SECURITY/AGENT BEHAVIOR)

Yes. 364 total green (307 agent incl. 35 attachments + 9 sweep; 57 frontend), dual strict `tsc`, storage-path grep guard. Worker-side contracts pinned: sniff matrix (PDF/ZIP/ELF/PE/NUL/UTF-8), every skip-policy branch, pre-download OOM gate, fail-closed listing, stale-wipe, meta revalidation, manifest/prompt presence-iff-downloaded, sweep deletion scoping + pagination + marker gating. NOT covered by automated tests: the live orchestrator behavior (digest production, NLM upload of sources/) — covered by the Phase 3 E2E checklist (plan §End-to-end verification) before the flag flip, and the orchestrator file is prompt-text, for which no test harness exists (stated explicitly per MRPF).

## Outcome

Both reviewers' findings integrated; suite green; **gate CLEARED** (Gemini real + Codex real via API-key — all three lineages exercised; no reduced-cross-vendor posture). Residual accepted risks: (a) forged-row threat model requires service-role DB access (defense-in-depth only); (b) `MZ`-prefixed legitimate text file false-positive skip (cost = a missing digest); (c) sweep MAX_PAGES cap defers >20k-entry prefixes to the next daily tick (logged, not silent).
