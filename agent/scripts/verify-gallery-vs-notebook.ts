/**
 * Verify a research-run's studio deliverables match the truly-newest NLM
 * artifacts in the source notebook. Catches the S31 wrong-artifact-upload bug
 * where `notebooklm download <type>` (without --artifact ID) returned an OLDER
 * artifact than the just-submitted task and got shipped to the gallery.
 *
 * Two source modes (exactly one required):
 *   --local-dir <path>   verify the local Projects/<slug>/ deliverables dir
 *                        (S89: the canonical pre-upload check — the worker's
 *                        uploadOutputs is now the sole authoritative scoped
 *                        upload, so the gate runs against what WILL be uploaded
 *                        rather than a now-vestigial flat storage path).
 *   --slug <supabase-slug>  verify Supabase Storage at the legacy flat `<slug>/`
 *                        prefix (kept for backward-compat / manual storage audits;
 *                        requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
 *
 * Usage:
 *   cd agent && node --env-file=.env --import=tsx \
 *     scripts/verify-gallery-vs-notebook.ts \
 *     --notebook <notebook-id> (--local-dir <path> | --slug <slug>) [--strict]
 *
 * Exit codes:
 *   0 = all studio types match newest-of-type in notebook (or absent both sides)
 *   1 = mismatches found (with --strict; warn-only otherwise)
 *   2 = usage / connection error
 *
 * Algorithm:
 * 1. List artifacts per studio type via `notebooklm artifact list -n <id> --type <T> --json`.
 *    Pick the truly-newest (max created_at) of each type.
 * 2. List candidate deliverable filenames (local dir readdir OR Supabase Storage
 *    list at `<slug>/`). Filter to studio-shaped names; per product, pick the
 *    highest-version winner (no `-vN` = v1; `-v3` = 3, etc.). The comparison is
 *    purely filename-based, so local and storage listings are interchangeable —
 *    the local Projects/ files carry the identical title-slug-prefixed names that
 *    uploadOutputs ships to scoped storage.
 * 3. For each product type:
 *    - If notebook has no artifact and listing has none: SKIP (nothing to check).
 *    - If notebook has one and listing has none: MISSING-IN-GALLERY.
 *    - If notebook has none and listing has one: STALE-IN-GALLERY (no notebook source).
 *    - If both: compare title-slug-prefix to slugify(newest.title). If no match: MISMATCH.
 * 4. Report a per-type table; exit non-zero on errors with --strict.
 *
 * Ships paired with feedback_post_run_artifact_verification.md (S31). Wired into
 * /research-compare slash command Phase 6.5 (post-Studio, pre-completion) in
 * --local-dir mode as of S89.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { slugify, VERSION, LAST_UPDATED } from "../lib/conventions.js";
import { GalleryWinner, pickWinners } from "../lib/studio-winner.js";
import { STUDIO_PRODUCT_LIST } from "../lib/plan-types.js";

// ── Args ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const strict = argv.includes("--strict");
const notebookId = argFor("--notebook");
const slug = argFor("--slug");
const localDir = argFor("--local-dir");

function argFor(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

// Supabase creds are only needed for the legacy --slug storage mode. Module-level
// so listGallery() can read them; the presence CHECK runs in the CLI-entry block
// at the bottom (S170 — gated behind import.meta.main so a unit test can import
// this module's pure helpers without process.exit()).
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

// Single-source guard (S170): Object.values(NLM_TYPE_TO_PRODUCT) IS the verifier
// coverage set — main()'s `Object.entries(NLM_TYPE_TO_PRODUCT)` loop checks exactly
// these product types. Assert that product VALUE set equals the canonical
// STUDIO_PRODUCT_LIST (conventions.json) so a product added to conventions can
// never SILENTLY drop out of the gallery-vs-notebook check (this script gates
// /research-compare Phase 6.5 in --strict mode). Drift fails LOUD at module load
// (the script is spawned fresh per check) AND in
// agent/test/studio-products-single-source.test.ts. The CLI-type KEYS (e.g.
// "slide-deck") are intentionally NOT derived — they are the NotebookLM CLI's own
// argument names with no canonical source; only the product values are
// single-sourced (mirrors regenerate-studio-products.ts assertProductDefsInSync,
// which keeps the per-product CLI defs literal and asserts the key SET). The
// default params exist ONLY so the sync test can feed drifted inputs and prove the
// guard is non-vacuous.
export function assertNlmTypeMapInSync(
  productValues: readonly string[] = Object.values(NLM_TYPE_TO_PRODUCT),
  canonical: readonly string[] = STUDIO_PRODUCT_LIST,
): void {
  const a = productValues.slice().sort();
  const b = canonical.slice().sort();
  if (a.length !== b.length || a.some((p, i) => p !== b[i])) {
    throw new Error(
      `NLM_TYPE_TO_PRODUCT drift: product values [${a.join(", ")}] != conventions ` +
        `STUDIO_PRODUCT_LIST [${b.join(", ")}]. Add the new product's NotebookLM ` +
        `CLI-type mapping to NLM_TYPE_TO_PRODUCT (verify-gallery-vs-notebook.ts) or ` +
        `update conventions.json.`,
    );
  }
}
assertNlmTypeMapInSync();

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

interface RowReport {
  product: string;
  notebook: NotebookArtifact | null;
  gallery: GalleryWinner | null;
  status: "PASS" | "MISMATCH" | "MISSING-IN-GALLERY" | "STALE-IN-GALLERY" | "EMPTY";
  detail: string;
}

async function main() {
  const source = localDir ? `local ${localDir}` : `storage <${slug}/>`;
  console.log(
    `verify-gallery-vs-notebook (conventions v${VERSION}, ${LAST_UPDATED})`,
  );
  console.log(`  notebook: ${notebookId}`);
  console.log(`  source:   ${source}`);
  console.log(`  strict:   ${strict}\n`);

  const galleryByProduct = localDir
    ? listLocal(localDir)
    : await listGallery(slug!);
  console.log(
    `Deliverables: ${Object.keys(galleryByProduct).length} studio winner(s) (newest per product type)\n`,
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
    console.log("OK — newest-of-each-type matches notebook's newest-of-each-type.");
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

// ── Deliverable listing (local dir or Supabase Storage) ──────────────
// Winner-selection lives in ../lib/studio-winner.ts (pickWinners) — pure +
// unit-tested. Both sources below feed it the same flat {name}[] shape.

// S89: verify the local Projects/<slug>/ deliverables dir. These are exactly the
// files uploadOutputs ships to scoped storage, so this is the canonical pre-upload
// gate. A missing/empty dir yields no winners (every notebook-present type then
// reports MISSING-IN-GALLERY → fail under --strict), surfacing the gap loudly.
function listLocal(dir: string): Record<string, GalleryWinner> {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
  } catch (e) {
    throw new Error(`cannot read local deliverables dir "${dir}": ${(e as Error).message}`);
  }
  return pickWinners(names.map((name) => ({ name })));
}

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
  return pickWinners(files);
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
      detail: `notebook has ${newest.id} but listing has no ${product} file`,
    };
  }
  if (!newest && winner) {
    return {
      product,
      notebook: null,
      gallery: winner,
      status: "STALE-IN-GALLERY",
      detail: `listing has v${winner.version}${winner.variant} ${winner.filename} but notebook has no ${product} artifact`,
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
    detail: `listing title-slug "${actualSlug.slice(0, 50)}" != newest "${expectedSlug.slice(0, 50)}"`,
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
      console.log(`         gallery:  v${r.gallery.version}${r.gallery.variant} ${r.gallery.filename.slice(0, 80)}`);
    }
  }
  console.log("─".repeat(100));
}

// ── CLI entry (runs ONLY when executed directly — never on import) ──────────
// Mirrors regenerate-studio-products.ts: the arg-validation + main() are gated
// behind import.meta.main so a unit test can import assertNlmTypeMapInSync (and
// the pure helpers) without process.exit() or auto-running the verification
// (S170 testability). The module-load assertNlmTypeMapInSync() above still runs
// on import — that is the drift guard, and it is pure (throws only on drift).
const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (!notebookId) {
    console.error(
      "usage: verify-gallery-vs-notebook.ts --notebook <id> (--local-dir <path> | --slug <supabase-slug>) [--strict]",
    );
    process.exit(2);
  }
  // Exactly one source mode.
  if ((slug && localDir) || (!slug && !localDir)) {
    console.error(
      "error: provide exactly one of --local-dir <path> or --slug <supabase-slug>",
    );
    process.exit(2);
  }
  // Supabase creds are only needed for the legacy --slug storage mode.
  if (slug && (!supabaseUrl || !supabaseKey)) {
    console.error(
      "missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (required for --slug mode)",
    );
    process.exit(2);
  }
  main().catch((err) => {
    console.error("fatal:", err);
    process.exit(2);
  });
}
