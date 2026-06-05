# DR Repo-Extraction — DESIGN-gate Peer Review (companion to `dr-repo-extraction-design-gate.md`)

> **Gate:** DESIGN × INFRA + ARCHITECTURE + AGENT BEHAVIOR + DATA × NORMAL.
> **Topology:** Sequential Gemini → integrate → Codex on integrated v2. (HARD RULE per `~/CLAUDE.md`.)
> **Outcome:** Both reviewers **APPROVE_WITH_CHANGES**; all findings integrated → plan v3. **No CRITICAL, no SECURITY-blocking finding.** DESIGN gate CLOSED.
> **Session:** S90 (2026-06-04).

---

## What each reviewer saw

- **Gemini** (`gemini-3-flash-preview`, OAuth CLI, cwd = `Dynamic Research/`): the **plan v1** + workspace file-read access scoped to `Dynamic Research/` (could not read the parent — workspace boundary). Holistic whole-artifact read. Self-contained ~16KB prompt.
- **Codex** (`gpt-5.5`, `codex exec -s read-only`, xhigh): the **integrated plan v2** + targeted reads of the actual code (`executor.ts`, `worker.ts`, `notify.ts`, `mcp-proxy/*.json`, `package.json` ×3, `.claude/settings.json`, `frontend/next.config.ts`, confirmed `frontend/vercel.json` absent). Code-grounded verification of every claim. *(First Codex run died at exit 127 after recursively crawling the huge gitignored `Projects/` + `sandbox/validated/` trees; re-run with an explicit "no tree enumeration, read only these files" constraint succeeded — 101K tokens.)*

---

## Verdicts

| Reviewer | Verdict |
|---|---|
| Gemini (v1) | APPROVE_WITH_CHANGES |
| Codex (v2) | APPROVE_WITH_CHANGES |

**Disagreements:** none. Codex explicitly AGREED with all 5 Gemini findings; added 2 MAJOR + 1 MINOR of its own.

---

## Findings & integration

| # | Sev | Reviewer | Finding | Integration (plan v3) |
|---|---|---|---|---|
| 1 | CRITICAL | Gemini | v1 `.gitignore` too permissive → archived `.env`/secret snapshots under `sandbox/` + `.mcp.json` keys would leak | §5 hardened: broad `**/.env.*` (catch `.env.bak-*`), `**/agent-env*`, `.mcp.json*`, `backup-claude-config/`, `**/.claude/*.local.json`; **`sandbox/` ignored ENTIRELY** (incl. `validated/`); + Phase 2.2 pre-commit secret scan |
| 2 | MAJOR | Gemini | Vercel cutover race (build with wrong Root Directory) | §6 Phase 3.4 strict order: **flip Root Directory `frontend/` FIRST → THEN `git push --force-with-lease`** |
| 3 | MINOR | Gemini | Plan in `sandbox/` (now fully ignored) won't be committed to the new repo | Phase 1.3: **promote plan + this review to `Documentation/` BEFORE `git init`** |
| 4 | NIT | Gemini | mcp-proxy paths host-specific | §3.1 note + commit-message flag |
| 5 | NIT | Gemini | §1 "root package.json ABSENT" ambiguous | §1 clarified: absence = PARENT only; DR root `package.json` exists + committed |
| 6 | MAJOR | Codex | `.gitignore` over-ignores `next-env.d.ts` (Next type shim `tsc --noEmit` needs on fresh checkout) | §5: **removed from ignore — committed** |
| 7 | MAJOR | Codex | Phase 1.4 still ran parent-wide `git status` (huge-tree hazard) + no concurrent-GC race gate | Phase 1.4 **path-scoped status**; new Phase 0.6 **GC-coordination gate** before Phase 2 |
| 8 | MINOR | Codex | Host-specific note should extend to `upstreams.json` + `.claude/settings.json:18` (parent dir in additionalDirectories) | §3.1 broadened; settings.json additionalDirectories flagged for Phase 4 narrow/document |

## Codex code-grounded claim-checks (all CONFIRMED)

- **§3.1** (agent paths don't need editing): CONFIRMED — `executor.ts:51-52`, `notify.ts:423`, `mcp-config.json:11-30`, `upstreams.json:8,31`, `.claude/settings.json:4-18` all point inside the unchanged folder; **no `git -C <parent>` or parent-relative git usage in `worker.ts`/`executor.ts`**.
- **Worker PID 40420 has NO git dependency** — `worker.ts:45` manages `.worker.pid` via `process.cwd()`; `executor.ts` spawns Claude in an ephemeral workdir, never git. → migration is invisible to the daemon; **no restart needed**.
- **Vercel Phase 3**: `frontend/package.json:5-8` has the build script, Next/React deps present, `next.config.ts` empty/no conflict, `frontend/vercel.json` ABSENT → `Root Directory=frontend/` builds standalone. Ordering correct.
- **Fresh-init**: captures on-disk unignored state; no risk of losing uncommitted DR work (only risk was the `next-env.d.ts` ignore + skipping the secret scan — both now handled).

## §10 open-question resolutions (reviewer-backed)

1. **Force-push existing repo vs new repo** → **force-push existing** (both reviewers). Preserves Vercel project ID / env vars / domain / SSL / auto-deploy hook; remote history is throwaway push-clone, bundle-backed.
2. **Vercel cutover mechanism** → CLI `vercel link`(in `frontend/`)→`pull`→`build`→`deploy --prebuilt` preview, verify, then flip+push. Sound.
3. **`.gitignore` completeness** → hardened (findings 1, 6); secret scan added.
4. **Fresh-init vs filter-repo** → fresh-init (both). History bundle-archived; `git blame` continuity not a driver for a utility project.
5. **Transient dual-tracking** → low risk (standard git nested-repo precedence; 10 projects already do it).
6. **DR-first sequencing** → correct (both); concurrent-GC race mitigated by Phase 0.6 gate.

---

## Sign-off

DESIGN gate CLOSED at plan **v3**. No CRITICAL outstanding; no SECURITY-labeled blocking finding. Execution authorized pending user go (the migration touches the live deploy + remote history → user confirmation required before Phase 3's point-of-no-return force-push).
