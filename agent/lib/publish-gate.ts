/**
 * MRPF PUBLISH gate — fail-closed completion enforcement.
 *
 * Deliverable (B) of the S100 PUBLISH design synthesis
 * (Documentation/mrpf-publish-gate-design-gate-peer-review.md). The policy
 * (~/.claude/CLAUDE.md §PUBLISH) is NON-OPERATIONAL until this code blocks
 * completion of publish-required jobs whose verification manifest is missing,
 * degraded, malformed, or failed. Root cause being closed: a silently-401'd
 * Perplexity leg let the pipeline FAIL OPEN into a WebSearch fallback, so the
 * cross-vendor check that catches hallucinations never fired (run 808e4b1f).
 *
 * The mechanical assertion (Codex, design synthesis §v2) for
 * publish_required=true jobs — completion is REFUSED unless:
 *   - publish_verification.verification_status === "passed"
 *   - all three vendor_legs (perplexity, notebooklm, claude) are status "ok"
 *     (degraded / failed / skipped are all HARD BLOCKS — a fallback is a
 *     failure for PUBLISH jobs, not a substitute)
 *   - claims_extraction_status is "populated" with >=1 claim, or exactly
 *     "no_load_bearing_claims" with zero claims (any inconsistency blocks)
 *   - every claim carries text, a temporal anchor (asOfDate), source URLs,
 *     source pub/access dates, a source-quality class, an
 *     upstream-independence basis, counter-evidence notes, and a verdict in
 *     {verified, verified_with_caveat}
 *
 * Bypass: URGENT severity ONLY, via a HUMAN-authored sign-off file the agent
 * must never create (see readUrgentBypass). Even a valid sign-off requires at
 * least one LIVE vendor leg — a degraded verifier cannot be renamed "the
 * single verification path".
 *
 * Everything here validates structurally at runtime: state.json is written by
 * the spawned pipeline and parsed with a cast, so no field can be trusted to
 * match the TS types. Unknown shapes BLOCK (fail closed), never pass.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  PipelineState,
  PublishVendorLegs,
  ResearchJob,
  VerifiedClaim,
} from "../types.js";

export interface PublishGateResult {
  /** True when completion may proceed (clean pass OR valid URGENT bypass). */
  ok: boolean;
  /** True when ok came from a human URGENT sign-off, not a clean manifest. */
  bypassed: boolean;
  /** Every defect found (empty on a clean pass). Preserved under bypass so
   * the log shows exactly what the human accepted. */
  reasons: string[];
}

export type BypassReadResult =
  | { present: false }
  | { present: true; valid: false; file: string; problem: string }
  | { present: true; valid: true; file: string; signoffLine: string };

export type JobPublishGateResult = PublishGateResult & {
  /** False when the job is not publish-required (gate does not apply). */
  applicable: boolean;
  signoffLine?: string;
};

const LEG_NAMES = ["perplexity", "notebooklm", "claude"] as const;
const CLAIM_PASS_VERDICTS = new Set(["verified", "verified_with_caveat"]);
/** Sanity bound — a manifest claiming more load-bearing claims than this is
 * pathological (inflated extraction) and blocks rather than soaking IO. */
const MAX_CLAIMS = 500;
/** Per-reason truncation so a hostile manifest can't blow up error_message. */
const REASON_SLICE = 300;

/**
 * Sign-off line contract (~/.claude/CLAUDE.md §Severity Modes). PUBLISH bypass
 * is URGENT-only by policy — EMERGENCY is incident response and does not
 * authorize external publication.
 */
const RISK_ACCEPTED_RE =
  /^RISK-ACCEPTED-BY:\s*[^|]*\S[^|]*\|\s*mode=URGENT\s*\|\s*reason=[^|]*\S[^|]*\|\s*followup-due=\d{4}-\d{2}-\d{2}\s*$/;

/** Queue job ids are UUIDs; anything else must not reach a filesystem path. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const truncate = (s: string): string => (s.length > REASON_SLICE ? `${s.slice(0, REASON_SLICE)}…` : s);

/**
 * Flag check tolerant of LLM-stringified booleans (S108 Gemini G2): the state
 * file is written by the spawned pipeline, which can serialize `true` as
 * `"true"`. Accepting the string form makes the gate fire MORE often — the
 * fail-closed direction; the reverse (a string silently reading as false and
 * skipping the gate) is the fail-open this closes. Applied to the jsonb job
 * flag too: zod guarantees a real boolean on the API path, but direct DB
 * writes bypass zod.
 */
const truthyFlag = (v: unknown): boolean =>
  v === true || (typeof v === "string" && v.trim().toLowerCase() === "true");

/**
 * publish_required is an OR of the durable job flag (user_context jsonb, set
 * at submit) and the pipeline-declared state flag. The OR is load-bearing:
 * the spawned pipeline omitting/zeroing its state flag must not un-publish a
 * job the submitter flagged (fail closed against prompt drift).
 */
export function isPublishRequired(
  job: Pick<ResearchJob, "user_context">,
  state: PipelineState | null | undefined,
): boolean {
  return truthyFlag(job.user_context?.publishRequired) || truthyFlag(state?.publish_required);
}

function validateClaim(claim: unknown, idx: number, reasons: string[]): void {
  if (claim === null || typeof claim !== "object" || Array.isArray(claim)) {
    reasons.push(`claim[${idx}] is not an object`);
    return;
  }
  const c = claim as Partial<VerifiedClaim> & Record<string, unknown>;
  const label = typeof c.text === "string" && c.text.trim().length > 0
    ? `claim[${idx}] ("${truncate(c.text.trim()).slice(0, 80)}")`
    : `claim[${idx}]`;

  if (typeof c.text !== "string" || c.text.trim().length === 0) {
    reasons.push(`${label} has no claim text`);
  }
  if (typeof c.asOfDate !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(c.asOfDate.trim())) {
    reasons.push(`${label} missing temporal anchor (asOfDate must be an ISO date)`);
  }
  if (
    !Array.isArray(c.sourceUrls) ||
    c.sourceUrls.length === 0 ||
    !c.sourceUrls.every((u) => typeof u === "string" && u.trim().length > 0)
  ) {
    reasons.push(`${label} has no source URLs — unsourced load-bearing claim`);
  }
  if (
    !Array.isArray(c.sourceDates) ||
    c.sourceDates.length === 0 ||
    !c.sourceDates.every((d) => typeof d === "string" && d.trim().length > 0)
  ) {
    reasons.push(`${label} missing source publication/access dates`);
  }
  if (typeof c.sourceQualityClass !== "string" || c.sourceQualityClass.trim().length === 0) {
    reasons.push(`${label} missing source-quality class`);
  }
  if (typeof c.upstreamIndependenceBasis !== "string" || c.upstreamIndependenceBasis.trim().length === 0) {
    reasons.push(
      `${label} missing upstream-independence basis — cross-vendor agreement does not count when sources trace to the same upstream`,
    );
  }
  if (typeof c.counterEvidenceNotes !== "string" || c.counterEvidenceNotes.trim().length === 0) {
    reasons.push(`${label} missing counter-evidence notes (record "none found" explicitly)`);
  }
  if (typeof c.verdict !== "string" || !CLAIM_PASS_VERDICTS.has(c.verdict)) {
    reasons.push(`${label} verdict "${truncate(String(c.verdict))}" is not verified/verified_with_caveat`);
  }
}

/**
 * The pure mechanical assertion. Collects EVERY defect (not first-failure) so
 * one failed run surfaces the whole repair list. `bypass` must be a
 * validated human sign-off (readUrgentBypass) — passing it relaxes manifest
 * defects but never the live-leg floor.
 */
export function evaluatePublishGate(
  state: PipelineState | null | undefined,
  opts?: { bypass?: { signoffLine: string } | null },
): PublishGateResult {
  const reasons: string[] = [];
  const pvRaw: unknown = state?.publish_verification;

  let legs: Partial<Record<(typeof LEG_NAMES)[number], unknown>> = {};

  if (pvRaw === null || pvRaw === undefined) {
    reasons.push(
      "publish_verification manifest missing from state.json — pipeline never ran claim verification",
    );
  } else if (typeof pvRaw !== "object" || Array.isArray(pvRaw)) {
    reasons.push("publish_verification is not an object");
  } else {
    const pv = pvRaw as Record<string, unknown>;

    if (pv.verification_status !== "passed") {
      reasons.push(
        `verification_status is "${truncate(String(pv.verification_status))}" (must be "passed")`,
      );
    }

    const legsRaw = pv.vendor_legs;
    if (legsRaw === null || typeof legsRaw !== "object" || Array.isArray(legsRaw)) {
      reasons.push("vendor_legs missing — cannot prove all three legs were live");
    } else {
      legs = legsRaw as PublishVendorLegs;
      for (const name of LEG_NAMES) {
        const leg = (legs as Record<string, unknown>)[name];
        const status =
          leg !== null && typeof leg === "object" && !Array.isArray(leg)
            ? (leg as Record<string, unknown>).status
            : undefined;
        if (typeof status !== "string") {
          reasons.push(`vendor leg "${name}" missing or has no status`);
        } else if (status !== "ok") {
          const detail =
            typeof (leg as Record<string, unknown>).detail === "string"
              ? ` (${truncate((leg as Record<string, unknown>).detail as string)})`
              : "";
          reasons.push(
            `vendor leg "${name}" status "${truncate(status)}"${detail} — degraded/failed/skipped legs HARD BLOCK publish`,
          );
        }
      }
    }

    const ces = pv.claims_extraction_status;
    const claimsRaw = pv.claims;
    if (ces !== "populated" && ces !== "no_load_bearing_claims") {
      reasons.push(
        `claims_extraction_status is "${truncate(String(ces))}" (must be "populated" or "no_load_bearing_claims")`,
      );
    }
    // S108 Gemini G4: "no load-bearing claims" is a tempting LLM escape hatch
    // from the heavy verification step — require a substantive written
    // justification so invoking it leaves an auditable, falsifiable record.
    if (ces === "no_load_bearing_claims") {
      const just = pv.no_claims_justification;
      if (typeof just !== "string" || just.trim().length < 20) {
        reasons.push(
          'claims_extraction_status="no_load_bearing_claims" requires a substantive no_claims_justification (>=20 chars) explaining why a research deliverable carries no load-bearing factual claims',
        );
      }
    }
    if (!Array.isArray(claimsRaw)) {
      reasons.push("claims is not an array");
    } else {
      if (ces === "populated" && claimsRaw.length === 0) {
        reasons.push(
          'claims is empty while claims_extraction_status="populated" — empty claim list on a claim-bearing artifact',
        );
      }
      if (ces === "no_load_bearing_claims" && claimsRaw.length > 0) {
        reasons.push(
          `claims_extraction_status="no_load_bearing_claims" but ${claimsRaw.length} claim(s) present — inconsistent manifest`,
        );
      }
      if (claimsRaw.length > MAX_CLAIMS) {
        reasons.push(`${claimsRaw.length} claims exceeds the ${MAX_CLAIMS} sanity bound`);
      } else {
        claimsRaw.forEach((c, i) => validateClaim(c, i, reasons));
      }
    }
  }

  if (reasons.length === 0) {
    return { ok: true, bypassed: false, reasons: [] };
  }

  if (opts?.bypass) {
    const hasLiveLeg = LEG_NAMES.some((name) => {
      const leg = (legs as Record<string, unknown>)[name];
      return (
        leg !== null &&
        typeof leg === "object" &&
        !Array.isArray(leg) &&
        (leg as Record<string, unknown>).status === "ok"
      );
    });
    if (!hasLiveLeg) {
      return {
        ok: false,
        bypassed: false,
        reasons: [
          ...reasons,
          "URGENT sign-off present but NO vendor leg is live — URGENT still requires one LIVE grounded verification path",
        ],
      };
    }
    return { ok: true, bypassed: true, reasons };
  }

  return { ok: false, bypassed: false, reasons };
}

/**
 * Read a HUMAN-authored URGENT risk-acceptance for one job.
 *
 * Contract: the operator creates `<dir>/<job-id>.txt` containing a line
 * matching the CLAUDE.md sign-off format with mode=URGENT. The agent (this
 * worker, the spawned pipeline, any review tooling) MUST NEVER create, edit,
 * or template this file — its existence IS the human authorization. The dir
 * lives outside the job workdir precisely so the spawned `claude -p` pipeline
 * has no business writing there, and it is gitignored so a sign-off is never
 * committed as a reusable artifact.
 */
export async function readUrgentBypass(dir: string, jobId: string): Promise<BypassReadResult> {
  if (!UUID_RE.test(jobId)) {
    // Non-UUID job ids never touch the filesystem; treat as no sign-off.
    return { present: false };
  }
  const file = path.join(dir, `${jobId}.txt`);
  let content: string;
  try {
    content = await fs.readFile(file, "utf-8");
  } catch {
    return { present: false };
  }
  const line = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith("RISK-ACCEPTED-BY:"));
  if (!line) {
    return {
      present: true,
      valid: false,
      file,
      problem: "file exists but contains no RISK-ACCEPTED-BY line",
    };
  }
  if (!RISK_ACCEPTED_RE.test(line)) {
    return {
      present: true,
      valid: false,
      file,
      problem: `RISK-ACCEPTED-BY line malformed (need "RISK-ACCEPTED-BY: <name> | mode=URGENT | reason=<short> | followup-due=<ISO date>"): ${truncate(line)}`,
    };
  }
  return { present: true, valid: true, file, signoffLine: line };
}

/**
 * The single call sites in executor.ts use: applicability check + bypass read
 * + gate evaluation in one step, fully unit-testable without spawning jobs.
 */
export async function evaluatePublishGateForJob(
  job: Pick<ResearchJob, "id" | "user_context">,
  state: PipelineState | null | undefined,
  bypassDir: string,
): Promise<JobPublishGateResult> {
  if (!isPublishRequired(job, state)) {
    return { applicable: false, ok: true, bypassed: false, reasons: [] };
  }
  const bypassRead = await readUrgentBypass(bypassDir, job.id);
  const bypass = bypassRead.present && bypassRead.valid ? { signoffLine: bypassRead.signoffLine } : null;
  const result = evaluatePublishGate(state, { bypass });
  if (bypassRead.present && !bypassRead.valid && !result.ok) {
    result.reasons.push(`risk-acceptance file rejected: ${bypassRead.problem}`);
  }
  return {
    applicable: true,
    ...result,
    ...(bypass ? { signoffLine: bypass.signoffLine } : {}),
  };
}
