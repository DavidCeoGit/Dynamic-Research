/**
 * POST /api/queue/attachments — mint a signed upload URL for a staged file.
 * DELETE /api/queue/attachments — remove a staged file.
 *
 * Phase 2 file-upload. SESSION-REQUIRED (stricter than /api/queue, which has an
 * env-org fallback): a caller must own a real org membership to stage files,
 * because staged bytes are later copied into a run the same caller submits.
 * The route never sees file bytes — the client PUTs them straight to Supabase
 * Storage with the returned signed URL (Vercel ~4.5MB body cap makes
 * multipart-through-route unusable for real PDFs). Caps are enforced in 4
 * layers; this is layers 2 (mint) — the signed PUT itself is uncapped, so the
 * submit route (layer 3) and worker sniff (layer 4) re-check.
 *
 * Accepted gap (for reviewers): the route validates extension + MIME + size but
 * cannot see the bytes, so a client could PUT non-PDF bytes under a .pdf name.
 * Closed by the worker magic-byte sniff in Phase 3.
 */

import { z } from "zod";
import { clientIp, checkRateLimit } from "@/lib/rate-limit";
import { requireOrgContext, UnauthorizedError, ForbiddenError } from "@/lib/auth";
import {
  createStagingUploadUrl,
  listStagingFiles,
  removeStagedFile,
  auditStorageWrite,
} from "@/lib/storage";
import {
  ATTACHMENT_ALLOWED_MIME_TYPES,
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  ATTACHMENT_MAX_FILES,
  ATTACHMENT_EXT_TO_MIME,
  ATTACHMENT_STORED_NAME_REGEX,
  isReservedBasename,
  sanitizeAttachmentName,
} from "@/lib/attachments-constants";

export const dynamic = "force-dynamic";

const mintSchema = z.object({
  draftId: z.string().uuid(),
  originalName: z.string().min(1).max(255),
  sizeBytes: z.number().int().min(1).max(ATTACHMENT_MAX_FILE_BYTES),
  contentType: z.enum(ATTACHMENT_ALLOWED_MIME_TYPES),
  // Codex MERGE-gate BLOCKING — names already attached to this draft in the
  // client form that DON'T live in the server-listed staging area: parent
  // carry-overs from Clone & Edit / Replay. The mint collision-suffix below
  // de-dupes against staged files AND these, so a new upload can't be assigned
  // a storedName that already belongs to a parent attachment (which would later
  // collide at submit-time copy). Bounded + shape-validated; advisory-only (the
  // submit route's buildCopyPlan dup-guard is the authoritative defense), so a
  // missing/spoofed list can never cause a cross-tenant or over-write effect.
  reservedStoredNames: z
    .array(
      z
        .string()
        .min(1)
        .max(160)
        .regex(ATTACHMENT_STORED_NAME_REGEX, "invalid reserved stored filename"),
    )
    .max(ATTACHMENT_MAX_FILES)
    .optional(),
});

// Interim grounded-review #6 — validate storedName SHAPE here (regex + reserved
// basename), mirroring attachmentMetaSchema. This guarantees scopedStagingPath
// (inside removeStagedFile) can't throw on a malformed name, so a thrown error
// from removeStagedFile is purely a storage-layer failure → 500, not 400.
const deleteSchema = z.object({
  draftId: z.string().uuid(),
  storedName: z
    .string()
    .min(1)
    .max(160)
    .regex(ATTACHMENT_STORED_NAME_REGEX, "invalid stored filename")
    .refine((s) => !s.includes(".."), { message: "stored filename must not contain '..'" })
    .refine((s) => !isReservedBasename(s), { message: "stored filename uses a reserved device name" }),
});

/**
 * Resolve the session org, returning a 401 Response if there's no
 * authenticated membership. Generic DB errors propagate as 500 (caught by the
 * caller) — they are NOT auth failures and must not look like one.
 */
async function requireSessionOrg(): Promise<
  { ok: true; orgId: string } | { ok: false; res: Response }
> {
  try {
    const { orgId } = await requireOrgContext();
    return { ok: true, orgId };
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return {
        ok: false,
        res: Response.json(
          { error: "Authentication required to upload attachments" },
          { status: 401 },
        ),
      };
    }
    throw err;
  }
}

export async function POST(request: Request): Promise<Response> {
  const ip = clientIp(request);
  const rl = await checkRateLimit(ip);
  if (!rl.allowed) {
    return Response.json(
      { error: "Rate limit exceeded", detail: `Try again in ${rl.retryAfterSec}s.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  const auth = await requireSessionOrg();
  if (!auth.ok) return auth.res;
  const { orgId } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = mintSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { draftId, originalName, sizeBytes, contentType, reservedStoredNames } =
    parsed.data;

  // List existing staged files: enforce per-draft count + total-size caps
  // server-side (the client pre-check is advisory; the signed PUT is uncapped),
  // and thread their names so the sanitizer's collision suffix is correct.
  let existing;
  try {
    existing = await listStagingFiles(orgId, draftId);
  } catch (e) {
    return Response.json(
      { error: "Failed to read staging area", detail: (e as Error).message },
      { status: 500 },
    );
  }

  if (existing.length >= ATTACHMENT_MAX_FILES) {
    return Response.json(
      { error: `At most ${ATTACHMENT_MAX_FILES} files per request` },
      { status: 400 },
    );
  }
  const existingTotal = existing.reduce((sum, f) => sum + f.size, 0);
  if (existingTotal + sizeBytes > ATTACHMENT_MAX_TOTAL_BYTES) {
    return Response.json(
      { error: "Total attachment size exceeds the limit" },
      { status: 400 },
    );
  }

  // Sanitize → storedName (forces a valid allowlisted extension), then assert
  // the declared contentType matches that extension. Extension is never trusted
  // alone, and MIME alone can't be trusted either — both must agree.
  let storedName: string;
  try {
    storedName = sanitizeAttachmentName(
      originalName,
      // Collision set = server-listed staged files PLUS client-declared parent
      // carry-overs (Codex BLOCKING). Suffixing against both guarantees a fresh
      // upload never lands on a storedName a parent attachment already owns.
      new Set([
        ...existing.map((f) => f.name),
        ...(reservedStoredNames ?? []),
      ]),
    );
  } catch {
    return Response.json(
      { error: "Unsupported file type (allowed: .pdf, .txt, .md)" },
      { status: 400 },
    );
  }
  const ext = storedName.slice(storedName.lastIndexOf("."));
  if (ATTACHMENT_EXT_TO_MIME[ext] !== contentType) {
    return Response.json(
      { error: "contentType does not match the file extension" },
      { status: 400 },
    );
  }

  let mint;
  try {
    mint = await createStagingUploadUrl(orgId, draftId, storedName);
  } catch (e) {
    return Response.json(
      { error: "Failed to create upload URL", detail: (e as Error).message },
      { status: 500 },
    );
  }

  await auditStorageWrite({
    caller: "api/queue/attachments:mint",
    organizationId: orgId,
    researchQueueId: null,
    objectPath: mint.path,
    bytes: sizeBytes,
    httpStatus: 200,
  });

  return Response.json({
    storedName,
    signedUrl: mint.signedUrl,
    token: mint.token,
    path: mint.path,
  });
}

export async function DELETE(request: Request): Promise<Response> {
  const auth = await requireSessionOrg();
  if (!auth.ok) return auth.res;
  const { orgId } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    // storedName shape is already validated by deleteSchema above, so
    // scopedStagingPath (inside removeStagedFile) won't throw on a malformed
    // name. A thrown error here is therefore a storage-layer failure → 500
    // (not 400): a 400 would wrongly tell the client their request was malformed
    // (interim grounded-review #6).
    await removeStagedFile(orgId, parsed.data.draftId, parsed.data.storedName);
  } catch (e) {
    return Response.json(
      { error: "Failed to remove file", detail: (e as Error).message },
      { status: 500 },
    );
  }

  return Response.json({ ok: true });
}
