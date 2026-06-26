/**
 * S106 Phase 3 unit tests — worker-side attachment intake.
 *
 * Covers:
 *   1. sniffAttachment magic-byte matrix (real PDF, ZIP-renamed, NUL text,
 *      ELF/PE prefixes, invalid UTF-8, valid md).
 *   2. downloadAttachments SKIP-AND-RECORD policy against a mocked Supabase
 *      storage client + a real temp workDir (per-file caps, size re-check,
 *      sniff rejection, bad storedName, duplicate storedName, max_files,
 *      total-bytes cap, download errors — and that it NEVER throws).
 *   3. buildManifest attachment fields (localSourcePath set/null,
 *      attachments + attachmentsSkipped + attachmentsPolicy).
 *   4. buildPrompt fenced attachments block + ./sources/ CRITICAL directive
 *      present iff at least one attachment was downloaded.
 *
 * Run: pnpm -C agent exec node --import=tsx --test "test/attachments.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  sniffAttachment,
  downloadAttachments,
  validateAttachmentMeta,
  asMetaOrNull,
  type StorageDownloaderLike,
} from "../lib/attachments.js";
import { ATTACHMENTS } from "../lib/conventions.js";
import { buildManifest, buildPrompt } from "../lib/job-manifest.js";
import type { AttachmentMeta, ResearchJob } from "../types.js";

const ORG = "0a1b2c3d-0a1b-4c3d-8e9f-0a1b2c3d4e5f";
const SLUG = "my-research-topic-9f8e7d6c";

// ── Fixtures ────────────────────────────────────────────────────────

const PDF_BYTES = Buffer.concat([
  Buffer.from("%PDF-1.7\n"),
  Buffer.from("1 0 obj << /Type /Catalog >> endobj\n%%EOF\n"),
]);
const ZIP_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from("not really text"),
]);
const ELF_BYTES = Buffer.concat([
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  Buffer.from("binary"),
]);
const PE_BYTES = Buffer.concat([
  Buffer.from([0x4d, 0x5a]),
  Buffer.from([0x90, 0x00, 0x03]),
]);
const MD_BYTES = Buffer.from("# Notes\n\nPlain **markdown** with unicode: é ✓\n");

function meta(over: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return {
    originalName: "Report.pdf",
    storedName: "report.pdf",
    sizeBytes: PDF_BYTES.length,
    contentType: "application/pdf",
    uploadedAt: "2026-06-11T00:00:00.000Z",
    ...over,
  };
}

/**
 * Mock client serving a fixed path→bytes map; records requested paths.
 * list() serves the sources/ listing derived from `files` (metadata size =
 * actual byte length) unless `listedSizes` overrides it — that lets tests
 * exercise the pre-download size gate independently of the actual bytes.
 */
function mockSb(
  files: Record<string, Buffer>,
  opts: {
    failDownloadWith?: string;
    failListWith?: string;
    listedSizes?: Record<string, number>;
  } = {},
): StorageDownloaderLike & { requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    storage: {
      from() {
        return {
          async list(prefix: string) {
            if (opts.failListWith) {
              return { data: null, error: { message: opts.failListWith } };
            }
            if (opts.listedSizes) {
              return {
                data: Object.entries(opts.listedSizes).map(([name, size]) => ({
                  name,
                  metadata: { size },
                })),
                error: null,
              };
            }
            const data = Object.entries(files)
              .filter(([p]) => p.startsWith(`${prefix}/`))
              .map(([p, buf]) => ({
                name: p.slice(prefix.length + 1),
                metadata: { size: buf.byteLength },
              }))
              .filter((o) => !o.name.includes("/"));
            return { data, error: null };
          },
          async download(objectPath: string) {
            requested.push(objectPath);
            if (opts.failDownloadWith) {
              return { data: null, error: { message: opts.failDownloadWith } };
            }
            const buf = files[objectPath];
            if (!buf) return { data: null, error: { message: "Object not found" } };
            return {
              data: {
                arrayBuffer: async () => {
                  const ab = new ArrayBuffer(buf.byteLength);
                  new Uint8Array(ab).set(buf);
                  return ab;
                },
              },
              error: null,
            };
          },
        };
      },
    },
  };
}

async function tmpWorkDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "attach-test-"));
}

function job(attachments: AttachmentMeta[]): Pick<
  ResearchJob,
  "id" | "organization_id" | "topic_slug" | "attachments"
> {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    organization_id: ORG,
    topic_slug: SLUG,
    attachments,
  };
}

// ── 1. sniffAttachment matrix ───────────────────────────────────────

test("sniff: real %PDF- accepted as application/pdf", () => {
  assert.equal(sniffAttachment(PDF_BYTES, "application/pdf").ok, true);
});

test("sniff: ZIP bytes declared as PDF rejected (missing %PDF- header)", () => {
  const r = sniffAttachment(ZIP_BYTES, "application/pdf");
  assert.equal(r.ok, false);
  assert.match(r.reason!, /%PDF-/);
});

test("sniff: empty buffer declared as PDF rejected", () => {
  assert.equal(sniffAttachment(Buffer.alloc(0), "application/pdf").ok, false);
});

test("sniff: valid markdown accepted as text/markdown", () => {
  assert.equal(sniffAttachment(MD_BYTES, "text/markdown").ok, true);
});

test("sniff: plain ascii accepted as text/plain", () => {
  assert.equal(sniffAttachment(Buffer.from("hello world\n"), "text/plain").ok, true);
});

test("sniff: NUL byte in declared text rejected", () => {
  const r = sniffAttachment(Buffer.from("abc\0def"), "text/plain");
  assert.equal(r.ok, false);
  assert.match(r.reason!, /NUL/);
});

test("sniff: PDF magic in declared text rejected", () => {
  assert.equal(sniffAttachment(PDF_BYTES, "text/plain").ok, false);
});

test("sniff: ZIP magic in declared text rejected (docx-renamed-.txt class)", () => {
  const r = sniffAttachment(ZIP_BYTES, "text/markdown");
  assert.equal(r.ok, false);
  assert.match(r.reason!, /ZIP/);
});

test("sniff: ELF magic in declared text rejected", () => {
  assert.equal(sniffAttachment(ELF_BYTES, "text/plain").ok, false);
});

test("sniff: PE/MZ magic in declared text rejected", () => {
  const r = sniffAttachment(PE_BYTES, "text/plain");
  assert.equal(r.ok, false);
  assert.match(r.reason!, /MZ/);
});

test("sniff: invalid UTF-8 in declared text rejected", () => {
  // 0xC3 expects a continuation byte; 0x28 is not one.
  const r = sniffAttachment(Buffer.from([0x61, 0xc3, 0x28, 0x62]), "text/plain");
  assert.equal(r.ok, false);
  assert.match(r.reason!, /UTF-8/);
});

test("sniff: empty buffer accepted as text (harmless)", () => {
  assert.equal(sniffAttachment(Buffer.alloc(0), "text/plain").ok, true);
});

// ── 2. downloadAttachments skip policy ──────────────────────────────

test("download: happy path writes verified file to <workDir>/sources/", async () => {
  const workDir = await tmpWorkDir();
  const m = meta();
  const sb = mockSb({ [`${ORG}/${SLUG}/sources/report.pdf`]: PDF_BYTES });

  const result = await downloadAttachments(sb, job([m]), workDir);

  assert.equal(result.downloaded.length, 1);
  assert.equal(result.skipped.length, 0);
  const written = await fs.readFile(path.join(workDir, "sources", "report.pdf"));
  assert.ok(written.equals(PDF_BYTES));
  assert.deepEqual(sb.requested, [`${ORG}/${SLUG}/sources/report.pdf`]);
});

test("download: empty attachments → empty result, no calls", async () => {
  const workDir = await tmpWorkDir();
  const sb = mockSb({});
  const result = await downloadAttachments(sb, job([]), workDir);
  assert.deepEqual(result, { downloaded: [], skipped: [] });
  assert.equal(sb.requested.length, 0);
});

test("download: storage error → skip-and-record, job continues", async () => {
  const workDir = await tmpWorkDir();
  const m = meta();
  const sb = mockSb(
    {},
    {
      failDownloadWith: "service unavailable",
      listedSizes: { "report.pdf": m.sizeBytes },
    },
  );
  const result = await downloadAttachments(sb, job([m]), workDir);
  assert.equal(result.downloaded.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /download failed/);
});

test("download: pre-download gate — listed storage size ≠ declared → skipped WITHOUT download (OOM guard)", async () => {
  const workDir = await tmpWorkDir();
  const m = meta({ sizeBytes: 100 });
  // Storage object claims to be huge — must be rejected before download().
  const sb = mockSb({}, { listedSizes: { "report.pdf": 5_000_000_000 } });
  const result = await downloadAttachments(sb, job([m]), workDir);
  assert.equal(result.downloaded.length, 0);
  assert.match(result.skipped[0].reason, /storage size mismatch before download/);
  assert.equal(sb.requested.length, 0, "oversized object must never be downloaded");
});

test("download: pre-download gate — object missing from sources/ listing → skipped without download", async () => {
  const workDir = await tmpWorkDir();
  const sb = mockSb({}, { listedSizes: {} });
  const result = await downloadAttachments(sb, job([meta()]), workDir);
  assert.match(result.skipped[0].reason, /not present in sources\/ listing/);
  assert.equal(sb.requested.length, 0);
});

test("download: list failure → ALL skipped fail-closed, never throws", async () => {
  const workDir = await tmpWorkDir();
  const sb = mockSb({}, { failListWith: "503" });
  const result = await downloadAttachments(sb, job([meta()]), workDir);
  assert.equal(result.downloaded.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /could not list sources/);
  assert.equal(sb.requested.length, 0);
});

test("download: post-download size mismatch (listing lied) → skipped", async () => {
  const workDir = await tmpWorkDir();
  const m = meta({ sizeBytes: PDF_BYTES.length + 10 });
  // Listing agrees with the declared size but the actual bytes differ —
  // belt-and-braces second check must catch it.
  const sb = mockSb(
    { [`${ORG}/${SLUG}/sources/report.pdf`]: PDF_BYTES },
    { listedSizes: { "report.pdf": PDF_BYTES.length + 10 } },
  );
  const result = await downloadAttachments(sb, job([m]), workDir);
  assert.equal(result.downloaded.length, 0);
  assert.match(result.skipped[0].reason, /size mismatch: declared/);
});

test("download: sniff rejection (ZIP bytes under .pdf name) → skipped, not written", async () => {
  const workDir = await tmpWorkDir();
  const m = meta({ sizeBytes: ZIP_BYTES.length });
  const sb = mockSb({ [`${ORG}/${SLUG}/sources/report.pdf`]: ZIP_BYTES });
  const result = await downloadAttachments(sb, job([m]), workDir);
  assert.equal(result.downloaded.length, 0);
  assert.match(result.skipped[0].reason, /sniff rejected/);
  await assert.rejects(fs.access(path.join(workDir, "sources", "report.pdf")));
});

test("download: invalid storedName (traversal) → skipped via path-helper throw", async () => {
  const workDir = await tmpWorkDir();
  const m = meta({ storedName: "..evil.pdf" });
  const sb = mockSb({});
  const result = await downloadAttachments(sb, job([m]), workDir);
  assert.equal(result.downloaded.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(sb.requested.length, 0, "must not hit storage with a bad name");
});

test("download: reserved Windows basename → skipped", async () => {
  const workDir = await tmpWorkDir();
  const m = meta({ storedName: "con.pdf" });
  const sb = mockSb({});
  const result = await downloadAttachments(sb, job([m]), workDir);
  assert.equal(result.skipped.length, 1);
  assert.equal(sb.requested.length, 0);
});

test("download: duplicate storedName → second entry skipped (S105 collision class)", async () => {
  const workDir = await tmpWorkDir();
  const sb = mockSb({ [`${ORG}/${SLUG}/sources/report.pdf`]: PDF_BYTES });
  const result = await downloadAttachments(sb, job([meta(), meta()]), workDir);
  assert.equal(result.downloaded.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /duplicate storedName/);
});

test("download: declared size above per-file cap → skipped without download", async () => {
  const workDir = await tmpWorkDir();
  const m = meta({ sizeBytes: ATTACHMENTS.max_file_bytes + 1 });
  const sb = mockSb({});
  const result = await downloadAttachments(sb, job([m]), workDir);
  assert.match(result.skipped[0].reason, /per-file cap/);
  assert.equal(sb.requested.length, 0);
});

test("download: entries beyond max_files cap → skipped", async () => {
  const workDir = await tmpWorkDir();
  const files: Record<string, Buffer> = {};
  const metas: AttachmentMeta[] = [];
  for (let i = 0; i < ATTACHMENTS.max_files + 2; i++) {
    const name = `f${i}.md`;
    metas.push(
      meta({ storedName: name, contentType: "text/markdown", sizeBytes: MD_BYTES.length }),
    );
    files[`${ORG}/${SLUG}/sources/${name}`] = MD_BYTES;
  }
  const result = await downloadAttachments(mockSb(files), job(metas), workDir);
  assert.equal(result.downloaded.length, ATTACHMENTS.max_files);
  assert.equal(result.skipped.length, 2);
  for (const s of result.skipped) assert.match(s.reason, /max_files/);
});

test("download: running total cap enforced across files", async () => {
  const workDir = await tmpWorkDir();
  // Three files at exactly the per-file cap exceed max_total_bytes on #3
  // (3 × 15 MiB = 45 MiB > 40 MiB).
  const big = Buffer.alloc(ATTACHMENTS.max_file_bytes, 0x61); // 'a' — valid text
  const files: Record<string, Buffer> = {};
  const metas: AttachmentMeta[] = [];
  for (let i = 0; i < 3; i++) {
    const name = `big${i}.txt`;
    metas.push(
      meta({ storedName: name, contentType: "text/plain", sizeBytes: big.length }),
    );
    files[`${ORG}/${SLUG}/sources/${name}`] = big;
  }
  const result = await downloadAttachments(mockSb(files), job(metas), workDir);
  assert.equal(result.downloaded.length, 2);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /total size cap/);
});

test("download: stale files from a prior attempt are WIPED before intake (Codex BLOCKING #1)", async () => {
  const workDir = await tmpWorkDir();
  const sourcesDir = path.join(workDir, "sources");
  await fs.mkdir(sourcesDir, { recursive: true });
  await fs.writeFile(path.join(sourcesDir, "stale-from-last-run.pdf"), PDF_BYTES);

  const m = meta();
  const sb = mockSb({ [`${ORG}/${SLUG}/sources/report.pdf`]: PDF_BYTES });
  const result = await downloadAttachments(sb, job([m]), workDir);

  assert.equal(result.downloaded.length, 1);
  const names = await fs.readdir(sourcesDir);
  assert.deepEqual(names.sort(), ["report.pdf"], "stale file must not survive intake");
});

test("download: forged contentType not in allowlist → skipped (Codex MAJOR #2)", async () => {
  const workDir = await tmpWorkDir();
  const m = meta({ contentType: "application/zip" as AttachmentMeta["contentType"] });
  const sb = mockSb({});
  const result = await downloadAttachments(sb, job([m]), workDir);
  assert.match(result.skipped[0].reason, /contentType .* not allowed/);
  assert.equal(sb.requested.length, 0);
});

test("download: extension/contentType mismatch → skipped (Codex MAJOR #2)", async () => {
  const workDir = await tmpWorkDir();
  // .pdf name claiming to be text — the sniffer would otherwise accept
  // UTF-8 bytes and write them under a .pdf extension.
  const m = meta({ storedName: "payload.pdf", contentType: "text/plain" });
  const sb = mockSb({});
  const result = await downloadAttachments(sb, job([m]), workDir);
  assert.match(result.skipped[0].reason, /does not match contentType/);
  assert.equal(sb.requested.length, 0);
});

test("download: malformed sizeBytes / oversize originalName → skipped (Codex MAJOR #2)", async () => {
  const workDir = await tmpWorkDir();
  const bad = [
    meta({ sizeBytes: 0 }),
    meta({ sizeBytes: -5, storedName: "b.pdf" }),
    meta({ sizeBytes: 10.5, storedName: "c.pdf" }),
    meta({ originalName: "x".repeat(300), storedName: "d.pdf" }),
  ];
  const sb = mockSb({});
  const result = await downloadAttachments(sb, job(bad), workDir);
  assert.equal(result.downloaded.length, 0);
  assert.equal(result.skipped.length, 4);
  for (const s of result.skipped) assert.match(s.reason, /malformed meta/);
  assert.equal(sb.requested.length, 0);
});

test("download: never throws even when every entry is hostile", async () => {
  const workDir = await tmpWorkDir();
  const hostile = [
    meta({ storedName: "../../etc/passwd.pdf" }),
    meta({ storedName: "a/b.pdf" }),
    meta({ storedName: "nul.txt", contentType: "text/plain" }),
    meta({ storedName: ".hidden.pdf" }),
  ];
  const result = await downloadAttachments(mockSb({}), job(hostile), workDir);
  assert.equal(result.downloaded.length, 0);
  assert.equal(result.skipped.length, hostile.length);
});

// ── Audit 2026-06-11 A6/A20 — non-object array elements ────────────────
// The DB CHECK only guarantees jsonb_typeof='array', so a forged row can
// hold attachments='[null, {...valid...}]'. These must SKIP-AND-RECORD,
// never TypeError out of the never-throws contract (which used to hard-fail
// the whole job via the executor's guard catch + buildManifest dereference).

test("validateAttachmentMeta: non-object elements return a reason, never throw (A6/A20)", () => {
  for (const junk of [null, undefined, "report.pdf", 42, true, ["nested"]]) {
    const reason = validateAttachmentMeta(junk);
    assert.match(reason ?? "", /not an object/, `expected object-reject for ${String(junk)}`);
  }
});

test("asMetaOrNull: null for non-objects, identity for objects (A6/A20)", () => {
  assert.equal(asMetaOrNull(null), null);
  assert.equal(asMetaOrNull("x"), null);
  assert.equal(asMetaOrNull(7), null);
  assert.equal(asMetaOrNull(["a"]), null);
  const m = meta();
  assert.equal(asMetaOrNull(m), m);
});

test("download: null element skipped-and-recorded, valid sibling still downloads (A6/A20)", async () => {
  const workDir = await tmpWorkDir();
  const m = meta();
  const sb = mockSb({ [`${ORG}/${SLUG}/sources/report.pdf`]: PDF_BYTES });
  const logs: string[] = [];

  const result = await downloadAttachments(
    sb,
    job([null as unknown as AttachmentMeta, m]),
    workDir,
    (msg) => logs.push(msg),
  );

  assert.equal(result.downloaded.length, 1, "valid sibling must survive the null element");
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].meta, null);
  assert.match(result.skipped[0].reason, /not an object/);
  // The final log loop dereferenced s.meta.storedName pre-fix — must now
  // print the placeholder instead of throwing.
  assert.ok(
    logs.some((l) => l.includes("<malformed element>")),
    `expected placeholder in skip log, got: ${logs.join(" | ")}`,
  );
  const written = await fs.readFile(path.join(workDir, "sources", "report.pdf"));
  assert.ok(written.equals(PDF_BYTES));
});

test("download: null element past the max_files cap also safe (A6/A20 second instance)", async () => {
  const workDir = await tmpWorkDir();
  // max_files valid-shaped entries, then a null at an index >= the cap —
  // the cap branch pushes the RAW element into skipped before validation
  // ever runs, so it must normalize too.
  const metas = Array.from({ length: ATTACHMENTS.max_files }, (_, i) =>
    meta({ storedName: `f${i}.pdf` }),
  );
  metas.push(null as unknown as AttachmentMeta);
  const result = await downloadAttachments(mockSb({}), job(metas), workDir);
  const capSkip = result.skipped.find((s) => /max_files cap/.test(s.reason));
  assert.ok(capSkip, "null element must be recorded against the cap");
  assert.equal(capSkip.meta, null);
});

test("manifest: skipped entry with meta:null carries placeholders, never throws (A6/A20)", () => {
  const manifest = buildManifest(fullJob([meta()]), {
    downloaded: [],
    skipped: [{ meta: null, reason: "malformed meta: element is not an object" }],
  });
  const uc = manifest.userContext as Record<string, unknown>;
  assert.deepEqual(uc.attachmentsSkipped, [
    {
      originalName: "<malformed element>",
      storedName: "<malformed element>",
      reason: "malformed meta: element is not an object",
    },
  ]);
});

// ── 3 + 4. buildManifest / buildPrompt assertions ───────────────────

function fullJob(attachments: AttachmentMeta[] = []): ResearchJob {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    created_at: "2026-06-11T00:00:00.000Z",
    updated_at: "2026-06-11T00:00:00.000Z",
    status: "running",
    claimed_at: null,
    completed_at: null,
    error_message: null,
    topic: "test topic",
    topic_slug: SLUG,
    user_context: {
      domainKnowledge: [],
      constraints: [],
      additionalUrls: [],
      claimsToVerify: [],
    },
    vendor_evaluation: {
      enabled: false,
      vendorType: "",
      serviceArea: "",
      serviceAddress: "",
      jobDescription: "",
      maxVendorsDiscovered: 10,
      maxVendorsEnriched: 5,
    },
    aji_dna_enabled: false,
    selected_products: {
      audio: false,
      video: false,
      slides: false,
      report: true,
      infographic: false,
    },
    customizations: {
      perplexity: { queryFraming: "", emphasis: [], outputStructure: "" },
      notebookLM: { persona: "", researchMode: "deep", priorities: [] },
      studio: {},
    },
    notify_email: null,
    current_phase: "Preflight",
    phase_status: "queued",
    progress_pct: 0,
    estimated_minutes: null,
    result_slug: null,
    organization_id: ORG,
    attachments,
  };
}

test("manifest: localSourcePath + attachments set when files downloaded", () => {
  const m = meta();
  // workDir is passed explicitly (S106 Gemini finding 1) — localSourcePath
  // must equal <workDir>/<sources_subdir> EXACTLY, not a re-derived path.
  const workDir = path.join("C:/tmp/research-compare", SLUG);
  const manifest = buildManifest(
    fullJob([m]),
    {
      downloaded: [m],
      skipped: [{ meta: meta({ storedName: "bad.txt" }), reason: "sniff rejected: x" }],
    },
    workDir,
  );
  const uc = manifest.userContext as Record<string, unknown>;
  assert.equal(
    uc.localSourcePath,
    path.join(workDir, "sources"),
    `localSourcePath must be exactly <workDir>/sources, got ${uc.localSourcePath}`,
  );
  assert.deepEqual(uc.attachments, [m]);
  assert.deepEqual(uc.attachmentsSkipped, [
    { originalName: "Report.pdf", storedName: "bad.txt", reason: "sniff rejected: x" },
  ]);
  assert.deepEqual(uc.attachmentsPolicy, {
    maxPagesReadPerPdf: ATTACHMENTS.max_pages_read_per_pdf,
    maxDigestWordsPerFile: ATTACHMENTS.max_digest_words_per_file,
  });
});

test("manifest: localSourcePath null when nothing downloaded (incl. all-skipped)", () => {
  const noResult = buildManifest(fullJob());
  assert.equal((noResult.userContext as Record<string, unknown>).localSourcePath, null);

  const allSkipped = buildManifest(fullJob([meta()]), {
    downloaded: [],
    skipped: [{ meta: meta(), reason: "download failed: x" }],
  });
  const uc = allSkipped.userContext as Record<string, unknown>;
  assert.equal(uc.localSourcePath, null);
  assert.equal((uc.attachmentsSkipped as unknown[]).length, 1);
});

test("prompt: fenced attachments block + ./sources/ directive present iff downloaded", () => {
  const m = meta();
  const withAtt = buildPrompt(fullJob([m]), "C:/tmp/x/job-manifest.json", {
    downloaded: [m],
    skipped: [],
  });
  assert.ok(withAtt.includes('<untrusted_input type="attachments">'));
  assert.ok(withAtt.includes("./sources/"));
  assert.ok(withAtt.includes(String(ATTACHMENTS.max_pages_read_per_pdf)));
  assert.ok(withAtt.includes(String(ATTACHMENTS.max_digest_words_per_file)));

  const without = buildPrompt(fullJob(), "C:/tmp/x/job-manifest.json", {
    downloaded: [],
    skipped: [],
  });
  assert.ok(!without.includes('<untrusted_input type="attachments">'));
  assert.ok(!without.includes("./sources/"));

  const omitted = buildPrompt(fullJob(), "C:/tmp/x/job-manifest.json");
  assert.ok(!omitted.includes("./sources/"));
});

test("prompt: skipped-count note appears when some files were skipped", () => {
  const m = meta();
  const p = buildPrompt(fullJob([m]), "C:/tmp/x/job-manifest.json", {
    downloaded: [m],
    skipped: [{ meta: meta({ storedName: "bad.txt" }), reason: "sniff" }],
  });
  assert.match(p, /1 additional attachment\(s\) were skipped/);
});
