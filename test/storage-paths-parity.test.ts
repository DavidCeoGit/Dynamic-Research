/**
 * S178 — cross-root behavioral parity guard for the tenant-scoped storage-path
 * helpers.
 *
 * The frontend cannot import agent/lib/storage-paths.ts (agent/ pulls
 * conventions.ts → fs.readFileSync, which would break the Next/edge bundle),
 * so the three path helpers are MIRRORED: agent/lib/storage-paths.ts ↔
 * frontend/lib/storage-paths.ts. The two draw their path segments + validation
 * constants from DIFFERENT sources — agent reads ATTACHMENTS.* from
 * conventions.json; the frontend reads ATTACHMENT_* from
 * attachments-constants.ts — and CLAUDE.md §9 mandates a manual pair-edit with
 * "nothing mechanical catches drift between the two." This IS that mechanical
 * catch: a silent divergence (conventions.json staging_prefix renamed but the
 * frontend mirror not, a stored_name_regex / reserved_basenames mismatch, or a
 * one-sided change to the traversal guards) re-opens the cross-tenant
 * path-construction drift class. Closes audit 2026-06-24 MEDIUM ("storage-path
 * helpers duplicated ... with no sync enforcement" + "frontend has zero test
 * parity vs agent's suite").
 *
 * This imports BOTH REAL exports and runs the same input matrix through the
 * actual functions — behavioral parity on the live exports, NOT a source
 * byte-grep (S120 Codex C5: byte-parity false-fails on formatting and misses
 * divergence outside the compared body). It lives at the repo root so it is
 * outside both subprojects' tsconfig (neither tsc typechecks a cross-root
 * import); tsx transpiles each module at runtime. agent's `uploadWithAudit` is
 * intentionally NOT mirrored (the frontend has no audit wrapper) and is out of
 * scope.
 *
 * Run (from repo root, via agent's tsx loader):
 *   pnpm -C agent exec node --import=tsx --test "../test/storage-paths-parity.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scopedStoragePath as agentScopedStoragePath,
  scopedStagingPath as agentScopedStagingPath,
  scopedSourcesPath as agentScopedSourcesPath,
} from "../agent/lib/storage-paths.js";
import {
  scopedStoragePath as frontendScopedStoragePath,
  scopedStagingPath as frontendScopedStagingPath,
  scopedSourcesPath as frontendScopedSourcesPath,
} from "../frontend/lib/storage-paths.js";

// Two well-shaped UUIDs (the helpers validate SHAPE 8-4-4-4-12, not v4 variant
// nibbles — see UUID_SHAPE_REGEX in both files).
const ORG = "550e8400-e29b-41d4-a716-446655440000";
const DRAFT = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const SLUG = "climate-tech-a1b2c3d4";

type Outcome =
  | { threw: true; message: string }
  | { threw: false; value: string };

type PathHelper = (a: string, b: string, c?: string) => string;

function call(fn: PathHelper, a: string, b: string, c?: string): Outcome {
  try {
    return { threw: false, value: fn(a, b, c) };
  } catch (e) {
    return { threw: true, message: (e as Error).message };
  }
}

/**
 * Behavioral parity: agent and frontend must agree on BOTH whether the call
 * throws AND (when it doesn't) the exact path string. Error messages are NOT
 * compared — a one-sided wording change is not a behavioral divergence (same
 * rule as publish-flag-parity / studio-products-parity).
 */
function assertParity(label: string, agent: Outcome, frontend: Outcome): void {
  assert.equal(
    agent.threw,
    frontend.threw,
    `${label}: throw-parity broken — agent.threw=${agent.threw} ` +
      `frontend.threw=${frontend.threw} ` +
      `(agent=${JSON.stringify(agent)} frontend=${JSON.stringify(frontend)})`,
  );
  if (!agent.threw && !frontend.threw) {
    assert.equal(
      agent.value,
      frontend.value,
      `${label}: value divergence — agent="${agent.value}" frontend="${frontend.value}"`,
    );
  }
}

interface Row {
  label: string;
  a: string;
  b: string;
  c?: string;
}

// ── scopedStoragePath(orgId, projectSlug, file?) ─────────────────────
const STORAGE_MATRIX: Row[] = [
  { label: "valid, no file", a: ORG, b: SLUG },
  { label: "valid, with file", a: ORG, b: SLUG, c: "report.pdf" },
  { label: "valid, dotted file", a: ORG, b: SLUG, c: "a.b.c.txt" },
  { label: "valid, dotted slug (dots are allowed)", a: ORG, b: "a.b.c" },
  { label: "invalid orgId — not a uuid", a: "not-a-uuid", b: SLUG },
  { label: "invalid orgId — 36 hyphens (v1 pathological)", a: "------------------------------------", b: SLUG },
  { label: "invalid orgId — empty", a: "", b: SLUG },
  { label: "invalid slug — forward slash", a: ORG, b: "a/b" },
  { label: "invalid slug — backslash", a: ORG, b: "a\\b" },
  { label: "invalid slug — dot-dot traversal", a: ORG, b: "..", c: "x.pdf" },
  { label: "invalid slug — embedded ..", a: ORG, b: "a..b" },
  { label: "invalid slug — empty", a: ORG, b: "" },
  { label: "invalid file — forward slash", a: ORG, b: SLUG, c: "sub/x.pdf" },
  { label: "invalid file — backslash", a: ORG, b: SLUG, c: "sub\\x.pdf" },
  { label: "invalid file — dot-dot traversal", a: ORG, b: SLUG, c: "../x.pdf" },
];

// ── scopedStagingPath(orgId, draftId, file?) ─────────────────────────
const STAGING_MATRIX: Row[] = [
  { label: "valid, no file (bare prefix)", a: ORG, b: DRAFT },
  { label: "valid, pdf", a: ORG, b: DRAFT, c: "report.pdf" },
  { label: "valid, txt with hyphen+underscore", a: ORG, b: DRAFT, c: "my-notes_v2.txt" },
  { label: "valid, md", a: ORG, b: DRAFT, c: "a.md" },
  { label: "invalid orgId", a: "nope", b: DRAFT, c: "report.pdf" },
  { label: "invalid draftId — not a uuid", a: ORG, b: "draft-1", c: "report.pdf" },
  { label: "invalid draftId — empty", a: ORG, b: "", c: "report.pdf" },
  { label: "invalid file — reserved basename con.pdf", a: ORG, b: DRAFT, c: "con.pdf" },
  { label: "invalid file — reserved basename nul.txt", a: ORG, b: DRAFT, c: "nul.txt" },
  { label: "invalid file — reserved basename lpt1.md", a: ORG, b: DRAFT, c: "lpt1.md" },
  { label: "invalid file — disallowed extension", a: ORG, b: DRAFT, c: "bad.exe" },
  { label: "invalid file — uppercase (regex is lowercase-anchored)", a: ORG, b: DRAFT, c: "Report.pdf" },
  { label: "invalid file — leading dot", a: ORG, b: DRAFT, c: ".hidden.pdf" },
  { label: "invalid file — dot-dot traversal", a: ORG, b: DRAFT, c: "../x.pdf" },
];

// ── scopedSourcesPath(orgId, projectSlug, file) — file REQUIRED ──────
const SOURCES_MATRIX: Row[] = [
  { label: "valid, pdf", a: ORG, b: SLUG, c: "report.pdf" },
  { label: "valid, md", a: ORG, b: SLUG, c: "a.md" },
  { label: "invalid orgId", a: "nope", b: SLUG, c: "report.pdf" },
  { label: "invalid slug — dot-dot", a: ORG, b: "..", c: "report.pdf" },
  { label: "invalid file — reserved basename con.pdf", a: ORG, b: SLUG, c: "con.pdf" },
  { label: "invalid file — disallowed extension", a: ORG, b: SLUG, c: "x.docx" },
  { label: "invalid file — empty (file is required)", a: ORG, b: SLUG, c: "" },
  { label: "invalid file — dot-dot traversal", a: ORG, b: SLUG, c: "../x.pdf" },
];

test("scopedStoragePath parity: agent and frontend agree across the input matrix", () => {
  for (const r of STORAGE_MATRIX) {
    assertParity(
      `scopedStoragePath[${r.label}]`,
      call(agentScopedStoragePath, r.a, r.b, r.c),
      call(frontendScopedStoragePath, r.a, r.b, r.c),
    );
  }
});

test("scopedStagingPath parity: agent and frontend agree across the input matrix", () => {
  for (const r of STAGING_MATRIX) {
    assertParity(
      `scopedStagingPath[${r.label}]`,
      call(agentScopedStagingPath, r.a, r.b, r.c),
      call(frontendScopedStagingPath, r.a, r.b, r.c),
    );
  }
});

test("scopedSourcesPath parity: agent and frontend agree across the input matrix", () => {
  for (const r of SOURCES_MATRIX) {
    assertParity(
      `scopedSourcesPath[${r.label}]`,
      call(agentScopedSourcesPath, r.a, r.b, r.c),
      call(frontendScopedSourcesPath, r.a, r.b, r.c),
    );
  }
});

test("anchor: literal path contract pinned on both tiers (catches identical both-sided drift)", () => {
  // Pure agent==frontend parity passes even if BOTH mirrors drift the same
  // wrong way (e.g. staging_prefix renamed in conventions.json AND
  // attachments-constants.ts). Anchor the agreed segments so that class of
  // change must update this test deliberately. A genuine rename is then a
  // 3-file edit (conventions.json + attachments-constants.ts + this anchor),
  // which is the intended friction.
  const expectStorage = `${ORG}/${SLUG}/report.pdf`;
  const expectStaging = `${ORG}/uploads/${DRAFT}/report.pdf`;
  const expectSources = `${ORG}/${SLUG}/sources/report.pdf`;

  assert.equal(agentScopedStoragePath(ORG, SLUG, "report.pdf"), expectStorage);
  assert.equal(frontendScopedStoragePath(ORG, SLUG, "report.pdf"), expectStorage);

  assert.equal(agentScopedStagingPath(ORG, DRAFT, "report.pdf"), expectStaging);
  assert.equal(frontendScopedStagingPath(ORG, DRAFT, "report.pdf"), expectStaging);

  assert.equal(agentScopedSourcesPath(ORG, SLUG, "report.pdf"), expectSources);
  assert.equal(frontendScopedSourcesPath(ORG, SLUG, "report.pdf"), expectSources);
});
