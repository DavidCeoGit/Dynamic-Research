/**
 * S165 — guards audit 2026-06-24 HIGH #1.
 *
 * The studio-product key set has two representations that MUST never drift:
 *   - agent/lib/plan-types.ts  → the StudioProduct union (compile-time type
 *     anchor: STUDIO_PRODUCT_KEYS) + the runtime STUDIO_PRODUCT_LIST, which is
 *     DERIVED from the conventions Record.
 *   - agent/lib/conventions.json → filename_patterns.studio.products (the
 *     canonical Record carrying ext/docx_companion/list_method/download_method).
 *
 * plan-types already calls assertStudioProductsInSync() at module load, so a
 * drift would crash the worker at startup. This test pins the same invariant in
 * CI so drift fails `pnpm test` BEFORE it can reach the worker (and before the
 * tri-vendor gate). Both imports are agent-side (no cross-package import — see
 * S164 rootDir lesson).
 *
 * Run via:
 *   pnpm -C agent exec node --import=tsx --test test/studio-products-sync.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STUDIO_PRODUCT_LIST,
  assertStudioProductsInSync,
  type StudioProduct,
} from "../lib/plan-types.js";
import { STUDIO_PRODUCTS as STUDIO_PRODUCT_DEFS } from "../lib/conventions.js";

// Independent oracle: the canonical key set, restated here so the test fails
// loudly (rather than tautologically) if either source is edited in isolation.
// Updating conventions.json's products MUST be accompanied by updating both
// STUDIO_PRODUCT_KEYS in plan-types.ts AND this literal.
const EXPECTED_PRODUCTS = [
  "audio",
  "video",
  "slides",
  "report",
  "infographic",
] as const;

test("studio product set + order matches the canonical expectation", () => {
  // Pins both halves against an INDEPENDENT literal (not Object.keys vs
  // Object.keys): the derived STUDIO_PRODUCT_LIST and the conventions Record
  // keys must each equal EXPECTED_PRODUCTS in membership AND order. Order
  // matters for human-facing `.join('|')` error text and matches conventions
  // key-insertion order.
  assert.deepEqual([...STUDIO_PRODUCT_LIST], [...EXPECTED_PRODUCTS]);
  assert.deepEqual(Object.keys(STUDIO_PRODUCT_DEFS), [...EXPECTED_PRODUCTS]);
});

test("assertStudioProductsInSync() passes for the shipped definitions", () => {
  assert.doesNotThrow(() => assertStudioProductsInSync());
});

test("assertStudioProductsInSync() THROWS on simulated drift (not vacuous)", () => {
  // Sensitivity check: the guard must actually catch a divergence, not just
  // happen to pass. Missing key, extra key, and renamed key all drift.
  assert.throws(
    () => assertStudioProductsInSync(["audio", "video"], ["audio"]),
    /STUDIO_PRODUCTS drift/,
    "should throw when the conventions key set is larger than the union",
  );
  assert.throws(
    () => assertStudioProductsInSync(["audio"], ["audio", "video"]),
    /STUDIO_PRODUCTS drift/,
    "should throw when the union is larger than the conventions key set",
  );
  assert.throws(
    () => assertStudioProductsInSync(["audio", "podcast"], ["audio", "video"]),
    /STUDIO_PRODUCTS drift/,
    "should throw when a key is renamed (same count, different member)",
  );
});

test("assertStudioProductsInSync() is order-insensitive (set, not sequence)", () => {
  // Reordering is NOT drift — only the SET must match. Order is pinned by the
  // separate canonical-order test above, intentionally not by the guard.
  assert.doesNotThrow(() =>
    assertStudioProductsInSync(["video", "audio"], ["audio", "video"]),
  );
});

test("every conventions studio product carries ext + docx_companion", () => {
  // Belt on the Record half of the contract the union half cannot express.
  for (const p of STUDIO_PRODUCT_LIST) {
    const def = STUDIO_PRODUCT_DEFS[p];
    assert.ok(def, `missing conventions def for product "${p}"`);
    assert.equal(typeof def.ext, "string", `${p}.ext must be a string`);
    assert.equal(
      typeof def.docx_companion,
      "boolean",
      `${p}.docx_companion must be a boolean`,
    );
  }
});

test("StudioProduct union members are all present at runtime", () => {
  // Compile-time anchor ↔ runtime list cross-check. If a member is added to the
  // union but not conventions.json (or vice versa), assertStudioProductsInSync
  // throws at import; this asserts the post-assertion runtime list is complete.
  const members: StudioProduct[] = [...EXPECTED_PRODUCTS];
  for (const m of members) {
    assert.ok(
      STUDIO_PRODUCT_LIST.includes(m),
      `StudioProduct "${m}" missing from runtime STUDIO_PRODUCT_LIST`,
    );
  }
  assert.equal(STUDIO_PRODUCT_LIST.length, members.length);
});
