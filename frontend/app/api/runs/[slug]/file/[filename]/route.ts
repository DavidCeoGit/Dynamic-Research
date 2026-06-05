/**
 * Media serving endpoint via Supabase Storage signed URLs.
 *
 * GET /api/runs/[slug]/file/[filename]
 *
 * - Media files (mp3, mp4, pdf, pptx, png, docx): 302 redirect to signed URL
 * - Text files (md, json): downloaded and served inline
 * - Supabase CDN handles Range requests natively after redirect
 *
 * S56 Phase 2 — replaces resolveOrgForSlug stopgap with session-or-env
 * orgId from getOrgContextDualPath(). Cross-tenant isolation is the storage
 * path prefix <orgId>/<slug>/<filename> in scopedStoragePath +
 * projectExists + getSignedUrl — a user with org-A's session/env can never
 * resolve a path under org-B/. No research_queue DB check (Gemini F1, S56).
 * Early-400 path-traversal response carries X-Org-Source:none for
 * telemetry completeness (Gemini F3, S56).
 */

import { getSignedUrl, projectExists } from "@/lib/storage";
import { scopedStoragePath } from "@/lib/storage-paths";
import { CONTENT_TYPE_MAP, isTextFile } from "@/lib/files";
import { getSupabase } from "@/lib/supabase";
import { getOrgContextDualPath } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; filename: string }> },
) {
  const { slug, filename } = await params;

  // ── Validate filename (no path traversal) ──────────────────
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    return Response.json(
      { error: "Invalid filename" },
      { status: 400, headers: { "X-Org-Source": "none" } },
    );
  }

  const { orgId, source } = await getOrgContextDualPath();
  const orgHeaders = { "X-Org-Source": source };

  // ── Verify project exists ──────────────────────────────────
  const exists = await projectExists(orgId, slug);
  if (!exists) {
    return Response.json(
      { error: `Project not found: ${slug}` },
      { status: 404, headers: orgHeaders },
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
          { status: 404, headers: orgHeaders },
        );
      }

      const content = await data.text();
      return new Response(content, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=60",
          "X-Org-Source": source,
        },
      });
    } catch (err) {
      return Response.json(
        { error: "Failed to download file", detail: String(err) },
        { status: 500, headers: orgHeaders },
      );
    }
  }

  // ── Media files: redirect to signed URL ────────────────────
  try {
    const signedUrl = await getSignedUrl(orgId, slug, filename, 3600);

    return new Response(null, {
      status: 302,
      headers: {
        Location: signedUrl,
        "Cache-Control": "private, max-age=3500",
        "X-Org-Source": source,
      },
    });
  } catch (err) {
    return Response.json(
      { error: "Failed to generate signed URL", detail: String(err) },
      { status: 500, headers: orgHeaders },
    );
  }
}
