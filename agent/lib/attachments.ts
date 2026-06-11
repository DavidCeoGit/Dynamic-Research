/**
 * S106 — Phase 3 of the file-upload feature: worker-side attachment intake.
 *
 * Two responsibilities:
 *   - sniffAttachment(buf, contentType): magic-byte content verification.
 *     The upload routes only ever see metadata (signed-URL PUTs bypass the
 *     server), so the declared contentType is a CLIENT CLAIM until this
 *     check runs. Pure function, unit-tested in test/attachments.test.ts.
 *   - downloadAttachments(sb, job, workDir): pull each submitted attachment
 *     from <orgId>/<slug>/sources/ in the research-projects bucket, re-check
 *     size, sniff, and write to <workDir>/sources/<storedName> for the
 *     pipeline (NLM source upload + bounded digests for the Perplexity and
 *     Claude legs).
 *
 * SKIP-AND-RECORD policy: one bad file must never kill a multi-dollar
 * research run. Every per-file failure is recorded in the returned
 * `skipped` list (which flows into the manifest as attachmentsSkipped) and
 * the loop continues. downloadAttachments NEVER throws.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ATTACHMENTS, BUCKET } from "./conventions.js";
import { scopedSourcesPath, scopedStoragePath } from "./storage-paths.js";
import type { AttachmentMeta, ResearchJob } from "../types.js";

// ── Content sniffing ────────────────────────────────────────────────

const PDF_MAGIC = Buffer.from("%PDF-");
// ZIP local-file / end-of-central-dir / spanned-archive signatures. A
// .docx/.xlsx/.jar renamed to .txt is a ZIP container, not text.
const ZIP_MAGICS = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08]),
];
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
// PE/DOS executables start "MZ". A legitimate text file beginning with the
// literal letters "MZ" is a theoretical false positive we accept — the cost
// of a skip is a missing digest, the cost of a miss is an executable on the
// prompt surface.
const PE_MAGIC = Buffer.from([0x4d, 0x5a]);

function startsWith(buf: Buffer, prefix: Buffer): boolean {
  return buf.length >= prefix.length && buf.subarray(0, prefix.length).equals(prefix);
}

export interface SniffResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verify that a downloaded attachment's bytes plausibly match its declared
 * contentType. PDF must carry the %PDF- header; txt/md must be NUL-free
 * valid UTF-8 and must not carry a known binary container/executable magic
 * (PDF, ZIP, ELF, PE). This is a cheap honesty check, not a full parser —
 * its job is to keep disguised binaries away from the orchestrator's
 * native-PDF Read path and the NLM source upload.
 */
export function sniffAttachment(
  buf: Buffer,
  contentType: AttachmentMeta["contentType"],
): SniffResult {
  if (contentType === "application/pdf") {
    if (!startsWith(buf, PDF_MAGIC)) {
      return { ok: false, reason: "declared PDF but missing %PDF- header" };
    }
    return { ok: true };
  }

  // text/plain or text/markdown
  if (startsWith(buf, PDF_MAGIC)) {
    return { ok: false, reason: "declared text but carries PDF magic bytes" };
  }
  for (const zip of ZIP_MAGICS) {
    if (startsWith(buf, zip)) {
      return { ok: false, reason: "declared text but carries ZIP magic bytes" };
    }
  }
  if (startsWith(buf, ELF_MAGIC)) {
    return { ok: false, reason: "declared text but carries ELF magic bytes" };
  }
  if (startsWith(buf, PE_MAGIC)) {
    return { ok: false, reason: "declared text but carries PE/DOS (MZ) magic bytes" };
  }
  if (buf.includes(0)) {
    return { ok: false, reason: "declared text but contains NUL bytes" };
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return { ok: false, reason: "declared text but is not valid UTF-8" };
  }
  return { ok: true };
}

// ── Metadata revalidation ───────────────────────────────────────────

// extension → required MIME, built from the parallel conventions arrays
// (allowed_extensions[i] pairs with allowed_mime_types[i]). The DB CHECK
// only guarantees `attachments` is a JSON array — element shape is enforced
// by the frontend zod schemas at submit, which a forged row bypasses. The
// worker is the last validator before bytes reach the prompt surface, so it
// re-checks the full shape itself (S106 Codex MAJOR #2).
const EXT_TO_MIME = new Map<string, string>(
  ATTACHMENTS.allowed_extensions.map((ext, i) => [
    ext,
    ATTACHMENTS.allowed_mime_types[i],
  ]),
);

/**
 * Returns a skip reason, or null if the meta is well-formed. Takes `unknown`
 * because the DB CHECK only guarantees the COLUMN is a JSON array — an
 * element can be null/string/number (audit 2026-06-11 A6/A20), and a forged
 * `[null, {...}]` row must produce a skip reason here, not a TypeError that
 * escapes downloadAttachments' never-throws contract and hard-fails the job.
 */
export function validateAttachmentMeta(meta: unknown): string | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return "malformed meta: element is not an object";
  }
  const m = meta as Partial<Record<keyof AttachmentMeta, unknown>>;
  if (typeof m.storedName !== "string" || m.storedName.length === 0) {
    return "malformed meta: storedName missing";
  }
  if (
    typeof m.originalName !== "string" ||
    m.originalName.length === 0 ||
    m.originalName.length > 255
  ) {
    return "malformed meta: originalName missing or over 255 chars";
  }
  if (
    typeof m.sizeBytes !== "number" ||
    !Number.isSafeInteger(m.sizeBytes) ||
    m.sizeBytes <= 0
  ) {
    return "malformed meta: sizeBytes must be a positive integer";
  }
  if (
    typeof m.contentType !== "string" ||
    !ATTACHMENTS.allowed_mime_types.includes(m.contentType)
  ) {
    return `malformed meta: contentType "${String(m.contentType)}" not allowed`;
  }
  const dot = m.storedName.lastIndexOf(".");
  const ext = dot >= 0 ? m.storedName.slice(dot).toLowerCase() : "";
  if (EXT_TO_MIME.get(ext) !== m.contentType) {
    return `malformed meta: extension "${ext}" does not match contentType "${m.contentType}"`;
  }
  return null;
}

/**
 * Narrow a raw attachments-array element to an object-shaped meta, or null.
 * Skip records carry the original meta for the manifest/log trail, but a
 * non-object element (audit A6/A20) has nothing to carry — consumers of
 * SkippedAttachment.meta must guard for null instead of dereferencing.
 */
export function asMetaOrNull(meta: unknown): AttachmentMeta | null {
  return typeof meta === "object" && meta !== null && !Array.isArray(meta)
    ? (meta as AttachmentMeta)
    : null;
}

// ── Download ────────────────────────────────────────────────────────

/**
 * Minimal structural type for the Supabase client surface this module
 * touches — lets tests inject a plain-object mock without pulling
 * @supabase/supabase-js type machinery into the test file.
 */
export interface StorageDownloaderLike {
  storage: {
    from(bucket: string): {
      download(
        objectPath: string,
      ): Promise<{
        data: { arrayBuffer(): Promise<ArrayBuffer> } | null;
        error: { message: string } | null;
      }>;
      list(
        prefix: string,
        opts: { limit: number; sortBy?: { column: string; order: string } },
      ): Promise<{
        data:
          | Array<{ name: string; metadata: Record<string, unknown> | null }>
          | null;
        error: { message: string } | null;
      }>;
    };
  };
}

export interface SkippedAttachment {
  /** null when the raw array element wasn't even an object (audit A6/A20). */
  meta: AttachmentMeta | null;
  reason: string;
}

export interface AttachmentDownloadResult {
  /** Metas whose bytes were verified and written to <workDir>/sources/. */
  downloaded: AttachmentMeta[];
  skipped: SkippedAttachment[];
}

type JobAttachmentFields = Pick<
  ResearchJob,
  "id" | "organization_id" | "topic_slug" | "attachments"
>;

/**
 * Download a job's attachments into `<workDir>/sources/`.
 *
 * Before any download, the sources/ folder is LISTED once and each file's
 * storage-metadata size is verified against the declared sizeBytes (S106
 * Gemini MERGE finding 2: download() buffers the whole object in RAM, so a
 * storage object far larger than its declared size must be rejected BEFORE
 * the bytes are pulled, or a forged row + oversized object could OOM the
 * worker). The list is fail-CLOSED: if it errors, every attachment is
 * skipped-and-recorded and the run proceeds without sources.
 *
 * Per file: validate the storedName via scopedSourcesPath (throws on any
 * contract violation → skip), re-check declared size against the per-file
 * cap, verify listed storage size === declared, download, verify actual
 * byte length matches declared (belt-and-braces; the submit route verified
 * exact size at copy time, so a mismatch means post-submit drift), enforce
 * the running total cap, sniff magic bytes, then write. Caps come from
 * conventions.json `attachments` (canonical).
 *
 * NEVER throws; never fails the job. Returns { downloaded, skipped }.
 */
export async function downloadAttachments(
  sb: StorageDownloaderLike,
  job: JobAttachmentFields,
  workDir: string,
  logFn: (msg: string) => void = () => {},
): Promise<AttachmentDownloadResult> {
  const result: AttachmentDownloadResult = { downloaded: [], skipped: [] };
  const metas = job.attachments ?? [];
  if (metas.length === 0) return result;

  const sourcesDir = path.join(workDir, ATTACHMENTS.sources_subdir);
  try {
    // WIPE-then-create: workDirs are keyed by slug and REUSED across retries
    // of the same run (the repo's documented stale-workdir bug class — cf.
    // findstatefile reused-workdir stale picks). The orchestrator digests
    // EVERY file in this directory, so anything left from a prior attempt
    // must not survive into this one (S106 Codex BLOCKING #1).
    await fs.rm(sourcesDir, { recursive: true, force: true });
    await fs.mkdir(sourcesDir, { recursive: true });
  } catch (err) {
    const reason = `could not prepare sources dir: ${(err as Error).message}`;
    logFn(`[attachments] ${reason} — skipping all ${metas.length} attachments`);
    result.skipped = metas.map((meta) => ({ meta: asMetaOrNull(meta), reason }));
    return result;
  }

  // Pre-download size verification (fail-CLOSED). One list call covers all
  // files; storage metadata size must match the declared sizeBytes BEFORE
  // any bytes are buffered in memory.
  let listedSizes: Map<string, number>;
  try {
    // Org/slug validated by the tenant-boundary primitive; the sources
    // subdir is a fixed conventions constant appended to the validated base.
    const sourcesPrefix = `${scopedStoragePath(job.organization_id, job.topic_slug)}/${ATTACHMENTS.sources_subdir}`;
    const { data, error } = await sb.storage
      .from(BUCKET)
      .list(sourcesPrefix, {
        limit: 1000,
        sortBy: { column: "name", order: "asc" },
      });
    if (error) throw new Error(error.message);
    listedSizes = new Map(
      (data ?? [])
        .filter((o) => o.metadata !== null)
        .map((o) => [o.name, Number((o.metadata as Record<string, unknown>).size ?? NaN)]),
    );
  } catch (err) {
    const reason = `could not list sources/ for size verification: ${(err as Error).message}`;
    logFn(`[attachments] ${reason} — skipping all ${metas.length} attachments (fail-closed)`);
    result.skipped = metas.map((meta) => ({ meta: asMetaOrNull(meta), reason }));
    return result;
  }

  const seenStoredNames = new Set<string>();
  let totalBytes = 0;

  for (const [idx, meta] of metas.entries()) {
    // Defensive max_files re-check (mint + submit already enforce it; a
    // hand-edited DB row must not amplify download work).
    if (idx >= ATTACHMENTS.max_files) {
      result.skipped.push({
        meta: asMetaOrNull(meta),
        reason: `exceeds max_files cap (${ATTACHMENTS.max_files})`,
      });
      continue;
    }
    // Full shape revalidation — the worker must not trust a row's element
    // shape (forged contentType / sizeBytes / oversize originalName would
    // otherwise reach the sniffer and the fenced prompt block).
    const metaReason = validateAttachmentMeta(meta);
    if (metaReason) {
      result.skipped.push({ meta: asMetaOrNull(meta), reason: metaReason });
      continue;
    }
    // Duplicate storedName would silently overwrite the earlier file in the
    // workdir (same failure class as the S105 storedName-collision finding).
    if (seenStoredNames.has(meta.storedName)) {
      result.skipped.push({ meta, reason: "duplicate storedName in attachments list" });
      continue;
    }
    seenStoredNames.add(meta.storedName);

    try {
      // Throws on any storedName contract violation (charset, extension,
      // traversal, reserved basename) — the tenant-boundary primitive is the
      // validator of record.
      const objectPath = scopedSourcesPath(
        job.organization_id,
        job.topic_slug,
        meta.storedName,
      );

      if (meta.sizeBytes > ATTACHMENTS.max_file_bytes) {
        result.skipped.push({
          meta,
          reason: `declared size ${meta.sizeBytes} exceeds per-file cap ${ATTACHMENTS.max_file_bytes}`,
        });
        continue;
      }

      // Pre-download size gate against the storage listing — the object's
      // REAL size must match the declared sizeBytes before download()
      // buffers it in RAM (OOM guard; Gemini S106 finding 2).
      const listedSize = listedSizes.get(meta.storedName);
      if (listedSize === undefined) {
        result.skipped.push({
          meta,
          reason: "not present in sources/ listing",
        });
        continue;
      }
      if (!Number.isFinite(listedSize) || listedSize !== meta.sizeBytes) {
        result.skipped.push({
          meta,
          reason: `storage size mismatch before download: declared ${meta.sizeBytes}, listed ${listedSize}`,
        });
        continue;
      }

      const { data, error } = await sb.storage.from(BUCKET).download(objectPath);
      if (error || !data) {
        result.skipped.push({
          meta,
          reason: `download failed: ${error?.message ?? "empty response"}`,
        });
        continue;
      }

      const buf = Buffer.from(await data.arrayBuffer());

      if (buf.length !== meta.sizeBytes) {
        result.skipped.push({
          meta,
          reason: `size mismatch: declared ${meta.sizeBytes}, actual ${buf.length}`,
        });
        continue;
      }

      if (totalBytes + buf.length > ATTACHMENTS.max_total_bytes) {
        result.skipped.push({
          meta,
          reason: `total size cap ${ATTACHMENTS.max_total_bytes} exceeded`,
        });
        continue;
      }

      const sniff = sniffAttachment(buf, meta.contentType);
      if (!sniff.ok) {
        result.skipped.push({ meta, reason: `sniff rejected: ${sniff.reason}` });
        continue;
      }

      // storedName passed scopedSourcesPath's regex (no separators, no
      // traversal, no reserved basename), so the join cannot escape
      // sourcesDir.
      await fs.writeFile(path.join(sourcesDir, meta.storedName), buf);
      totalBytes += buf.length;
      result.downloaded.push(meta);
      logFn(
        `[attachments] downloaded ${meta.storedName} (${buf.length} bytes) → sources/`,
      );
    } catch (err) {
      result.skipped.push({
        meta,
        reason: `unexpected error: ${(err as Error).message}`,
      });
    }
  }

  for (const s of result.skipped) {
    logFn(
      `[attachments] SKIPPED ${s.meta?.storedName ?? "<malformed element>"}: ${s.reason}`,
    );
  }
  return result;
}
