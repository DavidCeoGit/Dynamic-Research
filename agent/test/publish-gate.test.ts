/**
 * S108 unit tests — MRPF PUBLISH fail-closed gate (lib/publish-gate.ts).
 *
 * Pins the design-synthesis test list (Documentation/
 * mrpf-publish-gate-design-gate-peer-review.md, deliverable B): Perplexity-401
 * (failed leg), WebSearch fallback (degraded leg), empty-claims, missing
 * temporal anchor, URGENT-without-signoff — plus fail-closed behavior on
 * missing/malformed manifests, claim-field completeness, verdict gating,
 * the no-live-leg bypass floor, sign-off parsing, applicability (the OR of
 * job flag and state flag), and buildManifest seeding.
 *
 * Run: pnpm -C agent exec node --import=tsx --test "test/publish-gate.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  evaluatePublishGate,
  evaluatePublishGateForJob,
  isPublishRequired,
  readUrgentBypass,
} from "../lib/publish-gate.js";
import { buildManifest } from "../executor.js";
import type {
  PipelineState,
  PublishVerification,
  ResearchJob,
  VerifiedClaim,
} from "../types.js";

const JOB_ID = "838ca398-1111-4222-8333-444455556666";

// ── Fixtures ────────────────────────────────────────────────────────

function greenClaim(overrides: Partial<VerifiedClaim> = {}): VerifiedClaim {
  return {
    text: "The global auto-detailing market was $38.4B in 2025",
    asOfDate: "2026-06-10",
    sourceUrls: ["https://example.com/market-report", "https://other-vendor.example.org/stats"],
    sourceDates: ["2026-01-15 (published)", "2026-06-10 (accessed)"],
    sourceQualityClass: "reputable-secondary",
    upstreamIndependenceBasis:
      "Report A is primary survey data; report B aggregates registry filings — different upstreams",
    verdict: "verified",
    counterEvidenceNotes: "none found",
    ...overrides,
  };
}

function greenManifest(overrides: Partial<PublishVerification> = {}): PublishVerification {
  return {
    verification_status: "passed",
    claims_extraction_status: "populated",
    vendor_legs: {
      perplexity: { status: "ok", detail: "sonar-deep-research completed" },
      notebooklm: { status: "ok", detail: "deep research + extraction completed" },
      claude: { status: "ok", detail: "baseline snapshot written" },
    },
    claims: [greenClaim()],
    ...overrides,
  };
}

function publishState(pv: unknown, extra: Partial<PipelineState> = {}): PipelineState {
  return {
    publish_required: true,
    publish_verification: pv,
    ...extra,
  } as PipelineState;
}

function jobWith(publishRequired: boolean | undefined): Pick<ResearchJob, "id" | "user_context"> {
  return {
    id: JOB_ID,
    user_context: {
      domainKnowledge: [],
      constraints: [],
      additionalUrls: [],
      claimsToVerify: [],
      ...(publishRequired === undefined ? {} : { publishRequired }),
    },
  };
}

async function tmpBypassDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "publish-gate-test-"));
}

const VALID_SIGNOFF =
  "RISK-ACCEPTED-BY: David | mode=URGENT | reason=client deadline, manual verify done | followup-due=2026-06-12";

// ── isPublishRequired ───────────────────────────────────────────────

test("isPublishRequired: false when neither job nor state flags it", () => {
  assert.equal(isPublishRequired(jobWith(undefined), publishState(null, { publish_required: false })), false);
  assert.equal(isPublishRequired(jobWith(false), null), false);
});

test("isPublishRequired: job flag alone is enough (state cannot un-publish)", () => {
  assert.equal(isPublishRequired(jobWith(true), null), true);
  assert.equal(isPublishRequired(jobWith(true), publishState(null, { publish_required: false })), true);
  assert.equal(isPublishRequired(jobWith(true), { publish_required: undefined } as PipelineState), true);
});

test("isPublishRequired: pipeline-declared state flag alone is enough", () => {
  assert.equal(isPublishRequired(jobWith(undefined), publishState(greenManifest())), true);
});

test('isPublishRequired: LLM-stringified "true" still fires the gate (S108 Gemini G2)', () => {
  const state = { publish_required: "true", publish_verification: null } as unknown as PipelineState;
  assert.equal(isPublishRequired(jobWith(undefined), state), true);
  // jsonb job flag written outside zod gets the same tolerance
  const job = jobWith(undefined);
  (job.user_context as unknown as Record<string, unknown>).publishRequired = "TRUE";
  assert.equal(isPublishRequired(job, null), true);
  // but arbitrary truthy junk does NOT (only boolean true / string "true")
  const junk = { publish_required: "yes" } as unknown as PipelineState;
  assert.equal(isPublishRequired(jobWith(undefined), junk), false);
});

// ── evaluatePublishGate: clean pass + no_load_bearing_claims ────────

test("gate passes on an all-green manifest", () => {
  const res = evaluatePublishGate(publishState(greenManifest()));
  assert.equal(res.ok, true);
  assert.equal(res.bypassed, false);
  assert.deepEqual(res.reasons, []);
});

test("gate passes with zero claims when extraction says no_load_bearing_claims WITH justification", () => {
  const res = evaluatePublishGate(
    publishState(
      greenManifest({
        claims_extraction_status: "no_load_bearing_claims",
        claims: [],
        no_claims_justification:
          "Purely procedural how-to content; no quantitative figures, named entities, or factual premises drive any conclusion.",
      }),
    ),
  );
  assert.equal(res.ok, true);
});

test("no_load_bearing_claims WITHOUT a substantive justification blocks (S108 Gemini G4)", () => {
  for (const just of [undefined, "", "trust me", "   "]) {
    const m = greenManifest({ claims_extraction_status: "no_load_bearing_claims", claims: [] });
    if (just !== undefined) m.no_claims_justification = just;
    const res = evaluatePublishGate(publishState(m));
    assert.equal(res.ok, false, `justification=${JSON.stringify(just)} should block`);
    assert.ok(res.reasons.some((r) => r.includes("no_claims_justification")));
  }
});

// ── Vendor-leg failures (the S100 root cause) ───────────────────────

test("Perplexity-401: failed perplexity leg HARD BLOCKS", () => {
  const m = greenManifest();
  m.vendor_legs.perplexity = { status: "failed", detail: "401 insufficient_quota" };
  const res = evaluatePublishGate(publishState(m));
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r) => r.includes('"perplexity"') && r.includes("failed")));
});

test("WebSearch fallback: degraded perplexity leg HARD BLOCKS (fallback is not a substitute)", () => {
  const m = greenManifest();
  m.vendor_legs.perplexity = { status: "degraded", detail: "WebSearch fallback" };
  const res = evaluatePublishGate(publishState(m));
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r) => r.includes("WebSearch fallback")));
});

test("skipped notebooklm leg blocks; missing claude leg blocks", () => {
  const skipped = greenManifest();
  skipped.vendor_legs.notebooklm = { status: "skipped" };
  assert.equal(evaluatePublishGate(publishState(skipped)).ok, false);

  const missing = greenManifest() as unknown as Record<string, unknown>;
  delete (missing.vendor_legs as Record<string, unknown>).claude;
  const res = evaluatePublishGate(publishState(missing));
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r) => r.includes('"claude" missing')));
});

// ── Manifest-shape failures (fail closed) ───────────────────────────

test("missing manifest blocks (null, undefined, and absent field)", () => {
  assert.equal(evaluatePublishGate(publishState(null)).ok, false);
  assert.equal(evaluatePublishGate(publishState(undefined)).ok, false);
  assert.equal(evaluatePublishGate({ publish_required: true } as PipelineState).ok, false);
  assert.equal(evaluatePublishGate(null).ok, false);
});

test("non-object manifest / non-array claims / missing vendor_legs all block", () => {
  assert.equal(evaluatePublishGate(publishState("passed")).ok, false);
  assert.equal(evaluatePublishGate(publishState(["passed"])).ok, false);
  assert.equal(evaluatePublishGate(publishState(greenManifest({ claims: "lots" as unknown as VerifiedClaim[] }))).ok, false);
  const noLegs = greenManifest() as unknown as Record<string, unknown>;
  delete noLegs.vendor_legs;
  assert.equal(evaluatePublishGate(publishState(noLegs)).ok, false);
});

test("verification_status failed / not_run / absent blocks", () => {
  assert.equal(evaluatePublishGate(publishState(greenManifest({ verification_status: "failed" }))).ok, false);
  assert.equal(evaluatePublishGate(publishState(greenManifest({ verification_status: "not_run" }))).ok, false);
  const absent = greenManifest() as unknown as Record<string, unknown>;
  delete absent.verification_status;
  assert.equal(evaluatePublishGate(publishState(absent)).ok, false);
});

// ── Claims-extraction consistency ───────────────────────────────────

test("empty-claims: populated extraction with zero claims blocks", () => {
  const res = evaluatePublishGate(publishState(greenManifest({ claims: [] })));
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r) => r.includes("empty") && r.includes("populated")));
});

test("no_load_bearing_claims with claims present blocks (inconsistent)", () => {
  const res = evaluatePublishGate(
    publishState(greenManifest({ claims_extraction_status: "no_load_bearing_claims" })),
  );
  assert.equal(res.ok, false);
});

test("invalid claims_extraction_status blocks", () => {
  const res = evaluatePublishGate(
    publishState(greenManifest({ claims_extraction_status: "skipped" as "populated" })),
  );
  assert.equal(res.ok, false);
});

test("claim-count sanity bound blocks pathological manifests", () => {
  const res = evaluatePublishGate(
    publishState(greenManifest({ claims: Array.from({ length: 501 }, () => greenClaim()) })),
  );
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r) => r.includes("sanity bound")));
});

// ── Per-claim field gating ──────────────────────────────────────────

test("missing-anchor: claim without asOfDate blocks; non-ISO anchor blocks", () => {
  for (const asOfDate of ["", "soon", "June 2026", "2026-99-99", "2026-02-30", "2026-06-10 plus junk"]) {
    const res = evaluatePublishGate(publishState(greenManifest({ claims: [greenClaim({ asOfDate })] })));
    assert.equal(res.ok, false, `asOfDate="${asOfDate}" should block`);
    assert.ok(res.reasons.some((r) => r.includes("temporal anchor")));
  }
});

test("unsourced claim blocks: empty sourceUrls / sourceDates / quality / independence / counter-evidence", () => {
  const cases: Array<Partial<VerifiedClaim>> = [
    { sourceUrls: [] },
    { sourceUrls: ["  "] },
    { sourceDates: [] },
    { sourceQualityClass: "" as VerifiedClaim["sourceQualityClass"] },
    { upstreamIndependenceBasis: " " },
    { counterEvidenceNotes: "" },
    { text: "" },
  ];
  for (const c of cases) {
    const res = evaluatePublishGate(publishState(greenManifest({ claims: [greenClaim(c)] })));
    assert.equal(res.ok, false, `${JSON.stringify(c)} should block`);
  }
});

test("junk source metadata blocks: non-URL sources, undated sources, free-form quality class (S108 Codex C5)", () => {
  const cases: Array<Partial<VerifiedClaim>> = [
    { sourceUrls: ["not a url"] },
    { sourceUrls: ["ftp://example.com/x"] },
    { sourceUrls: ["https://"] },
    { sourceDates: ["recently"] },
    { sourceDates: ["2026-99-99 (published)"] },
    { sourceQualityClass: "made-up" as VerifiedClaim["sourceQualityClass"] },
    { sourceQualityClass: "very reputable" as VerifiedClaim["sourceQualityClass"] },
  ];
  for (const c of cases) {
    const res = evaluatePublishGate(publishState(greenManifest({ claims: [greenClaim(c)] })));
    assert.equal(res.ok, false, `${JSON.stringify(c)} should block`);
  }
  // all four legitimate quality classes pass
  for (const sourceQualityClass of ["primary", "official", "reputable-secondary", "weak"] as const) {
    const res = evaluatePublishGate(
      publishState(greenManifest({ claims: [greenClaim({ sourceQualityClass })] })),
    );
    assert.equal(res.ok, true, `${sourceQualityClass} should pass`);
  }
});

test("refuted / unverifiable / missing verdict blocks; verified_with_caveat passes", () => {
  for (const verdict of ["refuted", "unverifiable", undefined] as const) {
    const claim = greenClaim();
    if (verdict === undefined) {
      delete (claim as unknown as Record<string, unknown>).verdict;
    } else {
      claim.verdict = verdict;
    }
    assert.equal(evaluatePublishGate(publishState(greenManifest({ claims: [claim] }))).ok, false);
  }
  assert.equal(
    evaluatePublishGate(
      publishState(greenManifest({ claims: [greenClaim({ verdict: "verified_with_caveat" })] })),
    ).ok,
    true,
  );
});

test("one bad claim among many blocks, and the reason names its index", () => {
  const res = evaluatePublishGate(
    publishState(greenManifest({ claims: [greenClaim(), greenClaim({ asOfDate: "" }), greenClaim()] })),
  );
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r) => r.includes("claim[1]")));
});

// ── readUrgentBypass ────────────────────────────────────────────────

test("readUrgentBypass: absent file → present:false; valid file parses", async () => {
  const dir = await tmpBypassDir();
  assert.deepEqual(await readUrgentBypass(dir, JOB_ID), { present: false });

  await fs.writeFile(path.join(dir, `${JOB_ID}.txt`), `# operator note\n${VALID_SIGNOFF}\n`);
  const read = await readUrgentBypass(dir, JOB_ID);
  assert.equal(read.present && read.valid, true);
  if (read.present && read.valid) assert.equal(read.signoffLine, VALID_SIGNOFF);
});

test("readUrgentBypass: malformed lines are invalid (EMERGENCY mode, missing fields, no line)", async () => {
  const dir = await tmpBypassDir();
  const bad = [
    "RISK-ACCEPTED-BY: David | mode=EMERGENCY | reason=x | followup-due=2026-06-12", // PUBLISH bypass is URGENT-only
    "RISK-ACCEPTED-BY: David | mode=URGENT | reason=x", // no followup-due
    "RISK-ACCEPTED-BY: | mode=URGENT | reason=x | followup-due=2026-06-12", // no name
    "approved, go ahead", // no sign-off line at all
  ];
  for (const line of bad) {
    await fs.writeFile(path.join(dir, `${JOB_ID}.txt`), line);
    const read = await readUrgentBypass(dir, JOB_ID);
    assert.equal(read.present, true, line);
    assert.equal(read.present && read.valid, false, line);
  }
});

test("readUrgentBypass: non-UUID job ids never touch the filesystem", async () => {
  const read = await readUrgentBypass("/nonexistent-dir-anywhere", "../../etc/passwd");
  assert.deepEqual(read, { present: false });
});

// ── evaluatePublishGateForJob (executor entry point) ────────────────

test("ForJob: non-publish job is not applicable and passes", async () => {
  const dir = await tmpBypassDir();
  const res = evaluatePublishGateForJob(jobWith(undefined), publishState(null, { publish_required: false }), await readUrgentBypass(dir, JOB_ID));
  assert.deepEqual(res, { applicable: false, ok: true, bypassed: false, reasons: [] });
});

test("ForJob: publish job with green manifest passes without bypass", async () => {
  const dir = await tmpBypassDir();
  const res = evaluatePublishGateForJob(jobWith(true), publishState(greenManifest()), await readUrgentBypass(dir, JOB_ID));
  assert.equal(res.applicable, true);
  assert.equal(res.ok, true);
  assert.equal(res.bypassed, false);
});

test("URGENT-without-signoff: publish job with failing manifest and no sign-off blocks", async () => {
  const dir = await tmpBypassDir();
  const m = greenManifest({ verification_status: "failed" });
  const res = evaluatePublishGateForJob(jobWith(true), publishState(m), await readUrgentBypass(dir, JOB_ID));
  assert.equal(res.ok, false);
  assert.equal(res.bypassed, false);
});

test("ForJob: valid URGENT sign-off + >=1 live leg bypasses, preserving accepted defects", async () => {
  const dir = await tmpBypassDir();
  await fs.writeFile(path.join(dir, `${JOB_ID}.txt`), VALID_SIGNOFF);
  const m = greenManifest({ verification_status: "failed" }); // legs still all ok
  const res = evaluatePublishGateForJob(jobWith(true), publishState(m), await readUrgentBypass(dir, JOB_ID));
  assert.equal(res.ok, true);
  assert.equal(res.bypassed, true);
  assert.ok(res.reasons.length > 0);
  assert.equal(res.signoffLine, VALID_SIGNOFF);
});

test("ForJob: valid sign-off but ALL legs dead still blocks (one LIVE grounded path required)", async () => {
  const dir = await tmpBypassDir();
  await fs.writeFile(path.join(dir, `${JOB_ID}.txt`), VALID_SIGNOFF);
  const m = greenManifest({
    verification_status: "failed",
    vendor_legs: {
      perplexity: { status: "failed", detail: "401" },
      notebooklm: { status: "degraded" },
      claude: { status: "skipped" },
    },
  });
  const res = evaluatePublishGateForJob(jobWith(true), publishState(m), await readUrgentBypass(dir, JOB_ID));
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r) => r.includes("LIVE grounded verification path")));
});

test("ForJob: malformed sign-off file is surfaced in the block reasons", async () => {
  const dir = await tmpBypassDir();
  await fs.writeFile(path.join(dir, `${JOB_ID}.txt`), "approved, go ahead");
  const res = evaluatePublishGateForJob(jobWith(true), publishState(null), await readUrgentBypass(dir, JOB_ID));
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r) => r.includes("risk-acceptance file rejected")));
});

test("ForJob: missing manifest on a publish job blocks (fail closed, e.g. studio_only without state)", async () => {
  const dir = await tmpBypassDir();
  const res = evaluatePublishGateForJob(jobWith(true), null, await readUrgentBypass(dir, JOB_ID));
  assert.equal(res.applicable, true);
  assert.equal(res.ok, false);
});

// ── buildManifest seeding ───────────────────────────────────────────

function manifestJob(publishRequired?: boolean): ResearchJob {
  return {
    id: JOB_ID,
    created_at: "2026-06-11T00:00:00.000Z",
    updated_at: "2026-06-11T00:00:00.000Z",
    status: "running",
    claimed_at: null,
    completed_at: null,
    error_message: null,
    topic: "publish gate seeding",
    topic_slug: "publish-gate-seeding-abc12345",
    user_context: {
      domainKnowledge: [],
      constraints: [],
      additionalUrls: [],
      claimsToVerify: [],
      ...(publishRequired === undefined ? {} : { publishRequired }),
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
    selected_products: { audio: false, video: false, slides: false, report: true, infographic: false },
    customizations: {
      perplexity: { queryFraming: "", emphasis: [], outputStructure: "" },
      notebookLM: { persona: "", researchMode: "deep", priorities: [] },
      studio: {},
    },
    notify_email: null,
    current_phase: "0",
    phase_status: "queued",
    progress_pct: 0,
    estimated_minutes: null,
    result_slug: null,
    organization_id: "0a1b2c3d-0a1b-4c3d-8e9f-0a1b2c3d4e5f",
  };
}

test("buildManifest seeds publish_required from the job flag and a null manifest", () => {
  const on = buildManifest(manifestJob(true)) as Record<string, unknown>;
  assert.equal(on.publish_required, true);
  assert.equal(on.publish_verification, null);

  const off = buildManifest(manifestJob()) as Record<string, unknown>;
  assert.equal(off.publish_required, false);
  assert.equal(off.publish_verification, null);
});

test("buildManifest urgent_signoff_present reflects the operator sign-off file (S108 Gemini G1)", async () => {
  // Default: no sign-off file for this job id anywhere → false.
  const absent = buildManifest(manifestJob(true)) as Record<string, unknown>;
  assert.equal(absent.urgent_signoff_present, false);

  // With the file present in the (env-unset) cwd-derived dir → true.
  // PUBLISH_RISK_ACCEPT_DIR defaults to <cwd>/.publish-risk-accepted at module
  // load; create the marker there, assert, and clean up (dir is gitignored).
  const dir = process.env.PUBLISH_RISK_ACCEPT_DIR ?? path.join(process.cwd(), ".publish-risk-accepted");
  const file = path.join(dir, `${JOB_ID}.txt`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, VALID_SIGNOFF);
  try {
    const present = buildManifest(manifestJob(true)) as Record<string, unknown>;
    assert.equal(present.urgent_signoff_present, true);
  } finally {
    await fs.rm(file, { force: true });
  }
});
