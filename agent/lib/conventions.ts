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

interface Conventions {
  _version: number;
  _last_updated: string;
  slugify: SlugifyConfig;
  filename_patterns: FilenamePatterns;
  skip_files: SkipFiles;
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
