/**
 * S115 — buildPrompt PUBLISH-gate brief reinforcement.
 *
 * Job 9a1b7b30 (S113) reached terminal "complete" but the worker's publish
 * gate (agent/lib/publish-gate.ts) fail-closed: the executing model drifted
 * off the /research-compare publish_verification contract (emitted a `status`
 * field + flat string legs instead of `verification_status` +
 * `vendor_legs.{leg}.status`) and proxied the NotebookLM leg through Claude
 * because it looked for a non-existent "NLM MCP". The fix injects the exact
 * gate contract + NLM-leg clarification into the spawn brief, but ONLY for
 * publish-required jobs. These tests pin both the presence (publishRequired)
 * and the absence (default job) of the reinforcement block.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "../lib/job-manifest.js";
import type { ResearchJob } from "../types.js";

function baseJob(): ResearchJob {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    created_at: "2026-06-12T00:00:00.000Z",
    updated_at: "2026-06-12T00:00:00.000Z",
    status: "running",
    claimed_at: null,
    completed_at: null,
    error_message: null,
    topic: "test topic",
    topic_slug: "test-topic-deadbeef",
    user_context: {
      domainKnowledge: [],
      constraints: [],
      additionalUrls: [],
      claimsToVerify: [],
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
    current_phase: "Preflight",
    phase_status: "queued",
    progress_pct: 0,
    estimated_minutes: null,
    result_slug: null,
    organization_id: "4ece2f20-f2fc-4f8f-afce-59806d92a11b",
    attachments: [],
  };
}

function publishJob(): ResearchJob {
  const j = baseJob();
  j.user_context = { ...j.user_context, publishRequired: true };
  return j;
}

const MANIFEST = "C:/tmp/x/job-manifest.json";

test("prompt: PUBLISH block present and contract-faithful when publishRequired=true", () => {
  const p = buildPrompt(publishJob(), MANIFEST);
  assert.ok(p.includes("PUBLISH-REQUIRED RUN (fail-closed)"), "missing PUBLISH-REQUIRED header");
  // Exact gate field names (publish-gate.ts reads these verbatim).
  assert.ok(p.includes("verification_status"), "missing verification_status key");
  assert.ok(p.includes("vendor_legs"), "missing vendor_legs key");
  assert.ok(p.includes("claims_extraction_status"), "missing claims_extraction_status key");
  // All three legs named.
  for (const leg of ["perplexity", "notebooklm", "claude"]) {
    assert.ok(p.includes(`"${leg}"`), `missing vendor leg "${leg}"`);
  }
  // Per-claim required fields the gate validates (publish-gate.ts validateClaim).
  for (const field of [
    "text",
    "asOfDate",
    "sourceUrls",
    "sourceDates",
    "sourceQualityClass",
    "upstreamIndependenceBasis",
    "counterEvidenceNotes",
    "verdict",
  ]) {
    assert.ok(p.includes(field), `missing claim field ${field}`);
  }
  // S115 Codex Finding 2: pin the structural keys the gate parses (claims
  // array literal, leg .status, the no_load_bearing_claims justification) so a
  // future reword can't silently drop them.
  assert.ok(p.includes('"claims": ['), "missing inline claims array literal");
  assert.ok(p.includes('"status"'), "missing vendor-leg status key");
  assert.ok(p.includes("no_claims_justification"), "missing no_claims_justification key");
  // S115 Codex Finding 2 guard: the brief must NOT reintroduce the job-9a1b7b30
  // drift shape (a top-level `status: "DEGRADED_LEG"` instead of the nested
  // verification_status + vendor_legs.{leg}.status contract).
  assert.ok(!/"status":\s*"DEGRADED/i.test(p), "brief reintroduces the top-level DEGRADED status drift shape");
  assert.ok(p.includes("verification_status"), "top-level verdict key must be verification_status, not a bare status");
  // The NLM-leg drift fix: CLI not MCP, no proxy.
  assert.ok(p.includes("`notebooklm` CLI"), "missing notebooklm CLI clarification");
  assert.ok(/NO NotebookLM MCP/i.test(p), "missing 'no NLM MCP' clarification");
  assert.ok(/proxy/i.test(p), "missing anti-proxy directive");
  assert.ok(p.includes("Step A.5"), "missing Step A.5 reference");
  // S115 Gemini Finding 1: refuted/unverifiable claims must NOT enter claims[]
  // (the gate accepts only verified/verified_with_caveat there) — the brief
  // must give a schema-compliant path for failing claims, not just successes.
  assert.ok(p.includes("refuted"), "missing refuted-claim handling");
  assert.ok(p.includes("unverifiable"), "missing unverifiable-claim handling");
  assert.ok(/claim verification failed/i.test(p), "missing fail-closed claim-verification exit path");
  // S116: job 9a1b7b30 re-run drift — the model dated one source "2022-09"
  // (month only); the gate's containsRealIsoDate (/\d{4}-\d{2}-\d{2}/ + real-
  // calendar validation) rejects it as "missing dated source publication/access
  // entries". The brief must require a FULL YYYY-MM-DD per sourceDates entry,
  // forbid month/year-only, AND — per the S116 Gemini BLOCK — preserve source
  // quality (never drop/swap a strong source to satisfy the format; access date
  // keeps the original). These assertions scope to tokens UNIQUE to the new
  // directive (S116 Codex test nit: plain includes("YYYY-MM-DD") was already
  // true from the schema example and pinned nothing).
  assert.ok(/EVERY entry in each claim's `sourceDates` array MUST contain a FULL calendar date/.test(p), "missing full-date sourceDates directive");
  assert.ok(p.includes("2022-09"), "missing month-only rejected example");
  assert.ok(p.includes('annotated "(accessed)"'), "missing access-date fallback (quality-preserving path)");
  assert.ok(/NEVER drop or swap a stronger source for a weaker one/.test(p), "missing anti-source-downgrade guardrail (Gemini BLOCK fix)");
  assert.ok(/NEVER fabricate or guess a day/.test(p), "missing anti-fabrication guardrail");
  assert.ok(/validates it as a REAL calendar date/.test(p), "missing real-calendar-date fidelity (Codex nit: 2026-13-40 must not pass)");
});

test('prompt: PUBLISH block present for a DB-stringified flag "TRUE" (S120 flag-only harmonization)', () => {
  // S120 Codex C4: buildPrompt keys off the durable job flag via the canonical
  // predicate (isPublishRequired(job, null)), not the prior strict `=== true`.
  // A direct-DB-insert string flag "TRUE" (bypasses zod) must still inject the
  // brief, matching the lenient completion gate.
  const j = baseJob();
  (j.user_context as unknown as Record<string, unknown>).publishRequired = "TRUE";
  const p = buildPrompt(j, MANIFEST);
  assert.ok(p.includes("PUBLISH-REQUIRED RUN (fail-closed)"), "PUBLISH block missing for DB string 'TRUE' flag");
  assert.ok(p.includes("verification_status"), "missing verification_status key for string flag");
});

test('prompt: PUBLISH block absent for a rejected non-boolean flag "on" (strict boundary)', () => {
  // "on" is NOT accepted by the canonical predicate — a raw-checkbox value
  // normalizes at its own endpoint, never silently engages the gate here.
  const j = baseJob();
  (j.user_context as unknown as Record<string, unknown>).publishRequired = "on";
  const p = buildPrompt(j, MANIFEST);
  assert.ok(!p.includes("PUBLISH-REQUIRED RUN"), "PUBLISH block leaked for rejected 'on' flag");
});

test("prompt: PUBLISH block absent for a non-publish job (default)", () => {
  const p = buildPrompt(baseJob(), MANIFEST);
  assert.ok(!p.includes("PUBLISH-REQUIRED RUN"), "PUBLISH block leaked into a non-publish brief");
  assert.ok(!p.includes("vendor_legs"), "vendor_legs leaked into a non-publish brief");
});

test("prompt: PUBLISH block absent when publishRequired is explicitly false", () => {
  const j = baseJob();
  j.user_context = { ...j.user_context, publishRequired: false };
  const p = buildPrompt(j, MANIFEST);
  assert.ok(!p.includes("PUBLISH-REQUIRED RUN"), "PUBLISH block emitted for publishRequired=false");
});

// ── S193 Fix A (L1) — anti-stop CRITICAL emission ────────────────────
// The Class-A failure: the `claude -p` pipeline agent ends its turn while an
// async NotebookLM op (Phase-3 corpus import / Studio render) is still pending,
// writes a "finalizing in background" phase_status, and stops — the completion
// gate then hard-fails a near-complete job (4 confirmed prod events incl. ConQr
// 3ce18f2c). L1 injects a top-level anti-stop CRITICAL that is ALWAYS-emitted
// (Class A struck NON-publish jobs, so a publish-gated placement would leave the
// exact failing shape unprotected). These tests pin the always-emit + the
// ordering-outside-publishBlock invariant the MERGE gate flagged as key targets.

test("prompt: anti-stop CRITICAL present for a NON-publish job (ALWAYS-emitted, outside publishBlock)", () => {
  const p = buildPrompt(baseJob(), MANIFEST);
  // The exact failing shape was a non-publish job — this is the load-bearing assertion.
  assert.ok(p.includes("NON-INTERACTIVE SINGLE-SHOT EXECUTION"), "anti-stop CRITICAL missing from a non-publish brief");
  assert.ok(
    /MUST NOT end your turn while ANY asynchronous NotebookLM operation/.test(p),
    "anti-stop core directive missing",
  );
  // Names BOTH pending-op classes the failures came from.
  assert.ok(p.includes("wait=False"), "missing Phase-3 corpus-import (wait=False) specificity");
  assert.ok(/Studio render \(audio\/video\/slides\/infographic\)/.test(p), "missing Studio-render pending-op class");
  // Fail-forward (never fail-open on completion) + the bounded-poll cross-ref to the slash prompt.
  assert.ok(p.includes("FAIL FORWARD"), "missing fail-forward directive");
  assert.ok(p.includes("Phase 5.5 Step A.1"), "missing cross-reference to the bounded corpus-import poll");
  // The confirming clause that "background" is a WAIT point, not a stop.
  assert.ok(/NEVER a valid stopping point/.test(p), "missing 'background is not a stopping point' clause");
});

test("prompt: anti-stop CRITICAL present for a publish-required job too (both branches)", () => {
  const p = buildPrompt(publishJob(), MANIFEST);
  assert.ok(p.includes("NON-INTERACTIVE SINGLE-SHOT EXECUTION"), "anti-stop CRITICAL missing from a publish brief");
  assert.ok(p.includes("PUBLISH-REQUIRED RUN (fail-closed)"), "publish block should still be present");
});

test("prompt: anti-stop CRITICAL is emitted BEFORE (outside) the publishBlock", () => {
  // A publish-gated placement would leave the exact Class-A shape (non-publish)
  // unprotected — assert the anti-stop block lives in the always-emitted region,
  // ahead of the conditionally-appended publish block.
  const p = buildPrompt(publishJob(), MANIFEST);
  const antiStopIdx = p.indexOf("NON-INTERACTIVE SINGLE-SHOT EXECUTION");
  const publishIdx = p.indexOf("PUBLISH-REQUIRED RUN (fail-closed)");
  assert.ok(antiStopIdx > 0, "anti-stop CRITICAL not found");
  assert.ok(publishIdx > 0, "publish block not found");
  assert.ok(antiStopIdx < publishIdx, "anti-stop CRITICAL must precede the publishBlock (proves it is outside it)");
});
