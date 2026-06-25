# Frontend studio-product single-source — DESIGN-gate peer review (synthesis)

> DR S171 (2026-06-24). Companion to `studio-products-frontend-single-source-design-gate.md`.
> **Event Gate:** DESIGN (cross-tier contract). **Risk Label:** ARCHITECTURE. **Severity:** NORMAL.
> **Topology:** §11 sequential — Gemini holistic-adversarial → integrate → Codex
> gpt-5.5 xhigh grounded-adversarial (on integrated v2) → integrate → Claude grounded
> subagent (3rd lens, on v3). **Outcome: CLEARED, unanimous on the final state (v3).**

## What each reviewer saw
- **Gemini 3.1 (holistic):** the full v1 design doc + 11 pasted full files (agent canonical
  `plan-types.ts`, the `publish-flag-parity` precedent, and the 9 frontend mirror files).
  No repo access — reasoned over the pasted artifacts.
- **Codex gpt-5.5 xhigh (grounded):** the v2 doc in the live repo (`-s workspace-write`,
  cwd = project root) + free rg/sed over the whole tree; ran its own Zod-version + key
  probes. Banner asserted `model: gpt-5.5` / `reasoning effort: xhigh` (twice).
- **Claude subagent (grounded, 3rd lens):** the v3 doc + the live repo; ran **live `tsc`
  drift probes** (scratch schemas under /c/tmp) and a **runtime behavior-identity probe**,
  and executed the existing `publish-flag-parity.test.ts` to prove the parity wiring.

---

## Round 1 — Gemini 3.1 holistic-adversarial (v1) → VERDICT: BLOCK
Endorsed (INFO): the hermetic-module + repo-root-parity-test architecture over codegen; the
parity assertion logic (set+order, no hard-coded anchor needed since the agent side already
anchors the canonical); the Zod "keep literal + compile-time key assertion" approach.

Three CRITICALs — **all verified against the shipped code and integrated into v2:**
1. **Missed mirror — `studioRecoveryPayloadSchema.max(5)`** (`validate.ts:351`, comment
   "capped at the 5 studio products"). A length mirror of the product count; a 6th product
   would make the route silently reject a valid 6-product recovery payload. → **Site L**,
   treatment `.max(STUDIO_PRODUCT_KEYS.length)`.
2. **Enforcement gap — `estimateMinutes`** (`estimates.ts:33-37`). Typing the `TIMES`
   literal as `Record<StudioProductKey,number>` forces the literal complete, but the
   hand-unrolled `if (products.audio) total += TIMES.audio; …` consuming loop is NOT forced
   to read a new key → silent ETA exclusion. → **Site H** treatment must also refactor the
   loop to iterate `STUDIO_PRODUCT_KEYS`. Generalized as design **§5 rule 5**
   (compile-complete data ≠ compile-complete behavior).
3. **Boundary error — `files.ts` is load-bearing.** `KNOWN_PRODUCTS` drives
   `resolveProduct()` filename-suffix stripping; a new product omitted from it silently
   mis-resolves (breaks gallery grouping). Being a *superset* does not justify OUT. →
   **Site M** (OUT→IN), spread-derive: `ProductType = StudioProductKey | …extras`,
   `KNOWN_PRODUCTS = new Set([...STUDIO_PRODUCT_KEYS, …extras])`. Reframed the boundary
   rule: IN iff the studio-portion plays a load-bearing coverage/resolution role (§6).

Inventory grew 11 → 13 IN sites.

## Round 2 — Codex gpt-5.5 xhigh grounded-adversarial (on integrated v2) → VERDICT: BLOCK
Validated (grounded): all 13 IN sites exist exactly as cited; the Gemini trio is correct
(H loop real, L is the count mirror, M load-bearing via `resolveProduct`); M's exact members
(`ProductType` 10, `KNOWN_PRODUCTS` those + `"state"` — keep `"state"` Set-only); bundle
isolation holds (no frontend import of `plan-types`/`conventions`); the parity pattern is
valid (agent tsx loader, repo-root, `fs.readFileSync` fine under Node, set+order right, no
anchor needed); `coerceSelection`/`emptySelection` byte-identical; **re-sweep found no
missed mirror**; the OUT boundary is correct. Confirmed **Zod 4.3.6 preserves keys through
`.refine()`** (the assertion is well-founded).

One CRITICAL + two MAJOR — **all mechanism bugs in treatments, integrated into v3:**
1. **CRITICAL — vacuous Zod assertion FORM** (`§4`). `type _X = AssertExact<…>` that
   resolves to `never` does NOT fail `tsc` (a type alias to `never` is legal). → use the
   **value-assignment** form `const _x: AssertExact<…> = true;` with `AssertExact<A,B>`
   resolving to `true|false`, so `= true` errors on drift. Applied to both schemas.
2. **MAJOR — wrong re-export path** (`§3 row A`). `import("./studio-products")` from
   `frontend/lib/types/queue.ts` must be `"../studio-products"` (queue.ts is in `lib/types/`,
   the module in `lib/`).
3. **MAJOR — `Record` tightening breaks `Object.entries` consumers** (F `page.tsx:446/505`,
   K `StepReview.tsx:220/221`). Indexing an exact `Record<StudioProductKey,V>` with a
   `string` key (from `Object.entries(selectedProducts)`) is a `tsc` error. → narrow with
   `isStudioProductKey(k)` before indexing (NOT an `as` cast). Generalized as **§5 rule 6**;
   `isStudioProductKey` documented as the load-bearing consumer narrow.

## Round 3 — Claude grounded subagent (3rd lens, on v3) → VERDICT: ENDORSE
Independent depth pass; re-derived everything from shipped code. Key proofs:
- **§4 Zod fix proven non-vacuous via live `tsc`:** keys-match `= true` compiles (EXIT 0);
  drop/add/typo a key → `TS2322: Type 'true' is not assignable to type 'false'`; the REJECTED
  bare-`type` form compiles on drift (EXIT 0) — confirming the Codex CRITICAL was real and
  the value-assignment form is the correct remedy. Confirmed `keyof z.infer<schemaWith.refine>`
  yields the product-key union in this repo's Zod.
- **§3 row A path** `../studio-products` correct; **F/K** consumers verified (string keys from
  `Object.entries`), the `isStudioProductKey` narrow sound, **no other consumer** of the maps.
- **Behavior** `coerceSelection`/`emptySelection` byte-identical across {null, undefined, {},
  missing, extra, truthy/falsy, all-true/false} incl. key order.
- **OUT boundary** all hold; gallery `MediaType` correctly OUT (`toMediaType`/`classifyExt`
  switch on extension-derived render-kind, not product; a new product surfaces loudly).
- **Bundle isolation** zero `plan-types`/`conventions` frontend imports; ran the existing
  `publish-flag-parity` test → 2 pass (proves the cross-root tsx wiring).
- **Codegen rejection sound.**

Three non-blocking notes — folded in: runtime `Object.freeze` on the tuple (agent parity,
§2.1); an F/K render-path extra-key skip test + a freeze pin (§8); and a stale "agent 663"
count clarified as the S171-measured value (§8).

---

## Disagreements
None unresolved. Every Round-1 and Round-2 BLOCK finding was verified against the code and
integrated; the Round-3 lens independently confirmed the integrations work (tsc/runtime
probes) and found nothing blocking. The architecture, inventory (13 sites), OUT boundary,
and all three v3 mechanism fixes are agreed across all three lenses.

## Carry-forward to the MERGE gate (next session)
Implement the 13 sites + `frontend/lib/studio-products.ts` + `test/studio-products-parity.test.ts`
exactly per §3; run a fresh full §11 tri-vendor MERGE gate on the actual code (ARCHITECTURE);
re-sweep once more for new mirrors; `pnpm test` green + both-tier `tsc`. Deploy = frontend →
Vercel auto-build (NO worker restart, NO DB).
