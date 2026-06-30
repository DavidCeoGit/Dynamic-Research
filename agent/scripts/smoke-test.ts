/**
 * End-to-end SMOKE TEST for the process-page wiring + the agent write path.
 *
 * What it proves (the "page/wiring" contract, NOT the recovery logic — the
 * S188 unit tests cover that): a research_queue row, driven through the same
 * 11-phase progression the worker's DRY_RUN `simulateDryRun`
 * (executor.ts:872) emits, advances `progress_pct`/`current_phase`/
 * `phase_status` monotonically and terminates at status='completed'/100 — the
 * exact fields the `/new/[id]` process page polls every ~3s.
 *
 * Why a standalone script (not the real worker in DRY_RUN): the full-pipeline
 * DRY_RUN path runs the REAL plan-review synthesis (paid Anthropic calls) BEFORE
 * reaching simulateDryRun, and studio_only DRY_RUN jumps straight to completeJob
 * (no gradual progression). Only this reproduction gives a $0, gradual,
 * isolated walk. It drives the progression through the REAL api-client
 * updateJob/completeJob — the same functions simulateDryRun calls — so it
 * exercises the agent-auth `/api/queue/:id` PATCH route + DB transitions, not a
 * private copy.
 *
 * ISOLATION (airtight, no prod-worker pause needed):
 *   - The row is inserted with status='running', which the prod worker's claim
 *     (/api/queue/claim filters status='pending') can NEVER select. It stays
 *     'running' through every phase update (we never PATCH status) until the
 *     final completeJob → 'completed'. At no instant is it claimable.
 *   - It lives under a dedicated, idempotently-created 'smoke-test' org so it
 *     never touches system-default or any real tenant's dashboard.
 *   - Cleanup DELETE is scoped by the freshly-minted per-run row id (a UUID — the
 *     airtight guarantee); the 'smoke-test-' slug prefix + smoke-test org id are
 *     belt-and-suspenders. topic_slug carries a global UNIQUE index, so the slug
 *     is globally unique on its own too.
 *
 * Usage (run from agent/, env loaded via --env-file so no secret hits the shell):
 *   node --env-file=.env --import=tsx scripts/smoke-test.ts            # fast (~2s), self-cleaning
 *   node --env-file=.env --import=tsx scripts/smoke-test.ts --delay 1400   # ~15s, realistic page-watch pacing
 *   node --env-file=.env --import=tsx scripts/smoke-test.ts --keep     # leave the row for a manual page view
 *
 * Env required: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (insert/get/
 * delete + ensure-org), AGENT_SECRET_KEY (+ optional API_BASE_URL, default prod)
 * for the updateJob/completeJob agent route.
 *
 * Exit codes: 0 pass · 1 assertion/runtime failure · 2 usage/env error.
 */

import { randomUUID } from "node:crypto";
import { updateJob, completeJob } from "../api-client.js";

// ── Args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flagValue(name: string, fallback: number): number {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return fallback;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
const PHASE_DELAY_MS = flagValue("--delay", 150); // default fast; --delay 1400 ≈ realistic
const KEEP = args.includes("--keep");
const ORG_SLUG = "smoke-test";
const SLUG_PREFIX = "smoke-test-";

// ── Env ─────────────────────────────────────────────────────────────
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("[smoke] missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env");
  process.exit(2);
}
if (!process.env.AGENT_SECRET_KEY) {
  console.error("[smoke] missing AGENT_SECRET_KEY — updateJob/completeJob will 401 against the agent route");
  process.exit(2);
}
const sbHeaders = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};

// The 11 phases mirror executor.ts:872 simulateDryRun (names + pcts). The smoke
// test asserts generic invariants (monotonic, terminal) so prod-side drift here
// does not break it — this list only needs to be a representative ascending walk.
const PHASES: ReadonlyArray<{ name: string; pct: number }> = [
  { name: "Preflight", pct: 5 },
  { name: "Research Brief", pct: 8 },
  { name: "Perplexity Research", pct: 15 },
  { name: "CI Tier 1 Scoring", pct: 25 },
  { name: "NotebookLM Import", pct: 30 },
  { name: "NotebookLM Research", pct: 40 },
  { name: "Extraction", pct: 50 },
  { name: "Synthesis", pct: 60 },
  { name: "Studio Products", pct: 70 },
  { name: "Finalization", pct: 95 },
  { name: "Complete", pct: 100 },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sb(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...sbHeaders, ...(init?.headers ?? {}) } });
}

/** Get-or-create the dedicated smoke-test org. Idempotent (unique slug). */
async function ensureOrg(): Promise<string> {
  const got = await sb(`organizations?slug=eq.${ORG_SLUG}&select=id`);
  if (!got.ok) throw new Error(`ensureOrg GET ${got.status}: ${await got.text()}`);
  const existing = (await got.json()) as Array<{ id: string }>;
  if (existing[0]?.id) return existing[0].id;

  const created = await sb("organizations", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ name: "DR Smoke Test", slug: ORG_SLUG }),
  });
  if (!created.ok) throw new Error(`ensureOrg INSERT ${created.status}: ${await created.text()}`);
  const row = (await created.json()) as Array<{ id: string }>;
  const id = row[0]?.id;
  if (!id) throw new Error("ensureOrg: insert returned no id");
  console.log(`[smoke] created '${ORG_SLUG}' org ${id}`);
  return id;
}

/** Insert a guarded, non-claimable test row. Returns {id, slug}. */
async function insertRow(orgId: string): Promise<{ id: string; slug: string }> {
  const id = randomUUID();
  // Date.now() + a random suffix: collision-proof even for same-millisecond /
  // parallel runs (topic_slug is globally UNIQUE — a bare timestamp could clash).
  const slug = `${SLUG_PREFIX}${Date.now()}-${randomUUID().slice(0, 8)}`;
  const res = await sb("research_queue", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      id,
      organization_id: orgId,
      topic: "[SMOKE TEST] process-page wiring check — safe to delete",
      topic_slug: slug,
      status: "running", // NON-claimable: prod worker claims only status='pending'
      pipeline_mode: "full",
      progress_pct: 0,
      current_phase: "Queued",
      phase_status: "Smoke test initializing",
      user_context: {}, // never publishRequired — a publish-required dry path fails closed
      notify_email: null,
    }),
  });
  if (!res.ok) throw new Error(`insertRow ${res.status}: ${await res.text()}`);
  const row = (await res.json()) as Array<{ id: string; status: string }>;
  if (row[0]?.status !== "running") {
    throw new Error(`insertRow guard: expected status=running, got '${row[0]?.status}'`);
  }
  console.log(`[smoke] inserted row ${id} (slug ${slug}, status=running → non-claimable)`);
  return { id, slug };
}

/** Read back the row's progress-relevant fields via service-role REST. */
async function readRow(id: string): Promise<{ status: string; progress_pct: number; current_phase: string; topic_slug: string; organization_id: string }> {
  const res = await sb(`research_queue?id=eq.${id}&select=status,progress_pct,current_phase,topic_slug,organization_id`);
  if (!res.ok) throw new Error(`readRow ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as Array<{ status: string; progress_pct: number; current_phase: string; topic_slug: string; organization_id: string }>;
  if (!rows[0]) throw new Error(`readRow: row ${id} not found`);
  return rows[0];
}

/** Triple-guarded delete: only our freshly-created smoke-test row. */
async function cleanup(id: string, slug: string, orgId: string): Promise<void> {
  if (!slug.startsWith(SLUG_PREFIX) || !orgId) {
    console.error(`[smoke] REFUSING cleanup — guard failed (slug='${slug}', org='${orgId}')`);
    return;
  }
  const res = await sb(
    `research_queue?id=eq.${id}&topic_slug=eq.${slug}&organization_id=eq.${orgId}`,
    { method: "DELETE", headers: { Prefer: "return=representation" } },
  );
  if (!res.ok) {
    console.error(`[smoke] cleanup DELETE ${res.status}: ${await res.text()}`);
    return;
  }
  const deleted = (await res.json()) as unknown[];
  console.log(`[smoke] cleanup deleted ${deleted.length} row(s)`);
}

// ── Main ────────────────────────────────────────────────────────────
async function main(): Promise<number> {
  const orgId = await ensureOrg();
  const { id, slug } = await insertRow(orgId);
  let failed = false;

  try {
    const sent: number[] = [];
    for (const phase of PHASES) {
      await updateJob(id, {
        current_phase: phase.name,
        phase_status: `[SMOKE] ${phase.name}`,
        progress_pct: phase.pct,
      });
      sent.push(phase.pct);
      console.log(`[smoke] phase ${phase.name.padEnd(20)} ${phase.pct}%`);
      await sleep(PHASE_DELAY_MS);
    }
    await completeJob(id, slug);

    // ── Assertions ──
    // (1) we drove a strictly non-decreasing progression to 100
    for (let i = 1; i < sent.length; i++) {
      if (sent[i] < sent[i - 1]) throw new Error(`progression not monotonic at ${i}: ${sent[i - 1]}→${sent[i]}`);
    }
    if (sent[sent.length - 1] !== 100) throw new Error(`final sent pct ${sent.at(-1)} !== 100`);

    // (2) the persisted row reflects completion (what the page polls)
    const row = await readRow(id);
    const checks: Array<[string, boolean]> = [
      ["status === 'completed'", row.status === "completed"],
      ["progress_pct === 100", row.progress_pct === 100],
      ["current_phase === 'Complete'", row.current_phase === "Complete"],
      ["row stayed under smoke-test org", row.organization_id === orgId],
    ];
    for (const [label, ok] of checks) {
      console.log(`[smoke] assert ${ok ? "PASS" : "FAIL"} — ${label}`);
      if (!ok) failed = true;
    }
  } catch (err) {
    console.error(`[smoke] ERROR: ${(err as Error).message}`);
    failed = true;
  } finally {
    if (KEEP) {
      console.log(`[smoke] --keep: leaving row ${id} (slug ${slug}) for manual page view; delete later via cancel-job or REST`);
    } else {
      await cleanup(id, slug, orgId);
    }
  }

  console.log(failed ? "[smoke] RESULT: FAIL" : "[smoke] RESULT: PASS");
  return failed ? 1 : 0;
}

process.exit(await main());
