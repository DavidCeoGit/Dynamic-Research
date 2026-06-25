# executor.ts / studio-completeness.ts Decomposition — DESIGN GATE

> **Event Gate:** DESIGN (cross-module boundary, new subsystem layout)
> **Risk Labels:** ARCHITECTURE (cross-module boundaries + contracts between major subsystems). Secondary: AGENT BEHAVIOR (the modules ARE the worker hot-path; a regression silently propagates to every research job).
> **Severity Mode:** NORMAL.
> **Reviewer topology (per `~/CLAUDE.md` §11):** sequential tri-vendor — Gemini holistic-adversarial → integrate → Codex gpt-5.5 xhigh grounded-adversarial → integrate → Claude grounded subagent. UNANIMOUS clear required.
> **Status:** v4 — **DESIGN GATE CLEARED (tri-vendor UNANIMOUS), S173 2026-06-25.** Sequential lenses: Gemini 3.1 holistic-adversarial BLOCK (v1) → Codex gpt-5.5 xhigh grounded-adversarial BLOCK (v2) → Claude grounded subagent BLOCK (v3) → fresh Claude grounded fidelity re-check **ENDORSE** (v4); every finding integrated + verified against the real code, `tsc` clean. See §14. DESIGN gate only — **NO code, NO merge, NO deploy.** The MERGE gate (the actual extractions, in 4 waves) is a later session (or sessions), each wave its own full §11 tri-vendor gate per the agent/ PROD HARD RULE.
> **Author:** Claude (S173).

---

## §0. TL;DR

`agent/executor.ts` (2,247 LOC) and `agent/lib/studio-completeness.ts` (747 LOC) are the two largest, most-edited, hottest-path files in `agent/`. Every recent agent/ MERGE gate (S162 strand-class, S166/S168 coercion guards, S170 single-source) had to navigate these monoliths, and the review surface is the whole file each time. This design extracts cohesive **pure-move** clusters into focused `agent/lib/` modules, shrinking `executor.ts` to its orchestration core (~850–950 LOC) and `studio-completeness.ts` to its gate core (~320 LOC), with **zero runtime-behavior change** and a **byte-unchanged production import surface** (`worker.ts → executeJob` is untouched). The extraction ships as 4 independently-mergeable waves, lowest-risk first.

**The prime directive:** this is a *refactor*, not a *redesign*. No control-flow change inside `executeJob`/`enforceStudioCompleteness`; we move their *callees* out, not restructure their bodies. The full 663-test agent suite must stay green at every wave with **only import-path edits** to tests — no assertion changes. If a wave cannot meet that bar, it is wrong and gets reworked, not merged.

---

## §1. Motivation — why decompose, why now, why safe

**Why.** `executor.ts` mixes seven distinct responsibilities in one file: job orchestration, plan-review gating, child-process lifecycle/cost-caps, state.json parse/validate, manifest+prompt construction, deliverable upload, and a studio-only regen path. `studio-completeness.ts` mixes the completeness gate with the NotebookLM CLI wrapper and timestamp/anti-stale parsing. Consequences observed in-repo:
- **Review cost.** Every agent/ MERGE gate re-reads a 2,247-line file to reason about a 30-line change. The tri-vendor gate (Gemini + Codex + Claude) pays this 3×.
- **Test isolation.** The orchestration hub `executeJob` (549 LOC) is *not* unit-tested (only worker integration covers it); the helper functions that ARE tested are buried in the monolith. `runPlanReviewGate` (187 LOC) has no direct unit test.
- **Consumer reach-in.** `studio-recovery-sweep.ts`, `regenerate-studio-products.ts`, and `studio-snapshot-diff.ts` all import the NLM-CLI seams (`realListArtifacts`/`realDownloadArtifact`/`NlmArtifactRef`/`DownloadResult`) by reaching *into* the big completeness module. They want a CLI module, not a gate.

**Why now.** The studio-product single-sourcing initiative (S165–S172) is complete; this is the next-largest tech-debt item and the handoff's standing recommendation. No competing agent/ work is in flight (tree clean at `c3436c2`). Doing it now, before the next behavior change lands in these files, means future agent/ gates review smaller surfaces.

**Why safe.** Three structural facts make this low-risk:
1. **Unidirectional coupling.** `executor.ts → studio-completeness.ts` only; `studio-completeness.ts` imports nothing from `executor.ts`. No circular risk today, and the target graph stays acyclic (§5).
2. **Single production importer.** `worker.ts:29` is the *only* non-test runtime importer of `executor.ts`, and it imports exactly one symbol: `executeJob`. `executeJob` does **not** move. So the daemon's load contract is byte-unchanged.
3. **Pure move discipline.** Every wave is a mechanical extraction — cut a function, paste it into a new module, add imports, update call sites. No logic edits. The behavior-preservation proof is the unchanged test suite (§9).

---

## §2. Current-state inventory

### 2.1 `executor.ts` — 2,247 LOC, 28 top-level symbols

| Cluster | Symbols | ~LOC | Tested by |
|---|---|---|---|
| **Orchestration core** | `executeJob` (549) | 549 | worker integration only |
| **Studio-only path** | `runStudioOnly`, `spawnRegenScript`, `readStudioFailureReason` | 163 | — |
| **Plan-review gate** | `runPlanReviewGate`, `buildReservationAdvisory`, `persistReviewerCalls`, `PlanReviewOutcome` (iface) | 237 | — |
| **Claude spawn + process control** | `spawnClaude`, `waitForProcess`, `estimateInFlightCostCents`, `buildClaudeSpawnEnv`, `shouldRecoverAfterDurationKill`, `CLAUDE_SPAWN_ENV_STRIP_KEYS` (const) | 270 | `executor-spawn-env`, `duration-kill-recovery` |
| **State eval + watch** | `watchStateFile`, `verifyPipelineCompletion`, `evaluateCompletion`, `summarizeStateProgress`, `readStateForRecovery`, `recoverableNotebookId`, `isNonPrimitiveStateField` | 214 | `state-coercion-guards`, `watch-state-progress` |
| **Manifest + prompt** | `buildManifest`, `buildPrompt` | 243 | `attachments`, `publish-brief`, `publish-gate` |
| **Upload** | `uploadOutputs` | 66 | `upload-set` |
| **Shared state / util** | `getSupabase` + `supabase` singleton (line 148), `notifyTerminal`, `log`, `sleep`, `envMs`, config consts (`WORKING_DIR`, `PROJECTS_DIR`, `PHASE_MAP`, `MAX_JOB_COST_CENTS`, `STUDIO_RECOVERY_*`, `PUBLISH_RISK_ACCEPT_DIR`, `DRY_RUN`, `SUPABASE_*`) | ~110 | — |

Module-level mutable state: **one** — `let supabase: SupabaseClient | null` (line 148), read via `getSupabase()` by `persistReviewerCalls` (234) and `uploadOutputs`. This is the one decomposition hazard: any module that moves out and still needs Supabase must get the client from a *single shared owner*, not a second singleton.

### 2.2 `studio-completeness.ts` — 747 LOC, ~24 top-level symbols

| Cluster | Symbols | ~LOC | Tested by |
|---|---|---|---|
| **Completeness gate core** | `enforceStudioCompleteness` (218), `obligedProducts`, `expectedArtifactId`, `defaultDeps`, `CompletenessDeps/Options/Result` (ifaces), `STUDIO_ORDER`, `PRODUCT_TO_NLM_TYPE` | ~320 | `studio-completeness` (~35 cases), `studio-products-single-source` (`obligedProducts`) |
| **NLM CLI wrapper** | `realListArtifacts`, `realDownloadArtifact`, `defaultDownloadSpawn`, `mangleWinPath`, `NLM_BIN`, `DEFAULT_DOWNLOAD_TIMEOUT_MS`, `DownloadSpawn` (type), `NlmArtifactRef` (type), `DownloadResult` (type) | ~190 | `studio-completeness` (real-spawn cases), reached by 3 other consumers |
| **Download-failure taxonomy** | `classifyDownloadFailure`, `TERMINAL_DOWNLOAD_PATTERNS` | 19 | `studio-completeness` |
| **Timestamp / anti-stale** | `buildCompact`, `parseTimestamp`, `deriveRunStart`, `artifactCreatedAtMs`, `safeMs` | ~60 | transitively (via gate tests) |

`spawnSync` seams (S162 strand-class, throw-guarded): `realListArtifacts:550` (own try/catch) and `realDownloadArtifact:663` (guards the injected `spawnImpl`). Both move *together* with the NLM-CLI cluster, preserving each guard verbatim.

### 2.3 Consumer map (the build-breakers if missed)

- **`executor.ts`** ← imported by `worker.ts:29` (`executeJob`, runtime) + 8 test files (helpers). research-compare.md skill references it by line for behavioral contracts (no import).
- **`studio-completeness.ts`** ← imported by `executor.ts:64` (`enforceStudioCompleteness`, `defaultDeps`), `studio-recovery-sweep.ts:37` (`realListArtifacts`, `realDownloadArtifact`, `NlmArtifactRef`, `DownloadResult`), `studio-snapshot-diff.ts:34` (`NlmArtifactRef` type), `scripts/finalize-recovered-run.ts:50` (`obligedProducts`), `regenerate-studio-products.ts:77` (`realListArtifacts`, `realDownloadArtifact`, `NlmArtifactRef`) + 5 test files.

---

## §3. Design principles (invariants every wave must hold)

1. **Pure move only.** Cut/paste functions verbatim. No logic edits, no signature changes except the *minimal* injection in principle 4. If a diff line changes behavior, the wave is wrong.
2. **Byte-identical production surface.** `worker.ts` keeps importing `executeJob` from `./executor.js`. `executeJob` and `runStudioOnly` stay in `executor.ts`. The daemon's static-import / module-load order (CLAUDE.md §7 conventions-restart contract) is unchanged.
3. **Acyclic dependency graph.** New `lib/` modules depend *downward* only (orchestration → helpers → shared substrate). No helper imports `executor.ts`. Verified in §5.
4. **Shared config module, NOT param injection (revised v2 — Gemini M3/M4).** A config constant used by BOTH a retained and a moved function must live in ONE shared owner so both sides keep reading it verbatim with **zero signature change**. Resolution: extract the env-derived config (`WORKING_DIR`, `PROJECTS_DIR`, `MAX_JOB_COST_CENTS`, `STUDIO_RECOVERY_MAX_MS/POLL_MS`, `PUBLISH_RISK_ACCEPT_DIR`, `DRY_RUN`, `SUPABASE_URL/KEY`, the `envMs` helper) into a new leaf module `lib/worker-config.ts`; both `executor.ts` and the extracted modules import from it. Moved functions keep their bodies byte-identical (`path.join(WORKING_DIR, …)` still resolves — `WORKING_DIR` is now imported). **This eliminates the param-injection of v1** (no `maxJobCostCents`/`phaseMap` params), so there is **no call-signature churn and tests need only import-path edits.** Two distinctions: (a) **static, non-env constants move WITH their sole consumer, not into worker-config** — `PHASE_MAP` is a hardcoded dict used only by the state cluster, so it moves into `lib/state-evaluation.ts` (putting it in worker-config or injecting it would be miscategorization + churn). (b) The NLM-CLI module's `NLM_BIN` (an env-or-default const that 3 other consumers expect to live with the CLI) moves *with* the CLI cluster, unchanged.
5. **Single Supabase owner.** Extract `getSupabase()` + the singleton to one shared module (`lib/worker-supabase.ts`); every mover that needs Supabase imports it. **No second `createClient` singleton** is introduced (would double-connect and diverge auth config).
6. **Test suite is the proof.** Each wave: full `pnpm test` green with only *import-path* edits to test files — zero assertion edits. A green run is the behavior-preservation certificate (§9).
7. **Preserve every guard verbatim.** The S162 `spawnSync` throw-guards, S160/S161 atomic-rename, S166/S168 coercion guards, S64 terminal-error classifier hooks — all move as-is, comments included. A decomposition that "tidies" a guard is out of scope.
8. **EOL discipline.** `agent/` is CRLF. Every promoted file matches the live file's EOL before `/promote` (per `feedback_sandbox_write_lf_vs_repo_crlf_phantom_diff`).
9. **Re-anchor file-location-relative paths (NEW v2 — Gemini C1).** A function that resolves a path from its OWN file location (`path.dirname(fileURLToPath(import.meta.url))`) is **NOT a verbatim pure-move candidate** — moving it from `agent/` to `agent/lib/` silently changes the resolved root by one directory. Every wave MUST audit `import.meta.url`/`__dirname` use in the symbols it moves. There is exactly **one** affected mover: `spawnClaude`'s `mcpProxyConfigPath` (executor.ts:1626 → `agent/mcp-proxy/mcp-config.json`). It is re-anchored by having `executor.ts` (stable at `agent/`) compute the path from ITS `import.meta.url` and pass it to `spawnClaude` as a parameter (the one allowed signature change in the whole decomposition; `spawnClaude` has no direct unit test, so no test breaks). `spawnRegenScript`'s `import.meta.url` (executor.ts:1139, resolving `scripts/regenerate-studio-products.ts`) is **safe and unchanged** — it STAYS in `executor.ts`.

---

## §4. Target architecture

### 4.1 `executor.ts` → 1 retained core + 8 new `agent/lib/` modules

| New module | Symbols moved in | ~LOC | Notes |
|---|---|---|---|
| **(retain) `executor.ts`** | `executeJob`, `runStudioOnly`, `spawnRegenScript`, `readStudioFailureReason`, the **line-998 telemetry `createClient`** (stays verbatim inside `executeJob` — distinct one-off client with default auth feeding `recordUsage`; NOT folded into the singleton, §6.1), local `log`/`sleep` | ~850–950 | Stays the worker entrypoint. **Now imports** `getSupabase` from `worker-supabase` (executeJob calls it at line 546) + env config from `worker-config` + all extracted helpers. `executeJob` body unchanged; only its callee/config *bindings* now come from imports. |
| **`lib/worker-config.ts`** (NEW v2) | `WORKING_DIR`, `PROJECTS_DIR`, `MAX_JOB_COST_CENTS`, `STUDIO_RECOVERY_MAX_MS/POLL_MS`, `PUBLISH_RISK_ACCEPT_DIR`, `DRY_RUN`, `SUPABASE_URL/KEY`, `envMs` | ~30 | Shared env-config owner (leaf). Imported by `executor.ts`, `claude-spawn`, `job-manifest`, `upload-outputs`, `worker-supabase`. Reads `process.env` once at load (same vars as today). NOT for static maps (`PHASE_MAP` goes with the state cluster — principle 4a). |
| **`lib/worker-supabase.ts`** | `getSupabase` + `supabase` singleton | ~18 | **Single owner of the lazy singleton.** Three consumers post-move: `executor.ts`/executeJob (line 546), `upload-outputs`, `plan-review-gate`. Imports `SUPABASE_URL/KEY` from `worker-config`. |
| **`lib/claude-spawn.ts`** | `spawnClaude`, `waitForProcess`, `estimateInFlightCostCents`, `buildClaudeSpawnEnv`, `CLAUDE_SPAWN_ENV_STRIP_KEYS`, `shouldRecoverAfterDurationKill` | ~270 | Imports `MAX_JOB_COST_CENTS` from `worker-config` (verbatim read; no param). `spawnClaude` takes a `mcpProxyConfigPath` param (the ONE signature change — principle 9 path re-anchoring; spawnClaude has no direct unit test). Tests `executor-spawn-env`, `duration-kill-recovery` re-point. |
| **`lib/state-evaluation.ts`** | `watchStateFile`, `verifyPipelineCompletion`, `evaluateCompletion`, `summarizeStateProgress`, `readStateForRecovery`, `recoverableNotebookId`, `isNonPrimitiveStateField`, **`PHASE_MAP`** (moves in — sole consumer) | ~216 | `PHASE_MAP` moves WITH this cluster (static dict, used only here — principle 4a). No param injection, no signature change. Coercion guards verbatim. Tests `state-coercion-guards`, `watch-state-progress` re-point. |
| **`lib/job-manifest.ts`** | `buildManifest`, `buildPrompt` | ~243 | Pre-spawn manifest + prompt. Imports `WORKING_DIR`/`PROJECTS_DIR` from `worker-config` (the closures Gemini M4 flagged — `buildManifest`'s `workDir` default param keeps `path.join(WORKING_DIR, …)` verbatim). Keeps `fenceValue`/`isPublishRequired` imports. Tests `attachments`, `publish-brief`, `publish-gate` re-point. |
| **`lib/upload-outputs.ts`** | `uploadOutputs` | ~70 | Imports `getSupabase` from `worker-supabase`, `selectUploadSet`, `uploadWithAudit`, and `PROJECTS_DIR` from `worker-config` if it reads it. Test `upload-set` re-points. |
| **`lib/terminal-notify.ts`** | `notifyTerminal` | ~28 | Wrapper over `notify.js`. Imported by `executor.ts` + `plan-review-gate`. |
| **`lib/plan-review-gate.ts`** | `runPlanReviewGate`, `buildReservationAdvisory`, `persistReviewerCalls`, `PlanReviewOutcome` | ~237 | **Highest-risk** (most cross-imports: `synthesizePlan`, `reviewPlan`, `makePlanReviewTransports`, `classifyTerminalError`, `markPendingTerminalExit`, `updatePlanReviewStatus`, `failJob`, `terminal-notify`, `worker-supabase`). Sequenced LAST; deferrable at MERGE time if risk/reward unfavorable. |

**Symbol lists are illustrative, not exhaustive (Claude m-3, v4):** each move row lists the principal functions; **cluster-local supporting types travel WITH their cluster.** Specifically — `KillReason` (executor.ts:1705) → `claude-spawn`; `StateWatcher` (1807), `ProgressSummary` (1842), `CompletionVerdict` (2005) → `state-evaluation`; `UploadResult` (2112) + `Uploader` (2125) → `upload-outputs` (the latter is re-pointed by `upload-set.test.ts`, §7). None of these types has an external importer except `Uploader` (handled), so they move silently with no consumer churn. The MERGE wave treats each cluster's symbol set as "all functions + all types only that cluster uses."

### 4.2 `studio-completeness.ts` → 1 retained core + 2 new modules

| New module | Symbols moved in | ~LOC | Notes |
|---|---|---|---|
| **(retain) `studio-completeness.ts`** | `enforceStudioCompleteness`, `obligedProducts`, `expectedArtifactId`, `defaultDeps`, `CompletenessDeps/Options/Result`, `STUDIO_ORDER`, `PRODUCT_TO_NLM_TYPE` | ~320 | Imports CLI + timestamp modules back. `executor.ts`/sweep call surface unchanged. |
| **`lib/nlm-artifact-cli.ts`** | `realListArtifacts`, `realDownloadArtifact`, `defaultDownloadSpawn`, `mangleWinPath`, `NLM_BIN`, `DEFAULT_DOWNLOAD_TIMEOUT_MS`, `DownloadSpawn`, `NlmArtifactRef`, `DownloadResult`, `classifyDownloadFailure`, `TERMINAL_DOWNLOAD_PATTERNS` | ~190 | **Highest-value** — serves 4 consumers (completeness gate, recovery-sweep, regenerate script, snapshot-diff type) **+ `studio-completeness.test.ts`** which imports `classifyDownloadFailure`/`realDownloadArtifact`/`DownloadResult`/`DownloadSpawn`/`NlmArtifactRef` and must split-re-point (§7, Codex CRITICAL). Both S162 spawn guards move verbatim. |
| **`lib/artifact-timestamps.ts`** | `buildCompact`, `parseTimestamp`, `deriveRunStart`, `artifactCreatedAtMs`, `safeMs` | ~60 | Pure functions; now directly unit-testable (currently only transitive). |

### 4.3 Re-export decision: **move + re-point, no barrel**

Two options for the moved symbols' consumers:
- **(A) Move + re-point imports** (CHOSEN). The 13 test files that import moved helpers update their import path to the new module home. `worker.ts` is *unaffected* (`executeJob` stays). The 3 non-test consumers of the NLM-CLI seams re-point to `lib/nlm-artifact-cli.js`.
- **(B) Move + re-export barrel** (`export { x } from "./lib/..."` in executor.ts). Zero import changes, but re-couples every consumer back to `executor.ts` and defeats the cohesion goal — the file stays a hub for symbols it no longer owns.

**Chosen: (A).** Rationale: the production surface (`worker.ts → executeJob`) is genuinely unchanged regardless, so (A)'s only cost is mechanical test/consumer import-path edits, which the green suite validates. (B)'s barrel is exactly the "everything routes through the monolith" coupling we're removing. (A) is the real decomposition. *(Reviewer decision point — see §12 Q1.)*

---

## §5. Dependency graph after full decomposition (acyclicity proof)

```
worker.ts                                            [L0 entry]
  └─ executor.ts            (executeJob, runStudioOnly)   [L1]
       ├─ lib/claude-spawn.ts ─────────────┐               [L2]
       ├─ lib/state-evaluation.ts          │  (PHASE_MAP lives here)
       ├─ lib/job-manifest.ts ─────────────┤
       ├─ lib/upload-outputs.ts ──────┬────┤
       ├─ lib/terminal-notify.ts      │    │
       ├─ lib/plan-review-gate.ts ──┐ │    │
       │     ├─ lib/terminal-notify.ts (shared)            [L3]
       │     └─ lib/worker-supabase.ts ┤                   [L3]
       ├─ lib/worker-supabase.ts ◀─────┘──────────────┐
       ├─ lib/studio-completeness.ts                  │   [L2]
       │      ├─ lib/nlm-artifact-cli.ts   (← sweep, regenerate, snapshot-diff) [L3 leaf]
       │      └─ lib/artifact-timestamps.ts (pure)        [L3 leaf]
       └─ lib/worker-config.ts ◀───────────────────────┘  [L4 deepest leaf]
            (process.env only; ← executor, claude-spawn, job-manifest,
             upload-outputs, worker-supabase)
```

**Layering (strict downward):** L0 `worker.ts` → L1 `executor.ts` → L2 helpers (`claude-spawn`, `state-evaluation`, `job-manifest`, `upload-outputs`, `plan-review-gate`, `studio-completeness`) → L3 leaves (`terminal-notify`, `worker-supabase`, `nlm-artifact-cli`, `artifact-timestamps`) → L4 deepest leaf (`worker-config`). The only inter-helper edge is `plan-review-gate → terminal-notify`; `terminal-notify` is classified **L3** (imports only `notify.js` + a local logger — nothing in L2), so that edge points strictly downward (L2→L3), not L2↔L2. `worker-supabase` (L3) imports only `worker-config` (L4) + `@supabase/supabase-js`. `worker-config` (L4) imports only `process.env` (a true leaf). **No extracted module imports `executor.ts`** (principle 3), and every edge points to a strictly deeper layer, so the graph is a **DAG** — no cycle is introduced. (The S162 `nlm-artifact-cli` is consumed by `studio-recovery-sweep`/`regenerate`/`snapshot-diff`, all of which sit beside or below L2 and none of which `executor.ts` depends on for *those* symbols — no back-edge.)

**Pre-existing edge to include (Codex MINOR, v3):** `executor.ts` already imports `studioRecoveryBackoffMs` from `lib/studio-recovery-sweep.ts` (executor.ts:68, used at :880/:921). So the real (pre- and post-decomposition) picture is `executor.ts → studio-recovery-sweep.ts → nlm-artifact-cli.ts` (the sweep re-points its `realListArtifacts`/`realDownloadArtifact`/types to nlm-artifact-cli in Wave A) **alongside** `executor.ts → studio-completeness.ts → nlm-artifact-cli.ts`. Both paths converge on the `nlm-artifact-cli` leaf; neither creates a back-edge to `executor.ts`, so the DAG holds. `studio-recovery-sweep.ts` is NOT decomposed here — it only re-points two import lines.

**Studio-leaf type-only edge (Claude m-1, v4):** the two studio leaves are NOT fully independent — `artifact-timestamps.ts` has `artifactCreatedAtMs(a: NlmArtifactRef)` (studio-completeness.ts:279), and `NlmArtifactRef` moves to `nlm-artifact-cli.ts`, so `artifact-timestamps.ts` carries `import type { NlmArtifactRef } from "./nlm-artifact-cli.js"`. This edge is **type-only** (the CLI cluster calls no timestamp function — verified one-directional), so it is erased at compile time and adds **no runtime cycle**; the DAG conclusion holds. `artifact-timestamps` has no *executor/gate* back-dependency (the sense in which §4.2/claim-6 call it "pure"), but it is not free-standing.

Substrate both subsystems already share (unchanged, all leaves): `conventions.ts`, `plan-types.ts`, `types.ts`, `studio-winner.ts`. These remain shared; nothing about them changes.

---

## §6. The two sensitive seams in detail

### 6.1 Supabase clients (`getSupabase` singleton + the telemetry client) — CORRECTED v2 (Gemini C2)
Today there are **TWO** `createClient` sites and **THREE** `getSupabase()` callers (verified):
- `getSupabase()` singleton (executor.ts:150-159) — lazy `createClient` with `{ auth: { persistSession:false, autoRefreshToken:false } }`. **Callers:** `persistReviewerCalls` (234, moves→`plan-review-gate`), **`executeJob`** (546, via `downloadAttachments(getSupabase(), …)` — STAYS in executor.ts), `uploadOutputs` (2148, moves→`upload-outputs`).
- A **second** `createClient(SUPABASE_URL, SUPABASE_KEY)` (executor.ts:998, default auth, no opts) inside `executeJob`'s `finally`, feeding `recordUsage` telemetry.

**Resolution:** move the lazy singleton + getter verbatim into `lib/worker-supabase.ts`. **All three callers import `getSupabase` from it — including `executor.ts` itself** (executeJob is a consumer; v1 wrongly omitted it). The line-998 telemetry client **stays verbatim inside `executeJob`** (it doesn't move because executeJob doesn't move) — it is an intentional, distinct one-off with *different* auth config; **folding it into the singleton is a logic/auth change and is OUT of scope.** So **within the executor.ts decomposition surface** there remain exactly **two** `createClient` sites post-move: the single lazy-singleton owner in `worker-supabase.ts`, and the executeJob telemetry client (Codex Q5 — repo-wide there are other unrelated `createClient` sites in `staging-sweep`/`studio-recovery-sweep`/scripts; this invariant scopes ONLY to the symbols this decomposition touches). **Anti-pattern explicitly forbidden:** giving each *singleton* mover its own `let supabase` (would multiply the lazy client). The invariant is "**one owner of the lazy singleton**," not "one createClient in the repo." This is the single most important correctness point of the executor decomposition.

### 6.4 File-location-relative path (`spawnClaude` mcp-proxy) — NEW v2 (Gemini C1)
`spawnClaude` builds the proxy config path as `path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-proxy", "mcp-config.json")` (executor.ts:1626). The real target is `agent/mcp-proxy/mcp-config.json`, anchored to `import.meta.url` === `agent/executor.ts`. **A verbatim move to `agent/lib/claude-spawn.ts` would re-root it to `agent/lib/mcp-proxy/…`** (nonexistent) → `--mcp-config` silently points at a missing file → the proxy is bypassed. **Resolution:** `executor.ts` (stable at `agent/`) computes `mcpProxyConfigPath` from ITS `import.meta.url` (the existing line-1626 computation stays in executor.ts) and passes it to `spawnClaude(...)` as a parameter. `spawnClaude` consumes the path instead of computing it. This is the **one** signature change in the entire decomposition; `spawnClaude` has no direct unit test, so nothing breaks. (`spawnRegenScript`, executor.ts:1139, also uses `import.meta.url` but STAYS in executor.ts, so it is unaffected — verified the *only* other `import.meta.url` site.)

### 6.2 `notifyTerminal` shared by three callers
`executeJob`, `runStudioOnly` (both stay in executor.ts), and `runPlanReviewGate` (moves to plan-review-gate) all call `notifyTerminal`. **Resolution:** extract `notifyTerminal` to `lib/terminal-notify.ts`; executor.ts and plan-review-gate both import it. It depends only on `notify.js`'s `sendCompletionEmail` + a logger — no executor-local state — so the move is clean. (Its sibling email senders `sendPlanReviewEmail`/`sendDeliveryDelayedEmail` are called directly from `executeJob`/`runPlanReviewGate`; they stay imported from `notify.js` at those sites — only the `notifyTerminal` *wrapper* extracts.)

### 6.3 `log`/`sleep` duplication is intentional
Several existing agent/ modules already define a private 3–4-line `log`/`sleep`. The design keeps that idiom: each new module that logs gets a local `log`/`sleep` rather than importing a shared util, matching the codebase and avoiding a new cross-module dependency for a trivial helper. *(Reviewer decision point — §12 Q2: accept duplication vs introduce `lib/log.ts`.)*

---

## §7. Consumer / public-surface impact (complete list)

**Production (runtime) — `worker.ts`:** UNCHANGED. Still `import { executeJob } from "./executor.js"`. This is the entire production import surface of executor.ts.

**Production (runtime) — studio-completeness consumers (re-point in Wave A):**
- `executor.ts:64` — `enforceStudioCompleteness`, `defaultDeps`: UNCHANGED (still from `studio-completeness.js`).
- `studio-recovery-sweep.ts:37` — `realListArtifacts`, `realDownloadArtifact`, `NlmArtifactRef`, `DownloadResult` → re-point to `lib/nlm-artifact-cli.js`.
- `studio-snapshot-diff.ts:34` — `NlmArtifactRef` (type) → re-point to `lib/nlm-artifact-cli.js`.
- `scripts/finalize-recovered-run.ts:50` — `obligedProducts`: UNCHANGED (stays in studio-completeness.ts).
- `regenerate-studio-products.ts:77` — `realListArtifacts`, `realDownloadArtifact`, `NlmArtifactRef` → re-point to `lib/nlm-artifact-cli.js`.

**Tests (import-path edits only, no assertion changes) — EXHAUSTIVE per-test map (v4, verified by reading every import block; replaces the v2/v3 prose that twice elided a mixed import):**

| Test file | Symbols imported from `../executor.js` | New home(s) | Re-point | Wave |
|---|---|---|---|---|
| `attachments.test.ts` | `buildManifest`, `buildPrompt` | `job-manifest` | single | C |
| `duration-kill-recovery.test.ts` | `shouldRecoverAfterDurationKill` | `claude-spawn` | single | B |
| `executor-spawn-env.test.ts` | `buildClaudeSpawnEnv` | `claude-spawn` | single | B |
| `publish-brief.test.ts` | `buildPrompt` | `job-manifest` | single | C |
| `publish-gate.test.ts` | `buildManifest` | `job-manifest` | single | C |
| **`state-coercion-guards.test.ts`** | `isNonPrimitiveStateField`, `recoverableNotebookId`, `evaluateCompletion`, **`shouldRecoverAfterDurationKill`** | **`state-evaluation` + `claude-spawn`** | **SPLIT** (Claude M-1) | B |
| `upload-set.test.ts` | `uploadOutputs`, `type Uploader` | `upload-outputs` | single | C |
| `watch-state-progress.test.ts` | `summarizeStateProgress` | `state-evaluation` | single | B |

The ONE split is `state-coercion-guards.test.ts` (three state symbols ← `state-evaluation.js`, `shouldRecoverAfterDurationKill` ← `claude-spawn.js`) — symmetric to the studio-side `studio-completeness.test.ts` split (§7 studio bullet). Both its targets land in **Wave B**, so a correct Wave-B implementation resolves the split within the wave and the suite ends green (no cross-wave strand). All other 7 executor tests are clean single-module re-points.
- studio-completeness: `studio-recovery-sweep`, `studio-snapshot-diff`, `regenerate-studio-products` re-point the `DownloadResult`/`NlmArtifactRef` type imports to `lib/nlm-artifact-cli.js`. **`studio-completeness.test.ts` does a SPLIT re-point (CORRECTED v3 — Codex CRITICAL):** its single import block (`agent/test/studio-completeness.test.ts:21-29`) pulls BOTH retained-core symbols (`enforceStudioCompleteness`, `CompletenessDeps`) AND moved CLI symbols (`classifyDownloadFailure`, `realDownloadArtifact`, `DownloadResult`, `DownloadSpawn`, `NlmArtifactRef`). After Wave A it splits into two imports — retained from `studio-completeness.js`, moved from `lib/nlm-artifact-cli.js` (still an import-path edit only, no assertion change). v2 wrongly listed this test as "unchanged." `studio-products-single-source.test.ts` (`obligedProducts` only) IS genuinely unchanged.

**Skill doc:** `~/.claude/commands/research-compare.md` references `executor.ts`/`studio-completeness.ts` by line number for behavioral contracts (uploadOutputs, verifyPipelineCompletion, realListArtifacts). These line refs go stale after the move but are *documentation*, not code. **Action:** a doc-sync note in each wave's PR updating the cited file:line to the new home. Not a build-breaker; flagged so it isn't forgotten.

---

## §8. Migration plan — the deferred MERGE, in 4 waves

Each wave is an independent PR + its **own full §11 tri-vendor MERGE gate** (agent/ PROD HARD RULE — no substitutes; if Codex is quota-out, WAIT or API-flip) + DR-Deploy pull + worker restart + verify. Ordered lowest-risk first to validate the pure-move pattern before the riskier executor surgery.

| Wave | Scope | New files | Risk | Why this order |
|---|---|---|---|---|
| **A** | studio-completeness split | `lib/nlm-artifact-cli.ts`, `lib/artifact-timestamps.ts` | **Low** | Smaller file, cleanest seams, no Supabase/notify entanglement, highest-value (4 consumers). Proves the pattern. |
| **B** | executor config + pure helpers | `lib/worker-config.ts`, `lib/worker-supabase.ts`, `lib/claude-spawn.ts`, `lib/state-evaluation.ts` | **Low-Med** | worker-config + worker-supabase FIRST (prereqs for C/D — config home + singleton owner). claude-spawn (incl. the `mcpProxyConfigPath` re-anchor) + state-evaluation (incl. `PHASE_MAP`) are well-tested pure clusters. |
| **C** | executor deliverable prep | `lib/job-manifest.ts`, `lib/upload-outputs.ts`, `lib/terminal-notify.ts` | **Med** | upload-outputs needs worker-supabase (from B). terminal-notify needed before D. |
| **D** | executor plan-review | `lib/plan-review-gate.ts` | **Med-High** | Most cross-imports + terminal-error classifier hooks. Isolated, last; **deferrable** if MERGE-time risk/reward is unfavorable (executor still shrinks ~1,150 LOC from A–C alone). |

**Per-wave checklist (the MERGE gate's definition of done):**
1. Create the new module(s); cut the symbols in verbatim (comments + guards included).
2. Add imports to the new module (env-config from `worker-config`, NOT param injection — principle 4); update `executor.ts`/`studio-completeness.ts` to import the moved symbols; re-anchor any `import.meta.url` path (principle 9).
3. Re-point consumer + test imports per the §7 EXHAUSTIVE table, INCLUDING the two SPLIT re-points (a test whose single import block spans two destination modules): `studio-completeness.test.ts` in **Wave A** and `state-coercion-guards.test.ts` in **Wave B**.
4. `pnpm test` green at the **pre-wave baseline** with **zero assertion edits** (the baseline measured immediately before the wave is the source of truth — `pnpm test` counts drift with development per CLAUDE.md §2; at v4 authoring the baseline was agent 663 / frontend 125 (S172), but do not hard-pin a literal). `tsc --noEmit` clean both tiers. storage-path grep guard pass.
5. EOL-match every touched file (CRLF for agent/).
6. Full §11 tri-vendor gate on the actual diff. PARK on BLOCK.
7. Merge → DR-Deploy pull → idle-check → worker restart → verify preflight green + polling.

Waves are independent: a later wave can be deferred indefinitely without leaving the tree in a broken state — each wave ends green and shippable.

---

## §9. Behavior-preservation verification strategy

The green test suite is necessary but not sufficient (some symbols are only integration-tested). Each wave additionally requires:

1. **Diff is move-only.** Reviewer confirms every moved line is identical pre/post (a `git diff` with `-M`/`-C` rename detection should show pure relocation; any non-import content delta is a finding). The injected config params (principle 4) are the *only* allowed signature deltas, and each must be shown to pass the same value the module const held.
2. **Byte-identical prompt/manifest.** `buildPrompt`/`buildManifest` outputs must be byte-identical (they feed `claude -p`). Wave C adds/keeps a golden-output assertion (the `publish-brief`/`attachments` tests already pin substrings; confirm coverage or add a full-string pin).
3. **Env-strip set unchanged.** `buildClaudeSpawnEnv` / `CLAUDE_SPAWN_ENV_STRIP_KEYS` move verbatim; `executor-spawn-env.test.ts` re-points and stays green (S82 contract).
4. **Coercion guards unchanged.** `state-coercion-guards.test.ts` + `watch-state-progress.test.ts` re-point and stay green (S166/S168 fail-closed contract).
5. **Spawn-guard contract.** Wave A keeps the `studio-completeness.test.ts` S162 spawn-throw cases green against the relocated `nlm-artifact-cli.ts`.
6. **Supabase single-singleton-owner.** Wave B/C: assert (review-level) that exactly ONE lazy-singleton owner exists post-move (`lib/worker-supabase.ts`), that ALL THREE `getSupabase()` callers (executeJob in executor.ts, `persistReviewerCalls`, `uploadOutputs`) reach it via the shared getter, and that the executeJob line-998 telemetry `createClient` is **unchanged** (still a distinct client — §6.1). The invariant is one singleton owner, not one createClient.
7. **`import.meta.url` audit (NEW v2).** Each wave greps the symbols it moves for `import.meta.url`/`__dirname`; any hit is re-anchored per principle 9 (Wave B: `spawnClaude`'s `mcpProxyConfigPath` injected from executor; confirm the spawned `claude -p` still receives a path resolving to the real `agent/mcp-proxy/mcp-config.json`).

---

## §10. Risk analysis

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A moved function silently changes behavior (typo during cut/paste) | Low | High (prod hot-path) | Move-only diff review (§9.1) + full green suite + tri-vendor grounded pass per wave. |
| Second Supabase client introduced | Low | Med (double-connect, auth drift) | §6.1 single-owner rule + §9.6 review assertion. |
| Circular import after a wave | Very low | High (module-load crash at daemon start) | §5 DAG; principle 3 (no helper imports executor); `tsc` + a worker smoke-start at each wave's verify step. |
| Config-param injection passes a wrong value | Low | Med | Each injected param shown to equal the prior module const; existing tests exercise the values. |
| worker.ts load-order / conventions-restart contract broken | Very low | High | `executeJob` doesn't move; worker import unchanged (principle 2). Verify worker restarts clean each wave. |
| Stale skill-doc line refs mislead a future session | Med | Low | §7 doc-sync note per wave. |
| Wave D entanglement (terminal-error classifier hooks) regresses preflight backoff | Low | Med-High | D isolated + last; preflight-backoff integration (`classifyTerminalError`/`markPendingTerminalExit`) moves verbatim; `duration-kill-recovery` + preflight tests green; **D is deferrable**. |
| Context blowout mid-MERGE wave | Med | Low | Waves are independent + small; one wave ≈ one session; pre-work-context-check before each. |

**Agent/ PROD HARD RULE (CLAUDE.md §11):** every wave's MERGE gate must clear the FULL tri-vendor (Gemini + Codex + Claude) BEFORE merge — substitutes do not satisfy it; if Codex is quota-out, WAIT or use the §1a API-key flip.

---

## §11. OUT of scope / non-goals

- **No logic changes.** Not "improving" any function while moving it. No control-flow restructure of `executeJob`/`enforceStudioCompleteness`.
- **No new behavior, no new features.** Not adding the non-blocking `recovering`-state async poller mentioned in executor.ts:99 (that's a separate DESIGN initiative).
- **No prompt/manifest content change.** Byte-identical.
- **No change to `worker.ts`** beyond nothing (it's untouched).
- **No change to the pipeline skill** (`research-compare.md`) except stale line-ref doc-sync.
- **No splitting of `executeJob` itself.** Its 549 LOC stays one function this round; extracting its *internal phases* into named steps is a *possible future* refactor with real behavior risk (control-flow change) — explicitly deferred.
- **No touching the frontend tier.** Pure agent/ work.
- **`finalize-recovered-run.ts` / `studio-recovery-sweep.ts` internal structure** — not decomposed here; they only re-point imports.

---

## §12. Open questions for reviewers

- **Q1 (re-export vs re-point).** §4.3 chooses (A) move + re-point (no barrel). Does any reviewer prefer (B) re-export barrel for a *specific* wave to reduce churn, accepting the re-coupling? (Author position: (A) everywhere; the production surface is unchanged either way.)
- **Q2 (`log`/`sleep` duplication).** §6.3 keeps per-module trivial loggers (codebase idiom) vs introducing `lib/log.ts`. Accept duplication, or extract a shared logger as part of Wave B?
- **Q3 (Wave D inclusion).** Is extracting `plan-review-gate.ts` (Wave D) worth its risk, given A–C already shrink executor ~1,150 LOC? Author leans "yes, but explicitly deferrable at MERGE time."
- **Q4 (module naming).** Are `claude-spawn` / `state-evaluation` / `job-manifest` / `nlm-artifact-cli` / `artifact-timestamps` the right names, or do any collide with existing/clearer conventions?
- **Q5 (config home) — RESOLVED v2.** v1's param-injection is superseded by the shared `lib/worker-config.ts` module (Gemini M3/M4): env-config is imported (zero signature churn), static maps move with their consumer, file-relative paths re-anchored. Remaining reviewer check: is `worker-config` the right boundary, or should it fold into `worker-supabase` (both leaves)?
- **Q6 (granularity).** Is 10 new modules (8 executor-side + 2 studio-side) the right granularity, or should any be merged (e.g. fold `upload-outputs` into `job-manifest` as one "deliverables" module; fold `terminal-notify` into `worker-supabase`/`worker-config` as "worker-io")?

---

## §13. Summary of the proposal

Extract 10 cohesive pure-move modules (`lib/worker-config`, `worker-supabase`, `claude-spawn`, `state-evaluation`, `job-manifest`, `upload-outputs`, `terminal-notify`, `plan-review-gate`, `nlm-artifact-cli`, `artifact-timestamps`), shrinking `executor.ts` 2,247 → ~850–950 LOC and `studio-completeness.ts` 747 → ~320 LOC, with a byte-unchanged production import surface (`worker.ts → executeJob`), an acyclic dependency graph (DAG, L0→L4), and zero runtime-behavior change proven by an unmodified-assertion green test suite. The v2 revision (Gemini round, §14) replaced param-injection with a shared `worker-config` module, corrected the Supabase seam (one singleton owner + a retained telemetry client), and added file-location-relative path re-anchoring — together preserving "pure move + zero signature churn" honestly. Ship in 4 independent, lowest-risk-first MERGE waves, each its own full §11 tri-vendor gate. Wave D (plan-review) is deferrable. The MERGE gate(s) are later sessions; this is DESIGN only.

---

## §14. Review-finding resolution log

### Round 1 — Gemini 3.1 (gemini-3.1-pro-preview) holistic-adversarial — VERDICT: BLOCK → all findings integrated into v2

All four findings were **verified against the actual code** before integration (greps + reads, S173).

| # | Sev | Finding | Verified? | Resolution in v2 |
|---|---|---|---|---|
| C1 | CRITICAL | `spawnClaude` resolves the mcp-proxy config via `import.meta.url` (executor.ts:1626); a verbatim move to `agent/lib/` re-roots it to a nonexistent `agent/lib/mcp-proxy/…`, silently bypassing the proxy. | YES — confirmed line 1626 + that `spawnRegenScript`:1139 is the only *other* `import.meta.url` site (and it stays). | New **principle 9** (re-anchor file-relative paths) + **§6.4**: executor computes `mcpProxyConfigPath` and passes it to `spawnClaude` (the one allowed signature change). §9.7 audit step added. |
| C2 | CRITICAL | (a) §9.6 "exactly one createClient" is false — a 2nd `createClient` exists in executeJob:998 (telemetry, default auth). (b) §4.1/§6.1 missed that `executeJob` itself calls `getSupabase()` (line 546). | YES — confirmed createClient at 155 + 998; getSupabase callers at 234/546/2148. | **§6.1 corrected**: 3 getSupabase callers incl. executor.ts; line-998 telemetry client stays verbatim (folding = out-of-scope logic change); invariant restated as "one singleton owner," not "one createClient." §4.1 retain-row + worker-supabase row corrected. §9.6 corrected. |
| M3 | MAJOR | `PHASE_MAP` is a static dict, not env config; v1 principle 4 wrongly pushed it to a param → viral signature churn + test-call edits. | YES — confirmed static literal (132) used only by state cluster (1872, 2095). | **Principle 4 rewritten** (4a): static maps move WITH their sole consumer. `PHASE_MAP` moves into `state-evaluation.ts`. No injection. |
| M4 | MAJOR | `buildManifest` closes over `WORKING_DIR` (default param) + `PROJECTS_DIR` (body); both also used by retained executeJob → moving forces signature churn breaking `attachments`/`publish-brief` tests. | YES — confirmed WORKING_DIR@468/1029, PROJECTS_DIR@469/1054. | **Principle 4 rewritten**: new shared `lib/worker-config.ts` owns env config; both sides import it; moved bodies stay verbatim; zero signature churn. New module in Wave B. |
| §12 Q1 | — | Re-export vs re-point → reviewer agrees with author: (A) re-point, no barrel. | n/a | Kept (A). |
| §12 Q2 | — | log/sleep duplication → accept (no `lib/log.ts`). | n/a | Kept per §6.3. |
| §12 Q3 | — | Wave D inclusion → reviewer agrees: extract, isolated, worth it. | n/a | Kept; remains deferrable. |
| §12 Q4 | — | Module names → endorsed. | n/a | Kept. |
| §12 Q5 | — | Config injection → reviewer agrees primitives-only; static maps native. | n/a | Superseded by the worker-config module (cleaner than primitives-as-params). |

**Net effect of the round:** the decomposition shape held, but the "pure move" claim was hardened — v1 under-counted three classes of module-context closure (file-relative paths, static maps, env-config straddling the retain/move boundary) + miscounted the Supabase seam. v2's `worker-config` module + path re-anchoring + corrected Supabase invariant make "pure move, zero signature churn, zero test-assertion edits" an honest claim. Module count 9 → 10.

### Round 2 — Codex gpt-5.5 (xhigh, banner-asserted: `model: gpt-5.5` / `reasoning effort: xhigh` / `provider: openai`) grounded-adversarial on v2 — VERDICT: BLOCK → integrated into v3

Ran in-repo (`-s workspace-write`); read the real files, ran `tsc --noEmit` (passed), re-swept importers with `rg`.

| # | Sev | Finding | Verified? | Resolution in v3 |
|---|---|---|---|---|
| C3 | CRITICAL | §7 wrongly listed `studio-completeness.test.ts` as "unchanged." Its import block (`agent/test/studio-completeness.test.ts:21-29`) pulls moved CLI symbols (`classifyDownloadFailure`, `realDownloadArtifact`, `DownloadResult`, `DownloadSpawn`, `NlmArtifactRef`) — implementing Wave A as written breaks the test import. | YES — read the import block; confirmed it mixes retained (`enforceStudioCompleteness`, `CompletenessDeps`) + moved CLI symbols. | §7 + §4.2 corrected: the test does a **SPLIT re-point** in Wave A (retained from `studio-completeness.js`, moved from `nlm-artifact-cli.js`); still import-path-only. §8 step 3 calls out split-re-points explicitly. |
| C4 | MINOR | §5 graph omitted the pre-existing edge `executor.ts → studio-recovery-sweep.ts` (`studioRecoveryBackoffMs`, executor.ts:68/880). No cycle results, but should be shown. | YES — confirmed import + uses. | §5 augmented: both `executor → studio-recovery-sweep → nlm-artifact-cli` and `executor → studio-completeness → nlm-artifact-cli` shown; DAG holds; sweep only re-points 2 import lines. |
| Q5 | — | "two createClient sites" needs repo-wide qualification (other sites exist in staging-sweep/sweep/scripts). | YES — `rg` found ~10 repo-wide. | §6.1 scoped the invariant to "within the executor.ts decomposition surface." |
| §8 | — | (Author-caught while integrating) §8 step 2 still said "inject config params" (stale v1). | — | Rewritten to "import from worker-config; re-anchor import.meta.url." |

**Codex CONFIRMED (grounded positives):** no missed production importer of `executor.ts` (only `worker.ts:29`); the `studio-completeness.ts` importer set is otherwise complete; the Supabase call-site claims (3 `getSupabase()` + the separate telemetry `createClient`) are correct; the `import.meta.url` claims for `executor.ts` are correct; closure/signature claims hold (incl. `PUBLISH_RISK_ACCEPT_DIR` ∈ worker-config); `tsc --noEmit` passes on the current tree. §12: re-point right (Wave A must re-point the test), accept local log/sleep, Wave D deferrable, names fine, granularity acceptable.

**Net effect:** the decomposition shape + v2's seam fixes all held under the grounded lens; the one CRITICAL was a completeness miss in the *test-consumer map* (a `…`-elided import the recon flattened), not a soundness flaw. v3 closes it + the graph-edge omission + the wording scope.

### Round 3 — Claude grounded subagent (fresh, zero authoring context) on v3 — VERDICT: BLOCK → integrated into v4

Ran read-only in-repo; read every test import block, grep-swept closures, ran `tsc --noEmit` (EXIT 0). Confirmed all 7 load-bearing claims (consumer map, acyclicity, closure completeness, signature-churn, Supabase seam, spawn guards, wave safety) EXCEPT one symmetric map error.

| # | Sev | Finding | Verified? | Resolution in v4 |
|---|---|---|---|---|
| M-1 | MAJOR | §7 mis-categorized `state-coercion-guards.test.ts` as a single-module re-point; its one import block (`:21-26`) spans TWO destinations — `isNonPrimitiveStateField`/`recoverableNotebookId`/`evaluateCompletion` → `state-evaluation`, `shouldRecoverAfterDurationKill` → `claude-spawn`. This is the symmetric twin of the Codex C3 split (which the gate elevated to CRITICAL) — caught studio-side, missed executor-side. | YES — author re-read ALL 8 executor test imports; confirmed this is the ONLY split (both targets Wave B → converges green within the wave). | §7 replaced with an **EXHAUSTIVE per-test re-point table** (all 8 executor tests, single vs SPLIT, wave). §8 step 3 names both splits (`studio-completeness.test.ts` Wave A + `state-coercion-guards.test.ts` Wave B). Root-cause closed: the prose that twice elided a mixed import is gone. |
| m-1 | MINOR | §5 DAG omits the type-only edge `artifact-timestamps.ts → nlm-artifact-cli.ts` (`artifactCreatedAtMs(a: NlmArtifactRef)`). | YES — type-only, one-directional. | §5 augmented; edge is compile-erased → no runtime cycle, DAG holds. |
| m-2 | MINOR | §8 hard-pinned "agent 663 / frontend 125"; CLAUDE.md says counts drift + `pnpm test` is SoT. | YES. | §8 step 4 re-phrased to "pre-wave baseline, zero assertion edits" (no literal pin). |
| m-3 | MINOR | §4.1 move rows list functions but not cluster-local supporting types (`KillReason`, `StateWatcher`, `ProgressSummary`, `CompletionVerdict`, `UploadResult`, `Uploader`). | YES — only `Uploader` has an external importer (handled). | §4.1 note added: symbol lists illustrative; types travel with their cluster. |
| line-ref | INFO | Cited `executor.ts:65` for the studio-completeness import; actual `:64-67`. | YES. | Fixed to `:64`. |

**Claude subagent CONFIRMED (grounded positives, verbatim sense):** consumer map complete (only `worker.ts:29` runtime-imports executor); DAG holds (no extracted module imports executor.ts; the `executor→studio-recovery-sweep` edge is not a back-edge); EVERY module-const a mover closes over is in `worker-config` or moves with its cluster (incl. `buildManifest` reading `PUBLISH_RISK_ACCEPT_DIR`); the ONLY signature change is `spawnClaude`'s `mcpProxyConfigPath`; Supabase seam EXACT (3 `getSupabase()` + 2 `createClient`); S162 spawn guards + timestamp purity verified; wave plan safe; `tsc --noEmit` EXIT 0.

**Net effect:** the architecture + all v2/v3 seam fixes held under a third independent grounded lens; the sole blocker was the symmetric recurrence of the C3 test-map class (an elided mixed import), now closed structurally with the exhaustive §7 table. v4 is the candidate for the unanimous clear, pending the subagent's fidelity re-check that v4 applied M-1 correctly.

### Round 3b — fresh Claude grounded fidelity re-check on v4 — VERDICT: ENDORSE → **GATE UNANIMOUS-CLEARED**

A fresh grounded reviewer (zero authoring context) verified each v4 fix against the repo: (1) the §7 exhaustive per-test table is correct for all 8 executor tests — `state-coercion-guards.test.ts` correctly marked SPLIT, no other test mislabeled, the studio-side split intact; (2) the §5 type-only `artifact-timestamps → nlm-artifact-cli` edge is real + one-directional (compile-erased, no cycle); (3) §8 test-count de-pinned; (4) §4.1 supporting-types note exact (`Uploader` the only externally-imported one, handled). It re-verified the unchanged core under grounded greps: sole runtime importer `worker.ts:29`; DAG holds (no module imports executor.ts); Supabase seam EXACT (3 `getSupabase()` + 2 `createClient`); the only signature change is `spawnClaude`'s `mcpProxyConfigPath`; both `import.meta.url` sites accounted; all studio consumer re-points correct; `tsc --noEmit` EXIT 0. One non-blocking nit (path prefix on `finalize-recovered-run.ts`) was fixed in v4.

**Final gate verdict — UNANIMOUS CLEAR.** All three independent lenses (Gemini holistic + Codex grounded + Claude grounded) BLOCKed an earlier draft; every finding (Gemini C1/C2/M3/M4, Codex C3/C4, Claude M-1/m-1/m-2/m-3) was integrated and verified; the final state was re-confirmed clean by a fresh grounded pass. The DESIGN is sound, safe, and complete. **No code was written and nothing was merged or deployed — the design is now authoritative input for the Wave-A MERGE gate (a future session).**

### Bug-class lesson (for memory)
The same defect class recurred TWICE — a `…`-elided / flattened import in the recon hid a *mixed* test import (a single import block spanning two destination modules): Codex caught it for `studio-completeness.test.ts` (C3, CRITICAL), the Claude lens caught the symmetric `state-coercion-guards.test.ts` (M-1, MAJOR). Root cause: trusting a recon digest's summarized import lists over the raw import blocks. The fix (an EXHAUSTIVE per-test re-point table built from reading every raw import) is also the MERGE-gate discipline: **for a move refactor, enumerate every consumer's FULL import, never a summary.**
