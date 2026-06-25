/**
 * Frontend canonical for the NotebookLM Studio product key set.
 *
 * Hermetic (ZERO imports) so it is safe in EVERY bundle: server, edge, AND
 * client. The agent tier's canonical (agent/lib/plan-types.ts STUDIO_PRODUCT_LIST,
 * derived from agent/lib/conventions.json) cannot be imported here — it pulls
 * agent/lib/conventions.ts whose module body runs fs.readFileSync at load, which
 * would drag `fs` into the edge/client bundle (a Next 16 build break). So the
 * frontend keeps its OWN literal and the cross-tier invariant
 *   STUDIO_PRODUCT_KEYS  ==  agent STUDIO_PRODUCT_LIST
 * is NOT enforced in this module (it cannot import the Node-only canonical);
 * it is enforced by test/studio-products-parity.test.ts at `pnpm test` time
 * (set + order equality against the live agent export).
 *
 * HARD design rule for this tier: NO module-load throw. This module is imported
 * by client components (page.tsx, StepProducts.tsx, …); a load-time assert that
 * threw on drift — the agent fail-fast pattern — would crash the browser page.
 * The invariant is enforced ONLY at compile time (the Record<StudioProductKey,…>
 * types + the AssertExact key-parity guards in consumers) and test time (the
 * parity test), NEVER at client runtime.
 *
 * Order mirrors conventions.json key-insertion order. Object.freeze gives runtime
 * parity with the agent canonical (which freezes STUDIO_PRODUCT_LIST); `as const`
 * alone is compile-time readonly, not runtime-frozen.
 */
export const STUDIO_PRODUCT_KEYS = Object.freeze([
  "audio",
  "video",
  "slides",
  "report",
  "infographic",
] as const);

export type StudioProductKey = (typeof STUDIO_PRODUCT_KEYS)[number];

/** Canonical frontend selection type. Adding a product to the tuple above makes
 *  every object literal that omits the new key a compile error. */
export type SelectedProducts = Record<StudioProductKey, boolean>;

/**
 * Compile-time exact-equality assertion. Resolves to `true` iff A and B are
 * mutually assignable (same set), else `false`. Use in the VALUE-ASSIGNMENT form
 *   const _x: AssertExact<A, B> = true;
 * so a mismatch is a hard `tsc` error (`true` is not assignable to `false`). A
 * bare `type _X = AssertExact<…>` is VACUOUS — a type alias to `false`/`never`
 * does NOT fail tsc. The tuple-wrapping ([A] extends [B]) blocks distribution so
 * unions are compared as whole sets. Type-only (erased at runtime) — keeps this
 * module hermetic. Single-sourced here because the same guard is used by the Zod
 * key-parity checks (validate.ts) and the display-array completeness checks
 * (new/[id]/page.tsx, StepProducts.tsx).
 */
export type AssertExact<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

/** All-false selection — the canonical default object, derived not hand-listed. */
export function emptySelection(): SelectedProducts {
  return Object.fromEntries(
    STUDIO_PRODUCT_KEYS.map((k) => [k, false]),
  ) as SelectedProducts;
}

/** Coerce an untrusted/loose product bag to a complete boolean record. Every
 *  canonical key is forced present; a missing key → undefined → !! → false (same
 *  as the hand-written `{ audio: !!raw.audio, … }` maps it replaces). */
export function coerceSelection(
  raw: Record<string, unknown> | null | undefined,
): SelectedProducts {
  return Object.fromEntries(
    STUDIO_PRODUCT_KEYS.map((k) => [k, !!raw?.[k]]),
  ) as SelectedProducts;
}

/** Runtime guard narrowing an arbitrary string to a product key. LOAD-BEARING:
 *  it is the narrow that lets a consumer safely index a
 *  Record<StudioProductKey, V> with a `string` key from
 *  Object.entries(selectedProducts) (sites F, K) without an unsafe `as` cast. */
export function isStudioProductKey(s: string): s is StudioProductKey {
  return (STUDIO_PRODUCT_KEYS as readonly string[]).includes(s);
}
