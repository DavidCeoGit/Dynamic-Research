# F1 MERGE-gate synthesis — slash-prompt stomp-proofing (S198) — GATE CLEARED, APPLIED, VERIFIED

**Change:** `~/.claude/commands/research-compare.md` — poller discipline + in-template guards (Phase 5.5 Step C) + Phase 6 Step F (poller teardown → `phase:"7"`+`"complete"` terminal write → verify-after-write). Spec: `/c/tmp/dr-s198/review/f1-change-spec.md` (v3).
**MRPF:** MERGE gate; AGENT BEHAVIOR; NORMAL severity. Sequential Gemini → Codex → fresh-Claude family lens. Slash-prompt (live-immediately, not agent/ repo code) — normal MRPF latitude, S141 agent/-prod tightening not triggered, gate still run in full per family rule.

## Round 1 — Gemini 3.1-pro-preview (holistic-adversarial) — BLOCK → integrated
What it saw: full review bundle (spec v1 + verbatim current-file regions + gate/brief code). Banner: prompt=14747 thoughts=22322 out=665 finish=STOP.
- [MAJOR] Step F.1 killed ALL poll shells including a deliberately-running interactive video poll — contradicts Phase 5.5 step 5. → v2: interactive-mode exemption added to F.1 (mirrors F.2's).
- [MINOR] `TOPIC_SLUG` inside a QUOTED heredoc never interpolates — a verbatim copy sweeps nothing. → v2: explicit fill-the-placeholder instruction.
- [INFO] heartbeat whole-doc RMW race — judged correctly mitigated by Step F.4 verify-after-write ("defense-in-depth logic here is sound").

## Round 1.5 — author self-catch (between reviewers)
- run_is_over missed the gate's ALLOWED strings (`Complete`/`done`/`finalized` phases) → tightened to mirror; 31-case battery written (all pass).

## Round 2 — Codex gpt-5.5 xhigh (grounded-adversarial, workspace-write) — BLOCK → integrated
Banner asserted: `model: gpt-5.5`, reasoning xhigh, sandbox workspace-write (per §11 assert-what-ran rule). It reconstructed the full post-edit template, py_compiled it, and ran a JS-parseFloat-vs-python differential harness (its harness + results in codex-out.log lines 9214-9815).
- [CRITICAL] `STATE_PATH = glob(...)[0]` — platform-arbitrary pick; REPRODUCED a stale terminal state file standing down a LIVE poller. → v3: `resolve_state()` = faithful copy of the Step 5e/A.1 newest-timestamp resolver (mtime fallback), resolved FRESH on every read; also rewired `persist_poll_id` (same latent defect — it could persist poll ids into a file the worker never reads).
- [MAJOR] gate mirror still over-eager: `completed 3/5` (startswith) and `Infinity`/`1e309` (python float vs JS parseFloat finite) stand down a live poller. → v3: exact mirror — ALLOWED strings + JS-parseFloat-style prefix parse with finite check + `^complete[\s\-:(]`/exact-`complete`; ERROR standdown kept as a separate explicit case (Codex endorsed).
- [MAJOR] hardcoded 150-min deadline fires BEFORE a raised worker cap (e.g. 180-min) → early poller exit defeats Layer-2 ride-to-cap. → v3: 300 min (≥2× current cap) + explicit coupling note ("if you raise MAX_JOB_DURATION_MS keep this ≥2×").
- [MAJOR] slug-only sweep can kill a concurrent same-slug run's processes. → v3: two-token match (TOPIC_SLUG AND this run's TIMESTAMP — same slug never shares a timestamp).
- [MINOR] MODE placeholder left verbatim silently disables both guards. → v3: normalize + default NONINTERACTIVE with printed WARN (fail-safe toward the worker path, where the gate race lives).
GROUNDED-CORRECT (Codex-verified): post-edit template py_compiles; malformed-state cases raise nothing; added lines survive the `python -c "` double-quote embedding; PS sweep parses as valid PowerShell; Gemini fixes correctly integrated; publish/lint failure paths exit BEFORE Step F (no false-complete ordering).

## Round 2.5 — author self-catch (v3 battery)
- `resolve_state()` called from the loop-top guard OUTSIDE try — vanished-WORKDIR FileNotFoundError would crash the poller uncaught (S195-class worst outcome). → wrapped total (returns None). Final battery: 54/54 PASS (gate-mirror differential 29, ERROR extension 3, resolver/atomicity/crash-totality 22).

## Round 3 — fresh-Claude refutation lens (family-mandatory) — BLOCK → integrated (5th consecutive family catch)
Zero-authoring-context adversarial agent; read v3 spec + file copies + both external reviews + the self-test; ran reproduced counterexamples (`selftest/refute_v3_counterexamples.py`).
- **[CRITICAL, REPRODUCED] Import shadow kills the entire v3 guard stack.** EDIT 1a-imports added `datetime` to line 1032, but the UNTOUCHED line 1033 `from datetime import datetime, timezone` rebinds `datetime` to the CLASS — the resolver (copied from Step 5e's module-import namespace) calls `datetime.datetime(...)` → AttributeError on EVERY run (state files always match the timestamp regex) → swallowed by the resolver's deliberately-total except → returns None → terminal guard dead, heartbeat dead, and `persist_poll_id` REGRESSED from working-in-the-common-case to silent no-op. Why 3 reviewers + author missed it: Gemini saw spec text; Codex's harness reconstructed the PRE-resolver v2.5 template; the author's battery RE-TYPED the functions under its own imports — the one namespace difference that matters. → v4: import adds `os` ONLY; emb() calls the class directly `datetime(y,...)`; self-test rebuilt namespace-faithful (executes the spec code under the template's exact import lines).
- **[MAJOR] MODE default-to-NONINTERACTIVE loses the interactive video download** the moment placeholder discipline fails (the exact loss Gemini's MAJOR was integrated to prevent; masked by the CRITICAL until it's fixed). → v4: manifest auto-detect (`os.path.exists(WORKDIR + '/job-manifest.json')` — verified: executor writes the manifest into that exact dir).
- [MINOR ×4] persist one-shot atomic-rename failure window (Windows sharing violation from a concurrent python reader; REPRODUCED) → atomic-then-direct-write fallback; F.4 sweep-rerun must restate the interactive exemption → worded; line-1009 dual-heartbeat contradiction → new EDIT 4 (template writes it; agent must not); mirror fail-closed edges (non-primitive fields; bare-"error" over-match) → non-primitive returns False, ERROR standdown requires contract `error:` prefix.
- ANGLES ATTACKED, NO REFUTATION: phase:"7" second-order (PHASE_MAP/watchStateFile/brief/recovery all compatible); F.4 vs legitimate concurrent writers (none exist while child alive); 8bcd4644 max-drift replay (layer-3 alone saves the run; whole-doc stomper + all layers skipped fails identically to today); parseFloat mirror across 12 exotic inputs; resolver None-vs-'state.json' fallback delta (None is correct for a background poller); bash quoting; deadline-vs-cap; two-token sweep scope; tmp-litter glob poisoning; os.replace vs Node/libuv readers.

## Round 3.5 — Sequential-QA fidelity pass (same lens agent, v4) — FIDELITY: PASS
All six findings re-verified closed by replaying its own counterexamples against the v4 code verbatim under the template's exact assembled import lines (`selftest/refute_v4_fidelity_recheck.py`, 15/15). Per-finding: CRITICAL closed (resolver works under from-import namespace; `created_ms` unaffected); MAJOR closed both directions; all four MINORs closed. It ALSO demonstrated one residual edge in the MODE fix (the manifest probe is slug-persistent → stale manifest on an interactive rerun of a previously-worker-run topic mis-detects NONINTERACTIVE) and offered the cleaner `state.mode`-first recovery — **adopted in-round** (verified: prompt step 1.6 persists `mode` per-run; `mode_recovery_test.py` 7/7 incl. the residual-edge case). Two spec-text NITs (stale rationale sentence; "3 edit sites" header) fixed.

## Applied + verified (S198, same session)
All 9 edit operations applied to the LIVE `~/.claude/commands/research-compare.md` (live-immediately; no repo commit or worker restart needed — the child reads the prompt at spawn). Post-apply verification `selftest/verify_live_file.py`: **26/26 PASS** — assembled template extracted from the live file py_compiles under its real namespace; exactly one `phase:"7"`+`"complete"` terminal write and zero `phase:"6"` ones; Step F/preamble/EDIT-4/two-token sweep present; no leftover `STATE_PATH`; no unescaped double quotes in the embedded python; Step 5e/A.1/S138 markers intact.

## Meta-lesson (5th consecutive fresh-lens catch in this family)
The CRITICAL was a NAMESPACE defect invisible to every spec-fidelity reader: correct code copied into a scope that breaks it (`from datetime import datetime` shadowing the module). Neither external could see it — Gemini read spec text; Codex's harness reconstructed the PRE-fix template version; the author's own battery re-typed the functions under different imports. The mechanical countermeasure is now standing: **self-tests for embedded-template code must execute the code under the template's EXACT assembled import lines, extracted or replicated verbatim — never re-typed into a fresh namespace.**

## What each reviewer saw
Gemini: bundle only (spec v1 + verbatim file regions + gate code) — no live repo. Codex: full local review workspace (spec v2.5 live file copies), ran code. Fresh lens: v3 spec + file copies + both prior reviews' outputs + self-test battery, ran code.

## Deploy plan (post-PASS)
1. Apply the 3 edit sites to `~/.claude/commands/research-compare.md` (global file — direct Edit; live-immediately; no repo commit, no worker restart needed — the child reads the prompt at spawn).
2. Verify: re-read edited regions; re-extract the template python and py_compile it; grep the file for exactly one `phase: "7"` terminal write and zero remaining `phase: "6"` terminal writes.
3. Validation: next real run (or next dogfood) should show heartbeat lines in state.json during Studio, `TERMINAL_SEEN`/clean poller exit in the shell log, killed-poller count 0 on happy path, and the DB/gallery run completing with phase 7/Finalization 95%.
