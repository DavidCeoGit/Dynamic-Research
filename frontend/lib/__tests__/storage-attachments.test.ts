/**
 * Unit tests for the S102/audit-A1 frontend storage attachment helpers:
 * verifyAndCopyAttachments, removeStagedFiles, removeRunSources.
 *
 * Audit A1 identified that these functions had zero test coverage because
 * they hard-coded getSupabase(). The injectable _sb parameter (StorageClientLike)
 * added in fix/audit-majors lets us mock the Supabase storage surface here
 * without any env vars or network calls.
 *
 * Coverage pins:
 *  1. not-found → 400, copy() never invoked
 *  2. size-mismatch → 400, copy() never invoked
 *  3. copy failure mid-plan → partial rollback (copied-so-far paths removed) → 500
 *  4. post-copy list error → removes all copies → 500
 *  5. post-copy size mismatch → removes all copies → 400
 *  6. happy path → all copies + post-verify succeed → {ok:true, verified}
 *  7. bestEffortRemove via removeStagedFiles: resolved {error} logs, never throws
 *  8. removeRunSources: paths routed through bestEffortRemove correctly
 *
 * Run: pnpm -C agent exec node --import=tsx --test "../frontend/lib/__tests__/storage-attachments.test.ts"
 * (wired into the root `pnpm test` script)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifyAndCopyAttachments,
  removeStagedFiles,
  removeRunSources,
  type StorageClientLike,
} from "../storage";
import type { AttachmentPayloadItem } from "../types/queue";

const ORG = "0a1b2c3d-0a1b-4c3d-8e9f-0a1b2c3d4e5f";
const DRAFT = "11111111-2222-4333-8444-555555555555";
const SLUG = "my-research-topic-9f8e7d6c";
const PARENT_SLUG = "parent-run-slug-1234abcd";

// ── Fixtures ─────────────────────────────────────────────────────

function stagingItem(over: Partial<AttachmentPayloadItem> = {}): AttachmentPayloadItem {
  return {
    originalName: "report.pdf",
    storedName: "report-abc123.pdf",
    sizeBytes: 1024,
    contentType: "application/pdf",
    uploadedAt: "2026-06-11T00:00:00.000Z",
    origin: "staging",
    ...over,
  };
}

interface MockOpts {
  /** Sizes returned by staging list: storedName → size */
  stagingSizes?: Record<string, number>;
  /** Sizes returned by parent sources list */
  parentSizes?: Record<string, number>;
  /** If set, copy() fails with this message for ALL paths */
  copyFailAt?: string;
  /** If set, copy() fails starting at this 0-based index */
  copyFailIndex?: number;
  /** Dest list returned after copies; defaults to matching the items */
  destList?: Record<string, number>;
  /** If set, dest list call returns this error */
  destListError?: string;
  /** Capture remove() calls */
  removedPaths?: string[][];
  /** If set, remove() returns this error */
  removeError?: string;
}

function mockSb(opts: MockOpts = {}): StorageClientLike {
  const removedPaths = opts.removedPaths ?? [];
  let copyCount = 0;

  return {
    storage: {
      from(_bucket: string) {
        return {
          async list(prefix: string) {
            // Staging prefix
            if (prefix.includes("/uploads/")) {
              const data = Object.entries(opts.stagingSizes ?? {}).map(([name, size]) => ({
                name,
                metadata: { size } as Record<string, unknown>,
              }));
              return { data, error: null };
            }
            // Dest (sources/) prefix — called after all copies
            if (prefix.includes("/sources")) {
              if (opts.destListError) {
                return { data: null, error: { message: opts.destListError } };
              }
              const destSizes = opts.destList;
              if (destSizes) {
                const data = Object.entries(destSizes).map(([name, size]) => ({
                  name,
                  metadata: { size } as Record<string, unknown>,
                }));
                return { data, error: null };
              }
              // Default: mirror staging sizes (correct-copy scenario)
              const data = Object.entries(opts.stagingSizes ?? {}).map(([name, size]) => ({
                name,
                metadata: { size } as Record<string, unknown>,
              }));
              return { data, error: null };
            }
            // Parent sources prefix
            const data = Object.entries(opts.parentSizes ?? {}).map(([name, size]) => ({
              name,
              metadata: { size } as Record<string, unknown>,
            }));
            return { data, error: null };
          },
          async copy(_from: string, _to: string) {
            const idx = copyCount++;
            if (
              opts.copyFailAt !== undefined ||
              (opts.copyFailIndex !== undefined && idx >= opts.copyFailIndex)
            ) {
              return { data: null, error: { message: opts.copyFailAt ?? "copy error" } };
            }
            return { data: { id: "ok" }, error: null };
          },
          async remove(paths: string[]) {
            removedPaths.push(paths);
            if (opts.removeError) {
              return { data: null, error: { message: opts.removeError } };
            }
            return { data: [], error: null };
          },
        };
      },
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────

test("A1.1 — not-found returns 400 and copy() is never invoked", async () => {
  const item = stagingItem({ storedName: "missing.pdf" });
  const removedPaths: string[][] = [];
  const sb = mockSb({
    stagingSizes: {}, // storedName not present → not found
    removedPaths,
  });

  const result = await verifyAndCopyAttachments({
    orgId: ORG, newSlug: SLUG, draftId: DRAFT,
    items: [item], caller: "test",
    _sb: sb,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.ok(result.error?.includes("not found"));
  assert.equal(removedPaths.length, 0, "copy never ran so no rollback needed");
});

test("A1.2 — size mismatch returns 400 and copy() is never invoked", async () => {
  const item = stagingItem({ storedName: "report.pdf", sizeBytes: 1024 });
  const removedPaths: string[][] = [];
  const sb = mockSb({
    stagingSizes: { "report.pdf": 2048 }, // differs from claimed 1024
    removedPaths,
  });

  const result = await verifyAndCopyAttachments({
    orgId: ORG, newSlug: SLUG, draftId: DRAFT,
    items: [item], caller: "test",
    _sb: sb,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.ok(result.error?.includes("size mismatch"));
  assert.equal(removedPaths.length, 0);
});

test("A1.3 — copy failure mid-plan rolls back exactly the copied-so-far paths and returns 500", async () => {
  const items = [
    stagingItem({ storedName: "a.pdf", sizeBytes: 100, originalName: "a.pdf" }),
    stagingItem({ storedName: "b.pdf", sizeBytes: 200, originalName: "b.pdf" }),
    stagingItem({ storedName: "c.pdf", sizeBytes: 300, originalName: "c.pdf" }),
  ];
  const removedPaths: string[][] = [];
  const sb = mockSb({
    stagingSizes: { "a.pdf": 100, "b.pdf": 200, "c.pdf": 300 },
    copyFailIndex: 1, // first copy succeeds, second fails
    removedPaths,
  });

  const result = await verifyAndCopyAttachments({
    orgId: ORG, newSlug: SLUG, draftId: DRAFT,
    items, caller: "test",
    _sb: sb,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.ok(result.error?.includes("copy"));
  // rollback should have been called with exactly the 1 already-copied path
  assert.equal(removedPaths.length, 1, "bestEffortRemove called once for rollback");
  assert.equal(removedPaths[0].length, 1, "only 1 copied path rolled back");
  assert.ok(removedPaths[0][0].includes("a.pdf"), "the copied path was the first item");
});

test("A1.4 — post-copy dest list error removes all copies and returns 500", async () => {
  const item = stagingItem({ storedName: "r.pdf", sizeBytes: 512 });
  const removedPaths: string[][] = [];
  const sb = mockSb({
    stagingSizes: { "r.pdf": 512 },
    destListError: "storage unavailable",
    removedPaths,
  });

  const result = await verifyAndCopyAttachments({
    orgId: ORG, newSlug: SLUG, draftId: DRAFT,
    items: [item], caller: "test",
    _sb: sb,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.ok(result.error?.includes("post-copy verify list failed"));
  assert.equal(removedPaths.length, 1, "cleanup called");
  assert.equal(removedPaths[0].length, 1, "all 1 copies removed");
});

test("A1.5 — post-copy size mismatch removes all copies and returns 400", async () => {
  const items = [
    stagingItem({ storedName: "x.pdf", sizeBytes: 1000, originalName: "x.pdf" }),
    stagingItem({ storedName: "y.pdf", sizeBytes: 2000, originalName: "y.pdf" }),
  ];
  const removedPaths: string[][] = [];
  const sb = mockSb({
    stagingSizes: { "x.pdf": 1000, "y.pdf": 2000 },
    destList: { "x.pdf": 1000, "y.pdf": 99999 }, // y.pdf mismatches
    removedPaths,
  });

  const result = await verifyAndCopyAttachments({
    orgId: ORG, newSlug: SLUG, draftId: DRAFT,
    items, caller: "test",
    _sb: sb,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.ok(result.error?.includes("post-copy size check failed"));
  assert.equal(removedPaths.length, 1, "cleanup called");
  assert.equal(removedPaths[0].length, 2, "all 2 copies removed");
});

test("A1.6 — happy path: all copies succeed + post-verify passes → {ok:true, verified}", async () => {
  const items = [
    stagingItem({ storedName: "doc.pdf", sizeBytes: 3000, originalName: "doc.pdf" }),
  ];
  const removedPaths: string[][] = [];
  const sb = mockSb({
    stagingSizes: { "doc.pdf": 3000 },
    destList: { "doc.pdf": 3000 },
    removedPaths,
  });

  const result = await verifyAndCopyAttachments({
    orgId: ORG, newSlug: SLUG, draftId: DRAFT,
    items, caller: "test",
    _sb: sb,
  });

  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.verified));
  assert.equal(result.verified!.length, 1);
  assert.equal(result.verified![0].originalName, "doc.pdf");
  assert.equal(removedPaths.length, 0, "no cleanup on success");
});

test("A1.7 — removeStagedFiles: resolved {error} from remove() is logged but never throws", async () => {
  const removedPaths: string[][] = [];
  const sb = mockSb({ removeError: "storage-layer error", removedPaths });

  // Must not throw
  await assert.doesNotReject(() =>
    removeStagedFiles(ORG, DRAFT, ["report.pdf"], sb),
  );
  assert.equal(removedPaths.length, 1);
  assert.ok(removedPaths[0][0].includes("report.pdf"));
});

test("A1.8 — removeRunSources: paths routed via bestEffortRemove with correct org/slug scoping", async () => {
  const removedPaths: string[][] = [];
  const sb = mockSb({ removedPaths });

  await removeRunSources(ORG, SLUG, ["file.pdf"], sb);

  assert.equal(removedPaths.length, 1);
  const path = removedPaths[0][0];
  assert.ok(path.includes(ORG), `path should include orgId — got: ${path}`);
  assert.ok(path.includes(SLUG), `path should include slug — got: ${path}`);
  assert.ok(path.includes("file.pdf"), `path should include storedName — got: ${path}`);
  assert.ok(path.includes("sources"), `path should include sources subdir — got: ${path}`);
});
