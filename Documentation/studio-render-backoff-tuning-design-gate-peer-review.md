# Studio render-backoff tuning — DESIGN gate peer review (synthesis)

> Companion to `studio-render-backoff-tuning-design-gate.md`. DESIGN gate, S191 (2026-06-30).
> **Topology (per §11 / `~/CLAUDE.md`):** sequential, DESIGN-fresh — Gemini holistic-adversarial (v1) → integrate → Codex grounded-adversarial (on the integrated v2) → integrate → final **v3**. Both reviewers adversarial within their lens (breadth vs depth).
> **Outcome:** both reviewers returned **BLOCK** with substantive findings; **every finding integrated** into v3. No finding was rejected. The design ships NO code — the IMPL/MERGE will run its own full §11 tri-vendor MERGE gate against the implementation.

## Reviewer identities + what each saw
| | Gemini | Codex |
|---|---|---|
| Model (asserted) | `gemini-3.1-pro-preview` (REST `generateContent`, `thinkingLevel:high`); usage prompt=9454 thoughts=14056 | `gpt-5.5`, provider openai, **sandbox: workspace-write**, reasoning effort **xhigh** (run-banner asserted); 262,234 tokens |
| Lens | holistic-adversarial (breadth) — whole-artifact, system-level | grounded-adversarial (depth) — file:line against shipped code |
| What it saw | the v1 design doc + a ground-truth code-excerpt appendix (no repo access — SDK call) | **full bodies** of the design doc (sandbox v2) + `studio-recovery-sweep.ts`, `executor.ts`, `nlm-artifact-cli.ts`; targeted bodies of `studio-completeness.ts`, `finalize-recovered-run.ts`, `notify.ts`, `worker-config.ts`, tests; `rg` sweeps; **web/GitHub research + the locally-installed `notebooklm-py` source** |
| Verdict | BLOCK | BLOCK |

**Sandbox-mode note (Codex):** the §11 pin is `-s read-only`, but the documented Windows quirk (codex-fallback failure mode #2) is that `-s read-only` routes file-body reads through `pwsh Get-Content` → policy-blocked → zero grounded findings. Ran `-s workspace-write` (the documented remedy) with an explicit "review only, modify nothing" instruction; Codex modified no files (verified — `git status` clean). This honors the pin's *intent* (a code-grounded pass) over its letter, which would have produced a crippled review on this host.

---

## Gemini (holistic-adversarial) — verbatim findings + disposition

> **VERDICT: BLOCK.** "critical logical flaw in its primary safety mechanism (Design B) and a major timing hazard in its schedule math (Design A)."

1. **CRITICAL — Design B's `newAttempts >= 2` "confirmation gate" is dead code.** "`newAttempts` is the job's global sweep counter. Because the executor park sets `attempts = 1`, the very first sweep tick calculates `newAttempts = 2`. Therefore `newAttempts >= 2` is always true on the first poll… The worker is stateless between ticks; it has no way to know if it saw the status consecutively without a schema change."
   → **ACCEPTED.** Removed the illusory gate (§5.2). Design B safety now rests explicitly on (a) allowlist strictness (positively-confirmed terminal, default empty/inert) + (b) the unchanged downstream `finalizeBestEffortRun` obligation re-assert. Genuine consecutive confirmation would need persisted state — recorded as deferred **D-B3** (`render_failed_streak`), not adopted in v1.

2. **MAJOR — schedule sums to exactly 120m → knife-edge jitter overshoot.** "If Tick 8 executes even 1 ms early… the age check fails… schedule the next tick 35 minutes later. This turns a 120m target into a 155m completion."
   → **ACCEPTED.** Schedule shifted `[3,5,7,10,15,20,**25**,35]` → `[3,5,7,10,15,20,**30**,35]`; the window-crossing tick now lands at **125m** (a deliberate ~5-min margin past the 120m edge), so the `ageMs >= 120m` gate passes regardless of jitter (§4.1).

3. **MINOR — mixed payloads defeat O2 + §4.3↔§4.4 inconsistency.** "Decision D-A3 dictates that if a download is still pending, the cap tail uses `kind = "download"`… a mixed payload ticks at the slow cadence… If the render finishes at 20m, it will not be downloaded until 63m."
   → **ACCEPTED.** Rewrote D-A3 + §4.3 honestly: a mixed payload (download blip + render) uses the **download** cadence + cap while the download is pending (fast-pacing it would burn the download's 8-attempt cap — the §3 hazard applied to the download leg); once `renderOnlyRemaining`, it switches to the fast render cadence. O2 is met for render-only payloads and for the render *tail* of a mixed payload, NOT for a render while a download co-pends. Documented as a deliberate limitation (mixed payloads are rare; safety dominates).

4. **INFO — `STUDIO_VIDEO_RENDER_FAILED_STATUS_IDS` must reject `1` (in_progress).**
   → **ACCEPTED** (and extended by Codex to also reject `2`).

---

## Codex (grounded-adversarial) — verbatim findings + disposition

> **VERDICT: BLOCK.**

1. **CRITICAL — cap/cadence selection is not plumbed where the design says it is.** "`renderOnlyRemaining` is computed inside `attemptRecovery` (`:576`). The design says the cap tail computes `kind = renderOnlyRemaining ? "render" : "download"` (`:127`). As written, that variable is out of scope. Fix: make `attemptRecovery` return structured non-terminal context, e.g. `{ terminal: null, renderOnlyRemaining, bestEffortReason }`, and use that same value for cap, backoff, logs, and alert reason."
   → **ACCEPTED.** §4.4 now specifies `attemptRecovery`'s "not recovered" return changes from a bare `null` to a structured `{terminal:null, renderOnlyRemaining, bestEffortReason}`; the caller threads that one value into cap selection, backoff `kind`, the log line, and the operator-alert reason. §7 sweep bullet updated. (This is a real plumbing gap the breadth pass structurally could not see — it requires cross-function variable-scope tracing.)

2. **MAJOR — failed-status allowlist safety is incomplete; the real enum was found.** "Web/source research on the installed underlying CLI package found `ArtifactStatus`: `1=PROCESSING, 2=PENDING, 3=COMPLETED, 4=FAILED` in `notebooklm-py` v0.3.4 ([rpc/types.py L111-120]); CLI JSON emits `status_id` from that status. Allowlisting `2` would fast-terminalize a queued/transitional render on first sighting. Fix: hard-deny `1`, `2`, and `3`; allow only confirmed terminal values, currently `4`… Note the repo is unofficial and uses undocumented APIs, so this is not Google contract-grade evidence."
   → **ACCEPTED.** §1.3 upgraded with the real enum + the unofficial-source caveat; parser now rejects `{1,2,3}` (§4.5/§5.2/§7/test 9); D-B1 RESOLVED with `4=FAILED` as the value to arm (default stays empty pending shadow confirmation).

3. **MAJOR — stale `>=2` confirmation references survive in §6, §7, D-B1.** "Top matter says the gate was removed (`:9`), §5.2 correctly says first armed sighting (`:149`). But §6, §7, and D-B1 still say seen/confirmation `>=2` (`:164`,`:169`,`:192`). That gate is indeed dead: executor parks `attempts=1` (`:588`), first sweep computes `newAttempts=2` (`:242`)."
   → **ACCEPTED.** Purged all residual `≥2` refs (§6 fail-open, §7 sweep bullet, D-B1) — the v1.1 sweep was incomplete (the "sweep ALL mirror forms upfront" lesson). Only the legitimate "describes-the-removed-gate" references (changelog, §5.2 rationale, the §8 regression-guard test, D-B3) remain.

4. **MAJOR — test strategy contradicts the design.** "§4.3/D-A3 says mixed parks on download cadence (`:120`,`:191`). Test item 4 says 'render (or mixed)' parks at 3m (`:180`). Test item 1 expects `…20,25,35`, but the proposed schedule is `…20,30,35` (`:177`,`:190`)."
   → **ACCEPTED.** Test 1 schedule values `25→30`; test 4 render-ONLY→3m / mixed→5m.

5. **MINOR — executor first-park reorder.** "Current code computes `nextIso` before constructing `payload` (`:559`). Fix: compute `parkKind` from `recoverable.every(rp => rp.recovery_kind === "render")` before `nextIso`; absent kind is download."
   → **ACCEPTED.** §4.3 plumbing note added.

6. **MINOR — operator alert split needs signature plumbing.** "Current best-effort alert args have no reason/status (`:198`); current copy specifically says the render window was exceeded (`notify.ts:475`). Fast-failed renders need a reason/status_id field or separate alert method."
   → **ACCEPTED.** §7 notify bullet now requires a `reason`/`status_id` field (the `bestEffortReason` threaded from the §4.4 structured return).

7. **INFO — §3 regression trace CONFIRMED clean.** "I found no tick where `age < 120m` and `newAttempts > 12` under `[3,5,7,10,15,20,30,35]`. Sequence: park `attempts=1`, t1 3m/new2 … t7 90m/new8, t8 125m/new9. Best-effort is inside `attemptRecovery` and returns before the cap tail. With render cap 12, cap only bites after repeated best-effort refusal around t12/new13."
   → **CONFIRMATION** (not a finding) — independently validates the §3 keystone (dedicated render cap removes the zero-margin coupling) and the caller-inventory claim (default `"download"` preserves all existing callers + the 4 unit tests).

---

## Net synthesis
- **Both lenses caught DIFFERENT bug classes, as the topology intends.** Gemini (breadth) caught the dead-code safety gate + the schedule knife-edge — whole-artifact logic. Codex (depth) caught a variable-scope plumbing bug Gemini structurally could not see, found the real status enum via source research, and swept up the residual stale mirror-form references. Neither verdict subsumed the other.
- **v1 → v3 changes:** schedule `…25,35`→`…30,35` (125m crossing); confirmation gate removed; allowlist rejects `{1,2,3}` and `4=FAILED` is the value to arm; `attemptRecovery` structured non-terminal return; mixed-payload cadence scoped honestly; park-kind computed before `nextIso`; alert reason field; tests aligned.
- **No CRITICAL is a fail-open:** both CRITICALs were *design-fidelity/plumbing* (a dead gate, an out-of-scope variable), not safety regressions — the fail-closed completion gate (`finalizeBestEffortRun` obligation re-assert) is unchanged throughout, so even the un-fixed drafts could not have completed a run unsafely. The fixes make the design *implementable and honest*, not *safe-where-it-wasn't*.
- **Deferred (recorded):** D-B3 (persisted `render_failed_streak` for true consecutive confirmation — only if a shadow run shows transient mis-reporting of status_id 4).

## Downstream gate owed (NOT this session)
This is a DESIGN gate only. The IMPL is `agent/` PROD → the **full §11 tri-vendor MERGE gate BEFORE merge** (no substitutes — S141 HARD RULE), then migration-free deploy + worker restart, gated behind the S190 DR live-runtime freeze all-clear. The MERGE gate re-examines the structured-return change, the parser, and the cadence against the actual implementation + the new tests (§8).
