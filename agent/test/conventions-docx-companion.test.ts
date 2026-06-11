/**
 * v3.1 (S107) — Studio report .docx companion.
 *
 * The gallery offers a Word download for any md whose .docx companion exists;
 * Studio report mds were the one md class without one (pandoc Step C ran on
 * research mds only). conventions v3.1 adds a per-product `docx_companion`
 * flag (report: true) that lint-deliverables uses to (a) accept the .docx
 * sibling instead of flagging an ext mismatch, (b) exclude companions from
 * duplicate/coverage counting. These tests pin the conventions data + the
 * classify/parse/upload behavior the lint predicate is built on.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyFile,
  parseStudioFilename,
  STUDIO_PRODUCTS,
} from "../lib/conventions.js";
import { selectUploadSet, type UploadCandidate } from "../lib/upload-set.js";

const TITLED_REPORT_MD =
  "strategic-counter-proposal-memorandum-20260610-192705-report.md";
const TITLED_REPORT_DOCX =
  "strategic-counter-proposal-memorandum-20260610-192705-report.docx";

test("conventions: docx_companion flag is true for report, false elsewhere", () => {
  assert.equal(STUDIO_PRODUCTS["report"]?.docx_companion, true);
  for (const product of ["audio", "video", "slides", "infographic"]) {
    assert.equal(
      STUDIO_PRODUCTS[product]?.docx_companion,
      false,
      `${product} must not allow a docx companion`,
    );
  }
});

test("classify/parse: titled report .docx is studio-shaped with ext docx", () => {
  assert.equal(classifyFile(TITLED_REPORT_DOCX), "studio");
  const parsed = parseStudioFilename(TITLED_REPORT_DOCX);
  assert.ok(parsed, "titled report docx must parse as a studio filename");
  assert.equal(parsed.product, "report");
  assert.equal(parsed.ext, "docx");
});

test("lint predicate: ext 'docx' is companion-valid ONLY for flagged products", () => {
  // Mirrors lint-deliverables.ts: isDocxCompanion = ext==="docx" && flag===true.
  const companionValid = (product: string) =>
    STUDIO_PRODUCTS[product]?.docx_companion === true;
  assert.equal(companionValid("report"), true);
  assert.equal(companionValid("slides"), false);
  assert.equal(companionValid("audio"), false);
  // Canonical ext stays md — the companion never replaces the report itself.
  assert.equal(STUDIO_PRODUCTS["report"]?.ext, "md");
});

test("upload set: titled report .docx companion is uploaded alongside the md", () => {
  const file = (name: string): UploadCandidate => ({ name, isFile: true });
  const got = selectUploadSet([
    file(TITLED_REPORT_MD),
    file(TITLED_REPORT_DOCX),
    file("claude-prompt.md"), // skip-list control
  ]).map((f) => f.remoteName);
  assert.deepEqual(got, [TITLED_REPORT_MD, TITLED_REPORT_DOCX]);
});
