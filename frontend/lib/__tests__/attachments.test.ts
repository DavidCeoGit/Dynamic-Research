/**
 * Unit tests for the S102 file-upload Phase 1 frontend contract:
 * sanitizeAttachmentName, the attachment zod schemas, and the frontend
 * mirrors of scopedStagingPath/scopedSourcesPath.
 *
 * Run: pnpm -C agent exec node --import=tsx --test "../frontend/lib/__tests__/attachments.test.ts"
 * (wired into the root `pnpm test` script alongside hidden-runs.test.ts)
 *
 * PARITY NOTE: the path-helper vectors here duplicate
 * agent/test/storage-paths-staging.test.ts on purpose — the agent and
 * frontend helpers are pair-edited mirrors and cross-package imports are
 * avoided (separate tsconfigs). Keep both vector sets in sync.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_STORED_NAME_REGEX,
  sanitizeAttachmentName,
} from "../attachments-constants";
import { scopedSourcesPath, scopedStagingPath } from "../storage-paths";
import {
  attachmentMetaSchema,
  attachmentPayloadItemSchema,
  attachmentsArraySchema,
  researchJobPayloadSchema,
} from "../validate";
import {
  mapDbAttachmentsToParentPayload,
  partitionByOrigin,
  stripOrigin,
  buildCopyPlan,
} from "../attachments-copy";
import type { AttachmentMeta } from "../types/queue";

const ORG = "0a1b2c3d-0a1b-4c3d-8e9f-0a1b2c3d4e5f";
const DRAFT = "11111111-2222-4333-8444-555555555555";
const SLUG = "my-research-topic-9f8e7d6c";

// ── sanitizeAttachmentName ──────────────────────────────────────────

test("sanitize: plain name passes through lowercased", () => {
  assert.equal(sanitizeAttachmentName("Report.PDF"), "report.pdf");
});

test("sanitize: spaces and punctuation become hyphens, collapsed", () => {
  assert.equal(
    sanitizeAttachmentName("Quarterly Report (FINAL).pdf"),
    "quarterly-report-final.pdf",
  );
});

test("sanitize: non-ascii reduced to safe charset", () => {
  assert.equal(sanitizeAttachmentName("RÉSUMÉ.PDF"), "r-sum.pdf");
});

test("sanitize: leading dots stripped (skip-prefix protection)", () => {
  assert.equal(sanitizeAttachmentName("...hidden.md"), "hidden.md");
});

test("sanitize: traversal attempts neutralized", () => {
  const out = sanitizeAttachmentName("..\\..\\evil.pdf");
  assert.equal(out, "evil.pdf");
  assert.ok(!out.includes(".."));
});

test("sanitize: bare extension falls back to 'file'", () => {
  assert.equal(sanitizeAttachmentName(".pdf"), "file.pdf");
});

test("sanitize: interior dots survive (no '..' possible)", () => {
  assert.equal(sanitizeAttachmentName("data.tar.md"), "data.tar.md");
});

test("sanitize: disallowed extension throws", () => {
  assert.throws(() => sanitizeAttachmentName("evil.exe"));
  assert.throws(() => sanitizeAttachmentName("noextension"));
  assert.throws(() => sanitizeAttachmentName("archive.zip"));
});

test("sanitize: collision suffixing against existing names", () => {
  const existing = new Set(["report.pdf", "report-1.pdf"]);
  assert.equal(sanitizeAttachmentName("Report.pdf", existing), "report-2.pdf");
});

test("sanitize: Windows reserved device names are remapped, not failed (Codex S103 MAJOR-2)", () => {
  // The OS write on the Phase-3 Windows worker would fail on these; the
  // sanitizer remaps so a legit upload literally named "con.pdf" still works.
  assert.equal(sanitizeAttachmentName("CON.PDF"), "file-con.pdf");
  assert.equal(sanitizeAttachmentName("nul.txt"), "file-nul.txt");
  assert.equal(sanitizeAttachmentName("com1.md"), "file-com1.md");
  assert.equal(sanitizeAttachmentName("con.tar.pdf"), "file-con.tar.pdf");
  // remapped output is itself non-reserved and contract-valid
  assert.match(sanitizeAttachmentName("CON.PDF"), ATTACHMENT_STORED_NAME_REGEX);
  // not reserved: merely starts with a reserved string
  assert.equal(sanitizeAttachmentName("connection.pdf"), "connection.pdf");
});

test("sanitize: output always satisfies the storedName contract", () => {
  const inputs = [
    "Report.PDF",
    "Quarterly Report (FINAL).pdf",
    "RÉSUMÉ.PDF",
    "...hidden.md",
    "..\\..\\evil.pdf",
    ".pdf",
    "data.tar.md",
    "__weird--name__.txt",
    `${"x".repeat(300)}.txt`,
  ];
  for (const input of inputs) {
    const out = sanitizeAttachmentName(input);
    assert.match(out, ATTACHMENT_STORED_NAME_REGEX, `failed for input: ${input}`);
    assert.ok(!out.includes(".."), `'..' leaked for input: ${input}`);
    assert.ok(out.length <= 160, `too long for input: ${input}`);
  }
});

// ── attachment zod schemas ──────────────────────────────────────────

const VALID_META = {
  originalName: "Quarterly Report (FINAL).pdf",
  storedName: "quarterly-report-final.pdf",
  sizeBytes: 1024,
  contentType: "application/pdf",
  uploadedAt: "2026-06-10T12:00:00.000Z",
};

test("schema: valid meta passes", () => {
  assert.deepEqual(attachmentMetaSchema.parse(VALID_META), VALID_META);
});

test("schema: disallowed contentType rejected", () => {
  assert.throws(() =>
    attachmentMetaSchema.parse({ ...VALID_META, contentType: "application/zip" }),
  );
});

test("schema: size bounds enforced", () => {
  assert.throws(() => attachmentMetaSchema.parse({ ...VALID_META, sizeBytes: 0 }));
  assert.throws(() =>
    attachmentMetaSchema.parse({
      ...VALID_META,
      sizeBytes: ATTACHMENT_MAX_FILE_BYTES + 1,
    }),
  );
});

test("schema: storedName shape enforced (case, leading char, traversal)", () => {
  assert.throws(() => attachmentMetaSchema.parse({ ...VALID_META, storedName: "UPPER.PDF" }));
  assert.throws(() => attachmentMetaSchema.parse({ ...VALID_META, storedName: ".hidden.pdf" }));
  assert.throws(() => attachmentMetaSchema.parse({ ...VALID_META, storedName: "../x.pdf" }));
  assert.throws(() => attachmentMetaSchema.parse({ ...VALID_META, storedName: "a..b.pdf" }));
  assert.throws(() => attachmentMetaSchema.parse({ ...VALID_META, storedName: "x.exe" }));
});

test("schema: reserved device storedNames rejected (Codex S103 MAJOR-2)", () => {
  // A sanitized storedName is never reserved (sanitizer remaps), so a reserved
  // one reaching zod means tampering or a non-sanitizer path — reject it.
  assert.throws(() => attachmentMetaSchema.parse({ ...VALID_META, storedName: "con.pdf" }));
  assert.throws(() => attachmentMetaSchema.parse({ ...VALID_META, storedName: "nul.pdf" }));
  assert.throws(() => attachmentMetaSchema.parse({ ...VALID_META, storedName: "com9.pdf" }));
  // non-reserved lookalike still passes
  assert.equal(
    attachmentMetaSchema.parse({ ...VALID_META, storedName: "connection.pdf" }).storedName,
    "connection.pdf",
  );
});

test("schema: contentType must match extension (interim MAJOR-1)", () => {
  // .md bytes declared as PDF — the content-type confusion vector.
  assert.throws(() =>
    attachmentMetaSchema.parse({ ...VALID_META, storedName: "x.md" }),
  );
  const ok = attachmentMetaSchema.parse({
    ...VALID_META,
    storedName: "x.md",
    contentType: "text/markdown",
  });
  assert.equal(ok.contentType, "text/markdown");
  // payload variant carries the same refine
  assert.throws(() =>
    attachmentPayloadItemSchema.parse({
      ...VALID_META,
      storedName: "x.txt",
      origin: "staging",
    }),
  );
});

test("sanitize: NFKC expansion vectors stay safe (interim coverage gap)", () => {
  // U+2024 ONE DOT LEADER x2 — NFKC-normalizes to ".."; must not survive.
  const dotLeader = sanitizeAttachmentName("\u2024\u2024evil.pdf");
  assert.ok(!dotLeader.includes(".."));
  assert.match(dotLeader, ATTACHMENT_STORED_NAME_REGEX);
  // U+FF0F FULLWIDTH SOLIDUS — NFKC-normalizes to "/"; must not survive.
  const solidus = sanitizeAttachmentName("evil\uFF0Fname.pdf");
  assert.ok(!solidus.includes("/"));
  assert.match(solidus, ATTACHMENT_STORED_NAME_REGEX);
  // U+FB01 LATIN SMALL LIGATURE FI — expands to "fi".
  assert.equal(sanitizeAttachmentName("\uFB01le.txt"), "file.txt");
  // RTL override + zero-width chars — reduced to safe charset.
  const rtl = sanitizeAttachmentName("\u202Eevil\u200B.pdf");
  assert.match(rtl, ATTACHMENT_STORED_NAME_REGEX);
});

test("sanitize: batch collision threading (interim MINOR-4 contract)", () => {
  const assigned = new Set<string>();
  const out: string[] = [];
  for (const input of [".pdf", "..pdf", "---.pdf"]) {
    const name = sanitizeAttachmentName(input, assigned);
    assigned.add(name);
    out.push(name);
  }
  assert.deepEqual(out, ["file.pdf", "file-1.pdf", "file-2.pdf"]);
});

test("mirror helpers: full storedName contract on file (S102 r3)", () => {
  assert.throws(() => scopedStagingPath(ORG, DRAFT, ".env"));
  assert.throws(() => scopedStagingPath(ORG, DRAFT, "x."));
  assert.throws(() => scopedSourcesPath(ORG, SLUG, "UPPER.PDF"));
  assert.throws(() => scopedSourcesPath(ORG, SLUG, "evil.exe"));
});

test("schema: uploadedAt must be ISO datetime", () => {
  assert.throws(() =>
    attachmentMetaSchema.parse({ ...VALID_META, uploadedAt: "yesterday" }),
  );
});

test("schema: payload item requires a valid origin", () => {
  assert.throws(() => attachmentPayloadItemSchema.parse(VALID_META));
  assert.throws(() =>
    attachmentPayloadItemSchema.parse({ ...VALID_META, origin: "elsewhere" }),
  );
  const ok = attachmentPayloadItemSchema.parse({ ...VALID_META, origin: "staging" });
  assert.equal(ok.origin, "staging");
});

test("schema: array caps — count, total bytes, duplicate storedNames", () => {
  const item = (n: number, sizeBytes = 1024) => ({
    ...VALID_META,
    storedName: `file-${n}.pdf`,
    sizeBytes,
    origin: "staging",
  });
  // count cap
  assert.throws(() =>
    attachmentsArraySchema.parse([0, 1, 2, 3, 4, 5].map((n) => item(n))),
  );
  assert.equal(attachmentsArraySchema.parse([0, 1, 2, 3, 4].map((n) => item(n))).length, 5);
  // total-bytes cap: 3 × 15MiB = 45MiB > 40MiB total cap
  assert.throws(() =>
    attachmentsArraySchema.parse(
      [0, 1, 2].map((n) => item(n, ATTACHMENT_MAX_FILE_BYTES)),
    ),
  );
  // duplicate storedNames
  assert.throws(() => attachmentsArraySchema.parse([item(1), item(1)]));
});

test("schema: staging attachments require attachmentsDraftId (Gemini MINOR-1)", () => {
  const base = {
    topic: "a perfectly reasonable research topic",
    selectedProducts: { report: true },
    attachments: [{ ...VALID_META, origin: "staging" }],
  };
  assert.throws(() => researchJobPayloadSchema.parse(base));
  const ok = researchJobPayloadSchema.parse({
    ...base,
    attachmentsDraftId: DRAFT,
  });
  assert.equal(ok.attachments.length, 1);
});

test("schema: parent attachments require parentSlug (Gemini MINOR-1)", () => {
  const base = {
    topic: "a perfectly reasonable research topic",
    selectedProducts: { report: true },
    attachments: [{ ...VALID_META, origin: "parent" }],
  };
  assert.throws(() => researchJobPayloadSchema.parse(base));
  const ok = researchJobPayloadSchema.parse({ ...base, parentSlug: SLUG });
  assert.equal(ok.attachments.length, 1);
});

test("schema: payload defaults attachments to [] for pre-S102 clients", () => {
  const parsed = researchJobPayloadSchema.parse({
    topic: "a perfectly reasonable research topic",
    selectedProducts: { report: true },
  });
  assert.deepEqual(parsed.attachments, []);
  assert.equal(parsed.attachmentsDraftId ?? null, null);
});

// ── frontend path-helper mirrors (vectors mirror the agent suite) ───

test("mirror staging: prefix + file paths", () => {
  assert.equal(scopedStagingPath(ORG, DRAFT), `${ORG}/uploads/${DRAFT}`);
  assert.equal(
    scopedStagingPath(ORG, DRAFT, "report.pdf"),
    `${ORG}/uploads/${DRAFT}/report.pdf`,
  );
});

test("mirror staging: rejects bad orgId/draftId/file", () => {
  assert.throws(() => scopedStagingPath("not-a-uuid", DRAFT));
  assert.throws(() => scopedStagingPath(ORG, "uploads"));
  assert.throws(() => scopedStagingPath(ORG, ".."));
  assert.throws(() => scopedStagingPath(ORG, DRAFT, "a/b.pdf"));
  assert.throws(() => scopedStagingPath(ORG, DRAFT, "a\\b.pdf"));
  assert.throws(() => scopedStagingPath(ORG, DRAFT, "a..b.pdf"));
});

test("mirror sources: happy path + rejections", () => {
  assert.equal(
    scopedSourcesPath(ORG, SLUG, "report.pdf"),
    `${ORG}/${SLUG}/sources/report.pdf`,
  );
  assert.throws(() => scopedSourcesPath(ORG, SLUG, ""));
  assert.throws(() => scopedSourcesPath(ORG, SLUG, "a/b.pdf"));
  assert.throws(() => scopedSourcesPath(ORG, "a/b", "report.pdf"));
  assert.throws(() => scopedSourcesPath("not-a-uuid", SLUG, "report.pdf"));
});

test("mirror helpers: reject Windows reserved device basenames (Codex S103 MAJOR-2)", () => {
  assert.throws(() => scopedStagingPath(ORG, DRAFT, "con.pdf"));
  assert.throws(() => scopedStagingPath(ORG, DRAFT, "com1.md"));
  assert.throws(() => scopedSourcesPath(ORG, SLUG, "nul.txt"));
  assert.throws(() => scopedSourcesPath(ORG, SLUG, "con.tar.pdf"));
  // non-reserved lookalike passes through both helpers
  assert.equal(
    scopedStagingPath(ORG, DRAFT, "connection.pdf"),
    `${ORG}/uploads/${DRAFT}/connection.pdf`,
  );
});

// ── Phase 2: attachments-copy pure helpers ──────────────────────────
//
// These cover the submit-time verify+copy planning surface (the impure
// storage orchestration in lib/storage.ts builds on these). The
// mapDbAttachmentsToParentPayload vectors are the §3b regression guard: a
// replayed/cloned attachment-bearing run must carry its parent's files
// (the CRITICAL the S102 Phase-1 Gemini-grounded review flagged).

const META_A: AttachmentMeta = {
  originalName: "Brief A.pdf",
  storedName: "brief-a.pdf",
  sizeBytes: 1234,
  contentType: "application/pdf",
  uploadedAt: "2026-06-10T12:00:00.000Z",
};
const META_B: AttachmentMeta = {
  originalName: "notes.md",
  storedName: "notes.md",
  sizeBytes: 88,
  contentType: "text/markdown",
  uploadedAt: "2026-06-10T12:01:00.000Z",
};

test("mapDbAttachmentsToParentPayload: null/empty → []", () => {
  assert.deepEqual(mapDbAttachmentsToParentPayload(null), []);
  assert.deepEqual(mapDbAttachmentsToParentPayload(undefined), []);
  assert.deepEqual(mapDbAttachmentsToParentPayload([]), []);
});

test("mapDbAttachmentsToParentPayload: tags origin:parent, preserves every field (§3b)", () => {
  const out = mapDbAttachmentsToParentPayload([META_A, META_B]);
  assert.equal(out.length, 2);
  for (const item of out) assert.equal(item.origin, "parent");
  // Field-for-field carry — a dropped field here is a silently-lost attachment.
  assert.deepEqual(out[0], { ...META_A, origin: "parent" });
  assert.deepEqual(out[1], { ...META_B, origin: "parent" });
  // The mapped payload must itself satisfy the payload schema.
  assert.doesNotThrow(() => attachmentPayloadItemSchema.parse(out[0]));
});

test("partitionByOrigin: splits staging vs parent, preserves order", () => {
  const s1 = { ...META_A, origin: "staging" as const };
  const p1 = { ...META_B, origin: "parent" as const };
  const s2 = { ...META_A, storedName: "brief-a-1.pdf", origin: "staging" as const };
  const { staging, parent } = partitionByOrigin([s1, p1, s2]);
  assert.deepEqual(staging, [s1, s2]);
  assert.deepEqual(parent, [p1]);
});

test("stripOrigin: drops the payload-only origin field", () => {
  const stripped = stripOrigin([
    { ...META_A, origin: "staging" },
    { ...META_B, origin: "parent" },
  ]);
  assert.deepEqual(stripped, [META_A, META_B]);
  assert.ok(!("origin" in stripped[0]));
});

test("buildCopyPlan: staging item resolves uploads→sources paths", () => {
  const plan = buildCopyPlan({
    orgId: ORG,
    newSlug: SLUG,
    draftId: DRAFT,
    items: [{ ...META_A, origin: "staging" }],
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].fromPath, `${ORG}/uploads/${DRAFT}/brief-a.pdf`);
  assert.equal(plan[0].toPath, `${ORG}/${SLUG}/sources/brief-a.pdf`);
  assert.equal(plan[0].sizeBytes, META_A.sizeBytes);
  assert.equal(plan[0].origin, "staging");
});

test("buildCopyPlan: parent item resolves parentSources→sources paths", () => {
  const plan = buildCopyPlan({
    orgId: ORG,
    newSlug: SLUG,
    parentSlug: "parent-run-1a2b3c4d",
    items: [{ ...META_B, origin: "parent" }],
  });
  assert.equal(plan[0].fromPath, `${ORG}/parent-run-1a2b3c4d/sources/notes.md`);
  assert.equal(plan[0].toPath, `${ORG}/${SLUG}/sources/notes.md`);
});

test("buildCopyPlan: throws when a staging item has no draftId", () => {
  assert.throws(() =>
    buildCopyPlan({
      orgId: ORG,
      newSlug: SLUG,
      draftId: null,
      items: [{ ...META_A, origin: "staging" }],
    }),
  );
});

test("buildCopyPlan: throws when a parent item has no parentSlug", () => {
  assert.throws(() =>
    buildCopyPlan({
      orgId: ORG,
      newSlug: SLUG,
      parentSlug: null,
      items: [{ ...META_B, origin: "parent" }],
    }),
  );
});

test("buildCopyPlan: throws on duplicate storedName across origins (Codex BLOCKING)", () => {
  // A clone carries parent attachment "brief-a.pdf" while a freshly-staged
  // upload also resolved to "brief-a.pdf": both map to the SAME destination
  // toPath. The plan must reject this LOUDLY rather than silently clobbering
  // one file and persisting a row that claims two attachments.
  assert.throws(
    () =>
      buildCopyPlan({
        orgId: ORG,
        newSlug: SLUG,
        draftId: DRAFT,
        parentSlug: "parent-run-1a2b3c4d",
        items: [
          { ...META_A, origin: "staging" },
          { ...META_A, origin: "parent" }, // same storedName as the staging item
        ],
      }),
    /duplicate storedName/,
  );
});

test("buildCopyPlan: distinct storedNames across origins are allowed", () => {
  const plan = buildCopyPlan({
    orgId: ORG,
    newSlug: SLUG,
    draftId: DRAFT,
    parentSlug: "parent-run-1a2b3c4d",
    items: [
      { ...META_A, origin: "staging" },
      { ...META_B, origin: "parent" },
    ],
  });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].toPath, `${ORG}/${SLUG}/sources/brief-a.pdf`);
  assert.equal(plan[1].toPath, `${ORG}/${SLUG}/sources/notes.md`);
});
