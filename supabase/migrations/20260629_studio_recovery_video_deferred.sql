-- S187 P0-2 — Best-effort completion for a still-rendering Studio video (Branch (c)).
-- Additive marker column: a run that completed BEST-EFFORT with its Studio video
-- deferred (the Veo3 render exceeded the render window). The results page selects
-- this column directly to surface an honest "video unavailable for this run" banner.
--
-- Design: Documentation/studio-video-best-effort-completion-design-gate.md §7.1/D-2.
-- NO CHECK/enum change (studio_recovery_status reuses 'recovered'); the render-vs-
-- download distinction lives in studio_recovery_payload.recovery_kind, not status.
-- NOT NULL DEFAULT false mirrors the sibling studio_recovery_* columns and is a
-- fast metadata-only add on PG11+ (constant default). Idempotent (IF NOT EXISTS).
--
-- Filename: underscore between date prefix and name (supabase db push skips dash-
-- named files). No BEGIN/COMMIT, no SET LOCAL (the CLI wraps each file in an
-- implicit transaction). Deploy order (downstream MERGE): migration FIRST, then
-- the worker — the Branch-(c) code is dark-launched behind STUDIO_VIDEO_RENDER_ENABLED.

ALTER TABLE public.research_queue
  ADD COLUMN IF NOT EXISTS studio_recovery_video_deferred boolean NOT NULL DEFAULT false;
