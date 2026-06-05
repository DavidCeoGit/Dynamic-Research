-- Clone & Edit (S35) — research_queue.parent_run_id
--
-- Adds a nullable self-referencing FK on research_queue so a cloned run
-- (created via the gallery's "Clone & Edit" button) can point back at its
-- parent. ON DELETE SET NULL preserves the child row if the parent is
-- ever deleted — lineage is informational, not a hard dependency.
--
-- Existing rows backfill to NULL (no parent). The submit endpoint stamps
-- parent_run_id when the form is submitted with ?clone=<slug>.
--
-- This is a one-shot migration. Apply via Supabase Studio SQL Editor or
-- `supabase db push` if the CLI is wired up. No data movement; pure DDL.

ALTER TABLE research_queue
  ADD COLUMN IF NOT EXISTS parent_run_id UUID NULL
    REFERENCES research_queue(id) ON DELETE SET NULL;

-- Index for "find all my clones" + lineage chain queries. NULL parents
-- are the common case so a partial index keeps it small.
CREATE INDEX IF NOT EXISTS idx_research_queue_parent_run_id
  ON research_queue (parent_run_id)
  WHERE parent_run_id IS NOT NULL;

COMMENT ON COLUMN research_queue.parent_run_id IS
  'Self-FK to the run this was cloned from (S35 Clone & Edit). NULL for fresh submissions.';
