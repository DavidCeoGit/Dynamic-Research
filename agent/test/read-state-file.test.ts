/**
 * Tests for readPipelineState() — the state.json read/parse outcome classifier
 * (audit 2026-06-24: distinguish transient IO vs corrupt vs absent so a poller
 * /recovery read no longer swallows a corrupt state file into silence).
 *
 * Branch coverage is via injected deps (deterministic, no real fs); a final
 * real-fs block proves the DEFAULT wiring (findStateFile + fs.readFile) works.
 * Several tests are sensitivity proofs (non-vacuous): they assert the helper
 * DISCRIMINATES (e.g. a valid object → ok while null/array/primitive → corrupt),
 * so removing the guard would flip a result and fail the test.
 *
 * Run: pnpm -C agent exec node --import=tsx --test test/read-state-file.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  readPipelineState,
  type ReadPipelineStateDeps,
} from "../lib/read-state-file.js";

/** Build deps with a stub findStateFile + readFile; either may be a value or a
 *  thrower. `readCalls` records whether readFile was invoked (used to prove
 *  short-circuit behavior). */
function makeDeps(opts: {
  findResult?: string | null;
  findThrows?: unknown;
  readResult?: string;
  readThrows?: unknown;
  readCalls?: { n: number };
}): ReadPipelineStateDeps {
  return {
    findStateFile: async () => {
      if (opts.findThrows !== undefined) throw opts.findThrows;
      return opts.findResult ?? null;
    },
    readFile: async () => {
      if (opts.readCalls) opts.readCalls.n++;
      if (opts.readThrows !== undefined) throw opts.readThrows;
      return opts.readResult ?? "";
    },
  };
}

describe("readPipelineState — ok", () => {
  test("located + read + parses to a JSON object → ok with state + path", async () => {
    const deps = makeDeps({
      findResult: "/work/20260624-120000-state.json",
      readResult: JSON.stringify({ phase: "5.5", phase_status: "running", notebook_id: "nb1" }),
    });
    const r = await readPipelineState("/work", deps);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return; // narrow
    assert.equal(r.state.phase, "5.5");
    assert.equal(r.state.phase_status, "running");
    assert.equal(r.state.notebook_id, "nb1");
    assert.equal(r.path, "/work/20260624-120000-state.json");
  });
});

describe("readPipelineState — absent", () => {
  test("findStateFile returns null → absent, and readFile is NOT called", async () => {
    const readCalls = { n: 0 };
    const deps = makeDeps({ findResult: null, readCalls });
    const r = await readPipelineState("/work", deps);
    assert.equal(r.kind, "absent");
    assert.equal(readCalls.n, 0, "absent must short-circuit before reading");
  });
});

describe("readPipelineState — io-error", () => {
  test("findStateFile (readdir) throws → io-error carrying the error, readFile NOT called", async () => {
    const readCalls = { n: 0 };
    const enoent = Object.assign(new Error("ENOENT: no such dir"), { code: "ENOENT" });
    const deps = makeDeps({ findThrows: enoent, readCalls });
    const r = await readPipelineState("/missing", deps);
    assert.equal(r.kind, "io-error");
    if (r.kind !== "io-error") return;
    assert.equal(r.error, enoent);
    assert.equal(readCalls.n, 0, "a find() throw must short-circuit before reading");
  });

  test("readFile throws (file located but unreadable) → io-error, NOT corrupt", async () => {
    const ebusy = Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
    const deps = makeDeps({ findResult: "/work/state.json", readThrows: ebusy });
    const r = await readPipelineState("/work", deps);
    assert.equal(r.kind, "io-error", "a read race is transient, not corruption");
    if (r.kind !== "io-error") return;
    assert.equal(r.error, ebusy);
  });
});

describe("readPipelineState — corrupt", () => {
  test("malformed JSON → corrupt with path + a parse error", async () => {
    const deps = makeDeps({ findResult: "/work/state.json", readResult: "{ not valid json" });
    const r = await readPipelineState("/work", deps);
    assert.equal(r.kind, "corrupt");
    if (r.kind !== "corrupt") return;
    assert.equal(r.path, "/work/state.json");
    assert.ok(r.error instanceof Error, "parse failure surfaces a real Error");
  });

  // Sensitivity proofs: valid JSON that is NOT a usable object must be corrupt,
  // not ok. If the non-object guard were removed, these would flip to "ok" and
  // a downstream `state.phase` access would throw — so each is non-vacuous.
  for (const [label, body] of [
    ["null", "null"],
    ["array", "[]"],
    ["number", "5"],
    ["string", '"done"'],
    ["boolean", "true"],
  ] as const) {
    test(`valid JSON ${label} (not an object) → corrupt`, async () => {
      const deps = makeDeps({ findResult: "/work/state.json", readResult: body });
      const r = await readPipelineState("/work", deps);
      assert.equal(r.kind, "corrupt", `${label} must NOT be classified ok`);
      if (r.kind !== "corrupt") return;
      assert.equal(r.path, "/work/state.json");
    });
  }

  test("discriminates: empty object {} is ok (proves the guard is not over-broad)", async () => {
    const deps = makeDeps({ findResult: "/work/state.json", readResult: "{}" });
    const r = await readPipelineState("/work", deps);
    assert.equal(r.kind, "ok", "an object — even empty — is a valid read outcome");
  });
});

describe("readPipelineState — real fs (default deps wiring)", () => {
  async function tmpdir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), "dr-readstate-"));
  }

  test("absent: empty workdir → absent", async () => {
    const dir = await tmpdir();
    try {
      const r = await readPipelineState(dir);
      assert.equal(r.kind, "absent");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("io-error: nonexistent workdir → io-error (readdir ENOENT)", async () => {
    const r = await readPipelineState(path.join(os.tmpdir(), "dr-readstate-does-not-exist-xyz"));
    assert.equal(r.kind, "io-error");
  });

  test("ok: real valid state.json → ok with parsed fields", async () => {
    const dir = await tmpdir();
    try {
      await fs.writeFile(
        path.join(dir, "state.json"),
        JSON.stringify({ phase: "7", phase_status: "complete" }),
        "utf-8",
      );
      const r = await readPipelineState(dir);
      assert.equal(r.kind, "ok");
      if (r.kind !== "ok") return;
      assert.equal(r.state.phase, "7");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("corrupt: real malformed state.json → corrupt", async () => {
    const dir = await tmpdir();
    try {
      await fs.writeFile(path.join(dir, "state.json"), "{ truncated", "utf-8");
      const r = await readPipelineState(dir);
      assert.equal(r.kind, "corrupt");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
