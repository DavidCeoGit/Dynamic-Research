/**
 * S172 — unit tests for the hermetic frontend studio-product canonical
 * (frontend/lib/studio-products.ts). Behavioral coverage of the helpers that
 * replace the 13 hand-authored mirror sites; the cross-tier set/order invariant
 * against the agent canonical is a SEPARATE guard (test/studio-products-parity.test.ts).
 *
 * Run (from repo root, via agent's tsx loader):
 *   pnpm -C agent exec node --import=tsx --test "../frontend/lib/__tests__/studio-products.test.ts"
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  STUDIO_PRODUCT_KEYS,
  emptySelection,
  coerceSelection,
  isStudioProductKey,
} from "../studio-products";

describe("studio-products: STUDIO_PRODUCT_KEYS", () => {
  test("exact value + order (mirrors conventions.json insertion order)", () => {
    assert.deepEqual(
      [...STUDIO_PRODUCT_KEYS],
      ["audio", "video", "slides", "report", "infographic"],
    );
  });

  test("length is 5", () => {
    assert.equal(STUDIO_PRODUCT_KEYS.length, 5);
  });

  test("runtime-frozen (parity with the agent canonical's Object.freeze)", () => {
    assert.equal(Object.isFrozen(STUDIO_PRODUCT_KEYS), true);
  });
});

describe("studio-products: emptySelection", () => {
  test("all-false, complete key set — byte-identical to the old { audio:false, … } literal", () => {
    assert.deepEqual(emptySelection(), {
      audio: false,
      video: false,
      slides: false,
      report: false,
      infographic: false,
    });
  });

  test("a fresh object each call (no shared mutable default)", () => {
    const a = emptySelection();
    const b = emptySelection();
    assert.notEqual(a, b);
    a.audio = true;
    assert.equal(b.audio, false);
  });
});

describe("studio-products: coerceSelection", () => {
  test("byte-identical to the hand { audio:!!x.audio, … } maps on a full bag", () => {
    const raw = { audio: true, video: false, slides: true, report: false, infographic: true };
    assert.deepEqual(coerceSelection(raw), {
      audio: true,
      video: false,
      slides: true,
      report: false,
      infographic: true,
    });
  });

  test("missing key → false; never throws", () => {
    assert.deepEqual(coerceSelection({ audio: true }), {
      audio: true,
      video: false,
      slides: false,
      report: false,
      infographic: false,
    });
  });

  test("extra/stale key is dropped (only canonical keys appear)", () => {
    const out = coerceSelection({ audio: true, legacyPodcast: true } as Record<string, unknown>);
    assert.deepEqual(Object.keys(out), ["audio", "video", "slides", "report", "infographic"]);
    assert.equal((out as Record<string, unknown>).legacyPodcast, undefined);
  });

  test("truthy/falsy coercion matches !! semantics", () => {
    const out = coerceSelection({
      audio: 1,
      video: 0,
      slides: "yes",
      report: "",
      infographic: null,
    } as Record<string, unknown>);
    assert.deepEqual(out, {
      audio: true,
      video: false,
      slides: true,
      report: false,
      infographic: false,
    });
  });

  test("null / undefined / {} → all-false (equals emptySelection)", () => {
    assert.deepEqual(coerceSelection(null), emptySelection());
    assert.deepEqual(coerceSelection(undefined), emptySelection());
    assert.deepEqual(coerceSelection({}), emptySelection());
  });
});

describe("studio-products: isStudioProductKey", () => {
  test("accepts every canonical key", () => {
    for (const k of STUDIO_PRODUCT_KEYS) {
      assert.equal(isStudioProductKey(k), true);
    }
  });

  test("rejects non-keys (stale, typo, empty, prototype names)", () => {
    for (const k of ["", "podcast", "Audio", "audioo", "state", "report ", "toString", "__proto__"]) {
      assert.equal(isStudioProductKey(k), false, `should reject ${JSON.stringify(k)}`);
    }
  });
});
