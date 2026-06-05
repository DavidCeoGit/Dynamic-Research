# Multi-Tenancy Phase B — Auth + RLS + Worker Scoping (v3 DESIGN)

**Status:** v3 design — addresses Codex S48 sequential-QA drift findings on v2 (5 PARTIAL items + 1 new MAJOR re: additional stale route references). Differences vs v2: corrected API route paths to match actual repo (`POST /api/queue/claim`, `GET /api/state?slug=`, full enumeration of `/api/queue/extract-context`, `/api/queue/generate-questions`, `/api/runs/*`); E6 helper-cardinality fail-loud test (E9); §6.2 N/A cells replaced with explicit default-deny tests; concretized `audit_storage_writes` table + W7 test; rephrased §2.8 step 1 preflight to drop the prior negative-example wording. Pending re-run of Codex sequential QA.
**Predecessor:** Phase A (S47, 2026-05-23) — DB schema for organizations, organization_members, organization_invitations, min-owner trigger, topic_slug uniqueness scoped to org, research_queue.organization_id with DEFAULT system-default.
**Goal:** Convert the existing single-tenant app into a production-grade multi-tenant SaaS ready for team beta (~10 internal reviewers), without compromising the security model. **All SQL in this doc is illustrative; merge-ready SQL ships in `supabase/migrations/<TIMESTAMP>_phase_b_*.sql` per S46 conventions (underscore filename, no file-level BEGIN/COMMIT).**

---

## 1. Goals + Non-Goals

### 1.1 Goals (must ship in v1)

| # | Goal | Why it's v1 |
|---|---|---|
| G1 | Per-user authentication via Supabase Auth (magic link) | Without this, multi-tenancy is invisible; team would all share the primary owner login. |
| G2 | Session→organization_id binding enforced server-side | The actual security boundary. Every authenticated request must resolve to exactly one org. |
| G3 | Row-Level Security on every tenant-scoped table | Service-role bypass model from S47 is acceptable for the worker only. User-driven traffic must be RLS-enforced. |
| G4 | Worker/agent route writes respect `organization_id` from queue payload | Worker is an HTTP client of Next API routes; the API routes are where tenant scoping is actually enforced. |
| G5 | Storage paths prefixed by `organization_id` | Today's flat storage layout leaks across tenants the moment more than one tenant exists. |
| G6 | Admin provisioning script replacing self-serve invites | Team beta sized ~10 users; manual provisioning ships in days, self-serve invites in weeks. |
| G7 | Auth bypass + RLS bypass + worker-scoping integration tests (full 4-tables × 4-verbs matrix) | Production-grade means tested security boundaries. |
| G8 | DB-level invariants that close service-role bypass gaps | `UNIQUE (user_id)` on org_members + immutable `organization_id` trigger on research_queue. Defense-in-depth: code respects scoping AND DB blocks violations. |

### 1.2 Non-goals (deferred post-beta)

| # | Deferred | Rationale |
|---|---|---|
| N1 | Self-serve email invite flow | Manual provisioning serves beta. |
| N2 | Multi-org membership UX | Each beta user belongs to exactly one org — enforced by `UNIQUE (user_id)` constraint, not just convention. |
| N3 | Role management UI | SQL/admin script only for v1. |
| N4 | Cross-org sharing of research projects | Out of scope. v1 = strict isolation. |
| N5 | Billing / Stripe integration | Internal beta. |
| N6 | Audit log UI for org admins | Audit-log TABLE ships in v1 (service-role storage writes append a row); UI deferred. |
| N7 | Email/password authentication | Magic-link only. |
| N8 | SET LOCAL session-variable + per-table worker triggers (Gemini's G4 defense-in-depth pattern) | Deferred to Phase C / v2-of-v2. Service-role-route fences + immutable-org_id trigger + per-route JWT/X-Agent-Key validation cover v1 needs; SET LOCAL is heavy and unneeded until route-level validation proves insufficient in soak. Re-evaluate after beta. |

### 1.3 Explicit non-decisions reviewers should flag

- **Service-role key in Next API routes:** Phase B keeps the API routes (`/api/queue`, `/api/state/*`, etc.) on service-role for Supabase access; user-facing security comes from JWT validation + payload-org_id matching BEFORE the Supabase call. Reviewers: confirm this is acceptable; flag if not.
- **Magic-link-only auth:** No email/password fallback.
- **No SET LOCAL session-var defense-in-depth in v1.** See N8.

---

## 2. Architecture

### 2.1 Auth flow (magic link)

```
┌─────────────┐   email   ┌──────────────────┐   magic link   ┌─────────────┐
│ /login page │ ────────► │ Supabase Auth API│ ─────────────► │ User's inbox│
└─────────────┘           └──────────────────┘                └─────────────┘
                                                                      │ click
                                                                      ▼
┌─────────────────────────┐    JWT cookie    ┌─────────────────────────┐
│ /api/auth/callback?code │ ◄──────────────  │ Supabase Auth callback  │
└─────────────────────────┘                  └─────────────────────────┘
         │
         │ proxy.ts reads JWT cookie, resolves org_id per-request via
         │ private.auth_user_organization_id(); rejects 0-membership /
         │ ambiguous-membership users with explicit error codes.
         ▼
┌─────────────────────────┐
│ /dashboard (gated page) │
└─────────────────────────┘
```

- `/login` page: email input → calls `supabase.auth.signInWithOtp({ email })`. Email domain validated against `EMAIL_DOMAIN_ALLOWLIST` env var BEFORE the OTP send (server-side).
- `/api/auth/callback`: completes the magic-link exchange via `@supabase/ssr`, sets the session cookie. Email domain re-validated; rejects 403 if mismatched.
- `proxy.ts` (Next 16 file convention; **NOT** `middleware.ts`): for every non-public route, requires a valid session; resolves `org_id` PER-REQUEST (no cross-request cache — Gemini G3 finding) via `private.auth_user_organization_id()`; rejects zero or ambiguous membership with explicit error codes (see §2.2.4).
- Public routes (excluded from gating): `/login`, `/api/auth/callback`, `/healthz`, static assets.

### 2.2 Session → org binding

#### 2.2.1 Private schema for security-definer helpers (NEW per CG7)

```sql
-- Illustrative. Phase B-1 migration applies these.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE OR REPLACE FUNCTION private.auth_user_organization_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = private, public, pg_temp
AS $$
  SELECT organization_id
  FROM public.organization_members
  WHERE user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION private.auth_user_is_org_owner(target_org_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = private, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members
    WHERE organization_id = target_org_id
      AND user_id = auth.uid()
      AND role = 'owner'
  )
$$;

REVOKE ALL ON FUNCTION private.auth_user_organization_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.auth_user_is_org_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.auth_user_organization_id() TO authenticated;
GRANT EXECUTE ON FUNCTION private.auth_user_is_org_owner(uuid) TO authenticated;
```

- **No `LIMIT 1`** (Gemini Critical, Codex M1): if `UNIQUE (user_id)` is ever dropped and a user has 2+ memberships, this raises a Postgres cardinality violation (`more than one row returned by a subquery used as an expression`) — fail-loud, not silent.
- `SECURITY DEFINER` with `SET search_path` to private/public prevents search-path hijacking.
- `STABLE` so within a single statement the result is cached by Postgres.
- Lives in `private` schema (CG7): not exposed via PostgREST.

#### 2.2.2 DB invariant: UNIQUE (user_id) on organization_members (NEW per B1)

```sql
-- Illustrative. Phase B-1 migration.
-- Asserts the v1 N2 "exactly one membership per user" invariant in the DB.
ALTER TABLE public.organization_members
  ADD CONSTRAINT om_one_org_per_user UNIQUE (user_id);
```

Combined with the helper above, this makes the v1 single-org invariant DB-enforced.

#### 2.2.3 Frontend Supabase client (REWRITTEN per CG5)

- **Add `@supabase/ssr` as a Phase B prerequisite.** `pnpm add @supabase/ssr@latest` in `frontend/package.json`.
- Frontend uses **anon key + Supabase JWT cookie** via `createServerClient()` (server components / API routes) and `createBrowserClient()` (client components).
- The JWT cookie is set by `/api/auth/callback` after magic-link exchange.
- The existing service-role client in `frontend/lib/supabase.ts` is RENAMED to `frontend/lib/supabase-server-admin.ts` and reserved for admin-only paths (provisioning script, audit-log writes, internal cleanup). It is forbidden from user-facing API routes.

#### 2.2.4 Membership edge cases

| Case | Behavior |
|---|---|
| User has 0 memberships | `proxy.ts` returns 403 with `{error: "no_org_membership"}`. Admin script must always pair user-creation with membership-insertion. |
| User has 2+ memberships | Impossible by `UNIQUE (user_id)` constraint. If somehow encountered (constraint drop bug), the helper raises a cardinality violation, surfacing 500 with `{error: "ambiguous_org_membership"}` AND logging user_id. |
| User session expires mid-request | Standard Supabase Auth refresh-token rotation via `@supabase/ssr`; `proxy.ts` redirects to /login on hard expiry. |
| Auth user deleted while org_members row exists | `organization_members.user_id` has `ON DELETE CASCADE` → row removed by auth.users delete trigger. |
| Org deleted while members exist | Org DELETE is service-role-only in v1 (no authenticated DELETE policy on `organizations` — Codex Q8). Admin script removes members first, then org. |

### 2.3 RLS policies (full table)

**Wrap pattern:** every helper call wrapped as `(select private.helper())` per Supabase performance guidance (Codex m1). Postgres caches the helper result for the statement and skips re-evaluating per-row.

#### 2.3.1 `research_queue`

```sql
-- Illustrative.
DROP POLICY IF EXISTS rq_select ON public.research_queue;
DROP POLICY IF EXISTS rq_insert ON public.research_queue;
DROP POLICY IF EXISTS rq_update ON public.research_queue;
DROP POLICY IF EXISTS rq_delete ON public.research_queue;

CREATE POLICY rq_select ON public.research_queue FOR SELECT TO authenticated
  USING (organization_id = (select private.auth_user_organization_id()));

CREATE POLICY rq_insert ON public.research_queue FOR INSERT TO authenticated
  WITH CHECK (organization_id = (select private.auth_user_organization_id()));

CREATE POLICY rq_update ON public.research_queue FOR UPDATE TO authenticated
  USING (organization_id = (select private.auth_user_organization_id()))
  WITH CHECK (organization_id = (select private.auth_user_organization_id()));

CREATE POLICY rq_delete ON public.research_queue FOR DELETE TO authenticated
  USING (organization_id = (select private.auth_user_organization_id()));
```

#### 2.3.2 `organization_members`

```sql
DROP POLICY IF EXISTS om_select ON public.organization_members;
DROP POLICY IF EXISTS om_insert ON public.organization_members;
DROP POLICY IF EXISTS om_update ON public.organization_members;
DROP POLICY IF EXISTS om_delete ON public.organization_members;

-- Members can SELECT their OWN row only.
-- Owners can SELECT all members of their org. (Codex Q7 stricter default.)
CREATE POLICY om_select ON public.organization_members FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR (select private.auth_user_is_org_owner(organization_id))
  );

-- Owner-only INSERT into their own org.
CREATE POLICY om_insert ON public.organization_members FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = (select private.auth_user_organization_id())
    AND (select private.auth_user_is_org_owner(organization_id))
  );

-- Owner-only UPDATE/DELETE; min-owner trigger fires anyway as defense-in-depth.
CREATE POLICY om_update ON public.organization_members FOR UPDATE TO authenticated
  USING ((select private.auth_user_is_org_owner(organization_id)))
  WITH CHECK ((select private.auth_user_is_org_owner(organization_id)));

CREATE POLICY om_delete ON public.organization_members FOR DELETE TO authenticated
  USING ((select private.auth_user_is_org_owner(organization_id)));
```

#### 2.3.3 `organization_invitations` (CORRECT TABLE NAME per CG1)

```sql
DROP POLICY IF EXISTS oi_select ON public.organization_invitations;
DROP POLICY IF EXISTS oi_insert ON public.organization_invitations;
DROP POLICY IF EXISTS oi_delete ON public.organization_invitations;

-- Owner-only SELECT/INSERT/DELETE (members must not see other invites).
CREATE POLICY oi_select ON public.organization_invitations FOR SELECT TO authenticated
  USING ((select private.auth_user_is_org_owner(organization_id)));

CREATE POLICY oi_insert ON public.organization_invitations FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = (select private.auth_user_organization_id())
    AND (select private.auth_user_is_org_owner(organization_id))
  );

CREATE POLICY oi_delete ON public.organization_invitations FOR DELETE TO authenticated
  USING ((select private.auth_user_is_org_owner(organization_id)));

-- No UPDATE policy in v1 — invitations are immutable once issued.
-- Accept flow rotates by DELETE + INSERT, never UPDATE.
```

#### 2.3.4 `organizations`

```sql
DROP POLICY IF EXISTS orgs_select ON public.organizations;
DROP POLICY IF EXISTS orgs_update ON public.organizations;

CREATE POLICY orgs_select ON public.organizations FOR SELECT TO authenticated
  USING (id = (select private.auth_user_organization_id()));

-- Owners can UPDATE org name (Gemini G2 — workspace rename forward-compat).
CREATE POLICY orgs_update ON public.organizations FOR UPDATE TO authenticated
  USING ((select private.auth_user_is_org_owner(id)))
  WITH CHECK ((select private.auth_user_is_org_owner(id)));

-- No authenticated INSERT/DELETE policy on organizations in v1.
-- Service-role-only via admin provisioning script.
```

#### 2.3.5 Immutable org_id trigger on research_queue (NEW per CG9)

```sql
CREATE OR REPLACE FUNCTION private.research_queue_immutable_org_id()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'UPDATE')
     AND OLD.organization_id IS DISTINCT FROM NEW.organization_id
     AND COALESCE(current_setting('app.allow_org_migration', true), 'false') <> 'true' THEN
    RAISE EXCEPTION 'research_queue.organization_id is immutable (set app.allow_org_migration=true to override)';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS research_queue_immutable_org_id ON public.research_queue;
CREATE TRIGGER research_queue_immutable_org_id
  BEFORE UPDATE ON public.research_queue
  FOR EACH ROW EXECUTE FUNCTION private.research_queue_immutable_org_id();
```

`app.allow_org_migration` is a session-level escape hatch reserved for an explicit admin tenancy-migration tool. NEVER set in worker, never set in user-facing API routes. Storage migration scripts may set it transiently if they ever need to retag — but the v1 storage migration does not change org_id, only path layout.

### 2.4 Storage RLS

Bucket: `research-projects` (already exists, private, signed-URL access).

#### 2.4.1 Path scheme migration

**Existing layout (flat):** `research-projects/<project_slug>/<file>`
**New layout (org-prefixed):** `research-projects/<org_id>/<project_slug>/<file>`

#### 2.4.2 RLS on storage.objects

```sql
DROP POLICY IF EXISTS storage_read  ON storage.objects;
DROP POLICY IF EXISTS storage_write ON storage.objects;

CREATE POLICY storage_read ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'research-projects'
    AND (storage.foldername(name))[1] = (select private.auth_user_organization_id())::text
  );

CREATE POLICY storage_write ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'research-projects'
    AND (storage.foldername(name))[1] = (select private.auth_user_organization_id())::text
  );

-- Service role bypasses these policies (Supabase platform behavior).
-- The DB-level fence on org_id mutation + the API-route X-Agent-Key validation
-- are the effective scoping for service-role writes.
```

#### 2.4.3 Storage path migration script (REWRITTEN per CG8, G1)

`agent/scripts/phase-b-migrate-storage-paths.ts`:

1. Query `research_queue` for every row's `(id, organization_id, topic_slug)`. **Drives migration by research_queue.id, NOT slug** (CG8 — slug uniqueness is org-scoped after Phase A, so slug-only resolution is ambiguous).
2. For each row, list objects in storage matching the legacy flat path pattern `<topic_slug>/<file>`. Use research_queue.id-derived metadata (manifest file in storage) to disambiguate when multiple orgs share a slug.
3. **COPY** each object to `<org_id>/<topic_slug>/<file>`. Verify by listing the new path + comparing object sizes.
4. Update DB references: signed URLs are regenerated on demand from path; manifests rewritten via SQL `UPDATE`.
5. Update reader code paths (lib/storage.ts) to read ONLY from new layout. **No reactive fallback to legacy paths after this step** (Gemini G1 — fallback creates data-resurrection risk).
6. 30-day soak: legacy flat-path objects retained but never read by application code. Audit script greps for any code path still constructing flat paths and fails CI.
7. After soak, scheduled cleanup script DELETEs flat-path objects in one batch.

**Rationale for COPY-then-delete (vs MOVE):** preserves a recovery point during the cutover. The migration script is idempotent — re-running with already-copied objects skips the COPY and re-verifies. ABORT at any step leaves the system in a valid state because the new layout is fully populated and readers point at it.

### 2.5 Worker / Agent topology + scoping (REWRITTEN per CG3, CG10)

#### 2.5.1 Actual worker architecture

- `agent/worker.ts` is a long-running Node daemon. It DOES NOT directly hold the Supabase service-role key.
- The worker polls Next API routes using an `X-Agent-Key` shared-secret header for authentication. Actual route surface (verified against `frontend/app/api/` in S48): `POST /api/queue/claim` (atomic job claim via `claim_next_job` RPC), `GET/PATCH /api/queue/[id]` (per-job read/update), `GET /api/state?slug=<project-slug>` (state.json read), `POST /api/queue/extract-context` + `POST /api/queue/generate-questions` (Phase 0 user-driven), `POST /api/queue` (user submission), `GET /api/runs` + `GET /api/runs/[slug]/manifest` + `GET /api/runs/[slug]/files` + `GET /api/runs/[slug]/file/[filename]` (gallery + downloads).
- Storage writes happen via the worker calling `/api/storage/*` Next routes (or, currently, via direct Supabase service-role from script entry points — see actual call sites below).
- The Next API routes hold the service-role key and proxy to Supabase.

**Implication:** The org-scoping fence is on the **Next API routes**, not the worker process. Routes must validate `(request.body.organization_id)` against either (a) the JWT session's resolved `org_id` for user requests OR (b) the queue row's `organization_id` for `X-Agent-Key` worker requests.

#### 2.5.2 Actual storage-write call sites (verified against repo)

The following call sites currently construct storage paths and must be refactored:
- [agent/executor.ts](agent/executor.ts) line ~835 — uploads during run execution
- [agent/scripts/finalize-recovered-run.ts](agent/scripts/finalize-recovered-run.ts) line ~135 — recovery upload
- [agent/scripts/regenerate-studio-products.ts](agent/scripts/regenerate-studio-products.ts) line ~555 — Studio regeneration upload
- [frontend/lib/storage.ts](frontend/lib/storage.ts) line ~56 — frontend signed URL + list/download paths

#### 2.5.3 New helper + refactor

**New file:** `agent/lib/storage-paths.ts` exporting:

```ts
export function scopedStoragePath(orgId: string, projectSlug: string, file?: string): string {
  if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) throw new Error("scopedStoragePath: invalid orgId");
  if (!projectSlug || projectSlug.includes("/")) throw new Error("scopedStoragePath: invalid slug");
  return file ? `${orgId}/${projectSlug}/${file}` : `${orgId}/${projectSlug}`;
}
```

All FOUR call sites import + use this helper. NO call site constructs `<slug>/<file>` directly after the refactor.

**Build-time grep enforcement** (`agent/scripts/test-phase-b-storage-paths.sh`):
```bash
# Fails CI if any storage write call site bypasses the helper.
BAD=$(grep -rn "storage.from('research-projects').*\.upload\|\.from('research-projects')[^.]*\.list" \
  agent/ frontend/ --include='*.ts' \
  | grep -v "scopedStoragePath(" | grep -v "test-phase-b-storage-paths")
if [ -n "$BAD" ]; then echo "$BAD"; echo "FAIL: storage write bypasses scopedStoragePath helper"; exit 1; fi
```

#### 2.5.4 ResearchJob contract: add organization_id (per Codex code-grounded finding)

`agent/types.ts` `ResearchJob` interface gains a required `organization_id: string` field. Every code path that constructs or consumes a job carries it forward. The Next API `POST /api/queue/claim` route returns it from the DB row; the worker reads it from the response payload.

#### 2.5.5 Audit log for service-role storage writes (concretized per Codex Q3 QA drift)

The Q3 synthesis required "audit every service-role storage write" as a compensating control for keeping the worker on service-role. v3 concretizes this rather than leaving it as a goal:

```sql
-- Illustrative. Phase B-1 migration.
CREATE TABLE IF NOT EXISTS public.audit_storage_writes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  written_at    timestamptz NOT NULL DEFAULT now(),
  caller        text NOT NULL,           -- e.g. 'executor.ts', 'finalize-recovered-run.ts', 'regenerate-studio-products.ts'
  organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  research_queue_id uuid REFERENCES public.research_queue(id) ON DELETE SET NULL,
  object_path   text NOT NULL,           -- the full bucket path written
  bytes         bigint,
  http_status   int NOT NULL             -- Supabase upload response
);

CREATE INDEX IF NOT EXISTS audit_storage_writes_written_at_idx ON public.audit_storage_writes (written_at DESC);
CREATE INDEX IF NOT EXISTS audit_storage_writes_org_idx ON public.audit_storage_writes (organization_id, written_at DESC);

-- RLS: owners can SELECT their own org's audit rows; service-role writes (bypasses RLS).
ALTER TABLE public.audit_storage_writes ENABLE ROW LEVEL SECURITY;
CREATE POLICY asw_select ON public.audit_storage_writes FOR SELECT TO authenticated
  USING ((select private.auth_user_is_org_owner(organization_id)));
-- No INSERT/UPDATE/DELETE policy → authenticated clients cannot mutate; service-role bypasses.
```

Hook: every storage upload site in §2.5.2 (`agent/lib/storage-paths.ts` wrapper functions) appends one row immediately after Supabase upload completes. Logged fields: caller filename, org_id, queue_id, object_path, byte count, HTTP status. The row write is best-effort — failure is logged to Vercel but does NOT block the upload (audit must not be a single-point-of-failure choke).

Test: W7 (new — see §6.4) verifies that 1 storage upload produces 1 audit row.

### 2.6 Admin provisioning script

`agent/scripts/provision-beta-user.ts`:

```
Usage:
  node --env-file=.env --import=tsx scripts/provision-beta-user.ts \
    --email alice@example.com --org-name "Alice's Team" --role owner

Steps (idempotent):
  1. Validate args (email format, role enum, org-name nonempty, email domain in EMAIL_DOMAIN_ALLOWLIST).
  2. Find OR create organizations row with given name/slug.
  3. Find OR create auth.users row via service-role admin API.
  4. INSERT organization_members ON CONFLICT (user_id) DO NOTHING (per om_one_org_per_user UNIQUE).
  5. Send magic link via supabase.auth.admin.generateLink({ type: 'magiclink', email }).
  6. Print the magic link to stdout (operator pastes to user — no automated email send during beta).

Exit codes: 0 success, 1 input error, 2 supabase error.
```

State file: `agent/scripts/.phase-b-provisioned-users.json` — **gitignored explicitly** (Codex m5) — stores only `(email, org_id, user_id, provisioned_at)`. NEVER the magic link itself. Idempotency: re-running with same email is a no-op.

### 2.7 Frontend changes (REWRITTEN per CG2, CG5, Codex synthesis correction)

**Codex was right:** "Phase B cannot be 'mostly RLS plus no frontend change'." Frontend work IS Phase B.

| Surface | Change |
|---|---|
| `frontend/package.json` | Add `@supabase/ssr@latest`. Verify `@supabase/supabase-js` still pinned. |
| `frontend/lib/supabase.ts` | RENAME to `frontend/lib/supabase-server-admin.ts`. Still service-role; usage restricted to admin scripts + audit-log writes + provisioning. Grep CI test fails if any user-facing route imports this. |
| `frontend/lib/supabase-server.ts` (NEW) | `createServerClient()` via `@supabase/ssr`. Reads JWT cookie. Returns RLS-respecting client. Used by every user-facing API route. |
| `frontend/lib/supabase-browser.ts` (NEW) | `createBrowserClient()` via `@supabase/ssr`. Used by client components. |
| `frontend/proxy.ts` (NEW; **Next 16 file convention — NOT `middleware.ts`**) | Gates non-public routes. Resolves org_id per-request via `private.auth_user_organization_id()`. Rejects 0-membership users (403). Validates `Origin` header for POST/PATCH/DELETE (CSRF — Codex Q10). |
| `frontend/app/login/page.tsx` (NEW) | Email input + "Send magic link". Calls `supabase.auth.signInWithOtp({ email })` from browser. Email domain validated server-side at `/api/auth/send-magic-link` before forwarding to Supabase. |
| `frontend/app/api/auth/send-magic-link/route.ts` (NEW) | Validates email domain against `EMAIL_DOMAIN_ALLOWLIST`. Forwards to Supabase. Returns 200 or 403. |
| `frontend/app/api/auth/callback/route.ts` (NEW) | Magic-link exchange via `@supabase/ssr`. Sets cookie. Redirects to `/`. |
| `frontend/app/new/page.tsx` (MODIFY — **NOT `/research-compare` — actual route is `/new`**) | Switches from service-role client to authenticated SSR client. Form submission includes server-resolved `org_id` from session. |
| `frontend/app/api/queue/route.ts` (MODIFY) | Switches from service-role to authenticated SSR client. INSERT explicitly sets `organization_id = sessionOrgId`. CSRF Origin check applied via proxy.ts. |
| `frontend/app/api/queue/[id]/route.ts` (MODIFY) | Switches to SSR client. RLS auto-scopes by session org_id. |
| `frontend/app/api/state/route.ts` (MODIFY — single-route, query-param `?slug=`) | Switches to SSR client. RLS auto-scopes via `private.auth_user_organization_id()` joined against `research_queue.organization_id`. Worker (X-Agent-Key) requests pass through using payload-derived org_id. |
| `frontend/app/api/queue/claim/route.ts` (MODIFY) | Worker job-claim route. Adds payload-org_id assertion: returned job's `organization_id` is part of the JSON the worker reads + propagates downstream. Still uses service-role for the claim_next_job RPC; user-traffic gating not applicable. |
| `frontend/app/api/queue/extract-context/route.ts` (MODIFY) | Phase-0 user-driven route. Switches from service-role to SSR client. Resolves session org_id; any DB write tagged with it. |
| `frontend/app/api/queue/generate-questions/route.ts` (MODIFY) | Same pattern as extract-context. |
| `frontend/app/api/runs/route.ts` (MODIFY) | Gallery list. Switches to SSR client. RLS scopes list by session org_id. |
| `frontend/app/api/runs/[slug]/{manifest,files,file/[filename]}/route.ts` (MODIFY) | Per-run reads. Switch to SSR client. Validate that the resolved `research_queue.organization_id` for the slug matches the session org_id before serving (defense-in-depth: RLS would block, but explicit 403 surfaces faster + simpler error path). |
| `frontend/lib/storage.ts` (MODIFY per §2.5.2) | Use `scopedStoragePath()` helper from agent/lib (or a frontend-local mirror). List/download use authenticated SSR client. |
| Top nav | Shows `{user.email} • {org.name}`. Sign-out button (`supabase.auth.signOut()`). |
| Gallery + run-detail pages | Query through authenticated SSR client; RLS handles scoping. |

### 2.8 Migration order (deploy-safe sequencing, WITH PREFLIGHT GATES per Codex sweep #4)

Each step has a PREFLIGHT assertion that must pass before proceeding.

| # | Step | PREFLIGHT (must pass) |
|---|---|---|
| 1 | **Phase B-1 migration apply.** Creates `private` schema, helpers, UNIQUE(user_id) constraint, immutable-org_id trigger, all RLS policies (but NOT ENABLED). | `SELECT 1 FROM information_schema.tables WHERE table_name = 'organization_invitations'` = 1 row (table name validated against Phase A schema). |
| 2 | **Storage path migration COPY.** | Step 1 applied successfully (migration row in `supabase_migrations.schema_migrations`); `agent/scripts/phase-b-migrate-storage-paths.ts --preflight` confirms no slug collisions across orgs. |
| 3 | **agent/lib/storage-paths.ts created + agent + frontend storage call sites refactored.** Worker writes to new paths. | `bash agent/scripts/test-phase-b-storage-paths.sh` exits 0 (no bypass of helper). |
| 4 | **Frontend refactor: @supabase/ssr install + login + callback + proxy.ts + SSR client switch.** | `pnpm install @supabase/ssr` clean. `pnpm typecheck` passes. `frontend/lib/supabase.ts` renamed to `-admin.ts`; grep test confirms no user-facing route imports admin client. |
| 5 | **Verify existing primary owner (NOT "provision" — per Codex m4).** Confirms S47 bootstrap result. | `SELECT user_id FROM organization_members WHERE organization_id = '<system-default>'` returns the bootstrap user_id. If not, run provisioning script idempotently. |
| 6 | **Self-test as primary owner.** Login at `/login`, create research project, verify upload to new path + RLS scoping. | E2E tests pass. |
| 7 | **Phase B-2 migration apply.** `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on all 4 tenant-scoped tables + `storage.objects`. Drops `research_queue.organization_id` DEFAULT (after preflight assertion). | Preflight: `SELECT count(*) FROM research_queue WHERE created_at > '<phase-b-frontend-deploy-time>' AND organization_id = '<system-default>'` = 0 rows. (Codex Q2 — ensures no recent inserts relied on the DEFAULT.) |
| 8 | **Post-cutover verification.** Re-run workflow as primary owner. Service-role-using worker still functional; user-facing now RLS-enforced. | RLS bypass test grid §6.2 passes 100%. |
| 9 | **Provision team users.** Each gets own org. | `provision-beta-user.ts` idempotency state file confirms each user provisioned exactly once. |
| 10 | **Beta launch.** | Documentation + operator runbook (§11) in place; rollback rehearsed. |

---

## 3. SQL Artifact: Phase B-1 migration (additive policies + helpers + constraints)

**Filename:** `supabase/migrations/<TIMESTAMP>_phase_b_auth_rls_helpers.sql` (underscore per S46 C1).
**NO file-level `BEGIN`/`COMMIT`** (S46 C2 — Supabase CLI ExecBatch wraps the file + history insert atomically).

Statements applied (illustrative — final SQL ships in the actual migration file):
1. `CREATE SCHEMA IF NOT EXISTS private` + REVOKE/GRANT pattern
2. `CREATE OR REPLACE FUNCTION private.auth_user_organization_id()` (no LIMIT 1)
3. `CREATE OR REPLACE FUNCTION private.auth_user_is_org_owner(uuid)`
4. `ALTER TABLE public.organization_members ADD CONSTRAINT om_one_org_per_user UNIQUE (user_id)` — **must be FIRST mutating statement** so subsequent INSERTs in test harness can rely on it.
5. `CREATE OR REPLACE FUNCTION private.research_queue_immutable_org_id()` + trigger CREATE
6. All RLS policy CREATEs (DO NOT enable RLS yet — that's B-2)
7. EXPLICIT REVOKE PUBLIC + GRANT EXECUTE TO authenticated on functions (Codex m3)

## 4. SQL Artifact: Phase B-2 migration (enable RLS + drop DEFAULT)

**Filename:** `supabase/migrations/<TIMESTAMP>_phase_b_enable_rls.sql`

```sql
-- Illustrative. NO BEGIN/COMMIT.
SET lock_timeout = '5s';
SET statement_timeout = '15s';

ALTER TABLE public.research_queue            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_invitations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations             ENABLE ROW LEVEL SECURITY;

-- Storage RLS policies already created in Phase B-1; ENABLE here:
-- (Note: storage.objects has RLS enabled by default in Supabase — verify, don't re-enable.)

-- Drop the DEFAULT on research_queue.organization_id ONLY after preflight (see §2.8 step 7).
ALTER TABLE public.research_queue ALTER COLUMN organization_id DROP DEFAULT;
```

Why separate migration for the ENABLE: it's the cutover point. Running Phase B-2 against a partially-deployed frontend (still using service-role) would lock users out via RLS. Phase B-2 runs AFTER frontend refactor (§2.8 step 7).

## 5. Rollback plan (HARDENED per B2)

| Failure point | Rollback (in order of preference) |
|---|---|
| Phase B-1 migration fails | Supabase CLI ExecBatch is atomic; failure rolls back. Re-run after fix. |
| Storage path migration fails mid-stream | Existing flat-path objects untouched (COPY not MOVE). Re-run script from checkpoint. |
| Worker/frontend refactor fails in soak | Revert commit; service-role still works pre-cutover. |
| **Phase B-2 (RLS ENABLE) breaks production** | **FAST path (preferred):** apply `supabase/migrations/<TIMESTAMP>_phase_b_rollback_permissive.sql` — replaces every policy with `USING (true) WITH CHECK (true)`. Takes `ShareUpdateExclusiveLock` only (NOT `ACCESS EXCLUSIVE`). Doesn't queue behind long SELECTs. **SLOW fallback:** `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` — takes `ACCESS EXCLUSIVE`, only safe after app kill switch (env var `KILL_USER_TRAFFIC=true` causes proxy.ts to return 503 on all routes). |
| Long-running query blocks rollback | `lock_timeout 5s` + `statement_timeout 15s` set in rollback file → fail fast and noisy. Identify blockers: `SELECT pg_blocking_pids(pid), age(query_start), query FROM pg_stat_activity WHERE wait_event_type = 'Lock'`. Terminate blocker with `SELECT pg_cancel_backend(<pid>)` or `pg_terminate_backend(<pid>)`. |

**App kill switch:** `proxy.ts` checks `process.env.KILL_USER_TRAFFIC` on every request; if `true`, returns 503 with `{error:"maintenance"}`. Set via Vercel env var rotation — takes effect on next deploy or via `vercel env rm`+`vercel env add`+redeploy (~30s in production).

## 6. Test plan (EXPANDED per B3, CG3, CG4)

Test harness: `agent/scripts/test-phase-b-rls.sh`. Modes: `preflight` (read-only), `postmerge` (test bypass vectors), `cleanup` (delete test orgs/users).

### 6.1 Auth bypass tests

| # | Test | Expected |
|---|---|---|
| A1 | Unauthenticated GET `/api/state?slug=<project-slug>` | 401 |
| A2 | Unauthenticated POST `/api/queue` | 401 |
| A3 | Unauthenticated GET `/` | 302 → `/login` |
| A4 | Expired JWT POST `/api/queue` | 401 |
| A5 | Tampered JWT signature | 401 |
| A6 | POST `/api/queue` without Origin header (or with mismatched Origin) | 403 (CSRF) |
| A7 | Email domain not in `EMAIL_DOMAIN_ALLOWLIST` → `/api/auth/send-magic-link` | 403 |

### 6.2 RLS bypass tests — FULL 4×4 MATRIX (per B3)

For each of `research_queue`, `organization_members`, `organization_invitations`, `organizations` × `{SELECT, INSERT, UPDATE, DELETE}`, run as authenticated user A targeting user B's org:

| Table | SELECT | INSERT (with B's org_id) | UPDATE (B's row) | DELETE (B's row) |
|---|---|---|---|---|
| research_queue | Returns only A's rows | Rejected by WITH CHECK | Zero rows affected | Zero rows affected |
| organization_members | Returns only A's own row (Codex Q7) | Rejected (owner-only + own-org) | Zero rows affected | Zero rows affected |
| organization_invitations | Returns 0 rows (owner-only, A is in different org) | Rejected | Zero rows affected (default-deny: no UPDATE policy → all UPDATEs blocked) | Zero rows affected |
| organizations | Returns 0 rows | Zero rows affected (default-deny: no INSERT policy → all INSERTs blocked from authenticated client) | Zero rows affected (owner check fails) | Zero rows affected (default-deny: no DELETE policy → all DELETEs blocked from authenticated client) |

### 6.3 Storage RLS bypass tests (REFRAMED per CG4)

| # | Test | Expected |
|---|---|---|
| S1 | User A calls `supabase.storage.from('research-projects').createSignedUrl('<B_org_id>/...')` via authenticated SSR client | 403 (RLS on storage.objects rejects path-mismatch) |
| S2 | User A direct GET on `<B_org_id>/...` via a signed URL leaked from logs | **NOT TESTED — signed URLs are bearer tokens.** Code grep: verify no service-role route signs flat-path or cross-org URLs and exposes them. |
| S3 | User A POST upload to `<B_org_id>/...` path via authenticated client | 403 |
| S4 | User A authenticated LIST on `research-projects/<B_org_id>/` | 403 / empty result (depending on Supabase behavior — test both) |

### 6.4 Worker / service-role surface tests

| # | Test | Expected |
|---|---|---|
| W1 | Job inserted with org_id=A; worker writes deliverables; all written paths start with `<A>/...` | Pass |
| W2 | Grep all `agent/` + `frontend/` code for direct `.from('research-projects').upload(`/`.list(` not preceded by `scopedStoragePath(` | Zero matches (grep test in §2.5.3) |
| W3 | Concurrent jobs org A and org B; verify no cross-contamination in storage paths | Pass |
| W4 | Attempt UPDATE on `research_queue.organization_id` from psql as service_role | Trigger raises EXCEPTION (CG9 immutable-org_id trigger) |
| W5 | Grep all user-facing API routes for `getSupabaseAdmin()` / `supabase-server-admin` imports | Zero matches outside admin scripts |
| W6 | X-Agent-Key route validates payload `organization_id` against queue-row org_id | Mismatched payload → 400 |
| W7 | Single storage upload via `scopedStoragePath` → exactly 1 row appended to `audit_storage_writes` with matching org_id, queue_id, path, and HTTP status. | Pass |

### 6.5 Edge case tests

| # | Test | Expected |
|---|---|---|
| E1 | User with 0 memberships logs in | 403 with `no_org_membership` error |
| E2 | User created via `auth.users` without `organization_members` row | Same as E1 |
| E3 | Sole-owner DELETE of last member | Blocked by Phase A min-owner trigger |
| E4 | Sole-owner UPDATE role→member | Blocked by Phase A min-owner trigger |
| E5 | Org DELETE via authenticated client | 0 rows affected (no DELETE policy on organizations — Codex Q8) |
| E6 | Attempt to INSERT second org_members row for same user_id | `UNIQUE (user_id)` constraint violation |
| E7 | `private.auth_user_organization_id()` invoked without auth session | Returns NULL; RLS policies treat NULL as no match → zero rows |
| E8 | Helper function called from anonymous (anon-key) client | REVOKE EXECUTE FROM PUBLIC enforces 42501 permission denied |
| E9 | **Helper fail-loud under 2+ memberships.** Inside a transaction: `BEGIN; ALTER TABLE organization_members DROP CONSTRAINT om_one_org_per_user; INSERT … second membership for test user; SET LOCAL ROLE authenticated; SELECT private.auth_user_organization_id(); ROLLBACK;` | Helper raises `more than one row returned by a subquery used as an expression` (PostgreSQL cardinality violation). Verifies the no-`LIMIT 1` design is doing its job (B1 fail-loud contract). The transaction-with-ROLLBACK keeps the constraint intact outside the test. |

### 6.6 Deferred-manual tests

| # | Test | Reason |
|---|---|---|
| M1 | E2E as a real second user (provisioned via admin script + actual magic link) | Requires running provisioning + manual link click |
| M2 | Long-soak (24h passive observation with worker writing every 30s) | Wall-clock test |
| M3 | Rollback drill: trigger fake RLS failure, apply permissive rollback within 60s, restore | Manual coordination |

---

## 7. Open questions — RESOLVED for v2

Per S48 peer-review synthesis (see `Documentation/multi-tenancy-phase-b-plan-peer-review.md` §2 for full reviewer answers).

| Q | Resolution |
|---|---|
| Q1 | Magic-link only. Add `EMAIL_DOMAIN_ALLOWLIST` env var. Operator runbook covers expired-link cases (§11). |
| Q2 | DROP DEFAULT in B-2 migration. Preflight assertion required (§2.8 step 7). |
| Q3 | Worker stays on service-role (via Next API routes with X-Agent-Key). Compensating controls: immutable-org_id trigger (§2.3.5), payload-org_id validation in `/api/queue/claim` + `/api/queue/[id]` routes, `audit_storage_writes` table per §2.5.5 (concrete schema + hook + W7 test). |
| Q4 | COPY-then-delete with strict gating. NO reactive fallback (per G1). 30-day soak. |
| Q5 | `ON DELETE RESTRICT` (already set in Phase A migration). No cascade in v1. |
| Q6 | Own org per user. Enforced by `UNIQUE (user_id)` constraint (§2.2.2). |
| Q7 | Members see own row only; owners see all members of their org. (Stricter default per Codex.) |
| Q8 | No authenticated DELETE on `organizations`. Service-role admin script only. Min-owner trigger's cascade-skip behavior is fine because cascade unreachable from user surface. |
| Q9 | Service-role worker for v1. Scoped JWT deferred to Phase C. |
| Q10 | Add CSRF protection via Origin-header validation on POST/PATCH/DELETE routes (in `proxy.ts`). |

---

## 8. Multi-Reviewer Policy Framework alignment

Per `~/CLAUDE.md` Multi-Reviewer Policy Framework v2.1:

- **Event Gate:** DESIGN (this doc) + MERGE (each migration + each refactor).
- **Risk Labels:** SECURITY (auth boundaries, RLS, CSRF), DATA (RLS migrations, storage path migration, UNIQUE constraint), AGENT BEHAVIOR (worker scoping refactor), PRIVACY (member visibility), INFRA (Next.js proxy.ts, magic-link callback), ARCHITECTURE (frontend SSR client rewrite).
- **Severity Mode:** NORMAL.
- **Review Topology:**
  - DESIGN v1 (`Documentation/multi-tenancy-phase-b-plan.md` prior version): PARALLEL Gemini + Codex — **COMPLETE** S48 (this synthesis).
  - DESIGN v2 (this doc): **SEQUENTIAL QA** by Codex only (heavier finding count in v1 round per v2.1 rule).
  - MERGE (Phase B-1 SQL): SEQUENTIAL Gemini → revise → Codex on revised.
  - MERGE (Phase B-2 SQL): SEQUENTIAL Gemini → revise → Codex on revised.
  - MERGE (worker refactor PR): SEQUENTIAL Gemini → Codex.
  - MERGE (frontend auth PR): SEQUENTIAL Gemini → Codex.
- **Code-grounded preference:** Codex slot for parallel/sequential reviews wherever artifact references file paths.

---

## 9. Implementation plan + estimates (UPDATED per Codex synthesis correction)

Codex correctly noted v1 underestimated the frontend work. Revised estimate:

| Stage | Effort | Calendar |
|---|---|---|
| DESIGN v1 parallel review (Gemini + Codex) | ~1h | DONE S48 |
| Synthesis + v2 design doc | ~60 min | DONE S48 |
| DESIGN v2 sequential QA (Codex) | ~30 min Codex runtime + 30 min review | 0.5 day |
| Phase B-1 migration draft + MERGE-gate review | ~3h | 1 day |
| Phase B-1 apply | ~30 min | included |
| Storage path migration script (COPY-by-id, no fallback) + apply | ~4h | 1-2 days |
| `agent/lib/storage-paths.ts` + refactor 4 call sites + grep CI test | ~3h | 0.5-1 day |
| Frontend auth: install `@supabase/ssr`, login + callback + `proxy.ts` + SSR client rewrite | ~8h | 2-3 days |
| Frontend route refactor (`/new`, `/api/queue`, `/api/state`, gallery) from service-role to SSR | ~5h | 1-2 days |
| Phase B-2 migration + MERGE-gate review + apply + cutover verification | ~3h | 1 day |
| Provision team users | ~30 min per user (× ~10) | 1 day |
| E2E test as second user + rollback drill | ~3h | 0.5 day |
| **Total** | **~35-40 active hours** | **10-14 calendar days** |

Multi-agent parallelism opportunity: storage path migration script + frontend auth are independent once Phase B-1 lands. Can be parallel implementation agents. Cuts ~2 calendar days.

---

## 10. Out-of-band decisions deferred to v3 or later

1. Whether to fix the Phase A test 7a structural gap during Phase B (defer — not blocking; see `feedback_within_artifact_reviewer_blindspot.md`).
2. SET LOCAL session-var defense-in-depth (Gemini G4) — defer to Phase C / v2-of-v2 if route-level validation insufficient in soak (§1.2 N8).
3. Self-serve invite flow (N1) — Phase F.
4. Audit-log UI (N6) — table ships v1, UI later.
5. Whether to provision a "guest" / public landing-page route. **Decision: no** — fully gated behind `/login` for v1. Landing page is `/login` itself.

---

## 11. Operator runbook (NEW per Codex Q1)

### 11.1 Provisioning a new beta user

1. Verify email domain in `EMAIL_DOMAIN_ALLOWLIST`.
2. Run `pnpm tsx agent/scripts/provision-beta-user.ts --email <X> --org-name "<Name>" --role owner`.
3. Copy printed magic link from stdout.
4. Send magic link to user via secure channel (signal, secure email).
5. Verify `agent/scripts/.phase-b-provisioned-users.json` updated.

### 11.2 Expired magic-link recovery

1. Operator runs `--email <X>` again (idempotent).
2. New magic link printed; old one is rotated by Supabase.

### 11.3 Emergency RLS rollback (production-breaking RLS bug)

1. **Set kill switch:** `vercel env add KILL_USER_TRAFFIC true production && vercel redeploy --prod` (≤60s).
2. **Apply FAST permissive rollback migration:** `supabase db push --db-url $DATABASE_URL --file <permissive-rollback>.sql`.
3. **Identify the broken policy** via `pg_policies` query.
4. **Fix in a follow-up migration** + revert kill switch.

If permissive rollback also hangs:
- Identify blocker: `SELECT pg_blocking_pids(pid), age(query_start), query FROM pg_stat_activity WHERE wait_event_type = 'Lock'`.
- Terminate blocker: `SELECT pg_cancel_backend(<pid>)` first; `pg_terminate_backend(<pid>)` if cancel doesn't release.
- Re-apply rollback.

### 11.4 De-provisioning a beta user

1. SQL (service-role): `DELETE FROM organization_members WHERE user_id = (SELECT id FROM auth.users WHERE email = '<X>')`.
2. Optional org cleanup if zero remaining members.
3. Optionally `DELETE FROM auth.users WHERE email = '<X>'` (cascades to org_members via ON DELETE CASCADE).

### 11.5 Storage migration soak monitoring

Run `pnpm tsx agent/scripts/audit-flat-path-reads.ts` weekly during 30-day soak. Greps all code paths + production logs for any access to legacy `<slug>/<file>` patterns. Zero hits required before scheduled cleanup.
