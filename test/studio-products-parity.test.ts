/**
 * S172 — cross-tier set/order parity guard for the studio-product key set.
 *
 * The frontend cannot import the agent canonical (agent/lib/plan-types.ts pulls
 * conventions.ts → fs.readFileSync, which would break the edge/client bundle),
 * so the key set is MIRRORED: agent STUDIO_PRODUCT_LIST (derived from
 * conventions.json) ↔ frontend STUDIO_PRODUCT_KEYS (hand-authored literal). A
 * silent divergence (a product added to conventions.json but not to the frontend
 * tuple) would re-open the silent-drift class the S172 single-sourcing closed.
 *
 * This test imports BOTH REAL exports and asserts set + order equality on the
 * live values — NOT a source byte-grep (S120 Codex C5: byte-parity false-fails
 * on formatting and misses divergence outside the compared body). It lives at
 * the repo root so it is outside both subprojects' tsconfig (neither tsc
 * typechecks a cross-root import); tsx transpiles each module at runtime.
 *
 * Run (from repo root, via agent's tsx loader):
 *   pnpm -C agent exec node --import=tsx --test "../test/studio-products-parity.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { STUDIO_PRODUCT_LIST } from "../agent/lib/plan-types.js"; // Node canonical
import { STUDIO_PRODUCT_KEYS } from "../frontend/lib/studio-products.js"; // frontend mirror

test("studio-products parity: frontend key set == agent canonical (set-equality)", () => {
  const agent = [...STUDIO_PRODUCT_LIST].sort();
  const fe = [...STUDIO_PRODUCT_KEYS].sort();
  assert.deepEqual(
    fe,
    agent,
    `drift: frontend=[${STUDIO_PRODUCT_KEYS.join(",")}] agent=[${STUDIO_PRODUCT_LIST.join(",")}]`,
  );
});

test("studio-products parity: order matches conventions.json insertion order", () => {
  // Soft pin (the agent list itself only set-guards against the JSON; order is a
  // UI/display convenience). Asserted so an intentional reorder is a conscious
  // two-file change rather than a silent drift.
  assert.deepEqual([...STUDIO_PRODUCT_KEYS], [...STUDIO_PRODUCT_LIST]);
});
