# Design Gate — Per-sweep budget with breadth-fair, circular-ring tree-position resume (staging-sweep fan-out)

**Status:** DESIGN gate, **v3 — FINAL** (Gemini holistic-adversarial → integrated → Codex grounded-adversarial → integrated). Event Gate: DESIGN (new subsystem on a storage-deletion path). Risk Labels: DATA (bounds/threads a destructive GC walk), AGENT BEHAVIOR (changes worker-tick cadence behavior). Severity: NORMAL. Topology: sequential Gemini → Codex, both adversarial in their own lens. Both reviewers returned BLOCK on the prior revision; v3 integrates every BLOCKING + MAJOR.

**Subject file:** `agent/lib/staging-sweep.ts` (the S106 staging-TTL GC backstop; hardened S111 — marker-fail-closed, marker-before-sweep, MAX_PAGES stable cursor).

**Closes:** the deliberate follow-up documented in the `staging-sweep.ts` module docstring `KNOWN LIMITATION` (Gemini #2 / Codex MAJOR from the S111 MERGE gate, DEFERRED by owner).

**Revision history**
- **v1** — single advancing DFS frontier. Gemini **BLOCK**: reintroduced *global* multi-tenant GC starvation (one huge org traps the frontier for days) + O(N²) re-fetch thrash from keeping MAX_PAGES under a request budget + raw/filtered off-by-one.
- **v2** — breadth-fair round-robin + one-page-per-request + raw-index threading. Codex **BLOCK**: the round-robin pseudocode had two *permanent-starvation* bugs (EOF-from-non-zero strands the pointer; junk root pages never advance the pointer under budget pressure), the per-org cap didn't count file-list calls (so it didn't actually bound a draft-heavy org), and several invariants needed explicit specification.
- **v3 (this)** — circular-ring root traversal, count-every-list budget at every level, exact rawOffset/rawOffsetAfter rules, airtight all-pages-EOF orphan prune, `listPage` helper preserving the S111 never-throws/error-cursor guard. Codex #1–#7 all integrated (§12).

---

## 1. Problem

`sweepStagingUploads` performs an unbounded depth-first walk of staging storage:

```
list("")                              → org folders                 (1 call)
  for each org: list("<org>/uploads") → draft folders               (N_orgs calls)
    for each draft: list("<org>/uploads/<draft>") → files           (Σ drafts calls)
```

Total `list()` calls per sweep ≈ `1 + N_orgs + Σ_org(N_drafts)`. At pathological
scale — one tenant with tens of thousands of abandoned drafts — this is O(drafts)
**sequential** network round-trips, and the worker **awaits the whole sweep on its
idle poll tick** (`worker.ts:241-249`, inside the `if (!job)` branch). A multi-second-
to-multi-minute sweep therefore delays pickup of the next research job by that long.

S111's `MAX_PAGES` cap bounds a *single prefix's* listing but **not total sweep work**:
10,000 drafts = 10,000 draft-listing calls. S111 marker-before-sweep prevents a
*crash-looping* sweep from starving job processing, but a single well-behaved sweep can
still monopolize one tick. This is a tail risk at realistic scale (drafts cap at
`ATTACHMENT_MAX_FILES = 5` files; jobs run 30–50 min so a sub-minute pickup delay is
immaterial), but it is real and the GC backstop should be self-limiting.

## 2. Goals / Non-goals

**Goals**
1. Bound a single sweep's wall-clock (`maxMillis`, the primary tick-delay guard) and request count (`maxRequests`, the deterministic backup bound).
2. On a mid-tree cutoff, resume the **next** sweep from where this one stopped — no permanent tail starvation.
3. Eventual complete coverage: every file expired for the full duration of a round-robin cycle is reclaimed within a bounded number of sweeps.
4. **Multi-tenant fairness** (Gemini #1): no single org's size may starve GC for other orgs.
5. Preserve every S111 invariant: never-throws, marker-before-sweep fail-closed cadence, idempotent deletes, the scope guard (`<uuid>/uploads/<uuid>/`), dry-run, error-leaves-cursor-untouched.
6. No wasted listing (Gemini #2): never fetch a storage page that is discarded unprocessed.
7. The budget must bound work at **every** list level (Codex #3): root pages, `uploads/` draft pages, AND per-draft file pages all count — a per-org cap that ignores file lists does not bound a draft-heavy org.

**Non-goals**
- Parallelizing `list()`; moving the sweep off the worker tick; reworking the destructive core (expiry predicate, scope guard, bulk delete) — all untouched.
- *Fast* drainage of a pathological org. Fairness > throughput: a truly pathological org drains slowly across many sweeps **by design**, so it never delays the tick or starves other tenants (§5 note).

## 3. Design — page-granular, breadth-fair, circular-ring walk

### 3.1 One page per request (Gemini #2)

List exactly **one page** (`LIST_LIMIT = 1000`) per `list()` call. The walk processes that
page, then requests the next page only if it descends/continues. Peak memory is
O(page × depth) ≈ 3000 entries. Each `list()` is exactly one budget unit → exact accounting,
zero wasted pages. `MAX_PAGES` and the multi-page `listPrefix` accumulation are **removed**;
their memory-cap role is intrinsic (one page is the unit). The S111 never-throws + error-
cursor guard that lived in `listPrefix` is preserved in a new `listPage` helper (§3.5, Codex #6).

### 3.2 Count every list at every level (Codex #3)

A single budget predicate is checked **and the counter incremented before every `list()`** —
at root, at `<org>/uploads`, and at `<org>/uploads/<draft>`. Two counters:
- `requestsUsed` (global, vs `maxRequests`) + elapsed (vs `maxMillis`) → `overGlobalBudget()`.
- `perOrgRequests` (reset at each org entry, vs `maxRequestsPerOrg`) → bounds *all* of one
  org's list calls (draft pages **and** every per-draft file list). A 50k-draft org with one
  file each costs ~1 file-list per draft, so `perOrgRequests` trips after ~`maxRequestsPerOrg`
  drafts and the sweep yields that org — it does **not** issue 50k file-lists in one sweep.

### 3.3 Circular-ring root traversal (Codex #1 + #2)

`rootOffset` is a **raw root-listing position** that advances page-by-page and is a **ring**:

- It advances past **every** root page processed, **including pages with zero UUID org
  folders** (Codex #2 — otherwise 301 junk pages under a 300 budget would re-fetch forever
  and never reach the first real org).
- Reaching root **EOF from ANY start offset wraps `rootOffset` to 0** (Codex #1 — gating the
  wrap on `startedAtZero` stranded the pointer past the end forever when a tail scan from a
  non-zero offset hit EOF). The wrap is purely about traversal position; it is **independent**
  of whether any org remains truncated (the v2 comment "wrap … with no org left truncated"
  was contradictory and is removed).
- If the global budget trips **between** orgs during root paging, `rootOffset` already points
  at the next unscanned root page (it was advanced per completed page) → clean resume.
- If the global budget trips **inside** an org, `rootOffset` is set to that org's raw offset so
  the next sweep re-lists that one root page and re-finds the org by id; the org's draft/file
  progress is carried in `orgResume[orgId]` (§3.4).
- If a root `list()` errors, `rootOffset` is left unchanged (retry the same page next sweep).

### 3.4 Resume state (marker) + exact raw-offset rules (Codex #4)

```ts
interface WalkCursor {
  /** Raw root-listing offset where the next sweep resumes scanning org folders. Circular:
   *  advances per root page (incl. org-less pages); wraps to 0 at root EOF from any start. */
  rootOffset: number;
  /** Per-org in-progress position for orgs not fully drained this sweep. Keyed by org id
   *  (folder name); cardinality ≈ tenant count. An org that fully drains clears its entry;
   *  orphan entries (deleted org) are pruned only after a COMPLETE offset-0 → all-pages-EOF
   *  root pass with no error and no budget stop (§3.6, Codex #5). */
  orgResume: Record<string, { draftOffset: number; fileOffset: number }>;
}
```

**Exact offset rules (Codex #4 — never use the post-filter array index):** every listing page
is iterated by **raw index**. For each entry, its position is `rawOffset = pageBase + rawIdx`
and `rawOffsetAfter = rawOffset + 1`.
- On a budget stop **before** processing a child → save `rawOffset` (re-list/re-find that child).
- After **completing** a child → the resume point is `rawOffsetAfter` (move past it).
- Non-UUID entries / file placeholders are skipped but **still occupy a raw index**, so the
  next org's `rawOffset` accounts for them — no left/right shift, no re-listing a done sibling.

UUID folder names carry no age correlation, so name-sorted offsets have no systematic bias;
the only cost of cross-sweep mutation is a transient miss reclaimed on the next ring wrap (§6).

### 3.5 `listPage` helper preserves the S111 invariants (Codex #6)

```ts
async function listPage(sb, prefix, offset, stats): Promise<{ items: ListedObject[]; eof: boolean; error: boolean }> {
  // increments stats.requestsUsed (the ONE place a list is counted)
  try {
    const { data, error } = await sb.storage.from(BUCKET).list(prefix, {
      limit: LIST_LIMIT, offset, sortBy: { column: "name", order: "asc" },
    });
    if (error) throw new Error(error.message);
    const items = data ?? [];
    return { items, eof: items.length < LIST_LIMIT, error: false };
  } catch (err) {
    stats.errors.push(`list(${prefix || "<root>"}@${offset}) failed: ${(err as Error).message}`);
    return { items: [], eof: false, error: true };   // caller leaves the cursor untouched
  }
}
```

Both the resolved-`{error}` path and a rejected promise degrade to `{ error: true }` and a
recorded `stats.errors` entry (S106 Codex MAJOR #3 — never-throws). On `error: true` the caller
**does not advance or clear** the relevant cursor (S111 record() semantics, one level deeper).

### 3.6 Orphan prune — airtight all-pages-EOF gate (Codex #5)

Prune `orgResume` entries for orgs no longer present **only when ALL of**: the root scan
**started at offset 0** AND reached **EOF across every root page** AND had **no root-list error**
AND **did not stop on budget**. `seenOrgIds` is the **union of UUID org folders across all root
pages** in that pass. A partial root pass (budget stop, mid-ring start, or error) must NOT prune —
it saw only a slice of the orgs and would wrongly drop a live org's resume entry (this is the
S111 Codex-QA BLOCKING — "resumed-then-exhausted parent saw only its tail" — one level up, at root).

## 4. Walk algorithm (precise pseudocode — the implementation follows this)

```
cursor      = marker.walkCursor ?? { rootOffset: 0, orgResume: {} }
startedAt0  = cursor.rootOffset === 0
rootOffset  = cursor.rootOffset
seenOrgIds  = new Set()
requestsUsed = 0 ; t0 = clock()
overGlobal() = requestsUsed >= maxRequests || clock() - t0 >= maxMillis
rootEOF = rootError = budgetStop = false

ROOT: for (;;) {
  if (overGlobal()) { budgetStop = true; break }     // rootOffset = next unscanned page → resume there
  page = listPage("", rootOffset)                    // counts 1 request
  if (page.error) { rootError = true; break }        // leave rootOffset unchanged → retry
  for (rawIdx, entry) in page.items {
    if (!(entry.metadata === null && UUID(entry.name))) continue      // junk occupies a raw idx; skip
    orgId = entry.name ; seenOrgIds.add(orgId)
    perOrg = 0
    resume = cursor.orgResume[orgId] ?? { draftOffset: 0, fileOffset: 0 }
    r = drainOrg(orgId, resume, perOrg)              // §4.1; increments requestsUsed & perOrg before every list
    if (r.complete) delete cursor.orgResume[orgId]
    else {
      cursor.orgResume[orgId] = r.resume
      if (r.reason === GLOBAL) {                      // global budget tripped inside this org
        cursor.rootOffset = rootOffset + rawIdx       // re-list THIS root page, re-find org by id next sweep
        budgetStop = true ; break ROOT
      }
      // r.reason === PER_ORG or ERROR → org yields; continue to next org in page
    }
  }
  if (page.eof) { rootEOF = true; break }
  rootOffset += page.items.length                     // advance past the WHOLE raw page (Codex #2)
}

// ---- finalize cursor.rootOffset ----
if (rootEOF && !rootError && !budgetStop) {
  if (startedAt0) pruneOrphans(cursor.orgResume, seenOrgIds)   // §3.6 airtight gate
  cursor.rootOffset = 0                                         // circular wrap from ANY start (Codex #1)
}
// budgetStop sets rootOffset above (between-orgs: next page; inside-org: org's raw offset)
// rootError leaves cursor.rootOffset unchanged

stats.nextCursor = cursor
flush expired deletes (batched 100; deletes NOT counted vs maxRequests — Gemini Q2)
```

### 4.1 `drainOrg(orgId, resume, perOrg)` — bounded two-level walk

```
stagingRoot = `${orgId}/${ATTACHMENTS.staging_prefix}`     // "<org>/uploads"
draftOffset = resume.draftOffset ; firstDraft = true
for (;;) {
  if (overGlobal())             return { complete:false, resume:{draftOffset, fileOffset:0}, reason:GLOBAL }
  if (perOrg >= maxRequestsPerOrg) return { complete:false, resume:{draftOffset, fileOffset:0}, reason:PER_ORG }
  page = listPage(stagingRoot, draftOffset)                // counts 1 global + 1 perOrg
  if (page.error)               return { complete:false, resume:{draftOffset, fileOffset:0}, reason:ERROR }
  for (rawIdx, entry) in page.items {
    if (!(entry.metadata === null && UUID(entry.name))) continue
    draftPrefix = `${stagingRoot}/${entry.name}`
    fileStart   = firstDraft ? resume.fileOffset : 0 ; firstDraft = false
    f = drainDraftFiles(draftPrefix, fileStart, perOrg)    // pages files; counts each list global+perOrg
    if (!f.complete)            return { complete:false, resume:{draftOffset: draftOffset + rawIdx, fileOffset: f.fileOffset}, reason: f.reason }
    collectExpired(f.files)                                // stampMs < cutoffMs (UNCHANGED predicate)
  }
  if (page.eof)                 return { complete:true, resume:{draftOffset:0, fileOffset:0}, reason:DONE }
  draftOffset += page.items.length
}
```

`drainDraftFiles` pages a single draft's files the same way (one page per request, counts each
list, returns `{complete, files, fileOffset, reason}` with `fileOffset` the raw offset to resume
on a budget stop). A draft holds ≤ `ATTACHMENT_MAX_FILES` files in practice, so it is almost
always one page, but it is still budget-checked to stay correct against a pathological draft.

## 5. Budget knobs

| Knob | Proposed default | Rationale |
|---|---|---|
| `maxMillis` (global) | 15000 | **Primary** tick-delay guard — directly bounds wall-clock to ≤ half the 30s poll interval, and catches individually slow `list()` calls a count can't see. Uses the injectable clock. |
| `maxRequests` (global) | 300 | Deterministic backup bound (test-friendly). 300 one-page round-trips ≈ a few seconds; never reached at realistic scale. |
| `maxRequestsPerOrg` | 50 | Fairness — caps any one org at ~50 list calls (drafts + files) per sweep so it yields and other orgs are serviced. Must stay ≪ `maxRequests`. |

**Drain-rate note (deliberate):** with `maxRequestsPerOrg = 50` and ~1 file-list per draft, a
50k-draft org drains ~50 drafts/sweep → ~1000 sweeps for a full drain. That is **intended**:
the budget is a *backstop that protects the tick + tenant fairness*, not a throughput optimizer.
A truly pathological org draining slowly is acceptable; it cannot delay the tick or starve other
tenants. If a real tree ever needs faster drainage, raise the caps (still bounded by `maxMillis`).
At realistic scale a sweep finishes in `1 + N_orgs + Σdrafts` ≪ 300 requests and touches no cap —
behavior is identical to today. Defaults are **module constants** (Gemini Q3); promote to
`conventions.json` (restart-coupled) only on demonstrated need.

## 6. The tradeoff this design deliberately accepts (explicit)

Name-sorted offsets shift when entries are added/deleted *before* a saved offset between sweeps:
- **Delete before the offset** → listing shifts left → the resumed offset steps *over* a sibling
  not yet seen this cycle. **Transient miss**, reclaimed on the next ring wrap (offset → 0).
- **Insert before the offset** → shifts right → one already-done sibling re-listed. Harmless
  (deletes idempotent; cost = one `list()`).

Identical to the tradeoff S111 already documents for its within-prefix offset cursor
(`staging-sweep.ts:190-195`). Bounded-eventual-coverage holds because the ring always wraps to 0
and re-scans the whole tree; UUID names carry no age bias, so no file class is systematically
deferred — every miss is reclaimed within ≤2 full ring cycles.

## 7. Marker schema change + backward compatibility (Codex #7 wording)

```ts
interface SweepMarker { lastRunAt: string; walkCursor?: WalkCursor; }   // replaces cursors?: SweepCursors
```

An S111 marker carries `cursors` (the prefix map) and no `walkCursor`. On read, a missing
`walkCursor` ⇒ start at `{ rootOffset: 0, orgResume: {} }`. Discarding the legacy `cursors` is a
**one-time progress reset**, *not* "never skips": it cannot over-delete (a fresh pass starts at 0
and re-scans), but it does drop whatever in-flight S111 resume progress existed, so that region's
tail reclamation is *delayed* until the first new full ring cycle. Safe and bounded. No data
migration; the marker is rewritten in the new shape on the first sweep. The marker file is
operational state at `<cwd>/.staging-sweep-last`, not tracked content.

## 8. Type / signature changes

```ts
// SweepOptions gains:
maxRequests?: number;          // default 300
maxRequestsPerOrg?: number;    // default 50
maxMillis?: number;            // default 15000
startCursor?: WalkCursor;      // replaces cursors?: SweepCursors
clockFn?: () => Date;          // thread the injectable clock to the elapsed check (reuse maybeRun's)

// SweepStats gains / changes:
nextCursor: WalkCursor;        // replaces nextCursors: SweepCursors
requestsUsed: number;
budgetExhausted: boolean;      // global budget tripped this sweep (replaces `truncated`)
```

Consumers:
- `maybeRunStagingSweep`: read `walkCursor` from marker → `startCursor`; pre-write keeps the
  **incoming** cursor (S111 idempotent crash-resume — Gemini Q5); post-write stamps COMPLETION
  time + `stats.nextCursor` (S111 completion-clock). Pass the budget defaults.
- `agent/scripts/cleanup-staging-uploads.ts` (manual CLI): **loop** — re-invoke with the returned
  cursor while the sweep is making progress (budget tripped OR `orgResume` non-empty OR
  `rootOffset !== 0`), with a small inter-chunk sleep, until a full ring completes (`rootOffset`
  returns to 0 with empty `orgResume`). Bounded chunks; the loop drives a full pass (Gemini Q4 —
  `Infinity` in one shot risks API rate-limit / memory on a massive tree).
- Tests: S111 cursor-inheritance / prune-orphan tests are **replaced** by the §9 set.

## 9. Test plan (node --test, injected mock client + clock)

1. **No-budget-pressure parity** — small tree, generous budget → identical deletes to S111 (regression).
2. **Per-org fairness (Gemini #1)** — org A huge (> `maxRequestsPerOrg`), org B small; ONE sweep drains B fully and truncates A → no single-org trap.
3. **Per-org cap counts file lists (Codex #3)** — one org, many drafts × 1 file each → assert `requestsUsed` within the org ≤ `maxRequestsPerOrg + O(1)` (NOT one-per-draft).
4. **Circular wrap from non-zero (Codex #1)** — start `rootOffset` mid-ring, reach EOF → `nextCursor.rootOffset === 0`; the skipped head orgs are covered on the following sweep (no permanent skip).
5. **Junk root pages advance under budget (Codex #2)** — many non-UUID root pages before the first org, tight `maxRequests` → `rootOffset` advances every sweep and the org is eventually reached (no re-fetch-forever).
6. **One-page-per-request (Gemini #2)** — `requestsUsed` equals pages actually needed; resume does not re-fetch processed pages (no thrash).
7. **Global budget cutoff mid-org** — `nextCursor.rootOffset` pins the in-progress org, `orgResume[org]` saved, `budgetExhausted = true`; partial expired files still deleted.
8. **Resume continues forward** — feed sweep N's `nextCursor` as N+1's `startCursor`; union covers the same files one unbudgeted sweep would; idempotent, no double-delete crash.
9. **Raw-offset correctness (Codex #4)** — page interleaves junk before a UUID folder; resume offset = raw position, never the filtered index → lands on the correct next entry, never steps back.
10. **All-pages-EOF orphan prune (Codex #5)** — root paginates (>1 page); a partial/budget-stopped/mid-ring root pass does NOT prune; only a true 0→all-pages-EOF pass prunes absent orgs. `seenOrgIds` is the union across pages.
11. **Time budget** — injected clock past `maxMillis` mid-walk → cutoff even with requests remaining.
12. **Legacy marker (Codex #7)** — marker with `cursors` + no `walkCursor` → fresh start, never throws, rewrites new shape; a deep legacy cursor + root pagination still reaches eventual coverage.
13. **Mutation-shift tolerance** — delete entries before a saved offset between sweeps → no crash; coverage completes within the next wrap.
14. **Never-throws (Codex #6)** — list/remove rejection mid-budgeted-walk degrades to `stats.errors`, leaves the cursor untouched, returns.
15. **maybeRun marker round-trip** — `walkCursor` persisted at completion, re-read next tick; pre-write = incoming cursor, post-write = completion clock.
16. **CLI loop (Gemini Q4)** — manual CLI drains a budget-exceeding tree to completion across bounded chunks.

Target: keep the suite green (≥424) and net-add coverage for the ring model.

## 10. Rollback / blast radius

Pure logic change in one module + its tests + two call sites; no schema, no migration, no
storage-layout change. The destructive core (what gets deleted — UUID org/draft filters, `uploads`
prefix, metadata-file filter, `stampMs < cutoffMs`) is **unchanged**, so a bug in the new resume
math is at worst a **transient miss** (a draft's deletion deferred to a later sweep) — Codex
confirmed a resume bug cannot delete a live non-expired file while the predicate + scope guard
hold. Rollback = revert the commit; the next sweep reads a new-shape marker or falls back to a
fresh ring.

## 11. Gemini holistic-adversarial review — disposition (v1→v2)

What Gemini saw: design v1 + `agent/lib/staging-sweep.ts` + worker context. Verdict: **BLOCK**.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | BLOCKING | Single frontier → **global multi-tenant GC starvation** (noisy-neighbor DoS). | FIXED → breadth-fair round-robin (§3.2/§5), then hardened to a circular ring in v3. |
| 2 | BLOCKING | `MAX_PAGES` under a request budget **thrashes** (re-fetch discarded pages). | FIXED → one page per request; `MAX_PAGES`/`listPrefix` removed (§3.1). |
| 3 | MAJOR | Resume must index the **raw**, not post-filter, position. | FIXED → §3.4 exact rawOffset rules. |
| Q1–Q6 | — | rawIdx / don't-count-deletes / module-constants / CLI-loop-not-Infinity / no-cadence-regression / serialize-not-acceptable. | All adopted (§3.4, §5, §8). |

## 12. Codex grounded-adversarial review — disposition (v2→v3)

What Codex saw: design v2 + `agent/lib/staging-sweep.ts` (file:line) + `worker.ts` + CLI + conventions + the test file. Verdict: **BLOCK**.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | BLOCKING | EOF from a non-zero start strands `rootOffset` past the end forever (orgs skipped permanently); wrap-condition comment contradicted the pseudocode. | FIXED → **circular ring**: EOF from any start wraps `rootOffset` to 0; wrap decoupled from `orgResume`/prune (§3.3, §4). |
| 2 | BLOCKING | Junk (non-UUID) root pages under budget pressure never advance the pointer → re-fetch forever, never reach a real org. | FIXED → `rootOffset` advances past **every** root page incl. org-less ones; budget-stop between orgs persists the next page (§3.3, §4). |
| 3 | MAJOR | Per-org cap doesn't bound a draft-heavy org unless **file-list calls** are counted (50k drafts = 50k file lists, not 50 pages). | FIXED → count every list at every level; `maxRequestsPerOrg` covers draft + file lists (§3.2, §4.1, test 3). |
| 4 | MAJOR | Exact `rawOffset`/`rawOffsetAfter` rules needed to avoid off-by-one re-listing. | FIXED → save `rawOffset` on stop-before, `rawOffsetAfter` on complete (§3.4). |
| 5 | MAJOR | Org-orphan prune must gate on **all-pages** root EOF (union `seenOrgIds`), not a single offset-0 page. | FIXED → airtight 4-condition gate + union (§3.6, test 10). |
| 6 | MAJOR | Removing `listPrefix` drops the centralized never-throws/error-cursor guard. | FIXED → `listPage` helper preserves it; error leaves cursor untouched (§3.5, test 14). |
| 7 | MINOR | "Never skips" wording for legacy-marker discard is too strong. | FIXED → reworded "one-time progress reset / delayed coverage" (§7). |
| a–f | — | Round-robin incoherence / raw-index loss / count-all-lists / legacy-discard-is-delay / all-pages-EOF prune / S111-invariants-preserved. | All resolved by the above. |
| over-delete | — | Codex confirms: a resume bug **cannot** delete a live non-expired file while the unchanged predicate + scope guard hold. | Recorded (§10). |

**Gate status:** both reviewers BLOCKed their prior revision; v3 integrates every BLOCKING and
MAJOR. No open BLOCKING/MAJOR remains. Proceed to build → MERGE gate (DATA label).
