/**
 * S87 — tests for the shared state-file selector (newest-wins) that replaced
 * the first-match-in-readdir-order logic which false-failed e18e1931.
 *
 * Recency = the run timestamp EMBEDDED in the filename ("<ts>-state.json").
 * Selection BUCKETS by name shape (Codex MERGE MAJOR): if any candidate is
 * timestamped, only those are ranked (by embedded time); fs mtime / storage
 * created_at is the fallback ONLY when no candidate is timestamped — so the
 * embedded wall-clock is never compared against an epoch fallback across clocks.
 *
 * Run: pnpm -C agent exec node --import=tsx --test test/find-state-file.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  isStateFileName,
  embeddedStateTimestampMs,
  selectNewestStateFile,
  findStateFile,
  archiveStaleStateFiles,
  SUPERSEDED_STATE_DIR,
} from "../lib/find-state-file.js";

describe("isStateFileName", () => {
  test("matches plain and prefixed state files", () => {
    assert.equal(isStateFileName("state.json"), true);
    assert.equal(isStateFileName("20260603-215929-state.json"), true);
    assert.equal(isStateFileName("i-am-looking-for-a-name-state.json"), true);
  });
  test("rejects non-state files", () => {
    assert.equal(isStateFileName("brief.md"), false);
    assert.equal(isStateFileName("state.json.bak"), false);
    assert.equal(isStateFileName("statexjson"), false);
    assert.equal(isStateFileName(""), false);
  });
});

describe("embeddedStateTimestampMs", () => {
  test("parses an anchored <YYYYMMDD>-<HHMMSS>-state.json prefix", () => {
    assert.equal(
      embeddedStateTimestampMs("20260603-215929-state.json"),
      Date.UTC(2026, 5, 3, 21, 59, 29),
    );
    assert.ok(
      embeddedStateTimestampMs("20260603-215929-state.json")! >
        embeddedStateTimestampMs("20260602-185318-state.json")!,
    );
  });
  test("returns null for plain and slug-named state files", () => {
    assert.equal(embeddedStateTimestampMs("state.json"), null);
    assert.equal(embeddedStateTimestampMs("i-am-looking-state.json"), null);
  });
  test("is start-anchored: a slug ending in digits is NOT timestamped (Codex MINOR)", () => {
    assert.equal(embeddedStateTimestampMs("my-topic-20260603-215929-state.json"), null);
  });
  test("rejects calendar values Date.UTC would silently roll over", () => {
    assert.equal(embeddedStateTimestampMs("20261305-120000-state.json"), null); // month 13
    assert.equal(embeddedStateTimestampMs("20260632-120000-state.json"), null); // day 32
    assert.equal(embeddedStateTimestampMs("20260603-256000-state.json"), null); // hour 25
  });
});

describe("selectNewestStateFile", () => {
  test("returns null for no candidates", () => {
    assert.equal(selectNewestStateFile([]), null);
  });

  test("returns the single candidate", () => {
    const only = { name: "state.json", fallbackTimeMs: 5 };
    assert.deepEqual(selectNewestStateFile([only]), only);
  });

  test("all timestamped: EMBEDDED time decides, inverted fallback ignored (Gemini C2)", () => {
    const stale = { name: "20260602-185318-state.json", fallbackTimeMs: 9_000_000_000_000 };
    const fresh = { name: "20260603-215929-state.json", fallbackTimeMs: 1 };
    assert.equal(selectNewestStateFile([stale, fresh])?.name, fresh.name);
    assert.equal(selectNewestStateFile([fresh, stale])?.name, fresh.name);
  });

  test("no timestamped candidate: fall back to provided time", () => {
    const older = { name: "a-state.json", fallbackTimeMs: 100 };
    const newer = { name: "b-state.json", fallbackTimeMs: 200 };
    assert.deepEqual(selectNewestStateFile([older, newer]), newer);
    assert.deepEqual(selectNewestStateFile([newer, older]), newer);
  });

  test("no timestamped, equal fallback: lexicographically-greater name wins", () => {
    const a = { name: "a-state.json", fallbackTimeMs: 50 };
    const b = { name: "b-state.json", fallbackTimeMs: 50 };
    assert.equal(selectNewestStateFile([a, b])?.name, b.name);
    assert.equal(selectNewestStateFile([b, a])?.name, b.name);
  });

  test("MIXED: a timestamped candidate is authoritative over a plain one — no cross-clock compare (Codex MAJOR)", () => {
    // Even with a huge fallback time on the plain file, bucketing ranks only
    // the timestamped candidate(s); the plain fallback is never compared.
    const plain = { name: "state.json", fallbackTimeMs: 9_000_000_000_000 };
    const ts = { name: "20260603-215929-state.json", fallbackTimeMs: 0 };
    assert.equal(selectNewestStateFile([plain, ts])?.name, ts.name);
    assert.equal(selectNewestStateFile([ts, plain])?.name, ts.name);
  });
});

describe("findStateFile (local fs)", () => {
  async function tmpdir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), "fsf-"));
  }
  async function writeAt(dir: string, name: string, body: string, mtime: Date): Promise<void> {
    const p = path.join(dir, name);
    await fs.writeFile(p, body, "utf-8");
    await fs.utimes(p, mtime, mtime);
  }

  test("returns null on an empty dir", async () => {
    const dir = await tmpdir();
    assert.equal(await findStateFile(dir), null);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("returns null when no state files present", async () => {
    const dir = await tmpdir();
    await writeAt(dir, "brief.md", "x", new Date("2026-06-03T00:00:00Z"));
    assert.equal(await findStateFile(dir), null);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("finds a single plain state.json", async () => {
    const dir = await tmpdir();
    await writeAt(dir, "state.json", "{}", new Date("2026-06-03T00:00:00Z"));
    assert.equal(await findStateFile(dir), path.join(dir, "state.json"));
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("REPRODUCTION: e18e1931 — fresh phase-6 wins even with an OLDER mtime", async () => {
    // Both timestamped, mtimes INVERTED (stale 6/2 given the newer mtime) to
    // prove the embedded run timestamp, not mtime, decides.
    const dir = await tmpdir();
    await writeAt(dir, "20260602-185318-state.json",
      JSON.stringify({ phase: "0" }), new Date("2026-06-09T00:00:00Z"));
    await writeAt(dir, "20260603-215929-state.json",
      JSON.stringify({ phase: "6" }), new Date("2026-06-03T21:59:29Z"));
    const picked = await findStateFile(dir);
    assert.equal(picked, path.join(dir, "20260603-215929-state.json"));
    assert.equal(JSON.parse(await fs.readFile(picked!, "utf-8")).phase, "6");
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("MIXED: a stale plain state.json does not shadow the fresh timestamped run", async () => {
    const dir = await tmpdir();
    await writeAt(dir, "state.json", JSON.stringify({ phase: "0" }), new Date("2026-06-03T00:00:00Z"));
    await writeAt(dir, "20260603-215929-state.json", JSON.stringify({ phase: "6" }), new Date("2026-06-03T22:00:00Z"));
    assert.equal(await findStateFile(dir), path.join(dir, "20260603-215929-state.json"));
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("picks newest among three timestamped files by embedded time (mtimes equal)", async () => {
    const dir = await tmpdir();
    const t = new Date("2026-06-10T00:00:00Z");
    await writeAt(dir, "20260601-100000-state.json", "{}", t);
    await writeAt(dir, "20260604-100000-state.json", "{}", t);
    await writeAt(dir, "20260602-100000-state.json", "{}", t);
    assert.equal(await findStateFile(dir), path.join(dir, "20260604-100000-state.json"));
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("archiveStaleStateFiles (S117 stale-terminal-state fail-open)", () => {
  async function tmpdir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), "asf-"));
  }

  test("absent workdir (ENOENT) → no-op, returns []", async () => {
    const missing = path.join(os.tmpdir(), "asf-does-not-exist-xyz");
    assert.deepEqual(await archiveStaleStateFiles(missing), []);
  });

  test("non-ENOENT readdir error rethrows → caller fails CLOSED (Codex S117)", async () => {
    // A workDir path that is actually a FILE makes fs.readdir throw ENOTDIR,
    // not ENOENT. Swallowing it would leave a possibly-stale passing manifest
    // un-archived (fail-open); the helper MUST rethrow so executeJob can fail
    // the job closed.
    const dir = await tmpdir();
    const notADir = path.join(dir, "iam-a-file");
    await fs.writeFile(notADir, "x", "utf-8");
    await assert.rejects(
      archiveStaleStateFiles(notADir),
      (err: NodeJS.ErrnoException) => err.code !== "ENOENT",
    );
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("no state candidates → no-op, no archive dir created", async () => {
    const dir = await tmpdir();
    await fs.writeFile(path.join(dir, "brief.md"), "x", "utf-8");
    assert.deepEqual(await archiveStaleStateFiles(dir), []);
    await assert.rejects(fs.stat(path.join(dir, SUPERSEDED_STATE_DIR)));
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("the core fail-open: a stale PASSING manifest is removed from selection", async () => {
    // Reproduces the hazard: a prior attempt's terminal+passing state.json
    // remains in a reused workdir. After archiving, findStateFile() returns
    // null, so the executor's "no state.json was written" guard fails CLOSED
    // instead of the gate publish-clearing the stale manifest.
    const dir = await tmpdir();
    await fs.writeFile(
      path.join(dir, "20260612-235959-state.json"),
      JSON.stringify({ phase: "complete", publish_verification: { verification_status: "passed" } }),
      "utf-8",
    );
    const archived = await archiveStaleStateFiles(dir);
    assert.deepEqual(archived, ["20260612-235959-state.json"]);
    assert.equal(await findStateFile(dir), null);
    // forensics preserved (renamed, not deleted)
    const moved = await fs.readdir(path.join(dir, SUPERSEDED_STATE_DIR));
    assert.deepEqual(moved, ["0-20260612-235959-state.json"]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("archives both plain and prefixed candidates, leaves non-state files", async () => {
    const dir = await tmpdir();
    await fs.writeFile(path.join(dir, "state.json"), "{}", "utf-8");
    await fs.writeFile(path.join(dir, "20260601-100000-state.json"), "{}", "utf-8");
    await fs.writeFile(path.join(dir, "research-plan.json"), "{}", "utf-8");
    const archived = await archiveStaleStateFiles(dir);
    assert.equal(archived.length, 2);
    assert.ok(archived.includes("state.json"));
    assert.ok(archived.includes("20260601-100000-state.json"));
    // non-state file untouched; findStateFile sees nothing in root
    assert.ok((await fs.readdir(dir)).includes("research-plan.json"));
    assert.equal(await findStateFile(dir), null);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("idempotent + collision-safe across repeated re-queues (monotonic index)", async () => {
    const dir = await tmpdir();
    // first re-queue leaves a state file
    await fs.writeFile(path.join(dir, "state.json"), "{}", "utf-8");
    await archiveStaleStateFiles(dir);
    // second re-queue leaves another state file of the SAME name
    await fs.writeFile(path.join(dir, "state.json"), "{}", "utf-8");
    await archiveStaleStateFiles(dir);
    const moved = (await fs.readdir(path.join(dir, SUPERSEDED_STATE_DIR))).sort();
    assert.deepEqual(moved, ["0-state.json", "1-state.json"]);
    // a third call with nothing to archive is a clean no-op
    assert.deepEqual(await archiveStaleStateFiles(dir), []);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
