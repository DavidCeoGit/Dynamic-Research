/**
 * Verify Supabase Storage gallery for a research-run slug matches the truly-
 * newest NLM artifacts in the source notebook. Catches the S31 wrong-artifact-
 * upload bug where `notebooklm download <type>` (without --artifact ID) returned
 * an OLDER artifact than the just-submitted task and got uploaded to the gallery.
 *
 * Usage:
 *   cd agent && node --env-file=.env --import=tsx \
 *     scripts/verify-gallery-vs-notebook.ts \
 *     --notebook <notebook-id> --slug <supabase-slug> [--strict]
 *
 * Exit codes:
 *   0 = all studio types in gallery match newest-of-type in notebook (or absent both sides)
 *   1 = mismatches found (with --strict; warn-only otherwise)
 *   2 = usage / connection error
 *
 * Algorithm:
 * 1. List artifacts per studio type via `notebooklm artifact list -n <id> --type <T> --json`.
 *    Pick the truly-newest (max created_at) of each type.
 * 2. List Supabase Storage files at `<slug>/`. Filter to studio-shaped names; per
 *    product, pick the highest-version winner (no `-vN` = v1; `-v3` = 3, etc.).
 * 3. For each product type:
 *    - If notebook has no artifact and gallery has none: SKIP (nothing to check).
 *    - If notebook has one and gallery has none: MISSING-IN-GALLERY.
 *    - If notebook has none and gallery has one: STALE-IN-GALLERY (no notebook source).
 *    - If both: compare gallery title-slug-prefix to slugify(newest.title). If no match: MISMATCH.
 * 4. Report a per-type table; exit non-zero on errors with --strict.
 *
 * Ships paired with feedback_post_run_artifact_verification.md (S31). Wired into
 * /research-compare slash command Phase 6.5 (post-Studio, pre-completion).
 */

import { spawnSync } from "node:child_process";
import {
  slugify,
  STUDIO_PRODUCTS,
  VERSION,
  LAST_UPDATED,
} from "../lib/conventions.js";

// ── Args ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const strict = argv.includes("--strict");
const notebookId = argFor("--notebook");
const slug = argFor("--slug");

function argFor(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (!notebookId || !slug) {
  console.error(
    "usage: verify-gallery-vs-notebook.ts --notebook <id> --slug <supabase-slug> [--strict]",
  );
  process.exit(2);
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}

// ── NLM CLI type → conventions product mapping ──────────────────────

// NLM CLI accepts: audio | video | slide-deck | report | infographic (+ quiz, flashcard, etc. unused).
// Conventions module uses product names: audio | video | slides | report | infographic.
const NLM_TYPE_TO_PRODUCT: Record<string, string> = {
  audio: "audio",
  video: "video",
  "slide-deck": "slides",
  report: "report",
  infographic: "infographic",
};

// Windows node spawnSync needs a native path — MSYS /c/... won't resolve.
const NLM_BIN =
  process.env.NOTEBOOKLM_BIN ??
  (process.platform === "win32"
    ? "C:/Users/ceo/.notebooklm-venv/Scripts/notebooklm.exe"
    : "/c/Users/ceo/.notebooklm-venv/Scripts/notebooklm.exe");

// ── Main ─────────────────────────────────────────────────────────────

interface NotebookArtifact {
  id: string;
  title: string;
  created_at: string;
}

interface GalleryWinner {
  filename: string;
  titleSlug: string;
  timestamp: string;
  version: number;
}

interface RowReport {
  product: string;
  notebook: NotebookArtifact | null;
  gallery: GalleryWinner | null;
  status: "PASS" | "MISMATCH" | "MISSING-IN-GALLERY" | "STALE-IN-GALLERY" | "EMPTY";
  detail: string;
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(2);
});

async function main() {
  console.log(
    `verify-gallery-vs-notebook (conventions v${VERSION}, ${LAST_UPDATED})`,
  );
  console.log(`  notebook: ${notebookId}`);
  console.log(`  slug:     ${slug}`);
  console.log(`  strict:   ${strict}\n`);

  const galleryByProduct = await listGallery(slug!);
  console.log(
    `Gallery: ${countTotal(galleryByProduct)} studio file(s) across ${Object.keys(galleryByProduct).length} type(s)\n`,
  );

  const rows: RowReport[] = [];
  for (const [nlmType, product] of Object.entries(NLM_TYPE_TO_PRODUCT)) {
    const newest = listNotebookArtifactsAndPickNewest(notebookId!, nlmType);
    const winner = galleryByProduct[product] ?? null;
    rows.push(reconcile(product, newest, winner));
  }

  reportTable(rows);

  const errors = rows.filter((r) => r.status === "MISMATCH" || r.status === "MISSING-IN-GALLERY");
  const warnings = rows.filter((r) => r.status === "STALE-IN-GALLERY");
  const passes = rows.filter((r) => r.status === "PASS").length;
  const skipped = rows.filter((r) => r.status === "EMPTY").length;

  console.log();
  console.log(`Summary: ${passes} pass, ${errors.length} error, ${warnings.length} warn, ${skipped} skipped`);

  if (errors.length === 0) {
    console.log("OK — gallery's newest-of-each-type matches notebook's newest-of-each-type.");
    process.exit(0);
  }

  if (strict) {
    console.error("FAIL (--strict): errors above must be fixed before declaring run complete.");
    process.exit(1);
  }

  console.warn("WARN: errors above — pass --strict to fail-hard.");
  process.exit(0);
}

// ── NLM artifact listing ─────────────────────────────────────────────

function listNotebookArtifactsAndPickNewest(
  notebook: string,
  nlmType: string,
): NotebookArtifact | null {
  const r = spawnSync(
    NLM_BIN,
    ["artifact", "list", "-n", notebook, "--type", nlmType, "--json"],
    { encoding: "utf-8" },
  );

  // NLM CLI emits a deprecation warning to stderr; that's fine. Only fail on non-zero exit.
  if (r.status !== 0) {
    const stderr = (r.stderr ?? "") + (r.error ? ` ${r.error.message}` : "");
    console.warn(`  [${nlmType}] notebooklm artifact list exit=${r.status}: ${stderr.slice(0, 200)}`);
    return null;
  }

  let parsed: { artifacts?: Array<{ id: string; title: string; created_at: string; status_id?: number }> };
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    console.warn(`  [${nlmType}] failed to parse JSON: ${(e as Error).message}`);
    return null;
  }

  // status_id 3 == completed; absent assumed completed for forward-compat
  const arts = (parsed.artifacts ?? []).filter((a) => a.status_id === 3 || a.status_id === undefined);
  if (arts.length === 0) return null;

  arts.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const top = arts[0];
  return { id: top.id, title: top.title, created_at: top.created_at };
}

// ── Supabase Storage listing ─────────────────────────────────────────

async function listGallery(slugPath: string): Promise<Record<string, GalleryWinner>> {
  const url = `${supabaseUrl!.replace(/\/$/, "")}/storage/v1/object/list/research-projects`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prefix: slugPath, limit: 200, offset: 0 }),
  });

  if (!res.ok) {
    throw new Error(`Supabase list HTTP ${res.status}: ${await res.text()}`);
  }

  const files = (await res.json()) as Array<{ name: string }>;

  const byProduct: Record<string, GalleryWinner> = {};
  // Version-aware match: catches both v1 (no suffix) and v2/v3+ (-vN) files.
  // The canonical studio regex in conventions.json rejects -vN suffix, so we
  // do our own parse here. See feedback_post_run_artifact_verification.md.
  const VERSIONED_STUDIO = /^([a-z0-9-]+)-(\d{8}-\d{6})-([a-z]+)(?:-v(\d+))?\.([a-z0-9]+)$/;

  for (const { name } of files) {
    const m = name.match(VERSIONED_STUDIO);
    if (!m) continue;
    const [, titleSlug, timestamp, product, vStr] = m;
    if (!STUDIO_PRODUCTS[product]) continue;
    const version = vStr ? parseInt(vStr, 10) : 1;

    const candidate: GalleryWinner = { filename: name, titleSlug, timestamp, version };
    const cur = byProduct[product];
    if (!cur || candidate.version > cur.version) {
      byProduct[product] = candidate;
    }
  }
  return byProduct;
}

function countTotal(byProduct: Record<string, GalleryWinner>): number {
  return Object.keys(byProduct).length;
}

// ── Reconciliation ───────────────────────────────────────────────────

function reconcile(
  product: string,
  newest: NotebookArtifact | null,
  winner: GalleryWinner | null,
): RowReport {
  if (!newest && !winner) {
    return { product, notebook: null, gallery: null, status: "EMPTY", detail: "neither side" };
  }
  if (newest && !winner) {
    return {
      product,
      notebook: newest,
      gallery: null,
      status: "MISSING-IN-GALLERY",
      detail: `notebook has ${newest.id} but gallery has no ${product} file`,
    };
  }
  if (!newest && winner) {
    return {
      product,
      notebook: null,
      gallery: winner,
      status: "STALE-IN-GALLERY",
      detail: `gallery has v${winner.version} ${winner.filename} but notebook has no ${product} artifact`,
    };
  }

  // Both sides present: compare title slugs.
  // Use prefix-30-chars match (slugify caps at 60 but NLM titles can shift slightly between
  // submission and completion + truncation may differ across runs). 30-char prefix is the
  // signal-to-noise sweet spot.
  const expectedSlugRaw = slugify(newest!.title);
  const actualSlugRaw = winner!.titleSlug;
  // Strip leading numeric tokens (e.g. "2026-") so "2026-strategic-foo" matches "strategic-foo".
  // NLM occasionally renames artifacts after creation, prepending the year.
  const stripLeadingNumeric = (s: string) => s.replace(/^(\d+-)+/, "");
  const expectedSlug = stripLeadingNumeric(expectedSlugRaw);
  const actualSlug = stripLeadingNumeric(actualSlugRaw);
  const a = expectedSlug.slice(0, 30);
  const b = actualSlug.slice(0, 30);

  if (a === b || expectedSlug.startsWith(b) || actualSlug.startsWith(a)) {
    return {
      product,
      notebook: newest,
      gallery: winner,
      status: "PASS",
      detail: `v${winner!.version} ${actualSlug.slice(0, 50)}${actualSlug.length > 50 ? "…" : ""}`,
    };
  }

  return {
    product,
    notebook: newest,
    gallery: winner,
    status: "MISMATCH",
    detail: `gallery title-slug "${actualSlug.slice(0, 50)}" != newest "${expectedSlug.slice(0, 50)}"`,
  };
}

// ── Reporting ────────────────────────────────────────────────────────

function reportTable(rows: RowReport[]): void {
  const symbol: Record<RowReport["status"], string> = {
    PASS: "[PASS]",
    MISMATCH: "[FAIL]",
    "MISSING-IN-GALLERY": "[FAIL]",
    "STALE-IN-GALLERY": "[WARN]",
    EMPTY: "[ -- ]",
  };

  console.log("Per-product reconciliation:");
  console.log("─".repeat(100));
  for (const r of rows) {
    const sym = symbol[r.status];
    console.log(`  ${sym} ${r.product.padEnd(12)} ${r.detail}`);
    if (r.notebook && (r.status === "MISMATCH" || r.status === "MISSING-IN-GALLERY")) {
      console.log(`         notebook: ${r.notebook.id} (${r.notebook.created_at}) "${r.notebook.title.slice(0, 70)}"`);
    }
    if (r.gallery && r.status === "MISMATCH") {
      console.log(`         gallery:  v${r.gallery.version} ${r.gallery.filename.slice(0, 80)}`);
    }
  }
  console.log("─".repeat(100));
}
