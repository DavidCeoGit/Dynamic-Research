# S147 — agent/ dev-tooling bump (`@types/node`, `typescript`) — MERGE-gate peer review

**Date:** 2026-06-20 (S147)
**Gate:** MERGE · Risk Labels: DEPENDENCY · Severity: NORMAL · Topology: sequential Gemini → Codex → Codex-QA (BEFORE merge)
**Why gated:** CLAUDE.md §11 HARD RULE — any `agent/` change on the path to the production worker (`DynamicResearchWorker` cron → `DR-Deploy` clone → live daemon) clears a full tri-vendor gate before merge. User explicitly elected the full gate over the "dev-only, runtime-identical → exempt" reading.
**Reviewers:** Gemini `gemini-2.5-pro` (holistic-adversarial, via @google/genai SDK — CLI OAuth tier dead per [[feedback_gemini_cli_oauth_tier_deprecated_use_sdk]]); Codex `codex exec -s workspace-write` (grounded-adversarial, ChatGPT auth — no API-key flip needed).
**Logs:** `c:/tmp/dr-s147/{gemini,codex,codex-qa}.log`. Packet: `c:/tmp/dr-s147/gate-packet.md`.

## Change under review
`agent/package.json` devDependencies only (+ regenerated `agent/pnpm-lock.yaml`):

| dep | before | final (v3) |
|---|---|---|
| `@types/node` | `^20` | `~24.12.0` (resolves 24.12.4) |
| `typescript` | `^5` | `^6` (resolves 6.0.3) |

No source/runtime-dependency/config changes.

## What each reviewer saw
- **Gemini (holistic):** the gate packet (change, runtime architecture, verification, deploy plan). Whole-artifact reasoning, not file:line.
- **Codex (grounded v2 + QA v3):** the live working tree — `agent/package.json`, `agent/pnpm-lock.yaml`, `agent/node_modules/.../@types/node/v8.d.ts`, root `package.json` test script, agent source grep. Ran an executable counterexample against the real `tsc` + `tsx` runtime.

## Findings & resolution

### CRITICAL — `@types/node` ahead of the runtime Node version (gate-integrity hole)
- **Gemini v1 (BLOCK):** `@types/node@25` describes the Node-25 API surface while the prod host runs Node 24.x. The `tsc --noEmit` gate would then *approve* code using Node-25-only APIs that crash at runtime — a "drifting types" trap that weakens the gate's protective value. The diff's own "zero runtime delta" claim is true, but the gate's *future* safety guarantee is degraded.
- **Integration v2:** pinned `@types/node ^25 → ^24` to match the runtime major.
- **Codex v2 (BLOCK) — proven, at minor granularity:** `^24` resolves `24.13.2`, but the host is Node **24.12.0**. `@types/node@24.13.2` declares `GCProfiler[Symbol.dispose]()` (`@since v24.13.0`). Codex wrote a temp `agent/*.ts` using it → passed `tsc --noEmit` → threw `TypeError: profiler[Symbol.dispose] is not a function` under the real `node --import=tsx` runtime on Node 24.12.0. Same hole as Gemini's, one granularity finer. Correct invariant: **`@types/node` major.minor ≤ runtime Node major.minor**. (Note: the original `^20` was the *safe* direction — types behind runtime never falsely approve a missing API.)
- **Integration v3:** pinned `@types/node ~24.12.0` (>=24.12.0 <24.13.0 → 24.12.4) to match the host minor.
- **Verification (independent + reviewer):** Claude-author reproduced Codex's counterexample under v3 → `tsc` now ERRORS `Property '[SymbolConstructor.dispose]' does not exist on type 'GCProfiler'`. **Codex v3 QA ENDORSE** confirmed file:line: pin is `~24.12.0`, lock resolves 24.12.4 (not 24.13.x), counterexample rejected, `pnpm test` 514/514, temp file cleaned.

### MAJOR — TS 5→6 inference changes could mask a latent runtime bug (Gemini) — NON-BLOCKING
Generic to any major TS upgrade; no concrete instance produced. Accepted bar for a dev-tooling bump is full suite + `tsc --noEmit` green, which holds (514/514). `typescript` is not on the agent runtime path (Codex grounded: no `from "typescript"`/`require("typescript")`; `pnpm why typescript` = root devDep only; `tsx` transpiles via its own esbuild). Documented, not actioned.

### MAJOR — no-restart leaves on-disk source diverged from the running daemon (Gemini) — ACTIONED in deploy
Honored: deploy includes `DR-Deploy` resync + `pnpm -C agent install` + a worker restart (when idle) + preflight-green verification, so the validated on-disk state matches a freshly-initialized process.

### INFO — lockfile regen touches a production-reachable type resolution (Codex)
`@google/genai → protobufjs → @types/node 24.12.4` + `undici-types 7.18.2`. Declarations-only for runtime; no executable runtime-tree change. Acknowledged, non-blocking.

## Verdicts
- Gemini v1: **BLOCK** (1 CRITICAL, 2 MAJOR, 1 INFO) → integrated.
- Codex v2: **BLOCK** (1 CRITICAL proven, 1 INFO) → integrated.
- Codex v3 QA: **ENDORSE**.
- Claude-author: cleared (independent counterexample-closure reproduction + suite green).

**Gate result: CLEAR for merge.**

## Deploy (agent/ → prod worker)
1. Squash-merge `chore/s147-agent-types-ts` → main.
2. `git -C C:\Users\ceo\Projects\DR-Deploy pull origin main` + `pnpm -C agent install`.
3. Restart worker WHEN IDLE (verify no job mid-flight): kill detached node worker PID → `Start-ScheduledTask DynamicResearchWorker`; confirm fresh PID + preflight all-green in `DR-Deploy/agent/worker.log`.

## Durable lesson
`@types/node` must be pinned ≤ the runtime Node major.minor (here `~24.12.0` for host Node 24.12.0); a higher `@types/node` silently disables the `tsc` gate's ability to catch use of not-yet-available Node APIs. The same drift exists in the already-merged **frontend** `@types/node@25` (PR#34) — follow-up: re-pin frontend to match Vercel's Node version. New memory: `feedback_types_node_must_not_exceed_runtime_node`.
