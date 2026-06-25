/**
 * S160 — sensitive regression test for C-A.
 *
 * S158 widened realDownloadArtifact's return from Promise<boolean> to
 * Promise<DownloadResult> ({ ok, exitCode?, signal?, stderr? }). The UNCHANGED
 * consumer in regenerate-studio-products.ts (the studio_only regen pipeline)
 * still did `const ok = await realDownloadArtifact(...); if (!ok)` — but `!object`
 * is ALWAYS false, so the download-failure guard was DEAD CODE: a failed/truncated
 * download fell through and (in prod) uploaded as success. tsc accepts `!object`
 * (legal boolean coercion), so this compiled clean and shipped untested.
 *
 * This test injects a FAILING download and asserts downloadAndUpload returns
 * {ok:false} with the stderr surfaced. On the BUG version the dead guard lets
 * execution fall through to fs.readFile(namedLocal) on a file that was never
 * written → the call REJECTS instead of resolving {ok:false} → this test fails.
 *
 * Run: pnpm -C agent exec node --import=tsx --test test/regenerate-studio-products.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { downloadAndUpload } from "../scripts/regenerate-studio-products.js";
import type { DownloadResult } from "../lib/nlm-artifact-cli.js";

const TASK = { product: "video", cliType: "video" };
const ARTIFACT = { id: "vid-1", title: "X", created_at: "2026-06-15T19:34:36" };
// sb is never reached on the download-failure path (the guard returns first).
const FAKE_SB = {} as never;
const TS = "20260615-190502";

describe("downloadAndUpload — C-A download-failure guard", () => {
  test("a FAILED download returns {ok:false} (dead-guard regression) and surfaces stderr", async () => {
    const downloadArtifact = async (): Promise<DownloadResult> => ({
      ok: false,
      exitCode: 1,
      signal: null,
      stderr: "HTTP 503 transient",
    });
    const r = await downloadAndUpload(TASK, ARTIFACT, FAKE_SB, TS, { downloadArtifact });
    assert.equal(r.ok, false, "a failed download must not report success");
    assert.equal(r.remoteName, undefined, "no remoteName on a failed download");
    assert.match(
      String(r.reason),
      /download of artifact vid-1 failed/,
      "reason names the failed artifact",
    );
    assert.match(String(r.reason), /HTTP 503 transient/, "captured stderr is surfaced in the reason");
  });

  test("an unknown product (no ext) is rejected before any download", async () => {
    let called = false;
    const downloadArtifact = async (): Promise<DownloadResult> => {
      called = true;
      return { ok: true };
    };
    const r = await downloadAndUpload(
      { product: "not-a-product", cliType: "video" },
      ARTIFACT,
      FAKE_SB,
      TS,
      { downloadArtifact },
    );
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /unknown product/);
    assert.equal(called, false, "no download attempted for an unknown product");
  });
});
