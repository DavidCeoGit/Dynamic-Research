# Studio Product Checker — S197 MERGE-gate peer review (tri-vendor + fresh-Claude lens)

- **Change:** branch `s197-studio-product-checker` (base main `13093c5`) — implementation of `Documentation/studio-product-checker-design-gate.md` v4 §10 (12 files; 4 new modules, 8 edits; ~2,690 insertions incl. 45 tests).
- **MRPF classification:** MERGE gate; Risk Labels **AGENT BEHAVIOR + INFRA** (new host-side scheduled-task script + worker/executor breadcrumb seams; read-only against job state). Severity NORMAL. `agent/` PROD ⇒ S141 HARD RULE: full tri-vendor BEFORE merge, no substitutes; + the fresh-Claude grounded refutation lens (S195/S196 standing rule for this failure family).
- **Reviewer order:** Gemini 3.1-pro (holistic-adversarial) → integrate → Codex gpt-5.5 xhigh (grounded-adversarial, `-s workspace-write`, run-banner asserted) → integrate → fresh-Claude grounded refutation lens → integrate → final.
- **Verification state at gate open:** `pnpm test` green — agent 752/752 (707 baseline + 45 new), frontend 150/150, strict tsc clean both tiers, storage-path grep guard PASS.

---

## Round 1 — Gemini 3.1-pro-preview, holistic-adversarial (BLOCK → refuted, 0 integrations)

**What the reviewer saw:** the full v4 design doc + the complete implementation diff (156 KB bundle). No repo access. Banner: prompt=41k?, thinkingLevel high, temperature 0.3. Raw log: `/c/tmp/dr-s197/review/gemini-out.log`.

**VERDICT: BLOCK** — 1 CRITICAL + 2 INFO.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| G-1 | CRITICAL | PS 5.1 `ConvertTo-Json` throws on null input when `Get-CimInstance` matches nothing → probe exits 1 → checker reads `ok:false` (indeterminate) → `CHILD_DEAD_JOB_RUNNING` can never fire — the primary liveness check is defeated. | **REFUTED by live test on the deployment host** (PowerShell 5.1.26100.8737, 2026-07-01): `Get-CimInstance Win32_Process -Filter "ProcessId=999999" \| Select-Object … \| ConvertTo-Json -Compress` → **exit 0, empty stdout**. Same for the `Where-Object`-filtered worker-scan form. An EMPTY pipeline binds zero objects to `ConvertTo-Json` and emits nothing; the `ParameterBindingValidationException` Gemini cites occurs only when piping an explicit `$null` VALUE. The shipped code's `if (!out) return { ok: true, exists: false }` handles the empty-stdout path — the dead-PID probe returns a definitive not-exists and #6 fires. Precedent: [[feedback_live_test_refutes_confident_reviewer_on_external_service]] (S181 — settle external-service mechanism disputes with a live test before integrating). |
| G-2 | INFO | `realFindWorkerProcesses` relies on an error path (the same alleged throw) to return `[]` when no workers match. | REFUTED with G-1 — same wrong mechanism. Empty match → exit 0 + empty stdout → the `if (!out) return []` NORMAL path. |
| G-3 | INFO | `sendStudioStallAlert` emails on recovered/fyi-only batches. | Acknowledged as acceptable by the reviewer itself; intentional (operator visibility of RECOVERED transitions is part of §5.3). No change. |

**Round outcome:** no code changes; the BLOCK dissolves on empirical refutation of its only CRITICAL. The Codex grounded pass was explicitly told about the refutation and invited to re-verify.

---

## Round 2 — Codex gpt-5.5 xhigh, grounded-adversarial (`-s workspace-write`)

**What the reviewer saw:** the FULL repo working tree on the branch (commit `98b0037` checked out), the design doc, the diff via git, and license to run tsc/tests/node counterexamples — which it used (ran the 45-test file, tsc, `git diff --check`, a 200-trial lock race, and a live `Get-CimInstance` probe). Run banner asserted: `model: gpt-5.5`, `reasoning effort: xhigh`, sandbox workspace-write. Raw log: `/c/tmp/dr-s197/review/codex-out.log` (~9,900 lines).

**VERDICT: BLOCK** — 1 CRITICAL + 4 MAJOR + 1 MINOR + a grounded-correct list. ALL integrated in commit `eafea55`:

| # | Sev | Finding (grounded) | Disposition |
|---|---|---|---|
| X-1 | CRITICAL | Marker freshness weakened from spec §3: OR-gate (`floor fresh OR mtime fresh`) + `floor ?? 0` fallback in matching. Counterexample RUN: stale floor + fresh mtime + one prior-run artifact → checker resolved the foreign artifact as "ours" → masked an attempt-2 `NO_ARTIFACT` stall (observations: []). | **ACCEPTED + FIXED** — AND-gate: embedded `run_floor_ms` must EXIST and be ≥ `claimed_at`; mtime, when present, must corroborate; matching floor is never 0 (`Number.POSITIVE_INFINITY` belt = resolve nothing if the invariant is ever violated — fail toward NO_ARTIFACT, never toward masking). +2 tests (stale-floor/fresh-mtime rejected; missing-floor rejected). |
| X-2 | MAJOR | Latch close-out trusted the running-page read alone; `fetchRunningJobs` returns `[]` on SELECT error → transient blip wipes alerted latches → dedup state gone → re-alert spam. (The design's §5.1 tracked-id second read existed for exactly this; the implementation had dropped it as an "optimization" — a real fidelity drift.) | **ACCEPTED + FIXED** — new `fetchTrackedJobStatuses(ids)` deps seam (`null` on error ⇒ keep every latch; `"running"` ⇒ page miss, keep). Running-page cap raised 25→100 with a no-silent-caps warning log. +2 tests. |
| X-3 | MAJOR | Blind/degraded suppression emitted false `RECOVERED` + cleared latches: an auth-blip invocation "recovered" a previously-alerted `STALLED_PRODUCT:video`. Counterexample RUN by the reviewer. | **ACCEPTED + FIXED** — per-job `unobservable` key-freeze: list-failure/missing-state-or-notebook/probe-failure/per-job-throw freeze the affected keys (`"*"` for a thrown job); a frozen key is neither incremented nor recovered. Blind ≠ absent. +2 tests. |
| X-4 | MAJOR | Singleton lock was read-then-write TOCTOU; reviewer raced 200 paired acquisitions → both entered in 200/200 trials. | **ACCEPTED + FIXED** — atomic `fs.open(lockPath, "wx")` exclusive-create; EEXIST → fresh yields / stale removed + ONE atomic retry (the rm→create window itself settled by `wx`). Existing lock tests pass unchanged against the new implementation. |
| X-5 | MAJOR | `Get-CimInstance` returned "Access denied" in the review shell → probe `ok:false` → rows #6/#7 silently never alert if the Scheduled-Task principal lacks CIM access. | **PARTIALLY REFUTED, SPIRIT ACCEPTED** — the access-denied is a codex-sandbox artifact (CIM verified working live under the real `ceo` principal this session, same principal as `DynamicResearchWorker`); but the resilience gap is real and mirrors the design's own row-9 doctrine ("a blind checker must say I am blind"). **FIXED** — new global condition `PROCESS_PROBE_BLIND` (3 sightings, matrix row 11, reviewer-driven amendment) + probe-failure freeze of #6/#7 keys. Deploy step re-verifies the probe under the registered task. +1 test. |
| X-6 | MINOR | Log rotation `renameSync` onto an existing `.1` "fails on Windows". | **REFUTED-BUT-BELTED** — libuv rename replaces existing destinations on Windows (MOVEFILE_REPLACE_EXISTING; the repo's own S161 R2-2 doctrine). The 1-line `rmSync(force)` pre-clear applied anyway (costs nothing). |

**Grounded-correct (Codex verified):** breadcrumb lifecycle seams at executor.ts:119/:334/:359/:743; S117 fail-closed contract preserved (state-archive errors still fail the job; marker archive separately best-effort); cwd-independent anchoring + worker-start.bat keeps the S42 detach pattern; PRODUCT_TO_NLM_TYPE single-source with slides→slide-deck; id/slug validation before filesystem use; studio_only exclusion. Tests 45/45 + tsc + `git diff --check` all run by the reviewer itself.

**Round outcome:** integration commit `eafea55`; post-integration full suite agent 758/758 + frontend 150/150, tsc clean.

---

## Round 3 — fresh-Claude grounded refutation lens (BLOCK → all integrated) — **the 4th consecutive externally-missed catch in this family**

**What the reviewer saw:** the FULL repo on integrated commit `eafea55`, zero authoring context, prompted to REFUTE + hunt sibling sites of the just-fixed classes; ran tsc, the test file, and live deps-injected counterexample sequences against the shipped `runStudioCheckerOnce` (27 tool uses, ~190k tokens). Explicitly told the worker seams were attack surface #1.

**VERDICT: BLOCK** — 2 MAJOR (both REPRODUCED with counterexamples; both siblings of classes the same gate had just fixed) + 4 MINOR + 4 INFO, plus 10 documented failed refutation attempts (the job-critical worker seams survived everything). ALL integrated in commit `80d9df5`:

| # | Sev | Finding | Disposition |
|---|---|---|---|
| F-1 | MAJOR | **Global-condition latches exempt from the M-2 blind-freeze** — auth outage kills the job → next tick `listCalls=0` → `NLM_AUTH_DEGRADED` "not seen" → false `RECOVERED` email MID-INCIDENT + latch deleted (re-arming alert/recover cycles). Reproduced (CE-1, 3 ticks). The exact blind≠absent principle Codex X-3 fixed for per-product keys, violated one level up. | **ACCEPTED + FIXED** — `probesAttempted` tracked; global unobservable set: `listCalls===0` freezes both NLM_* keys, `probesAttempted===0` freezes PROCESS_PROBE_BLIND; fed through the same not-seen freeze. +1 test. |
| F-2 | MAJOR | **Wedge row false-fires on every healthy long render** — "quiet" anchored to artifact `created_at`, which NLM stamps at SUBMIT: a 40-min render is ">25 min quiet" the instant it completes, child legitimately alive in Phase 6/7 → S130-class cry-wolf FYI ~5–10 min after every long video. Reproduced (CE-2). **The SPEC encoded the defect** (§5.2 #10 "created_at ≥ 25 min ago") — which is exactly why both spec-fidelity externals passed it. | **ACCEPTED + FIXED** — quiet is now CHECKER-OBSERVED: the observation fires on each all-complete+child-alive sighting; confirmation = ceil(wedgeQuietMs/cadence)+1 spaced sightings (~25+ min observed). **Spec amended to v4.1** (row 10 re-anchored; changelog entry). Row-10 tests rewritten (5 ticks silent → 6th fires). |
| F-3 | MINOR | "2 consecutive sightings (≥5 min apart)" spacing unenforced — a manual run 1 s after the scheduled tick instant-confirms. Reproduced (CE-3). | **FIXED** — increment only when `consecutive===0 OR now−lastSeenMs ≥ 0.8×cadence`. +1 test. |
| F-4 | MINOR | Stale-lock takeover still races (sibling of Codex X-4): B's `rm` can delete A's freshly-`wx`-created lock (14/400 double-acquisitions). | **FIXED** — takeover by atomic rename-aside (single rename winner) then retry `wx`. |
| F-5 | MINOR | `agent/.run/`, `agent/.studio-checker/`, `studio-checker.log*` not gitignored — `git add .` would commit breadcrumb/latch JSONs (job UUIDs + local paths). | **FIXED** — .gitignore entries added. |
| F-6 | MINOR | `/worker/i` cmdline matchers over-match on a multi-project box → a real DR-worker death down-classifies to the FYI mismatch alert. | **FIXED** — tightened to `/worker\.(ts|js)/i` both sides (residual cross-project worker.ts ambiguity documented as accepted). |
| F-7..10 | INFO | Latch writes not temp+rename (crash → truncated JSON → dedup dust only); `statePhase` embeds child-written text into the operator email (HTML-escaped; spec-sanctioned §5.3 "phase context" — notify's "no untrusted content" comment is approximate); `agentRuntimeDir()` assumes tsx-executed sources (a future dist/ build relocates state); checker inert until task registration (StartIn=DR-Deploy is the deploy-step guard). | **ACCEPTED AS RECORDED** — no code change; first item is bounded dust (a lost latch re-earns sightings, alert-only consequence); remainder tracked in deploy notes/handoff. |

**Failed refutation attempts (load-bearing evidence):** breadcrumb IO can't fail/delay a job (whole-body guards; S117 fail-closed rethrow preserved; claim-order verified); marker archive can't collide or re-open S117; no import cycles; GC fail-safe (DB error deletes nothing; idle-only; bounded); re-queue/stale-marker matrix holds incl. the POSITIVE_INFINITY belt direction; close-out survives every wipe attack; no CHILD_DEAD/WEDGE storm in the post-exit S129 tail; matching agrees with the real slash-prompt writers (`{run_floor_ms, before}` shape + list-canonical `task_id` persistence); read-only claims verified (grep-guard + SELECT-only + injection-guarded probes); entry hardening (isMain guard, exit-0 catch, cap-clamp directions).

---

## Round 4 — Sequential-QA fidelity pass (MRPF post-fix-revision topology): **PASS**

Same fresh-Claude lens (context intact — the MRPF "reviewer whose findings drove the fix verifies fidelity" rule), on commit `80d9df5`. **FIDELITY VERDICT: PASS** — all six findings [fixed correctly], counterexamples re-run against the new code:

- CE-1a (auth outage + job death): false RECOVERED gone; alerted state retained. CE-1b (auth genuinely heals while jobs run): genuine RECOVERED still emits.
- CE-2a (healthy 40-min render): zero findings through 5 ticks (was FYI at tick 2). CE-2b (genuinely wedged child): still fires at the 6th spaced sighting — detection preserved, not silenced. Escalation = 12 spaced sightings verified; wedge stays SOFT (grace-resettable — sleep can't fake "sustained").
- CE-3 (1s-adjacent run): no double-count; grace's `consecutive===0` arm prevents a spacing deadlock; measure-based escalation legitimately unaffected.
- CE-4 lock race: **0/400 double-acquisitions** (was 14/400).
- .gitignore rules confirmed via `git check-ignore -v`; PS regex escaping verified end-to-end; the real worker cmdline matches the tightened pattern live.
- Q3 sibling sweep: every latch key class now freeze-covered EXCEPT one narrow pre-existing INFO-grade exemption — `CHILD_WEDGED_POST_STUDIO` isn't frozen on a transient state.json/notebook-id read blip (`productsChecked===0` path). Post-fix consequence: one spurious "recovered" line for an FYI-class condition + ~30 min re-earn — bounded, bias-to-silence. Recorded for later polish; explicitly does not hold the merge.
- Suite/tsc independently re-verified on `80d9df5` (agent 760/760); worker-seam files byte-identical since round 1 (no re-audit exposure).

---

## Final synthesis

**GATE CLEARED — merge authorized.** Sequential order held: Gemini 3.1-pro holistic-adversarial (BLOCK → its sole CRITICAL empirically REFUTED on the deployment host, refutation recorded) → Codex gpt-5.5 xhigh grounded-adversarial on the same commit (BLOCK → 6 findings, all integrated, `eafea55`) → fresh-Claude grounded refutation lens on the integrated commit (BLOCK → 6 findings incl. 2 reproduced MAJORs both externals missed — the 4th consecutive fresh-lens catch in this family → all integrated, `80d9df5`, incl. a spec v4.1 amendment where the DESIGN itself encoded a defect) → Sequential-QA fidelity PASS.

**What each reviewer saw:** Gemini — design doc + full diff (no repo). Codex — full repo on the branch + license to run (used it: tests, tsc, a 200-trial race, a live CIM probe). Fresh lens — full repo on the integrated commit + live counterexample harnesses. QA — the fix diff + its own round-3 context.

**Key process lessons (recorded to memory):**
1. The fresh-lens rule (S195/S196) earns its keep AGAIN at MERGE: spec-fidelity reviewers structurally cannot catch a defect the SPEC encodes (F-2 wedge created_at) — only a lens asked "is this TRUE?" rather than "does this match the spec?" finds it. 4th consecutive catch.
2. Live-test refutation (S181 rule) beat a confident holistic CRITICAL again (PS 5.1 empty-pipeline ConvertTo-Json) — 2 minutes of empiricism vs an unnecessary integration.
3. "Blind ≠ absent" is now a doctrine for ANY latch/dedup state machine: Codex found it per-product, the fresh lens found the same class one level up (global), and QA's sibling sweep closed the enumeration. Freeze what you could not observe.

**Residuals (tracked, non-blocking):** wedge-key freeze on state-read blips (INFO, above); latch writes not temp+rename (dust-grade); cross-project `worker.ts` elsewhere-belt ambiguity (FYI-path only); `agentRuntimeDir()` assumes tsx-executed sources; deploy-step must verify the CIM probe under the registered task principal + StartIn=DR-Deploy (deploy notes).

**Verification state at gate close:** commits `98b0037` → `eafea55` → `80d9df5` on `s197-studio-product-checker`; agent 760/760, frontend 150/150, strict tsc clean, storage-path grep guard PASS. Raw logs: `/c/tmp/dr-s197/review/{gemini-out.log,codex-out.log}`; runner: `gemini-review.mjs`; prompts: `codex-prompt.md` + the two agent prompts (in-session).
