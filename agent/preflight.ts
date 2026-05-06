/**
 * Worker daemon pre-flight checks.
 *
 * Runs once at worker startup before the polling loop begins. Fails loudly
 * with actionable remediation if any check fails, so the operator can fix
 * the issue before the worker claims a job and wastes a slot on a run that
 * can never succeed.
 *
 * Each check was born from a real session-25 incident (Bugs 32, 34, and
 * the exit-0 masking pattern of Bug 35). Add future checks here when a new
 * "worker can claim but can't execute" class of bug is found.
 *
 * Checks (in order; each must pass before the next runs):
 *
 *   1. Env sanity — required vars are set, paths are Windows-native if on Windows.
 *   2. Claude CLI spawn — can we actually `claude -p` from a child process
 *      with the same env-stripping logic the executor uses? Catches Bug 32
 *      (CLAUDECODE inherit) and PATH issues.
 *   3. NotebookLM auth — is the NLM CLI logged in? Catches Bug 34.
 *      (Optional — skipped if notebooklm venv is not found. Logs a warning.)
 *
 * Exit code: 0 if all required checks pass; 1 if any required check fails.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

interface CheckResult {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
  remediation?: string;
}

// ── 1. Env sanity ───────────────────────────────────────────────────

function checkEnv(): CheckResult {
  const missing: string[] = [];
  if (!process.env.AGENT_SECRET_KEY) missing.push("AGENT_SECRET_KEY");
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");

  if (missing.length > 0) {
    return {
      name: "env-sanity",
      ok: false,
      required: true,
      detail: `Missing required env vars: ${missing.join(", ")}`,
      remediation: "Populate agent/.env from agent/.env.example",
    };
  }

  // Windows: flag `/c/...` MSYS-style paths in WORKING_DIR / PROJECTS_DIR
  // (Bug 31 — Node.js resolves these to ghost C:\c\... directories).
  if (process.platform === "win32") {
    const ghostPathRe = /^\/[a-zA-Z]\//;
    const workingDir = process.env.WORKING_DIR ?? "";
    const projectsDir = process.env.PROJECTS_DIR ?? "";
    if (ghostPathRe.test(workingDir) || ghostPathRe.test(projectsDir)) {
      return {
        name: "env-sanity",
        ok: false,
        required: true,
        detail: `Windows-style path required but got MSYS-style: WORKING_DIR=${workingDir} PROJECTS_DIR=${projectsDir}`,
        remediation: "Change /c/tmp/... to C:/tmp/... in agent/.env (drive-letter, not MSYS mount)",
      };
    }
  }

  return { name: "env-sanity", ok: true, required: true, detail: "all required env vars present" };
}

// ── 2. Claude CLI spawn ─────────────────────────────────────────────

function checkClaudeSpawn(): Promise<CheckResult> {
  return new Promise((resolve) => {
    // Mirror the exact env-stripping logic executor.ts uses.
    const childEnv = { ...process.env } as NodeJS.ProcessEnv;
    delete childEnv.CLAUDECODE;
    delete childEnv.CLAUDE_CODE_SSE_PORT;
    delete childEnv.CLAUDE_CODE_SESSION_ID;

    // We are only verifying the spawn path (CLAUDECODE strip, PATH,
    // arg passing through cmd.exe on Windows). We do NOT assert content —
    // claude will contextualize to the cwd and respond variously. What
    // matters for the worker is: exit 0 + any stdout = spawn works.
    const child = spawn("claude", ["-p", "hello"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      env: childEnv,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        name: "claude-spawn",
        ok: false,
        required: true,
        detail: "claude CLI did not respond within 60s",
        remediation: "Check `claude --version` from your shell. If it hangs or errors, reinstall Claude Code.",
      });
    }, 60_000);

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const nested = stderr.includes("nested sessions") || stdout.includes("nested sessions");
        resolve({
          name: "claude-spawn",
          ok: false,
          required: true,
          detail: `claude exited code=${code}. stdout=${stdout.slice(0, 200)} stderr=${stderr.slice(0, 200)}`,
          remediation: nested
            ? "CLAUDECODE env var is inherited from a parent Claude session — executor.ts strips it but this preflight spawn hit it too. Re-run worker from a non-Claude shell."
            : "Verify `claude -p 'test'` works from your shell. If it errors there too, reinstall Claude Code.",
        });
        return;
      }
      const trimmed = stdout.trim();
      if (trimmed.length === 0) {
        resolve({
          name: "claude-spawn",
          ok: false,
          required: true,
          detail: `claude exited 0 but produced no stdout. stderr=${stderr.slice(0, 200)}`,
          remediation: "Unexpected: claude ran but wrote nothing. Try `claude -p hello` from your shell.",
        });
        return;
      }
      resolve({ name: "claude-spawn", ok: true, required: true, detail: `claude spawn OK (${trimmed.length} bytes reply)` });
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        name: "claude-spawn",
        ok: false,
        required: true,
        detail: `spawn error: ${err.message}`,
        remediation: "Is `claude` on PATH? Run `which claude` (bash) or `where claude` (cmd) to verify.",
      });
    });
  });
}

// ── 3. NotebookLM auth ──────────────────────────────────────────────

function checkNotebookLMAuth(): Promise<CheckResult> {
  return new Promise((resolve) => {
    // Call the venv binary directly. Activation scripts require a POSIX
    // shell (`source`) which isn't available from Node spawn+cmd.exe.
    const nlmBin = process.env.NOTEBOOKLM_BIN
      ?? (process.platform === "win32"
        ? `${process.env.USERPROFILE}\\.notebooklm-venv\\Scripts\\notebooklm.exe`
        : `${process.env.HOME}/.notebooklm-venv/bin/notebooklm`);

    const child = spawn(nlmBin, ["list", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        name: "nlm-auth",
        ok: false,
        required: false,
        detail: "notebooklm list did not respond within 30s",
        remediation: "Run `notebooklm list` manually to check. If it hangs, re-run `notebooklm login`.",
      });
    }, 30_000);

    child.on("exit", (code) => {
      clearTimeout(timeout);
      const combined = stdout + "\n" + stderr;
      const authBroken = /not logged in|login|auth|unauthorized|session expired/i.test(combined);
      if (code !== 0 || authBroken) {
        resolve({
          name: "nlm-auth",
          ok: false,
          required: false,
          detail: `nlm auth check failed (code=${code}): ${combined.slice(0, 200)}`,
          remediation: "Open PowerShell, run `~/.notebooklm-venv/Scripts/Activate.ps1` then `notebooklm login`, complete the browser flow.",
        });
        return;
      }
      resolve({ name: "nlm-auth", ok: true, required: false, detail: "notebooklm session valid" });
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        name: "nlm-auth",
        ok: false,
        required: false,
        detail: `nlm spawn error: ${err.message}`,
        remediation: "notebooklm CLI not found — is the venv at ~/.notebooklm-venv? Skipping as non-required.",
      });
    });
  });
}

// ── Orchestrator ────────────────────────────────────────────────────

export async function runPreflight(): Promise<void> {
  const log = (msg: string): void => {
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
    console.log(`[${ts}] [preflight] ${msg}`);
  };

  log("Starting pre-flight checks...");

  const results: CheckResult[] = [];
  results.push(checkEnv());
  if (!results[0].ok) {
    emit(results, log);
    process.exit(1);
  }

  results.push(await checkClaudeSpawn());
  if (!results[1].ok && results[1].required) {
    emit(results, log);
    process.exit(1);
  }

  results.push(await checkNotebookLMAuth());

  emit(results, log);

  const hardFail = results.some((r) => !r.ok && r.required);
  if (hardFail) process.exit(1);

  log("All required checks passed — worker will begin polling.");
}

function emit(results: CheckResult[], log: (m: string) => void): void {
  for (const r of results) {
    const mark = r.ok ? "✓" : r.required ? "✗" : "⚠";
    log(`${mark} ${r.name}: ${r.detail}`);
    if (!r.ok && r.remediation) {
      log(`   → remediation: ${r.remediation}`);
    }
  }
}
