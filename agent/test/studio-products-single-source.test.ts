/**
 * S169 — studio-products single-source (Task 2, chip task_7486732e).
 *
 * Pins that the three agent-side mirror sites which now DERIVE the studio
 * product set from conventions.json (via plan-types' STUDIO_PRODUCT_LIST) still
 * produce values BYTE-FOR-BYTE / behavior-identical to the pre-refactor
 * hand-typed literals:
 *   - agent/lib/plan-synthesizer.ts   -> STUDIO_SELECTED_ENUM / STUDIO_SELECTED_EXAMPLE
 *     (the LLM schema-hint prompt: the one behavioral-risk surface) + their
 *     wiring into SCHEMA_HINT.
 *   - agent/lib/studio-completeness.ts -> obligedProducts() order (STUDIO_ORDER
 *     is now an alias of STUDIO_PRODUCT_LIST).
 *   - agent/types.ts                  -> SelectedProducts (now
 *     Record<StudioProduct, boolean>): a runtime key-set check, belt over tsc.
 *
 * The conventions.json <-> StudioProduct union drift guard itself lives in
 * studio-products-sync.test.ts (assertStudioProductsInSync); this file pins the
 * DOWNSTREAM derivations of that single source.
 *
 * Run: pnpm -C agent exec node --import=tsx --test test/studio-products-single-source.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_HINT,
  RESEARCH_COMPARE_PIPELINE_DIGEST,
  STUDIO_PRODUCTS_SLASH,
  STUDIO_SELECTED_ENUM,
  STUDIO_SELECTED_EXAMPLE,
} from "../lib/plan-synthesizer.js";
import { obligedProducts } from "../lib/studio-completeness.js";
import { assertProductDefsInSync } from "../scripts/regenerate-studio-products.js";
// Importing this also EXECUTES verify-gallery's module-load assertNlmTypeMapInSync()
// — and, crucially, NOT its main() (the S170 isMain guard). If the real
// NLM_TYPE_TO_PRODUCT ever drifts, this import throws and the whole suite fails.
import { assertNlmTypeMapInSync } from "../scripts/verify-gallery-vs-notebook.js";
import { STUDIO_PRODUCT_LIST } from "../lib/plan-types.js";
import type { SelectedProducts } from "../types.js";

// Pre-S169 literals, hand-copied from the former source. NON-VACUOUS: these are
// fixed strings, NOT re-derived from STUDIO_PRODUCT_LIST, so any change to the
// derivation's order / quoting / spacing fails here.
const PRE_S169_ENUM = '"audio", "video", "slides", "report", "infographic"';
const PRE_S169_EXAMPLE = '"audio?","video?","slides?","report?","infographic?"';
const PRE_S169_SLASH = "audio/video/slides/report/infographic";
const PRE_S169_ORDER = ["audio", "video", "slides", "report", "infographic"];

test("plan-synthesizer STUDIO_SELECTED_ENUM is byte-identical to the pre-S169 literal", () => {
  assert.equal(STUDIO_SELECTED_ENUM, PRE_S169_ENUM);
});

test("plan-synthesizer STUDIO_SELECTED_EXAMPLE is byte-identical to the pre-S169 literal", () => {
  assert.equal(STUDIO_SELECTED_EXAMPLE, PRE_S169_EXAMPLE);
});

test("SCHEMA_HINT wires the derived enum into the studio_products.selected line", () => {
  // The exact pre-S169 prompt line (U+2014 em-dash + 'BARE values.'). Proves the
  // ${STUDIO_SELECTED_ENUM} interpolation is WIRED and the surrounding text is
  // unchanged — not merely that the fragment const exists.
  assert.ok(
    SCHEMA_HINT.includes(
      `- studio_products.selected entries MUST be exactly one of: ${PRE_S169_ENUM} — BARE values.`,
    ),
    "SCHEMA_HINT studio enum line drifted from the pre-S169 prompt",
  );
});

test("SCHEMA_HINT wires the derived example into the JSON skeleton", () => {
  assert.ok(
    SCHEMA_HINT.includes(`"selected": [${PRE_S169_EXAMPLE}],`),
    "SCHEMA_HINT studio JSON example drifted from the pre-S169 prompt",
  );
});

test("obligedProducts() returns the canonical order when all products are selected", () => {
  const allSelected = {
    audio: true,
    video: true,
    slides: true,
    report: true,
    infographic: true,
  } as SelectedProducts;
  assert.deepEqual(obligedProducts(allSelected), PRE_S169_ORDER);
});

test("obligedProducts() preserves canonical order under a partial, out-of-order selection", () => {
  // report + audio selected, listed report-first in the object — output must
  // still be canonical order (audio before report), proving the order comes from
  // STUDIO_ORDER (= STUDIO_PRODUCT_LIST), not the input object's key order.
  const partial = {
    report: true,
    audio: true,
    video: false,
    slides: false,
    infographic: false,
  } as SelectedProducts;
  assert.deepEqual(obligedProducts(partial), ["audio", "report"]);
});

test("STUDIO_PRODUCT_LIST equals the pre-S169 order (the shared anchor for the above)", () => {
  assert.deepEqual([...STUDIO_PRODUCT_LIST], PRE_S169_ORDER);
});

test("SelectedProducts is keyed exactly by the canonical product set (runtime belt over tsc)", () => {
  // Build a SelectedProducts from the canonical list; its key set must equal
  // STUDIO_PRODUCT_LIST exactly (no excess / no missing). The conventions <-> union
  // drift case is caught earlier by assertStudioProductsInSync at module load.
  const built = Object.fromEntries(
    STUDIO_PRODUCT_LIST.map((p) => [p, false]),
  ) as SelectedProducts;
  assert.deepEqual(
    Object.keys(built).slice().sort(),
    [...STUDIO_PRODUCT_LIST].slice().sort(),
  );
  for (const p of STUDIO_PRODUCT_LIST) {
    assert.equal(typeof built[p], "boolean");
  }
});

// ── R2 (Codex grounded BLOCK): the prose digest + the regen-script key set ──────

test("plan-synthesizer STUDIO_PRODUCTS_SLASH is byte-identical to the pre-S169 prose literal", () => {
  assert.equal(STUDIO_PRODUCTS_SLASH, PRE_S169_SLASH);
});

test("RESEARCH_COMPARE_PIPELINE_DIGEST wires the slash form into BOTH prose lines", () => {
  // The two pre-S169 prose mentions of the product set. Proves the digest prompt
  // tracks STUDIO_PRODUCT_LIST too (not just SCHEMA_HINT) — the drift Codex caught.
  assert.ok(
    RESEARCH_COMPARE_PIPELINE_DIGEST.includes(
      `5.5  Studio Products            — ${PRE_S169_SLASH} (Veo cinematic for video)`,
    ),
    "digest phase-5.5 line drifted from the pre-S169 prose",
  );
  assert.ok(
    RESEARCH_COMPARE_PIPELINE_DIGEST.includes(
      `manifest.selected_products (${PRE_S169_SLASH}).`,
    ),
    "digest selected_products line drifted from the pre-S169 prose",
  );
});

test("assertProductDefsInSync() passes for the shipped regen-script PRODUCT_DEFS", () => {
  assert.doesNotThrow(() => assertProductDefsInSync());
});

test("assertProductDefsInSync() THROWS on drift — superset, subset, rename (not vacuous)", () => {
  // PRODUCT_DEFS missing a canonical product (would silently drop it from studio_only).
  assert.throws(
    () => assertProductDefsInSync(["audio"], ["audio", "video"]),
    /PRODUCT_DEFS drift/,
  );
  // PRODUCT_DEFS has an extra product not in the canonical set.
  assert.throws(
    () => assertProductDefsInSync(["audio", "video"], ["audio"]),
    /PRODUCT_DEFS drift/,
  );
  // Same cardinality, renamed key.
  assert.throws(
    () => assertProductDefsInSync(["audio", "podcast"], ["audio", "video"]),
    /PRODUCT_DEFS drift/,
  );
});

test("assertProductDefsInSync() is order-insensitive (set, not sequence)", () => {
  assert.doesNotThrow(() =>
    assertProductDefsInSync(["video", "audio"], ["audio", "video"]),
  );
});

// ── R3 (S170, Codex grounded BLOCK): the verify-gallery coverage mirror ─────────
// verify-gallery-vs-notebook.ts NLM_TYPE_TO_PRODUCT's VALUES are the verifier's
// per-product coverage set (its Object.entries loop). Same single-source contract
// as PRODUCT_DEFS above. The mere SUCCESS of the import at the top of this file is
// itself the strongest pin: it ran the script's module-load assertNlmTypeMapInSync()
// against the REAL map (and did NOT run main(), proving the isMain guard works).

test("assertNlmTypeMapInSync() passes for the shipped verify-gallery NLM_TYPE_TO_PRODUCT", () => {
  assert.doesNotThrow(() => assertNlmTypeMapInSync());
});

test("assertNlmTypeMapInSync() THROWS on drift — subset, superset, rename (not vacuous)", () => {
  // A product missing from the verifier coverage set (would be silently skipped).
  assert.throws(
    () => assertNlmTypeMapInSync(["audio"], ["audio", "video"]),
    /NLM_TYPE_TO_PRODUCT drift/,
  );
  // A verifier value not in the canonical set.
  assert.throws(
    () => assertNlmTypeMapInSync(["audio", "video"], ["audio"]),
    /NLM_TYPE_TO_PRODUCT drift/,
  );
  // Same cardinality, renamed product value.
  assert.throws(
    () => assertNlmTypeMapInSync(["audio", "podcast"], ["audio", "video"]),
    /NLM_TYPE_TO_PRODUCT drift/,
  );
});

test("assertNlmTypeMapInSync() is order-insensitive (set, not sequence)", () => {
  assert.doesNotThrow(() =>
    assertNlmTypeMapInSync(["video", "audio"], ["audio", "video"]),
  );
});

test("verify-gallery NLM_TYPE_TO_PRODUCT coverage equals the canonical product set", () => {
  // Belt over the module-load assertion: the verifier's real product VALUE set
  // (validated via the default-param call) must equal STUDIO_PRODUCT_LIST exactly.
  assert.doesNotThrow(() =>
    assertNlmTypeMapInSync(undefined, [...STUDIO_PRODUCT_LIST]),
  );
});
