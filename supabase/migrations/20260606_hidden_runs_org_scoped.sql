-- v4 (S92): org-scoped hide that works on the env-fallback path.
-- Drops the per-user identity from 20260605_user_hidden_runs — env-path hides
-- have no authenticated user (the live dashboard has no session). UI-only,
-- non-destructive. Table is currently empty, so the ALTERs are instant + safe.
-- Conventions: underscore filename, NO BEGIN/COMMIT, NO SET LOCAL.
-- Version 20260606 sorts strictly after the already-applied 20260605_* (a same-
-- date prefix would collide/mis-order the migration version).

-- Policies reference user_id, so they must drop before the column.
DROP POLICY IF EXISTS uhr_select ON public.user_hidden_runs;
DROP POLICY IF EXISTS uhr_insert ON public.user_hidden_runs;
DROP POLICY IF EXISTS uhr_delete ON public.user_hidden_runs;

-- The old unique + explicit index include user_id, so they drop before the column.
ALTER TABLE public.user_hidden_runs
  DROP CONSTRAINT user_hidden_runs_user_id_organization_id_slug_key;

DROP INDEX IF EXISTS public.idx_user_hidden_runs_user_org;

ALTER TABLE public.user_hidden_runs DROP COLUMN user_id;

-- Org singleton: a run is hidden once per org. Its btree also serves the
-- .eq(organization_id) filter, so no separate index is needed.
ALTER TABLE public.user_hidden_runs
  ADD CONSTRAINT user_hidden_runs_org_slug_key UNIQUE (organization_id, slug);

-- RLS remains ENABLED with NO policies: all access is via the service-role
-- client (which bypasses RLS); anon/authenticated direct access is denied by
-- default. Route-level org-scoping (.eq("organization_id", orgId)) is the
-- load-bearing tenant boundary.
