/**
 * Media serving endpoint via Supabase Storage signed URLs.
 *
 * GET /api/runs/[slug]/file/[filename]
 *
 * - Media files (mp3, mp4, pdf, pptx, png, docx): 302 redirect to signed URL
 * - Text files (md, json): downloaded and served inline
 * - Supabase CDN handles Range requests natively after redirect
 */

import { getSignedUrl, projectExists } from "@/lib/storage";
import { CONTENT_TYPE_MAP, isTextFile } from "@/lib/files";
import { getSupabase } from "@/lib/supabase";

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
      { status: 400 },
    );
  }

  // ── Verify project exists ──────────────────────────────────
  const exists = await projectExists(slug);
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
        .download(`${slug}/${filename}`);

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
    const signedUrl = await getSignedUrl(slug, filename, 3600);

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
