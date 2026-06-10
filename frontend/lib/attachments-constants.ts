/**
 * S102 file-upload feature — frontend constants + filename sanitizer.
 *
 * MIRROR of the `attachments` block in agent/lib/conventions.json (v3).
 * Kept as a frontend-local duplicate per the established mirror pattern
 * (frontend/lib/storage-paths.ts, frontend/lib/untrusted-input.ts) — agent/
 * and frontend/ have separate tsconfigs and avoiding the cross-package import
 * keeps the Next build hermetic. PAIR-EDIT this file with conventions.json
 * whenever caps, allowed types, or path-segment names change; nothing
 * mechanical catches drift between the two.
 */

export const ATTACHMENT_ALLOWED_EXTENSIONS = [".pdf", ".txt", ".md"] as const;

export const ATTACHMENT_ALLOWED_MIME_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
] as const;

export type AttachmentContentType = (typeof ATTACHMENT_ALLOWED_MIME_TYPES)[number];

/** Per-file cap: 15 MiB. */
export const ATTACHMENT_MAX_FILE_BYTES = 15_728_640;
/** Per-request total cap: 40 MiB. */
export const ATTACHMENT_MAX_TOTAL_BYTES = 41_943_040;
export const ATTACHMENT_MAX_FILES = 5;

/**
 * Storage path segments. `uploads` can never collide with a real topic_slug
 * because generateSlug() always appends "-<8 hex>". The sources/ subdir is
 * invisible to the gallery (lib/storage.ts listFiles filters sub-folders).
 */
export const ATTACHMENT_STAGING_PREFIX = "uploads";
export const ATTACHMENT_SOURCES_SUBDIR = "sources";

/** Staged objects older than this are garbage by construction (TTL sweep). */
export const ATTACHMENT_STAGING_TTL_HOURS = 24;

/** Canonical extension → MIME type for the three allowed formats. */
export const ATTACHMENT_EXT_TO_MIME: Record<string, AttachmentContentType> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

/**
 * The shape every storedName must satisfy. sanitizeAttachmentName() output
 * always matches; zod re-validates at submit; the storage-path helpers
 * re-reject traversal at every path construction (defense in depth).
 */
export const ATTACHMENT_STORED_NAME_REGEX = /^[a-z0-9][a-z0-9._-]*\.(pdf|txt|md)$/;

/**
 * Sanitize a user-supplied filename into a storage-safe storedName.
 *
 * - NFKC-normalize + lowercase
 * - extension must be in the allowlist (throws otherwise — callers validate
 *   extension BEFORE calling, so the throw is a programming-error backstop)
 * - base charset reduced to [a-z0-9._-]; everything else becomes "-"
 * - consecutive dots collapsed (no ".." can survive), separators collapsed
 * - leading dots/separators stripped (a leading "." is a skip-prefix in
 *   conventions.json and must never reach storage)
 * - empty base falls back to "file"
 * - base bounded to 100 chars so suffixed names stay well under 255
 * - optional collision suffix: "-1", "-2", … against `existingNames`
 *
 * CALLER CONTRACT for `existingNames` (S102 interim-review MINOR-4): many
 * distinct inputs collapse to the same output (".pdf", "..pdf", "---.pdf"
 * all → "file.pdf"), so when sanitizing a BATCH the caller MUST thread the
 * cumulative set of already-assigned storedNames (plus any already staged in
 * the draft) through every call. Failing to do so is still SAFE — duplicate
 * storedNames are rejected by attachmentsArraySchema at submit — but it
 * turns a silent rename into a whole-submission rejection.
 *
 * The ORIGINAL name is display-only and must never be used in a storage path.
 */
export function sanitizeAttachmentName(
  originalName: string,
  existingNames?: ReadonlySet<string>,
): string {
  const normalized = originalName.normalize("NFKC").toLowerCase().trim();
  const lastDot = normalized.lastIndexOf(".");
  const ext = lastDot >= 0 ? normalized.slice(lastDot) : "";
  if (!(ATTACHMENT_ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new Error(`sanitizeAttachmentName: extension not allowed "${ext}"`);
  }
  let base = normalized
    .slice(0, lastDot)
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[.\-_]+/, "")
    .replace(/[.\-_]+$/, "");
  if (!base) base = "file";
  base = base.slice(0, 100).replace(/[.\-_]+$/, "");
  if (!base) base = "file";

  let candidate = `${base}${ext}`;
  let i = 1;
  while (existingNames?.has(candidate)) {
    candidate = `${base}-${i}${ext}`;
    i += 1;
  }
  return candidate;
}
