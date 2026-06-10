-- File-attachment metadata on research_queue (S102 file-upload feature).
-- Users attach PDF/TXT/MD source files at submission time; this column carries
-- the AttachmentMeta[] (originalName, storedName, sizeBytes, contentType,
-- uploadedAt) the worker uses to download the run's storage objects from
-- <org_id>/<topic_slug>/sources/<storedName> into the job workdir.
-- Storage objects live in the research-projects bucket; this is metadata only.
-- Element-shape validation lives in the API layer (frontend/lib/validate.ts
-- attachmentMetaSchema); the DB guards only the container type.
-- Additive; rollback = ALTER TABLE public.research_queue DROP COLUMN attachments.
-- Conventions: underscore filename, NO BEGIN/COMMIT, NO SET LOCAL.

ALTER TABLE public.research_queue
  ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Defense-in-depth: the column must always be a JSON array, so a worker or
-- script bug can never persist an object/string/null here and break the
-- executor's job.attachments iteration.
ALTER TABLE public.research_queue
  ADD CONSTRAINT research_queue_attachments_is_array
  CHECK (jsonb_typeof(attachments) = 'array');
