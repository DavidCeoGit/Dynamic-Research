/**
 * S106 unit tests — staging-TTL sweep (the only new code that DELETES
 * storage objects; S106 Codex MINOR #4 required coverage).
 *
 * Pins: TTL expiry math, non-UUID root folders never touched, unparseable
 * timestamps left in place, dry-run never removes, resolved {error} from
 * remove() recorded, THROWN list() contained (never escapes), offset
 * pagination across >1 page, batch sizing, and maybeRunStagingSweep's
 * marker gate + missing-creds bail.
 *
 * S111 sweep-hardening trio (+ MERGE-gate integrations): marker write failure
 * FAILS CLOSED, paced by an in-memory backoff (item 1 / Codex BLOCKING); the
 * marker is claimed before the sweep + re-stamped at completion (item 2 +
 * Codex clock); truncated prefixes persist a resume cursor that is INHERITED
 * under a truncated/resumed parent (item 3 / Gemini BLOCKING #1 + Codex QA
 * BLOCKING) but PRUNED only after a COMPLETE offset-0 pass shows the child is
 * gone (Codex MAJOR).
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
} from "../lib/staging-sweep.js";

const ORG = "0a1b2c3d-0a1b-4c3d-8e9f-0a1b2c3d4e5f";
const DRAFT = "11111111-2222-4333-8444-555555555555";
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
});

test("sweep: non-UUID root folders are never scanned or deleted", async () => {
  const tree = baseTree([{ name: "old.pdf", created_at: OLD, metadata: { size: 5 } }]);
  // Plant a would-be victim under the legacy folder — sweep must never list it.
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

test("sweep: remove() resolving {error} is recorded, not thrown (Supabase remove shape)", async () => {
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

test("sweep: paginates past 1000 entries and batches deletes at 100", async () => {
  const files: Entry[] = [];
  for (let i = 0; i < 1500; i++) {
    files.push({ name: `f${String(i).padStart(4, "0")}.pdf`, created_at: OLD, metadata: { size: 1 } });
  }
  const sb = mockSweepSb(baseTree(files));
  const stats = await sweepStagingUploads(sb, { now: NOW });
  assert.equal(stats.filesScanned, 1500, "second page must be reached (Gemini #3)");
  assert.equal(stats.expired, 1500);
  assert.equal(stats.deleted, 1500);
  assert.equal(sb.removed.length, 15, "deletes must go out in 100-path batches");
  assert.equal(stats.truncated, false);
});

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

// ── S111 item 1 — marker-write-failure FAILS CLOSED (Codex BLOCKING) ─

test("maybeRunStagingSweep: marker write failure FAILS CLOSED, paced by in-memory backoff (item 1)", async () => {
  const backoffState = { lastRunMs: 0 };
  // Parent dir doesn't exist → fs.writeFile rejects (ENOENT), exercising the
  // marker-claim-failure path without mocking fs.
  const badMarker = path.join(
    os.tmpdir(),
    `no-such-sweep-dir-${DRAFT}`,
    ".staging-sweep-last",
  );
  const sb = mockSweepSb(
    baseTree([{ name: "old.pdf", created_at: OLD, metadata: { size: 5 } }]),
  );
  const logs: string[] = [];
  const r1 = await maybeRunStagingSweep({
    markerPath: badMarker,
    now: NOW,
    sb,
    backoffState,
    logFn: (m) => logs.push(m),
  });
  assert.equal(r1.ran, false, "a failed durable claim must FAIL CLOSED (no sweep)");
  assert.ok(
    logs.some((l) => l.includes("failing closed")),
    "the fail-closed skip must be logged",
  );
  assert.equal(sb.removed.length, 0, "nothing deleted when failing closed");
  assert.equal(
    backoffState.lastRunMs,
    NOW.getTime(),
    "in-memory backoff stamped so the same process won't re-attempt every tick",
  );
  // Same NOW, file marker still absent (write failed) — in-memory must gate.
  const r2 = await maybeRunStagingSweep({
    markerPath: badMarker,
    now: NOW,
    sb,
    backoffState,
    logFn: (m) => logs.push(m),
  });
  assert.equal(r2.ran, false, "in-memory backoff gates the immediate retry");
});

// ── S111 item 2 — marker-before-sweep + completion-time stamp ────────

test("maybeRunStagingSweep: marker is claimed BEFORE the sweep lists storage (item 2)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sweep-before-"));
  const markerPath = path.join(dir, ".staging-sweep-last");
  let markerExistedAtSweepStart = false;
  const base = mockSweepSb(
    baseTree([{ name: "old.pdf", created_at: OLD, metadata: { size: 5 } }]),
  );
  // Wrap list() to capture whether the marker is already on disk the first
  // time the sweep touches storage — proves the pre-write ran first.
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
  const r = await maybeRunStagingSweep({
    markerPath,
    now: NOW,
    sb,
    backoffState: { lastRunMs: 0 },
  });
  assert.equal(r.ran, true);
  assert.ok(
    markerExistedAtSweepStart,
    "marker must be written before the sweep begins listing (crash-loop safety)",
  );
});

test("maybeRunStagingSweep: post-sweep marker stamps COMPLETION time, not start (Codex clock)", async () => {
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
  };
  assert.equal(
    marker.lastRunAt,
    finish.toISOString(),
    "post-sweep marker must record the COMPLETION time, not the start",
  );
  assert.equal(
    backoffState.lastRunMs,
    finish.getTime(),
    "in-memory backoff must advance to the completion time",
  );
});

// ── S111 item 3 — MAX_PAGES stable-cursor (inherit + prune-on-full-pass) ──

test("sweep: prefix exceeding MAX_PAGES records a resume cursor (item 3)", async () => {
  // 20_001 entries → 20 full pages of 1000 fill the cap, tail deferred. FRESH
  // so the test isolates the pagination/cursor mechanism (no deletes).
  const files: Entry[] = [];
  for (let i = 0; i < 20_001; i++) {
    files.push({ name: `f${String(i).padStart(5, "0")}.pdf`, created_at: FRESH, metadata: { size: 1 } });
  }
  const sb = mockSweepSb(baseTree(files));
  const draftPrefix = `${ORG}/uploads/${DRAFT}`;
  const stats = await sweepStagingUploads(sb, { now: NOW });
  assert.equal(stats.truncated, true, "MAX_PAGES cap must flag truncation");
  assert.equal(
    stats.nextCursors[draftPrefix],
    20_000,
    "resume cursor = MAX_PAGES * LIST_LIMIT",
  );
  assert.equal(stats.filesScanned, 20_000, "only the first cap-worth examined this sweep");
});

test("sweep: resumes a truncated prefix from its saved cursor, clears it on exhaustion (item 3)", async () => {
  const draftPrefix = `${ORG}/uploads/${DRAFT}`;
  const sb = mockSweepSb(
    baseTree([{ name: "old.pdf", created_at: OLD, metadata: { size: 5 } }]),
  );
  const stats = await sweepStagingUploads(sb, {
    now: NOW,
    cursors: { [draftPrefix]: 5000 },
  });
  const draftListCalls = sb.listCalls.filter((c) => c.prefix === draftPrefix);
  assert.ok(draftListCalls.length > 0, "draft prefix must be listed");
  assert.equal(
    draftListCalls[0].offset,
    5000,
    "listing must resume from the saved cursor offset",
  );
  assert.equal(
    stats.nextCursors[draftPrefix],
    undefined,
    "an exhausted prefix clears its cursor (wraps to a fresh pass next sweep)",
  );
});

test("sweep: inherited cursor under a TRUNCATED parent is preserved (item 3 / Gemini BLOCKING #1)", async () => {
  // Root truncates (>MAX_PAGES*LIST_LIMIT entries) so an org in the unlisted
  // tail isn't visited. Its inherited cursor must SURVIVE — dropping it would
  // permanently starve that org's own tail. (Junk folders pad the listing; only
  // ORG is UUID-shaped, so the recursion stays cheap.)
  const rootEntries: Entry[] = [{ name: ORG, metadata: null }];
  for (let i = 0; i < 20_000; i++) {
    rootEntries.push({ name: `junk-${String(i).padStart(5, "0")}`, metadata: null });
  }
  const tree: Record<string, Entry[]> = {
    "": rootEntries,
    [`${ORG}/uploads`]: [{ name: DRAFT, metadata: null }],
    [`${ORG}/uploads/${DRAFT}`]: [{ name: "old.pdf", created_at: OLD, metadata: { size: 5 } }],
  };
  const tailOrgUploads = "ffffffff-0000-4000-8000-000000000000/uploads";
  const sb = mockSweepSb(tree);
  const stats = await sweepStagingUploads(sb, {
    now: NOW,
    cursors: { [tailOrgUploads]: 40_000 },
  });
  assert.equal(stats.truncated, true, "root must truncate for this scenario");
  assert.equal(stats.nextCursors[""], 20_000, "root truncation cursor saved");
  assert.equal(
    stats.nextCursors[tailOrgUploads],
    40_000,
    "an inherited cursor under a TRUNCATED parent must be preserved (Gemini #1)",
  );
});

test("sweep: orphaned cursor under a COMPLETE (offset-0) EXHAUSTED parent is pruned (item 3 / Codex MAJOR)", async () => {
  // Root exhausts from offset 0 (small, complete listing) and a previously-
  // cursored org is GONE from it (its folder was deleted). Its stale cursor must
  // be pruned — the parent never re-lists a deleted child, so it would otherwise
  // leak forever.
  const goneOrgUploads = "ffffffff-0000-4000-8000-000000000000/uploads";
  const sb = mockSweepSb(
    baseTree([{ name: "old.pdf", created_at: OLD, metadata: { size: 5 } }]),
  );
  const stats = await sweepStagingUploads(sb, {
    now: NOW,
    cursors: { [goneOrgUploads]: 20_000 },
  });
  assert.equal(stats.truncated, false, "root exhausts in this small tree");
  assert.equal(
    stats.nextCursors[goneOrgUploads],
    undefined,
    "a cursor for an org absent from the COMPLETE root listing must be pruned",
  );
});

test("sweep: a RESUMED-then-exhausted parent does NOT prune sibling cursors (item 3 / Codex QA BLOCKING)", async () => {
  // Root resumes from a saved nonzero cursor and exhausts — it saw only the
  // TAIL from the resume offset, NOT the complete org set. It must NOT prune a
  // sibling cursor for an org that may live before the resume offset; pruning
  // there would reintroduce the Gemini #1 starvation.
  const otherOrgUploads = "ffffffff-0000-4000-8000-000000000000/uploads";
  const sb = mockSweepSb(
    baseTree([{ name: "old.pdf", created_at: OLD, metadata: { size: 5 } }]),
  );
  const stats = await sweepStagingUploads(sb, {
    now: NOW,
    cursors: { "": 1000, [otherOrgUploads]: 40_000 },
  });
  // Root resumed at offset 1000 → baseTree's 3 root entries slice to empty →
  // exhausted, but from a NONZERO offset, so the prune must be SUPPRESSED.
  assert.equal(
    stats.nextCursors[otherOrgUploads],
    40_000,
    "a resumed-then-exhausted parent must not prune sibling cursors (incomplete view)",
  );
});

test("sweep: list error on a prefix leaves its inherited cursor untouched (item 3 / 3-state)", async () => {
  // A transient list() failure on a resuming prefix must not advance, clear, OR
  // prune its cursor — next sweep retries the same region (deletes idempotent).
  const draftPrefix = `${ORG}/uploads/${DRAFT}`;
  const sb = mockSweepSb(
    baseTree([{ name: "old.pdf", created_at: OLD, metadata: { size: 5 } }]),
    { throwOnPrefix: draftPrefix },
  );
  const stats = await sweepStagingUploads(sb, {
    now: NOW,
    cursors: { [draftPrefix]: 7000 },
  });
  assert.ok(
    stats.errors.some((e) => e.includes("exploded")),
    "the list error must be recorded",
  );
  assert.equal(
    stats.nextCursors[draftPrefix],
    7000,
    "an errored prefix keeps its inherited cursor (retry same region)",
  );
  assert.equal(stats.deleted, 0, "nothing deleted when the draft list failed");
});
