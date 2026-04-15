/**
 * Supabase Storage abstraction layer.
 *
 * Replaces all filesystem I/O from lib/files.ts with Supabase Storage
 * SDK calls. All API routes call these functions instead of fsp.*.
 *
 * Includes a 10-second in-memory cache to absorb SWR 5s polling bursts.
 */

import { getSupabase } from "./supabase";

const BUCKET = "research-projects";

// ── In-memory cache ──────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const CACHE_TTL_MS = 10_000; // 10 seconds

function getCached<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiry) {
    cache.delete(key);
    return undefined;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, expiry: Date.now() + CACHE_TTL_MS });
}

// ── Storage file metadata ────────────────────────────────────────

export interface StorageFileEntry {
  name: string;
  size: number;
  created_at: string;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * List all project slugs (top-level folders in the bucket).
 */
export async function listProjects(): Promise<string[]> {
  const cacheKey = "projects";
  const cached = getCached<string[]>(cacheKey);
  if (cached) return cached;

  const supabase = getSupabase();
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list("", { limit: 100, sortBy: { column: "name", order: "asc" } });

  if (error) throw new Error(`listProjects failed: ${error.message}`);

  // Folders appear as items with null metadata in Supabase Storage
  const slugs = (data ?? [])
    .filter((item) => item.id === null || item.metadata === null)
    .map((item) => item.name);

  setCache(cacheKey, slugs);
  return slugs;
}

/**
 * List all files in a project folder.
 */
export async function listFiles(slug: string): Promise<StorageFileEntry[]> {
  const cacheKey = `files:${slug}`;
  const cached = getCached<StorageFileEntry[]>(cacheKey);
  if (cached) return cached;

  const supabase = getSupabase();
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(slug, { limit: 500, sortBy: { column: "name", order: "asc" } });

  if (error) throw new Error(`listFiles(${slug}) failed: ${error.message}`);

  const files: StorageFileEntry[] = (data ?? [])
    .filter((item) => item.metadata !== null) // Exclude sub-folders
    .map((item) => ({
      name: item.name,
      size: item.metadata?.size ?? 0,
      created_at: item.created_at ?? "",
    }));

  setCache(cacheKey, files);
  return files;
}

/**
 * Find the state.json file in a project folder.
 * Returns the filename (not full path), or null if not found.
 */
export async function findStateFile(
  slug: string,
): Promise<string | null> {
  const files = await listFiles(slug);
  const stateFile = files.find((f) => f.name.endsWith("-state.json"));
  return stateFile?.name ?? null;
}

/**
 * Download and parse a state.json file.
 */
export async function readStateJson(
  slug: string,
  filename: string,
): Promise<Record<string, unknown>> {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .download(`${slug}/${filename}`);

  if (error) {
    throw new Error(`readStateJson(${slug}/${filename}) failed: ${error.message}`);
  }

  const text = await data.text();
  return JSON.parse(text);
}

/**
 * Generate a signed URL for a file (1hr expiry by default).
 */
export async function getSignedUrl(
  slug: string,
  filename: string,
  expiresIn = 3600,
): Promise<string> {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(`${slug}/${filename}`, expiresIn);

  if (error) {
    throw new Error(`getSignedUrl(${slug}/${filename}) failed: ${error.message}`);
  }

  return data.signedUrl;
}

/**
 * Check if a project exists (has files in the bucket).
 */
export async function projectExists(slug: string): Promise<boolean> {
  const files = await listFiles(slug);
  return files.length > 0;
}
