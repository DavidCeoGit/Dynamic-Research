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
 * Windows reserved device basenames. Windows treats `con.pdf`, `con.tar.gz`,
 * etc. as the CON device — the reservation keys on the segment BEFORE THE
 * FIRST dot, regardless of extension, and a write to such a name fails at the
 * OS layer. The worker downloads attachments to `<workdir>/sources/<storedName>`
 * on a WINDOWS host (Phase 3), so a reserved storedName would break that run
 * (Codex S103 grounded-adversarial MAJOR-2). MIRROR of conventions.json
 * attachments.reserved_basenames — pair-edit both.
 */
export const ATTACHMENT_RESERVED_BASENAMES: ReadonlySet<string> = new Set([
  "con", "prn", "aux", "nul",
  "com0", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt0", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** True if storedName's first dot-segment is a Windows reserved device name. */
export function isReservedBasename(storedName: string): boolean {
  return ATTACHMENT_RESERVED_BASENAMES.has(storedName.toLowerCase().split(".")[0]);
}

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
 * - Windows reserved device basenames (con, nul, com1…) are remapped to
 *   "file-<base>" so a legit upload literally named "con.pdf" still works
 *   (renamed) rather than failing the OS write on the Windows worker
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
  // Remap Windows reserved device names (keyed on the first dot-segment) so
  // the OS write on the Phase-3 worker never hits CON/NUL/COM1/etc.
  if (ATTACHMENT_RESERVED_BASENAMES.has(base.split(".")[0])) base = `file-${base}`;

  let candidate = `${base}${ext}`;
  let i = 1;
  while (existingNames?.has(candidate)) {
    candidate = `${base}-${i}${ext}`;
    i += 1;
  }
  return candidate;
}
