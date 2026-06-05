# SSR Auth Refactor — Design v3

> Authored S54 (2026-05-26). Status: **DESIGN-gate, post-Codex-code-grounded round 2 integration; awaiting Codex Sequential QA round 3** (see `~/CLAUDE.md` Multi-Reviewer Policy Framework §Review Topology — DESIGN-revision rule: reviewer who caught more last round runs QA).
> Companion peer-review log: `Documentation/ssr-auth-refactor-design-peer-review.md` — records every reviewer finding + author disposition.
>
> **v3 deltas (integrated from Codex round 2):**
> - **C-C1 (CRITICAL/BLOCKING/SECURITY):** Fixed cross-tenant data leak via `POST /api/queue` `parentSlug → parent_run_id` lookup. Phase 2 refactor now scopes the parent query with `.eq('organization_id', orgId)`. Recommended a DB-level composite-FK or BEFORE-INSERT trigger guard — added to Phase 5+ scope as new §4.5.
> - **C-M1 (MAJOR):** Middleware design phase-gated. Phase 1 refreshes cookies only (no route protection). Phase 2 adds dual-path tolerance for the 8 cutover routes. Phase 4 promotes to full protection. Updated §2.5 + §5 row table.
> - **C-M2 (MAJOR):** Replaced single-matcher with two-matcher pattern. `/api/:path*` always runs through proxy (protects dynamic API file routes like `/api/runs/<slug>/file/chart.png`); static asset exclusion applies only outside `/api`.
> - **C-M3 (MAJOR/SECURITY):** Open-redirect closed. Login flow now uses a hidden `redirect` form field validated for same-origin (must start with `/` but not `//`); Server Action passes through `emailRedirectTo`; callback re-validates before navigation.
> - **C-M4 (MAJOR):** §2.2 rewritten to not overclaim `@supabase/ssr` defaults — enumerates the cookie options we explicitly want with sources, adds a Phase 1 DevTools-verification checkpoint.
> - **C-M5 (MAJOR):** Static-grep preflight in §5 row 5 upgraded from single-line `git grep` to multiline `rg -U` to actually catch the multi-line insert at `frontend/app/api/queue/route.ts` lines 80-95.
> - **C-M6 (MAJOR):** §8.3 expanded with 10-point minimum spec for `agent/scripts/test-ssr-auth-cutover.sh`.
> - **C-m1 (MINOR):** §6 T14 split into T14a (app-level fail via `.single()` → PostgREST 406) and T14b (DB-level fail via `private.auth_user_organization_id()` → SQLSTATE 21000).
> - **C-m2 (MINOR/AMENDED RATIONALE):** Globally renamed `middleware.ts` → `proxy.ts` and `function middleware` → `function proxy`. NOT because Next 16 deprecated `middleware.ts` (verified via Perplexity 2026-05-26 — it didn't), but because `@supabase/ssr`'s migration guide for Next 16 standardizes on `proxy.ts`. Rationale documented in §2.5.
>
> **v2 deltas (preserved from Gemini round 1; see peer-review companion for full audit trail):**
> - G-C1 dropped impossible SQL preflight; G-M1 broadened proxy matcher (now refined per C-M2); G-m1 clarified handler tag distribution; G-m2 mandated `SameSite=Lax`; §9 Q1-Q8 all resolved.

---

## 0. Executive summary

### 0.1 What

Replace 8 handler bodies (across 7 files) that derive `organization_id` from either `process.env.SYSTEM_DEFAULT_ORG_ID`, `resolveOrgForSlug(slug)`, or the Phase A schema DEFAULT, with **session-derived `orgId` from a real SSR-cookie-based Supabase Auth context**. 5 of the 8 carry an explicit `STOPGAP(SSR-auth)` comment; the other 3 (queue routes) implicitly rely on the Phase A DEFAULT and are not grep-discoverable via that tag — see §1.3 for full inventory. Add the prerequisite auth infrastructure: `@supabase/ssr`, `frontend/proxy.ts` (the Next-16 `@supabase/ssr` naming convention; see §2.5), magic-link login page, `/auth/callback` route, request-scoped server-client + `requireOrgContext()` helper. Stage the rollout across 5 phases so each phase is independently deployable and reversible. The final phase applies the deferred Phase B-2 migration (`ENABLE ROW LEVEL SECURITY` on the 4 tenant tables + `DROP DEFAULT` on `research_queue.organization_id`) as the multi-tenancy RLS cutover.

### 0.2 Why now

Phase B-2 (the second half of multi-tenancy) is blocked on this refactor. Per `Documentation/multi-tenancy-phase-b-plan.md` §4: *"Running Phase B-2 against a partially-deployed frontend (still using service-role) would lock users out via RLS."* The system-default DEFAULT on `research_queue.organization_id` is the temporary safety net that this refactor retires; until frontend always writes an explicit `org_id` AND derives identity from a real JWT, B-2's `ENABLE RLS + DROP DEFAULT` would either lock out every authenticated path or silently reject every queue insert.

### 0.3 Risk classification (per `~/CLAUDE.md` Multi-Reviewer Policy Framework)

| Axis | Value |
|---|---|
| Event Gate | **DESIGN** for this doc; subsequent **MERGE** at each of the 5 phase implementations |
| Risk Labels | **SECURITY** (auth/authz), **AGENT BEHAVIOR** (changes how every user-facing route resolves tenancy), **ARCHITECTURE** (introduces SSR cookie session as cross-cutting concern), **DEPENDENCY** (adds `@supabase/ssr`) |
| Severity Mode | **NORMAL** |
| Reviewer order | Sequential **Gemini Deep Think → integrate → Codex** for this DESIGN doc; same per-phase for each MERGE gate |
| Artifacts | This file + `Documentation/ssr-auth-refactor-design-peer-review.md`; per-phase MERGE-gate peer reviews at `Documentation/ssr-auth-refactor-phase-<N>-merge-gate-peer-review.md` |
| Blocking semantics | SECURITY-labeled CRITICAL findings block merge until resolved or human risk-acceptance is signed (per `~/CLAUDE.md` §Disagreement Procedure) |

### 0.4 Effort estimate

| Phase | Scope | Estimate | Deployable | Reversible |
|---|---|---|---|---|
| 0 | This DESIGN doc + 2 reviewer rounds + integration | ~3h | n/a | n/a |
| 1 | Auth infra: `@supabase/ssr`, `proxy.ts`, `/login`, `/auth/callback`, helpers. No STOPGAP changes. | ~3h | ✓ (deploys greenfield surface; existing routes unaffected) | ✓ (revert proxy + delete pages) |
| 2 | Refactor 8 handler bodies to **dual-path** (env fallback if no session, session-derived if session present); add cross-org slug guard | ~3-4h | ✓ (per-route incremental) | ✓ (env fallback preserved through the whole phase) |
| 3 | Soak window — verify both paths in production, monitor `audit_storage_writes`, confirm no zero-row queries | ~3 days wall-clock, ~0.5h active | n/a | n/a |
| 4 | Remove env fallback; assert session-derived `orgId` only; delete `SYSTEM_DEFAULT_ORG_ID` reads | ~1h | ✓ | ✓ (re-add env fallback) |
| 5 | Apply Phase B-2 migration (`ENABLE RLS` + `DROP DEFAULT`); run plan §6 RLS bypass test grid | ~2h | ✓ (deploy = `supabase db push`) | Limited (rollback = follow-up migration `DISABLE RLS` + re-add DEFAULT) |

**Total: ~12-14h active work** across roughly 1 week elapsed (soak gate at Phase 3).

---

## 1. Scope

### 1.1 IN

- Add `@supabase/ssr` (official Supabase SSR helper, post-2024 successor to `@supabase/auth-helpers-nextjs`) as `frontend/` dependency.
- Add `NEXT_PUBLIC_SUPABASE_ANON_KEY` to Vercel production env (Preview + Development too).
- Author `frontend/proxy.ts` for cookie session refresh + (Phase 4) protected-route redirect. (`proxy.ts` rather than `middleware.ts` per Supabase `@supabase/ssr` Next 16 migration guide — see §2.5 for rationale.)
- Author `frontend/lib/supabase-server.ts` exporting `createServerSupabase()` (request-scoped client wrapping `@supabase/ssr.createServerClient`).
- Author `frontend/lib/auth.ts` exporting `requireUser()` and `requireOrgContext()` helpers (the latter joins `auth.uid()` → `organization_members.organization_id`).
- Author `frontend/app/login/page.tsx` (magic-link email form).
- Author `frontend/app/login/actions.ts` (Server Action calling `signInWithOtp`).
- Author `frontend/app/auth/callback/route.ts` (OAuth code → session exchange).
- Author `frontend/app/no-org/page.tsx` (informational page for authenticated users without a membership row).
- Refactor 8 handler bodies across 7 files (Phase 2):
  - `app/api/state/route.ts` (1 GET)
  - `app/api/runs/route.ts` (1 GET — gallery list)
  - `app/api/runs/[slug]/manifest/route.ts` (1 GET)
  - `app/api/runs/[slug]/files/route.ts` (1 GET)
  - `app/api/runs/[slug]/file/[filename]/route.ts` (1 GET)
  - `app/api/queue/route.ts` POST (must add explicit `organization_id` on insert) + GET (must filter by `organization_id`)
  - `app/api/queue/[id]/route.ts` GET (user-facing poll; must verify `organization_id` matches session)
- Add `agent/scripts/test-ssr-auth-cutover.sh` exercising the RLS bypass test grid from `multi-tenancy-phase-b-plan.md` §6.2.
- Apply Phase B-2 migration (`supabase/migrations/20260601_phase_b_2_enable_rls.sql` — placeholder date) at Phase 5.

### 1.2 OUT (deferred or out-of-scope entirely)

- **Phase F invite flow** (`POST /api/orgs/[id]/invitations`, accept-by-token page, etc.) — separate initiative; primary owner is the only user this refactor needs to support.
- **Sign-up self-service** — sign-up = "owner provisions you via migration script + sends you the magic-link email"; no public sign-up form.
- **Password auth, OAuth (Google/GitHub), 2FA, session revocation UI**.
- **Org switcher UI** — the `om_one_org_per_user` UNIQUE constraint from Phase B-1 §2 forbids multi-org-per-user; no switcher possible until that constraint is dropped.
- **Worker daemon auth changes** — worker continues using service-role + X-Agent-Key header on `/api/queue/claim` and PATCH `/api/queue/[id]`. Unchanged.
- **`/api/queue/extract-context` and `/api/queue/generate-questions` auth changes** — per `~/CLAUDE.md` Security Requirements + product decision (recorded in this session), these remain **unauthenticated + per-IP rate-limited**. They invoke Anthropic only, never touch the DB; binding them to a session would gate the pre-signup form-wizard UX with no security gain.
- **Admin UI for managing members** — service-role admin script only for now.
- **Login analytics / login email customization** — Supabase default email template is acceptable for the first user (David); customization waits until invite flow ships.

### 1.3 Affected file inventory

| File | Phase 1 | Phase 2 | Phase 4 | Phase 5 |
|---|---|---|---|---|
| `frontend/package.json` | +dep | — | — | — |
| `frontend/proxy.ts` | NEW (cookie-refresh only; no route protection — see §2.5 phase-gating) | — | edit (populate `PROTECTED_PHASE_4` array; enable redirect block) | — |
| `frontend/lib/supabase.ts` | unchanged (keeps service-role singleton) | — | — | — |
| `frontend/lib/supabase-server.ts` | NEW | — | — | — |
| `frontend/lib/auth.ts` | NEW (`requireUser`, `requireOrgContext`) | edit (add `getOrgContextDualPath`) | edit (delete dual-path helper) | — |
| `frontend/lib/storage.ts` | — | edit (`resolveOrgForSlug` becomes belt-and-suspenders, not primary) | edit (delete `resolveOrgForSlug` or mark internal-only) | — |
| `frontend/app/login/page.tsx` | NEW | — | — | — |
| `frontend/app/login/actions.ts` | NEW | — | — | — |
| `frontend/app/auth/callback/route.ts` | NEW | — | — | — |
| `frontend/app/no-org/page.tsx` | NEW | — | — | — |
| `frontend/app/api/state/route.ts` | — | edit | edit | — |
| `frontend/app/api/runs/route.ts` | — | edit | edit | — |
| `frontend/app/api/runs/[slug]/manifest/route.ts` | — | edit | edit | — |
| `frontend/app/api/runs/[slug]/files/route.ts` | — | edit | edit | — |
| `frontend/app/api/runs/[slug]/file/[filename]/route.ts` | — | edit | edit | — |
| `frontend/app/api/queue/route.ts` | — | edit (POST + GET) | edit | — |
| `frontend/app/api/queue/[id]/route.ts` | — | edit (GET only; PATCH unchanged) | edit | — |
| `agent/scripts/test-ssr-auth-cutover.sh` | NEW (skeleton) | edit (per-route tests) | edit (negative tests) | edit (post-RLS tests) |
| `supabase/migrations/20260601_phase_b_2_enable_rls.sql` | — | — | — | NEW (includes `research_queue_parent_same_org` trigger from §4.5) |

**STOPGAP tag distribution (Q-m1 fidelity, S54 round 3):** Of the 8 affected handler bodies above, **5 carry an explicit `STOPGAP(SSR-auth)` comment** that grep-locates them — they are: `app/api/state/route.ts`, `app/api/runs/route.ts`, `app/api/runs/[slug]/manifest/route.ts`, `app/api/runs/[slug]/files/route.ts`, `app/api/runs/[slug]/file/[filename]/route.ts`. **3 are NOT tagged** (do not contain the STOPGAP string) but still implicitly rely on the Phase A schema DEFAULT: they are the 2 handlers in `app/api/queue/route.ts` (POST + GET) and the 1 handler in `app/api/queue/[id]/route.ts` (GET only — PATCH is X-Agent-Key worker auth and OUT of scope). A pure-grep-driven implementation would miss the 3 queue handlers; the file inventory above is the authoritative reference.

---

## 2. Architecture decisions

### 2.1 Library: `@supabase/ssr` (vs. roll-your-own)

**Decision: `@supabase/ssr`.**

Rationale:
- Official Supabase package; succeeds `@supabase/auth-helpers-nextjs` (which is in maintenance mode as of 2024).
- First-class App Router support: `createServerClient`, `createBrowserClient`, cookie store abstraction compatible with `next/headers`.
- Handles the cookie-rotation dance on token refresh that is the most footgun-prone part of SSR auth.
- Single small dep (~50KB) — meets project's "prefer high-level abstractions over boilerplate" rule in `~/CLAUDE.md`.

Rejected alternatives:
- Roll-your-own — ~200 lines of cookie + JWT verification + refresh logic, all of which are exactly the bugs `@supabase/ssr` was extracted to fix.
- `@supabase/auth-helpers-nextjs` (legacy) — deprecated; would force a second migration later.
- NextAuth + Supabase adapter — heavyweight, conflicts with Supabase's own JWT-bearing client design, and the adapter has stale Supabase v1 assumptions.

### 2.2 Cookie strategy

**Decision: explicitly configure each cookie option rather than rely on `@supabase/ssr` "defaults".** v2 incorrectly stated `HttpOnly: true` was a `@supabase/ssr` default; per Codex C-M4 review of current Supabase docs (2026-05), the SSR auth cookies are NOT necessarily HttpOnly — the browser-client side may need token access for the realtime subscription pattern. The right move is to make the choice explicit.

**Options we set, in our `cookies.setAll(xs)` handler:**

| Option | Value | Why |
|---|---|---|
| `name` | per `xs[i].name` from `@supabase/ssr` | Library-managed; multiple cookies (`sb-<ref>-auth-token`, `sb-<ref>-auth-token-code-verifier`, etc.) |
| `value` | per `xs[i].value` | Library-managed |
| `httpOnly` | `true` (Phase 1 only — re-evaluate before adding browser-client realtime in a future phase) | Defense-in-depth against XSS exfiltration; we have no current browser-client requirement |
| `secure` | `true` always (auto-disabled by `@supabase/ssr` on `localhost` per docs) | Prevents transmission over HTTP |
| `sameSite` | `'lax'` (MANDATORY — see G-m2 below) | PKCE code-verifier must ride cross-site GET from email-client click |
| `path` | `'/'` | Cookie applies to entire site |
| `maxAge` / `expires` | per `xs[i].options` from `@supabase/ssr` | Library-managed; tied to JWT refresh window |

**`SameSite=Lax` is MANDATORY, not preferential** (resolved Gemini G-m2): `@supabase/ssr` uses PKCE for the magic-link OAuth code exchange; the code-verifier cookie must ride the cross-site GET when the user clicks the magic link from an external email client (e.g., Gmail web → `/auth/callback?code=...`). `SameSite=Strict` would suppress the cookie on that cross-site navigation, causing `exchangeCodeForSession` to fail with PKCE mismatch and a hard-to-debug "Auth session missing" error.

**Phase 1 verification checkpoint (added per C-M4):** post-deploy, open Chrome DevTools → Application → Cookies → `https://dynamic-research.vercel.app` and confirm:
- All `sb-*-auth-*` cookies have `HttpOnly` ✓, `Secure` ✓, `SameSite=Lax` ✓, `Path=/` ✓.
- Browser cannot read the auth cookies via `document.cookie` (sanity-check the HttpOnly flag).
- Logout clears all `sb-*-auth-*` cookies.

If any of these fail, re-check our `cookies.setAll` implementation against the `@supabase/ssr` API surface — the library passes options through but our handler may be discarding them.

### 2.3 Server client architecture: request-scoped, not singleton

**Decision: `createServerSupabase()` constructs a NEW client per request.**

`frontend/lib/supabase.ts` keeps its service-role singleton (used by `/api/queue/claim`, `/api/queue/[id]` PATCH, the worker, and Phase 2's dual-path internals). `frontend/lib/supabase-server.ts` is a new file exporting `createServerSupabase()` that takes the request's cookie store from `next/headers` and constructs an `@supabase/ssr.createServerClient` instance bound to that request. Per-request construction is mandatory because the cookie store is per-request; sharing a client across requests would leak sessions across users.

```ts
// frontend/lib/supabase-server.ts (pseudocode)
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// §2.2: explicit cookie options enforced for every set, regardless of
// what the library's caller wants to pass. Q-M2 (S54 round 3) — without
// this override we were re-introducing reliance on library defaults.
const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
};

export async function createServerSupabase() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (xs) => xs.forEach(({ name, value, options }) =>
          // Library-supplied `options` (e.g., maxAge) merged first;
          // our security-critical options override last to enforce §2.2.
          cookieStore.set(name, value, { ...options, ...AUTH_COOKIE_OPTIONS })),
      },
    },
  );
}
```

### 2.4 Auth helpers API surface

**Decision: two helpers, both throwing on auth failure (consumer catches and returns 401/403).**

```ts
// frontend/lib/auth.ts (pseudocode)
export async function requireUser(): Promise<User> {
  const supabase = await createServerSupabase();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new UnauthorizedError("No session");
  return user;
}

export async function requireOrgContext(): Promise<{ user: User; orgId: string }> {
  const user = await requireUser();
  const supabase = await createServerSupabase();
  const { data, error } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .single();
  if (error || !data) throw new ForbiddenError("User has no organization membership");
  return { user, orgId: data.organization_id };
}
```

**Why use the user-context client (anon key + JWT) for the membership lookup, not service-role?**
- Defense-in-depth: any path that doesn't go through `auth.uid()` is one bug away from cross-tenant leakage.
- Post Phase 5: the `om_select` RLS policy from B-1 already permits a user to see their own row (`user_id = auth.uid()`), so the lookup succeeds under RLS.
- Pre Phase 5: RLS is not enabled on `organization_members`, so the user-context query succeeds via permissive default — same result.

**Why use `.single()`?** The `om_one_org_per_user` UNIQUE constraint from B-1 §2 guarantees at most one row; using `.single()` matches the constraint's invariant and surfaces violations as PostgreSQL `PGRST116` (no rows) or PostgREST 406 (multiple rows) — both diagnostic.

### 2.5 Proxy (formerly "middleware") responsibility — phase-gated

**Naming (C-m2, S54 Codex round 2, amended rationale):** the file is `frontend/proxy.ts` with `export async function proxy(...)`, NOT `frontend/middleware.ts` with `export async function middleware(...)`. Verified via Perplexity Sonar (2026-05-26): Next.js 16 itself did NOT deprecate `middleware.ts` — it still works at the framework level. HOWEVER, the Next-16 ecosystem (Clerk, Auth0, Prismic, Supabase) has standardized on `proxy.ts`, and Supabase's **`@supabase/ssr` migration guide for Next 16 specifically uses `proxy.ts`**. Since this design depends on `@supabase/ssr`, alignment with their docs dictates `proxy.ts`. (If we ignored ecosystem alignment and used `middleware.ts`, it would compile and run, but future Supabase doc updates and integration examples would not match our codebase.)

**Decision: behavior phase-gated across the rollout** (C-M1, S54 Codex round 2). The same `proxy.ts` file ships in Phase 1 with minimal behavior, then grows in Phase 4 to add full route protection.

| Phase | `proxy.ts` behavior | Why |
|---|---|---|
| 1 | Cookie refresh ONLY. Calls `supabase.auth.getUser()` to trigger token-refresh cookie rotation. NEVER redirects. | "Existing routes unaffected" (Phase 1 goal). Unauth requests pass through to the STOPGAP routes' env-fallback path. |
| 2 | Same as Phase 1 (cookie refresh only). | Phase 2 smoke needs the logged-out env-path reachable for the dual-path test. |
| 3 (soak) | Same as Phase 1. | Allow both paths during soak. |
| 4 | Adds route protection. Unauth requests to any non-public route → 302 `/login?redirect=...`. | The env fallback is gone; routes require a session. proxy.ts redirect protects them before they 500. |
| 5 | No change to proxy.ts. | RLS migration is DB-side. |

**Two-matcher pattern** (C-M2, S54 Codex round 2): the v2 single-matcher broadened-extension approach regressed `/api/runs/<slug>/file/<filename>` (dynamic tenant data routes that serve `chart.png`, `report.pdf`, etc., which would be skipped as if they were static assets). v3 uses two matchers — `/api/:path*` ALWAYS runs through proxy (auth-aware regardless of file extension); the static-exclusion matcher applies only OUTSIDE `/api`.

```ts
// frontend/proxy.ts (Phase 1 form — cookie refresh only; Phase 4 adds the protected-redirect block below)
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Phase 4: these are the routes that require auth. Empty in Phase 1-3.
const PROTECTED_PHASE_4: string[] = [
  // To be populated in Phase 4. Until then, route handlers do their own
  // auth via getOrgContextDualPath() and emit 401/302 themselves.
];

const PUBLIC_ROUTES = [
  "/login",
  "/auth/callback",
  "/no-org",
  "/api/queue/extract-context",
  "/api/queue/generate-questions",
  "/api/queue/claim",          // X-Agent-Key auth, NOT user session
  "/api/healthz",
];

export async function proxy(req: NextRequest) {
  const res = NextResponse.next();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (xs) => xs.forEach(({ name, value, options }) =>
          // §2.2: enforce our security-critical cookie options. Q-M2
          // (S54 round 3): library-supplied options were passed verbatim,
          // re-introducing reliance on library defaults. Override explicitly.
          res.cookies.set(name, value, {
            ...options,
            httpOnly: true,
            secure: true,
            sameSite: "lax",
            path: "/",
          })),
      },
    },
  );

  // CRITICAL: getUser() triggers the token-refresh cookie rotation when needed.
  // Always call it, regardless of whether the route is protected.
  const { data: { user } } = await supabase.auth.getUser();

  const { pathname } = req.nextUrl;

  // Special case: /api/queue/[id] PATCH is worker-only (X-Agent-Key); GET is user-facing.
  // Method-aware skip: the route's own handler does the X-Agent-Key check for PATCH.
  // Next 16: `req.method` is reliable in the proxy.ts runtime.
  if (pathname.match(/^\/api\/queue\/[^/]+$/) && req.method === "PATCH") {
    return res;
  }

  // PHASE 4 ONLY (commented out for Phase 1-3 deploy):
  // const isPublic = PUBLIC_ROUTES.includes(pathname);
  // const isProtected = PROTECTED_PHASE_4.some((p) =>
  //   p === pathname || pathname.startsWith(p + "/"));
  // if (!user && isProtected && !isPublic) {
  //   const url = req.nextUrl.clone();
  //   url.pathname = "/login";
  //   url.searchParams.set("redirect", pathname);  // sanitized later, see §3.1
  //   return NextResponse.redirect(url);
  // }

  return res;
}

export const config = {
  matcher: [
    // Matcher 0 (added v3, C-M2): /api/* ALWAYS through proxy — dynamic API
    // file routes like /api/runs/<slug>/file/chart.png are TENANT data, not
    // static assets. Skipping them by extension would create cross-tenant
    // access bypass.
    "/api/:path*",
    // Matcher 1: page routes + non-/api requests, excluding Next internals
    // and frontend/public/ static assets (svg/png/...).
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf)$).*)",
  ],
};
```

**Why call `getUser()` even when the route is public?** Because the side effect is the cookie-refresh write — failing to call it means a logged-in user browsing public routes never gets their token refreshed, eventually expires. This is the canonical `@supabase/ssr` proxy pattern.

**Why `getUser()` not `getSession()`?** `getSession()` reads the cookie without contacting the auth server; the JWT could be expired-but-not-yet-detected. `getUser()` revalidates against the auth server. Per Supabase docs §SSR: always `getUser()` in proxy.

### 2.6 RLS interaction during the dual-path soak (Phase 2 → Phase 5)

**Decision: STOPGAP routes continue querying the DB via SERVICE-ROLE, even after gaining session identity in Phase 2.** The user-context client is auth-only (used to derive `orgId`), not query-only.

Reasoning: Phase B-2 (Phase 5) is what enables RLS. Pre-Phase 5, querying via user-context would work the same as service-role (no RLS to enforce). Post-Phase 5, querying via user-context would let RLS do automatic enforcement — but we keep service-role + manual `.eq('organization_id', orgId)` because:

1. The existing route code already does service-role queries; minimizing the diff cuts review surface area.
2. Manual `.eq()` is RLS-independent — if RLS is ever toggled off for diagnostic reasons, the routes don't silently cross tenants.
3. `audit_storage_writes` (B-1 §6) is the compensating control for service-role writes; this pattern preserves the audit trail.

**Codex / Gemini: this is the most opinionated decision in the doc — please weigh in.** Counterargument: switching to user-context post-Phase 5 gets us "RLS does the work" semantics for free and is the standard Supabase pattern. The cost is duplicating client construction inside every route handler.

### 2.7 Cross-org slug-collision guard

**Decision: post-Phase 4, the slug-bearing routes (state, manifest, files, file, queue/[id]) MUST hard-fail rather than 404 on cross-org slug match.**

Pre-refactor: `lib/storage.ts` `resolveOrgForSlug` already returns `null` and logs `Phase B SSR auth refactor must land before serving this request` on multi-org collision. This is a defense-in-depth gap: an attacker who guesses a slug from another org's run gets a 404, but the route never explicitly verifies "this slug belongs to MY org."

Post-refactor (Phase 2 dual-path):
```ts
// Pseudocode for every slug-bearing route
const { orgId } = await requireOrgContext();
const supabase = getSupabase();  // service-role
const { data: row, error } = await supabase
  .from("research_queue")
  .select("id, organization_id")
  .eq("topic_slug", slug)
  .eq("organization_id", orgId)   // ← the explicit guard
  .maybeSingle();
if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
```

Post-Phase 5 (RLS enabled): the `rq_select` policy from B-1 §5.1 enforces this server-side too — but the explicit `.eq()` stays for the defense-in-depth reasons in §2.6.

### 2.8 Email deliverability (magic-link)

Per memory `feedback_resend_free_tier_own_email_only.md`, Resend's free tier sends only to the account owner. Supabase Auth uses its own SMTP (not Resend) and supports magic-link email out of the box for any address with no per-tier restrictions. **For this refactor, we rely on Supabase's default SMTP**. A future Resend domain-verified setup (Phase F invite flow) is a separate initiative.

### 2.9 Worker daemon — explicitly unchanged

Worker continues to:
- Use `SUPABASE_SERVICE_ROLE_KEY` (no JWT, no session, no cookies).
- Call `POST /api/queue/claim` with `X-Agent-Key: ${AGENT_SECRET_KEY}` header.
- Call `PATCH /api/queue/[id]` with the same header.
- Bypass RLS post-Phase 5 (service-role always bypasses; the `audit_storage_writes` table from B-1 §6 is the compensating control).

The worker is the load-bearing producer; introducing JWT auth there is out of scope and would create a separate failure mode (JWT expiry mid-job).

---

## 3. Magic-link flow

### 3.1 Login page

`frontend/app/login/page.tsx` — Server Component renders a form with two inputs: visible email field + **hidden `redirect` field bound to `searchParams.redirect`** (per C-M3, to round-trip the originating path through the magic-link click).

```tsx
// frontend/app/login/page.tsx (pseudocode)
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ redirect?: string }> }) {
  const { redirect: redirectParam } = await searchParams;
  // Re-validate here (defense-in-depth; Server Action validates again)
  const safeRedirect = isSafeRedirect(redirectParam) ? redirectParam : "/";
  return (
    <form action={signInWithMagicLink}>
      <input type="email" name="email" required />
      <input type="hidden" name="redirect" value={safeRedirect} />
      <button type="submit">Send magic link</button>
    </form>
  );
}
```

`isSafeRedirect()` helper (`frontend/lib/auth.ts`):

```ts
export function isSafeRedirect(path: string | undefined): path is string {
  // Same-origin relative path: must start with '/' but NOT '//' (protocol-relative
  // URLs like '//evil.example/path' would be treated as external). Reject any
  // string with a scheme, an absolute URL, or whitespace.
  if (!path || typeof path !== "string") return false;
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//")) return false;
  if (/[\s\x00-\x1f]/.test(path)) return false;
  return true;
}
```

After submit, render an inline confirmation: "Check your email — link valid for 1 hour." Show server-rendered error if `signInWithOtp` returned an error (rate limit, invalid email, etc.).

### 3.2 Server Action

`frontend/app/login/actions.ts`:

```ts
"use server";
import { createServerSupabase } from "@/lib/supabase-server";
import { isSafeRedirect } from "@/lib/auth";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL!;  // hardcoded to prod URL — Q8

export async function signInWithMagicLink(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { error: "Invalid email format" };
  }

  // C-M3: validate redirect; embed in emailRedirectTo so Supabase's magic-link
  // email click preserves it through to /auth/callback. Supabase magic-link
  // emails ONLY preserve the ?code= param + any params on emailRedirectTo —
  // not arbitrary login-page query string params.
  const redirectRaw = String(formData.get("redirect") ?? "/");
  const safeRedirect = isSafeRedirect(redirectRaw) ? redirectRaw : "/";

  const callbackUrl = new URL("/auth/callback", SITE_URL);
  callbackUrl.searchParams.set("redirect", safeRedirect);

  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: callbackUrl.toString(),
      shouldCreateUser: false,  // CRITICAL: only allow existing users
    },
  });
  if (error) return { error: error.message };
  return { ok: true };
}
```

**`shouldCreateUser: false`** is the safety gate — sign-up is not self-service in v1. An unknown email gets an error (Supabase returns a generic "for security, we don't disclose whether this email exists" message, which is the correct posture).

### 3.3 Callback route

`frontend/app/auth/callback/route.ts`:

```ts
import { createServerSupabase } from "@/lib/supabase-server";
import { isSafeRedirect } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const redirectParam = url.searchParams.get("redirect");

  // C-M3: re-validate redirect (defense-in-depth; was validated in Server
  // Action but re-validating here protects against a manually-crafted
  // /auth/callback?code=...&redirect=<attack> URL).
  const safeRedirect = isSafeRedirect(redirectParam) ? redirectParam : "/";

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=missing_code", url));
  }

  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error.message)}`, url),
    );
  }

  // Verify the just-logged-in user has a membership row; if not, /no-org.
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login?error=no_user_after_exchange", url));
  }
  const { data: member } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member) {
    return NextResponse.redirect(new URL("/no-org", url));
  }

  // Safe redirect; isSafeRedirect already enforced same-origin relative.
  // new URL(safeRedirect, url) with a path starting with '/' resolves to
  // the request's origin — cannot escape.
  return NextResponse.redirect(new URL(safeRedirect, url));
}
```

### 3.4 `/no-org` page

`frontend/app/no-org/page.tsx` — informational only. Renders: "Your account is signed in but not yet associated with an organization. Contact the workspace owner to be invited." Includes a "Sign out" form that calls `supabase.auth.signOut()` via Server Action.

This is the landing for the "user passes auth but membership lookup fails" case — i.e. an `auth.users` row exists (because owner manually provisioned it) but the `organization_members` insert hasn't happened yet, OR membership was revoked.

---

## 4. Per-route refactor plan (Phase 2 diffs)

All 8 handler bodies follow one of two shapes. Diff shape is shown as pseudo-patch.

### 4.1 Pattern A: env-constant routes (state GET, runs GET, queue POST, queue GET, queue/[id] GET)

Before (representative — `app/api/runs/route.ts`):

```ts
const ORG_ID = requireEnv("SYSTEM_DEFAULT_ORG_ID");

export async function GET() {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("research_queue")
    .select(...)
    .eq("organization_id", ORG_ID)
    .order(...);
  return Response.json(data);
}
```

After (Phase 2 dual-path):

```ts
import { getOrgContextDualPath } from "@/lib/auth";

export async function GET(req: Request) {
  const { orgId, source } = await getOrgContextDualPath();  // session OR env
  const supabase = getSupabase();
  const { data } = await supabase
    .from("research_queue")
    .select(...)
    .eq("organization_id", orgId)
    .order(...);
  res.headers.set("X-Org-Source", source);  // diagnostic for soak
  return Response.json(data);
}
```

After (Phase 4 final):

```ts
import { requireOrgContext } from "@/lib/auth";

export async function GET() {
  const { orgId } = await requireOrgContext();
  const supabase = getSupabase();
  const { data } = await supabase
    .from("research_queue")
    .select(...)
    .eq("organization_id", orgId)
    .order(...);
  return Response.json(data);
}
```

`getOrgContextDualPath` (Phase 2 helper; deleted in Phase 4):

```ts
// frontend/lib/auth.ts (Phase 2 add)
export async function getOrgContextDualPath(): Promise<{ orgId: string; source: "session" | "env" }> {
  try {
    const { orgId } = await requireOrgContext();
    return { orgId, source: "session" };
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      const envOrgId = process.env.SYSTEM_DEFAULT_ORG_ID;
      if (!envOrgId) throw new Error("Phase 2 dual-path: no session AND no SYSTEM_DEFAULT_ORG_ID env");
      return { orgId: envOrgId, source: "env" };
    }
    throw err;
  }
}
```

### 4.2 Pattern B: slug-bearing routes (state GET when `slugParam` present, manifest, files, file, queue/[id] GET)

Before (representative — `app/api/runs/[slug]/manifest/route.ts`):

```ts
const { slug } = await params;
let orgId: string | null;
try {
  orgId = await resolveOrgForSlug(slug);
} catch (err) { return Response.json({ error: ... }, { status: 500 }); }
if (!orgId) return Response.json({ error: "Not found" }, { status: 404 });
// ... use orgId to scope storage path lookup
```

After (Phase 2 dual-path):

```ts
const { slug } = await params;
const { orgId, source } = await getOrgContextDualPath();
const supabase = getSupabase();
const { data: row } = await supabase
  .from("research_queue")
  .select("id")
  .eq("topic_slug", slug)
  .eq("organization_id", orgId)   // ← cross-org guard added here
  .maybeSingle();
if (!row) return Response.json({ error: "Not found" }, { status: 404 });
// ... use orgId to scope storage path lookup
```

After Phase 4: same as Phase 2 minus the env fallback inside `getOrgContextDualPath`; the call becomes `requireOrgContext()`.

### 4.3 Special case: `queue/[id]` PATCH

Unchanged. Still X-Agent-Key. proxy.ts §2.5 explicitly short-circuits PATCH on this URL pattern.

### 4.4 Special case: `queue` POST insert + `parent_run_id` lookup (C-C1 BLOCKING)

The original v2 design caught only the insert pattern (one of two tenant-sensitive paths in this handler). Codex round 2 caught the second path: the `parentSlug → parent_run_id` lookup at `frontend/app/api/queue/route.ts` lines 48-53. A user can craft a clone/studio-only POST with another org's `parentSlug`; the route resolves the parent ID across orgs and writes an org-A queue row pointing at an org-B parent. The worker then resolves the parent by ID at `agent/scripts/regenerate-studio-products.ts:349-401` and reads parent-org storage/notebook data — cross-tenant data leak.

After Phase 2 (CRITICAL fix, BLOCKING merge per `~/CLAUDE.md` §Disagreement Procedure on SECURITY-labeled CRITICAL):

```ts
// 1. Derive orgId FIRST. Before any DB lookup.
const { orgId } = await getOrgContextDualPath();

// 2. Parent lookup — MUST be same-org scoped.
let parentRunId: string | null = null;
if (data.parentSlug) {
  const { data: parentRow } = await supabase
    .from("research_queue")
    .select("id")
    .eq("topic_slug", data.parentSlug)
    .eq("organization_id", orgId)   // ← BLOCKING fix: prevents cross-tenant parent reference
    .maybeSingle();
  parentRunId = parentRow?.id ?? null;
}

// 3. studio_only path remains: 400 if parent_run_id not resolved (existing behavior;
//    now ALSO 400 if the parentSlug exists but belongs to a different org — that's
//    the desired error for an attacker probing).
if (data.pipelineMode === "studio_only" && !parentRunId) {
  return Response.json(
    { error: "Parent run not found in your organization's queue", ... },
    { status: 400 },
  );
}

// 4. Insert with explicit organization_id.
const { data: row } = await supabase
  .from("research_queue")
  .insert({
    ...existingFields,
    organization_id: orgId,            // ← Phase A DEFAULT replacement
    parent_run_id: parentRunId,        // ← guaranteed same-org by step 2
  })
  .select(...)
  .single();
```

### 4.5 Defense-in-depth: DB-level `parent_run_id` same-org guard (added v3 per C-C1)

The §4.4 route-level fix closes the leak through `POST /api/queue`, but any future code path that updates `research_queue.parent_run_id` (admin tools, migration scripts, manual SQL during incidents) could re-open the vector. Defense-in-depth: enforce the invariant at the DB level via a `BEFORE INSERT OR UPDATE` trigger on `research_queue` that asserts `parent_run_id` references a row with the same `organization_id`.

```sql
-- To ship in the Phase B-2 migration (or a sibling B-2.5 migration):
CREATE OR REPLACE FUNCTION private.research_queue_parent_same_org()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = private, public, pg_temp
AS $$
DECLARE
  parent_org uuid;
BEGIN
  IF NEW.parent_run_id IS NOT NULL THEN
    SELECT organization_id INTO parent_org
      FROM public.research_queue
      WHERE id = NEW.parent_run_id;

    IF parent_org IS NULL THEN
      RAISE EXCEPTION 'research_queue.parent_run_id % does not exist', NEW.parent_run_id;
    END IF;

    IF parent_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION
        'research_queue.parent_run_id % belongs to org %, not own org %',
        NEW.parent_run_id, parent_org, NEW.organization_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS research_queue_parent_same_org ON public.research_queue;

CREATE TRIGGER research_queue_parent_same_org
  BEFORE INSERT OR UPDATE ON public.research_queue
  FOR EACH ROW
  EXECUTE FUNCTION private.research_queue_parent_same_org();
```

This is the DB-level companion to the route-level `.eq('organization_id', orgId)` in §4.4. The combined two-layer enforcement makes the cross-tenant parent_run_id leak vector requires breaching both layers simultaneously.

Note this trigger is COMPATIBLE with the Phase A → B-1 → B-2 sequence: Phase A backfilled every existing row to `system-default` (single org), so the trigger fires green on all existing data. Phase B-1 added the `research_queue_immutable_org_id` trigger (catches the org-migration vector); this new trigger catches the parent-reference vector. Together they make `research_queue` tenant-safe at the DB layer.

---

## 5. Migration order — deploy-safe sequencing

| Phase | Action | Preflight gate | Reversible? |
|---|---|---|---|
| 1 | Deploy auth infra (no STOPGAP changes). | Existing routes still return 200. `/api/healthz` passes. | ✓ Revert proxy.ts + delete `/login` + `/auth/callback` + helpers. |
| 2 | Deploy dual-path one route at a time. After each: hit the route logged-out (env path) + logged-in (session path); confirm `X-Org-Source` header matches. | Both paths return identical results for system-default-org row reads. `audit_storage_writes` rows correctly attribute writes. | ✓ Each route reverts to single-path env code. |
| 3 | Soak window. **Minimum 3 days.** Owner uses the app as normal in logged-in mode; logged-out probes via curl exercise the env path. | Zero discrepancy between paths (compare `X-Org-Source: session` vs `X-Org-Source: env` response payloads via `vercel logs --since 24h` for each of the 8 cutover routes; counts and shapes must be identical). `audit_storage_writes` continues to accumulate without anomalies. **NOTE:** The v1 idea of a `count(*) WHERE org_id='<system-default>'` SQL preflight is logically broken (Gemini G-C1) — drop it. Soak verification is observational: route-paired payload diffing + log scan only. | n/a — no code change. |
| 4 | Delete env fallback. Helpers throw on no-session. Routes redirect to /login (proxy.ts protection promoted from cookie-refresh-only to full route protection — see §2.5 phase-gating). | All routes return 401/302 when unauthenticated. Manual confirmation: 8 handlers all use `requireOrgContext()`. `grep -r SYSTEM_DEFAULT_ORG_ID frontend/` returns no matches outside `Documentation/`+comments. | ✓ Re-add env fallback + revert proxy.ts to Phase 1 cookie-refresh-only form. |
| 5 | Apply `20260601_phase_b_2_enable_rls.sql`: `ENABLE ROW LEVEL SECURITY` on the 4 tenant tables + `ALTER TABLE research_queue ALTER COLUMN organization_id DROP DEFAULT` + the `research_queue_parent_same_org` trigger from §4.5. **v3 preflight (resolving Gemini G-C1 + Codex C-M5):** *multiline* static grep — `rg -U 'from\("research_queue"\)\s*\.insert\(\{[^}]*organization_id' frontend/ agent/` must match every insert site, AND `rg -U 'from\("research_queue"\)\s*\.insert\(' frontend/ agent/` minus the above must be empty (no inserts without explicit org_id). PLUS `grep -r SYSTEM_DEFAULT_ORG_ID frontend/ agent/` returns 0 matches outside `Documentation/` + comments. The v2 single-line `git grep` was insufficient — it missed `frontend/app/api/queue/route.ts:80-95` because `.from(...)` and `.insert(...)` are on separate lines (Codex C-M5). **The B-plan §2.8 step 7 SQL count check remains DROPPED** (Gemini G-C1) — logically impossible to satisfy when system-default IS the only org's UUID. | All preflight (multiline grep) + post-merge tests in `agent/scripts/test-phase-b-rls.sh` + `agent/scripts/test-ssr-auth-cutover.sh` pass. RLS bypass grid §6 passes 100%. | Limited — rollback = follow-up migration to `DISABLE RLS` + re-add DEFAULT + drop the parent-same-org trigger (`supabase db reset` would wipe the schema — not an option). Service-role worker keeps functioning regardless. |

---

## 6. RLS bypass test grid (Phase 5 acceptance)

Lifted from `multi-tenancy-phase-b-plan.md` §6.2. This section is the **conceptual** grid; the executable implementation lives in `agent/scripts/test-ssr-auth-cutover.sh` (NEW — §8.3 specifies the 10-point minimum spec). The existing `agent/scripts/test-phase-b-rls.sh` remains scoped to B-1 helpers + RLS policy structural checks (per its own lines 21-29); it does NOT cover HTTP auth or the RLS bypass matrix below — that's what the new script is for. (Q-M4 fidelity, S54 round 3.)

| Test | Setup | Expected |
|---|---|---|
| T1 | Unauthenticated request to `/api/runs` | 302 to `/login` (proxy.ts Phase 4+) |
| T2 | Authenticated owner, their own org's slug | 200 + manifest |
| T3 | Authenticated owner, **another org's slug** | 404 (the `.eq('organization_id', orgId)` guard) |
| T4 | Authenticated user with NO membership | 302 to `/no-org` |
| T5 | Direct SQL via anon key, no JWT | 0 rows from `research_queue` (RLS denies) |
| T6 | Direct SQL via anon key, owner JWT | Only owner's org's rows |
| T7 | Worker `POST /api/queue/claim` with X-Agent-Key | 200 (or 204), bypasses session-aware proxy (matcher-included but route handler short-circuits on header check) |
| T8 | Worker writes to storage; `audit_storage_writes` gains 1 row attributed to `caller='worker'` | row exists with correct `organization_id` |
| T9 | Owner-as-authenticated tries `UPDATE organizations SET slug='new'` | exception "organizations.slug is immutable" (B-1 §5.5 trigger) |
| T10 | Service-role `UPDATE research_queue SET organization_id=<other>` | exception "research_queue.organization_id is immutable" unless `app.allow_org_migration=true` (B-1 §4) |
| T11 | Concurrent logins from two browsers for same owner | both work; cookie rotation doesn't cross-contaminate |
| T12 | Magic-link, then 1-hour idle, then page navigation | proxy.ts refreshes via `getUser()`; user stays logged in |
| T13 | Magic-link, then 24-hour idle, then page navigation | session expires; redirected to /login |
| T14a | Simulate dropping `om_one_org_per_user`, insert 2nd membership row, call `requireOrgContext()` from a route handler | App-level fail: PostgREST 406 "multiple rows returned" (`.single()` semantics — NOT SQLSTATE 21000) |
| T14b | Same setup as T14a, then invoke `private.auth_user_organization_id()` directly via psql with the user's JWT | PostgreSQL `cardinality_violation` (SQLSTATE 21000) raised (B-1 §3 scalar-subquery wrap) — confirms the DB-level fail-loud path. (C-m1, S54 Codex round 2 split: `.single()` and the SQL function have DIFFERENT failure modes and must be tested separately.) |
| T15 | Cross-org `parent_run_id` attack: authenticated as org-A owner, POST `/api/queue` with `parentSlug` of a row owned by org-B | 400 "Parent run not found in your organization's queue" (route-level §4.4 guard). Direct DB attempt — `INSERT INTO research_queue (organization_id, parent_run_id) VALUES (<org-A>, <org-B-row-id>)` via psql — fires `research_queue_parent_same_org` trigger and raises exception. (C-C1, S54 Codex round 2 BLOCKING fix. Both layers must pass.) |

---

## 7. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Owner forgets to add `NEXT_PUBLIC_SUPABASE_ANON_KEY` to Vercel before Phase 1 deploy | Medium | Auth infra returns 500 | Pre-deploy checklist; Vercel build will succeed (env vars are runtime), so manual gate before flipping traffic |
| Magic-link email lands in spam | Medium | Owner can't log in for soak | Pre-deploy: send self-test from Supabase dashboard; document password-reset-via-Supabase-Studio escape hatch |
| proxy.ts perf overhead on every request | Low | Latency +20-50ms | Acceptable; benchmark in Phase 1 staging |
| Cookie `Secure` flag breaks local dev (HTTP) | Low | Local dev login fails | `@supabase/ssr` auto-disables `Secure` on `localhost`; verified in v0 |
| Server Action POST + cookie write races on multi-tab login | Low | Stale session in one tab | Supabase auth client handles via `onAuthStateChange` broadcast (browser-client autonomic) |
| Phase 2 dual-path deploys leave `X-Org-Source: env` header on logged-in requests | High during soak | Diagnostic noise | Expected; header is the diagnostic. Remove in Phase 4. |
| Cross-org slug collision before Phase 4 | Medium (only one org exists today, so currently 0%) | Wrong-org data leak | The `.eq('organization_id', orgId)` guard in §4.2 closes this in Phase 2 — does NOT wait for Phase 5 RLS |
| Phase 5 migration runs before all dual-path deploys complete soak | Low | Authenticated queries 0-row | Phase 5 preflight in §5 row 5 must pass — multiline `rg -U` grep confirms every insert site passes explicit `organization_id`; observational soak verification (route-paired payload diffing + log scan) from Phase 3 confirms no `X-Org-Source: env` traffic remains. (Q-M5 fidelity, S54 round 3 — the v1 SQL `count(*)` preflight was logically impossible per Gemini G-C1 and is permanently retired.) |
| Worker daemon spins up a NEW node process during Phase 5 deploy window, hits `/api/queue/claim` with the old `DROP DEFAULT` not yet applied | Low | Insert fails | Worker doesn't insert via DEFAULT — it only claims (UPDATE). Safe. |
| Service-role compromise post-Phase 5 | Low | Full DB bypass | B-1 mitigations: `organizations_immutable_columns` + `research_queue_immutable_org_id` triggers + `audit_storage_writes` log |
| `getUser()` in proxy.ts fires PostgREST request per request | High | Latency + Supabase Auth API load | This is the canonical `@supabase/ssr` pattern; Supabase Auth caches the JWT verify for the cookie's lifetime. Negligible in practice. |
| Magic link emailed to old email address after user changes | n/a | n/a | Phase F invite flow scope; v1 has only 1 user |

---

## 8. Test plan

### 8.1 Per-phase smoke tests

| Phase | Smoke |
|---|---|
| 1 | `curl https://dynamic-research.vercel.app/login` returns 200; `curl /auth/callback?code=invalid` returns 302 to `/login?error=...`. |
| 2 | For each of 8 routes: hit logged-out + logged-in; both 200; `X-Org-Source` header set; results identical for system-default org. |
| 3 | Daily during soak: `vercel logs` grep `X-Org-Source=env` count — establishes baseline of anon traffic. |
| 4 | `curl /api/runs` returns 302 (logged-out); `grep -r SYSTEM_DEFAULT_ORG_ID frontend/` is empty; manual login + browse exercise. |
| 5 | Full RLS bypass grid §6 passes; `pg_class.relrowsecurity = true` for all 4 tenant tables; `pg_attrdef` shows no DEFAULT on `research_queue.organization_id`. |

### 8.2 Unit tests

- `lib/auth.test.ts` — `requireUser()`, `requireOrgContext()`, `getOrgContextDualPath()` against mock cookie store + mock Supabase client. (Tests use `node --test`, NOT vitest — per project convention.)
- `lib/storage.test.ts` — `resolveOrgForSlug` no longer the primary path, but the helper itself still tested for the legacy/internal use.

### 8.3 Integration test harness

`agent/scripts/test-ssr-auth-cutover.sh` (NEW — does not yet exist; the existing `agent/scripts/test-phase-b-rls.sh` explicitly scopes out HTTP auth + the RLS bypass matrix per its own lines 21-29 and is a B-1 helper/policy harness only). Per C-M6, the new script's minimum spec:

1. **Unauth redirect** — `curl https://<host>/api/runs` → 302 to `/login` (Phase 4+ only).
2. **Owner authenticated access** — authenticate via magic-link, then `curl /api/runs` with session cookie → 200 + JSON array.
3. **No-membership user redirect** — provision a fresh `auth.users` row WITHOUT a `organization_members` row, login, then any non-public page → 302 to `/no-org`.
4. **Other-org slug 404** — owner of org-A authenticated, then `curl /api/runs/<org-B-slug>` → 404 (route-level `.eq('organization_id', orgId)` guard).
5. **Worker X-Agent-Key bypass** — `curl -X POST /api/queue/claim -H "X-Agent-Key: $AGENT_SECRET_KEY"` → 200 or 204 regardless of session state. Same for `PATCH /api/queue/[id]`.
6. **Anon-key direct SQL denied** — `psql "$ANON_URL" -c "SELECT * FROM research_queue"` → 0 rows (RLS enforces).
7. **Owner JWT direct SQL scoped** — owner-JWT psql `SELECT * FROM research_queue` → only org-A rows.
8. **RLS enabled on the 4 tenant tables** — `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('research_queue', 'organization_members', 'organization_invitations', 'organizations')` → all 4 show `relrowsecurity = true`.
9. **`research_queue.organization_id` DEFAULT dropped** — `SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef d JOIN pg_attribute a ON ... WHERE attname='organization_id' AND relname='research_queue'` → 0 rows.
10. **Cross-org parent_run_id rejected** — `INSERT INTO research_queue (organization_id, parent_run_id, topic, topic_slug, ...) VALUES (<org-A>, <org-B-row-id>, ...)` via psql → exception from `research_queue_parent_same_org` trigger. AND `curl POST /api/queue` with org-A session + cross-org parentSlug → 400.

All 10 tests gate the Phase 5 deploy. T1-T15 in §6 are the conceptual coverage matrix; this script is the executable form.

### 8.4 Manual acceptance (Phase 5 cutover)

- Owner logs in fresh in 2 browsers (Chrome + Firefox).
- Submits new research job; verifies `organization_id` is correctly populated.
- Polls job status until complete.
- Opens gallery; verifies only owner's runs visible.
- Direct anon-key query from `psql` confirms 0 rows.

---

## 9. Open questions — resolved post-Gemini round 1

All 8 v1 open questions reached resolution in Gemini round 1. Codex round 2 should treat these as established baselines, raising only if it has specific code-grounded counterevidence.

| # | Question | v1 author position | Gemini verdict + rationale | v2 final decision |
|---|---|---|---|---|
| Q1 | `@supabase/ssr` vs roll-your-own vs legacy `@supabase/auth-helpers-nextjs`? | `@supabase/ssr` | CONFIRMED — correct supported choice for Next 16 App Router; no known showstopper bugs | `@supabase/ssr` |
| Q2 | Keep service-role + manual `.eq()` post-Phase 5, OR switch to user-context + RLS? | Keep service-role | CONFIRMED — minimizes diff, preserves audit_storage_writes pattern uniformly, defers cascading `lib/storage.ts` refactor to a hypothetical post-beta Phase C | Keep service-role + manual `.eq()` |
| Q3 | `SameSite=Lax` vs `Strict`? | `Lax` (default) | CONFIRMED — promoted to MANDATORY: `Strict` would break PKCE on magic-link click from email clients (see §2.2 G-m2 resolution) | `Lax` mandatory |
| Q4 | Bind unauth `/api/queue/{extract-context,generate-questions}` to org_id? | No (keep fully anon) | CONFIRMED — no DB state to scope; no analytics downstream | Keep anon + rate-limit |
| Q5 | Soak window minimum? | 3 days | NOT REVIEWED — carry forward v1 position; Codex re-evaluate | 3 days |
| Q6 | Phase 5 rollback strategy? | Follow-up DISABLE RLS migration | CONFIRMED — `supabase db reset` wipes schema + production data; follow-up migration is the only acceptable rollback | Follow-up `DISABLE RLS` migration |
| Q7 | Phase 5 timing relative to Phase 4 deploy? | Separate session +24h | CONFIRMED — ensures Phase 4 hasn't caused unexpected lockouts before flipping RLS switch | +24h gap minimum |
| Q8 | Hardcode `NEXT_PUBLIC_SITE_URL` vs use `NEXT_PUBLIC_VERCEL_URL`? | Hardcode `https://dynamic-research.vercel.app` | CONFIRMED — `NEXT_PUBLIC_VERCEL_URL` would require wildcard allowlist (e.g., `*.vercel.app`) in Supabase Auth Redirect URLs setting; hardcoding is safer | Hardcode prod URL |

---

## 10. References

- `Documentation/multi-tenancy-phase-a-plan.md` — Phase A schema (multi-tenancy foundation)
- `Documentation/multi-tenancy-phase-b-plan.md` — Phase B plan including B-1 (landed) + B-2 (this refactor's Phase 5)
- `supabase/migrations/20260522_phase_a_multi_tenancy.sql`
- `supabase/migrations/20260523_phase_b_auth_rls_helpers.sql`
- `Documentation/multi-tenancy-phase-b-merge-gate-peer-review.md` — B-1 MERGE-gate audit trail
- `~/CLAUDE.md` §Multi-Reviewer Policy Framework — gate × label × severity model
- `frontend/lib/supabase.ts` — current service-role singleton (kept)
- `frontend/lib/storage.ts` — `resolveOrgForSlug` (deprecated post-Phase 4)
- Memory: `feedback_pushclone_divergence_reconcile.md` (push-clone reconcile is mandatory before each Vercel deploy)
- Memory: `feedback_resend_free_tier_own_email_only.md` (Resend deliverability constraint — not blocking; Supabase SMTP is independent)
- Memory: `feedback_ts_narrowing_module_const_to_nested_fn.md` (requireEnv pattern for module-const env reads)
- Memory: `feedback_verify_handoff_blockers_against_live_system.md` (verify B-2 ENABLE RLS preflight against live PostgREST before applying)
- Supabase SSR docs: https://supabase.com/docs/guides/auth/server-side/nextjs
- `@supabase/ssr` package: https://github.com/supabase/ssr

---

## 11. Reviewer instructions

**Gemini Deep Think (round 1):** ✅ COMPLETED S54 2026-05-26. See peer-review companion file §"Round 1" for findings + author dispositions. v2 deltas at the top of this doc captured the integrated changes.

**Codex (round 2, code-grounded):** ✅ COMPLETED S54 2026-05-26. See peer-review companion file §"Round 2" for the 1 CRITICAL + 6 MAJOR + 2 MINOR findings and how v3 resolved each. The C-C1 CRITICAL/BLOCKING (cross-tenant `parent_run_id` leak) is resolved at two layers in §4.4 + new §4.5.

**Codex Sequential QA (round 3, on this integrated v3):** PENDING.

Per `~/CLAUDE.md` §Review Topology DESIGN-revision rule: the reviewer who caught more last round runs the QA pass on the revision. Codex caught more in round 2 (9 findings, 1 BLOCKING vs Gemini's 4 findings, 0 BLOCKING) → Codex runs round 3 QA.

Your job in round 3 is **fidelity, not novel critique** (per the topology table + `feedback_self_fidelity_sweep_before_qa`). Verify:

1. Each of the 9 round-2 Codex findings (C-C1, C-M1 through C-M6, C-m1, C-m2) is correctly resolved in v3 — every disposition in the peer-review companion §Round 2 maps to a real change in the v3 doc text.
2. The author did not regress any v2 Gemini-integrated change while applying Codex findings (e.g., did the matcher v3 still cover the SVG files Gemini caught? Did the SameSite=Lax mandate from G-m2 survive the §2.2 rewrite?).
3. No new factual claims introduced in v3 are wrong (e.g., the proxy.ts rename rationale, the `research_queue_parent_same_org` trigger syntax, the multiline rg incantation, the test spec items).
4. The §4.5 SQL function + trigger compile cleanly as PostgreSQL syntactically.
5. The §3.1 `isSafeRedirect()` helper actually rejects all the open-redirect vectors C-M3 raised (`//evil/path`, `https://evil`, `\\evil`, etc.).
6. The peer-review companion file `Documentation/ssr-auth-refactor-design-peer-review.md` truly captures the audit trail without gaps.

Do NOT raise novel architectural critiques. If you find a CRITICAL or MAJOR regression in v3 vs v2, raise it. If you find a fidelity gap (e.g., the v3 delta claims X but the doc text still says Y), raise it. Otherwise SHIP.

Deliver: structured critique with the same severity tagging. End with `VERDICT: SHIP` (everything fidel) or `VERDICT: REQUEST CHANGES (n)` (fidelity gaps; n = how many).

Invocation: `cat sandbox/working/codex_qa_v3_ssr_auth_refactor_PROMPT.md | codex exec -s read-only -C "<project root>" -` per project standard.

---

*End of v1.*
