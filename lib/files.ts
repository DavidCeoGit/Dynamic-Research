/**
 * File parsing utilities for the /research-compare frontend.
 *
 * Pure functions only — no filesystem I/O. All storage access
 * is handled by lib/storage.ts (Supabase Storage).
 *
 * Parses CLI output filenames, classifies artifacts, and builds
 * a structured inventory from Supabase Storage metadata.
 */

import type { StorageFileEntry } from "./storage";

// ── Types ─────────────────────────────────────────────────────────

export type FileType =
  | "markdown"
  | "audio"
  | "video"
  | "image"
  | "slides"
  | "state"
  | "docx";

export type ProductType =
  | "audio"
  | "video"
  | "slides"
  | "report"
  | "infographic"
  | "brief"
  | "perplexity"
  | "notebooklm"
  | "comparison"
  | "vendor-evaluation";

export interface FileEntry {
  /** Original filename */
  filename: string;
  /** File size in bytes */
  size: number;
  /** Classified file type (for rendering decisions) */
  type: FileType;
  /** CLI product type (for grouping) */
  product: ProductType | null;
  /** Version number (1 if no explicit -vN suffix) */
  version: number;
  /** S35 — optional letter-suffix variant (e.g. "a","b","c","d") for batched
   * A/B/C/D regenerations submitted under the same version. NULL = no variant. */
  variant: string | null;
  /** Whether this is a title-prefixed copy */
  titlePrefixed: boolean;
  /** Extracted title (only for title-prefixed files) */
  title: string | null;
  /** CLI timestamp (YYYYMMDD-HHMMSS) */
  timestamp: string | null;
}

export interface ParsedFilename {
  timestamp: string | null;
  product: string | null;
  version: number;
  /** S35 — see FileEntry.variant. */
  variant: string | null;
  extension: string;
  title: string | null;
  suffix: string | null;
  titlePrefixed: boolean;
}

// ── Extension maps ────────────────────────────────────────────────

const EXT_TO_FILE_TYPE: Record<string, FileType> = {
  md: "markdown",
  mp3: "audio",
  mp4: "video",
  png: "image",
  jpg: "image",
  jpeg: "image",
  pdf: "slides",
  pptx: "slides",
  json: "state",
  docx: "docx",
};

export const CONTENT_TYPE_MAP: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  json: "application/json",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** Known CLI product names that appear after the timestamp. */
const KNOWN_PRODUCTS = new Set([
  "audio",
  "video",
  "slides",
  "report",
  "infographic",
  "brief",
  "perplexity",
  "notebooklm",
  "comparison",
  "vendor-evaluation",
  "state",
]);

// ── Filename parsing ──────────────────────────────────────────────

// Timestamp pattern: YYYYMMDD-HHMMSS
const TS = String.raw`(\d{8}-\d{6})`;

// Raw pattern: TIMESTAMP-product(-vN<variant>?)?(.ext)
// Examples:
//   20260414-062922-audio-v3.mp3
//   20260414-062922-brief.md
//   20260414-062922-vendor-evaluation.md
//   20260414-062922-slides-v2 (2).pdf  (Windows copy artifact)
//   20260511-153442-video-v5a.mp4      (S35 — A/B/C/D variants of same version)
const RAW_RE = new RegExp(
  `^${TS}-([-\\w]+?)(?:-v(\\d+)([a-z])?)?(?:\\s*\\(\\d+\\))?\\.([\\w]+)$`,
);

// Title-prefixed pattern: Title-Slug-TIMESTAMP-product(-vN<variant>?)?(-suffix)?(.ext)
// Examples:
//   Safe-plumbing-for-heavy-upstairs-bathtubs-20260414-062922-audio-v3.mp3
//   Canyon-Lake-Plumber-Evaluation-20260414-062922-report-v3.md
//   Hire-a-Plumber-Canyon-Lake-20260414-062922-video-v3-explainer-retry.mp4
//   the-capital-preservation-imperative-20260511-153442-video-v5a.mp4 (S35)
const TITLE_RE = new RegExp(
  `^(.+?)-${TS}-([-\\w]+?)(?:-v(\\d+)([a-z])?)?(?:-([-\\w]+))?\\.([\\w]+)$`,
);

/**
 * Parse a CLI output filename into its structured components.
 *
 * Handles both raw (timestamp-first) and title-prefixed formats,
 * plus Windows copy artifacts like "slides-v2 (2).pdf".
 */
export function parseFilename(filename: string): ParsedFilename {
  // Try raw pattern first (more common, more specific)
  const rawMatch = filename.match(RAW_RE);
  if (rawMatch) {
    const [, timestamp, productRaw, versionDigits, variantLetter, ext] = rawMatch;
    const product = resolveProduct(productRaw);
    const version = versionDigits ? parseInt(versionDigits, 10) : 1;
    const variant = variantLetter ?? null;

    return {
      timestamp,
      product,
      version,
      variant,
      extension: ext,
      title: null,
      suffix: null,
      titlePrefixed: false,
    };
  }

  // Try title-prefixed pattern
  const titleMatch = filename.match(TITLE_RE);
  if (titleMatch) {
    const [, titleSlug, timestamp, productRaw, versionDigits, variantLetter, suffix, ext] =
      titleMatch;
    const product = resolveProduct(productRaw);
    const version = versionDigits ? parseInt(versionDigits, 10) : 1;
    const variant = variantLetter ?? null;
    const title = titleSlug.replace(/-/g, " ");

    return {
      timestamp,
      product,
      version,
      variant,
      extension: ext,
      title,
      suffix: suffix ?? null,
      titlePrefixed: true,
    };
  }

  // Fallback: unrecognized format — extract extension only
  const dotIdx = filename.lastIndexOf(".");
  const ext = dotIdx > 0 ? filename.slice(dotIdx + 1) : "";

  return {
    timestamp: null,
    product: null,
    version: 1,
    variant: null,
    extension: ext,
    title: null,
    suffix: null,
    titlePrefixed: false,
  };
}

/**
 * Resolve a raw product string to a known ProductType.
 * Handles compound names like "vendor-evaluation".
 */
function resolveProduct(raw: string): string | null {
  if (KNOWN_PRODUCTS.has(raw)) return raw;

  // Check if it starts with a known product (e.g., "video" from "video-v3")
  for (const p of KNOWN_PRODUCTS) {
    if (raw === p || raw.startsWith(p + "-")) return p;
  }

  return raw;
}

function classifyFileType(ext: string): FileType {
  return EXT_TO_FILE_TYPE[ext.toLowerCase()] ?? "markdown";
}

// ── File inventory from Supabase Storage ─────────────────────────

/** Text file extensions that should be served inline (not redirected). */
const TEXT_EXTENSIONS = new Set(["md", "json"]);

export function isTextFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * Build a structured file inventory from Supabase Storage list() results.
 *
 * Replaces the old buildFileInventory() that read from the filesystem.
 * Same output shape — API response contracts are unchanged.
 */
export function buildFileInventoryFromStorage(
  files: StorageFileEntry[],
): FileEntry[] {
  const inventory: FileEntry[] = [];

  for (const file of files) {
    const parsed = parseFilename(file.name);
    const fileType = classifyFileType(parsed.extension);

    inventory.push({
      filename: file.name,
      size: file.size,
      type: fileType,
      product: (parsed.product as ProductType) ?? null,
      version: parsed.version,
      variant: parsed.variant,
      titlePrefixed: parsed.titlePrefixed,
      title: parsed.title,
      timestamp: parsed.timestamp,
    });
  }

  // Sort: by product asc → version desc → variant desc (newest-first within version)
  // S35: variants like v5a/v5b/v5c/v5d are tied at version=5; we tiebreak by variant
  // letter descending so the LATEST experimental variant surfaces as default.
  inventory.sort((a, b) => {
    const pa = a.product ?? "";
    const pb = b.product ?? "";
    if (pa !== pb) return pa.localeCompare(pb);
    if (b.version !== a.version) return b.version - a.version;
    // Both versions equal — sort by variant. NULL (no variant) sorts AFTER lettered
    // variants so v5a/v5b/v5c precede v5 (the base). This keeps user-facing newest
    // at the top of the dropdown when variants exist.
    const va = a.variant ?? "";
    const vb = b.variant ?? "";
    return vb.localeCompare(va);
  });

  return inventory;
}
