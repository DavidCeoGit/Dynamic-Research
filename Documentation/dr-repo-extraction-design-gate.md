# DR Repo-Extraction — DESIGN-gate Plan

> **Status:** v3 — DESIGN gate CLOSED. Gemini + Codex BOTH APPROVE_WITH_CHANGES, all findings integrated. Ready for execution on user go.
> **Session:** S90 (2026-06-04). **Author:** Claude (Opus 4.8).
> **Final path:** `Documentation/dr-repo-extraction-design-gate.md`.
> **Companion (to be written):** `Documentation/dr-repo-extraction-design-gate-peer-review.md`.

---

## 0. MRPF classification

- **Event Gate:** DESIGN (structural repo restructure + infra/deploy pipeline change + irreversible-ish history boundary). Gemini + Codex **mandatory** regardless of labels.
- **Risk Labels:** INFRA (Vercel reconfig, git remote, deploy pipeline), ARCHITECTURE (repo-boundary restructure), AGENT BEHAVIOR (CLAUDE.md instructions that silently steer every future session's git workflow; enforce-sandbox auto-setup on the new `.git`), DATA (git history — but **archived, not destroyed**; irreversibility mitigated by a `git bundle` + `.git` rename backup).
- **Severity Mode:** NORMAL (no production-down pressure; worker + live site healthy).
- **Topology:** Sequential **Gemini → integrate → Codex** on the integrated v2. This artifact is the v1.

---

## 1. Problem (what bad outcome are we preventing)

The parent `Anti Gravity/` is **one git repo** (`origin = github.com/DavidCeoGit/GravityClaw.git`, parent `.git` = 90 MB) that **accidentally** shares history across ~34 unrelated project folders. There is **no** root workspace **at the parent** (`Anti Gravity/pnpm-workspace.yaml` / `Anti Gravity/package.json` ABSENT) — this was never a designed monorepo. *(Note for clarity, per Gemini NIT: `Dynamic Research/package.json` DOES exist — it carries the unified `test` script and is preserved + committed in the new repo. The "absent root workspace" refers strictly to the PARENT.)*

The concrete harm already realized: a concurrent **GravityClaw** session **force-pushed** `GravityClaw.git` to a standalone history (`34e2ff4`, S89-end), which **erased DR's S84–S88 commits from that shared remote**. DR's commits survive **only locally**. Any `git push origin main` from the DR side would now push into GC's standalone repo (re-entangling the two histories GC is separating) — so DR currently **has no safe remote** for its parent/agent code.

**Goal:** make `Dynamic Research/` its **own** standalone repo with its **own** remote, retire the fragile push-clone, and do it **without** disturbing the live Vercel site or the running worker. Then apply a repeatable pattern to the other still-entangled stragglers.

### 1.1 Current entanglement state (verified S90)

- **Already self-separated** (own nested `.git`, 10): American Signature Courts, CMO Command Center, Client Pipeline, Finn, Operator-OS, Regenesis, Website-generator, coleman-worker, stitch, wise-board-muse.
- **Still entangled** in the parent repo (5): **Dynamic Research** (this plan, 1113 tracked files), **GravityClaw** (remote already standalone at `34e2ff4`, but local tree still in the parent), **habit-tracker**, **ai-adoption-accelerators**, **asc-bid-pipeline**.

---

## 2. User-approved decisions (carried from S89 handoff — NOT re-litigated here)

1. **History:** FRESH `git init` in `Dynamic Research/` (NOT `git filter-repo` — too risky on a 600+-commit diverged shared history; the deploy does not depend on parent history). Full history preserved by **archiving** the parent repo's `.git` (rename + `git bundle`, never delete) → recoverable, zero ongoing cost.
2. **Remote:** REUSE the existing `DavidCeoGit/Dynamic-Research` GitHub repo as the **whole-project** home (not a 3rd remote). Restructure it from "frontend-at-root" to "whole project, frontend at `frontend/` subdir"; set Vercel **Root Directory = `frontend/`**; **RETIRE** the `c:/tmp/Dynamic-Research` push-clone → one repo / one remote, killing the [[feedback_pushclone_divergence_reconcile]] footgun.
3. **Doc/tooling fallout:** fold ALL flips into the **same** migration commit — no intermediate stale-layout state.

---

## 3. Refinements found during S90 fact-finding (REVIEWERS: please pressure-test these)

These adjust *how* the pre-approved decisions execute; they do not change the decisions.

### 3.1 The folder does NOT move → agent-code paths stay valid (scope reduction)

Decision #1 gives `Dynamic Research/` its own `.git` **in place**. The physical directory **stays at** `Anti Gravity/Dynamic Research/`. Therefore the hardcoded absolute paths `.../Anti Gravity/Dynamic Research/...` in `agent/executor.ts:52` (`PROJECTS_DIR`), `agent/lib/notify.ts:423` (tailHint), `agent/mcp-proxy/mcp-config.json`, `agent/mcp-proxy/upstreams.json`, and `.claude/settings.json` (`additionalDirectories`) **remain correct and need NO edit**. The grep-and-flip is **docs-only** (CLAUDE.md §3/§4 + ~dozen memory files). *(An exploratory sweep initially assumed a physical move out of `Anti Gravity/` and flagged those code paths for editing — that assumption is rejected; editing them would BREAK the worker.)* **(Gemini NIT — Finding 4; broadened per Codex MINOR):** these mcp-proxy paths are HOST-SPECIFIC absolute Windows paths — committed as-is for daemon continuity, but flag (commit message + a comment) that they require updating if the project is ever cloned to a different machine. `mcp-config.json:3` already carries a host note; **add the same note to `upstreams.json` (lines 8, 31)**. Also: `.claude/settings.json:18` (`additionalDirectories`) still includes the whole parent `Anti Gravity` directory — after extraction DR likely no longer needs parent-wide write access; document why it stays broad OR narrow it to DR-only in Phase 4. They are not blockers; they are correct on THIS host.

### 3.2 "Archive the parent `.git`" is the FINAL step of the WHOLE sweep — NOT part of DR extraction

The parent `.git` still serves the **other 4 entangled stragglers** (GravityClaw local tree, habit-tracker, ai-adoption-accelerators, asc-bid-pipeline). Archiving it during DR extraction would strand their history. So DR extraction **does not touch the parent `.git` at all** — DR simply gains its own nested `.git` and stops using the parent (exactly like the 10 already-separated projects do today). The parent `.git` archival becomes a **separate terminal milestone** after the last straggler leaves. This makes DR-first genuinely low-blast-radius.

- **Transient state (accepted):** DR files are tracked by BOTH the parent repo AND DR's new nested repo. Harmless as long as DR sessions run git only from `Dynamic Research/` (its own `.git` takes precedence for any command run inside it). This is the identical state the 10 already-nested projects live in now.

### 3.3 enforce-sandbox auto-setup will fire on the new `.git`

`~/.claude/hooks/enforce-sandbox.sh` is **generic** (resolves `CLAUDE_PROJECT_DIR`, no hardcoded parent path) so it needs no edit. BUT it contains an auto-setup branch: `if [[ ! -f "$PROJECT_DIR/.claude/sandbox-allowlist" && -d "$PROJECT_DIR/.git" ]]` → runs `setup-sandbox-project.sh` (creates `sandbox/validated`, `sandbox/rejected`, a template `.claude/sandbox-allowlist`, and **edits `.gitignore`**). DR's PROJECT_DIR has no `.git` today, so this has never fired for DR. The instant `git init` lands, the **next** Write/Edit under DR triggers it. **Pre-empt** by authoring `.claude/sandbox-allowlist` + `.gitignore` ourselves (Phase 1) **before** the first post-init write, so the auto-setup is a no-op and we control the content.

### 3.4 The Vercel Root-Directory change is per-PROJECT, not per-branch → can't "preview" the new layout on a branch

Vercel's Root Directory is a single project-level setting. You cannot have production on `.` and a preview on `frontend/` simultaneously. So a "push to a staging branch and preview" approach does **not** validate the new layout. The staged cutover must use the **Vercel CLI** (`vercel build` / `vercel deploy --prebuilt` from the `frontend/` subdir, or a `vercel.json` with `rootDirectory`) to produce a **preview deployment that exercises the new layout without aliasing production**, verify it, then **promote/alias**. Detailed in §6. **This is the single highest-risk step; reviewers please scrutinize.**

---

## 4. Target end-state

```
Anti Gravity/                         (NO LONGER a git repo — only after the FULL sweep; during DR-first it still is)
  Dynamic Research/                   <- NEW standalone repo root (own .git)
    .git/                             <- fresh init
    .gitignore                        <- NEW (authored Phase 1)
    .claude/sandbox-allowlist         <- pre-authored (pre-empt auto-setup)
    CLAUDE.md                         <- §3/§4 flipped to "git at this root, no push-clone"
    agent/                            <- unchanged paths (folder didn't move)
    frontend/                         <- Vercel Root Directory points HERE
    supabase/
    Documentation/
    Projects/                         <- gitignored (job outputs)
    sandbox/                          <- gitignored except sandbox/validated? (decide §5)
  GravityClaw/                        <- still entangled until its own extraction
  habit-tracker/ ai-adoption-accelerators/ asc-bid-pipeline/  <- still entangled
```

- **Remote:** `DavidCeoGit/Dynamic-Research` holds the **whole** project (frontend + agent + supabase + Documentation), root layout = the SoT layout above.
- **Vercel:** project `dynamic-research` (`prj_OIKSf0p2ajj7NF6JQ9PhHCOt1QZN`, team `team_bXjlhUrWnKgeok81q1LiI5NR`), Root Directory = `frontend/`, still auto-deploys on push to `DavidCeoGit/Dynamic-Research` main.
- **Push-clone `c:/tmp/Dynamic-Research`:** retired (kept on disk as a cold backup until the next session confirms the new deploy is stable, then removable).
- **Worker:** PID 40420 keeps running throughout; **no restart needed** (folder didn't move; executor paths unchanged; the git change is invisible to the daemon).

---

## 5. `.gitignore` design (CRITICAL — fresh `git add .` will otherwise commit junk)

A fresh `git init && git add .` captures the **entire working tree**, including `node_modules/`, build caches, job outputs, **secrets**, and the worker's runtime files. The `.gitignore` must be authored **before** the first `git add`. **(Gemini CRITICAL — Finding 1: the v1 list was too permissive and would leak secrets via archived env files + MCP configs. v2 hardens it below.)** Hardened root `.gitignore`:

```
# deps / build
**/node_modules/
**/.next/
**/out/
**/build/
*.tsbuildinfo
# NOTE (Codex MAJOR): do NOT ignore next-env.d.ts — it's a Next type shim that
# `pnpm test`'s `tsc --noEmit` (root package.json:7) needs present on a fresh
# checkout. It is committed (small, harmless). (The push-clone ignored it and
# survived only because Vercel regenerates it at build; committing is strictly safer.)

# env / secrets — BROAD (catch .env, .env.local, AND archived/backup variants
# like .env.bak-s82-pre-api-key-disable). Exempt only *.example templates.
.env
.env.*
**/.env
**/.env.*
!**/.env.example
!**/.env*.example
*.pem
*.key
credentials.*
**/agent-env*
# MCP configs often carry server API keys
.mcp.json
.mcp.json.*
**/.mcp.json
backup-claude-config/

# vercel
**/.vercel

# worker / agent runtime state
**/worker.log
**/.worker.pid
**/.preflight-backoff
agent/scripts/.phase-a-bootstrap-state.json

# claude machine-local + session history (DO commit settings.json + sandbox-allowlist)
**/.claude/settings.local.json
**/.claude/*.local.json
**/.claude/sessions/

# job outputs (large, per-tenant, possibly client-identifying — NEVER commit)
Projects/

# sandbox — IGNORE ENTIRELY (incl. validated archive). It can contain archived
# .env / secret snapshots; the audit-trail value does not outweigh the leak risk.
# Re-add specific validated artifacts deliberately AFTER a secret scan if needed.
sandbox/
agent/sandbox/

# OS
.DS_Store
```

**Resolved decisions (were "DECISION POINTS" in v1):**
- (a) **`Projects/`** → **ignore entirely** (per-job deliverables, possible client-identifying ASC content → PRIVACY + bloat). RESOLVED.
- (b) **`sandbox/`** → **ignore entirely**, INCLUDING `sandbox/validated/` (reversed from v1's "keep validated"). Gemini's CRITICAL showed archived `.env`/secret snapshots can live under `sandbox/` → the archive's audit value does not outweigh the leak vector. RESOLVED toward safety.
- (c) **`.claude/`** → commit `settings.json` + `sandbox-allowlist`; ignore `*.local.json` + `sessions/`. RESOLVED.
- (d) **Belt-and-suspenders secret scan (NEW, Phase 2.2):** after `git add .`, BEFORE the first commit, scan the staged set for likely secrets and ABORT if any hit:
  `git -C "Dynamic Research" diff --cached --name-only` piped through a grep for `\.env`, plus `git diff --cached -G '(sk-|pplx-|SUPABASE_SERVICE_ROLE|ANTHROPIC_API_KEY=|eyJ[A-Za-z0-9_-]{20,})'`. Zero hits required to proceed. This catches anything the glob missed.

---

## 6. Execution plan — DR FIRST, phased, each phase independently verifiable

> **Nothing in Phases 0–2 touches the remote or Vercel.** The live site keeps deploying from the **untouched** push-clone until Phase 3's verified cutover. The worker keeps running the whole time.

### Phase 0 — Pre-flight safety (read-only + backups; fully reversible)
0.1 Confirm worker PID 40420 alive + polling; queue idle (no job mid-flight, to avoid racing `git add` with `Projects/` writes — though `Projects/` is gitignored).
0.2 **Backup the parent history twice:** (a) `git -C "Anti Gravity" bundle create <archive>/anti-gravity-parent-<date>.bundle --all`; (b) note the parent `.git` stays in place (not renamed yet). Verify the bundle restores (`git bundle verify`).
0.3 Record current Vercel config: `vercel project ls` / dashboard screenshot of Root Directory = `.`, build settings, env vars, production domain + current deployment ID (the **rollback target**).
0.4 Snapshot the **live** production site (key routes: gallery, a run page, submit form) for post-cutover diffing — the "did the deploy still work" oracle. (Out-of-band: see §9 verification script.)
0.5 Confirm `pnpm test` GREEN on disk pre-change (baseline).
0.6 **(Codex MAJOR — concurrent-GC race gate.)** Before Phase 2, confirm NO concurrent GravityClaw session is mid-operation on the shared parent tree: check for a running GC worker / active checkout, and establish a short coordination window ("no parent-git destructive ops, no writes under `Dynamic Research/`") for the duration of Phases 2–3. The `git init` + `git add .` snapshot is near-instant, so the window is small — but a concurrent GC `git checkout`/`stash` mid-`git add` could capture a torn tree. If a GC session is active, pause until it idles (or coordinate explicitly). This directly addresses §10 Q6.

### Phase 1 — Author the new repo's ignore + allowlist + LAND the architectural record (no `.git` yet; reversible)
1.1 Write `Dynamic Research/.gitignore` (§5 hardened version).
1.2 Write `Dynamic Research/.claude/sandbox-allowlist` (pre-empt enforce-sandbox auto-setup §3.3) — mirror the patterns the project already relies on (sandbox/**, CLAUDE.md, .claude/**, and the per-job `Projects/<slug>/.claude/sandbox-allowlist` exception).
1.3 **(Gemini MINOR — Finding 3) Promote THIS plan + its peer-review into `Documentation/` BEFORE `git init`.** Because §5 now ignores `sandbox/` entirely, the plan would NOT be captured by the fresh init if left in sandbox. Via `/promote`: `sandbox/dr-repo-extraction-design-gate.md` → `Documentation/dr-repo-extraction-design-gate.md`, and the captured Gemini+Codex critique → `Documentation/dr-repo-extraction-design-gate-peer-review.md`. The new repo's very first commit then carries its own split rationale.
1.4 **(Codex MAJOR — do NOT run parent-wide `git status`; it crawls the huge tree and contradicts §3.2's hazard.)** Confirm the authored files exist with a PATH-SCOPED check only: `git -C "Anti Gravity" status --short -- "Dynamic Research/.gitignore" "Dynamic Research/.claude/sandbox-allowlist"` (or just `ls` the two files). No full-tree status.

### Phase 2 — `git init` DR in place + first commit (DR gains its own repo; parent untouched)
2.1 `cd "Anti Gravity/Dynamic Research" && git init -b main`.
2.2 `git add .` → **inspect `git status` carefully**: confirm NO `node_modules`, NO `.env`, NO `Projects/`, NO `.next` staged (the §5 gitignore guard). Abort + fix gitignore if any junk appears.
2.3 First commit: `chore(dr): standalone repo init (fresh history; parent history archived in bundle)`. This commit's tree = current on-disk state = the content of parent commits through 11321ac (S89). Their commit *messages/history* live in the Phase-0 bundle.
2.4 Verify: `git -C "Dynamic Research" log --oneline` (1 commit), `git -C "Dynamic Research" status` clean, worker still alive, `pnpm test` still GREEN.
   - **Rollback for Phases 1–2:** `rm -rf "Dynamic Research/.git"` + remove the 2 authored files → DR is exactly as before; parent repo never changed.

### Phase 3 — Restructure the remote + STAGED Vercel cutover (the irreversible-ish, highest-risk phase)
> Detailed cutover mechanism — reviewers please harden:
3.1 Add remote: `git -C "Dynamic Research" remote add origin https://github.com/DavidCeoGit/Dynamic-Research.git`.
3.2 **Do NOT force-push to main yet.** Push the new whole-project tree to a **staging branch**: `git push origin main:repo-restructure-staging` (or a fresh branch). This uploads the new layout WITHOUT changing what Vercel production builds (Vercel prod tracks `main` + Root Directory `.`; the staging branch with frontend in a subdir + current Root Directory `.` would fail to build — that's expected and harmless, it's not aliased to prod).
3.3 **Validate the new layout via Vercel CLI preview** (NOT a git-push preview, per §3.4): from `Dynamic Research/frontend/`, run `vercel link` (associate THIS subdir with the existing `dynamic-research` project — Gemini Q2 refinement), then `vercel pull`, `vercel build`, `vercel deploy --prebuilt` (preview, no prod alias) — producing a preview URL that builds the app from the `frontend/` subdir. Verify the preview URL serves the gallery/submit/run pages correctly (the §9 checklist). (Heed [[feedback_vercel_cli_personal_scope_blocked]]: team scope is mandatory; [[feedback_vercel_link_rejects_triple_dash_path]]: pass `--project` if auto-slug fails.)
3.4 **(Gemini MAJOR — Finding 2: strict ordering to avoid the build-with-wrong-root race.) Only after the preview is verified GREEN, in THIS order:**
   1. Flip Vercel Dashboard **Root Directory → `frontend/`** FIRST (no push yet → no build triggered against the old layout with the new setting).
   2. THEN `git push origin main --force-with-lease` (restructured tree). This is now safe: the remote `Dynamic-Research` is DR's, NOT GC's. The push triggers ONE production build, which uses the already-correct `frontend/` root.
   - Doing it in this order eliminates the window where Vercel would try to build the new-layout tree with the stale Root Directory `.` (or vice-versa).
   - **Force-push justification (Gemini §10.1 = APPROVE force-push):** `DavidCeoGit/Dynamic-Research` currently holds only the flat push-clone history (frontend-at-root), which is NOT a source of truth and is backed up by the Phase-0 bundle + the on-disk push-clone. The restructured tree is an unrelated fresh-init history → `--force-with-lease` is required. Reusing the repo (vs a new one) **preserves the Vercel project wiring** (project ID, env vars, domain/SSL, auto-deploy hook) — avoiding re-link toil and DNS propagation downtime. This is the **single point of no return** on the remote; rollback is via Vercel "Promote last-good deployment" (0.3) + re-push from the retained push-clone.
3.5 Verify production: new deployment ID, production domain still resolves, §9 checklist GREEN against the **production** alias (not just preview).
   - **Rollback for Phase 3:** Vercel dashboard → "Promote to Production" the **last good deployment** recorded in 0.3 (instant, restores the pre-cutover build); revert Root Directory to `.`; the push-clone still exists on disk to re-push if needed.

### Phase 4 — Docs/tooling flips (folded into the SAME migration commit on the new repo)
4.1 `CLAUDE.md §3` → "The git repo is at THIS directory root (`Dynamic Research/`). Use `git status`/`git commit` directly. Remote: `DavidCeoGit/Dynamic-Research`."
4.2 `CLAUDE.md §4` → replace the entire push-clone deploy section with "Vercel deploys directly from `DavidCeoGit/Dynamic-Research` (Root Directory = `frontend/`). Edit `frontend/` → commit → push → Vercel auto-builds. NO push-clone, NO sync, NO 3-way diff."
4.3 `~/CLAUDE.md` line ~93 MRPF path reference — leave as `Dynamic Research/Documentation/...` (still resolves; low value to change) OR make repo-relative. (Minor.)
4.4 Memory flips (docs-only): mark `feedback_pushclone_divergence_reconcile.md` and `feedback_shared_monorepo_concurrency_stash_hazard.md` as **RESOLVED/HISTORICAL** (link to this plan); update DR `MEMORY.md` lines (push-clone deploy line, "git at parent" line); the S89 handoff BLOCKER/TOP-PRIORITY sections get superseded by the S90 handoff.
4.5 Commit all Phase-4 flips into ONE commit on the new DR repo: `docs(dr): repoint git/deploy instructions to standalone repo (post-extraction)`. (Folded-together per decision #3; no stale intermediate state since these are the FIRST docs the new repo carries.)

### Phase 5 — Full verification + push-clone retirement
5.1 Worker: still PID 40420, polling, preflight GREEN, `.preflight-backoff` absent.
5.2 `pnpm test` GREEN (grep guard + agent tsc + frontend tsc).
5.3 `studio-winner` 8/8, full agent suite green.
5.4 Production site §9 checklist GREEN (gallery renders a known-good slug, submit form loads, a run page loads).
5.5 Make a **trivial verification commit** (e.g. a comment in `frontend/`) → push → confirm Vercel auto-builds from `frontend/` and deploys (proves the new pipeline end-to-end).
5.6 Push-clone: leave `c:/tmp/Dynamic-Research` on disk one session as cold backup; schedule deletion for S91 once the new pipeline has a confirmed clean deploy.

### Phase 6 (DEFERRED — terminal milestone, NOT this session) — Archive parent `.git`
Only after **all** entangled stragglers (GravityClaw local, habit-tracker, ai-adoption-accelerators, asc-bid-pipeline) have their own repos. Then: `git bundle` the parent once more, rename `Anti Gravity/.git` → `Anti Gravity/.git.archived-<date>` (don't delete), confirm no project depends on it. Tracked separately in the straggler-sweep plan.

---

## 7. Repeatable pattern for the other stragglers (post-DR)

For each of GravityClaw / habit-tracker / ai-adoption-accelerators / asc-bid-pipeline:
1. Decide history: fresh-init (default, cheap) vs `filter-repo --subdirectory-filter` (only if that project's history matters AND its deploy/tooling needs it). GravityClaw already chose `filter-repo` + force-push-in-place (see [[project_gc_repo_split_design_gate]]) and its remote is already standalone — its remaining work is reconciling the **local** tree to that standalone remote, not a fresh init.
2. Author `.gitignore` + pre-empt enforce-sandbox auto-setup.
3. `git init` (or attach existing standalone remote) in place.
4. Repoint that project's own CLAUDE.md / deploy / memory.
5. Verify its app/deploy/tests.
6. Only after ALL leave → Phase 6 archive parent `.git`.

DR is the template; each straggler gets the same 6-phase shape scaled to its deploy surface.

---

## 8. Rollback summary (per phase)

| Phase | Reversible? | Rollback |
|---|---|---|
| 0 Pre-flight | Fully | Nothing changed |
| 1 ignore/allowlist | Fully | Delete the 2 authored files |
| 2 git init + commit | Fully | `rm -rf Dynamic Research/.git`; parent untouched |
| 3 remote + Vercel cutover | **Irreversible-ish** | Vercel "Promote to Production" the last-good deployment (0.3) + revert Root Directory to `.`; push-clone on disk re-pushable; Phase-0 bundle restores history |
| 4 docs flips | Fully | git revert the docs commit |
| 5 verify/retire | Fully | Push-clone kept on disk |
| 6 archive parent .git | Deferred | `.git` renamed not deleted; rename back |

---

## 9. Out-of-band verification checklist (the "deploy still works" oracle)

Run against **preview** (Phase 3.3) AND **production** (Phase 3.5 / 5.4):
1. Gallery route loads + renders a known-completed slug's deliverables (e.g. the e18e1931 slug) — files list non-empty, audio/video/report links resolve (signed URLs).  **Pass:** gallery shows ≥1 run with files.
2. Submit form route loads, fields render, no console errors.  **Pass:** form interactive.
3. A run/status page loads for an existing slug.  **Pass:** status renders (not "API not running").
4. No 404 on static assets / CSS (the trailingSlash + subpath-relative-path class of bug).  **Pass:** styled correctly.
5. Auth magic-link route reachable (don't complete, just 200).  **Pass:** no 500.
> Format for the response: "deploy-checklist GREEN" or a per-item failure list.

---

## 10. Open questions for the reviewers (Gemini → Codex)

1. **Force-push `main` on the existing `DavidCeoGit/Dynamic-Research`** (§3.4/3.5) vs. creating a brand-new repo + re-pointing Vercel. Which is lower-risk given the existing repo is wired to the live Vercel project? Trade-off: force-push keeps the Vercel↔repo↔domain wiring (no re-link) but rewrites remote history; new repo is clean but requires re-linking Vercel + re-adding env vars + possible domain reattach.
2. **Vercel Root-Directory cutover mechanism** (§3.3): is the CLI `vercel build`/`deploy --prebuilt` preview from `frontend/` the right way to validate the subdir layout before flipping the dashboard setting, or is there a cleaner Vercel-native staged path?
3. **`.gitignore` completeness** (§5): any secret/runtime/output path that would leak or bloat if I missed it? Especially: is anything under `agent/` runtime-generated-and-secret beyond `.env`, `worker.log`, `.worker.pid`, `.preflight-backoff`?
4. **Fresh-init vs filter-repo for DR** — confirm fresh-init is acceptable given DR's deploy genuinely doesn't depend on parent history and the history is bundle-archived. Any scenario where losing per-file `git blame` continuity on DR source bites us?
5. **Transient dual-tracking** (§3.2): DR files tracked by both parent and nested repo until Phase 6. Any footgun beyond "don't run git from the parent for DR work"?
6. **Sequencing:** is DR-first (before GravityClaw's local reconciliation) correct, given GC's remote is already standalone and a concurrent GC session may still touch the shared parent tree? Risk of a concurrent GC `git` op racing DR's Phase 2 `git init`.
