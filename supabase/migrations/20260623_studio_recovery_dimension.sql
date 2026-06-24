-- =============================================================================
-- S158 — Transient-tolerant studio-completeness gate: studio_recovery_* dimension
-- =============================================================================
-- DESIGN gate: Documentation/studio-completeness-transient-tolerance-design-gate.md
--   (v3-FINAL, DESIGN gate CLEARED S157 — Gemini + Codex + Codex-QA).
--
-- Purpose:
--   Add the persistence layer for the decoupled studio-recovery sweep. The S129
--   studio-completeness gate hard-FAILS a job when a selected studio product is
--   confirmed complete in NotebookLM (status_id 3) but its binary download hits
--   a TRANSIENT NLM blip (S156 incident, job f204631d — re-downloading the next
--   day succeeded byte-identical). This migration adds a PARALLEL typed
--   dimension (the gate-blessed plan_review_* precedent — NOT a new status enum
--   value) so the worker can self-heal failed -> completed out-of-band without
--   ever letting a job reach completed while a product is missing.
--
--   research_queue.status enum is UNCHANGED. The values pending|running|
--   completed|failed|cancelled continue to govern queue lifecycle. A recoverable
--   job stays status='failed', discriminated by studio_recovery_status='pending'.
--
-- Conventions followed (per memory files):
--   - Filename uses UNDERSCORE (NOT dash) between digit prefix + name
--     [feedback_supabase_db_push_filename_underscore.md]
--   - NO file-level BEGIN/COMMIT — CLI ExecBatch wraps the file + history insert
--     in an implicit transaction; explicit BEGIN breaks atomicity.
--     [feedback_supabase_db_push_no_begin_commit.md]
--   - NO SET LOCAL — fires WARNING 25P01 in the wrapper transaction.
--     [feedback_set_local_in_supabase_migration_warns.md]
--   - ADDITIVE only — ALTER TABLE adds columns with defaults (existing rows get
--     the DEFAULT for the NOT NULL columns; nullable columns stay NULL). No
--     RLS change: the new columns inherit research_queue's existing RLS.
--
-- Pre-apply verification (verify state before mutating — Codex MAJOR-4 precedent):
--   Read-only probe FIRST, confirm the columns are absent:
--     SELECT column_name FROM information_schema.columns
--     WHERE table_name='research_queue' AND column_name LIKE 'studio_recovery%';
--   Expected: zero rows (pre-S158).
--
-- Rollback (ADDITIVE — safe to revert by):
--   ALTER TABLE public.research_queue
--     DROP CONSTRAINT IF EXISTS research_queue_studio_recovery_pending_complete_check,
--     DROP CONSTRAINT IF EXISTS research_queue_studio_recovery_status_check,
--     DROP COLUMN studio_recovery_status,
--     DROP COLUMN studio_recovery_attempts,
--     DROP COLUMN studio_recovery_first_failed_at,
--     DROP COLUMN studio_recovery_next_attempt_at,
--     DROP COLUMN studio_recovery_payload,
--     DROP COLUMN studio_recovery_error;
--   DROP INDEX IF EXISTS research_queue_studio_recovery_due_idx;


-- -----------------------------------------------------------------------------
-- §1 — research_queue column additions (parallel typed dimension)
-- -----------------------------------------------------------------------------
-- studio_recovery_status enum (design §6):
--   none       -- never entered the recovery path (default for every row)
--   pending    -- artifact confirmed status_id 3 in NLM but download transiently
--                 failed; the decoupled sweep is retrying download->upload->complete
--   recovered  -- sweep re-downloaded + re-asserted the S129 obligation set + completed
--   exhausted  -- attempt/age cap breached OR artifact no longer status_id 3 (terminal)
--
-- studio_recovery_first_failed_at is the TRIGGER-IMMUNE age anchor (design G6):
--   trg_queue_updated bumps updated_at on EVERY PATCH, so an updated_at-keyed
--   age cap would slide forward on every retry and never trip. This column is
--   written ONCE (by the executor on the transient branch) and NEVER re-touched
--   by the sweep, so the 48h age bound is measured from the real first failure.

ALTER TABLE public.research_queue
  ADD COLUMN IF NOT EXISTS studio_recovery_status          text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS studio_recovery_attempts        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS studio_recovery_first_failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS studio_recovery_next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS studio_recovery_payload         jsonb,
  ADD COLUMN IF NOT EXISTS studio_recovery_error           text;

-- CHECK added separately so it can be dropped/replaced without losing column
-- data if the enum ever needs to evolve.
ALTER TABLE public.research_queue
  DROP CONSTRAINT IF EXISTS research_queue_studio_recovery_status_check;

ALTER TABLE public.research_queue
  ADD CONSTRAINT research_queue_studio_recovery_status_check
  CHECK (studio_recovery_status IN (
    'none',
    'pending',
    'recovered',
    'exhausted'
  ));

-- S160 C3 (MERGE-gate fix): a 'pending' recovery row MUST carry every field the
-- decoupled sweep needs to make progress. Without this, a row with a NULL
-- studio_recovery_first_failed_at is INVISIBLE to the sweep's due-candidate query
-- (`.lte(studio_recovery_first_failed_at, …)` excludes NULLs) — it would sit
-- non-terminal forever while the UI hides the Retry/Edit terminal controls. The
-- executor is the sole pending-writer and always sets these atomically, so this
-- is defense-in-depth, but it makes a malformed pending row impossible to create.
-- All existing rows are status_id 'none' (additive migration) so the constraint
-- is satisfied on apply. Dropped/re-added idempotently like the enum CHECK above.
ALTER TABLE public.research_queue
  DROP CONSTRAINT IF EXISTS research_queue_studio_recovery_pending_complete_check;

ALTER TABLE public.research_queue
  ADD CONSTRAINT research_queue_studio_recovery_pending_complete_check
  CHECK (
    studio_recovery_status <> 'pending'
    OR (
      studio_recovery_first_failed_at IS NOT NULL
      AND studio_recovery_next_attempt_at IS NOT NULL
      AND studio_recovery_payload          IS NOT NULL
      AND studio_recovery_attempts >= 1
    )
  );

COMMENT ON COLUMN public.research_queue.studio_recovery_status IS
  'S158 transient-tolerant studio gate: parallel dimension to research_queue.status (status enum UNCHANGED — plan_review_* precedent). none=not in recovery; pending=confirmed-in-NLM artifact had a transient download failure, decoupled sweep retrying; recovered=self-healed to completed; exhausted=cap breached / artifact gone (terminal). A recoverable job stays status=failed; the frontend derives the "Finalizing media" chip from (status=failed AND studio_recovery_status=pending).';

COMMENT ON COLUMN public.research_queue.studio_recovery_attempts IS
  'S158: count of recovery passes actually RUN by the sweep (executor seeds 1 on the in-gate failure). Caps the sweep at STUDIO_RECOVERY_SWEEP_MAX_ATTEMPTS (8). The age cap is attempts-GATED (fires only when attempts >= STUDIO_RECOVERY_SWEEP_MIN_ATTEMPTS_FOR_AGE_EXHAUST) so a worker-down/backoff window cannot falsely exhaust a never-tried job (Codex MAJOR-1).';

COMMENT ON COLUMN public.research_queue.studio_recovery_first_failed_at IS
  'S158: TRIGGER-IMMUNE age anchor (design G6). Written ONCE by the executor on the transient branch and NEVER re-touched by the sweep, so the 48h age cap is measured from the real first failure — unlike updated_at, which trg_queue_updated bumps on every retry-PATCH.';

COMMENT ON COLUMN public.research_queue.studio_recovery_next_attempt_at IS
  'S158: claim-predicate for the recovery sweep (plan_review_next_attempt_at precedent). The sweep only considers a candidate when next_attempt_at <= now(); each pass sets it to now()+exponential-backoff. NULL means no recovery pending.';

COMMENT ON COLUMN public.research_queue.studio_recovery_payload IS
  'S158: self-sufficient recovery descriptor (design G8) — {notebookId, products:[{product,artifactId,nlmType,filename}]}. Carries the confirmed artifact ids so the sweep downloads BY ID (never default-latest) without depending on state.json surviving on disk. The presentBefore products live in the per-slug deliverables dir; the sweep re-downloads only the pending products and re-asserts the full obligation set before completing.';

COMMENT ON COLUMN public.research_queue.studio_recovery_error IS
  'S158: last captured NLM download stderr (truncated 500). The S129 gate previously swallowed stderr (the literal S156 diagnostic gap, design G9); this column makes transient-vs-terminal visible.';


-- -----------------------------------------------------------------------------
-- §2 — Partial index for the sweep candidate query
-- -----------------------------------------------------------------------------
-- The sweep's cheap eligibility check (design §7) runs every poll tick:
--   WHERE studio_recovery_status='pending'
--     AND studio_recovery_next_attempt_at <= now()
--     AND studio_recovery_first_failed_at <= now() - interval '2 min'
--   ORDER BY studio_recovery_next_attempt_at ASC LIMIT 1
-- A partial index on (studio_recovery_next_attempt_at) WHERE status='pending'
-- keeps it O(due-candidates) without bloating storage for the common
-- studio_recovery_status='none' rows.

CREATE INDEX IF NOT EXISTS research_queue_studio_recovery_due_idx
  ON public.research_queue (studio_recovery_next_attempt_at)
  WHERE studio_recovery_status = 'pending';


-- =============================================================================
-- END MIGRATION 20260623_studio_recovery_dimension.sql
-- =============================================================================
