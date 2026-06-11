/**
 * Lint a Dynamic Research workdir against canonical conventions.
 *
 * Reports violations of: filename patterns (Studio title-prefix, research
 * topic-prefix), skip-rule leakage (would-be-uploaded internal files),
 * state.json consistency. Local-only — no NLM/Supabase round-trips. Fast
 * (sub-second) so it can be a pre-finalize gate.
 *
 * Usage:
 *   cd agent && node --import=tsx scripts/lint-deliverables.ts <workdir>
 *   cd agent && node --import=tsx scripts/lint-deliverables.ts <workdir> --strict
 *
 * Exit codes:
 *   0 = clean
 *   1 = violations found
 *   2 = usage error
 *
 * --strict: also fails on "unknown" classifications (files that match
 * neither studio nor research nor skip patterns). Default is to warn
 * but not fail on unknowns (some workdirs have legitimate scratch).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  classifyFile,
  parseStudioFilename,
  parseResearchFilename,
  STUDIO_PRODUCTS,
  RESEARCH_ROLES,
  RESEARCH_DOCX_ROLES,
  VERSION,
  LAST_UPDATED,
  type FileClass,
} from "../lib/conventions.js";
import { findStateFile, isStateFileName } from "../lib/find-state-file.js";

const args = process.argv.slice(2);
const workDir = args[0];
const strict = args.includes("--strict");
// S108 (S107 follow-up): strict studio-coverage is SELECTION-AWARE. Partial
// product selection is normal (M&A ran 3/5, S107 ran 1/5) — requiring all 5
// made standalone --strict error on every partial run. Explicit override:
// --products=audio,report. Otherwise the workdir's job-manifest.json /
// state.json selectedProducts is consulted; only with NO selection source do
// we fall back to expecting all 5.
const productsArg = args.find((a) => a.startsWith("--products="));

if (!workDir) {
  console.error("usage: lint-deliverables.ts <workdir> [--strict] [--products=audio,report,...]");
  process.exit(2);
}

/** Resolve which Studio products this run was supposed to produce. */
async function resolveSelectedProducts(): Promise<{ products: string[] | null; source: string }> {
  const valid = new Set(Object.keys(STUDIO_PRODUCTS));
  if (productsArg) {
    const list = productsArg
      .slice("--products=".length)
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .filter((p) => p.length > 0);
    const bad = list.filter((p) => !valid.has(p));
    if (bad.length > 0) {
      console.error(`--products contains unknown product(s): ${bad.join(", ")} (valid: ${[...valid].join(", ")})`);
      process.exit(2);
    }
    return { products: list, source: "--products flag" };
  }
  // job-manifest.json (worker runs) then state.json (any run) — both carry
  // selectedProducts as {audio: bool, ...}.
  const candidates: Array<{ file: string; label: string }> = [
    { file: path.join(workDir, "job-manifest.json"), label: "job-manifest.json" },
  ];
  try {
    const stateFile = await findStateFile(workDir);
    if (stateFile) candidates.push({ file: stateFile, label: path.basename(stateFile) });
  } catch {
    // state discovery is best-effort
  }
  for (const { file, label } of candidates) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf-8")) as {
        selectedProducts?: Record<string, unknown>;
      };
      const sel = parsed.selectedProducts;
      if (sel && typeof sel === "object") {
        const list = Object.keys(sel).filter((p) => valid.has(p) && sel[p] === true);
        if (list.length > 0) return { products: list, source: label };
      }
    } catch {
      // missing/unparseable — try next source
    }
  }
  return { products: null, source: "none (expecting all products)" };
}

interface Violation {
  severity: "error" | "warn";
  file: string;
  msg: string;
}

const violations: Violation[] = [];

async function main() {
  console.log(`Linting ${workDir} against conventions v${VERSION} (${LAST_UPDATED})`);
  console.log(`  --strict: ${strict}\n`);

  let entries: string[];
  try {
    entries = await fs.readdir(workDir);
  } catch (err) {
    console.error(`workdir not readable: ${err}`);
    process.exit(2);
  }

  // Track what each file class contains
  const byClass: Record<FileClass, string[]> = {
    studio: [],
    research: [],
    "research-docx": [],
    skip: [],
    unknown: [],
  };

  // Track studio products + research roles seen so we can spot duplicates
  const studioProductsSeen = new Map<string, string[]>();
  const researchRolesSeen = new Map<string, string[]>();

  for (const name of entries) {
    const full = path.join(workDir, name);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const cls = classifyFile(name);
    byClass[cls].push(name);

    if (cls === "studio") {
      const parsed = parseStudioFilename(name);
      if (parsed) {
        if (!STUDIO_PRODUCTS[parsed.product]) {
          violations.push({
            severity: "error",
            file: name,
            msg: `Studio product "${parsed.product}" not in canonical list (${Object.keys(STUDIO_PRODUCTS).join(", ")})`,
          });
        }
        const expectedExt = STUDIO_PRODUCTS[parsed.product]?.ext;
        // v3.1 (S107): a .docx sibling is a valid pandoc companion for
        // products flagged docx_companion (report only) — the gallery keys
        // its Word-download button off the companion's existence.
        const isDocxCompanion =
          parsed.ext === "docx" &&
          STUDIO_PRODUCTS[parsed.product]?.docx_companion === true;
        if (expectedExt && parsed.ext !== expectedExt && !isDocxCompanion) {
          violations.push({
            severity: "error",
            file: name,
            msg: `Studio product "${parsed.product}" expects .${expectedExt}, got .${parsed.ext}`,
          });
        }
        // Companions don't count toward duplicate/coverage tracking — only
        // canonical-ext files represent the product.
        if (!isDocxCompanion) {
          const list = studioProductsSeen.get(parsed.product) ?? [];
          list.push(name);
          studioProductsSeen.set(parsed.product, list);
        }
      }
    }

    if (cls === "research" || cls === "research-docx") {
      const parsed = parseResearchFilename(name);
      if (parsed) {
        const validRoles = cls === "research" ? RESEARCH_ROLES : RESEARCH_DOCX_ROLES;
        if (!validRoles.has(parsed.role)) {
          violations.push({
            severity: "error",
            file: name,
            msg: `Research role "${parsed.role}" not in canonical list`,
          });
        }
        const list = researchRolesSeen.get(`${cls}:${parsed.role}`) ?? [];
        list.push(name);
        researchRolesSeen.set(`${cls}:${parsed.role}`, list);
      }
    }

    if (cls === "unknown") {
      violations.push({
        severity: strict ? "error" : "warn",
        file: name,
        msg: `Unknown filename pattern — does not match studio, research, or skip rules`,
      });
    }
  }

  // Detect duplicates
  for (const [product, files] of studioProductsSeen.entries()) {
    if (files.length > 1) {
      violations.push({
        severity: "warn",
        file: files.join(", "),
        msg: `Duplicate Studio product "${product}" — ${files.length} files. Pick one canonical version.`,
      });
    }
  }
  for (const [key, files] of researchRolesSeen.entries()) {
    if (files.length > 1) {
      violations.push({
        severity: "warn",
        file: files.join(", "),
        msg: `Duplicate research role "${key}" — ${files.length} files.`,
      });
    }
  }

  // state.json sanity check
  // S84: the brief writes a plain "state.json" (claude-prompt.md step 5); the
  // dash-only filter silently skipped the lint entirely. Match both the exact
  // name and legacy "<prefix>-state.json". Mirror S83 8b32c97.
  const stateFiles = entries.filter((f) => isStateFileName(f));
  if (stateFiles.length > 0) {
    for (const f of stateFiles) {
      try {
        const content = await fs.readFile(path.join(workDir, f), "utf-8");
        const state = JSON.parse(content);
        if (!state.notebook_id) {
          violations.push({
            severity: "warn",
            file: f,
            msg: "state.json has notebook_id=null — should be set after notebook creation",
          });
        }
        if (state.phase && state.phase !== "7" && state.phase_status === "complete") {
          violations.push({
            severity: "warn",
            file: f,
            msg: `state.json says phase=${state.phase} phase_status=complete — phase 7 (Finalization) expected for clean completion`,
          });
        }
      } catch (err) {
        violations.push({
          severity: "error",
          file: f,
          msg: `state.json unparseable: ${err}`,
        });
      }
    }
  }

  // Summary
  console.log("File classification:");
  for (const cls of ["studio", "research", "research-docx", "skip", "unknown"] as FileClass[]) {
    const files = byClass[cls];
    if (files.length === 0) continue;
    console.log(`  ${cls}: ${files.length}`);
    for (const f of files.slice(0, 8)) console.log(`    - ${f}`);
    if (files.length > 8) console.log(`    ... +${files.length - 8} more`);
  }
  console.log();

  // Studio coverage — selection-aware (S108): only the products this run
  // actually selected are REQUIRED; unselected ones are reported as info.
  const selection = await resolveSelectedProducts();
  const expectedProducts = selection.products ?? Object.keys(STUDIO_PRODUCTS);
  console.log(`Studio selection source: ${selection.source} → expecting [${expectedProducts.join(", ")}]`);
  const missingProducts = expectedProducts.filter((p) => !studioProductsSeen.has(p));
  const unselectedSeen = [...studioProductsSeen].filter((p) => !expectedProducts.includes(p));
  if (unselectedSeen.length > 0) {
    console.log(`Studio products present beyond selection (info): ${unselectedSeen.join(", ")}`);
  }
  if (missingProducts.length > 0) {
    console.log(`Studio products MISSING: ${missingProducts.join(", ")}`);
    if (strict) {
      for (const p of missingProducts) {
        violations.push({
          severity: "error",
          file: "(missing)",
          msg: `Selected Studio product "${p}" not present in workdir (selection source: ${selection.source})`,
        });
      }
    }
  } else {
    console.log(`Studio coverage: all ${expectedProducts.length} selected product(s) present ✓`);
  }
  console.log();

  // Print violations
  const errors = violations.filter((v) => v.severity === "error");
  const warns = violations.filter((v) => v.severity === "warn");

  if (errors.length === 0 && warns.length === 0) {
    console.log("LINT CLEAN — no violations.");
    process.exit(0);
  }

  if (errors.length > 0) {
    console.log(`ERRORS (${errors.length}):`);
    for (const v of errors) console.log(`  [error] ${v.file}: ${v.msg}`);
    console.log();
  }
  if (warns.length > 0) {
    console.log(`WARNINGS (${warns.length}):`);
    for (const v of warns) console.log(`  [warn]  ${v.file}: ${v.msg}`);
    console.log();
  }

  if (errors.length > 0) {
    console.log("LINT FAILED — fix errors before finalize.");
    process.exit(1);
  }

  console.log("LINT WARNINGS ONLY — review but no hard block.");
  process.exit(0);
}

main().catch((err) => {
  console.error("unexpected error:", err);
  process.exit(2);
});
