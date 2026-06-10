/**
 * Unit tests for the S102 attachment path helpers (agent side):
 * scopedStagingPath + scopedSourcesPath in agent/lib/storage-paths.ts.
 *
 * Run: pnpm -C agent exec node --import=tsx --test "test/storage-paths-staging.test.ts"
 *
 * PARITY NOTE: frontend/lib/storage-paths.ts carries pair-edited mirrors of
 * these helpers. Cross-package imports are avoided (separate tsconfigs —
 * agent tsc would choke on frontend's extensionless relative imports), so
 * parity is enforced by running the SAME test vectors against the frontend
 * mirror in frontend/lib/__tests__/attachments.test.ts. Keep the two vector
 * sets in sync when validation rules change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scopedSourcesPath,
  scopedStagingPath,
  scopedStoragePath,
} from "../lib/storage-paths.js";

const ORG = "0a1b2c3d-0a1b-4c3d-8e9f-0a1b2c3d4e5f";
const DRAFT = "11111111-2222-4333-8444-555555555555";
const SLUG = "my-research-topic-9f8e7d6c";

// ── scopedStagingPath ───────────────────────────────────────────────

test("staging: prefix-only path", () => {
  assert.equal(scopedStagingPath(ORG, DRAFT), `${ORG}/uploads/${DRAFT}`);
});

test("staging: path with file", () => {
  assert.equal(
    scopedStagingPath(ORG, DRAFT, "report.pdf"),
    `${ORG}/uploads/${DRAFT}/report.pdf`,
  );
});

test("staging: rejects invalid orgId", () => {
  assert.throws(() => scopedStagingPath("", DRAFT));
  assert.throws(() => scopedStagingPath("not-a-uuid", DRAFT));
  assert.throws(() => scopedStagingPath("../escape", DRAFT));
});

test("staging: rejects invalid draftId (non-UUID, traversal, slug-like)", () => {
  assert.throws(() => scopedStagingPath(ORG, ""));
  assert.throws(() => scopedStagingPath(ORG, "uploads"));
  assert.throws(() => scopedStagingPath(ORG, ".."));
  assert.throws(() => scopedStagingPath(ORG, "11111111222243338444555555555555"));
});

test("staging: rejects file with path separators or traversal", () => {
  assert.throws(() => scopedStagingPath(ORG, DRAFT, "a/b.pdf"));
  assert.throws(() => scopedStagingPath(ORG, DRAFT, "a\\b.pdf"));
  assert.throws(() => scopedStagingPath(ORG, DRAFT, "a..b.pdf"));
});

test("staging: enforces the full storedName contract on file (S102 r3)", () => {
  assert.throws(() => scopedStagingPath(ORG, DRAFT, ".env"));
  assert.throws(() => scopedStagingPath(ORG, DRAFT, "x."));
  assert.throws(() => scopedStagingPath(ORG, DRAFT, "UPPER.PDF"));
  assert.throws(() => scopedStagingPath(ORG, DRAFT, "noextension"));
  assert.throws(() => scopedStagingPath(ORG, DRAFT, "evil.exe"));
  assert.throws(() => scopedStagingPath(ORG, DRAFT, "a\u0000b.pdf"));
  assert.throws(() => scopedStagingPath(ORG, DRAFT, "a\nb.pdf"));
});

// ── scopedSourcesPath ───────────────────────────────────────────────

test("sources: happy path", () => {
  assert.equal(
    scopedSourcesPath(ORG, SLUG, "report.pdf"),
    `${ORG}/${SLUG}/sources/report.pdf`,
  );
});

test("sources: file is required (no bare sources/ target)", () => {
  assert.throws(() => scopedSourcesPath(ORG, SLUG, ""));
});

test("sources: rejects file with path separators or traversal", () => {
  assert.throws(() => scopedSourcesPath(ORG, SLUG, "a/b.pdf"));
  assert.throws(() => scopedSourcesPath(ORG, SLUG, "a\\b.pdf"));
  assert.throws(() => scopedSourcesPath(ORG, SLUG, "a..b.pdf"));
});

test("sources: enforces the full storedName contract on file (S102 r3)", () => {
  assert.throws(() => scopedSourcesPath(ORG, SLUG, ".env"));
  assert.throws(() => scopedSourcesPath(ORG, SLUG, "x."));
  assert.throws(() => scopedSourcesPath(ORG, SLUG, "UPPER.PDF"));
  assert.throws(() => scopedSourcesPath(ORG, SLUG, "evil.exe"));
  assert.throws(() => scopedSourcesPath(ORG, SLUG, "a\u0000b.pdf"));
});

test("sources: rejects invalid slug (delegated to scopedStoragePath)", () => {
  assert.throws(() => scopedSourcesPath(ORG, "", "report.pdf"));
  assert.throws(() => scopedSourcesPath(ORG, "a/b", "report.pdf"));
  assert.throws(() => scopedSourcesPath(ORG, "..", "report.pdf"));
});

test("sources: rejects invalid orgId (delegated to scopedStoragePath)", () => {
  assert.throws(() => scopedSourcesPath("not-a-uuid", SLUG, "report.pdf"));
});

// ── Layout invariants ───────────────────────────────────────────────

test("sources path nests exactly one level under the run folder", () => {
  const run = scopedStoragePath(ORG, SLUG);
  const src = scopedSourcesPath(ORG, SLUG, "x.md");
  assert.ok(src.startsWith(`${run}/sources/`));
  assert.equal(src.split("/").length, run.split("/").length + 2);
});

test("staging lives under the org prefix, never under a run slug", () => {
  const staged = scopedStagingPath(ORG, DRAFT, "x.md");
  assert.ok(staged.startsWith(`${ORG}/uploads/`));
});
