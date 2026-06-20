/**
 * Media serving endpoint via Supabase Storage signed URLs.
 *
 * GET /api/runs/[slug]/file/[filename]
 *
 * - Media files (mp3, mp4, pdf, pptx, png, docx): 302 redirect to signed URL
 * - Text files (md, json): downloaded and served inline
 * - Supabase CDN handles Range requests natively after redirect
 * - `?download=1` forces a download (Content-Disposition: attachment on the
 *   signed URL) for media — a cross-origin `<a download>` is otherwise ignored
 *   and media opens inline (S132 Bug-1). Inline viewers omit the param.
 *
 * S146 Phase 4 — org resolved from the SESSION via requireOrgOr401() (the
 * Phase-2 env fallback is retired); unauthenticated → 401. Cross-tenant
 * isolation is the storage path prefix <orgId>/<slug>/<filename> in
 * scopedStoragePath + projectExists + getSignedUrl — a user with org-A's session
 * can never resolve a path under org-B/. No research_queue DB check (Gemini F1).
 */

import { getSignedUrl, projectExists } from "@/lib/storage";
import { scopedStoragePath } from "@/lib/storage-paths";
import { CONTENT_TYPE_MAP, isTextFile } from "@/lib/files";
import { getSupabase } from "@/lib/supabase";
import { requireOrgOr401 } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; filename: string }> },
) {
  const { slug, filename } = await params;
  const wantsDownload =
    new URL(request.url).searchParams.get("download") === "1";

  // ── Validate filename (no path traversal) ──────────────────
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    return Response.json({ error: "Invalid filename" }, { status: 400 });
  }

  const auth = await requireOrgOr401();
  if (!auth.ok) return auth.res;
  const { orgId } = auth;

  // ── Verify project exists ──────────────────────────────────
  const exists = await projectExists(orgId, slug);
  if (!exists) {
    return Response.json(
      { error: `Project not found: ${slug}` },
      { status: 404 },
    );
  }

  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const contentType = CONTENT_TYPE_MAP[ext] ?? "application/octet-stream";

  // ── Text files: serve inline ───────────────────────────────
  if (isTextFile(filename)) {
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase.storage
        .from("research-projects")
        .download(scopedStoragePath(orgId, slug, filename));

      if (error) {
        return Response.json(
          { error: `File not found: ${filename}` },
          { status: 404 },
        );
      }

      const content = await data.text();
      return new Response(content, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=60",
        },
      });
    } catch (err) {
      return Response.json(
        { error: "Failed to download file", detail: String(err) },
        { status: 500 },
      );
    }
  }

  // ── Media files: redirect to signed URL ────────────────────
  try {
    const signedUrl = await getSignedUrl(
      orgId,
      slug,
      filename,
      3600,
      wantsDownload ? filename : undefined,
    );

    return new Response(null, {
      status: 302,
      headers: {
        Location: signedUrl,
        "Cache-Control": "private, max-age=3500",
      },
    });
  } catch (err) {
    return Response.json(
      { error: "Failed to generate signed URL", detail: String(err) },
      { status: 500 },
    );
  }
}
