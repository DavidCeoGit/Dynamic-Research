/**
 * NotebookLM artifact CLI wrapper + download-failure taxonomy.
 *
 * S174 Wave A: extracted VERBATIM from studio-completeness.ts (the S129 gate) so
 * the consumers that reach for the NLM-CLI seams — the completeness gate,
 * studio-recovery-sweep, regenerate-studio-products, and studio-snapshot-diff
 * (the NlmArtifactRef type) — import a focused CLI module instead of reaching
 * into the gate. No logic change: realListArtifacts/realDownloadArtifact and
 * both S162 spawnSync throw-guards move byte-for-byte, comments included.
 *
 * realDownloadArtifact's `ok` is true only on a non-empty downloaded file; the
 * S160/S161 atomic rename-only promotion + the S162 spawn-throw guards preserve
 * the "never throws, never strands a recovery row" contract the gate + sweep
 * depend on.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";

// Windows: spawnSync needs the native venv path (Bug 3 / WinError 2).
const NLM_BIN =
  process.env.NOTEBOOKLM_BIN ??
  (process.platform === "win32"
    ? "C:/Users/ceo/.notebooklm-venv/Scripts/notebooklm.exe"
    : "notebooklm");

export interface NlmArtifactRef {
  id: string;
  title: string;
  created_at: string;
}

/**
 * S187 P0-2 — a STATUS-AWARE artifact ref. realListArtifacts only ever emits
 * refs for COMPLETED artifacts (and drops status_id); this carries status_id so
 * Branch (c) can SEE a still-rendering video. The underlying
 * `notebooklm artifact list --json` already returns status_id — the completed-
 * only list simply discards it.
 *   status_id 1 = in_progress (rendering)   3 = completed   (other = failed/unknown)
 */
export interface NlmArtifactRefWithStatus {
  id: string;
  title: string;
  created_at: string;
  status_id?: number;
}

/**
 * S158 — the captured outcome of one download attempt. The S129 gate previously
 * DISCARDED `r.status`/`r.stderr`/`r.signal` (the literal S156 diagnostic gap,
 * design G9); the recovery taxonomy classifies on the captured result, never on
 * `exitCode===0` (the Bug-12 backslash-path success stays a success).
 */
export interface DownloadResult {
  ok: boolean;
  exitCode?: number | null;
  signal?: string | null;
  stderr?: string;
}

// ── S158 download-failure classifier (design §8) ─────────────────────
// TRANSIENT (everything except truly-local-disk): on a CONFIRMED status_id-3
// winner a 404/401/403/5xx/429/network/timeout/SIGTERM is an NLM consistency-
// lag or auth-refresh transient, not genuine loss. Biased toward recoverable —
// the sweep's fresh re-list is the real terminality decider. The ONLY way to
// regress is to mis-bucket a LOCAL-disk error as transient (which merely burns
// bounded attempts, never a hard-fail), so the terminal set is kept tight.
const TERMINAL_DOWNLOAD_PATTERNS: RegExp[] = [
  /enospc/i,
  /no space left/i,
  /disk (is )?full/i,
  /\bdisk quota exceeded\b/i,
  /erofs/i,
  /read-only file system/i,
];

/**
 * Classify a CAPTURED download failure. Only TRULY-LOCAL, recovery-can't-fix
 * conditions (disk-full / read-only FS / disk-quota) are 'terminal'; everything
 * else — including 404/auth/5xx/network/timeout/SIGTERM/null-exit — is
 * 'transient' (Codex MAJOR-7). NEVER keys on exitCode===0: classify only ever
 * runs on an ok:false result, and the Bug-12 backslash-path success stays a
 * success. exitCode/signal are accepted for forward-use + logging; the decision
 * is the local-disk stderr signature.
 */
export function classifyDownloadFailure(
  exitCode: number | null,
  stderr: string,
  signal: string | null,
): "transient" | "terminal" {
  void exitCode;
  void signal;
  const text = stderr ?? "";
  if (TERMINAL_DOWNLOAD_PATTERNS.some((re) => re.test(text))) return "terminal";
  return "transient";
}

// ── Real (non-injected) dependency implementations ───────────────────

/** List COMPLETED (status_id===3) artifacts of a type, newest-first. */
export function realListArtifacts(
  notebookId: string,
  nlmType: string,
): NlmArtifactRef[] | null {
  // S162 (Codex grounded BLOCK): the ENTIRE body is throw-guarded. spawnSync THROWS
  // SYNCHRONOUSLY on an invalid arg — notably an empty NLM_BIN (a blank
  // NOTEBOOKLM_BIN survives the `??` default at line ~68) or a NUL byte in an arg —
  // UNLIKE a missing binary / timeout / maxBuffer, which return error-shaped
  // (status:null). This fn documents a throw-safe "returns null on failure"
  // contract; an unguarded spawnSync throw broke it and escaped the recovery sweep,
  // stranding a row before its attempt-bump/caps ran. Guarding the whole body (which
  // also subsumes the prior JSON.parse try/catch) makes a list failure ALWAYS a
  // transient null (the sweep's C1 retry path), never a thrown error.
  try {
    const r = spawnSync(
      NLM_BIN,
      ["artifact", "list", "-n", notebookId, "--type", nlmType, "--json"],
      {
        encoding: "utf-8",
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 60_000,
      },
    );
    if (r.status !== 0) return null;
    const parsed = JSON.parse(r.stdout ?? "") as {
      artifacts?: Array<{ id: string; title: string; created_at: string; status_id?: number }>;
    };
    // status_id 3 == completed; undefined assumed completed for forward-compat
    // (mirrors verify-gallery-vs-notebook.ts). In_progress (other status_id)
    // is excluded — that is the whole point vs the unreliable `artifact poll`.
    const arts = (parsed.artifacts ?? []).filter(
      (a) => a.status_id === 3 || a.status_id === undefined,
    );
    arts.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    return arts.map((a) => ({ id: a.id, title: a.title, created_at: a.created_at }));
  } catch {
    return null;
  }
}

/**
 * S187 P0-2 — list ALL artifacts of a type (ANY status), newest-first, WITH
 * status_id. Same throw-safe "returns null on ANY failure" contract as
 * realListArtifacts (the S162 whole-body guard subsumes the JSON.parse try) —
 * the ONLY differences are: (1) NO status_id===3 filter, and (2) status_id is
 * carried through. Branch (c) uses it to detect a still-rendering video
 * (status_id 1) and to anti-stale-match it by exact id / created_at >=
 * runFloorMs. realListArtifacts is left UNTOUCHED for its completed-only callers
 * (the in-gate + sweep download paths).
 */
export function realListArtifactsWithStatus(
  notebookId: string,
  nlmType: string,
): NlmArtifactRefWithStatus[] | null {
  try {
    const r = spawnSync(
      NLM_BIN,
      ["artifact", "list", "-n", notebookId, "--type", nlmType, "--json"],
      {
        encoding: "utf-8",
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 60_000,
      },
    );
    if (r.status !== 0) return null;
    const parsed = JSON.parse(r.stdout ?? "") as {
      artifacts?: Array<{
        id: string;
        title: string;
        created_at: string;
        status_id?: number;
      }>;
    };
    const arts = (parsed.artifacts ?? []).slice();
    arts.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    return arts.map((a) => ({
      id: a.id,
      title: a.title,
      created_at: a.created_at,
      status_id: a.status_id,
    }));
  } catch {
    return null;
  }
}

/**
 * Default spawnSync timeout for the in-gate recovery download. The decoupled
 * sweep passes a SHORTER timeout (~90s) so a per-tick budget can bound added
 * new-job-claim latency (Codex MAJOR-2) — spawnSync is uninterruptible once
 * started, so a shorter atomic timeout is the only lever.
 */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 300_000;

/**
 * The NLM-download spawn seam. Injectable so the atomic-write + cleanup logic in
 * realDownloadArtifact is unit-testable without the real NotebookLM CLI (S160
 * Codex MAJOR — the prior partial-cleanup root fix shipped untested).
 */
export type DownloadSpawn = (
  args: string[],
  opts: { timeoutMs: number },
) => { status: number | null; signal: NodeJS.Signals | null; stdout?: string; stderr?: string };

const defaultDownloadSpawn: DownloadSpawn = (args, opts) => {
  const r = spawnSync(NLM_BIN, args, {
    encoding: "utf-8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    maxBuffer: 16 * 1024 * 1024,
    timeout: opts.timeoutMs,
  });
  return { status: r.status, signal: r.signal ?? null, stdout: r.stdout, stderr: r.stderr };
};

const mangleWinPath = (p: string): string =>
  p.replace(/^([A-Za-z]):\//, "\\$1\\").replace(/\//g, "\\");

/**
 * Download a specific artifact BY ID; `ok` is true only on a non-empty file.
 * S158: captures exitCode/signal/stderr (the gate previously discarded them —
 * the literal S156 diagnostic gap, G9) so the taxonomy can classify the failure.
 *
 * S160 CRITICAL (Codex): the download writes to a same-directory TEMP path and is
 * ATOMICALLY promoted to the final convention path ONLY after exit 0 + a non-empty
 * stat. The final convention path is therefore written EXCLUSIVELY by a successful
 * rename — so a crash mid-download (the worker killed before this fn returns, when
 * an in-process cleanup could never run) leaves only a `.part` temp file, never the
 * convention-named final. That is what makes the sweep's on-disk-first skip (M5) and
 * the finalize keystone safe: a convention file on disk always means a COMPLETE
 * download. A FAILED download never touches the final, so a prior good file survives.
 * (Bug-12: NLM may write a backslash-mangled path — the temp candidates absorb it.)
 *
 * S161 R2-2 (Codex QA): the promotion is RENAME-ONLY — there is NO `fs.rm(outPath)`
 * before the rename and NO `fs.copyFile` fallback after it. fs.rename replaces an
 * existing destination atomically (libuv MOVEFILE_REPLACE_EXISTING on Windows), so
 * a failed promotion can never (a) delete a prior good final (no pre-delete) nor
 * (b) leave a truncated convention-named final (no mid-copy crash window) — it
 * returns {ok:false} with the prior final intact and the temp dropped. The
 * `renameImpl` seam makes the rename-failure path unit-testable.
 *
 * S161 R2-1: any leftover `.part` (e.g. a kill mid-spawn before cleanup runs, or
 * the sweep's artifact-gone branch) is on the upload skip-list (conventions.json
 * skip_files.extensions), so an orphan temp can never reach the gallery via
 * selectUploadSet or the finalize upload set.
 */
export async function realDownloadArtifact(
  notebookId: string,
  artifactId: string,
  nlmType: string,
  outPath: string,
  timeoutMs?: number,
  spawnImpl: DownloadSpawn = defaultDownloadSpawn,
  renameImpl: (src: string, dest: string) => Promise<void> = fs.rename,
): Promise<DownloadResult> {
  const tmpPath = `${outPath}.part`;
  const tmpCandidates = [tmpPath, mangleWinPath(tmpPath)];
  const cleanupTmp = async () => {
    for (const c of tmpCandidates) await fs.rm(c, { force: true }).catch(() => {});
  };

  // Clear any leftover temp from a prior crash so a stale .part can't masquerade.
  await cleanupTmp();

  // S162 (Codex grounded BLOCK): guard the spawn seam. defaultDownloadSpawn's
  // spawnSync THROWS SYNCHRONOUSLY on an invalid arg (an empty NLM_BIN from a blank
  // NOTEBOOKLM_BIN, or a NUL byte) — distinct from the error-shaped {status:null}
  // returns for a missing binary / timeout. An injected spawnImpl could also throw.
  // Map ANY throw to a fail-closed {ok:false} (this fn's documented "never throws"
  // contract) so it never escapes the recovery sweep and strands a row; the temp is
  // dropped and the prior final is left untouched.
  let r: ReturnType<DownloadSpawn>;
  try {
    r = spawnImpl(
      ["download", nlmType, "-n", notebookId, "-a", artifactId, tmpPath, "--force"],
      { timeoutMs: timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS },
    );
  } catch (err) {
    await cleanupTmp();
    return {
      ok: false,
      exitCode: null,
      signal: null,
      stderr: `spawn threw: ${(err as Error).message}`.slice(0, 2000),
    };
  }
  const exitCode = r.status;
  const signal = r.signal ?? null;
  // Scan BOTH streams (design §7) — the NLM CLI splits errors across them.
  const stderr = [r.stderr, r.stdout].filter(Boolean).join("\n").slice(0, 2000) || undefined;

  if (r.status !== 0) {
    await cleanupTmp();
    return { ok: false, exitCode, signal, stderr };
  }

  // Find the non-empty TEMP file and ATOMICALLY promote it to the final path via
  // RENAME-ONLY (S161 R2-2). fs.rename replaces an existing destination atomically
  // (libuv MOVEFILE_REPLACE_EXISTING on Windows) — so there is NO delete-then-write
  // window and NO copyFile fallback:
  //   • a rename failure leaves the prior good final UNTOUCHED (no pre-delete), and
  //   • a crash can never strand a truncated convention-named final (no mid-copy).
  // On promotion failure we drop the temp and return ok:false (fail-closed); the
  // final is written EXCLUSIVELY by a successful rename of a confirmed-non-empty temp.
  for (const cand of tmpCandidates) {
    let st: Awaited<ReturnType<typeof fs.stat>>;
    try {
      st = await fs.stat(cand);
    } catch {
      continue; // this candidate wasn't written — try the next
    }
    if (!st.isFile() || st.size === 0) continue;
    try {
      await renameImpl(cand, outPath);
    } catch (err) {
      // Promotion failed: prior final intact, temp dropped, fail-closed. NEVER
      // copyFile (a mid-copy crash truncates the final) and NEVER delete the final.
      await cleanupTmp();
      return {
        ok: false,
        exitCode,
        signal,
        stderr: (stderr ?? `promotion rename failed: ${(err as Error).message}`).slice(0, 2000),
      };
    }
    await cleanupTmp();
    return { ok: true, exitCode, signal };
  }
  // Exit 0 but no non-empty temp → transient failure; NEVER touch the final.
  await cleanupTmp();
  return { ok: false, exitCode, signal, stderr };
}
