/**
 * Supabase Storage abstraction layer.
 *
 * Replaces all filesystem I/O from lib/files.ts with Supabase Storage
 * SDK calls. All API routes call these functions instead of fsp.*.
 *
 * Includes a 10-second in-memory cache to absorb SWR 5s polling bursts.
 *
 * Phase B / S50 — every function takes an `orgId` parameter and constructs
 * tenant-scoped paths via scopedStoragePath() from ./storage-paths. The route
 * callers under frontend/app/api/runs/* either resolve org_id from the slug
 * via resolveOrgForSlug() (slug-bearing routes) or from
 * process.env.SYSTEM_DEFAULT_ORG_ID (the global gallery list). Both are
 * stopgaps until the SSR auth refactor (next Phase B sub-phase) lands and
 * the routes get org_id from the authenticated session cookie.
 */

import { getSupabase } from "./supabase";
import { scopedStoragePath } from "./storage-paths";
import { isStateFileName, selectNewestStateFile } from "./find-state-file";

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

// ── Org resolution stopgap ───────────────────────────────────────

/**
 * Resolve the organization_id that owns a given project slug.
 *
 * Phase B / S50 stopgap. The SSR auth refactor (next sub-phase) will derive
 * org_id from the authenticated session cookie and this helper goes away.
 *
 * Limitation: after Phase A multi-tenancy, slug uniqueness is org-scoped,
 * not global. With one org in production today the lookup is unambiguous.
 * Once a second org provisions and any slug happens to collide across orgs,
 * this stopgap returns null + logs a high-priority warning rather than
 * throwing — the route handler then returns 404 to the client (matching the
 * "not found" behavior; closes the information-disclosure scope dispute
 * from S50 Gemini MERGE review). The console.warn is the operator signal to
 * land the SSR refactor before more orgs onboard.
 */
export async function resolveOrgForSlug(slug: string): Promise<string | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("research_queue")
    .select("organization_id")
    .eq("topic_slug", slug);

  if (error) {
    throw new Error(`resolveOrgForSlug(${slug}) failed: ${error.message}`);
  }
  if (!data || data.length === 0) return null;

  const orgs = new Set(
    (data as Array<{ organization_id: string }>).map((r) => r.organization_id),
  );
  if (orgs.size > 1) {
    console.warn(
      `[storage] resolveOrgForSlug(${slug}) ambiguous: slug exists in ${orgs.size} orgs. ` +
        `Returning 404. Phase B SSR auth refactor must land before serving this request.`,
    );
    return null;
  }
  return data[0].organization_id ?? null;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * List all project slugs for an organization (top-level folders under <orgId>/).
 *
 * Phase B / S50 — was listProjects(); the SSR-less stopgap calls this with
 * process.env.SYSTEM_DEFAULT_ORG_ID. The SSR refactor will pass the
 * session-resolved org_id.
 */
export async function listProjects(orgId: string): Promise<string[]> {
  const cacheKey = `projects:${orgId}`;
  const cached = getCached<string[]>(cacheKey);
  if (cached) return cached;

  const supabase = getSupabase();
  // scopedStoragePath(orgId, "") would throw on empty slug; use a bare orgId
  // prefix instead for the org-level list. We still validate orgId by
  // re-using the same regex via a trivial scopedStoragePath call below the
  // surface — done here inline to avoid breaking the helper's invariant.
  // Strict canonical UUID v4 (mirrored from scopedStoragePath helper). M1.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) {
    throw new Error(`listProjects: invalid orgId "${orgId}"`);
  }
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(orgId, {
      limit: 100,
      sortBy: { column: "name", order: "asc" },
    });

  if (error) throw new Error(`listProjects(${orgId}) failed: ${error.message}`);

  // Folders appear as items with null metadata in Supabase Storage
  const slugs = (data ?? [])
    .filter((item) => item.id === null || item.metadata === null)
    .map((item) => item.name);

  setCache(cacheKey, slugs);
  return slugs;
}

/**
 * List all files in a project folder for a given org.
 */
export async function listFiles(
  orgId: string,
  slug: string,
): Promise<StorageFileEntry[]> {
  const cacheKey = `files:${orgId}:${slug}`;
  const cached = getCached<StorageFileEntry[]>(cacheKey);
  if (cached) return cached;

  const supabase = getSupabase();
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(scopedStoragePath(orgId, slug), {
      limit: 500,
      sortBy: { column: "name", order: "asc" },
    });

  if (error) throw new Error(`listFiles(${orgId}, ${slug}) failed: ${error.message}`);

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
  orgId: string,
  slug: string,
): Promise<string | null> {
  const files = await listFiles(orgId, slug);
  // S87: select the NEWEST state file by embedded run timestamp (fallback to
  // storage created_at for plain/slug-named names). Once uploadOutputs pushes a
  // reused workdir's files, a scoped prefix can hold stale "<ts>-state.json"
  // from earlier runs; the prior first-match returned the oldest and would
  // render a completed run as stale/Preflight in the gallery. Mirrors the
  // agent-side rule in agent/lib/find-state-file.ts (Gemini MERGE-gate, S87).
  const best = selectNewestStateFile(
    files
      .filter((f) => isStateFileName(f.name))
      .map((f) => ({ name: f.name, fallbackTimeMs: Date.parse(f.created_at) || 0 })),
  );
  if (!best) {
    // A completed run with no state file is invisible to the gallery — surface
    // it for diagnostics rather than failing silently (S84 Gemini G-MINOR-1).
    console.warn(`findStateFile: no state.json for ${orgId}/${slug}`);
    return null;
  }
  return best.name;
}

/**
 * Download and parse a state.json file.
 */
export async function readStateJson(
  orgId: string,
  slug: string,
  filename: string,
): Promise<Record<string, unknown>> {
  const supabase = getSupabase();
  const objectPath = scopedStoragePath(orgId, slug, filename);
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .download(objectPath);

  if (error) {
    throw new Error(`readStateJson(${objectPath}) failed: ${error.message}`);
  }

  const text = await data.text();
  return JSON.parse(text);
}

/**
 * Generate a signed URL for a file (1hr expiry by default).
 */
export async function getSignedUrl(
  orgId: string,
  slug: string,
  filename: string,
  expiresIn = 3600,
): Promise<string> {
  const supabase = getSupabase();
  const objectPath = scopedStoragePath(orgId, slug, filename);
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(objectPath, expiresIn);

  if (error) {
    throw new Error(`getSignedUrl(${objectPath}) failed: ${error.message}`);
  }

  return data.signedUrl;
}

/**
 * Check if a project exists (has files in the bucket).
 */
export async function projectExists(
  orgId: string,
  slug: string,
): Promise<boolean> {
  const files = await listFiles(orgId, slug);
  return files.length > 0;
}
