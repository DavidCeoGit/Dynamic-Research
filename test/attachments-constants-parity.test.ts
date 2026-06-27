/**
 * S178 — cross-root parity guard for the attachment constants mirror.
 *
 * frontend/lib/attachments-constants.ts is a hand-authored MIRROR of the
 * `attachments` block in agent/lib/conventions.json (the agent canonical,
 * surfaced as the ATTACHMENTS export of conventions.ts). conventions.json
 * itself says: "Frontend mirror of these values: frontend/lib/
 * attachments-constants.ts (pair-edit both)" — and attachments-constants.ts
 * says "nothing mechanical catches drift between the two." This IS that
 * mechanical catch.
 *
 * Why it matters: these constants gate the $15/job cost guard (max_file_bytes /
 * max_total_bytes / max_files) and the upload validation surface
 * (allowed_extensions / allowed_mime_types / stored_name_regex /
 * reserved_basenames / staging_prefix / sources_subdir). A silent one-sided
 * edit (e.g. raising max_files in conventions.json but not the frontend, or a
 * new allowed extension added to one side only) drifts the client-side
 * pre-validation away from the worker's server-side enforcement. The
 * companion storage-paths-parity.test.ts covers the three path HELPERS; this
 * covers the DATA they (and the upload routes) read. Closes audit 2026-06-24
 * MEDIUM ("attachments-constants.ts mirrors conventions.json with no sync
 * check").
 *
 * Imports BOTH REAL exports and compares the live values — NOT a source
 * byte-grep. Lives at the repo root so it is outside both subprojects'
 * tsconfig; tsx transpiles each module at runtime. Agent-only worker tunables
 * (max_pages_read_per_pdf, max_digest_words_per_file) are intentionally NOT
 * mirrored to the frontend and are out of scope.
 *
 * Run (from repo root, via agent's tsx loader):
 *   pnpm -C agent exec node --import=tsx --test "../test/attachments-constants-parity.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ATTACHMENTS } from "../agent/lib/conventions.js"; // agent canonical (conventions.json block)
import {
  ATTACHMENT_ALLOWED_EXTENSIONS,
  ATTACHMENT_ALLOWED_MIME_TYPES,
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  ATTACHMENT_MAX_FILES,
  ATTACHMENT_STAGING_PREFIX,
  ATTACHMENT_SOURCES_SUBDIR,
  ATTACHMENT_STAGING_TTL_HOURS,
  ATTACHMENT_EXT_TO_MIME,
  ATTACHMENT_STORED_NAME_REGEX,
  ATTACHMENT_RESERVED_BASENAMES,
  isReservedBasename,
} from "../frontend/lib/attachments-constants.js";

// Raw conventions.json attachments block (untyped JSON at runtime).
const C = ATTACHMENTS as {
  allowed_extensions: string[];
  allowed_mime_types: string[];
  stored_name_regex: string;
  max_file_bytes: number;
  max_total_bytes: number;
  max_files: number;
  staging_prefix: string;
  sources_subdir: string;
  staging_ttl_hours: number;
  reserved_basenames: string[];
};

test("attachments parity: scalar caps + path segments mirror conventions.json", () => {
  assert.equal(ATTACHMENT_MAX_FILE_BYTES, C.max_file_bytes, "max_file_bytes drift");
  assert.equal(ATTACHMENT_MAX_TOTAL_BYTES, C.max_total_bytes, "max_total_bytes drift");
  assert.equal(ATTACHMENT_MAX_FILES, C.max_files, "max_files drift");
  assert.equal(ATTACHMENT_STAGING_PREFIX, C.staging_prefix, "staging_prefix drift");
  assert.equal(ATTACHMENT_SOURCES_SUBDIR, C.sources_subdir, "sources_subdir drift");
  assert.equal(ATTACHMENT_STAGING_TTL_HOURS, C.staging_ttl_hours, "staging_ttl_hours drift");
});

test("attachments parity: allowed extensions + mime types mirror conventions.json (value + order)", () => {
  assert.deepEqual(
    [...ATTACHMENT_ALLOWED_EXTENSIONS],
    C.allowed_extensions,
    "allowed_extensions drift",
  );
  assert.deepEqual(
    [...ATTACHMENT_ALLOWED_MIME_TYPES],
    C.allowed_mime_types,
    "allowed_mime_types drift",
  );
});

test("attachments parity: stored-name regex source mirrors conventions.json", () => {
  // The frontend RegExp literal and the conventions.json string must encode the
  // identical pattern (RegExp.source drops the slashes; the JSON string's single
  // backslash before the dot survives JSON parsing → both read `\.`).
  assert.equal(
    ATTACHMENT_STORED_NAME_REGEX.source,
    C.stored_name_regex,
    "stored_name_regex drift",
  );
});

test("attachments parity: reserved basenames mirror conventions.json (set-equality) + isReservedBasename agrees", () => {
  assert.deepEqual(
    [...ATTACHMENT_RESERVED_BASENAMES].sort(),
    [...C.reserved_basenames].sort(),
    "reserved_basenames set drift",
  );
  // Tie the live helper to the canonical list: every reserved name (any allowed
  // extension) is rejected; a normal name is not.
  for (const name of C.reserved_basenames) {
    assert.equal(
      isReservedBasename(`${name}.pdf`),
      true,
      `isReservedBasename should flag reserved "${name}.pdf"`,
    );
  }
  assert.equal(isReservedBasename("report.pdf"), false, "a normal name must not be flagged");
});

test("attachments consistency: ext→mime map keys ⊆ allowed extensions, values ⊆ allowed mime types", () => {
  // EXT_TO_MIME is frontend-derived (no direct conventions mirror), so guard its
  // internal consistency with the allowlists — catches an extension added to the
  // allowlist but not the mime map (or vice-versa).
  const exts = Object.keys(ATTACHMENT_EXT_TO_MIME);
  assert.deepEqual(
    exts.slice().sort(),
    [...ATTACHMENT_ALLOWED_EXTENSIONS].slice().sort(),
    "EXT_TO_MIME keys must exactly cover the allowed extensions",
  );
  for (const [ext, mime] of Object.entries(ATTACHMENT_EXT_TO_MIME)) {
    assert.ok(
      (ATTACHMENT_ALLOWED_MIME_TYPES as readonly string[]).includes(mime),
      `EXT_TO_MIME["${ext}"] = "${mime}" is not in the allowed mime types`,
    );
  }
});
