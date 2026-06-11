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
 * Run: pnpm -C agent exec node --import=tsx --test "test/staging-sweep.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
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

/** Mock sweep client over a prefix→entries map; records removed paths. */
function mockSweepSb(
  tree: Record<string, Entry[]>,
  opts: { removeError?: string; throwOnList?: boolean } = {},
): StorageSweepClientLike & { removed: string[][] } {
  const removed: string[][] = [];
  return {
    removed,
    storage: {
      from() {
        return {
          async list(prefix: string, listOpts: { limit: number; offset?: number }) {
            if (opts.throwOnList) throw new Error("network exploded");
            const entries = tree[prefix] ?? [];
            const off = listOpts.offset ?? 0;
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
  const result = await maybeRunStagingSweep({ markerPath, now: NOW });
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
      logFn: (m) => logs.push(m),
    });
    assert.equal(result.ran, false);
    assert.ok(logs.some((l) => l.includes("credentials not configured")));
  } finally {
    if (savedUrl !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = savedUrl;
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
  }
});
