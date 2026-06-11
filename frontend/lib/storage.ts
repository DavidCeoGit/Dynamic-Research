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
import {
  scopedStoragePath,
  scopedStagingPath,
  scopedSourcesPath,
} from "./storage-paths";
import {
  ATTACHMENT_SOURCES_SUBDIR,
  ATTACHMENT_MAX_FILE_BYTES,
} from "./attachments-constants";
import { buildCopyPlan, stripOrigin } from "./attachments-copy";
import { isStateFileName, selectNewestStateFile } from "./find-state-file";
import type {
  AttachmentMeta,
  AttachmentPayloadItem,
} from "./types/queue";

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

// ── Phase 2 file-upload: staging + submit-time verify/copy ───────────

/** Build a Map<storedName, sizeBytes> from a Supabase Storage list result. */
function sizeMapFromList(
  data: Array<{ name: string; metadata: { size?: number } | null }> | null,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const item of data ?? []) {
    if (item.metadata !== null) m.set(item.name, item.metadata?.size ?? 0);
  }
  return m;
}

/**
 * Best-effort bulk remove of storage objects. Codex MERGE-gate MINOR — the
 * Supabase Storage SDK's remove() RESOLVES `{ data, error }` on a storage-layer
 * failure rather than REJECTING, so a bare `.remove(paths).catch(...)` swallows
 * the common failure mode silently and leaves orphans with no signal. This
 * helper inspects BOTH the returned `error` AND a thrown exception, logging
 * either, while never throwing — cleanup must stay non-blocking. `context`
 * names the call site so an orphan can be traced from the log line.
 */
async function bestEffortRemove(
  supabase: ReturnType<typeof getSupabase>,
  paths: string[],
  context: string,
): Promise<void> {
  if (paths.length === 0) return;
  try {
    const { error } = await supabase.storage.from(BUCKET).remove(paths);
    if (error) {
      console.warn(
        `[storage] ${context}: remove failed (non-blocking, orphans left): ${error.message}`,
      );
    }
  } catch (ex) {
    console.warn(
      `[storage] ${context}: remove threw (non-blocking, orphans left): ${(ex as Error).message}`,
    );
  }
}

/**
 * Best-effort append to public.audit_storage_writes. Mirrors the agent-side
 * uploadWithAudit() contract: a failure is logged but NEVER blocks the caller —
 * the audit log must not be a single point of failure for legitimate writes.
 * research_queue_id is null for attachment writes because the copy happens
 * BEFORE the queue row is inserted (submit) or the row id isn't threaded here.
 */
export async function auditStorageWrite(opts: {
  caller: string;
  organizationId: string;
  researchQueueId: string | null;
  objectPath: string;
  bytes: number | null;
  httpStatus: number;
}): Promise<void> {
  try {
    const supabase = getSupabase();
    const { error } = await supabase.from("audit_storage_writes").insert({
      caller: opts.caller,
      organization_id: opts.organizationId,
      research_queue_id: opts.researchQueueId,
      object_path: opts.objectPath,
      bytes: opts.bytes,
      http_status: opts.httpStatus,
    });
    if (error) {
      console.warn(
        `[storage] audit_storage_writes insert failed (non-blocking): ${error.message}`,
      );
    }
  } catch (ex) {
    console.warn(
      `[storage] audit_storage_writes threw (non-blocking): ${(ex as Error).message}`,
    );
  }
}

/**
 * Mint a signed upload URL for a staged attachment at
 * <orgId>/uploads/<draftId>/<storedName>. The client PUTs the file bytes
 * directly to Supabase Storage with this URL (bypassing the Vercel ~4.5MB
 * route body cap). The path is locked to the caller's org + draftId by the
 * path helper; the route is session-required.
 *
 * NON-UPSERT (load-bearing — interim grounded-review #2): minted WITHOUT
 * `{ upsert: true }`, so the signed-upload URL is single-use — a second PUT to
 * an existing object 409s. This is the PRIMARY guarantee that staged bytes
 * can't be re-PUT to a larger size mid-flight; verifyAndCopyAttachments' post-
 * copy size check is the secondary backstop. Do NOT add `{ upsert: true }` here
 * to paper over a re-upload UX papercut without re-evaluating that TOCTOU.
 */
export async function createStagingUploadUrl(
  orgId: string,
  draftId: string,
  storedName: string,
): Promise<{ path: string; token: string; signedUrl: string }> {
  const supabase = getSupabase();
  const objectPath = scopedStagingPath(orgId, draftId, storedName);
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUploadUrl(objectPath);
  if (error || !data) {
    throw new Error(
      `createStagingUploadUrl(${objectPath}) failed: ${error?.message ?? "no data"}`,
    );
  }
  return { path: objectPath, token: data.token, signedUrl: data.signedUrl };
}

/** List the currently-staged objects for a draft (uncached — staging mutates). */
export async function listStagingFiles(
  orgId: string,
  draftId: string,
): Promise<StorageFileEntry[]> {
  const supabase = getSupabase();
  const prefix = scopedStagingPath(orgId, draftId);
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(prefix, { limit: 500 });
  if (error) {
    throw new Error(`listStagingFiles(${prefix}) failed: ${error.message}`);
  }
  return (data ?? [])
    .filter((item) => item.metadata !== null)
    .map((item) => ({
      name: item.name,
      size: item.metadata?.size ?? 0,
      created_at: item.created_at ?? "",
    }));
}

/** Remove a single staged object (DELETE on the mint route). */
export async function removeStagedFile(
  orgId: string,
  draftId: string,
  storedName: string,
): Promise<void> {
  const supabase = getSupabase();
  const objectPath = scopedStagingPath(orgId, draftId, storedName);
  const { error } = await supabase.storage.from(BUCKET).remove([objectPath]);
  if (error) {
    throw new Error(`removeStagedFile(${objectPath}) failed: ${error.message}`);
  }
}

/**
 * Best-effort bulk removal of a draft's CONSUMED staging objects after a submit
 * has copied them into the run's sources/ and the queue row inserted. Codex
 * MERGE-gate MAJOR — the prior code copied staging→sources but never deleted the
 * staging originals, so every successful submit left a duplicate set under
 * <orgId>/uploads/<draftId>/ that nothing reclaimed until the (Phase-3) TTL
 * sweep. Deleting them on the success path bounds the common case immediately;
 * the 24h sweep remains the backstop for ABANDONED drafts (never submitted).
 * Never throws — a failed cleanup must not fail an already-successful submit.
 */
export async function removeStagedFiles(
  orgId: string,
  draftId: string,
  storedNames: string[],
): Promise<void> {
  if (storedNames.length === 0) return;
  const supabase = getSupabase();
  const paths = storedNames.map((n) => scopedStagingPath(orgId, draftId, n));
  await bestEffortRemove(supabase, paths, `removeStagedFiles(${orgId}/${draftId})`);
}

export interface VerifyAndCopyResult {
  ok: boolean;
  /** HTTP status the route should return on failure. */
  status?: number;
  error?: string;
  /** Origin-stripped AttachmentMeta to persist on the row (success only). */
  verified?: AttachmentMeta[];
}

/**
 * Verify every payload attachment exists at its claimed origin with the exact
 * claimed size, then copy each into the new run's <orgId>/<slug>/sources/.
 * Shared by POST /api/queue (submit) and the replay route (§3b parent carry).
 *
 * Contract:
 *  - Verifies ALL before copying ANY (no half-applied state on a bad claim).
 *  - On any copy failure: best-effort removes the files copied so far in THIS
 *    call, returns 500, and the caller inserts NO row — staging/parent bytes
 *    stay intact, so a resubmit (which mints a fresh slug) is safe.
 *  - Returns origin-stripped AttachmentMeta for the DB insert.
 */
export async function verifyAndCopyAttachments(opts: {
  orgId: string;
  newSlug: string;
  draftId?: string | null;
  parentSlug?: string | null;
  items: AttachmentPayloadItem[];
  caller: string;
}): Promise<VerifyAndCopyResult> {
  const { orgId, newSlug, draftId, parentSlug, items, caller } = opts;
  if (items.length === 0) return { ok: true, verified: [] };

  const supabase = getSupabase();

  let plan;
  try {
    plan = buildCopyPlan({ orgId, newSlug, draftId, parentSlug, items });
  } catch (e) {
    return { ok: false, status: 400, error: (e as Error).message };
  }

  const needStaging = plan.some((p) => p.origin === "staging");
  const needParent = plan.some((p) => p.origin === "parent");

  let stagingSizes: Map<string, number> | null = null;
  let parentSizes: Map<string, number> | null = null;

  if (needStaging) {
    if (!draftId) {
      return { ok: false, status: 400, error: "attachmentsDraftId required for staged attachments" };
    }
    const prefix = scopedStagingPath(orgId, draftId);
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 500 });
    if (error) {
      return { ok: false, status: 500, error: `staging list failed: ${error.message}` };
    }
    stagingSizes = sizeMapFromList(data);
  }
  if (needParent) {
    if (!parentSlug) {
      return { ok: false, status: 400, error: "parentSlug required for parent attachments" };
    }
    const prefix = `${scopedStoragePath(orgId, parentSlug)}/${ATTACHMENT_SOURCES_SUBDIR}`;
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 500 });
    if (error) {
      return { ok: false, status: 500, error: `parent sources list failed: ${error.message}` };
    }
    parentSizes = sizeMapFromList(data);
  }

  // Verify existence + exact size for EVERY entry before any copy.
  for (const p of plan) {
    const sizes = p.origin === "staging" ? stagingSizes! : parentSizes!;
    const actual = sizes.get(p.storedName);
    if (actual === undefined) {
      return {
        ok: false,
        status: 400,
        error: `attachment "${p.storedName}" not found in ${p.origin} storage`,
      };
    }
    if (actual !== p.sizeBytes) {
      return {
        ok: false,
        status: 400,
        error: `attachment "${p.storedName}" size mismatch (claimed ${p.sizeBytes}, actual ${actual})`,
      };
    }
  }

  // All verified — copy into the new run's sources/.
  const copied: string[] = [];
  for (const p of plan) {
    const { error } = await supabase.storage.from(BUCKET).copy(p.fromPath, p.toPath);
    if (error) {
      // Roll back what we copied in THIS call (best-effort) so a failed submit
      // doesn't leave half a source set orphaned under the new slug.
      await bestEffortRemove(supabase, copied, `partial-copy rollback (${newSlug}/sources/)`);
      return { ok: false, status: 500, error: `copy "${p.storedName}" failed: ${error.message}` };
    }
    copied.push(p.toPath);
    await auditStorageWrite({
      caller,
      organizationId: orgId,
      researchQueueId: null,
      objectPath: p.toPath,
      bytes: p.sizeBytes,
      httpStatus: 200,
    });
  }

  // Post-copy size verification (Gemini MERGE-gate BLOCKING #1 — close the
  // TOCTOU window). The pre-copy list and the copy() are not atomic: a staged
  // object's signed-upload URL is valid for ~2h, so the bytes could be re-PUT
  // to a LARGER size between our size check and the copy, smuggling an
  // over-cap file into sources/. Re-list the destination and confirm every
  // copied object's ACTUAL size matches the claimed size and the per-file cap;
  // on any mismatch, remove all copies and fail closed.
  const destPrefix = `${scopedStoragePath(orgId, newSlug)}/${ATTACHMENT_SOURCES_SUBDIR}`;
  const { data: destList, error: destErr } = await supabase.storage
    .from(BUCKET)
    .list(destPrefix, { limit: 500 });
  if (destErr) {
    await bestEffortRemove(supabase, copied, `post-copy verify-list cleanup (${newSlug}/sources/)`);
    return { ok: false, status: 500, error: `post-copy verify list failed: ${destErr.message}` };
  }
  const destSizes = sizeMapFromList(destList);
  for (const p of plan) {
    const actual = destSizes.get(p.storedName);
    if (actual === undefined || actual !== p.sizeBytes || actual > ATTACHMENT_MAX_FILE_BYTES) {
      await bestEffortRemove(supabase, copied, `post-copy size-mismatch cleanup (${newSlug}/sources/)`);
      return {
        ok: false,
        status: 400,
        error: `post-copy size check failed for "${p.storedName}" (claimed ${p.sizeBytes}, copied ${actual ?? "missing"})`,
      };
    }
  }

  return { ok: true, verified: stripOrigin(items) };
}

/**
 * Best-effort removal of a run's copied source objects, by storedName. Used by
 * the submit + replay routes to clean up after a copy SUCCEEDED but the
 * subsequent research_queue insert FAILED (Gemini MERGE-gate MAJOR #3) — the
 * freshly-generated slug is never reused, so without this the copied files are
 * orphaned permanently (sources/ has no TTL sweep). Never throws.
 */
export async function removeRunSources(
  orgId: string,
  slug: string,
  storedNames: string[],
): Promise<void> {
  if (storedNames.length === 0) return;
  // Codex MERGE-gate MINOR — route the remove through bestEffortRemove so a
  // resolved `{ error }` (the SDK's normal storage-failure shape) is logged,
  // not just a thrown exception. Still never throws.
  const supabase = getSupabase();
  const paths = storedNames.map((n) => scopedSourcesPath(orgId, slug, n));
  await bestEffortRemove(supabase, paths, `removeRunSources(${orgId}/${slug})`);
}
