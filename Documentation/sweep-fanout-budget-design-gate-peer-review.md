# Peer Review — Per-sweep budget with breadth-fair tree-position resume (DESIGN gate)

Companion to `Documentation/sweep-fanout-budget-design-gate.md`. MRPF DESIGN gate, sequential
topology, both lenses adversarial. Reviewer order: Gemini (holistic-adversarial, breadth) →
integrate v2 → Codex (grounded-adversarial, depth, file:line) → integrate v3 (final).

**What each reviewer saw**
- **Gemini 3.1 Pro** (holistic-adversarial): design doc **v1** + full `agent/lib/staging-sweep.ts` + the worker idle-tick invocation context. Lens: whole-artifact breadth, "strongest case to BLOCK."
- **Codex** (ChatGPT auth, `codex exec -s read-only`, grounded-adversarial): design doc **v2** + `agent/lib/staging-sweep.ts` (file:line) + `agent/worker.ts` + `agent/scripts/cleanup-staging-uploads.ts` + `conventions.{ts,json}` + `agent/test/staging-sweep.test.ts` in its read-only sandbox. Lens: code-grounded depth, counterexamples against shipped code.

**Outcome:** both reviewers returned **BLOCK** on the revision they saw. v2 integrated all 3 Gemini
findings (2 BLOCKING + 1 MAJOR); v3 integrated all 7 Codex findings (2 BLOCKING + 4 MAJOR + 1 MINOR).
No BLOCKING/MAJOR remains open. Disposition tables in the design doc §11 (Gemini) and §12 (Codex).

---

## Round 1 — Gemini holistic-adversarial (on v1) — VERBATIM

WHAT I SAW: Design doc (v1) + Subject file `agent/lib/staging-sweep.ts`.

**VERDICT: BLOCK**

This design elegantly solves the persistent-cursor-leak problem (Codex MAJOR) but introduces a **catastrophic global starvation vulnerability** while doing so. It also contains a fundamental mechanical contradiction regarding pagination that will cause it to burn its entire budget on discarded network responses. You cannot ship this as proposed.

Here is the adversarial breakdown.

### 1. [BLOCKING] Global GC Starvation (The "No Worse Than S111" Fallacy)
**The Concern:** In Â§4.2 and Q6, the design claims that serializing the drainage of a massive prefix across multiple sweeps is "acceptable" and "no worse than S111." **This is factually false.**
Under S111, if `Org A` had 200,000 drafts, the sweep would process `MAX_PAGES` (20,000 drafts), save a cursor *for that org in the map*, and then **continue scanning `Org B`, `Org C`, etc., in the same sweep**. Every tenant received GC progress every day.
Under your single-advancing-frontier model, if `Org A` has 200k drafts, the sweep hits the budget in `Org A` and *stops the entire walk*. Tomorrow, it resumes in `Org A`. It will stay trapped in `Org A` for 10+ days. During this time, **every other tenant in the system is completely starved of GC**. A single runaway script or malicious tenant generating empty drafts can indefinitely pause garbage collection for the entire platform, causing unbounded storage growth.
**Why it matters:** Trades a known prefix-tail delay for a complete system-wide GC denial-of-service. Your "starvation-free by construction" claim only holds for intra-prefix tails, but creates absolute global starvation.
**Recommended Fix:** The single-frontier model is inherently at odds with fairness in a multi-tenant tree. You must make a choice:
*   *Option A (Keep single frontier, accept risk):* If you genuinely want to accept this risk for the sake of simplicity, you must explicitly document this as a "Noisy Neighbor GC Denial of Service" vulnerability, not claim parity with S111.
*   *Option B (Maintain Fairness):* Reintroduce a multi-cursor state (the map) so you can enforce a `maxRequestsPerPrefix`, yield, and move to the next org, resuming the deep org later.

### 2. [BLOCKING] O(N^2) Request Waste & The `MAX_PAGES` Contradiction
**The Concern:** The design retains `MAX_PAGES` as a "per-visit memory cap", implying `listChunk` will still internally fetch up to 20 pages (20,000 items) before yielding to the DFS processing loop. This is a fatal mismatch for a budgeted exact-offset walk.
If `listChunk` fetches 20 pages of drafts (costing 20 requests) and returns 20,000 drafts, the DFS will begin calling `list()` for each draft's files. After processing ~280 drafts, the global `maxRequests` budget (300) is exhausted. The sweep stops. The remaining 19,720 drafts you just fetched are discarded from memory.
Tomorrow, the sweep resumes at exact offset `280`. It fetches 20 pages *again*, processes 280 drafts, and discards the rest. You will fetch the same drafts dozens of times, burning your network budget on data you immediately throw away.
**Why it matters:** The sweep will thrash, doing exponentially more listing work than necessary and severely degrading the actual GC throughput.
**Recommended Fix:** Delete `MAX_PAGES` and the `listPrefix` loop entirely. In a precise-offset DFS, `listChunk` should fetch exactly **ONE page** (1,000 items). The DFS processes it; when exhausted, it requests the next single page. Memory is naturally bounded to O(depth) (3,000 items maximum), and 0 requests are wasted on discarded data. The global `maxRequests` is the only bound you need.

### 3. [MAJOR] Exact Offset Mapping Off-By-One
**The Concern:** You correctly identified this in Q1 as the most error-prone part. When iterating `orgFolders`, the index `i` of the filtered array does *not* match the Supabase offset.
If the raw page is `[file, orgA, file, orgB]` and budget exhausts on `orgB` (filtered index `i=1`), saving `offset: startOffset + 1` is wrong (that points to `orgA`). You must save `offset: startOffset + 3`.
**Why it matters:** Resuming at the filtered index will cause the sweep to step backwards, creating infinite loops if the step-back puts it behind the budget exhaustion point.
**Recommended Fix:** The filtering step must retain the raw index. Example: `rootRes.items.map((item, rawIdx) => ({ item, rawIdx })).filter(isOrg)`. The snapshot must always use `startOffset + current.rawIdx`.

---

### Explicit Answers to Open Questions (Â§9)

*   **Q1 (Offset mapping):** Addressed in Finding #3. You absolutely must map back to the `rawIdx` of the unfiltered page.
*   **Q2 (Count deletes?):** **Endorse not counting them.** Deletes are transitively bounded by the listing budget. However, because `DELETE` is network I/O, ensure the final `flush()` batch doesn't wildly exceed your intended worker-tick delay. The current 100-path batch is fine.
*   **Q3 (Budget tuning location):** **Module constants.** This is a safety backstop. Don't expose operator knobs in `conventions.json` until there is proven operational need.
*   **Q4 (CLI Budget):** **`Infinity` is dangerous.** A human running the CLI on a massive tree with `Infinity` will likely trigger Supabase API rate limits or worker memory exhaustion (especially if you fix Finding #2 to stream 1 page at a time). The CLI should enforce the budget, but wrap the sweep in a `while (stats.nextCursor)` loop with a small sleep between chunks to pace the API.
*   **Q5 (Fail-closed cadence regression?):** **No regression.** The pre-write persisting the incoming `walkCursor` perfectly preserves the idempotent, fail-closed guarantee of S111. If the worker crashes mid-sweep, the next run will correctly resume from the pre-written `walkCursor`.
*   **Q6 (Serialize huge prefix):** **NOT ACCEPTABLE.** (See Finding #1). It is a fundamental regression of multi-tenant fairness and violates your core claim that this is "no worse than S111."
---

## Round 2 — Codex grounded-adversarial (on integrated v2) — VERBATIM

**Verdict: BLOCK**

The unchanged UUID/staging/TTL delete predicate still prevents resume math from deleting a non-expired file, but v2’s resume algorithm is not coherent enough for a DATA-labelled destructive GC path. I found concrete starvation paths where `orgStartOffset` gets stranded and coverage is lost indefinitely, so the design’s “transient miss only” claim is false.

1. **[BLOCKING] Non-zero root passes can strand `orgStartOffset` at EOF forever.**  
Anchor: `sandbox/sweep-fanout-budget-design-gate.md:149-177`, especially `rootStartedAtZero` gating wrap at lines 171-174. Current S111 explicitly distinguishes “resumed tail” from “complete pass” in [agent/lib/staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:52>) and tests it at [agent/test/staging-sweep.test.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/test/staging-sweep.test.ts:419>).  
Counterexample: root raw offsets are `0=A, 1=B, 2=C`; cursor starts at `orgStartOffset=1`. Sweep processes B and C, reaches EOF, `rootStartedAtZero=false`, so no wrap to 0. `nextOrgStart` becomes `3`. Every later sweep lists root at offset 3, gets empty, and stays at 3. A/B/C are skipped forever.  
There is also a design contradiction: the cursor comment says wrap after a complete root pass “with no org left truncated” (`design:101-102`), but the pseudocode wraps after `rootComplete && rootStartedAtZero` regardless of `orgResume`. If an implementer follows the comment, root `[A huge, B]` leaves A’s resume entry stranded after B completes.  
Fix: define root traversal as circular. When a tail scan from non-zero reaches EOF, the next cursor must become `0`; pruning remains separately gated on an offset-0 EOF pass. Remove “with no org left truncated” from wrap semantics.

2. **[BLOCKING] Root pages containing no UUID orgs can be re-fetched forever under budget pressure.**  
Anchor: design §4 only updates `nextOrgStart` from `org.rawOffset` / `org.rawOffsetAfter` (`design:153-168`). Real code filters root entries after listing at [agent/lib/staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:289>), and existing tests include non-UUID root folders/files at [agent/test/staging-sweep.test.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/test/staging-sweep.test.ts:87>).  
Counterexample: 301 root pages of legacy non-UUID folders precede the first UUID org; `maxRequests=300`. If root page listing consumes request budget but no org is discovered, `nextOrgStart` remains the original offset. Next sweep starts over and never reaches the UUID org.  
Fix: maintain a raw `rootScanOffset` advanced after every root page, even pages with zero valid org folders. If the budget trips during root paging, persist the next raw root offset. Add a junk-only root-page regression test.

3. **[MAJOR] The per-org cap math is unsafe unless file-list calls are explicitly counted.**  
Anchor: design claims `maxRequestsPerOrg=50` caps a giant org at “50 pages (~50k drafts)” (`design:192-193`). But current code issues one list call for the org’s draft folder page and then one list call per draft file prefix at [agent/lib/staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:299>) and [agent/lib/staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:315>). The worker awaits this on idle tick at [agent/worker.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/worker.ts:241>).  
Counterexample: one org with 50,000 draft folders, one file each. If `drainOrg` fetches 50 draft pages and then drains those drafts, that is `50 + 50,000` list calls, not 50.  
Fix: the predicate must be checked and incremented before every `list()` at every level: root, `<org>/uploads`, and `<org>/uploads/<draft>`. Stop inside a draft page and save the current raw draft/file offset. Add a test asserting `requestsUsed <= maxRequestsPerOrg` for many drafts with one file each.

4. **[MAJOR] Raw-offset threading is required, but the design must specify exact `rawOffset` / `rawOffsetAfter` rules.**  
Anchor: current filters discard raw indices at [agent/lib/staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:289>), [agent/lib/staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:308>), and [agent/lib/staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:319>). v2 correctly calls this out at `design:124-135`, but §4 is still easy to implement off by one.  
Counterexample: page base `100`, raw entries `[junk, orgA, junk, orgB]`. Filtered indices are `[orgA=0, orgB=1]`. After orgA, the correct next raw offset is `102`; using filtered index gives `101`, re-listing orgA.  
Fix: for every filtered child use `{ item, rawOffset: pageBase + rawIdx, rawOffsetAfter: pageBase + rawIdx + 1 }`. On budget stop before processing a child, save `rawOffset`; after completing it, save `rawOffsetAfter`.

5. **[MAJOR] Org-level orphan pruning is only airtight if “complete offset-0 root pass” means EOF across all root pages.**  
Anchor: current S111 guard only prunes after an offset-0 exhausted parent pass at [agent/lib/staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:267>) and [agent/lib/staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:286>); tests pin the resumed-tail no-prune case at [agent/test/staging-sweep.test.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/test/staging-sweep.test.ts:419>).  
Counterexample: root page 0 contains org A; root page 1 contains org B with an `orgResume`. If v2 prunes after an offset-0 first page rather than after root EOF, B’s resume is wrongly discarded.  
Fix: prune only when root listing started at 0, reached EOF across all root pages, had no root-list error, and did not stop on budget. `seenOrgIds` must be the union across all root pages. Add a >1000-org regression test.

6. **[MAJOR] Removing `listPrefix` removes the centralized never-throws/error-cursor guard.**  
Anchor: current `listPrefix` catches thrown list failures at [agent/lib/staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:201>), returns an error state, and `record()` leaves inherited cursors untouched at [agent/lib/staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:257>). Marker fail-closed and completion restamp live at [agent/lib/staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:493>) and [agent/lib/staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:522>).  
Fix: replace `listPrefix` with a shared `listPage` helper that still catches throws, records errors, and never advances/clears resume state on list failure. Keep the marker pre-write as incoming `walkCursor`, and post-write as completion timestamp plus `stats.nextCursor`.

7. **[MINOR] Ignoring legacy `cursors` is data-safe, but the “never skips” wording is too strong unless the round-robin bugs are fixed.**  
Anchor: design §7 (`design:222-226`) vs current marker read at [agent/lib/staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:455>). Dropping S111 cursors cannot over-delete; it restarts from 0. But it can discard real in-flight progress and delay tail reclamation. With the §4 EOF-stranding bug, that “fresh” state can still become permanent starvation.  
Fix: document it as a one-time progress reset, not “never skips,” and add a legacy-marker test with an old deep prefix cursor plus enough root pagination to prove eventual coverage.

**Specific answers**

a. The §4 round-robin is not coherent. It has both a forever-skip path at EOF from non-zero and a contradictory wrap condition when an org remains truncated.

b. Yes, the current filters lose raw item indices for any new mid-page resume. Current S111 prefix cursors are still raw because `listPrefix` resumes by raw storage offset before filtering, but v2’s per-child cursor math must carry raw indices explicitly.

c. `maxRequests=300` only bounds the tick if every storage `list()` increments the global counter. `maxRequestsPerOrg=50` only bounds tenant work if file-prefix list calls are counted too. The design rationale currently suggests the wrong mental model.

d. Legacy marker discard is safe from over-delete, but it drops in-flight progress. Treat it as delayed coverage, not as a proof of no skip.

e. Orphan prune is airtight only after a true offset-0 root EOF across all pages. A single root page is not enough once root paginates.

f. The S111 invariants can be preserved, but only if the replacement keeps try/catch around every list, marker-before-sweep fail-closed, incoming-cursor prewrite, and completion-clock restamp.

**Over-delete claim**

A resume bug cannot, by itself, delete a live non-expired draft file if the destructive core is genuinely unchanged: UUID org/draft filters, `uploads` staging prefix, metadata-file filter, and `stampMs < cutoffMs` remain at [agent/lib/staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:289>) through [agent/lib/staging-sweep.ts](<C:/Users/ceo/Documents/AI Training/Anti Gravity/DR-dev/agent/lib/staging-sweep.ts:333>). But “worst case is a transient miss” is false: the current v2 cursor algorithm can create permanent starvation.
EXIT=0

---

## Synthesis

The two lenses caught **different bug classes**, exactly as the MRPF predicts:

- **Gemini (breadth)** caught the *system-level architecture error*: the v1 single-frontier model
  was internally elegant (it dissolved the S111 orphan-leak class) but created a **worse**
  whole-system failure — global multi-tenant GC starvation. A file:line reviewer staring at one
  function would not necessarily surface "one tenant starves all others"; it took the holistic read.
  Gemini also caught the O(N²) re-fetch thrash from composing MAX_PAGES with a request budget.

- **Codex (depth)** caught the *concrete algorithm bugs* in the v2 fix: two permanent-starvation
  counterexamples (EOF-from-non-zero strands the ring pointer; junk root pages never advance it
  under budget) and the fairness-math hole (the per-org cap doesn't bound a draft-heavy org unless
  **file** lists are counted, not just draft pages). These are file:line-grounded and would not
  surface from a purely holistic read — they require tracing the actual filter/offset code and the
  per-list cost model.

Neither pass alone would have produced a shippable design. The sequential order (breadth fixes the
architecture, then depth hardens the concrete algorithm on the integrated revision) worked as
intended — Codex reviewed the *real* fix, not a stale v1.

**Net design deltas v1→v3:** single DFS frontier → breadth-fair **circular ring** over orgs;
MAX_PAGES multi-page accumulation → **one page per request**; per-org cap → **counts every list at
every level**; resume offsets → **exact raw rawOffset/rawOffsetAfter**; orphan prune → **all-pages
offset-0 EOF gate**; `listPrefix` → **`listPage` helper preserving never-throws + error-cursor**;
legacy-marker discard reworded as a **one-time progress reset**.

**Confirmed safety floor (Codex):** with the destructive core unchanged (UUID org/draft filters,
`uploads` staging prefix, metadata-file filter, `stampMs < cutoffMs`), a resume-math bug **cannot
over-delete a live non-expired file** — the worst case is a transient miss reclaimed on the next
ring wrap. This is the property that makes the DATA label's blast radius acceptable.

**Proceed:** build per v3 §4 algorithm → MERGE gate (DATA label, Gemini→Codex→QA).
