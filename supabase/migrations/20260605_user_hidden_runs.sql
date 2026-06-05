-- Per-user "hidden from my gallery view" markers (S92).
-- Soft, non-destructive: never touches research_queue, Storage, or state.json.
-- Additive table; rollback = DROP TABLE public.user_hidden_runs (no data depends on it).
-- Conventions: underscore filename, NO BEGIN/COMMIT, NO SET LOCAL, RLS enabled at create.

CREATE TABLE public.user_hidden_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  slug            text NOT NULL,
  hidden_at       timestamptz NOT NULL DEFAULT now(),
  -- org-scoped unique: a cross-org slug collision cannot resurface a hidden run (Gemini MAJOR-2).
  UNIQUE (user_id, organization_id, slug)
);

CREATE INDEX idx_user_hidden_runs_user_org
  ON public.user_hidden_runs (user_id, organization_id);

ALTER TABLE public.user_hidden_runs ENABLE ROW LEVEL SECURITY;

-- A user may only read/insert/delete their OWN hide rows, scoped to their org.
-- `TO authenticated` mirrors the existing tenant-perimeter policies in
-- 20260523_phase_b_auth_rls_helpers.sql. The RLS-respecting anon+cookie client
-- carries the user JWT so auth.uid() resolves; the service-role client (which
-- bypasses RLS) MUST NOT be used for this table (Codex MAJOR-A).
CREATE POLICY uhr_select ON public.user_hidden_runs
  FOR SELECT TO authenticated USING (
    user_id = auth.uid()
    AND organization_id = (SELECT private.auth_user_organization_id())
  );

CREATE POLICY uhr_insert ON public.user_hidden_runs
  FOR INSERT TO authenticated WITH CHECK (
    user_id = auth.uid()
    AND organization_id = (SELECT private.auth_user_organization_id())
  );

CREATE POLICY uhr_delete ON public.user_hidden_runs
  FOR DELETE TO authenticated USING (
    user_id = auth.uid()
    AND organization_id = (SELECT private.auth_user_organization_id())
  );
