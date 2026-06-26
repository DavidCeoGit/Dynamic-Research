import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getContentType } from "./conventions.js";
import { selectUploadSet } from "./upload-set.js";
import {
  uploadWithAudit,
  type UploadWithAuditOpts,
  type UploadWithAuditResult,
} from "./storage-paths.js";
import { getSupabase } from "./worker-supabase.js";
import type { ResearchJob } from "../types.js";

function log(context: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${context.slice(0, 8)}] ${msg}`);
}

// ── Output uploader ─────────────────────────────────────────────────

export interface UploadResult {
  uploaded: number;
  /** Count of files selected for upload from Projects/<slug>/ (post skip-list,
   * post non-file filter). 0 ⇒ the caller's empty-guard fires (loud failJob)
   * rather than reporting a deliverable-less success. */
  selected: number;
  failed: Array<{ remoteName: string; reason: string }>;
}

/** Injectable single-object uploader (Codex MAJOR — lets the IO-loop test
 * assert upsert:true + re-queue idempotency without a live Supabase client).
 * The `sb` field of UploadWithAuditOpts is supplied internally on the default
 * path, so callers/tests need not construct one. */
export type Uploader = (
  args: Omit<UploadWithAuditOpts, "sb">,
) => Promise<UploadWithAuditResult>;

/**
 * Upload a completed run's deliverables to Supabase Storage.
 *
 * S88 MERGE-B (Codex S87 deferred CRITICAL "B2"): sources ONLY from
 * Projects/<slug>/ — the complete, canonical, slug/title-named deliverable set
 * (md/docx/pdf/mp3/mp4/pptx/png) the /research-compare skill leaves there. The
 * prior union with the REUSED per-slug workDir leaked stale prior-run siblings
 * + scratch into the gallery and, with upsert:false, conflict-failed re-queues.
 * Now uses upsert:true (idempotent re-run). File selection is delegated to the
 * pure selectUploadSet(); the uploader is injectable for tests.
 * See Documentation/uploadoutputs-upload-hygiene-design-gate.md.
 */
export async function uploadOutputs(
  job: ResearchJob,
  projectsDir: string,
  uploader?: Uploader,
): Promise<UploadResult> {
  const slug = job.topic_slug;
  const upload: Uploader =
    uploader ?? ((args) => uploadWithAudit({ ...args, sb: getSupabase() }));

  let entries: Array<{ name: string; isFile: boolean }> = [];
  try {
    const dirents = await fs.readdir(projectsDir, { withFileTypes: true });
    entries = dirents.map((d) => ({ name: d.name, isFile: d.isFile() }));
  } catch {
    log(job.id, `Projects dir not found for upload: ${projectsDir}`);
  }

  const selectedSet = selectUploadSet(entries);
  log(job.id, `Uploading ${selectedSet.length} files to Supabase Storage`);

  const failed: Array<{ remoteName: string; reason: string }> = [];
  let uploaded = 0;

  for (const { remoteName } of selectedSet) {
    const localPath = path.join(projectsDir, remoteName);
    try {
      const content = await fs.readFile(localPath);

      // S161 R2-3 (belt-and-suspenders behind the size-aware gate): a 0-byte
      // deliverable is always a truncated/empty bug. Refuse it as a FAILED upload
      // so the existing `uploadResult.failed.length > 0` hard-fail catches it before
      // completeJob — an empty buffer must never be uploaded + reported as success.
      if (content.length === 0) {
        log(job.id, `Refusing 0-byte deliverable (not uploaded): ${remoteName}`);
        failed.push({ remoteName, reason: "refused: zero-byte deliverable" });
        continue;
      }
      const contentType = getContentType(remoteName);

      const result = await upload({
        caller: "executor.ts",
        organizationId: job.organization_id,
        researchQueueId: job.id,
        projectSlug: slug,
        filename: remoteName,
        content,
        contentType,
        upsert: true,
      });

      if (!result.ok) {
        log(job.id, `Upload failed for ${remoteName}: ${result.reason}`);
        failed.push({ remoteName, reason: result.reason ?? "unknown" });
      } else {
        log(job.id, `Uploaded: ${remoteName} (${content.length} bytes)`);
        uploaded++;
      }
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      log(job.id, `Upload error for ${remoteName}: ${msg}`);
      failed.push({ remoteName, reason: msg });
    }
  }

  return { uploaded, selected: selectedSet.length, failed };
}
