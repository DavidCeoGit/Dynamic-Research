# MERGE-gate peer review — STUDIO_PRODUCTS single-source (audit 2026-06-24 HIGH #1)

**Session:** DR S165 (2026-06-24)
**Change:** `agent/lib/plan-types.ts` (+net ~78/-2) + NEW `agent/test/studio-products-sync.test.ts` (6 tests).
**Classification (MRPF):** MERGE gate · Risk labels: **ARCHITECTURE** (cross-module contract between `plan-types.ts` and `conventions.ts` — the canonical studio-product key set) · Severity **NORMAL** · agent/ PROD code → full tri-vendor gate mandatory BEFORE merge (CLAUDE.md §11 HARD rule).
**Topology:** sequential — Gemini (holistic-adversarial) → integrate → Codex (grounded-adversarial) → + Claude grounded subagent (kept). All three ENDORSED.

---

## The fix
Before: two same-named exports of incompatible shape — `plan-types.ts` had its own literal tuple
`STUDIO_PRODUCTS` (used with `.includes()`/`.join()` + as the `StudioProduct` union source), while
`conventions.ts:112` exports `STUDIO_PRODUCTS` = the Record `filename_patterns.studio.products`.
They could silently drift AND collided on auto-import.

After:
- `STUDIO_PRODUCT_KEYS` (private `as const` tuple) = irreducible compile-time TYPE anchor;
  `type StudioProduct = (typeof STUDIO_PRODUCT_KEYS)[number]` (unchanged precise 5-member union).
- `export const STUDIO_PRODUCT_LIST: readonly StudioProduct[] = Object.freeze(Object.keys(STUDIO_PRODUCT_DEFS) as StudioProduct[])`
  — public runtime list DERIVED from the conventions Record (single runtime source), frozen.
- `assertStudioProductsInSync(jsonKeys?, unionKeys?)` — set-based; THROWS on divergence; called at
  module load (fail-fast at worker startup) and re-asserted in the test (drift fails `pnpm test`).
- The plan-types export RENAMED `STUDIO_PRODUCTS` → `STUDIO_PRODUCT_LIST` so the name collision is gone.

**Irreducible constraint:** a precise `StudioProduct` union must be a static literal — TS cannot
project a literal union from `Object.keys()` of a JSON-loaded Record (widens to `string`). So the
static tuple is irreducible; drift is prevented by the assertion + test rather than eliminated.

## What each reviewer saw
- **Gemini (`gemini-3.1-pro-preview`, @google/genai SDK):** the design-rationale bundle + the full
  git diff + the FULL post-change `plan-types.ts` + the new test + the full `conventions.ts`. Holistic
  breadth lens, prompted to find the strongest BLOCK at the system level.
- **Codex (`codex exec -s workspace-write`, `model: gpt-5.5`, reasoning effort `xhigh`, ChatGPT auth,
  codex-cli 0.130.0):** the SHIPPED repo on disk (read file bodies, ran `tsc --noEmit`, ran the isolated
  test, ran an in-memory TS compiler probe + a runtime probe, grepped all importers). Grounded depth lens
  on the post-Gemini-integration v2.
- **Claude grounded subagent (opus, zero authoring context):** the shipped files on disk; ran tsc, the
  isolated test, the full agent suite, and a runtime module-load probe. Reviewed the pre-rename version
  (r2); its grounded checks are name-agnostic and the rename was mechanical + re-verified, so its ENDORSE
  carries to the integrated v2.

## Findings + resolution
| # | Reviewer | Sev | Finding | Resolution |
|---|---|---|---|---|
| G1 | Gemini | MAJOR | Both exports still NAMED `STUDIO_PRODUCTS` (incompatible shapes) → auto-import footgun; PR claim "eliminates the duplicate export" was false. | INTEGRATED: renamed plan-types export → `STUDIO_PRODUCT_LIST` (zero external importers; only internal `.includes`/`.join` + the new test updated). Comment/claim corrected. |
| G2 | Gemini | MINOR | Test #1 (`STUDIO_PRODUCTS == Object.keys(DEFS)`) was tautological (`Object.keys` vs `Object.keys`). | INTEGRATED: dropped it; the canonical-order test now pins BOTH `STUDIO_PRODUCT_LIST` and `Object.keys(STUDIO_PRODUCT_DEFS)` against the independent `EXPECTED_PRODUCTS` literal. |
| C-INFO | Codex | INFO | Broader product-key mirrors remain outside this bounded fix (`studio-completeness.ts:54`, `agent/types.ts:148`, `frontend/app/runs/[slug]/page.tsx:25`, `plan-synthesizer.ts:248` prompt text). | Pre-existing + partly explicitly deferred; does not undermine the plan-types↔conventions guard. Tracked as the broader "conventions.json → all mirrors sync-enforcement" DESIGN-gate follow-up. |
| CL-INFO | Claude | INFO | `Object.keys()` returns a non-frozen array (`readonly` only at type level). | INTEGRATED proactively: `Object.freeze()` added so the `readonly` annotation is true at runtime too. Not a regression (the old `as const` tuple wasn't frozen either). Codex runtime-probe confirmed `Object.isFrozen === true` + `push` throws. |

## Cleared claims (verified by ≥1 grounded lens against shipped code)
1. **No type regression** — `StudioProduct` is exactly `"audio"|"video"|"slides"|"report"|"infographic"`
   (Codex in-memory compiler probe). `pnpm -C agent exec tsc --noEmit` = 0.
2. **No behavior change** — conventions.json key order = `audio,video,slides,report,infographic`;
   `STUDIO_PRODUCT_LIST.join("|")` byte-identical to pre-S165 (Codex runtime probe).
3. **No import hazard** — every `plan-types.js` importer is agent-side Node
   (`api-client.ts:15`, `executor.ts:51`, `plan-reviewer.ts:35`, `plan-synthesizer.ts:34`,
   `plan-transports.ts:43`, tests); frontend has comments only (`validate.ts:359,381`, `queue.ts:212`).
   No edge/browser bundle pulls conventions.ts's fs.readFileSync.
4. **No circular import** — conventions.ts does not import plan-types.ts.
5. **ESM order sound** — module-load throw aborts evaluation; no consumer observes a drifted value.
6. **Module-load throw appropriate** — only fires on genuine code/config drift; conventions.json
   changes already mandate a daemon restart (§7).
7. **Guard not vacuous** — sensitivity test feeds superset/subset/renamed inputs → throws; reorder → ok.
8. **Python parity fine** — conventions.py reads the same JSON Record, not a separate literal.

## Verification
- `pnpm test` → agent **587** / frontend **102**, 0 fail; strict `tsc --noEmit` (agent + frontend) PASS;
  storage-path grep guard PASS. (Baseline 581 agent; +6 new sync tests.)
- Reviewer artifacts: `/c/tmp/dr-s165/{gemini.log, codex.log, codex-prompt.txt, gemini-review.mjs, review-context.md, plan-types.diff}`; Claude grounded subagent in the S165 transcript.

## Outcome
**MERGE APPROVED — unanimous tri-vendor ENDORSE on the integrated v2.** Worker restart (the prod-reaching
step) gated behind a per-instance user ASK per S165 standing auth.

## Follow-ups (out of scope; each its own gate)
- DESIGN gate: conventions.json → ALL product-key mirrors sync-enforcement (`STUDIO_ORDER` in
  studio-completeness.ts:54, `agent/types.ts:148`, `frontend/app/runs/[slug]/page.tsx:25`,
  plan-synthesizer.ts:248 prompt text). Codex/Gemini both flagged the mirror sprawl.
