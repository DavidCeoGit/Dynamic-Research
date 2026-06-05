# S52 #C — INFRA MERGE-gate Peer Review Synthesis

**Gate:** MERGE | INFRA + AGENT BEHAVIOR labels | NORMAL severity | Sequential Gemini → Codex.

**Artifacts under review (v1):**
- `sandbox/package-json-test-stub.patch` (intended: `Dynamic Research/package.json`)
- `sandbox/lint-storage-paths-workflow.yml` (intended: `.github/workflows/lint-storage-paths.yml`)

---

## Round 1 — Gemini Deep Think (web paste, 2026-05-25 evening)

**Verdict:** REQUEST CHANGES (1 CRIT, 1 MAJ, 1 MIN, 1 question).

### Findings + dispositions

| # | Severity | Finding | Disposition | Rationale |
|---|---|---|---|---|
| C1 | CRITICAL | Workflow runs only `bash agent/scripts/test-phase-b-storage-paths.sh`, bypassing the `pnpm test` matrix (storage-paths + tsc). Severe operational blind spot — local devs caught by tsc, CI green even on compile breakage. | **MOOT** — see investigation below. Resolution: defer the entire workflow piece from this MERGE; promote only the package.json patch. C1's concern dissolves when CI is descoped. | The workflow can't sensibly live in the SoT repo (no GitHub remote) or the push-clone repo (push-clone IS the frontend, layout doesn't match the script's `agent frontend` grep targets, storage-paths script isn't even synced to push-clone). CI topology requires a separate decision (new repo / inline workflow / pre-commit hook) not in scope for tonight. |
| M1 | MAJOR | `working-directory: "Dynamic Research"` will fail if the GitHub repo root maps directly to the project structure. | **VALIDATED + DRIVES C1 DEFER.** Push-clone is at repo root (`/c/tmp/Dynamic-Research/` directly contains `app/`, `components/`, `package.json` for the frontend — no `Dynamic Research/` parent dir). My draft's working-directory was wrong. The fix isn't "remove working-directory" (Gemini's suggestion) because the script + grep targets ALSO don't exist in push-clone's layout. Workflow needs a fundamental rethink → deferred. |
| m1 | MINOR | Single-line grep is brittle; could miss multi-line antipatterns. | **ACKNOWLEDGED, deferred** | Already documented in the script's own header comments. Out of scope for this MERGE. Worth tracking as S53+ work if it becomes a real escape vector. |
| Q1 | QUESTION | Are there legacy ignore-list patterns needed for the script before CI strict-blocks? | **ANSWERED: no** | Pre-flight against HEAD `add995c`: grep guard PASS, agent TSC clean, frontend TSC clean. Composite chain exits 0. No legacy noise. |

### Investigation that drove the C1 deferral (load-bearing context)

I checked `/c/tmp/Dynamic-Research/` (the push-clone, GitHub-remote `DavidCeoGit/Dynamic-Research`) and found:

1. **The push-clone repo root IS the frontend.** Its `package.json` is `name: "frontend"` with Next 16 scripts (`dev`/`build`/`start`/`lint`). It has `app/`, `components/`, `hooks/`, `lib/` at the repo root, not under a `Dynamic Research/` subdir.
2. **The agent/ subdirectory exists in push-clone but is STALE** — 7 files vs SoT's ~15. Missing: `test-phase-b-storage-paths.sh` (the script the workflow was supposed to run), plus all the Phase A/B migration scripts, RLS tests, and verify scripts.
3. **`Dynamic Research/package.json` (root SoT) doesn't exist in push-clone** — the push-clone has the frontend `package.json` only. So patching the SoT root's `package.json` has zero CI consequence (no remote).
4. **Therefore:** the workflow CAN'T run against push-clone-as-is (missing script, wrong grep targets) AND CAN'T trigger from SoT (no GitHub remote).

Three viable CI-topology paths, all out of scope for this MERGE:
- **A)** Sync the script + adapt grep targets to push-clone's layout (`agent app components hooks lib` instead of `agent frontend`). Adds maintenance burden — script forks between SoT and push-clone.
- **B)** Inline the grep logic in a workflow at push-clone with no external script dependency. Clean but the antipattern definition then lives in two places.
- **C)** Create a NEW GitHub repo as the SoT mirror so CI can run against the canonical layout. Heaviest lift, but only path that catches agent-side antipattern resurrection (push-clone's agent/ is stale and unrun).

**Recommendation for S53:** option C with the `agent/` ownership question explicitly addressed — or restructure the project to be a proper monorepo with one GitHub root.

---

## v2 — Reduced scope (Codex round-1 inbound)

**Artifacts under review (v2):**
- `sandbox/package-json-test-stub.patch` ONLY (the workflow YAML stays in sandbox as design reference; not promoted).

**Net change from v1:**
- Workflow promotion REMOVED.
- package.json patch unchanged from v1.

**What v2 ships:**
- Local-dev `pnpm test` wired to: storage-paths grep guard + agent tsc + frontend tsc. Catches BOTH agent and frontend antipatterns + type errors on a single command before commit.
- ZERO CI gate (deferred to S53+ pending topology decision).

**Pre-flight evidence for v2 (verified 2026-05-25 ~16:50 PDT against HEAD `add995c`):**
- `pnpm --filter ./agent exec tsc --noEmit` → exit 0 (verified)
- `pnpm -C agent exec tsc --noEmit` → exit 0 (verified — alternative syntax also works)
- `bash agent/scripts/test-phase-b-storage-paths.sh && pnpm --filter ./agent exec tsc --noEmit && pnpm --filter ./frontend exec tsc --noEmit` → exit 0 (composite chain works)

---

## Round 2 — Codex `exec` (CLI, 2026-05-25 evening)

**Verdict:** REQUEST CHANGES (0 CRIT, 2 MAJ, 1 MIN, 1 NIT). Independent verification on the deferral rationale.

**What Codex saw:**
- v2 sandbox patch (package.json) + v1 workflow YAML (sandbox reference) + this synthesis
- Live `agent/scripts/test-phase-b-storage-paths.sh`, `.gitignore`, `CLAUDE.md`, `package.json` (SoT)
- Push-clone `/c/tmp/Dynamic-Research/` for the topology investigation
- pnpm filtering docs, workspace config docs

### Codex round-1 — independent verification of v2 deferral

- **C1 (workflow defer) → Codex AGREES.** Push-clone CAN'T host the v1 workflow as drafted: wrong working-directory, missing script, wrong scan target layout, no `frontend/` subdir. Two-reviewer agreement on the C1 deferral.

### New Codex findings + v3 dispositions

| # | Severity | Finding | Disposition | v3 fix |
|---|---|---|---|---|
| Cx1 | MAJOR | `pnpm --filter ./agent` may silently no-op if it matches no projects (no `pnpm-workspace.yaml` in this tree; `--fail-if-no-match` not passed). Better to use the known-working `pnpm -C agent`. | **ACCEPT** | Patch updated to `pnpm -C agent` + `pnpm -C frontend`. Re-verified live: clean run exits 0, canary type error exits 1 (the chain DOES catch real type errors; earlier `exit=0` was bash `| tail` masking without `pipefail`). |
| Cx2 | MAJOR | Root `package.json` is gitignored (`.gitignore:14`). My patch lands on disk but is never committed — the change wouldn't propagate. | **ACCEPT** | New companion change: add `!/package.json` exception (root-anchored, leading slash) at `.gitignore`. Verified via `git check-ignore -v package.json` — now returns the exception rule, meaning file is NOT ignored. Pairs with the patch. **User authorized this scope extension** (track root package.json, exposes the `@perplexity-ai/mcp-server` dep to source control — not secret, just preference shift). |
| Cx3 | MINOR | `CLAUDE.md` line 25 says "Root `pnpm test` currently returns exit 1 — see S52 #6 todo" which goes stale once v3 ships. | **ACCEPT** | Direct edit to CLAUDE.md §2 line 25: now reads "Root `pnpm test` runs `bash agent/scripts/test-phase-b-storage-paths.sh && pnpm -C agent exec tsc --noEmit && pnpm -C frontend exec tsc --noEmit` — the grep guard against legacy flat-layout storage paths + strict TypeScript across both subprojects (wired S52 #C, 2026-05-25)." |
| Cxn | NIT | Synthesis wording "SoT repo has no GitHub remote" — parent worktree DOES have GravityClaw origin; just no Dynamic-Research-scoped remote. | **ACKNOWLEDGED, no doc change** | True observation; my phrasing was imprecise. The substantive point holds: there's no GitHub remote AT the Dynamic Research scope to run a Dynamic-Research-scoped Action against. |

### v3 — final scope (3 files changed; Codex round-2 inbound)

**v3 artifacts:**
- `Dynamic Research/package.json` — `test` script rewired (one-line change inside the scripts block).
- `Dynamic Research/.gitignore` — add `!/package.json` exception at line ~17 (5-line block including comment).
- `Dynamic Research/CLAUDE.md` — §2 line 25 updated to reflect new wiring (already applied directly since CLAUDE.md is in the writable set).

**Pre-flight evidence for v3:**
- `git check-ignore -v package.json` → rule `!/package.json` matched → file is NOT ignored.
- `pnpm test` clean run → exits 0 (PASS storage-paths + TSC clean on both subprojects).
- `pnpm test` with deliberate type-canary (`export const x: number = "string";`) → exits 1 (TS2322 propagates correctly through the `&&` chain; pnpm correctly reports `Test failed`).

**Net change from v2:** added .gitignore exception + CLAUDE.md doc fix; patch syntax updated to `pnpm -C`. Workflow YAML still deferred (sandbox reference only).

---

## Round 3 — Codex `exec` QA on v3 (pending)

Per MRPF v2.2 post-fix-revision rule: the reviewer that DROVE the fixes (Codex round-1) verifies the integrated v3. No Gemini re-invoke needed (Gemini round-1 already approved the deferral; v3 doesn't change the C1 disposition).
