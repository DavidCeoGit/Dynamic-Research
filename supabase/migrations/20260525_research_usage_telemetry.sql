-- =============================================================================
-- S52 #4 — research_usage telemetry table (DATA-label MERGE-gate)
-- =============================================================================
-- Sandbox draft 2026-05-25 morning. Intended path on promote:
--   supabase/migrations/20260525_research_usage_telemetry.sql
--
-- Purpose:
--   Persist per-job Claude CLI usage + USD cost parsed from
--   `claude -p --output-format json --verbose` stdout (JSON array of events
--   whose last element is the type=="result" usage summary). Best-effort
--   write on every job completion (success, failure, kill). Surfaces per-org
--   daily spend, per-job token totals, per-model breakdown.
--
-- Shape verified live 2026-05-25 morning via two probes (CLI v2.1.146):
--   - --output-format json alone: single JSON object on stdout
--   - --output-format json --verbose: single-line JSON ARRAY of events
--     (rate_limit, system_init, assistant N, result)
--   Gemini round-1 M2: keep --verbose for per-line heartbeat visibility in
--   worker.log; parser handles both shapes for defense in depth.
--   The CLI emits `total_cost_usd`, per-model `modelUsage{}`, top-level usage
--   totals, durations, stop_reason, terminal_reason. We trust the CLI numbers
--   verbatim; no MODEL_PRICING constants needed.
--
-- Conventions followed (per memory files):
--   - Filename uses underscore (NOT dash) between digit prefix + name
--     [feedback_supabase_db_push_filename_underscore.md]
--   - NO explicit BEGIN/COMMIT — CLI ExecBatch wraps the file + history insert
--     in an implicit transaction. Explicit BEGIN breaks atomicity.
--     [feedback_supabase_db_push_no_begin_commit.md]
--   - NO SET LOCAL — fires WARNING 25P01 in the wrapper transaction.
--     [feedback_set_local_in_supabase_migration_warns.md]
--   - RLS ENABLED at create-time (table is brand-new, zero rows, zero
--     existing traffic — same safety logic as audit_storage_writes in
--     20260523_phase_b_auth_rls_helpers.sql §6).
--   - Uses private.auth_user_is_owner() + private.auth_user_organization_id()
--     helpers shipped in 20260523_phase_b_auth_rls_helpers.sql §3.
--
-- Rollback note: ADDITIVE migration. No DROPs, no data mutation, no RLS
--   ENABLE on existing tables. Safe to revert by dropping research_usage
--   if it ever becomes problematic.

-- -----------------------------------------------------------------------------
-- §1 — research_usage table
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.research_usage (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recorded_at              timestamptz NOT NULL DEFAULT now(),
  -- Tenant scope (FK ON DELETE RESTRICT — audit data should not silently vanish)
  research_queue_id        uuid NOT NULL REFERENCES public.research_queue(id) ON DELETE RESTRICT,
  organization_id          uuid NOT NULL REFERENCES public.organizations(id)   ON DELETE RESTRICT,
  -- Worker-side status (interpreted by the worker BEFORE attempting JSON parse)
  job_status               text NOT NULL CHECK (job_status IN ('complete', 'failed', 'killed', 'no-summary')),
  exit_code                int  NOT NULL,
  -- CLI-side status (parsed from stdout JSON; NULL if no-summary)
  is_error                 boolean,
  api_error_status         text,
  stop_reason              text,
  terminal_reason          text,
  -- Performance
  duration_ms              bigint,
  duration_api_ms          bigint,
  ttft_ms                  bigint,
  num_turns                int,
  -- Token totals (sum across all models in the call, from usage.*)
  input_tokens             bigint,
  cache_creation_tokens    bigint,
  cache_read_tokens        bigint,
  output_tokens            bigint,
  -- Cost (verbatim from CLI's total_cost_usd; numeric(12,6) for micro-USD precision)
  total_cost_usd           numeric(12, 6),
  -- Per-model breakdown (jsonb pass-through of modelUsage{})
  model_usage              jsonb,
  -- Full final-line JSON (forward-compat catch-all when CLI shape evolves)
  raw_json                 jsonb
);

COMMENT ON TABLE public.research_usage IS
  'S52 #4: per-job Claude CLI usage + USD cost. Parsed from `claude -p --output-format json --verbose` stdout — a JSON array of events whose last element is the type==result usage summary. Parser handles both array-with-result (--verbose ON, current) and bare-result-object (--verbose OFF, fallback) shapes. Best-effort write — worker logs failure but does NOT block job completion. raw_json preserves the full final-event summary for forward-compat parsing when CLI shape evolves. model_usage captures per-model breakdown since Claude Code routes internally across multiple models per call (e.g. haiku-4-5 for routing decisions + opus-4-7 for completion).';

COMMENT ON COLUMN public.research_usage.job_status IS
  'Worker''s interpretation: complete | failed | killed | no-summary. "no-summary" = child exited but stdout did not yield a parseable JSON summary (likely SIGKILL or partial write at SIGTERM); when set, the *_tokens / *_ms / cost columns are NULL.';

COMMENT ON COLUMN public.research_usage.total_cost_usd IS
  'Verbatim from CLI total_cost_usd field. Includes ALL model cost in the session including 1h/5m cache priming. First-call-per-hour-per-session is expensive (cache priming); subsequent calls within the same session-window are cache-hit cheap. Interpret daily aggregates with this cache-tier dynamic in mind.';

COMMENT ON COLUMN public.research_usage.model_usage IS
  'Verbatim CLI modelUsage{} object, keyed by model_id (e.g. "claude-opus-4-7[1m]"). Each model entry has inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUSD, contextWindow, maxOutputTokens.';

-- -----------------------------------------------------------------------------
-- §2 — Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS research_usage_recorded_at_idx
  ON public.research_usage (recorded_at DESC);

CREATE INDEX IF NOT EXISTS research_usage_org_idx
  ON public.research_usage (organization_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS research_usage_queue_idx
  ON public.research_usage (research_queue_id);

-- -----------------------------------------------------------------------------
-- §3 — RLS (enabled at create-time; zero existing rows, zero traffic)
-- -----------------------------------------------------------------------------

ALTER TABLE public.research_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ru_select ON public.research_usage;

CREATE POLICY ru_select ON public.research_usage
  FOR SELECT
  TO authenticated
  USING (
    (select private.auth_user_is_owner())
    AND organization_id = (select private.auth_user_organization_id())
  );

-- Intentionally NO INSERT/UPDATE/DELETE policy:
-- - Authenticated clients cannot mutate the usage log (forensic immutability).
-- - Service-role (worker) bypasses RLS for INSERT.

-- -----------------------------------------------------------------------------
-- §4 — Daily aggregate view (reporting; non-materialized for V1)
-- -----------------------------------------------------------------------------

-- Gemini round-1 C1: standard views run under the view-owner's privileges
-- (postgres/supabase_admin in migration context), which bypasses RLS on the
-- underlying table — a critical cross-tenant data leak. PostgreSQL 15+
-- (Supabase is on PG 15+) supports `WITH (security_invoker = true)` to flip
-- the view to evaluate base-table policies against the QUERYING client.
-- Without this option, ru_select on the base table is bypassed.
CREATE OR REPLACE VIEW public.research_usage_daily
WITH (security_invoker = true) AS
SELECT
  date_trunc('day', recorded_at)                                    AS day,
  organization_id,
  count(*)                                                          AS jobs,
  count(*) FILTER (WHERE job_status = 'complete')                   AS jobs_complete,
  count(*) FILTER (WHERE job_status = 'failed')                     AS jobs_failed,
  count(*) FILTER (WHERE job_status = 'killed')                     AS jobs_killed,
  count(*) FILTER (WHERE job_status = 'no-summary')                 AS jobs_no_summary,
  sum(total_cost_usd) FILTER (WHERE job_status = 'complete')        AS total_cost_usd_complete,
  sum(total_cost_usd)                                               AS total_cost_usd_all,
  sum(input_tokens)                                                 AS total_input_tokens,
  sum(output_tokens)                                                AS total_output_tokens,
  sum(cache_read_tokens)                                            AS total_cache_read_tokens,
  sum(cache_creation_tokens)                                        AS total_cache_creation_tokens,
  avg(duration_ms) FILTER (WHERE job_status = 'complete')           AS avg_duration_ms_complete,
  avg(ttft_ms) FILTER (WHERE job_status = 'complete')               AS avg_ttft_ms_complete
FROM public.research_usage
GROUP BY 1, 2;

COMMENT ON VIEW public.research_usage_daily IS
  'S52 #4: per-day, per-org rollup of Claude CLI usage + cost. Splits jobs by status so failed/killed/no-summary stats don''t pollute complete-job averages. RLS inherited from research_usage base table (ru_select policy) via WITH (security_invoker = true) — Gemini round-1 C1 fix.';

-- =============================================================================
-- END MIGRATION 20260525_research_usage_telemetry.sql
-- =============================================================================
