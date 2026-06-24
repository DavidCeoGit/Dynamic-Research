/**
 * Classify the outcome of reading + parsing the current pipeline state.json.
 *
 * Why this exists (audit 2026-06-24, two MEDIUMs):
 *   The progress poller (watchStateFile) and the duration-kill recovery read
 *   (readStateForRecovery) each wrapped findStateFile + readFile + JSON.parse in
 *   a single bare `catch {}` that returned/ignored uniformly. That collapsed
 *   THREE distinct outcomes into one:
 *     - a TRANSIENT miss (state not written yet, file vanished/locked mid-write,
 *       workdir not yet enumerable) — expected during a live run, retry;
 *     - a genuinely CORRUPT state file (present + readable but not valid JSON) —
 *       persistent, worth surfacing instead of silently freezing progress or
 *       silently dropping a recoverable run;
 *     - ABSENT (no state file at all) — nothing to read.
 *   Indistinguishable outcomes meant a corrupt state file produced zero log
 *   signal forever. This helper makes the distinction once, in a unit-tested
 *   place, so each caller can apply the right policy.
 *
 * Prior art: verifyPipelineCompletion() in executor.ts already splits these
 * cases inline, but it needs finer caller-facing reason strings (enumerate-vs-
 * read-vs-parse) that surface in job failure messages and it gates PUBLISH, so
 * it is intentionally NOT routed through this helper — consolidating it is a
 * separate, larger change with its own review.
 *
 * Scope boundary: this classifies the READ/PARSE outcome only. Validating the
 * SHAPE of a parsed state (required fields, value ranges) is the separate
 * state-schema.ts (Zod) initiative — out of scope here. The single structural
 * guard below (parsed value must be a JSON object, not null/array/primitive)
 * exists only so an `ok` result is always a safely-indexable object for callers,
 * never to validate the PipelineState contract.
 *
 * findStateFile + readFile are injectable so every branch is deterministically
 * unit-testable without touching the real filesystem (mirrors the Uploader DI
 * idiom in executor.ts).
 */

import * as fs from "node:fs/promises";
import { findStateFile as defaultFindStateFile } from "./find-state-file.js";
import type { PipelineState } from "../types.js";

export type StateReadResult =
  /** Located, read, and parsed to a JSON object. */
  | { kind: "ok"; state: PipelineState; path: string }
  /** No state-file candidate exists in the workdir (findStateFile → null). */
  | { kind: "absent" }
  /** Directory enumeration OR the file read threw — transient/unknown IO. The
   *  file may exist; we could not obtain its bytes. Retry-eligible. */
  | { kind: "io-error"; error: unknown }
  /** The file was located AND read, but its bytes are not a valid JSON object
   *  (JSON.parse threw, or parsed to null/array/primitive). Persistent. */
  | { kind: "corrupt"; error: unknown; path: string };

export interface ReadPipelineStateDeps {
  findStateFile: (workDir: string) => Promise<string | null>;
  readFile: (filePath: string, encoding: "utf-8") => Promise<string>;
}

const defaultDeps: ReadPipelineStateDeps = {
  findStateFile: defaultFindStateFile,
  readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
};

/**
 * Read the current state.json for a workdir and classify the outcome. Never
 * throws — every failure mode is reported as a typed StateReadResult so callers
 * can branch on it (transient vs corrupt vs absent) rather than swallow a bare
 * catch.
 */
export async function readPipelineState(
  workDir: string,
  deps: ReadPipelineStateDeps = defaultDeps,
): Promise<StateReadResult> {
  let stateFile: string | null;
  try {
    stateFile = await deps.findStateFile(workDir);
  } catch (error) {
    // readdir on the workdir threw (ENOENT before it is created, EMFILE, EPERM,
    // ENOTDIR, …) — we cannot prove presence/absence → transient IO.
    return { kind: "io-error", error };
  }

  if (!stateFile) return { kind: "absent" };

  let content: string;
  try {
    content = await deps.readFile(stateFile, "utf-8");
  } catch (error) {
    // Located but unreadable — vanished/locked between find and read (race
    // during an active run) → transient IO, not corruption.
    return { kind: "io-error", error };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return { kind: "corrupt", error, path: stateFile };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      kind: "corrupt",
      error: new Error("state.json did not parse to a JSON object"),
      path: stateFile,
    };
  }

  return { kind: "ok", state: parsed as PipelineState, path: stateFile };
}
