/**
 * S106 unit tests — staging-TTL sweep (the only new code that DELETES storage
 * objects; S106 Codex MINOR #4 required coverage).
 *
 * Pins: TTL expiry math, non-UUID root folders never touched, unparseable
 * timestamps left in place, dry-run never removes, resolved {error} from
 * remove() recorded, THROWN list() contained (never escapes), batch sizing,
 * and maybeRunStagingSweep's marker gate + missing-creds bail + S111 hardening
 * (fail-closed marker, marker-before-sweep, completion clock).
 *
 * S112 per-sweep budget + breadth-fair circular-ring resume — these tests
 * REPLACE the S111 per-prefix `Record<prefix,offset>` cursor tests:
 *   - one page per request (no re-fetch thrash; Gemini #2)
 *   - per-org fairness cap counts file lists (Codex #3)
 *   - circular wrap from a non-zero start (Codex #1)
 *   - junk root pages advance under budget pressure (Codex #2)
 *   - raw-offset resume, not the filtered index (Codex #4)
 *   - all-pages-EOF orphan prune; resumed/mid-ring passes never prune (Codex #5)
 *   - global request + wall-clock budget; legacy-marker one-time reset (Codex #7)
 *
 * Run: pnpm -C agent exec node --import=tsx --test "test/staging-sweep.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  sweepStagingUploads,
  maybeRunStagingSweep,
  type StorageSweepClientLike,
  type WalkCursor,
} from "../lib/staging-sweep.js";

const ORG = "0a1b2c3d-0a1b-4c3d-8e9f-0a1b2c3d4e5f";
const ORG2 = "0b2c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e60";
const DRAFT = "11111111-2222-4333-8444-555555555555";
const DRAFT2 = "22222222-3333-4444-8555-666666666666";
const NOW = new Date("2026-06-11T12:00:00.000Z");
const OLD = "2026-06-09T12:00:00.000Z"; // 48h before NOW — expired at 24h TTL
const FRESH = "2026-06-11T11:00:00.000Z"; // 1h before NOW — kept

interface Entry {
  name: string;
  created_at?: string | null;
  metadata: Record<string, unknown> | null;
}

/** Mock sweep client over a prefix→entries map; records removed paths + list calls. */
function mockSweepSb(
  tree: Record<string, Entry[]>,
  opts: { removeError?: string; throwOnList?: boolean; throwOnPrefix?: string } = {},
): StorageSweepClientLike & {
  removed: string[][];
  listCalls: Array<{ prefix: string; offset: number }>;
} {
  const removed: string[][] = [];
  const listCalls: Array<{ prefix: string; offset: number }> = [];
  return {
    removed,
    listCalls,
    storage: {
      from() {
        return {
          async list(prefix: string, listOpts: { limit: number; offset?: number }) {
            const off = listOpts.offset ?? 0;
            listCalls.push({ prefix, offset: off });
            if (opts.throwOnList) throw new Error("network exploded");
            if (opts.throwOnPrefix && prefix === opts.throwOnPrefix) {
              throw new Error(`list of ${prefix} exploded`);
            }
            const entries = tree[prefix] ?? [];
            return {
              data: entries.slice(off, off + listOpts.limit),
              error: null,
            };
          },
          async remove(paths: string[]) {
            if (opts.removeError) {
              return { data: null, error: { message: opts.removeError } };
            }
            removed.push(paths);
            return { data: null, error: null };
          },
        };
      },
    },
  };
}

function baseTree(files: Entry[]): Record<string, Entry[]> {
  return {
    "": [
      { name: ORG, metadata: null },
      { name: "legacy-flat-slug", metadata: null }, // non-UUID — must be ignored
      { name: "some-file.md", metadata: { size: 10 } }, // root object — ignored
    ],
    [`${ORG}/uploads`]: [{ name: DRAFT, metadata: null }],
    [`${ORG}/uploads/${DRAFT}`]: files,
  };
}

// ── Core destructive behavior (carried from S106) ───────────────────

test("sweep: expired file deleted, fresh file kept", async () => {
  const sb = mockSweepSb(
    baseTree([
      { name: "old.pdf", created_at: OLD, metadata: { size: 5 } },
      { name: "new.pdf", created_at: FRESH, metadata: { size: 5 } },
    ]),
  );
  const stats = await sweepStagingUploads(sb, { now: NOW });
  assert.equal(stats.expired, 1);
  assert.equal(stats.deleted, 1);
  assert.deepEqual(sb.removed.flat(), [`${ORG}/uploads/${DRAFT}/old.pdf`]);
  assert.equal(stats.errors.length, 0);
  assert.equal(stats.budgetExhausted, false);
  assert.equal(stats.nextCursor.rootOffset, 0, "small tree completes → ring wraps to 0");
});

test("sweep: non-UUID root folders are never scanned or deleted", async () => {
  const tree = baseTree([{ name: "old.pdf", created_at: OLD, metadata: { size: 5 } }]);
  tree["legacy-flat-slug"] = [{ name: "deliverable.pdf", created_at: OLD, metadata: { size: 9 } }];
  const sb = mockSweepSb(tree);
  const stats = await sweepStagingUploads(sb, { now: NOW });
  assert.equal(stats.orgsScanned, 1);
  for (const p of sb.removed.flat()) {
    assert.ok(p.startsWith(`${ORG}/uploads/`), `unexpected delete outside staging: ${p}`);
  }
});

test("sweep: unparseable created_at → left in place + error recorded", async () => {
  const sb = mockSweepSb(
    baseTree([{ name: "mystery.pdf", created_at: null, metadata: { size: 5 } }]),
  );
  const stats = await sweepStagingUploads(sb, { now: NOW });
  assert.equal(stats.expired, 0);
  assert.equal(stats.deleted, 0);
  assert.equal(stats.errors.length, 1);
  assert.match(stats.errors[0], /unparseable/);
});

test("sweep: dry-run collects wouldDelete and never calls remove()", async () => {
  const sb = mockSweepSb(
    baseTree([{ name: "old.pdf", created_at: OLD, metadata: { size: 5 } }]),
  );
  const stats = await sweepStagingUploads(sb, { now: NOW, dryRun: true });
  assert.deepEqual(stats.wouldDelete, [`${ORG}/uploads/${DRAFT}/old.pdf`]);
  assert.equal(stats.deleted, 0);
  assert.equal(sb.removed.length, 0);
});

test("sweep: remove() resolving {error} is recorded, not thrown", async () => {
  const sb = mockSweepSb(
    baseTree([{ name: "old.pdf", created_at: OLD, metadata: { size: 5 } }]),
    { removeError: "permission denied" },
  );
  const stats = await sweepStagingUploads(sb, { now: NOW });
  assert.equal(stats.deleted, 0);
  assert.equal(stats.errors.length, 1);
  assert.match(stats.errors[0], /remove batch/);
});

test("sweep: THROWN list() is contained — recorded error, no escape (Codex MAJOR #3)", async () => {
  const sb = mockSweepSb({}, { throwOnList: true });
  const stats = await sweepStagingUploads(sb, { now: NOW });
  assert.equal(stats.deleted, 0);
  assert.equal(stats.errors.length, 1);
  assert.match(stats.errors[0], /network exploded/);
});

// ── S112 — one page per request + budget (Gemini #2, Codex #3) ───────

test("sweep: one page per request — paginates files + batches deletes at 100, no re-fetch", async () => {
  const files: Entry[] = [];
  for (let i = 0; i < 2500; i++) {
    files.push({ name: `f${String(i).padStart(4, "0")}.pdf`, created_at: OLD, metadata: { size: 1 } });
  }
  const sb = mockSweepSb(baseTree(files));
  const draftPrefix = `${ORG}/uploads/${DRAFT}`;
  const stats = await sweepStagingUploads(sb, { now: NOW });
  assert.equal(stats.filesScanned, 2500);
  assert.equal(stats.expired, 2500);
  assert.equal(stats.deleted, 2500);
  assert.equal(sb.removed.length, 25, "deletes go out in 100-path batches");
  // root(1) + uploads(1) + 3 file pages (1000,1000,500) = 5 list calls; nothing re-fetched.
  assert.equal(stats.requestsUsed, 5, "exactly the pages needed — no thrash");
  const fileCalls = sb.listCalls.filter((c) => c.prefix === draftPrefix);
  assert.deepEqual(fileCalls.map((c) => c.offset), [0, 1000, 2000], "file pages listed once each, in order");
  assert.equal(stats.budgetExhausted, false);
});

test("sweep: per-org cap COUNTS file-list calls — a draft-heavy org is bounded (Codex #3)", async () => {
  // One org, 100 drafts × 1 file each. Naively this is ~100 file lists; the
  // per-org cap must bound it because file lists are counted.
  const tree: Record<string, Entry[]> = {
    "": [{ name: ORG, metadata: null }],
    [`${ORG}/uploads`]: [],
  };
  for (let i = 0; i < 100; i++) {
    const d = `${String(i).padStart(8, "0")}-2222-4333-8444-555555555555`;
    tree[`${ORG}/uploads`].push({ name: d, metadata: null });
    tree[`${ORG}/uploads/${d}`] = [{ name: "old.pdf", created_at: OLD, metadata: { size: 1 } }];
  }
  const sb = mockSweepSb(tree);
  const stats = await sweepStagingUploads(sb, { now: NOW, maxRequestsPerOrg: 10 });
  assert.equal(stats.budgetExhausted, false, "per-org cap is not the GLOBAL budget");
  // root(1) + within-org lists bounded by maxRequestsPerOrg(10): far below ~100.
  assert.ok(stats.requestsUsed <= 12, `requestsUsed ${stats.requestsUsed} must be bounded by per-org cap, not one-per-draft`);
  assert.ok(stats.draftsScanned < 100, "the org yielded before scanning all 100 drafts");
  assert.ok(stats.nextCursor.orgResume[ORG] !== undefined, "the truncated org saved a resume entry");
});

test("sweep: per-org fairness — a huge org yields so a sibling org is still serviced (Gemini #1)", async () => {
  // ORG huge (many drafts, exceeds the per-org cap), ORG2 tiny. ONE sweep must
  // make progress on BOTH — no single-org trap.
  const tree: Record<string, Entry[]> = {
    "": [{ name: ORG, metadata: null }, { name: ORG2, metadata: null }],
    [`${ORG}/uploads`]: [],
    [`${ORG2}/uploads`]: [{ name: DRAFT2, metadata: null }],
    [`${ORG2}/uploads/${DRAFT2}`]: [{ name: "old.pdf", created_at: OLD, metadata: { size: 1 } }],
  };
  for (let i = 0; i < 30; i++) {
    const d = `${String(i).padStart(8, "0")}-2222-4333-8444-555555555555`;
    tree[`${ORG}/uploads`].push({ name: d, metadata: null });
    tree[`${ORG}/uploads/${d}`] = [{ name: "old.pdf", created_at: OLD, metadata: { size: 1 } }];
  }
  const sb = mockSweepSb(tree);
  const stats = await sweepStagingUploads(sb, { now: NOW, maxRequestsPerOrg: 4 });
  assert.ok(stats.nextCursor.orgResume[ORG] !== undefined, "huge org A truncated (saved resume)");
  assert.equal(stats.nextCursor.orgResume[ORG2], undefined, "small org B fully drained (no resume)");
  assert.ok(
    sb.removed.flat().includes(`${ORG2}/uploads/${DRAFT2}/old.pdf`),
    "org B's expired file deleted in the SAME sweep — no single-org trap",
  );
});

test("sweep: global budget cutoff mid-org pins the org + saves resume, deletes partial", async () => {
  const tree: Record<string, Entry[]> = {
    "": [{ name: ORG, metadata: null }],
    [`${ORG}/uploads`]: [{ name: DRAFT, metadata: null }, { name: DRAFT2, metadata: null }],
    [`${ORG}/uploads/${DRAFT}`]: [{ name: "old.pdf", created_at: OLD, metadata: { size: 1 } }],
    [`${ORG}/uploads/${DRAFT2}`]: [{ name: "old.pdf", created_at: OLD, metadata: { size: 1 } }],
  };
  const sb = mockSweepSb(tree);
  // maxRequests=3: root(1) + uploads(2) + DRAFT files(3) collect, then DRAFT2 trips GLOBAL.
  const stats = await sweepStagingUploads(sb, { now: NOW, maxRequests: 3 });
  assert.equal(stats.budgetExhausted, true);
  assert.ok(stats.nextCursor.orgResume[ORG] !== undefined, "in-progress org saved a resume entry");
  assert.equal(stats.nextCursor.rootOffset, 0, "rootOffset pins ORG's raw offset (0) to re-find it");
  assert.equal(stats.deleted, 1, "the first draft's expired file was still deleted");
});

// ── S112 — circular ring (Codex #1, #2) ─────────────────────────────

test("sweep: circular wrap from a NON-ZERO start reaching EOF → rootOffset returns to 0 (Codex #1)", async () => {
  const sb = mockSweepSb(
    baseTree([{ name: "old.pdf", created_at: OLD, metadata: { size: 5 } }]),
  );
  // Start mid-ring at offset 1 → the tail [legacy, some-file] has no UUID org;
  // EOF from non-zero MUST wrap to 0 (not strand past the end).
  const stats = await sweepStagingUploads(sb, {
    now: NOW,
    startCursor: { rootOffset: 1, orgResume: {} },
  });
  assert.equal(stats.orgsScanned, 0, "ORG at offset 0 is skipped THIS sweep (started past it)");
  assert.equal(stats.nextCursor.rootOffset, 0, "EOF from a non-zero start wraps to 0 (no permanent strand)");
  // The skipped head org is covered on the FOLLOWING sweep (rootOffset 0).
  const stats2 = await sweepStagingUploads(sb, { now: NOW, startCursor: stats.nextCursor });
  assert.equal(stats2.deleted, 1, "the skipped head org is reclaimed on the next ring cycle");
});

test("sweep: junk (org-less) root pages advance the pointer + wrap, never re-fetch page 0 (Codex #2)", async () => {
  // 2500 non-UUID root entries, no org. With maxRequests=1 (one root page/sweep)
  // the pointer MUST advance past each junk page and wrap to 0 at EOF — it must
  // NEVER stall re-fetching page 0 (the Codex #2 starvation).
  const root: Entry[] = [];
  for (let i = 0; i < 2500; i++) root.push({ name: `junk-${String(i).padStart(5, "0")}`, metadata: null });
  const sb = mockSweepSb({ "": root });
  let cursor: WalkCursor | undefined;
  const offsets: number[] = [];
  for (let i = 0; i < 6; i++) {
    const stats = await sweepStagingUploads(sb, { now: NOW, maxRequests: 1, startCursor: cursor });
    cursor = stats.nextCursor;
    offsets.push(cursor.rootOffset);
    if (cursor.rootOffset === 0) break;
  }
  assert.deepEqual(offsets, [1000, 2000, 0], "rootOffset advances past junk pages (1000, 2000) then wraps to 0");
  // Coverage of an org positioned AFTER >1000 junk root entries is proven by the
  // all-pages-EOF orphan-prune-union test below (root paginates, org on page 2).
});

// ── S112 — raw-offset resume (Codex #4) ─────────────────────────────

test("sweep: resume offset indexes the RAW listing position, not the filtered index (Codex #4)", async () => {
  // uploads listing interleaves junk before each draft: [junkA, DRAFT, junkB, DRAFT2].
  // After draining DRAFT, a per-org cutoff must save DRAFT2's RAW offset (3), not
  // the filtered index (1) — else resume re-lists DRAFT.
  const tree: Record<string, Entry[]> = {
    "": [{ name: ORG, metadata: null }],
    [`${ORG}/uploads`]: [
      { name: "junkA", metadata: null },
      { name: DRAFT, metadata: null },
      { name: "junkB", metadata: null },
      { name: DRAFT2, metadata: null },
    ],
    [`${ORG}/uploads/${DRAFT}`]: [{ name: "a.pdf", created_at: OLD, metadata: { size: 1 } }],
    [`${ORG}/uploads/${DRAFT2}`]: [{ name: "b.pdf", created_at: OLD, metadata: { size: 1 } }],
  };
  const sb = mockSweepSb(tree);
  // maxRequestsPerOrg=2: uploads list(1) + DRAFT files(2) complete; DRAFT2 trips PER_ORG.
  const stats = await sweepStagingUploads(sb, { now: NOW, maxRequestsPerOrg: 2 });
  assert.equal(
    stats.nextCursor.orgResume[ORG].draftOffset,
    3,
    "saved draftOffset is DRAFT2's RAW index (3), not the filtered index (1)",
  );
  assert.equal(stats.deleted, 1, "only DRAFT's file deleted this sweep");
  // Resume: the next sweep lists uploads at offset 3 and reclaims DRAFT2.
  const stats2 = await sweepStagingUploads(sb, { now: NOW, startCursor: stats.nextCursor });
  assert.ok(
    sb.removed.flat().includes(`${ORG}/uploads/${DRAFT2}/b.pdf`),
    "DRAFT2 reclaimed on resume (raw offset landed correctly)",
  );
  const uploadsResumeCall = sb.listCalls.find(
    (c) => c.prefix === `${ORG}/uploads` && c.offset === 3,
  );
  assert.ok(uploadsResumeCall, "uploads re-listed at the RAW resume offset 3");
});

// ── S112 — orphan prune airtight gate (Codex #5) ────────────────────

test("sweep: complete offset-0 EOF root pass PRUNES an absent org's resume entry (Codex #5)", async () => {
  const goneOrg = "ffffffff-0000-4000-8000-000000000000";
  const sb = mockSweepSb(
    baseTree([{ name: "old.pdf", created_at: OLD, metadata: { size: 5 } }]),
  );
  const stats = await sweepStagingUploads(sb, {
    now: NOW,
    startCursor: { rootOffset: 0, orgResume: { [goneOrg]: { draftOffset: 50, fileOffset: 0 } } },
  });
  assert.equal(
    stats.nextCursor.orgResume[goneOrg],
    undefined,
    "an org absent from the COMPLETE offset-0 root listing is pruned",
  );
});

test("sweep: a resumed (non-zero) EOF root pass does NOT prune sibling resume entries (Codex #5)", async () => {
  const otherOrg = "ffffffff-0000-4000-8000-000000000000";
  const sb = mockSweepSb(
    baseTree([{ name: "old.pdf", created_at: OLD, metadata: { size: 5 } }]),
  );
  // Start at offset 1 (non-zero) → only the tail seen, not the full org set →
  // pruning must be SUPPRESSED (would reintroduce starvation).
  const stats = await sweepStagingUploads(sb, {
    now: NOW,
    startCursor: { rootOffset: 1, orgResume: { [otherOrg]: { draftOffset: 50, fileOffset: 0 } } },
  });
  assert.deepEqual(
    stats.nextCursor.orgResume[otherOrg],
    { draftOffset: 50, fileOffset: 0 },
    "a resumed-then-exhausted parent must not prune sibling cursors (incomplete view)",
  );
});

test("sweep: orphan prune uses the union of orgs across ALL root pages (Codex #5)", async () => {
  // Root paginates: 1001 junk entries on page 1, then the real org on page 2.
  // A full 0→all-pages-EOF pass must KEEP the live org (seen on page 2) and only
  // prune the truly-absent one.
  const root: Entry[] = [];
  for (let i = 0; i < 1001; i++) root.push({ name: `junk-${String(i).padStart(5, "0")}`, metadata: null });
  root.push({ name: ORG, metadata: null });
  const tree: Record<string, Entry[]> = {
    "": root,
    [`${ORG}/uploads`]: [{ name: DRAFT, metadata: null }],
    [`${ORG}/uploads/${DRAFT}`]: [{ name: "old.pdf", created_at: OLD, metadata: { size: 1 } }],
  };
  const goneOrg = "ffffffff-0000-4000-8000-000000000000";
  const sb = mockSweepSb(tree);
  // maxRequestsPerOrg=1 → ORG (on root page 2) is SEEN but truncated, so it KEEPS
  // a resume entry. The prune must keep ORG (seen via the page-2 union) and drop
  // only the truly-absent goneOrg — proving seenOrgIds unions across all pages.
  const stats = await sweepStagingUploads(sb, {
    now: NOW,
    maxRequestsPerOrg: 1,
    startCursor: {
      rootOffset: 0,
      orgResume: {
        [ORG]: { draftOffset: 0, fileOffset: 0 }, // live (on page 2) — must be KEPT
        [goneOrg]: { draftOffset: 9, fileOffset: 0 }, // absent — must be pruned
      },
    },
  });
  assert.equal(stats.nextCursor.orgResume[goneOrg], undefined, "absent org pruned");
  assert.ok(
    stats.nextCursor.orgResume[ORG] !== undefined,
    "live org seen only on root page 2 is KEPT (union across all root pages, Codex #5)",
  );
  assert.equal(stats.nextCursor.rootOffset, 0, "completed ring wraps to 0");
});

// ── S112 — wall-clock budget + resume continuity + tolerance ────────

test("sweep: wall-clock budget (maxMillis) trips mid-walk even with requests remaining", async () => {
  const tree: Record<string, Entry[]> = {
    "": [{ name: ORG, metadata: null }],
    [`${ORG}/uploads`]: [],
  };
  for (let i = 0; i < 40; i++) {
    const d = `${String(i).padStart(8, "0")}-2222-4333-8444-555555555555`;
    tree[`${ORG}/uploads`].push({ name: d, metadata: null });
    tree[`${ORG}/uploads/${d}`] = [{ name: "old.pdf", created_at: OLD, metadata: { size: 1 } }];
  }
  const base = NOW.getTime();
  let calls = 0;
  // First few clock reads return base (t0 + early checks), then jump past maxMillis.
  const clockFn = () => new Date(base + (calls++ < 4 ? 0 : 999_999));
  const sb = mockSweepSb(tree);
  const stats = await sweepStagingUploads(sb, {
    now: NOW,
    clockFn,
    maxMillis: 100,
    maxRequests: 10_000, // generous — prove TIME is what cut it off
  });
  assert.equal(stats.budgetExhausted, true, "wall-clock cap tripped");
  assert.ok(stats.draftsScanned < 40, "did not scan the whole org before the time cap");
});

test("sweep: resume drives full coverage across budgeted chunks (no double-delete)", async () => {
  const tree: Record<string, Entry[]> = {
    "": [{ name: ORG, metadata: null }, { name: ORG2, metadata: null }],
    [`${ORG}/uploads`]: [],
    [`${ORG2}/uploads`]: [],
  };
  const expectAll = new Set<string>();
  for (const o of [ORG, ORG2]) {
    for (let i = 0; i < 12; i++) {
      const d = `${String(i).padStart(8, "0")}-2222-4333-8444-55555555555${o === ORG ? "5" : "6"}`;
      tree[`${o}/uploads`].push({ name: d, metadata: null });
      tree[`${o}/uploads/${d}`] = [{ name: "old.pdf", created_at: OLD, metadata: { size: 1 } }];
      expectAll.add(`${o}/uploads/${d}/old.pdf`);
    }
  }
  const sb = mockSweepSb(tree);
  let cursor: WalkCursor | undefined;
  let total = 0;
  for (let i = 0; i < 50; i++) {
    const stats = await sweepStagingUploads(sb, {
      now: NOW,
      maxRequests: 4,
      maxRequestsPerOrg: 3,
      startCursor: cursor,
    });
    total += stats.deleted;
    cursor = stats.nextCursor;
    if (cursor.rootOffset === 0 && Object.keys(cursor.orgResume).length === 0) break;
  }
  const removedAll = new Set(sb.removed.flat());
  assert.equal(removedAll.size, expectAll.size, "every expired file deleted exactly once across chunks");
  for (const p of expectAll) assert.ok(removedAll.has(p), `missing delete: ${p}`);
  assert.equal(total, expectAll.size, "no double-delete (deleted count == unique files)");
});

test("sweep: resuming with an org cursor beyond the (shrunk) listing → no crash, clears entry", async () => {
  // Mutation tolerance: a saved draftOffset now points past the end of a shrunk
  // uploads listing → empty page → eof → org completes → entry cleared.
  const sb = mockSweepSb(
    baseTree([{ name: "old.pdf", created_at: OLD, metadata: { size: 5 } }]),
  );
  const stats = await sweepStagingUploads(sb, {
    now: NOW,
    startCursor: { rootOffset: 0, orgResume: { [ORG]: { draftOffset: 999, fileOffset: 0 } } },
  });
  // uploads has 1 entry; offset 999 → empty → eof → org drained, entry cleared.
  assert.equal(stats.nextCursor.orgResume[ORG], undefined, "org cursor cleared after exhausting from a stale offset");
  assert.equal(stats.errors.length, 0, "no crash / no error from the stale offset");
});

test("sweep: a HUNG list() is bounded by maxMillis — per-call timeout degrades to error, no hang (breadth F1)", async () => {
  // A single storage list() that never resolves must not delay the sweep past
  // maxMillis. The per-call timeout (real wall-clock) fires and degrades to a
  // recorded error; the sweep returns instead of hanging the worker tick.
  const tree = baseTree([{ name: "old.pdf", created_at: OLD, metadata: { size: 5 } }]);
  const sb: StorageSweepClientLike = {
    storage: {
      from() {
        return {
          async list(prefix: string, o: { limit: number; offset?: number }) {
            if (prefix === "") return new Promise<never>(() => {}); // root list hangs forever
            const off = o.offset ?? 0;
            return { data: (tree[prefix] ?? []).slice(off, off + o.limit), error: null };
          },
          async remove() {
            return { data: null, error: null };
          },
        };
      },
    },
  };
  // Real 60ms wall-clock budget; the hung root list() is aborted after ~60ms.
  // (No `now`/`clockFn` → real clock, so elapsed advances and remainingMs is finite.)
  const stats = await sweepStagingUploads(sb, { maxMillis: 60 });
  assert.ok(
    stats.errors.some((e) => /exceeded maxMillis budget/.test(e)),
    "the hung list() is bounded by the per-call timeout and recorded as an error",
  );
  assert.equal(stats.deleted, 0, "no delete when the root list never returns");
});

test("sweep: list error on a draft prefix is contained — recorded, org resume saved, no delete", async () => {
  const draftPrefix = `${ORG}/uploads/${DRAFT}`;
  const sb = mockSweepSb(
    baseTree([{ name: "old.pdf", created_at: OLD, metadata: { size: 5 } }]),
    { throwOnPrefix: draftPrefix },
  );
  const stats = await sweepStagingUploads(sb, { now: NOW });
  assert.ok(stats.errors.some((e) => e.includes("exploded")), "the list error is recorded");
  assert.equal(stats.deleted, 0, "nothing deleted when the draft list failed");
  assert.ok(stats.nextCursor.orgResume[ORG] !== undefined, "the org keeps a resume entry to retry");
});

// ── maybeRunStagingSweep — marker gate + S111 hardening ──────────────

test("maybeRunStagingSweep: recent marker → skipped without touching storage or env", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sweep-marker-"));
  const markerPath = path.join(dir, ".staging-sweep-last");
  await fs.writeFile(markerPath, JSON.stringify({ lastRunAt: NOW.toISOString() }));
  const result = await maybeRunStagingSweep({
    markerPath,
    now: NOW,
    backoffState: { lastRunMs: 0 },
  });
  assert.deepEqual(result, { ran: false });
});

test("maybeRunStagingSweep: due but creds missing → bails {ran:false}, never throws", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sweep-marker-"));
  const markerPath = path.join(dir, ".staging-sweep-last"); // absent → due
  const savedUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const logs: string[] = [];
    const result = await maybeRunStagingSweep({
      markerPath,
      now: NOW,
      backoffState: { lastRunMs: 0 },
      logFn: (m) => logs.push(m),
    });
    assert.equal(result.ran, false);
    assert.ok(logs.some((l) => l.includes("credentials not configured")));
  } finally {
    if (savedUrl !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = savedUrl;
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
  }
});

test("maybeRunStagingSweep: marker write failure FAILS CLOSED, paced by in-memory backoff (S111 item 1)", async () => {
  const backoffState = { lastRunMs: 0 };
  const badMarker = path.join(os.tmpdir(), `no-such-sweep-dir-${DRAFT}`, ".staging-sweep-last");
  const sb = mockSweepSb(
    baseTree([{ name: "old.pdf", created_at: OLD, metadata: { size: 5 } }]),
  );
  const logs: string[] = [];
  const r1 = await maybeRunStagingSweep({ markerPath: badMarker, now: NOW, sb, backoffState, logFn: (m) => logs.push(m) });
  assert.equal(r1.ran, false, "a failed durable claim must FAIL CLOSED (no sweep)");
  assert.ok(logs.some((l) => l.includes("failing closed")), "the fail-closed skip must be logged");
  assert.equal(sb.removed.length, 0, "nothing deleted when failing closed");
  assert.equal(backoffState.lastRunMs, NOW.getTime(), "in-memory backoff stamped so the same process won't re-attempt every tick");
  const r2 = await maybeRunStagingSweep({ markerPath: badMarker, now: NOW, sb, backoffState, logFn: (m) => logs.push(m) });
  assert.equal(r2.ran, false, "in-memory backoff gates the immediate retry");
});

test("maybeRunStagingSweep: marker is claimed BEFORE the sweep lists storage (S111 item 2)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sweep-before-"));
  const markerPath = path.join(dir, ".staging-sweep-last");
  let markerExistedAtSweepStart = false;
  const base = mockSweepSb(
    baseTree([{ name: "old.pdf", created_at: OLD, metadata: { size: 5 } }]),
  );
  const sb: StorageSweepClientLike = {
    storage: {
      from(b: string) {
        const inner = base.storage.from(b);
        return {
          async list(prefix, o) {
            markerExistedAtSweepStart ||= existsSync(markerPath);
            return inner.list(prefix, o);
          },
          remove: inner.remove.bind(inner),
        };
      },
    },
  };
  const r = await maybeRunStagingSweep({ markerPath, now: NOW, sb, backoffState: { lastRunMs: 0 } });
  assert.equal(r.ran, true);
  assert.ok(markerExistedAtSweepStart, "marker must be written before the sweep begins listing (crash-loop safety)");
});

test("maybeRunStagingSweep: post-sweep marker stamps COMPLETION time + walkCursor (S111 clock + S112)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sweep-finish-"));
  const markerPath = path.join(dir, ".staging-sweep-last");
  const start = new Date("2026-06-11T00:00:00.000Z");
  const finish = new Date("2026-06-12T06:00:00.000Z"); // >24h later than start
  const times = [start, finish];
  let i = 0;
  const clockFn = () => times[Math.min(i++, times.length - 1)];
  const backoffState = { lastRunMs: 0 };
  const sb = mockSweepSb(
    baseTree([{ name: "old.pdf", created_at: OLD, metadata: { size: 5 } }]),
  );
  const r = await maybeRunStagingSweep({ markerPath, clockFn, sb, backoffState });
  assert.equal(r.ran, true);
  const marker = JSON.parse(await fs.readFile(markerPath, "utf-8")) as {
    lastRunAt: string;
    walkCursor?: WalkCursor;
  };
  assert.equal(marker.lastRunAt, finish.toISOString(), "post-sweep marker records the COMPLETION time");
  assert.equal(backoffState.lastRunMs, finish.getTime(), "in-memory backoff advances to completion time");
  assert.ok(marker.walkCursor && typeof marker.walkCursor.rootOffset === "number", "marker carries the new walkCursor shape");
  assert.equal(marker.walkCursor!.rootOffset, 0, "completed small-tree sweep wrapped the ring to 0");
});

// ── S112 MERGE-gate (Codex BLOCKING) — DELETE-SHIFT convergence ──────
// A mutating mock: remove() actually splices paths out of the tree and collapses
// emptied folders (Supabase storage folders are virtual — they vanish when their
// last object is deleted). This reproduces the offset-shift Codex flagged: deletes
// before a saved offset shrink the listing. The worker must still EVENTUALLY drain
// every expired file (eventual coverage), and a drain-to-quiescence loop (the CLI's
// contract) must reach zero remaining.

function mutatingMockSb(tree: Record<string, Entry[]>): StorageSweepClientLike & {
  removedCount: () => number;
} {
  let removed = 0;
  // Structure-aware collapse for the EXACT staging layout. The listing keys are
  // "" (root → orgs), "<org>/uploads" (→ drafts), "<org>/uploads/<draft>" (→ files).
  // A draft folder vanishes when its last file is removed; an org folder (an entry
  // in the root listing keyed "") vanishes when its uploads listing empties. NOTE
  // the parent of "<org>/uploads" is the ROOT key "" — NOT a "<org>" key (there is
  // no such key) — so generic "slice before last /" collapse is WRONG here.
  return {
    removedCount: () => removed,
    storage: {
      from() {
        return {
          async list(prefix: string, o: { limit: number; offset?: number }) {
            const off = o.offset ?? 0;
            return { data: (tree[prefix] ?? []).slice(off, off + o.limit), error: null };
          },
          async remove(paths: string[]) {
            for (const p of paths) {
              const parts = p.split("/"); // [org, "uploads", draft, file]
              const org = parts[0];
              const draft = parts[2];
              const file = parts[3];
              const draftKey = `${org}/uploads/${draft}`;
              const uploadsKey = `${org}/uploads`;
              const files = tree[draftKey];
              if (!files) continue;
              const fi = files.findIndex((e) => e.name === file);
              if (fi < 0) continue;
              files.splice(fi, 1);
              removed += 1;
              if (files.length === 0) {
                delete tree[draftKey];
                const drafts = tree[uploadsKey];
                if (drafts) {
                  const di = drafts.findIndex((e) => e.name === draft);
                  if (di >= 0) drafts.splice(di, 1);
                  if (drafts.length === 0) {
                    delete tree[uploadsKey];
                    const root = tree[""];
                    const oi = root.findIndex((e) => e.name === org);
                    if (oi >= 0) root.splice(oi, 1);
                  }
                }
              }
            }
            return { data: null, error: null };
          },
        };
      },
    },
  };
}

test("sweep: WORKER converges — delete-shift drains ALL expired files across repeated sweeps (Codex BLOCKING)", async () => {
  const tree: Record<string, Entry[]> = { "": [{ name: ORG, metadata: null }], [`${ORG}/uploads`]: [] };
  for (let i = 0; i < 600; i++) {
    const d = `${String(i).padStart(8, "0")}-2222-4333-8444-555555555555`;
    tree[`${ORG}/uploads`].push({ name: d, metadata: null });
    tree[`${ORG}/uploads/${d}`] = [{ name: "old.pdf", created_at: OLD, metadata: { size: 1 } }];
  }
  const sb = mutatingMockSb(tree);
  let cursor: WalkCursor | undefined;
  let sweeps = 0;
  // Each sweep deletes a per-org-bounded slice; deletion shifts the listing.
  // Convergence must hold despite the shift (no permanent skip).
  for (; sweeps < 500; sweeps++) {
    const stats = await sweepStagingUploads(sb, { now: NOW, maxRequestsPerOrg: 20, startCursor: cursor });
    cursor = stats.nextCursor;
    if (sb.removedCount() === 600) break;
  }
  assert.equal(sb.removedCount(), 600, "every expired file is eventually deleted despite delete-shift");
  assert.equal(tree[`${ORG}/uploads`]?.length ?? 0, 0, "the org's drafts all collapsed away");
  assert.ok(sweeps < 200, `converged in a bounded number of sweeps (was ${sweeps})`);
});

test("sweep: drain-to-quiescence loop (CLI contract) reaches zero remaining under delete-shift", async () => {
  // The CLI loops until a COMPLETE ring deletes nothing — it must NOT stop early on
  // a delete-shift false-EOF (the Codex BLOCKING for the CLI). Two orgs + a tight
  // budget force many chunks.
  const tree: Record<string, Entry[]> = { "": [] };
  let expected = 0;
  for (const orgId of [ORG, ORG2]) {
    tree[""].push({ name: orgId, metadata: null });
    tree[`${orgId}/uploads`] = [];
    for (let i = 0; i < 120; i++) {
      const d = `${String(i).padStart(8, "0")}-2222-4333-8444-5555555555${orgId === ORG ? "55" : "66"}`;
      tree[`${orgId}/uploads`].push({ name: d, metadata: null });
      tree[`${orgId}/uploads/${d}`] = [{ name: "old.pdf", created_at: OLD, metadata: { size: 1 } }];
      expected += 1;
    }
  }
  const sb = mutatingMockSb(tree);
  let cursor: WalkCursor | undefined;
  let guard = 0;
  // Quiescence = a COMPLETE RING (rootOffset 0→0, orgResume empty) that deleted
  // NOTHING. Tracking per-RING (not per-chunk) is required: a delete-shift can make
  // a single mid-ring chunk delete 0 while survivors remain, so a per-chunk
  // deleted==0 check would false-complete (the CLI bug Codex flagged).
  let ringDeleted = 0;
  for (;;) {
    if (guard++ > 8000) throw new Error("did not reach quiescence — possible non-convergence");
    const stats = await sweepStagingUploads(sb, {
      now: NOW,
      maxRequests: 6,
      maxRequestsPerOrg: 3,
      startCursor: cursor,
    });
    cursor = stats.nextCursor;
    ringDeleted += stats.deleted;
    if (cursor.rootOffset === 0 && Object.keys(cursor.orgResume).length === 0) {
      if (ringDeleted === 0) break; // a full ring deleted nothing → truly drained
      ringDeleted = 0; // ring deleted something → run another ring
    }
  }
  assert.equal(sb.removedCount(), expected, "drain-to-quiescence deletes every expired file");
  assert.equal(tree[""].length, 0, "all org folders collapsed away — nothing left in staging");
});

test("maybeRunStagingSweep: legacy S111 marker (cursors map, no walkCursor) → fresh ring, never throws (Codex #7)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sweep-legacy-"));
  const markerPath = path.join(dir, ".staging-sweep-last");
  // >24h stale so it's due; legacy shape carries `cursors`, not `walkCursor`.
  const stale = new Date(NOW.getTime() - 3 * 24 * 3_600_000).toISOString();
  await fs.writeFile(
    markerPath,
    JSON.stringify({ lastRunAt: stale, cursors: { [`${ORG}/uploads/${DRAFT}`]: 5000 } }),
  );
  const sb = mockSweepSb(
    baseTree([{ name: "old.pdf", created_at: OLD, metadata: { size: 5 } }]),
  );
  const r = await maybeRunStagingSweep({ markerPath, now: NOW, sb, backoffState: { lastRunMs: 0 } });
  assert.equal(r.ran, true, "legacy marker is due and runs (one-time progress reset)");
  // The legacy `cursors` map is ignored → fresh ring from 0 → the org is swept.
  assert.equal(r.stats!.deleted, 1, "fresh ring reclaims the expired file (never over-deletes)");
  const marker = JSON.parse(await fs.readFile(markerPath, "utf-8")) as { walkCursor?: WalkCursor; cursors?: unknown };
  assert.ok(marker.walkCursor, "marker rewritten in the new walkCursor shape");
  assert.equal(marker.cursors, undefined, "legacy cursors field is gone after rewrite");
});
