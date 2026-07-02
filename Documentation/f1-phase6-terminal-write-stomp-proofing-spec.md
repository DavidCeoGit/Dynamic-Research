# F1 — Stomp-proof Phase-6 terminal write + poller discipline (slash-prompt change spec) — v4

**v4 = post-fresh-lens integration.** Round history: v1 → Gemini 3.1-pro holistic BLOCK (MAJOR: interactive video-poll kill exception; MINOR: TOPIC_SLUG heredoc substitution) → v2 → self-caught gate-mirror gap (ALLOWED strings) → v2.5 → Codex gpt-5.5 xhigh grounded BLOCK (CRITICAL: glob()[0] stale-state pick; 3 MAJOR; 1 MINOR) → v3 → **fresh-Claude refutation lens BLOCK (5th consecutive family catch): [CRITICAL, REPRODUCED] the added `datetime` module import is SHADOWED by the template's existing line-1033 `from datetime import datetime, timezone`, so the copied resolver's `datetime.datetime(...)` raises AttributeError on EVERY run — swallowed by the total except → all three guards dead code + persist_poll_id regressed to silent no-op; [MAJOR] MODE default-to-NONINTERACTIVE loses the interactive video download when placeholder discipline fails → manifest auto-detect; 4 MINOR (persist one-shot atomic-rename failure window; F.4 sweep-rerun exemption wording; line-1009 dual-heartbeat conflict; mirror fail-closed edges)** → **v4 (this)**. All findings integrated.

**Target file:** `~/.claude/commands/research-compare.md` (global slash prompt, 1508 lines — NOT in the repo; live-immediately once edited).
**MRPF:** MERGE gate, Risk Label AGENT BEHAVIOR, Severity NORMAL. Sequential Gemini → Codex → fresh-Claude refutation lens (phase5/checker-family rule).
**Regression-forbidden zones:** Phase 5 Step 5e (lines ~642-750) and Phase 5.5 Step A.1 (~831-920) — crash-hardened S195, untouched. The S138 Layer-1/Layer-2 ride-to-cap design must be preserved (no early exit while the job is alive).

## 1. The incident class this fixes (S196, run 8bcd4644 — live-observed near-miss)

During the 98-min ConQr run `8bcd4644`, the `claude -p` child self-authored a variant poller (`studio_poll.py`) instead of using the template. It had blind done-detection (poll 49 still `done=[]` with every product on disk) and stomped `state.json` `phase_status` every 30s tick. The run completed only because the agent routed around it — the race is real: **an orphaned poller stomping `phase_status` AFTER the Phase-6 terminal write (`phase: "6"`, `phase_status: "complete"`) hard-fails a perfect run**, because the completion gate (`agent/lib/state-evaluation.ts:313-323`) then sees `phase="6"` (parseFloat < 7) and a non-"complete" status.

Gate code (shipped, verbatim):

```ts
const phaseRaw = state.phase;
const phaseStr = String(phaseRaw).trim().toLowerCase();
const phaseNum = parseFloat(phaseStr);
const phaseStatusStr = String(state.phase_status ?? "").trim().toLowerCase();
const ALLOWED = new Set(["7", "complete", "finalized", "finalised", "done"]);
const COMPLETE_AUGMENTED = /^complete[\s\-:(]/;
const isComplete =
  ALLOWED.has(phaseStr) ||
  (Number.isFinite(phaseNum) && phaseNum >= 7) ||
  phaseStatusStr === "complete" ||
  COMPLETE_AUGMENTED.test(phaseStatusStr);
```

`PHASE_MAP`: `"6" = Vendor Evaluation, 85%`; `"7" = Finalization, 95%`. The shipped anti-stop brief (`agent/lib/job-manifest.ts:226`) already tells the child *"the worker also accepts a numeric state.phase of 7+"*. So `phase: "7"` at the terminal write is (a) gate-stomp-proof, (b) display-more-accurate, (c) already documented to the child.

Second root cause: the prose (line 1009) demands a Fix-E heartbeat while driving the Studio loop, but the TEMPLATE contains no heartbeat code — giving the agent a reason to hand-roll a variant. F1 builds the heartbeat INTO the template, guarded.

## 2. The change — 4 edit sites

### EDIT 1 — Poller discipline preamble + template guards (Phase 5.5 Step C)

**1a-preamble. Insert after `**Unified Parallel Poll Loop:**` (line 1027), before the ```bash fence:**

> **Poller discipline (S198 — the 8bcd4644 orphan-stomp class):** use the template below VERBATIM — fill ONLY the placeholders (`MODE`, `<NOTEBOOK_ID>`, `WORKDIR`/`TOPIC_SLUG`, the `tasks` map, timestamps/output paths). Do NOT hand-roll a variant poller: run 8bcd4644's self-authored `studio_poll.py` had blind done-detection that never flipped AND stomped `state.json` `phase_status` every tick — an orphan poller stomping after the Phase-6 terminal write would hard-fail a perfect run at the completion gate. The template self-provides what the prose requires: the Fix-E heartbeat (non-interactive only; never once the run is terminal; never a `complete`/`ERROR`-prefixed status; atomic temp+rename like Step 5e's), orphan self-termination (exits 0 on a terminal or ERROR marker, judged by an EXACT worker-gate mirror), a newest-state-file resolver (never `glob()[0]`), and a hard orphan deadline far above the worker cap. A hand-rolled poller has none of these guards.

**1a-imports. The template's import line (line 1032)** `import time, subprocess, re, sys, json, glob` **becomes** `import time, subprocess, re, sys, json, glob, os` — **`os` ONLY, NOT `datetime`**: the untouched next line (1033) is `from datetime import datetime, timezone`, which binds `datetime` to the CLASS. Adding the module import would be shadowed by it (fresh-lens CRITICAL: `datetime.datetime(...)` then raises AttributeError, silently killing every guard through the resolver's total except). The resolver below therefore calls the class directly: `datetime(y, mo, d, h, mi, s)`.

**1b. Replace the STATE_PATH selection lines (1066-1067):**

```python
state_files = glob.glob(WORKDIR + '/*-state.json')
STATE_PATH = state_files[0] if state_files else None
```

**with the resolver + guard functions (resolver = faithful mirror of `find-state-file.ts` selectNewestStateFile, same as the Step 5e/A.1 resolver, WORKDIR-anchored):**

```python
DEADLINE = time.time() + 300*60   # ORPHAN backstop = 2x MAX_JOB_DURATION (currently 150 min).
                                  # MUST stay comfortably ABOVE the worker cap: on a live job the cap
                                  # kills the whole child tree first, so this fires ONLY for a poller
                                  # that outlived its job (e.g. survived a cap-kill). If you raise
                                  # MAX_JOB_DURATION_MS past 150 min, keep this >= 2x that value.
                                  # Exit 0, no state write — NEVER an early exit on a live job.

def resolve_state():
    # Faithful mirror of find-state-file.ts selectNewestStateFile (identical to the Step 5e /
    # Step A.1 resolver) so the guards, heartbeat, and persist_poll_id ALWAYS land on the SAME
    # file the worker reads. NEVER glob()[0]: platform-arbitrary order — a stale TERMINAL state
    # file from a prior run in a reused workdir would falsely stand this poller down.
    # TOTAL: any filesystem surprise (vanished WORKDIR, mtime race) returns None, never raises —
    # the loop-top guard calls this outside a try, and an uncaught poller crash is the
    # S195-class worst outcome.
    try:
        cands = [WORKDIR + '/' + n for n in os.listdir(WORKDIR) if n == 'state.json' or n.endswith('-state.json')]
        def emb(f):
            m = re.match(r'^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-state\.json$', os.path.basename(f))
            if not m: return None
            y, mo, d, h, mi, s = map(int, m.groups())
            if y < 100: return None
            try: return datetime(y, mo, d, h, mi, s)   # datetime is the CLASS here (line 1033 from-import) — NOT datetime.datetime as in Step 5e's module-import namespace
            except ValueError: return None
        ts = [(t, f) for f in cands for t in [emb(f)] if t is not None]
        if ts:
            ts.sort(key=lambda x: (x[0], os.path.basename(x[1])))
            return ts[-1][1]
        if cands:
            return max(cands, key=lambda f: (os.path.getmtime(f), os.path.basename(f)))
        return None
    except Exception:
        return None

def read_state():
    sp = resolve_state()
    if not sp:
        return None
    try:
        with open(sp) as f:
            return json.load(f)
    except Exception:
        return None

def run_is_over(st):
    # EXACT mirror of the worker gate (state-evaluation.ts evaluateTerminalState): non-primitive
    # phase/phase_status fails CLOSED (gate calls it malformed -> NOT complete, so keep polling);
    # ALLOWED phase strings; JS-parseFloat-compatible FINITE numeric >= 7; phase_status exactly
    # 'complete' or ^complete[\s\-:(]. Plus one poller-specific standdown: an 'ERROR:'-prefixed
    # status (the contract format) also ends the run (never overwrite an error report).
    if not isinstance(st, dict):
        return False
    if isinstance(st.get('phase'), (dict, list)) or isinstance(st.get('phase_status'), (dict, list)):
        return False
    ph = str(st.get('phase', '')).strip().lower()
    if ph in ('7', 'complete', 'finalized', 'finalised', 'done'):
        return True
    m = re.match(r'^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?', ph)   # JS parseFloat prefix parse
    if m:
        try:
            v = float(m.group(0))
            if v >= 7 and v != float('inf'):                       # gate requires FINITE >= 7
                return True
        except Exception:
            pass
    ps = str(st.get('phase_status', '')).strip().lower()
    if ps == 'complete' or re.match(r'^complete[\s\-:(]', ps):
        return True
    return ps.startswith('error:')   # contract format is 'ERROR: <detail>' — a drifted transient line like 'error rate high, retrying' must NOT stand the poller down

def heartbeat(n_done, n_all, count):
    # Fix E: fresh progress line every tick so state.json / the process page never look frozen.
    # Atomic temp+rename (mirror of the Step 5e heartbeat) so a concurrent worker/process-page
    # read never sees a partial file. Best-effort; NEVER writes once the run is terminal; the
    # status NEVER begins with 'complete' or 'ERROR'.
    try:
        sp = resolve_state()
        if not sp:
            return
        with open(sp) as f:
            st = json.load(f)
        if run_is_over(st):
            return
        st['phase_status'] = f'Phase 5.5a: Studio polling - {n_done}/{n_all} products complete (poll {count})'
        tmp = sp + '.hb.tmp'
        with open(tmp, 'w') as f:
            json.dump(st, f, indent=2)
        os.replace(tmp, sp)
    except Exception as e:
        print(f'WARN: heartbeat write failed: {e}', flush=True)

MODE = '<NONINTERACTIVE|INTERACTIVE>'  # fill with the run mode (worker / claude -p => NONINTERACTIVE)
if MODE not in ('NONINTERACTIVE', 'INTERACTIVE'):
    # Placeholder unfilled/mis-filled: recover from RUN-LOCAL facts, never guess (a wrong
    # static default self-terminates a deliberately-spared interactive video poll — fresh-lens
    # MAJOR). Preference: (1) state.mode — step 1.6 persists it per-run, fresh by construction;
    # (2) job-manifest presence (executor writes it into this exact workdir) — slug-persistent,
    # so it can be STALE on an interactive rerun of a previously-worker-run topic (fresh-lens
    # residual edge), hence last resort only.
    _st = read_state()
    _m = str(_st.get('mode', '')).strip().upper() if isinstance(_st, dict) else ''
    if _m in ('NONINTERACTIVE', 'INTERACTIVE'):
        MODE = _m
    else:
        MODE = 'NONINTERACTIVE' if os.path.exists(WORKDIR + '/job-manifest.json') else 'INTERACTIVE'
    print(f'WARN: MODE placeholder not filled - auto-detected {MODE} (state.mode first, manifest fallback)', flush=True)
```

*(MODE sits AFTER the function definitions because its recovery path calls `read_state()`.)*

**1b-persist. `persist_poll_id` (lines 1069-1082) is rewired to the resolver + atomic write (the glob()[0] CRITICAL applied to it too — it could persist poll ids into a STALE state file the worker never reads):**

```python
def persist_poll_id(product, poll_id):
    # Persist to state.artifacts[product] — the path the worker reads
    # (studio-completeness.ts expectedArtifactId). Tightens the backstop AND
    # survives a cap-kill recovery. Best-effort. Resolves the state file fresh
    # (never a stale glob()[0] pick). Atomic temp+rename FIRST; on failure
    # (Windows sharing violation from a concurrent python reader blocks
    # os.replace but NOT a direct write) fall back to the legacy direct write —
    # this is called ONCE per product at re-alias, so a silently-dropped write
    # permanently loses that product's expectedArtifactId (fresh-lens MINOR).
    try:
        sp = resolve_state()
        if not sp:
            return
        with open(sp) as f:
            st = json.load(f)
        st.setdefault('artifacts', {})[product] = {'task_id': poll_id}
        try:
            tmp = sp + '.pp.tmp'
            with open(tmp, 'w') as f:
                json.dump(st, f, indent=2)
            os.replace(tmp, sp)
        except Exception:
            with open(sp, 'w') as f:
                json.dump(st, f, indent=2)
    except Exception as e:
        print(f'WARN: could not persist poll_id for {product}: {e}', flush=True)
```

**1c. Loop-top guards — insert between `while len(completed) < len(tasks):` (line 1122) and `    poll_count += 1`:**

```python
    if time.time() > DEADLINE:
        print('ORPHAN_DEADLINE: poller outlived 2x MAX_JOB_DURATION - exiting, NO state write', flush=True)
        sys.exit(0)
    if MODE == 'NONINTERACTIVE' and run_is_over(read_state()):
        print('TERMINAL_SEEN: run already finalized - orphan poller exiting, NO state write', flush=True)
        sys.exit(0)
```

**1d. Replace the loop tail (lines 1189-1190):**

```python
    if len(completed) < len(tasks):
        time.sleep(interval)
```

with:

```python
    if len(completed) < len(tasks):
        if MODE == 'NONINTERACTIVE':
            heartbeat(len(completed), len(tasks), poll_count)
        time.sleep(interval)
```

*Why MODE-gated:* in INTERACTIVE mode the prompt legitimately offers "proceed to Phase 6 while video polls in the background" (line 1009) — an interactive late video poller is NOT an orphan, must not self-terminate on the terminal marker, and has no DB watcher needing heartbeats. The orphan DEADLINE applies in both modes. An unfilled MODE placeholder auto-detects from run-local facts (state.mode first, manifest probe fallback) with a visible WARN — never a static default.

### EDIT 2 — Track the poller shell (line 1201)

Replace: `Run with `run_in_background: true`.`

With: `Run with `run_in_background: true`. Record the background shell id the harness returns the moment you launch it — Phase 6 Step F kills every recorded poll shell before the terminal write.`

### EDIT 3 — Phase 6 Step F: poller teardown + stomp-proof terminal write (replaces line 1466)

Replace the line `**State update:** `phase: "6"`, `phase_status: "complete"`.` with:

### Step F — Poller Teardown + Terminal Write (MANDATORY — the LAST actions of the run)

The terminal write below must be the FINAL `state.json` write of the entire run. An orphaned background poller stomping `phase_status` after it is the S196/8bcd4644 near-miss race that hard-fails a perfect run. Execute in this exact order:

1. **Kill background poll shells this run spawned** (`run_in_background: true` shells — the unified Studio poll loop, any Phase-3 long poll, any video poll): use the harness kill on each recorded shell id. **Interactive-mode exception (matches step 2's):** do NOT kill a video poll you deliberately left running per Phase 5.5 step 5 — it must survive to download the video.
2. **Defensive orphan sweep.** Non-interactive mode: MANDATORY. Interactive mode: skip if you deliberately left a video poll running (Phase 5.5 step 5). Kill any python process whose command line references THIS run — the match requires BOTH this run's `TOPIC_SLUG` AND this run's `TIMESTAMP` (two concurrent runs of the same topic share the slug but never the timestamp; both tokens are `[A-Za-z0-9-]` so they are regex-safe literals). Zero kills is the healthy result (the unified loop exits itself on the happy path); the two-token scope protects the worker daemon, the NLM CLI, other jobs, and same-slug siblings. **Before running, replace `TOPIC_SLUG` and `TIMESTAMP` in the script with this run's ACTUAL values** (same fill-the-placeholder convention as the poll template — the heredoc is quoted, so bash will NOT interpolate anything for you):

```bash
cat > /tmp/kill-run-pollers.ps1 << 'EOF'
Get-CimInstance Win32_Process -Filter "Name LIKE 'python%'" |
  Where-Object { $_.CommandLine -match 'TOPIC_SLUG' -and $_.CommandLine -match 'TIMESTAMP' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Output "killed poller PID $($_.ProcessId)" }
EOF
powershell -NoProfile -ExecutionPolicy Bypass -File /tmp/kill-run-pollers.ps1
```

3. **Terminal state update — ONE write, BOTH fields:** `phase: "7"`, `phase_status: "complete"`. `phase: "7"` is the stomp-proof half of the terminal contract: the worker gate (`agent/lib/state-evaluation.ts`) passes on `phase >= 7` OR `phase_status == "complete"` INDEPENDENTLY, so a `phase_status`-only stomp by a missed orphan can no longer fail the run. (`"7"` also maps to Finalization/95% in the progress display — more accurate than the old `"6"`, which showed Vendor Evaluation/85%. The anti-stop brief already documents "phase of 7+" to the child.)
4. **Verify-after-write:** re-read `state.json`; if it does not show `phase: "7"` AND `phase_status: "complete"`, a live stomper raced you — re-run step 2's sweep **under the same exemptions** (interactive mode: still spare a deliberately-running video poll), then re-write the terminal state ONCE more. After this, NOTHING may touch `state.json` — no pollers, no heartbeats, no cleanup writes.

*(The two existing blockquotes — PUBLISH terminal requirement S108 + CRITICAL terminal marker contract S57 Bug 49 — remain unchanged, immediately after this step.)*

### EDIT 4 — Kill the dual-heartbeat instruction (line 1009, fresh-lens MINOR)

The template now writes the Fix-E heartbeat itself; line 1009's instruction to "write a `phase_status` heartbeat on each poll" would make the agent a SECOND concurrent state.json writer racing the template's RMW — and the prose-vs-template contradiction is the drift-inducer class F1 exists to remove. In line 1009, replace the clause:

`poll the video render to completion within its timeout, writing a `phase_status` heartbeat on each poll (Fix E);`

with:

`poll the video render to completion within its timeout — the template's poll loop writes the Fix-E `phase_status` heartbeat for you; do NOT write a parallel heartbeat yourself;`

*(The manifest brief (`job-manifest.ts:226`) still says "write a fresh progress line yourself while driving the Studio render loop" — repo code, out of F1's scope; it defers to this file's specifics, and its stale clause is queued for the next agent/ batch ([D]).)*

## 3. Defense-in-depth layering

| Layer | Mechanism | What it stops | Known residual |
|---|---|---|---|
| 1 (primary) | Step F.1/F.2 kill before terminal write (two-token scope) | any live poller at write time | agent drift skips Step F; hand-rolled poller lacking TIMESTAMP in cmdline escapes F.2 (but shell-id kill F.1 + guards below remain) |
| 2 | template terminal-guard exit (exact gate mirror, fresh newest-file resolve, 30s ticks) | orphan that survived layer 1 | ms-scale race: heartbeat's read→rename straddling the terminal write stomps BOTH fields |
| 3 | `phase: "7"` in terminal write | any stomper that writes ONLY `phase_status` (all observed hand-rolled pollers) | a whole-doc RMW stomper (layer-2's residual) |
| 4 | Step F.4 verify-after-write + one re-write | the layer-2/3 residual race | stomp landing between re-write and child exit — requires missing layers 1 AND 2 AND a 30s tick inside a ~1s window |
| 5 | 300-min orphan DEADLINE (≥2× cap) | immortal orphan surviving a cap-kill (non-terminal state, guard-2 never fires) | operator raising MAX_JOB_DURATION_MS above 300 min without updating the template note |

## 3.5 STATE_PATH selection safety (reused workdirs)

The resolver no longer leans on the S117 archive alone: `resolve_state()` picks the NEWEST state file by embedded timestamp (mtime fallback) exactly like `find-state-file.ts`, so even if a stale terminal state file survives in the workdir (interactive runs have no archiver; the S87 oldest-pick bug is the precedent), the guards, heartbeat, and persist_poll_id all land on the live run's file — the same file the worker gate evaluates. The S117 fail-closed archive remains the first line for NONINTERACTIVE (guard-armed) runs.

## 4. What this change does NOT do

- Does NOT touch Step 5e / Step A.1 (regression-forbidden). It REUSES their resolver + atomic-heartbeat patterns verbatim.
- Does NOT change the S138 no-early-exit / ride-to-cap semantics: the template still never exits on detection failure; the DEADLINE (300 min ≥ 2× cap) cannot fire on a live job.
- Does NOT change any agent/ repo code (slash-prompt only; `job-manifest.ts:226` already documents phase 7+).
- Does NOT change interactive-mode behavior except the 300-min orphan deadline and the optional Step F sweep (both video-poll-exempt).
