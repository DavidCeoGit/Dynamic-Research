# Frontend studio-product key single-source — DESIGN gate

> DR S171 (2026-06-24). Completes the studio-product single-sourcing initiative
> begun agent-side in S165 (`STUDIO_PRODUCTS` rename + canonical `STUDIO_PRODUCT_LIST`),
> S169 (`STUDIO_ORDER`/`SelectedProducts`/plan-synthesizer prompt/`PRODUCT_DEFS`), and
> S170 (`NLM_TYPE_TO_PRODUCT`). The agent tier is now fully single-sourced against
> `agent/lib/conventions.json`. This doc designs the **frontend** half.
>
> **Event Gate:** DESIGN (cross-tier contract / new subsystem module) → MERGE later.
> **Risk Labels:** ARCHITECTURE (cross-module/cross-tier boundary contract). Not
> SECURITY/DATA/PRIVACY/AGENT-BEHAVIOR. **Severity:** NORMAL.
> **Reviewers (§11):** Gemini holistic-adversarial → integrate → Codex gpt-5.5 xhigh
> grounded-adversarial → integrate → Claude grounded subagent. Unanimous clear required.
>
> Companion synthesis artifact: `studio-products-frontend-single-source-design-gate-peer-review.md`.
>
> **Revision log:** v1 → **v2** integrates the Gemini 3.1 holistic-adversarial pass
> (3 verified CRITICALs: a missed 12th mirror `studioRecoveryPayloadSchema.max(5)`; an
> enforcement gap in `estimateMinutes`' hand-unrolled consuming loop; and `files.ts`
> `KNOWN_PRODUCTS`/`ProductType` reclassified OUT→IN — a superset is still single-sourceable
> via spread when its studio-portion is load-bearing). Inventory grew 11 → **13 IN sites**.
> v2 → **v3** integrates the Codex gpt-5.5 xhigh grounded-adversarial pass (1 CRITICAL +
> 2 MAJOR, all mechanism bugs in treatments — the architecture/inventory/boundary were
> validated): the Zod key-parity assertion FORM was vacuous (a `type` alias to `never`
> doesn't fail `tsc` — §4); the queue.ts re-export path was `./` not `../` (§3 row A); and
> tightening F/K to `Record<StudioProductKey,…>` breaks their `Object.entries` `string`-key
> consumers, which must narrow via `isStudioProductKey()` (§3 rows F/K, §5 rule 6).

---

## 1. Problem

The set of NotebookLM Studio products — **`audio, video, slides, report, infographic`** —
is the canonical key set defined ONCE agent-side in
`agent/lib/conventions.json` → `filename_patterns.studio.products`, surfaced as the
runtime list `STUDIO_PRODUCT_LIST` and the precise type `StudioProduct` in
`agent/lib/plan-types.ts` (guarded against the JSON by `assertStudioProductsInSync()`
at module-load + in `agent/test/studio-products-sync.test.ts`).

The **frontend** re-declares this same key set independently in **13 load-bearing
sites across 9 files**. None of them references the canonical: each is a hand-authored
literal (an interface, a Zod object, an `as const` tuple, a `Record` keyed by product,
or a coercion map). Adding or removing a Studio product in `conventions.json` today
requires manually finding and editing all 13 — and **nothing fails** if one is missed.
That is the silent-drift class this initiative closes.

### 1.1 Why the frontend can't just import the agent canonical

`agent/lib/plan-types.ts` imports `agent/lib/conventions.ts`, whose module body runs
`fs.readFileSync(conventions.json)` at load (CLAUDE.md §7). Pulling that into a
frontend module would drag `fs` into the **edge/client bundle** — a build break in
Next 16 (Edge runtime has no `fs`; the client bundle must not contain it). This is the
same boundary the agent `types.ts` respects with `import type { StudioProduct }`
(erased at runtime) — but the frontend needs the **runtime** key list (`.map`, Zod
shape, `Object.keys`), not just the type, so a type-only import is insufficient.

Confirmed: zero frontend modules import `plan-types` or `conventions` (grep). The
frontend tier is bundle-isolated from the agent tier by construction, and must stay so.

---

## 2. Design — hermetic frontend mirror + cross-tier parity test

Two new artifacts. The pattern is **mirror + guard**, identical in spirit to the
existing `test/publish-flag-parity.test.ts` (S120), which already mirrors the
publish-flag predicate across the agent/frontend tier boundary and guards it with a
behavioral parity test run from the repo root.

### 2.1 `frontend/lib/studio-products.ts` — the hermetic frontend canonical

A **dependency-free** module (no imports → safe in every bundle: server, edge, client).
It is the single source of truth *for the frontend tier*. Proposed exports:

```ts
// frontend/lib/studio-products.ts
// Hermetic (zero imports) so it is safe in server, edge, AND client bundles.
// The key set MUST equal agent/lib/plan-types.ts STUDIO_PRODUCT_LIST (which derives
// from agent/lib/conventions.json). That cross-tier invariant is NOT enforced here
// (this module cannot import the Node-only canonical without breaking the edge/client
// bundle); it is enforced by test/studio-products-parity.test.ts at `pnpm test` time.
// Order mirrors conventions.json key-insertion order.
// Object.freeze for runtime parity with the agent canonical (which freezes
// STUDIO_PRODUCT_LIST); `as const` alone is compile-time readonly, not runtime-frozen.
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

/** All-false selection — the canonical default object, derived not hand-listed. */
export function emptySelection(): SelectedProducts {
  return Object.fromEntries(
    STUDIO_PRODUCT_KEYS.map((k) => [k, false]),
  ) as SelectedProducts;
}

/** Coerce an untrusted/loose product bag to a complete boolean record. */
export function coerceSelection(
  raw: Record<string, unknown> | null | undefined,
): SelectedProducts {
  return Object.fromEntries(
    STUDIO_PRODUCT_KEYS.map((k) => [k, !!raw?.[k]]),
  ) as SelectedProducts;
}

/** Runtime guard for narrowing an arbitrary string to a product key. LOAD-BEARING:
 *  it is the narrow that lets a consumer safely index a `Record<StudioProductKey, V>`
 *  with a `string` key from `Object.entries(selectedProducts)` (sites F, K) without an
 *  unsafe `as` cast (§5 rule 6). */
export function isStudioProductKey(s: string): s is StudioProductKey {
  return (STUDIO_PRODUCT_KEYS as readonly string[]).includes(s);
}
```

Design notes:
- **Hand-authored `as const` tuple IS the type anchor.** Unlike the agent canonical
  (which must *derive* its runtime list from a JSON Record and therefore keeps a
  separate `STUDIO_PRODUCT_KEYS` tuple as the irreducible compile-time anchor), the
  frontend literal is itself hand-authored, so the tuple directly yields the precise
  `StudioProductKey` union with no derivation gymnastics. The **parity test** is what
  prevents this hand-authored tuple from drifting from the canonical.
- **No module-load throw.** This module is imported by **client components** (`page.tsx`,
  `StepProducts.tsx`, …). A module-load `assert…()` that throws on drift — the agent
  pattern — would crash the browser page/bundle. So the frontend enforces the invariant
  at **compile time** (the `Record<StudioProductKey, …>` types below) and **test time**
  (the parity test), **never** at client runtime. This is a hard design rule for this
  tier (see §5).

### 2.2 `test/studio-products-parity.test.ts` — the cross-tier guard

Lives at the **repo root** (outside both subprojects' tsconfig roots, so neither `tsc`
typechecks the cross-root import; `tsx` transpiles at runtime) and is run by the agent's
tsx loader — exactly like `test/publish-flag-parity.test.ts`. It imports **both real
exports** and asserts equality:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { STUDIO_PRODUCT_LIST } from "../agent/lib/plan-types.js";       // Node canonical
import { STUDIO_PRODUCT_KEYS } from "../frontend/lib/studio-products.js"; // frontend mirror

test("studio-products parity: frontend key set == agent canonical (set-equality)", () => {
  const agent = [...STUDIO_PRODUCT_LIST].sort();
  const fe = [...STUDIO_PRODUCT_KEYS].sort();
  assert.deepEqual(fe, agent,
    `drift: frontend=[${STUDIO_PRODUCT_KEYS.join(",")}] agent=[${STUDIO_PRODUCT_LIST.join(",")}]`);
});

test("studio-products parity: order matches conventions.json insertion order", () => {
  // Soft pin (the agent list itself only set-guards against JSON; order is a UI/display
  // convenience). Asserted so an intentional reorder is a conscious two-file change.
  assert.deepEqual([...STUDIO_PRODUCT_KEYS], [...STUDIO_PRODUCT_LIST]);
});
```

Wired into root `package.json` `test` alongside the other repo-root parity test:
`pnpm -C agent exec node --import=tsx --test "../test/studio-products-parity.test.ts"`.

**Transitive single-source chain:**
`conventions.json` → (`assertStudioProductsInSync`) → agent `STUDIO_PRODUCT_LIST` →
(`studio-products-parity.test.ts`) → frontend `STUDIO_PRODUCT_KEYS` → (compile-time
`Record<StudioProductKey,…>`) → every frontend site. A product added to the JSON breaks
the parity test until the frontend tuple is updated; updating the tuple then breaks
`tsc` at every frontend `Record`/literal that omits the new key. Drift cannot ship.

**Why behavioral/set assertion, not byte-grep:** per S120 Codex C5, a source byte-grep
false-fails on formatting and misses divergence outside the compared body. We compare the
live exported values.

---

## 3. Per-site inventory & treatment (the 13 IN sites)

Each row: a hand-authored studio-product key mirror whose drift is a real bug. "Forces
drift to fail" names the mechanism that makes adding/removing a product break the build
or a test. Sites L, M and the Site-H consuming-loop fix were added in v2 from the Gemini
holistic pass.

| # | Site | Current form | Treatment | Forces drift to fail via |
|---|------|--------------|-----------|--------------------------|
| A | `frontend/lib/types/queue.ts:53` `interface SelectedProducts` | 5-field interface | `export type { SelectedProducts } from "../studio-products";` — re-export the hermetic `Record<StudioProductKey,boolean>` (note the `../` — queue.ts is in `lib/types/`, the module in `lib/`) | compile: every `{...} as SelectedProducts` literal must cover all keys |
| B | `frontend/lib/validate.ts:103` `selectedProductsSchema` | Zod `z.object({5 keys})` + `.refine` | keep explicit Zod object; add compile-time key-parity assertion (see §4) | compile: `satisfies` assertion fails if keys ≠ `StudioProductKey` |
| C | `frontend/lib/validate.ts:407` `selectedProductsBaseSchema` | Zod `z.object({5 keys})` | same as B | compile assertion |
| D | `frontend/lib/validate.ts:446` `FORM_DEFAULT_VALUES.selectedProducts` | `{audio:false,…}` literal | `emptySelection()` | compile: return type `SelectedProducts` |
| E | `frontend/app/runs/[slug]/page.tsx:25` `PRODUCT_KEYS` + `:29` `normalizeProducts` + `:57` default | tuple + coercion map + default obj | import `STUDIO_PRODUCT_KEYS`; `normalizeProducts`→`coerceSelection`; default→`emptySelection()` | compile + the shared helpers |
| F | `frontend/app/page.tsx:88` `PRODUCT_ICONS` **+ consumer :446/:505** | `Record<string, Icon>`, indexed by a `string` key from `Object.entries(run.selectedProducts)` | tighten map to `Record<StudioProductKey, Icon>` **AND** narrow the consumer key with `isStudioProductKey(k)` before indexing (`run.selectedProducts` is a loose `Record<string,boolean>` → `Object.entries` yields `string` keys; indexing the exact record with `string` is a `tsc` error) | compile: missing key = error; consumer guard keeps the index sound |
| G | `frontend/app/api/runs/[slug]/manifest/route.ts:61` interface field + `:217` coercion | inline `{5 fields}` type + `{audio:!!sp.audio,…}` | type→`SelectedProducts`; coercion→`coerceSelection(sp)` | compile + helper |
| H | `frontend/lib/estimates.ts:10` `TIMES` **+ `estimateMinutes:33`** | literal `{base,audio,…,vendors}` **+ hand-unrolled `if (products.audio) total += TIMES.audio` loop** | type `TIMES` as `Record<StudioProductKey, number> & { base: number; vendors: number }` **AND refactor the loop to `for (const k of STUDIO_PRODUCT_KEYS) if (products[k]) total += TIMES[k]`** | compile (literal) **+ structural (loop iterates canonical)** |
| I | `frontend/app/new/[id]/page.tsx:75` `DELIVERABLES` | `{key: keyof SelectedProducts; …}[]` (UI order, full set) | annotate `key: StudioProductKey`; add a **test-time** completeness check (set of `.key` == `StudioProductKey`) | test: coverage assertion (order preserved) |
| J | `frontend/components/new-research/StepProducts.tsx:9` `PRODUCTS` | `[{key:"audio" as const,…}] as const` (UI order, full set) | same as I | test: coverage assertion |
| K | `frontend/components/new-research/StepReview.tsx:10` `PRODUCT_META` **+ consumer :220/:221** | `Record<string, Meta>`, indexed by a `string` key from `selectedProducts.map(([key]) => PRODUCT_META[key])` | tighten map to `Record<StudioProductKey, Meta>` **AND** narrow the consumer key via `isStudioProductKey(key)` (same `Object.entries` string-key issue as F; the existing `if (!meta) return null` guard becomes provably-dead under the exact record, so the narrow replaces it) | compile: missing key = error; consumer guard keeps the index sound |
| **L** | `frontend/lib/validate.ts:340` `studioRecoveryPayloadSchema` **`.max(5)`** (:351) | hardcoded array-length cap = product count (comment: "capped at the 5 studio products") | `.max(STUDIO_PRODUCT_KEYS.length)` | runtime-bound tied to canonical length (a 6th product no longer rejects a valid 6-product recovery) |
| **M** | `frontend/lib/files.ts:24` `ProductType` union **+** `:99` `KNOWN_PRODUCTS` Set | superset literals (studio 5 **+** `brief,perplexity,notebooklm,comparison,vendor-evaluation`[+`state` in the Set]) used by `resolveProduct()` to strip filename suffixes | spread-derive the studio portion: `type ProductType = StudioProductKey \| "brief" \| …`; `KNOWN_PRODUCTS = new Set<string>([...STUDIO_PRODUCT_KEYS, "brief", …, "state"])` | compile (union) + the spread (a new product is auto-included in both) |

Sites A, F, G, H, K, M become **compile-enforced** (a `Record<StudioProductKey,…>`, the
`SelectedProducts` type, or a `StudioProductKey | …` union / `[...STUDIO_PRODUCT_KEYS, …]`
spread forces every product key present). Sites D, E, G use the shared
`emptySelection()`/`coerceSelection()` helpers (one definition, many call sites). Sites
B, C use a compile-time assertion (§4). Sites I, J keep their display-ordered arrays and
get a **test-time** completeness check (a `Record` would destroy the intentional UI
order; an array can't be compile-forced to be exhaustive, so a test is the right tool).
Site H additionally needs a **structural loop fix** (§5 rule 5) — typing the `TIMES`
literal forces the literal to be complete but does **not** force the consuming
`estimateMinutes` body to read the new key; the hand-unrolled `if`s must become a loop
over `STUDIO_PRODUCT_KEYS`. Site L is the one **runtime-bound** mirror (a Zod length cap).

---

## 4. The Zod tension (sites B, C) — explicit design decision

`selectedProductsSchema`/`selectedProductsBaseSchema` are the **runtime validation
surface** for the wire payload and the react-hook-form registration. Two candidate
treatments:

- **(rejected) Derive the schema:** `z.object(Object.fromEntries(STUDIO_PRODUCT_KEYS.map(
  k => [k, z.boolean().default(false)])))`. This single-sources the *literal* but
  **loses Zod's precise inferred output type** (`z.infer` widens to `Record<string,
  boolean>`), which `FormData`, `selectedProducts` field paths, and `react-hook-form`'s
  `register("selectedProducts.${key}")` all depend on. Higher blast radius, on a
  validation surface — not worth it.
- **(chosen) Keep the explicit Zod literal + a compile-time key-parity assertion.**
  Codex grounded probe (v3) confirmed Zod 4.3.6 **preserves the key set through
  `.refine()`**, so `keyof z.infer<typeof selectedProductsSchema>` yields the product-key
  union (the assertion is well-founded). BUT the assertion FORM must not be vacuous — a
  bare `type _X = AssertExact<…>` that resolves to `never` does **not** fail `tsc` (a type
  alias to `never` is legal). Use the **value-assignment** form, which DOES error on
  mismatch:
  ```ts
  // AssertExact resolves to `true` iff A and B are mutually assignable, else `false`.
  type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

  // Fails `tsc` if the Zod keys ever drift from the canonical StudioProductKey set:
  // when AssertExact resolves to `false`, `= true` is a type error.
  const _selectedProductsKeysInSync: AssertExact<
    keyof z.infer<typeof selectedProductsSchema>, StudioProductKey> = true;
  const _selectedProductsBaseKeysInSync: AssertExact<
    keyof z.infer<typeof selectedProductsBaseSchema>, StudioProductKey> = true;
  ```
  (Resolving to `false`, not `never`, is deliberate: `const x: never = true` *also* errors,
  but `false` makes the failure mode legible and the helper reusable.) This preserves Zod's
  exact inference (zero blast radius on the consuming types) while making a drifted schema a
  **hard `tsc` error**. The literal text isn't derived, but the *invariant* (the key set)
  is single-sourced — which is the property that actually matters. The parity test
  additionally pins the runtime list. A sensitivity test (a deliberately-drifted local
  schema asserted to fail) proves the guard is non-vacuous.

**Open question for reviewers:** is "single-source the invariant, not the literal" an
acceptable bar for sites B/C, or is the residual hand-authored Zod literal a drift risk
the assertion fails to cover? (The assertion covers *missing/extra keys*; it does not
cover a *typo'd key* — but a typo'd key is also a missing+extra pair, so it IS caught.)

---

## 5. Hard design rules (tier-specific)

1. **No module-load throw in any frontend module.** Client components import these;
   a load-time throw crashes the page. Enforce by compile-time types + test-time
   assertions ONLY. (Contrast: the agent canonical throws at module load because
   fail-fast at daemon startup is correct there.)
2. **`studio-products.ts` stays dependency-free.** Any import (especially a transitive
   `fs` puller) re-opens the edge/client bundle hazard. The parity test should assert
   the module is importable in isolation (it is, if it has no imports).
3. **Behavior-preserving.** Every treatment must produce the byte-identical runtime
   result for current inputs: `coerceSelection` ≡ the hand `{audio:!!x.audio,…}` maps;
   `emptySelection()` ≡ `{audio:false,…}`; the Zod schemas validate/transform
   identically (the `.refine` "at least one product" stays on `selectedProductsSchema`).
4. **OUT sites stay out** (§6) — but "different *set*" is not the test; "not a
   load-bearing studio-product coverage/resolution role" is (§6). A superset whose
   studio-portion IS load-bearing is IN via spread, not OUT.
5. **A `Record<StudioProductKey, V>` type forces the *literal* to be complete — it does
   NOT force *consuming logic* to read every key.** Any hand-unrolled per-product
   consuming loop (`if (products.audio) …; if (products.video) …`) over a load-bearing
   computation must be refactored to iterate `STUDIO_PRODUCT_KEYS`, or a new product
   compiles cleanly while being silently dropped from the computation (the
   `estimateMinutes` ETA bug, Site H). Compile-complete data ≠ compile-complete behavior.
6. **Tightening `Record<string, V>` → `Record<StudioProductKey, V>` shifts the type
   burden onto consumers that index it with a `string` key** (typically from
   `Object.entries(selectedProducts)`, where `selectedProducts` is a loose
   `Record<string,boolean>`). Indexing an exact record with a `string` is a `tsc` error.
   Narrow the key first with `isStudioProductKey(k)` (the hermetic module exports it for
   exactly this) — do NOT cast with `as StudioProductKey` (that re-opens the unsafe index
   the tightening was meant to close). Sites F, K. This is why the consumer sites are part
   of the treatment, not just the map declaration.

---

## 6. Principled OUT-of-scope boundary

Documented so reviewers judge the *line*, not just the in-scope edits (the grounded lens
finds "mirrors" in waves; pre-stating the boundary is what converges the gate — DR S170).

**The boundary rule (refined in v2): a site is IN iff its studio-product key enumeration
plays a load-bearing COVERAGE / ITERATION / RESOLUTION role — i.e. drift there silently
changes which products get processed, validated, displayed, or resolved.** Being a
*superset* does NOT make a site OUT (the studio-portion is still single-sourced via
spread — Site M `files.ts`). A site is OUT only when the studio products are NOT
enumerated as a coverage set, OR a missing product surfaces LOUDLY (default/throw/empty)
rather than silently.

- **`frontend/app/runs/[slug]/gallery/page.tsx` `MediaType`** (`audio|video|image|slides|
  markdown`) + `toMediaType`/`classifyExt`/`TYPE_ICON`/`TYPE_LABEL` — keyed by
  **render-kind derived from file EXTENSION**, not by product (verified: `toMediaType`
  switches on `entry.type` = the ext-derived `FileType`; `classifyExt` switches on the
  extension). It is a many-products-to-render-kind collapse (`report`→`markdown`,
  `infographic`→`image`); it does not enumerate the product set. A new product surfaces
  LOUDLY (unrenderable → `null`/default, not a silent miscount). **OUT.**
- **`frontend/lib/files.ts` `EXT_TO_FILE_TYPE` / `CONTENT_TYPE_MAP`** — keyed by file
  **extension**, with a graceful `?? "markdown"` fallback. Not a product set. **OUT.**
  (Contrast Site M `ProductType`/`KNOWN_PRODUCTS` in the SAME file, which ARE product-name
  sets driving `resolveProduct` → IN.)
- **Loose `Record<string, boolean>` typings** of `selectedProducts` (`page.tsx:35`,
  `hooks/useRunState.ts:46`, `app/api/runs/route.ts:34`, `app/api/state/route.ts`,
  `VendorTabs.tsx`) — generic *value readers* (`Object.entries`/`Object.values(...).
  filter(Boolean)`). They list **no** product-key literal, so they cannot drift.
  Optionally tightenable to `SelectedProducts` for clarity, but **not required** and
  not a drift risk — left OUT to keep the change minimal and behavior-locked.
- **Prose** (`StepReview.tsx:323` "audio, video, slides, report, infographic"), code
  comments — not load-bearing key sets.
- **Test fixtures** (`attachments.test.ts` `{report:true}` partials) — `Partial`
  selections by design.

---

## 7. Risks & mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| New module accidentally imported into agent graph / wrong tier | Low | It's frontend-only, zero imports; agent has its own canonical. Parity test imports it but from repo root (not the agent bundle). |
| `tsx`-only parity test masks a real `tsc` error in `studio-products.ts` | Low | The module IS inside `frontend/` tsconfig, so `pnpm -C frontend tsc --noEmit` (already in `pnpm test`) typechecks it. Only the cross-root *parity test file* is tsc-exempt. |
| Zod `satisfies`/`AssertExact` assertion is vacuous (always true) | Med | Add a deliberately-drifted negative case in a `// @ts-expect-error` test or a sync unit test, proving the assertion is non-vacuous (S165 precedent: `studio-products-sync.test.ts` sensitivity tests). |
| `coerceSelection` changes a coercion edge (e.g. `!!raw?.[k]` vs `!!sp.audio`) | Low | Identical operation; covered by behavior-preservation + existing route tests. `raw?.[k]` with a missing key → `undefined` → `!!` → `false`, same as the explicit map. |
| Next 16 client bundle rejects the new import path | Low | Zero deps, plain TS const+types; nothing bundler-hostile. Verified at MERGE via `next build` (Vercel) + local `tsc`. |
| Scope creep at MERGE (13 sites, 9 files) | Med | This DESIGN doc freezes the site list + treatments; MERGE implements exactly these, re-sweeps once for new mirrors, runs the full §11 gate. |
| A consuming-loop drift like Site H exists elsewhere (compile-complete data, hand-unrolled behavior) | Med | §5 rule 5 is now a stated invariant; the MERGE re-sweep + Codex grounded pass specifically hunt hand-unrolled per-product loops, not just literal key sets. |

---

## 8. Test plan (for the MERGE gate)

- `frontend/lib/__tests__/studio-products.test.ts` (NEW, run via the frontend suite):
  `emptySelection()` shape/all-false; `coerceSelection` matrix (missing key, extra key,
  truthy/falsy coercions) ≡ old maps; `isStudioProductKey` accept/reject;
  `STUDIO_PRODUCT_KEYS` frozen/exact.
- `test/studio-products-parity.test.ts` (NEW, repo-root): set-equality + order pin
  against agent `STUDIO_PRODUCT_LIST` (§2.2).
- Completeness checks for `DELIVERABLES`/`PRODUCTS` (sites I/J): set of `.key` ===
  `StudioProductKey` set (a unit test, since arrays can't be compile-forced exhaustive).
- Negative/sensitivity case proving the Zod key-parity assertion is non-vacuous.
- **Site H consuming-loop:** an `estimateMinutes` test asserting EACH product's minutes
  contributes (e.g. enabling only `video` adds `TIMES.video`), so the structural loop fix
  is pinned — a regression to hand-unrolled `if`s that drops a key would fail.
- **Site L:** `studioRecoveryPayloadSchema` accepts an array of length
  `STUDIO_PRODUCT_KEYS.length` and rejects one longer (pins the cap to the canonical count).
- **Site M:** `resolveProduct`/`KNOWN_PRODUCTS` covers every `StudioProductKey` (a new
  product is recognized + suffix-stripped); `ProductType` still admits the non-studio
  extras. Assert `KNOWN_PRODUCTS ⊇ STUDIO_PRODUCT_KEYS`.
- **F/K render-path extra-key test:** assert a stale/extra key in `selectedProducts` is
  silently SKIPPED (not rendered, not thrown) at both the `page.tsx` and `StepReview.tsx`
  consumers — the `isStudioProductKey()` narrow now carries the skip that K's
  (type-dead-after-narrow) `if (!meta) return null` used to. (3rd-lens MINOR.)
- **Runtime-freeze pin:** assert `Object.isFrozen(STUDIO_PRODUCT_KEYS)` + exact length,
  mirroring the agent canonical's `Object.freeze`.
- Full `pnpm test` green (agent suite unchanged — 663 measured S171; frontend grows by the
  new suites); `tsc --noEmit` both tiers; storage-path grep guard.
- MERGE deploy = frontend → Vercel auto-build. **No worker restart, no DB.** (Confirms
  this is NOT the agent/-prod-hard-rule path; still ARCHITECTURE-labeled → full §11.)

---

## 9. Decision summary

Build `frontend/lib/studio-products.ts` (hermetic: `STUDIO_PRODUCT_KEYS` tuple,
`StudioProductKey`, `SelectedProducts`, `emptySelection`, `coerceSelection`,
`isStudioProductKey`) as the frontend SoT; guard it against the agent canonical with a
repo-root behavioral parity test wired into `pnpm test`; refactor the **13 IN sites** to
derive from it — compile-enforced `Record`/type/union/spread where possible, shared
helpers for coercion/default, compile-assertion for Zod, **a structural loop fix for the
`estimateMinutes` consumer (§5 rule 5)**, the canonical-length cap for the Zod recovery
schema (Site L), the spread-derived superset for `files.ts` (Site M), and test-time
coverage for the two display arrays; hold the documented OUT boundary (judged by
*load-bearing coverage role*, not "different set"); enforce the invariant ONLY at compile
+ test time, never at client runtime. Net effect: a Studio-product change in
`conventions.json` becomes a single-edit-then-follow-the-failures operation across BOTH
tiers, with no silent-drift path.

---

## 10. DESIGN-gate outcome (§11 tri-vendor, sequential)

**CLEARED — unanimous on the final state (v3).** Full synthesis:
`studio-products-frontend-single-source-design-gate-peer-review.md`.

- **Gemini 3.1 holistic-adversarial (v1):** BLOCK → 3 CRITICALs, all verified against code
  and integrated into v2 (missed Site L `.max(5)`; Site H consuming-loop enforcement gap;
  `files.ts` reclassified OUT→IN as Site M). Endorsed the architecture, the Zod approach,
  and the parity-test design.
- **Codex gpt-5.5 xhigh grounded-adversarial (on integrated v2):** BLOCK → 1 CRITICAL +
  2 MAJOR, all mechanism bugs in treatments, integrated into v3 (vacuous Zod assertion FORM
  → value-assignment form; queue.ts re-export path `./`→`../`; F/K `Record` tightening needs
  `isStudioProductKey` consumer-narrowing). Validated all 13 sites exist as cited, the
  Gemini trio, M's exact members, bundle isolation, the parity pattern, behavior-equivalence,
  and a clean re-sweep.
- **Claude grounded subagent (3rd lens, on v3):** ENDORSE. Independently re-swept (no missed
  mirror), **tsc-probed the v3 Zod fix** (proved non-vacuous; the rejected form vacuous),
  runtime-probed `coerceSelection`/`emptySelection` (byte-identical incl. order), judged the
  OUT boundary (all hold; gallery `MediaType` correctly OUT), confirmed bundle isolation +
  ran the existing parity test to prove the wiring. 3 non-blocking MINOR/INFO notes folded
  into §2.1 (runtime freeze) + §8 (F/K extra-key test, freeze pin).

**Next: the MERGE gate** (separate session) implements the 13 sites + 2 new artifacts and
runs its own full §11 tri-vendor MERGE gate on the actual code (ARCHITECTURE-labeled;
frontend → Vercel, no worker restart, no DB).
