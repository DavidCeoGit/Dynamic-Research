-- Pipeline mode (CE-3) — research_queue.pipeline_mode
--
-- Adds a non-null text column distinguishing a normal full-pipeline run
-- ("full") from a Studio-only regeneration ("studio_only"). Studio-only
-- runs skip Perplexity + NotebookLM deep research entirely: the worker
-- spawns agent/scripts/regenerate-studio-products.ts instead of Claude,
-- reusing the parent run's existing NotebookLM notebook. This is the
-- cost-saver path from Documentation/clone-and-edit-design.md — a clone
-- whose research is fine but whose deliverable framing needs a tweak.
--
-- Pairs with parent_run_id (migration 20260511): a studio_only run MUST
-- have parent_run_id set so the worker can resolve the parent's notebook.
--
-- DEFAULT 'full' + NOT NULL means every existing row backfills to the
-- normal path — no behaviour change for in-flight or historical runs.
-- The worker treats a missing/unknown value as 'full' defensively, so
-- the agent code is safe to deploy BEFORE this migration is applied.
--
-- One-shot DDL migration. Apply via Supabase Studio SQL Editor (same as
-- migration 20260511) — PostgREST cannot run DDL.
-- Destination: supabase/migrations/20260514-pipeline-mode.sql

ALTER TABLE research_queue
  ADD COLUMN IF NOT EXISTS pipeline_mode TEXT NOT NULL DEFAULT 'full'
    CHECK (pipeline_mode IN ('full', 'studio_only'));

COMMENT ON COLUMN research_queue.pipeline_mode IS
  'CE-3: ''full'' = normal deep-research pipeline; ''studio_only'' = regenerate Studio products against the parent run''s existing notebook (requires parent_run_id).';
