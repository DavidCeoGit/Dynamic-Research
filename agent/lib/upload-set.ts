/**
 * Pure selection of which Projects/<slug>/ entries uploadOutputs sends to
 * Supabase Storage. Extracted as a tested pure core (mirrors the S87
 * find-state-file.ts pattern) so the IO loop in executor.ts stays thin.
 *
 * Why this exists (S88 MERGE-B — Codex S87 deferred CRITICAL "B2"):
 *   uploadOutputs historically uploaded the UNION of Projects/<slug>/ AND the
 *   per-slug workDir (C:/tmp/research-compare/<slug>). The workDir is REUSED
 *   across re-queues of the same slug, so it accumulated (a) stale prior-run
 *   deliverables (<oldts>-*.md), (b) scratch the skip-list misses
 *   (persona*.txt, research-plan.json, research-status.json, tier1-passed-
 *   urls-*.txt), and (c) timestamp-named copies that DUPLICATE the canonical
 *   slug/title-named Projects/ deliverables under a different name. All of it
 *   leaked into the gallery file inventory (which lists every storage object,
 *   unfiltered), and with upsert:false a re-queued slug conflict-failed at
 *   upload.
 *
 *   Fix (Option A, design-gate Gemini+Codex unanimous): source ONLY from
 *   Projects/<slug>/. The /research-compare skill guarantees that dir holds the
 *   COMPLETE canonical set — Phase 6 Step B copies md/mp3/mp4/pptx/png there
 *   (renamed slug/title-prefixed), and .docx/.pdf are GENERATED inside it
 *   (Pandoc Step C / Bug 23). It is overwritten-in-place each run, so it never
 *   accumulates stale siblings. The reused workDir is redundant and dropped.
 *
 *   See Documentation/uploadoutputs-upload-hygiene-design-gate.md (+ companion
 *   peer-review) for the full decision record.
 */

import { isSkipFile } from "./conventions.js";

/** Minimal directory-entry shape: name + whether it is a regular file.
 * Build from `fs.readdir(dir, { withFileTypes: true })` → `{ name, isFile: d.isFile() }`. */
export interface UploadCandidate {
  name: string;
  isFile: boolean;
}

/**
 * Given the Projects/<slug>/ directory entries, return the set to upload.
 * Excludes subdirectories / non-regular-files (Codex NIT — a string-only filter
 * could select a subdir) and skip-list files (pipeline-internal/scratch). The
 * remoteName is the filename verbatim (also the storage object name). Pure: no
 * IO, no ordering assumptions. Returns [] for an empty or all-excluded input —
 * the caller treats [] as the loud empty-guard failure.
 */
export function selectUploadSet(
  entries: UploadCandidate[],
): Array<{ remoteName: string }> {
  const out: Array<{ remoteName: string }> = [];
  for (const e of entries) {
    if (!e.isFile) continue;
    if (isSkipFile(e.name)) continue;
    out.push({ remoteName: e.name });
  }
  return out;
}
