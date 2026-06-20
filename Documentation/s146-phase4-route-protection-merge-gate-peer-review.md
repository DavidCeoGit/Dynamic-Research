# S146 MERGE-gate peer review — Phase 4 SSR-auth route protection

**Date:** 2026-06-20 · **Session:** DR S146 · **Gate:** MERGE · **Labels:** SECURITY (auth/authz, tenant isolation, anonymous-exposure closure), ARCHITECTURE (retires the Phase-2 dual-path bridge) · **Severity:** NORMAL · **Topology:** sequential Gemini(holistic-adversarial) → integrate → Codex(grounded-adversarial) → integrate → Codex(fidelity-QA).

Reviewer CLIs per `~/CLAUDE.md` §Multi-Reviewer + DR CLAUDE.md §11. Gemini run via `@google/genai` SDK (`gemini-2.5-pro`; CLI OAuth tier dead since S145). Codex run via `codex exec -s workspace-write` (read-only blocks Windows file reads), grounded against the live tree. Logs: `c:/tmp/dr-s146/{gemini,codex,codex-qa}.log`.

## Change summary
Phase 4 of `Documentation/ssr-auth-refactor-design.md`. Closes a live anonymous-exposure hole: pre-change, no session → `getOrgContextDualPath()` fell back to `process.env.SYSTEM_DEFAULT_ORG_ID`, so any anonymous visitor's `/api/runs` etc. returned the SYSTEM_DEFAULT_ORG's data and the home page rendered that gallery.

- `frontend/lib/auth.ts` — DELETE `getOrgContextDualPath` + the env fallback; ADD `requireOrgOr401(message?)` (session-only; 401 on Unauthorized|Forbidden, rethrow generic → 500). Re-exports `isSafeRedirect` from route-protection.
- `frontend/lib/route-protection.ts` (NEW, pure) — `isApiPath` / `isPublicPage` (exact-match) / `isProtectedPage` / `isSafeRedirect`.
- `frontend/proxy.ts` — enable Phase-4 PAGE-route protection: anon → `/login?redirect=<path+query>`; authed-no-membership → `/no-org` (fail-open on the membership query). `/api/*` self-protects (not redirected). Worker `PATCH /api/queue/[id]` short-circuit unchanged.
- 10 API routes — `getOrgContextDualPath` → `requireOrgOr401`; `X-Org-Source` stripped; vestigial `source !== "session"` attachment guards removed (queue + replay). Tenant scoping unchanged.
- `frontend/lib/__tests__/route-protection.test.ts` (NEW, 12 tests) + `package.json` registration.

## Round 1 — Gemini holistic-adversarial (v1): **BLOCK**
- **CRITICAL — open redirect via the emitted `?redirect=pathname`.** Holistic-reviewer concern that the proxy emits an unvalidated user-controlled redirect param. *Assessment:* not live-exploitable — both consumers (`login/page.tsx:26`, `auth/callback/route.ts:30`) already gate via `isSafeRedirect` which rejects `//` and `\`. But the defense-in-depth point is valid. **Integrated (v2):** proxy guards the emitted value with `isSafeRedirect`; `isSafeRedirect` relocated into the pure `route-protection.ts` (Edge-importable) as the single source of truth, re-exported from `auth.ts` for existing consumers; added `isSafeRedirect` unit tests.
- **MAJOR — `isPublicPage` prefix over-match** (`startsWith(p+"/")` could expose a future public route's children). **Integrated (v2):** exact-match only (`PUBLIC_PAGE_ROUTES.includes(pathname)`); no current public route has a legitimate child.
- **INFO — unused `SYSTEM_DEFAULT_ORG_ID`.** Acknowledged → cleanup follow-up (remove the now-unused Vercel env var; storage.ts references are comments only).

## Round 2 — Codex grounded-adversarial (v2): **BLOCK**
Grounded against the live tree (verified retired `getOrgContextDualPath` / live `SYSTEM_DEFAULT_ORG_ID` / `X-Org-Source` all absent from runtime; ran `unstable_doesMiddlewareMatch` + URL counterexamples + `tsc --noEmit`).
- **MAJOR — matcher boundary.** The page matcher lookahead excluded any path *starting with* `api` (e.g. `/apiary`, `/api-docs`), so the proxy never ran on such a page → a future `/api*`-prefixed page would be unprotected. No live page today. **Integrated (v3):** lookahead `api` → `api(?:/|$)` (matches exactly `/api` + `/api/*`, not `/apiary`).
- **MAJOR — login redirect dropped the query string.** `/new?clone=<slug>` emitted `redirect=/new`, breaking Clone&Edit through the login bounce (the form activates clone prefill from `?clone=`). **Integrated (v3):** redirect target is `pathname + req.nextUrl.search`, `isSafeRedirect`-guarded; the full 4-hop chain (proxy → login page → action → callback) encodes via `searchParams` and re-validates at each hop.
- **INFO — packet said "14 tests", actual 12.** Packet miscount; no code impact. (Frontend suite total 86 = 74 prior + 12 route-protection.)

## Round 3 — Codex fidelity-QA (v3): **ENDORSE — findings: none**
Re-read the current `frontend/proxy.ts`; confirmed both MAJORs fixed and no new issue. Independently re-verified `isSafeRedirect` accepts `/new?clone=slug` + `/apiary?x=1` and rejects `//evil.com`, `/\evil.com`, `https://evil.com`, `evil.com`, `/has space`. `tsc --noEmit` passed.

## Resolution: **CLEAR to merge.** Both reviewers ENDORSE after integration; sequential topology satisfied.

## Verification (final, on the merged v3 tree)
- `pnpm test`: **428 agent + 86 frontend = 514 pass, exit 0** (incl. `tsc --noEmit` on both projects + 12 route-protection tests).
- `next build`: exit 0; Proxy (Middleware) + all routes compile.
- Runtime (local `next dev`, real Supabase):
  - ANON: `/`,`/runs`,`/new` → 307 `/login?redirect=…`; `/login`,`/no-org` → 200; `/api/{runs,state,queue}` → 401; public `POST /api/queue/generate-questions` → 400.
  - OWNER (provisioned member, minted session): `/` → 200; `/api/runs` → 200 (runsCount=16); not locked out.
  - NO-MEMBERSHIP (throwaway user, deleted after): `/` → 307 `/no-org`; `/api/runs` → 401.
  - v3 fixes: `/new?clone=source-run-123` → 307 `/login?redirect=%2Fnew%3Fclone%3Dsource-run-123` (query preserved); `/apiary` → 307 `/login` (now protected).

## Follow-ups (non-blocking, INFO)
1. Remove the now-unused `SYSTEM_DEFAULT_ORG_ID` env var from the Vercel project (frontend runtime no longer reads it; `lib/storage.ts` references are comments). Local org-gated-route testing now requires the dev-session mint (`reference_localhost_dev_session_mint`), not the env trick.
2. Phase 5 (RLS canonicalization: `SET NOT NULL` / `DROP DEFAULT` already applied per B-2) remains separately tracked.
