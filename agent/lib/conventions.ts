/**
 * Dynamic Research conventions — TypeScript wrapper.
 *
 * Canonical data lives in agent/lib/conventions.json. This module loads
 * it at runtime, narrows types, and exposes idiomatic helpers. Don't
 * duplicate values here — change conventions.json, the wrapper picks up.
 *
 * Usage:
 *   import { slugify, studioFilename, isSkipFile, RESEARCH_ROLES } from "../lib/conventions.js";
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ── Load canonical data ─────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONVENTIONS_PATH = path.join(__dirname, "conventions.json");

interface SlugifyConfig {
  max_length: number;
  strip_pattern_js: string;
  fallback: string;
}

interface ProductDef {
  ext: string;
  list_method: string;
  download_method: string;
}

interface FilenamePatterns {
  studio: { pattern: string; regex: string; products: Record<string, ProductDef> };
  research: { pattern: string; regex: string; roles: string[] };
  research_docx_companion: { pattern: string; regex: string; roles: string[] };
}

interface SkipFiles {
  exact: string[];
  prefixes: string[];
  extensions?: string[];
}

/**
 * v3 (S102) user file-upload feature. Caps + path-segment names for
 * user-attached source files. Pair-edited frontend mirror:
 * frontend/lib/attachments-constants.ts.
 */
interface AttachmentsConfig {
  allowed_extensions: string[];
  allowed_mime_types: string[];
  /** Pattern every storedName must match; compiled by storage-paths.ts. */
  stored_name_regex: string;
  max_file_bytes: number;
  max_total_bytes: number;
  max_files: number;
  staging_prefix: string;
  sources_subdir: string;
  staging_ttl_hours: number;
  max_pages_read_per_pdf: number;
  max_digest_words_per_file: number;
}

interface Conventions {
  _version: number;
  _last_updated: string;
  slugify: SlugifyConfig;
  filename_patterns: FilenamePatterns;
  skip_files: SkipFiles;
  attachments: AttachmentsConfig;
  supabase_storage: { bucket: string };
}

const raw = fs.readFileSync(CONVENTIONS_PATH, "utf-8");
const data = JSON.parse(raw) as Conventions;

// ── Public API ──────────────────────────────────────────────────────

export const VERSION = data._version;
export const LAST_UPDATED = data._last_updated;
export const BUCKET = data.supabase_storage.bucket;

export const SKIP_FILES = new Set(data.skip_files.exact);
export const SKIP_PREFIXES = data.skip_files.prefixes;
export const SKIP_EXTENSIONS = data.skip_files.extensions ?? [];

/**
 * S102 file-upload caps + path segments. Consumed by agent/lib/storage-paths.ts
 * (staging/sources path helpers), the executor's attachment download, and the
 * staging TTL sweep. conventions.json is the canonical source; the frontend
 * duplicates these values in frontend/lib/attachments-constants.ts (pair-edit).
 */
export const ATTACHMENTS = data.attachments;

export const RESEARCH_ROLES = new Set(data.filename_patterns.research.roles);
export const RESEARCH_DOCX_ROLES = new Set(data.filename_patterns.research_docx_companion.roles);
export const STUDIO_PRODUCTS = data.filename_patterns.studio.products;

export const STUDIO_FILENAME_REGEX = new RegExp(data.filename_patterns.studio.regex);
export const RESEARCH_FILENAME_REGEX = new RegExp(data.filename_patterns.research.regex);
export const RESEARCH_DOCX_FILENAME_REGEX = new RegExp(data.filename_patterns.research_docx_companion.regex);

/** Canyon Lake S12 slugify: strip special, spaces->hyphens, lowercase, max length. */
export function slugify(title: string | null | undefined): string {
  if (!title) return data.slugify.fallback;
  const stripPattern = new RegExp(data.slugify.strip_pattern_js, "g");
  let s = title.replace(stripPattern, "");
  s = s.trim().replace(/\s+/g, "-");
  s = s.replace(/-+/g, "-").toLowerCase();
  s = s.slice(0, data.slugify.max_length).replace(/-+$/, "");
  return s || data.slugify.fallback;
}

/** Build a Studio product filename: {title-slug}-{TIMESTAMP}-{product}.{ext} */
export function studioFilename(title: string, timestamp: string, product: string): string {
  const def = STUDIO_PRODUCTS[product];
  if (!def) throw new Error(`unknown studio product: ${product}`);
  return `${slugify(title)}-${timestamp}-${product}.${def.ext}`;
}

/** Build a research file filename: {topic-prefix}-{role}.{ext} */
export function researchFilename(topicPrefix: string, role: string, ext: string): string {
  if (!RESEARCH_ROLES.has(role) && !RESEARCH_DOCX_ROLES.has(role)) {
    throw new Error(`unknown research role: ${role}`);
  }
  return `${slugify(topicPrefix)}-${role}.${ext}`;
}

/** True if a filename should be skipped from any uploads/listings. */
export function isSkipFile(filename: string): boolean {
  if (SKIP_FILES.has(filename)) return true;
  for (const p of SKIP_PREFIXES) {
    if (filename.startsWith(p)) return true;
  }
  for (const ext of SKIP_EXTENSIONS) {
    if (filename.endsWith(ext)) return true;
  }
  return false;
}

/** Classify a filename into one of: studio | research | research-docx | skip | unknown. */
export type FileClass = "studio" | "research" | "research-docx" | "skip" | "unknown";

export function classifyFile(filename: string): FileClass {
  if (isSkipFile(filename)) return "skip";
  if (STUDIO_FILENAME_REGEX.test(filename)) return "studio";
  if (RESEARCH_FILENAME_REGEX.test(filename)) return "research";
  if (RESEARCH_DOCX_FILENAME_REGEX.test(filename)) return "research-docx";
  return "unknown";
}

/** Parse a Studio filename into its components, or null if not Studio-shaped. */
export function parseStudioFilename(
  filename: string,
): { titleSlug: string; timestamp: string; product: string; ext: string } | null {
  const m = filename.match(STUDIO_FILENAME_REGEX);
  if (!m) return null;
  return { titleSlug: m[1], timestamp: m[2], product: m[3], ext: m[4] };
}

/** Parse a research filename into its components, or null if not research-shaped. */
export function parseResearchFilename(
  filename: string,
): { topicPrefix: string; role: string; ext: string } | null {
  const m = filename.match(RESEARCH_FILENAME_REGEX);
  if (!m) return null;
  return { topicPrefix: m[1], role: m[2], ext: m[3] };
}

// ── Content-type map (Supabase Storage uploads) ─────────────────────

/**
 * File extension → MIME content-type for Supabase Storage uploads.
 * Consolidated from agent/executor.ts + agent/scripts/finalize-recovered-run.ts
 * (S34 conciseness #1). TS-only — Python pipeline doesn't upload. If a Python
 * upload path is added later, mirror this into conventions.json + conventions.py.
 */
export const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** Look up MIME content-type for a filename; falls back to application/octet-stream. */
export function getContentType(filename: string): string {
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}
