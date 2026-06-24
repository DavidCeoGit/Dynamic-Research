/**
 * S88 MERGE-B — uploadOutputs upload-hygiene.
 *
 * Pure-core tests for selectUploadSet() + IO-loop tests for uploadOutputs()
 * via an injected uploader (no live Supabase). Covers: stale/scratch exclusion,
 * non-file (subdir) exclusion, empty / all-excluded → [], upsert:true on every
 * call, re-queue idempotency, and the caller-relevant `selected===0` signal.
 *
 * Design record: Documentation/uploadoutputs-upload-hygiene-design-gate.md.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { selectUploadSet, type UploadCandidate } from "../lib/upload-set.js";
import { uploadOutputs, type Uploader } from "../executor.js";
import type { ResearchJob } from "../types.js";

const file = (name: string): UploadCandidate => ({ name, isFile: true });
const dir = (name: string): UploadCandidate => ({ name, isFile: false });

// ── selectUploadSet (pure) ──────────────────────────────────────────

test("selectUploadSet: includes canonical slug/title-named deliverables incl. state.json", () => {
  const entries = [
    file("i-am-...-brief.md"),
    file("i-am-...-brief.docx"),
    file("i-am-...-comparison.md"),
    file("executive-strategy-report-...-20260603-215929-report.md"),
    file("i-am-...-audio.mp3"),
    file("i-am-...-slides.pdf"),
    file("i-am-...-state.json"), // state IS uploaded per conventions state_json_policy
  ];
  const got = selectUploadSet(entries).map((f) => f.remoteName);
  assert.deepEqual(got, entries.map((e) => e.name));
});

test("selectUploadSet: excludes skip-list scratch (exact / prefix / extension)", () => {
  const entries = [
    file("i-am-...-report.md"), // keep
    file("claude-prompt.md"), // exact skip
    file("job-manifest.json"), // exact skip
    file("add_perplexity_sources.py"), // .py ext skip
    file("instr-report.txt"), // instr- prefix skip
    file("nlm-research-query.txt"), // nlm- prefix skip
    file(".worker.pid"), // . prefix skip
  ];
  const got = selectUploadSet(entries).map((f) => f.remoteName);
  assert.deepEqual(got, ["i-am-...-report.md"]);
});

test("selectUploadSet: excludes leftover `.part` download temps (S161 R2-1)", () => {
  // Sensitivity: without `.part` on skip_files.extensions, isSkipFile() returns
  // false for the temp and it leaks into the upload set (→ the gallery).
  const entries = [
    file("some-title-20260615-190502-video.mp4"), // keep
    file("some-title-20260615-190502-video.mp4.part"), // orphan temp — skip
    file("some-title-20260615-190502-audio.mp3.part"), // orphan temp — skip
  ];
  const got = selectUploadSet(entries).map((f) => f.remoteName);
  assert.deepEqual(got, ["some-title-20260615-190502-video.mp4"]);
});

test("selectUploadSet: excludes non-files / subdirectories (Codex NIT)", () => {
  const entries = [file("i-am-...-report.md"), dir(".claude"), dir("subdir")];
  const got = selectUploadSet(entries).map((f) => f.remoteName);
  assert.deepEqual(got, ["i-am-...-report.md"]);
});

test("selectUploadSet: empty input → [] (tested precondition for empty-guard)", () => {
  assert.deepEqual(selectUploadSet([]), []);
});

test("selectUploadSet: all-excluded (skip + dirs only) → []", () => {
  const entries = [file("claude-prompt.md"), file("foo.py"), dir(".claude")];
  assert.deepEqual(selectUploadSet(entries), []);
});

// ── uploadOutputs (IO loop via injected uploader) ───────────────────

const JOB = {
  id: "test-job-id",
  topic_slug: "test-slug",
  organization_id: "test-org",
} as unknown as ResearchJob;

/** Mock uploader simulating real upsert semantics: a second write of the same
 * filename FAILS under upsert:false but SUCCEEDS under upsert:true. Records
 * each call so the test can assert the flag the loop actually passes. */
function makeStore() {
  const stored = new Set<string>();
  const calls: Array<{ filename: string; upsert: boolean }> = [];
  const uploader: Uploader = async (args) => {
    calls.push({ filename: args.filename, upsert: args.upsert });
    if (stored.has(args.filename) && !args.upsert) {
      return { ok: false, path: args.filename, reason: "conflict (exists, upsert:false)" };
    }
    stored.add(args.filename);
    return { ok: true, path: args.filename };
  };
  return { uploader, calls };
}

async function withTempProjectsDir(
  files: string[],
  fn: (projectsDir: string) => Promise<void>,
): Promise<void> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "uploadset-"));
  try {
    for (const f of files) await fs.writeFile(path.join(base, f), `content-of-${f}`);
    await fn(base);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

test("uploadOutputs: uploads selected deliverables with upsert:true", async () => {
  await withTempProjectsDir(
    ["report.md", "audio.mp3", "claude-prompt.md"], // last one skipped
    async (projectsDir) => {
      const { uploader, calls } = makeStore();
      const res = await uploadOutputs(JOB, projectsDir, uploader);
      assert.equal(res.selected, 2);
      assert.equal(res.uploaded, 2);
      assert.equal(res.failed.length, 0);
      assert.deepEqual(
        calls.map((c) => c.filename).sort(),
        ["audio.mp3", "report.md"],
      );
      assert.ok(calls.every((c) => c.upsert === true), "every upload must pass upsert:true");
    },
  );
});

test("uploadOutputs: re-queue is idempotent (upsert:true does not conflict-fail)", async () => {
  await withTempProjectsDir(["report.md", "comparison.md"], async (projectsDir) => {
    const { uploader } = makeStore();
    const first = await uploadOutputs(JOB, projectsDir, uploader);
    assert.equal(first.uploaded, 2);
    // Second run over the same store — files already exist. With the loop's
    // hardcoded upsert:true the mock returns ok; a regression to upsert:false
    // would make these conflict-fail.
    const second = await uploadOutputs(JOB, projectsDir, uploader);
    assert.equal(second.selected, 2);
    assert.equal(second.uploaded, 2);
    assert.equal(second.failed.length, 0);
  });
});

test("uploadOutputs: empty / all-skipped Projects dir → selected===0 (empty-guard signal)", async () => {
  await withTempProjectsDir(["claude-prompt.md", "helper.py"], async (projectsDir) => {
    const { uploader, calls } = makeStore();
    const res = await uploadOutputs(JOB, projectsDir, uploader);
    assert.equal(res.selected, 0);
    assert.equal(res.uploaded, 0);
    assert.equal(res.failed.length, 0);
    assert.equal(calls.length, 0, "no upload attempted when nothing is selectable");
  });
});

test("uploadOutputs: missing Projects dir → selected===0 (no throw)", async () => {
  const { uploader } = makeStore();
  const res = await uploadOutputs(JOB, path.join(os.tmpdir(), "does-not-exist-uploadset"), uploader);
  assert.equal(res.selected, 0);
  assert.equal(res.uploaded, 0);
});

test("uploadOutputs: a 0-byte deliverable is REFUSED as a failed upload (S161 R2-3 belt)", async () => {
  // Sensitivity: without the content.length===0 guard the empty buffer is uploaded
  // (uploaded=2, failed=0) and the job would complete — the exact fail-open R2-3
  // closes. The guard records it as failed so the executor's failed-upload hard-fail
  // catches it before completeJob.
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "uploadset-zero-"));
  try {
    await fs.writeFile(path.join(base, "report.md"), "real content");
    await fs.writeFile(path.join(base, "audio.mp3"), ""); // 0 bytes
    const { uploader, calls } = makeStore();
    const res = await uploadOutputs(JOB, base, uploader);
    assert.equal(res.selected, 2, "both files are selected (size is not a select-time filter)");
    assert.equal(res.uploaded, 1, "only the non-empty deliverable uploads");
    assert.equal(res.failed.length, 1, "the 0-byte deliverable is recorded as failed");
    assert.match(res.failed[0].reason, /zero-byte/i);
    assert.ok(!calls.some((c) => c.filename === "audio.mp3"), "the 0-byte file is never sent to storage");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
