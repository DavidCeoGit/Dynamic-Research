-- =============================================================================
-- S58 Phase 1 MVP — Plan-review gate (DESIGN-gate per Documentation/final-plan-design-gate.md)
-- =============================================================================
-- Sandbox draft 2026-05-27. Intended path on promote:
--   supabase/migrations/20260527_plan_review_gate.sql
--
-- Purpose:
--   Add the persistence layer for the pre-spawn multi-reviewer plan-review
--   gate (Documentation/final-plan-design-gate.md v3 APPROVED S57). Adds a
--   parallel `plan_review_status` dimension on `research_queue` (the existing
--   JobStatus enum is UNCHANGED — Codex CRITICAL-1) plus retry-tracking
--   columns (Codex CRITICAL-2) and a new `plan_reviews` audit table with
--   explicit org_id + concrete RLS policies (Codex CRITICAL-3 — Postgres RLS
--   does NOT inherit through foreign keys).
--
-- Conventions followed (per memory files):
--   - Filename uses UNDERSCORE (NOT dash) between digit prefix + name
--     [feedback_supabase_db_push_filename_underscore.md]
--   - NO file-level BEGIN/COMMIT — CLI ExecBatch wraps the file + history
--     insert in an implicit transaction. Explicit BEGIN breaks atomicity.
--     [feedback_supabase_db_push_no_begin_commit.md]
--   - NO SET LOCAL — fires WARNING 25P01 in the wrapper transaction.
--     [feedback_set_local_in_supabase_migration_warns.md]
--   - RLS ENABLED at create-time on the NEW table (zero existing rows,
--     zero existing traffic — same safety logic as research_usage and
--     audit_storage_writes).
--   - Uses private.auth_user_is_owner() + private.auth_user_organization_id()
--     helpers from 20260523_phase_b_auth_rls_helpers.sql §3.
--
-- Pre-apply verification (Codex MAJOR-4 — verify RLS state before mutating):
--   Run this read-only probe FIRST, capture output, confirm research_queue is
--   in the expected pre-Phase-B-2 state (relrowsecurity=false):
--     SELECT relname, relrowsecurity
--     FROM pg_class
--     WHERE relname IN ('research_queue','plan_reviews');
--   Expected: research_queue=false (Phase B-2 pending), plan_reviews=missing.
--
-- Rollback note: ADDITIVE migration only. ALTER TABLE adds columns with
-- defaults (no data backfill required — new rows get DEFAULT, existing rows
-- accept the column NULL/default). No DROPs, no RLS ENABLE on existing tables,
-- no destructive ops. Safe to revert by:
--   ALTER TABLE public.research_queue
--     DROP COLUMN plan_json,
--     DROP COLUMN plan_review_status,
--     DROP COLUMN plan_review_iterations,
--     DROP COLUMN plan_review_attempts,
--     DROP COLUMN plan_review_next_attempt_at,
--     DROP COLUMN plan_review_error;
--   DROP TABLE public.plan_reviews;


-- -----------------------------------------------------------------------------
-- §1 — research_queue column additions (Codex CRITICAL-1 + CRITICAL-2)
-- -----------------------------------------------------------------------------
-- research_queue.status enum is UNCHANGED. The values pending|running|completed|
-- failed|cancelled continue to govern queue lifecycle. NEW columns add a
-- parallel dimension for plan-review state + retry tracking.
--
-- plan_review_status enum (matches design §5):
--   pending          -- never reviewed yet (default for new rows)
--   reviewing        -- review in progress
--   approved         -- approved for spawn
--   request_changes  -- user-input needed (NEVER set for system failure — Gemini CRITICAL-1)
--   blocked          -- plan-quality reject (terminal; companion status -> 'failed')
--   system_blocked   -- infra failure; auto-retried (companion status -> 'pending' + next_attempt_at set)

ALTER TABLE public.research_queue
  ADD COLUMN IF NOT EXISTS plan_json                    jsonb,
  ADD COLUMN IF NOT EXISTS plan_review_status           text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS plan_review_iterations       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS plan_review_attempts         integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS plan_review_next_attempt_at  timestamptz,
  ADD COLUMN IF NOT EXISTS plan_review_error            text;

-- CHECK constraint added separately so it can be dropped/replaced without
-- losing the column data if the enum needs to evolve.
ALTER TABLE public.research_queue
  DROP CONSTRAINT IF EXISTS research_queue_plan_review_status_check;

ALTER TABLE public.research_queue
  ADD CONSTRAINT research_queue_plan_review_status_check
  CHECK (plan_review_status IN (
    'pending',
    'reviewing',
    'approved',
    'request_changes',
    'blocked',
    'system_blocked'
  ));

COMMENT ON COLUMN public.research_queue.plan_json IS
  'S58 plan-review gate: synthesized ResearchPlan JSON (schema_version 1). Populated by worker Phase 0a (synthesizePlan) before reviewer invocation. NULL means plan not yet synthesized (plan_review_status=pending).';

COMMENT ON COLUMN public.research_queue.plan_review_status IS
  'S58 plan-review gate: parallel dimension to research_queue.status. Codex CRITICAL-1 split — original status enum UNCHANGED. Combined with status to render derived UI state per design §4. system_blocked is for infrastructure failures only; request_changes is reserved for plan-quality issues from user input (Gemini CRITICAL-1).';

COMMENT ON COLUMN public.research_queue.plan_review_iterations IS
  'S58 plan-review gate: count of sequential review rounds run on this job (Gemini -> integrate -> Codex counts as 1 iteration). Capped by MAX_REVIEW_ROUNDS env (default 2 — design §8 Q1).';

COMMENT ON COLUMN public.research_queue.plan_review_attempts IS
  'S58 plan-review gate: retry counter for system_blocked state (Codex CRITICAL-2). Increments only on infra failure, NOT on REQUEST_CHANGES iterations. Capped at 6 attempts (~30h total wall-clock per design §6).';

COMMENT ON COLUMN public.research_queue.plan_review_next_attempt_at IS
  'S58 plan-review gate: claim-predicate field for system_blocked retry (Codex CRITICAL-2). Set when plan_review_status=system_blocked + status reset to pending. Schedule: 5m, 15m, 45m, 2h15m, 6h45m, 20h15m exponential. NULL means no retry pending.';

COMMENT ON COLUMN public.research_queue.plan_review_error IS
  'S58 plan-review gate: last reviewer error message (truncated to 500 chars). Diagnostic only — UI surfaces a friendlier message keyed off plan_review_status.';


-- -----------------------------------------------------------------------------
-- §2 — Indexes for claim-predicate + retry sweeps
-- -----------------------------------------------------------------------------
-- The modified claim predicate (frontend/app/api/queue/claim/route.ts) reads:
--   WHERE status='pending'
--     AND (plan_review_status <> 'system_blocked'
--          OR plan_review_next_attempt_at <= now())
--   ORDER BY plan_review_next_attempt_at NULLS FIRST, created_at ASC
-- A partial index on (status='pending', plan_review_next_attempt_at) speeds
-- this without bloating storage for completed rows.

CREATE INDEX IF NOT EXISTS research_queue_plan_review_claim_idx
  ON public.research_queue (plan_review_next_attempt_at NULLS FIRST, created_at)
  WHERE status = 'pending';


-- -----------------------------------------------------------------------------
-- §3 — plan_reviews table (audit log; per-reviewer per-iteration row)
-- -----------------------------------------------------------------------------
-- Codex CRITICAL-3: explicit organization_id column + concrete RLS policies.
-- RLS does NOT "inherit" through foreign keys in Postgres.
-- Modeled on supabase/migrations/20260525_research_usage_telemetry.sql §1.

CREATE TABLE IF NOT EXISTS public.plan_reviews (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Tenant scope (FK ON DELETE RESTRICT — audit data should not silently vanish)
  research_queue_id   uuid NOT NULL REFERENCES public.research_queue(id) ON DELETE RESTRICT,
  organization_id     uuid NOT NULL REFERENCES public.organizations(id)  ON DELETE RESTRICT,
  -- Review iteration (1-indexed; matches plan_review_iterations)
  iteration           integer NOT NULL,
  -- Reviewer role for this row
  reviewer            text NOT NULL CHECK (reviewer IN ('gemini','codex','integration')),
  -- The plan version this reviewer/integrator was operating on
  plan_version        jsonb NOT NULL,
  -- Verdict
  verdict             text NOT NULL CHECK (verdict IN (
    'APPROVE', 'APPROVE_WITH_CHANGES', 'REQUEST_CHANGES', 'BLOCK',
    'INTEGRATED', 'UNAVAILABLE'
  )),
  -- Structured findings (jsonb array of {severity, origin, message} objects)
  findings            jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Model identity (forward-compat — these strings will drift over time)
  model_id            text NOT NULL,
  provider            text NOT NULL CHECK (provider IN ('google','openai','anthropic')),
  -- Cost + perf
  input_tokens        integer,
  output_tokens       integer,
  total_cost_usd      numeric(12, 6),
  duration_ms         integer,
  -- Raw response (forward-compat catch-all)
  raw_json            jsonb
);

COMMENT ON TABLE public.plan_reviews IS
  'S58 plan-review gate: per-reviewer per-iteration audit log. One row per (research_queue_id, iteration, reviewer) triple. reviewer="integration" rows record the Claude integration pass between sequential reviewers (design §11 integrator-Claude clarification). Best-effort write — worker logs failure but does NOT block job progression.';

COMMENT ON COLUMN public.plan_reviews.verdict IS
  'Reviewer verdict per sign-off contract in design §"Sign-off contract for reviewers". INTEGRATED for the Claude integration pass between sequential reviewers (no verdict from a model, just a record of the integration). UNAVAILABLE marks a reviewer that was unreachable during fallback (per design §6).';

COMMENT ON COLUMN public.plan_reviews.findings IS
  'Array of {severity, origin, message} objects. severity in CRITICAL|MAJOR|MINOR. origin from the 9-value enum in design §7 (topic|persona|answer-N|studio-selection|decision-context|plan-ambition|scoring-rubric|source-strategy|vendor-evaluation). Empty array for APPROVE / INTEGRATED rows.';

COMMENT ON COLUMN public.plan_reviews.total_cost_usd IS
  'USD cost for this single reviewer call. Sum across all rows for a job to get total review cost — compare against MAX_REVIEW_COST_CENTS env (design §8 Q3 cost-cap circuit breaker).';


-- -----------------------------------------------------------------------------
-- §4 — Indexes for plan_reviews
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS plan_reviews_queue_iter_idx
  ON public.plan_reviews (research_queue_id, iteration, reviewer);

CREATE INDEX IF NOT EXISTS plan_reviews_org_created_idx
  ON public.plan_reviews (organization_id, created_at DESC);


-- -----------------------------------------------------------------------------
-- §5 — RLS on plan_reviews (enabled at create-time; concrete policies)
-- -----------------------------------------------------------------------------
-- Codex CRITICAL-3: explicit policies, not inherited. Same shape as
-- research_usage (ru_select) — owners of a tenant can read their own org's
-- review rows; service_role bypasses RLS for INSERT.

ALTER TABLE public.plan_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pr_select ON public.plan_reviews;

CREATE POLICY pr_select ON public.plan_reviews
  FOR SELECT
  TO authenticated
  USING (
    (select private.auth_user_is_owner())
    AND organization_id = (select private.auth_user_organization_id())
  );

-- Intentionally NO INSERT/UPDATE/DELETE policy for authenticated:
-- - Authenticated clients cannot mutate the audit log (forensic immutability).
-- - Service-role (worker) bypasses RLS for INSERT.


-- =============================================================================
-- END MIGRATION 20260527_plan_review_gate.sql
-- =============================================================================
