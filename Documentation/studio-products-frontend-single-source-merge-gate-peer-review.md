# Frontend studio-product single-source — MERGE-gate peer review (synthesis)

> DR S172 (2026-06-24). Companion to `studio-products-frontend-single-source-design-gate.md`
> (the frozen DESIGN, cleared S171). This is the **MERGE gate** on the actual code.
> **Event Gate:** MERGE. **Risk Label:** ARCHITECTURE (cross-tier contract). **Severity:** NORMAL.
> **Topology:** §11 sequential — Gemini 3.1 holistic-adversarial → integrate → Codex gpt-5.5 xhigh
> grounded-adversarial → integrate → Claude grounded subagent (3rd lens).
> **Outcome: CLEARED, unanimous ENDORSE on the final state.**
> **Deploy:** frontend → Vercel auto-build. **NO worker restart, NO DB, NO agent/ change.**

## The change (14 files, +370/−80)
NEW `frontend/lib/studio-products.ts` (hermetic, zero imports, no module-load throw):
`STUDIO_PRODUCT_KEYS` (Object.freeze tuple), `StudioProductKey`, `SelectedProducts =
Record<StudioProductKey,boolean>`, `AssertExact<A,B>` (compile-time key-parity helper),
`emptySelection()`, `coerceSelection()`, `isStudioProductKey()`. NEW
`frontend/lib/__tests__/studio-products.test.ts` (helpers) + repo-root
`test/studio-products-parity.test.ts` (imports BOTH live exports, set+order equality; precedent
`test/publish-flag-parity.test.ts`). `package.json` wires both in. 13 IN sites (A–M) refactored
per design §3. Verified: `pnpm test` = agent **663** / frontend **125**, 0 fail; both-tier
`tsc --noEmit` clean; eslint clean on changed files.

## Two deliberate deviations from the frozen design (all 3 lenses validated)
1. **Sites I/J use a COMPILE-TIME exhaustiveness assertion, not the design's TEST-time check.**
   `DELIVERABLES`/`PRODUCTS` live in `"use client"` page/component modules using `@/` aliases +
   heavy client deps that the node `--test` harness (relative-import only) cannot load. Treatment:
   `as const satisfies readonly {key:StudioProductKey;…}[]` + `const _x: AssertExact<(typeof
   ARR)[number]["key"], StudioProductKey> = true;`. Enforces the SAME invariant more robustly (tsc
   + Vercel build, catches missing AND extra/typo), correcting the design's "arrays can't be
   compile-forced exhaustive" premise (false via union extraction).
2. **`AssertExact` exported from the hermetic module** (design showed it inlined in validate.ts).
   Type-only (erased) → module stays hermetic; single-sources the helper used by sites B/C/I/J.

## A real gap caught during implementation (by tsc, pre-gate)
**Site A** — the design's row-A treatment (a bare `export type { SelectedProducts } from
"../studio-products"`) FAILS `tsc` (TS2304): queue.ts USES `SelectedProducts` internally
(`ResearchJobPayload`, `ResearchJob`) and a bare re-export does not bind the name locally. Fixed:
`import type { SelectedProducts }` at top + `export type { SelectedProducts }` re-export. (Codex
independently reproduced the TS2304 on the bare form.)

## What each reviewer saw
- **Gemini 3.1 (holistic):** the frozen design + the full diff + full post-change versions of the
  new module, both new tests, the agent canonical `plan-types.ts`, and the mechanism-heavy libs
  (queue/validate/estimates/files). No repo access — reasoned over the pasted artifacts (~146K chars).
- **Codex gpt-5.5 xhigh (grounded):** the live repo (`-s workspace-write`, cwd = root) + free
  rg/sed/cat + ran `git diff HEAD`, `pnpm test`, and scratch tsc/node probes. Banner asserted
  `model: gpt-5.5` / `reasoning effort: xhigh`.
- **Claude grounded subagent (3rd lens):** the live repo; ran independent tsc non-vacuity probes,
  node runtime byte-identity probes against the shipped modules, parity drift-injection on scratch
  copies, `pnpm test`, eslint, and a full independent re-sweep. Zero authoring context.

## Round 1 — Gemini 3.1 holistic-adversarial → VERDICT: ENDORSE
7 INFO findings, all positive confirmations (no CRITICAL/MAJOR/MINOR): the I/J compile-time
deviation is sound and "strictly superior"; the exported `AssertExact` is hermetic-preserving; Zod
`.refine()` preserves the inferred key set (assertion well-founded + non-vacuous); the F/K
`isStudioProductKey` narrows are correct and skip stale keys without `as`; Site H loop fix is a
textbook §5-rule-5 execution; all 13 sites complete (incl. A re-export, L `.max(.length)`, M
spread); the parity test guards both drift directions. Nothing to integrate → v2 == v1.

## Round 2 — Codex gpt-5.5 xhigh grounded-adversarial → VERDICT: ENDORSE
CRITICAL/MAJOR/MINOR: none. Grounded counterexamples (all cited with commands):
- Scratch tsc probes: missing/add/typo Zod key → `TS2322` (non-vacuous); exact refined Zod
  compiled; the REJECTED bare `type _X = AssertExact<…>` form compiled on drift (vacuous, as the
  design warned); missing array key → `TS2322`; bare queue re-export → `TS2304`; `"state"` as
  `ProductType` → `TS2322` (confirms it is correctly Set-only).
- Runtime: `coerceSelection`/`emptySelection` byte+order identity; all 64 ETA combinations; all
  studio+extra `resolveProduct` cases; stale-key skip (no throw).
- `pnpm test` exit 0 (663 / 125). Parity sensitivity: missing-key + reversed-order both →
  `ERR_ASSERTION`. Confirmed an independent anchor exists (`agent/test/studio-products-sync.test.ts`)
  so parity is not only live-vs-live. Re-sweep: no missed mirror; gallery = render-kind/extension.
Nothing to integrate → v3 == v2.

## Round 3 — Claude grounded subagent → VERDICT: ENDORSE
Independent probes corroborated every claim (tsc non-vacuity incl. the I/J dual-layer:
`satisfies` catches typo, `AssertExact` catches missing; runtime byte+order identity incl. all 64
ETA combos; stale-key non-throw at F/K — `.includes()` even resists prototype-name keys; hermetic
isolation; parity guards both drift classes; tsc both tiers clean; full re-sweep no missed mirror).
**One MINOR** the other lenses missed:
- **MINOR — `frontend/lib/files.ts:101` stale comment** claimed "KNOWN_PRODUCTS ⊇ STUDIO_PRODUCT_KEYS
  is pinned by the unit test"; no such test exists — the superset is structurally guaranteed by the
  `[...STUDIO_PRODUCT_KEYS]` spread (a compile-time tautology). **FIXED** in this gate (comment-only;
  reworded to credit the spread). No code/behavior risk.

## Disagreements
None. All three lenses agree the behavior is preserved at every site, the sweep is complete, both
deviations are sound and non-vacuous, the parity test guards, and the hermetic module is import- and
throw-free. The only finding (a MINOR comment inaccuracy) was applied as suggested.

## Deploy
Commit (bundles the DESIGN + DESIGN-peer-review + this synthesis) → `gh pr create --base main` →
merge → Vercel auto-build of `frontend/`. NO worker restart, NO DB migration, NO agent/ change.
