# MERGE-gate peer review — single-source the agent-side studio product-key mirrors (S169–S170)

**Chip:** task_7486732e · **Sessions:** S169 (core) → S170 (round 3 + gate close) · **Date:** 2026-06-24
**Status:** ✅ TRI-VENDOR GATE CLEARED (unanimous ENDORSE on the final state) — merged to prod.

## Classification (MRPF)
- **Event Gate:** MERGE (agent/ production code reaching the live worker daemon).
- **Risk Labels:** ARCHITECTURE (single-source contract across modules) + AGENT BEHAVIOR (the
  plan-synthesizer LLM prompt is on the change surface; byte-identity is the behavioral-risk axis).
- **Severity Mode:** NORMAL.
- **Topology:** sequential; full tri-vendor required BEFORE merge per `~/CLAUDE.md` §11 HARD RULE
  (agent/ PROD deploys hold until Gemini + Codex + Claude all clear — no substitutes).
- **Automated-test question (required for ARCHITECTURE/AGENT BEHAVIOR):** YES — covered by a dedicated
  17-test suite (`agent/test/studio-products-single-source.test.ts`) pinning byte-identity + non-vacuous
  drift throws, plus the pre-existing `studio-products-sync.test.ts` guarding the JSON↔union canonical.

## What changed
Single-source ALL load-bearing AGENT-SIDE studio product-key mirrors against the S165 canonical
`STUDIO_PRODUCT_LIST` (`agent/lib/plan-types.ts`, a frozen readonly array derived from conventions.json;
precise `StudioProduct` union anchored by the private `STUDIO_PRODUCT_KEYS` tuple). A product added to
conventions.json can no longer silently drift out of any agent code path.

Six edited sites + one new test:
1. `agent/lib/studio-completeness.ts` — `STUDIO_ORDER` literal → `= STUDIO_PRODUCT_LIST`.
2. `agent/types.ts` — `interface SelectedProducts {5 booleans}` → `type = Record<StudioProduct, boolean>`
   + `import type { StudioProduct }` (runtime-erased; agent/ stays frontend-independent).
3. `agent/lib/plan-synthesizer.ts` — STUDIO_PRODUCTS_SLASH / STUDIO_SELECTED_ENUM / STUDIO_SELECTED_EXAMPLE
   derived above the digest; SCHEMA_HINT enum/example + digest prose interpolate them. **BYTE-IDENTICAL** prompt.
4. `agent/scripts/regenerate-studio-products.ts` — `assertProductDefsInSync()` at module load.
5. `agent/scripts/verify-gallery-vs-notebook.ts` (**round 3**) — `NLM_TYPE_TO_PRODUCT` VALUES are the verifier
   coverage set (its `Object.entries` loop); added `assertNlmTypeMapInSync()` at module load + an `isMain`
   guard (validations + `main()` run only on direct execution → testable import). CLI-type KEYS ("slide-deck")
   intentionally NOT derived (NotebookLM CLI arg names; no canonical source) — symmetric with #4.
6. `agent/lib/plan-types.ts` — comment-only (single-sourced-sites list now includes verify-gallery).
7. NEW `agent/test/studio-products-single-source.test.ts` — 17 tests.

## Principled IN/OUT boundary
**IN** (single-sourced): a product-key enumeration USED AS THE COVERAGE/ITERATION SET deciding which products
get processed/checked. Drift there = a new canonical product silently skipped. (All 6 above.)
**OUT** (deliberately not — each verified drift-safe by all three reviewers):
- `studio-completeness.ts:64` `PRODUCT_TO_NLM_TYPE` — value-map looked up inside a CANONICAL-driven loop
  (`for product of missing`, missing ← obligedProducts ← STUDIO_ORDER ← canonical) with a graceful
  `if(!nlmType){stillMissing.push;note;continue}` (:404). A new product surfaces LOUDLY, never silently dropped.
- `notify.ts:139/152/226` — human-readable EMAIL PROSE (not coverage logic; recovery logic reads failed
  products from STATE). At most MINOR prose drift.
- `cleanup-supabase-naming.py` / `conventions.py` — Python; outside the TS module graph.
- test fixtures (PRE_S169_* literals) — the non-vacuous oracle.
Also confirmed drift-safe (Claude re-sweep): `studio-winner.ts`, `lint-deliverables.ts:56` `Object.keys(STUDIO_PRODUCTS)`
— derive from the same canonical conventions Record.

## What each reviewer saw
- **Gemini 3.1 Pro (holistic, breadth):** full files (verify-gallery, studio-completeness, plan-types, regenerate,
  test) + unified diff + review context. v1 holistic ENDORSE on the core; v3 holistic ENDORSE on the final state.
- **Codex gpt-5.5 xhigh (grounded, depth, `-s workspace-write`):** the repo (read file bodies, ran `tsc` + `pnpm
  test` + direct-execution probes of the isMain refactor). Run banner asserted `model: gpt-5.5` + `reasoning
  effort: xhigh` each round (per `~/CLAUDE.md` §11 model-assertion rule).
- **Claude grounded subagent (depth, 3rd lens, zero authoring context):** the repo; ran counterexamples incl. the
  REAL Phase 6.5 prod invocation from `~/.claude/commands/research-compare.md:1206`, import-only side-effect probe,
  import-graph trace, `tsc`, full `pnpm test`.

## Gate log (3 rounds — Codex finds mirrors in WAVES)
| Round | Gemini (holistic) | Codex (grounded) | Outcome |
|---|---|---|---|
| v1 (core) | ENDORSE (0) | **BLOCK** — 2 CRITICALs (PRODUCT_DEFS coverage drift; plan-synthesizer digest prose drift) + 1 MINOR (stale comment) | fixed (round 2) |
| v2 (QA) | — | **BLOCK** — both v1 CRITICALs VERIFIED CLOSED; new CRITICAL (verify-gallery NLM_TYPE_TO_PRODUCT) + MINOR (notify prose) | fixed (round 3) |
| v3 (final) | **ENDORSE** (0) | **ENDORSE** (0) — verified verify-gallery closed; ran isMain refactor; boundary accepted; completeness re-sweep clean | + Claude subagent **ENDORSE** (0) → **MERGE** |

Codex's grounded depth lens earned §11 AGAIN: it BLOCKED 3× on completeness/coverage seams that the holistic lens
did not surface, finding the mirrors in waves (array → Record-keys → digest prose → reverse-map coverage set). The
final verify-gallery CRITICAL was a genuinely production-reachable mirror (Phase 6.5 via `claude -p`, `--strict`).

## Key adversarial confirmations (final state, all three lenses)
- **isMain does NOT fail-open:** `isMain` is reliably TRUE under the exact prod invocation (`node --import=tsx
  --env-file=.env scripts/verify-gallery-vs-notebook.ts ...`), including `%20`-encoded spaces in the repo path
  (both `import.meta.url` and `pathToFileURL(argv[1])` encode identically). Codex + Claude both ran it directly.
- **Module-load assertion is fail-CLOSED in the right direction:** a drift (developer code change) crashes the
  script/worker at startup; conventions.json changes already require a daemon restart, so this surfaces loud.
- **No TDZ/cycle:** `conventions.ts` imports only `node:{fs,path,url}` — zero back-edges; graph strictly acyclic.
- **Prompt byte-identical:** ENUM (comma-space), EXAMPLE (comma-no-space, `?` suffix), SLASH all reproduce the
  pre-S169 literals exactly; conventions key order == union order.
- **Type change safe:** no `extends`/`implements`/declaration-merge of `SelectedProducts`; `Record<StudioProduct,
  boolean>` structurally identical; the frontend twin is a SEPARATE, untouched, deferred mirror.
- **Build/tests green:** `tsc --noEmit` clean; `pnpm test` agent **663/663** + frontend **111/111**, 0 fail.

## Deferred follow-ups (own gates)
- **Frontend mirror single-source (~6 sites):** the frontend cannot import the Node-only canonical → needs a
  hermetic frontend mirror + a frontend parity test; own DESIGN gate.
- **Task 3:** executor.ts / studio-completeness.ts decomposition (DESIGN gate; multi-session).

## Verdict
**ENDORSE — unanimous tri-vendor on the final integrated state.** Merged to main; prod worker idle-restarted on
the new HEAD.
