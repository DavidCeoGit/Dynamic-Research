# MERGE-Gate Peer Review — S145 @supabase/ssr 0.10.3 → 0.12.0 (frontend auth/SSR)

**Date:** 2026-06-18 (S145) · **Gate:** MERGE · **Risk labels:** SECURITY (auth/tenant isolation) +
DEPENDENCY · **Severity:** NORMAL · **Topology:** sequential Gemini → ground → Codex → Gemini QA
**Branch:** `fix/s145-supabase-ssr-0.12` · **PR:** #31 · **Author:** Claude (Opus 4.8)
**Plan:** `~/.claude/plans/ticklish-splashing-ritchie.md`

## Change
Frontend-only dependency bump (no application code changed):
- `@supabase/ssr` `^0.10.3` → `^0.12.0` (resolves 0.12.0; no 0.11 ever published)
- `@supabase/supabase-js` `^2.107.0` → `^2.108.0` (resolves 2.108.2) — REQUIRED peer of ssr 0.12
Files: `frontend/package.json` + `frontend/pnpm-lock.yaml` + this doc. Agent worker does NOT use
`@supabase/ssr` → no DR-Deploy/worker restart; Vercel is the only deploy surface.

## Why no code change
0.12's cookie contract (`setAll(cookiesToSet, headers)` + `getAll`, `{name,value,options}` items,
`Object.entries(headers).forEach(...response.headers.set...)`) is EXACTLY what `frontend/proxy.ts` and
`frontend/lib/supabase-server.ts` already implement — verified against the installed 0.12 `types.d.ts`.

## Gate timeline
### Gemini holistic-adversarial (v1) → BLOCK (MAJOR)
Premise: the 0.12 chunked-cookie encoding change could make `getUser()` THROW on a legacy/old-format
cookie → unhandled exception → 500 on every authed request → HARD LOCKOUT (user can't reach /login to
recover). A mechanism claim about the shipped library.

### Grounding + Codex grounded-adversarial (arbiter) → ENDORSE
Codex verified against installed source + ran a runtime smoke. Gemini's throw-to-500 premise is
REFUTED — the read path fails closed GRACEFULLY at three layers:
1. `@supabase/ssr@0.12 cookies.js decodeChunkedCookieValue()` (L13-33): base64url-decode failure →
   warn + `return null`; `JSON.parse` failure → warn + `return null`. Doc comment: "treat the entry as
   absent so the SDK does not propagate or re-save the corrupted payload." Server `getItem` (L296-318)
   returns null for absent/partial chunks; `combineChunks` returns null on read (no throw).
2. `@supabase/supabase-js@2.108.2 auth-js`: `getItemAsync` catches parse failure → null;
   `__loadSession()` → `{session:null,error:null}`; `getUser()` → `AuthSessionMissingError` RESULT
   (not an uncaught throw); `throwOnError` defaults false.
3. **Runtime smoke (Codex):** no-cookie / raw legacy value / bad `base64-*` / invalid session JSON /
   partial chunk → ALL returned `user:null`, `AuthSessionMissingError`, `threw:false`. = clean one-time
   logout, NOT a lockout.
No tenant-bleed: `getUser()` validates the access token against Supabase Auth (not local
`session.user`); org scoping queries `organization_members.eq(user_id, user.id)`. A malformed cookie
cannot synthesize another user. Codex: no CRITICAL/MAJOR; MINOR = "logout, not lockout"; ENDORSE.

### Gemini sequential QA (reconsideration with evidence) → RESOLVED
Given the source + runtime-smoke evidence, Gemini withdrew its BLOCK: "the failure mode I was concerned
about does not exist in the new version; the libraries are designed to fail gracefully into a
logged-out state." Disagreement settled by grounded evidence, NOT by override.

## Verification (author)
- `pnpm test` (root): agent 428 + frontend 74 = 502/502, exit 0 (incl. both `tsc --noEmit`).
- `pnpm -C frontend exec next build`: exit 0. Import smoke: ssr + supabase-js load.
- Resolution: ssr 0.12.0 + supabase-js 2.108.2, single versions, peer satisfied.

## Residual risk + verification plan
Cookie-migration (existing 0.10 session under 0.12) is domain-bound to PROD and proven benign (graceful
one-time re-login). User chose: merge → manual auth walkthrough on prod
(`dynamic-research.vercel.app`) → `git revert` in <1 min if any step fails (frontend-only, no
DB/migration). Logs: `c:/tmp/s145-ssr-{gemini,codex,gemini-qa}.log`; packet `c:/tmp/s145-ssr-gate-packet.md`.

## Outcome
**ENDORSE — merge approved.** Full Gemini+Codex+Claude SECURITY gate cleared before merge; the lone
BLOCK was refuted by grounded source + empirical runtime evidence and withdrawn by its author.
