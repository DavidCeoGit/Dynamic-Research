# SSR Auth Refactor — Phase 1 MERGE-gate Peer Review

> Authored S55 (2026-05-26). Per `~/CLAUDE.md` Multi-Reviewer Policy Framework:
> **MERGE-gate**, **SECURITY** + **AGENT BEHAVIOR** + **ARCHITECTURE** + **DEPENDENCY** labels,
> **NORMAL** severity, sequential topology **Gemini → integrate → Codex → integrate → Codex QA**.
>
> Companion to: `Documentation/ssr-auth-refactor-design.md` (committed `8a24c7d`).
>
> **STATUS: APPROVED for merge after 3 sequential rounds.** Final verdict from
> Round 3 Codex Sequential QA: `VERDICT: APPROVE` (all 5 Round-2 dispositions
> PASS, all 3 Round-1 carryforwards PASS, no regressions).

---

## Round 1 — Gemini Deep Think (`gemini-3-pro-preview`, CLI)

- Invoked: 2026-05-26 11:54:23 PDT
- Wall-clock: ~18 min (incl. retries)
- Prompt: `sandbox/working/gemini_phase1_PROMPT.md`
- Response: `sandbox/working/gemini_phase1_response.json` (5.1KB)
- Verdict: **REQUEST CHANGES (2)** — 1 CRITICAL + 1 MAJOR + 1 MINOR + 1 NIT

### Findings + author dispositions

#### G-C1 (CRITICAL / BLOCKING / SECURITY) — Cookie synchronization bypass in `proxy.ts`

**Reviewer text** (verbatim):

> In `proxy.ts`, `setAll` mutates `res.cookies.set(...)` but fails to update the incoming `req.cookies`. Middleware executes in the same request lifecycle as the downstream Server Components. If a token is refreshed here, the browser receives the new cookie via `res`, but the Server Components still receive the *original* request with the expired JWT. This causes a spurious `401 Unauthorized` application crash exactly when the token expires.

**Disposition:** ACCEPT.

**Fix applied (v2 → carried into v3 `frontend/proxy.ts:84-102`):**

```ts
setAll: (xs, headers) => {
  xs.forEach(({ name, value }) => req.cookies.set(name, value));
  res = NextResponse.next({ request: req });
  xs.forEach(({ name, value, options }) =>
    res.cookies.set(name, value, { ...options, ...AUTH_COOKIE_OPTIONS }),
  );
  Object.entries(headers).forEach(([k, v]) => res.headers.set(k, v));
},
```

Required `let res = NextResponse.next();` (was `const`). v3 further extends
this to include the headers argument (see Round 2 C-M1 below).

---

#### G-M1 (MAJOR) — Edge-runtime dynamic env access in `proxy.ts`

**Reviewer text** (verbatim):

> `proxy.ts` executes in the Next.js Edge Runtime and utilizes the `requireEnv(name)` helper to dynamically read `process.env[name]`. Standard Next.js bundlers perform static build-time AST replacement for `NEXT_PUBLIC_` variables. Dynamic object-key access bypasses this substitution. In production and Vercel Edge environments, this will evaluate to `undefined` and crash the middleware.

**Disposition:** ACCEPT.

**Fix applied** — removed the `requireEnv()` helper from `proxy.ts` AND
`supabase-server.ts` AND `app/login/actions.ts`. Replaced with static
property access + `.trim()` defense per memory
`feedback_vercel_env_add_stdin_trailing_newline.md`.

---

#### G-m1 (MINOR) — `isSafeRedirect` accepts `/\evil.com` (backslash prefix)

**Disposition:** ACCEPT. Fix at `frontend/lib/auth.ts:69`:
`if (path.includes("\\")) return false;`

---

#### G-n1 (NIT) — `requireEnv` duplication

**Disposition:** SUPERSEDED by G-M1 resolution (helper removed entirely).

---

## Round 2 — Codex code-grounded (`gpt-5.5`, `codex exec -s read-only`)

- Invoked: 2026-05-26 12:18:54 PDT
- Wall-clock: ~12 min
- Prompt: `sandbox/working/codex_phase1_PROMPT.md`
- Response: `sandbox/working/codex_phase1_response.txt` (3.8KB)
- Verdict: **REQUEST CHANGES (2)** — 2 MAJOR + 2 MINOR + 1 NIT

### Findings + author dispositions

#### C-M1 (MAJOR / SECURITY / DEPENDENCY) — `setAll` drops the `@supabase/ssr` headers contract

**Reviewer text** (paraphrased + verified against `frontend/node_modules/@supabase/ssr/dist/module/types.d.ts:22-45`):

`setAll(cookies, headers)` is the type signature; the library passes
`Cache-Control: private, no-cache, no-store, must-revalidate, max-age=0`,
`Expires: 0`, `Pragma: no-cache` to prevent CDN/proxy caching of Set-Cookie
responses that could otherwise be served cross-user. My v2 implementation
ignored the second argument in both proxy.ts and supabase-server.ts.

**Disposition:** ACCEPT (verified the type contract by reading the installed
node_modules source).

**Fix applied (v3):**

- `proxy.ts:84-102` — `setAll(xs, headers)` now copies headers onto
  `res.headers` (full snippet above under G-C1).

- `supabase-server.ts:53-65` — `setAll(xs, _headers)` accepts the arg but
  intentionally drops it; comment explains rationale. Server Components
  cannot write cookies (try/catch swallows), and Server Actions /
  Route Handlers either redirect (no cache risk) or are Phase 2 dual-path
  scope. The load-bearing site is proxy.ts.

---

#### C-M2 (MAJOR / SECURITY) — Account enumeration via login flow

**Disposition:** ACCEPT.

**Fix applied (v3 `frontend/app/login/actions.ts:60-73`):** all syntactically
valid email submissions redirect to `/login?sent=1` regardless of
`signInWithOtp` outcome; provider errors are server-logged only. Only the
pre-Supabase `EMAIL_RE` format check may surface `?error=` (safe — the
attacker already knows whether the string is syntactically valid).
Rate-limit feedback is sacrificed for v1 — acceptable for single-user
beta.

---

#### C-m1 (MINOR) — `/auth/callback` ignores membership lookup errors

**Disposition:** ACCEPT. Fix at `auth/callback/route.ts:53-66`: destructure
`error: memberError` and branch on it BEFORE the `!member` check.

---

#### C-m2 (MINOR) — Unconditional `Secure` cookie attribute breaks local dev

**Disposition:** ACCEPT. Both `proxy.ts:41` + `supabase-server.ts:36` gate
`secure` on `process.env.NODE_ENV === "production"`. Retracts the design
§2.2 claim that `@supabase/ssr` auto-disables Secure on localhost — the
installed package source disproves it.

---

#### C-n1 (NIT) — Helper return shapes drift from design §2.4

**Disposition:** ACCEPT. `frontend/lib/auth.ts:15,37,47,58` —
`import type { User } from "@supabase/supabase-js"`; `requireUser():
Promise<User>`; `requireOrgContext(): Promise<{ user: User; orgId: string }>`.

No Phase 1 consumers; locks in the design contract before Phase 2 wires
helpers into routes.

---

## Round 3 — Codex Sequential QA (`gpt-5.5`, `codex exec -s read-only`)

- Invoked: 2026-05-26 12:37:00 PDT
- Wall-clock: ~5 min
- Prompt: `sandbox/working/codex_phase1_qa_PROMPT.md`
- Response: `sandbox/working/codex_phase1_qa_response.txt`
- Verdict: **APPROVE** — all 5 Round-2 findings PASS + all 3 Round-1 carryforwards PASS, no regressions

### Round 3 PASS table (verbatim from Codex)

```
[C-M1] PASS — frontend/proxy.ts:84,101; frontend/lib/supabase-server.ts:53,62
   proxy accepts `(xs, headers)` and copies headers to `res.headers`; server
   helper accepts `_headers` and intentionally drops it with comment.
[C-M2] PASS — frontend/app/login/actions.ts:43,62,73
   only email format redirects with `?error=`, and all post-Supabase paths
   redirect to `/login?sent=1`.
[C-m1] PASS — frontend/app/auth/callback/route.ts:53,58,68
   membership lookup destructures `memberError` and branches on it before
   `!member`.
[C-m2] PASS — frontend/proxy.ts:41; frontend/lib/supabase-server.ts:36
   both cookie option blocks gate `secure` on
   `process.env.NODE_ENV === "production"`.
[C-n1] PASS — frontend/lib/auth.ts:15,37,47,58
   `User` is imported, `requireUser()` returns full `User`, and org context
   returns `{ user, orgId }`.

Round-1 carryforwards:
[G-C1 cookie sync] PASS — frontend/proxy.ts:61,96,97,99
[G-M1 static env]  PASS — frontend/proxy.ts:73; frontend/lib/supabase-server.ts:42;
                          frontend/app/login/actions.ts:36
[G-m1 backslash]   PASS — frontend/lib/auth.ts:69

VERDICT: APPROVE
```

---

## What each reviewer saw (per `~/CLAUDE.md` synthesis requirement)

- **Gemini round 1:** prompt-embedded full source of 7 new files + design
  doc executive summary; no codebase file access (pure paste-and-respond
  via CLI).
- **Codex round 2:** full repo read access via
  `codex exec -s read-only -C "<project root>"`; ground-truth against
  shipped code (v2) + design doc + Round-1 audit trail.
- **Codex round 3:** same access; verified v3 fidelity to Round-2
  dispositions + Round-1 carryforward integrity.

Sequential topology delivered: Gemini's holistic-doc + paste-mode catches
v1 design fidelity (1 CRITICAL on cookie sync the design pseudocode
glossed over); Codex's code-grounded pass catches gaps Gemini misses at
paste-only depth, including the `@supabase/ssr` type contract
(C-M1 only catchable by reading `node_modules/@supabase/ssr/dist/module/types.d.ts`).

---

## Cumulative findings tally

| Round | Reviewer | CRITICAL | MAJOR | MINOR | NIT | Verdict |
|---|---|---|---|---|---|---|
| 1 | Gemini Deep Think | 1 | 1 | 1 | 1 | REQUEST CHANGES (2) |
| 2 | Codex code-grounded | 0 | 2 | 2 | 1 | REQUEST CHANGES (2) |
| 3 | Codex Sequential QA | 0 | 0 | 0 | 0 | **APPROVE** |

All 9 findings (1+1+1+1 + 2+2+1) ACCEPTED and resolved in v3 (modulo NIT
G-n1 which was SUPERSEDED by G-M1's fix). Net code surface for Phase 1:
482 LOC across 7 files (was 452 in v1; +30 LOC for security hardening
across the 2 review cycles).

CLI cost approximate: Gemini ~$3-4, Codex round 2 ~$6-8 (heavy reasoning
trace), Codex round 3 ~$2-3. Total ~$11-15 for a SECURITY-labeled MERGE
gate that surfaced 2 CRITICAL/MAJOR security issues (cookie sync +
account enumeration) the design rounds missed. Strong cost/value
asymmetry.

---

## What this MERGE-gate exposed for design-doc back-port (deferred)

These were resolved here at MERGE time but reflect design specification
gaps:

1. **§2.2 cookie strategy** — claimed `@supabase/ssr` auto-disables Secure
   on localhost. Installed package source disproves; v3 gates Secure on
   `NODE_ENV=production` directly. Design doc should be amended in next
   revision.

2. **§2.5 setAll signature** — pseudocode shows `setAll: (xs) =>`. Actual
   `@supabase/ssr` type is `setAll: (cookies, headers) => void`. The
   library passes Cache-Control headers that MUST be applied to the
   response in middleware contexts. Design doc should be amended.

3. **§3.2 Server Action enumeration** — pseudocode returns `{ error }`
   objects, which when surfaced to UI leaks account-enumeration signal.
   v3 unconditionally redirects to `?sent=1` for any syntactically valid
   email. Design doc should be amended.

4. **§2.4 helper return types** — design specified `Promise<User>` /
   `{ user, orgId }`. v1+v2 deviated to narrower shapes; v3 restored
   fidelity. (No design change needed — this was author drift, not a
   spec gap.)
