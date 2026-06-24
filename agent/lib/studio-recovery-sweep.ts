/**
 * S158 — Decoupled studio-recovery sweep.
 *
 * The S129 studio-completeness gate (lib/studio-completeness.ts) hard-FAILS a
 * job when a selected studio product is CONFIRMED complete in NotebookLM
 * (status_id 3) but its binary download hits a TRANSIENT NLM blip (S156, job
 * f204631d). The executor now tags that one branch with the parallel
 * studio_recovery_* dimension (status stays 'failed', studio_recovery_status
 * 'pending') instead of treating it as terminal. THIS module is the out-of-band
 * sweep that self-heals it: it re-confirms the artifact is still status_id 3,
 * re-downloads it BY ID off the critical path, and — only after re-asserting the
 * full S129 obligation set via finalizeRecoveredRun() (Codex MAJOR-4 keystone) —
 * flips the job failed -> completed. A bounded attempt/age cap converts a
 * genuinely non-recovering artifact to a real hard-fail + one operator alert.
 *
 * SCHEDULING (design §7 — Gemini CRITICAL-1 + Codex MAJOR-1): NOT idle-only and
 * NOT poll-only. The worker runs maybeRunStudioRecoverySweep() BEFORE claimJob()
 * every 30s tick (so a busy queue can't starve a time-sensitive recovery) AND
 * before probeBackoff()'s early exit (so a long preflight-credit backoff window
 * can't starve it either — recovery touches only NLM ($0) + Supabase, never the
 * backed-off Anthropic provider). It is tightly bounded:
 *   - a cheap indexed eligibility query first (returns immediately when none due),
 *   - AT MOST 1 candidate per tick, paced per-job by studio_recovery_next_attempt_at,
 *   - a SHORTER per-download spawnSync timeout (~90s) so a due candidate adds at
 *     most ~one download timeout of new-job-claim latency (Codex MAJOR-2),
 *   - best-effort: NEVER throws/exits — a sweep failure must never crash the
 *     worker poll chain.
 *
 * Design: Documentation/studio-completeness-transient-tolerance-design-gate.md
 * (v3-FINAL). Injectable deps so the whole flow is unit-testable without
 * spawning the NLM CLI or hitting Supabase (test/studio-recovery-sweep.test.ts).
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import {
  realListArtifacts,
  realDownloadArtifact,
  type NlmArtifactRef,
  type DownloadResult,
} from "./studio-completeness.js";
import {
  finalizeRecoveredRun,
  defaultFinalizeDeps,
  type FinalizeArgs,
  type FinalizeResult,
} from "../scripts/finalize-recovered-run.js";
import { sendCompletionEmail, sendStudioRecoveryExhaustedEmail } from "./notify.js";
import type { StudioRecoveryPayload } from "../types.js";

// ── Tunables (env-guarded; a NaN/negative env can never make a cap infinite) ──

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const MAX_ATTEMPTS = envInt("STUDIO_RECOVERY_SWEEP_MAX_ATTEMPTS", 8);
const MIN_ATTEMPTS_FOR_AGE_EXHAUST = envInt(
  "STUDIO_RECOVERY_SWEEP_MIN_ATTEMPTS_FOR_AGE_EXHAUST",
  3,
);
const MAX_AGE_MS = envMs("STUDIO_RECOVERY_SWEEP_MAX_AGE_MS", 172_800_000); // 48h
const DOWNLOAD_TIMEOUT_MS = envMs("STUDIO_RECOVERY_SWEEP_DOWNLOAD_TIMEOUT_MS", 90_000);
const GRACE_MS = envMs("STUDIO_RECOVERY_SWEEP_GRACE_MS", 120_000); // 2 min
const PROJECTS_DIR =
  process.env.PROJECTS_DIR ??
  "/c/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/Projects";

// Exponential backoff (ms) indexed by attempts-so-far. Cumulative over the
// 8-attempt cap stays well under the 48h age window. Capped at the last entry.
const BACKOFF_SCHEDULE_MS = [
  300_000, // 5m
  900_000, // 15m
  2_700_000, // 45m
  7_200_000, // 2h
  14_400_000, // 4h
  28_800_000, // 8h
  43_200_000, // 12h
];

/** Backoff for the NEXT attempt given attempts-so-far (1-indexed). */
export function studioRecoveryBackoffMs(attempts: number): number {
  const idx = Math.max(0, Math.min(attempts - 1, BACKOFF_SCHEDULE_MS.length - 1));
  return BACKOFF_SCHEDULE_MS[idx];
}

// ── Shapes ──────────────────────────────────────────────────────────

export interface RecoveryCandidate {
  id: string;
  topic: string;
  topic_slug: string;
  notify_email: string | null;
  organization_id: string;
  studio_recovery_attempts: number;
  studio_recovery_first_failed_at: string | null;
  studio_recovery_payload: StudioRecoveryPayload | null;
}

export type ExhaustReason = "attempt-cap" | "age-cap" | "artifact-gone" | "payload-missing";
export type SweepOutcome = "none" | "recovered" | "retry" | "exhausted";

export interface RecoverySweepResult {
  ran: boolean;
  outcome?: SweepOutcome;
  jobId?: string;
  attempts?: number;
  exhaustReason?: ExhaustReason;
  detail?: string;
}

export interface RecoverySweepDeps {
  /** The single due recovery candidate (RLS-bypassing), or null when none due. */
  fetchDueCandidate: (nowIso: string, graceIso: string) => Promise<RecoveryCandidate | null>;
  /** Structurally-malformed pending rows (NULL anchor/next/payload or attempts<1)
   *  — invisible to the due-candidate query, so they'd sit non-terminal forever.
   *  C3 defense-in-depth (the migration CHECK is the primary guard). */
  fetchMalformedPending: () => Promise<RecoveryCandidate[]>;
  /** True iff a non-empty deliverable file already exists on disk (M5 — skip
   *  re-listing/re-downloading a pending product already recovered in a prior tick). */
  isFilePresent: (filePath: string) => Promise<boolean>;
  /** COMPLETED (status_id 3) artifacts of an NLM type, newest-first. */
  listArtifacts: (notebookId: string, nlmType: string) => NlmArtifactRef[] | null;
  /** Download a specific artifact BY ID to outPath (shorter sweep timeout). */
  downloadArtifact: (
    notebookId: string,
    artifactId: string,
    nlmType: string,
    outPath: string,
    timeoutMs?: number,
  ) => Promise<DownloadResult>;
  /** Upload + obligation-checked completed PATCH (the shared finalize core). */
  finalize: (args: FinalizeArgs) => Promise<FinalizeResult>;
  /** PATCH studio_recovery_* (+ error_message) columns (RLS-bypassing). */
  patchRecovery: (jobId: string, body: Record<string, unknown>) => Promise<boolean>;
  /** Notify the requester on heal (completion email). */
  sendCompleted: (args: { to: string; slug: string; topic: string }) => Promise<void>;
  /** Notify the requester on exhaustion (terminal failed email). */
  sendFailed: (args: { to: string; slug: string; topic: string; errorMessage: string }) => Promise<void>;
  /** Operator alert on exhaustion. */
  sendExhaustedAlert: (args: {
    jobId: string;
    slug: string;
    topic: string;
    attempts: number;
    reason: ExhaustReason;
    products: string[];
    ageHours: number;
  }) => Promise<void>;
  /** S161 R2-1 (optional, belt-and-suspenders): best-effort remove orphan `*.part`
   *  download temps from the candidate's deliverables dir (a kill mid-spawn or the
   *  artifact-gone branch can leave one). The `.part` ext is on the upload skip-list
   *  so an orphan can't reach the gallery; this keeps the reused dir tidy. Optional
   *  so existing test deps need not provide it; never throws. */
  removeOrphanParts?: (dir: string) => Promise<void>;
  /** Root deliverables dir; per-job dir is path.join(projectsDir, topic_slug). */
  projectsDir: string;
  now: () => number;
  log: (msg: string) => void;
}

// ── Core: recover (at most) one due candidate ───────────────────────

/**
 * Process the single due recovery candidate (if any). Returns a structured
 * outcome. Never throws on a recovery-domain failure — the caller's best-effort
 * wrapper additionally guards against any unexpected throw.
 */
export async function runStudioRecoverySweepOnce(
  deps: RecoverySweepDeps,
): Promise<RecoverySweepResult> {
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const graceIso = new Date(nowMs - GRACE_MS).toISOString();

  // C3 (defense-in-depth): a structurally-malformed pending row (NULL anchor /
  // next_attempt_at / payload, or attempts<1) is invisible to fetchDueCandidate's
  // predicate, so it would sit non-terminal forever while the UI hides terminal
  // controls. The migration 20260623 CHECK is the PRIMARY guard (prevents
  // creation); this quarantines any that somehow exist by flipping them to
  // exhausted (operator-alerted; no requester email — it is an integrity event).
  await quarantineMalformedPending(deps);

  const c = await deps.fetchDueCandidate(nowIso, graceIso);
  if (!c) return { ran: false };

  const payload = c.studio_recovery_payload;
  const newAttempts = (c.studio_recovery_attempts ?? 0) + 1;
  const firstFailedMs = c.studio_recovery_first_failed_at
    ? Date.parse(c.studio_recovery_first_failed_at)
    : NaN;
  const ageMs = Number.isFinite(firstFailedMs) ? nowMs - firstFailedMs : 0;
  const ageHours = Math.round((ageMs / 3_600_000) * 10) / 10;

  // Structurally-invalid payload (should never occur — the executor writes the
  // payload atomically with status='failed'+pending). Cannot recover ⇒ exhaust.
  // S162 (Codex grounded round-2 BLOCK): the check must validate EACH product
  // ELEMENT, not just the array. The sweep reads the row via service-role and CASTS
  // the DB jsonb to StudioRecoveryPayload with NO runtime validation, and the
  // migration CHECK only enforces `studio_recovery_payload IS NOT NULL` — NOT the
  // element shape. So a malformed row (e.g. `{notebookId, products:[null]}`) written
  // outside the validated agent route is reachable here; without per-element
  // validation the productNames `.map(p => p.product)` below (which is OUTSIDE the
  // structural backstop, because the cap/bump tail needs it) would throw and strand
  // the row forever. A malformed element is structurally unrecoverable ⇒ the existing
  // payload-missing exhaust (fast terminality + operator alert), never a strand.
  const productsWellFormed =
    !!payload &&
    Array.isArray(payload.products) &&
    payload.products.length > 0 &&
    payload.products.every(
      (p) =>
        p != null &&
        typeof p.product === "string" &&
        typeof p.artifactId === "string" &&
        typeof p.nlmType === "string" &&
        typeof p.filename === "string",
    );
  if (!payload || typeof payload.notebookId !== "string" || !payload.notebookId || !productsWellFormed) {
    return finishExhausted(deps, c, newAttempts, "payload-missing", [], ageHours);
  }

  // Null-safe derivation (defense-in-depth): even though the validation above now
  // guarantees well-formed products, keep this one line — the only throw-capable
  // derivation OUTSIDE the structural backstop — provably throw-proof regardless of
  // the validation, so a future validation gap can never re-open the strand here.
  const productNames = payload.products
    .map((p) => p?.product)
    .filter((x): x is string => typeof x === "string");

  // S162 (Codex grounded BLOCK — class-closing structural strand-guard): run the
  // entire recovery ATTEMPT (orphan-part cleanup, per-product on-disk-first
  // re-confirm/re-download, finalize) inside a try so that ANY unexpected throw from
  // a dep AFTER the candidate is selected — an arg-validation spawnSync throw from a
  // blank NLM_BIN (realListArtifacts / realDownloadArtifact), a path.join on an
  // unexpected NULL column, or any FUTURE un-try/caught dep — can NOT escape to the
  // OUTER maybeRunStudioRecoverySweep wrapper. That wrapper returns {ran:false}
  // BEFORE the attempt-bump patchRecovery + the caps below run, so a PERSISTENT throw
  // would strand the row non-terminal forever (attempts never bump, caps never trip;
  // the UI hides terminal controls). On any such throw we LOG and fall through to the
  // cap/bump tail, so attempts ALWAYS progress and the caps eventually exhaust —
  // making strand-while-healthy STRUCTURALLY impossible regardless of which dep
  // throws. attemptRecovery RETURNS a terminal result (recovered, or an artifact-gone
  // exhaust) or null ("not recovered — run the cap/bump tail"). The per-dep guards
  // (the finalize try/catch + the throw-safe spawn seams in studio-completeness.ts)
  // are the first line; this is the catch-all backstop. patchRecovery (the durability
  // write) is intentionally OUTSIDE this try — if it throws the DB is unreachable and
  // no local catch can record progress; that self-heals on reconnect, unlike a
  // strand-while-healthy.
  let recovered: RecoverySweepResult | null;
  try {
    recovered = await attemptRecovery(deps, c, payload, newAttempts, productNames, ageHours);
  } catch (err) {
    deps.log(
      `[studio-recovery] ${c.id}: UNEXPECTED throw during recovery attempt ` +
        `(${(err as Error).message}) — treating as continued-transient (caps backstop)`,
    );
    recovered = null;
  }
  if (recovered) return recovered;

  // Not recovered this pass. Cap checks (any breach → genuine hard-fail).
  if (newAttempts > MAX_ATTEMPTS) {
    return finishExhausted(deps, c, newAttempts, "attempt-cap", productNames, ageHours);
  }
  // AGE cap is ATTEMPTS-GATED (Codex MAJOR-1): wall-clock age alone must NOT
  // exhaust a job that was never actually tried (worker down / long backoff).
  if (ageMs > MAX_AGE_MS && newAttempts >= MIN_ATTEMPTS_FOR_AGE_EXHAUST) {
    return finishExhausted(deps, c, newAttempts, "age-cap", productNames, ageHours);
  }

  // Continued transient: bump attempts + schedule the next attempt. The
  // immutable studio_recovery_first_failed_at is LEFT UNTOUCHED (G6 — the age
  // anchor must not slide forward on a retry-PATCH).
  const nextIso = new Date(nowMs + studioRecoveryBackoffMs(newAttempts)).toISOString();
  await deps.patchRecovery(c.id, {
    studio_recovery_attempts: newAttempts,
    studio_recovery_next_attempt_at: nextIso,
  });
  deps.log(
    `[studio-recovery] ${c.id}: still pending — attempt ${newAttempts}, next at ${nextIso}`,
  );
  return { ran: true, outcome: "retry", jobId: c.id, attempts: newAttempts };
}

/**
 * One recovery ATTEMPT for an already-selected, payload-validated candidate:
 * best-effort orphan-part cleanup, per-product on-disk-first re-confirm + re-download,
 * and (on full presence) the obligation-checked finalize. Returns a TERMINAL
 * RecoverySweepResult (recovered, or an artifact-gone exhaust) OR null meaning "not
 * recovered this pass — the caller runs the cap/bump tail". Extracted from
 * runStudioRecoverySweepOnce so the caller can wrap the whole attempt in the S162
 * structural strand-guard: any UNEXPECTED throw here is caught by the caller and
 * converted to the cap/bump path, so a persistent throw can never strand the row.
 * Behaviour is otherwise byte-for-byte identical to the prior inline body.
 */
async function attemptRecovery(
  deps: RecoverySweepDeps,
  c: RecoveryCandidate,
  payload: StudioRecoveryPayload,
  newAttempts: number,
  productNames: string[],
  ageHours: number,
): Promise<RecoverySweepResult | null> {
  const projectsDir = path.join(deps.projectsDir, c.topic_slug);

  // S161 R2-1 (belt-and-suspenders): drop orphan `*.part` temps in the candidate
  // dir before this pass — the artifact-gone branch returns before any download,
  // and a prior kill mid-spawn can strand one. Best-effort; never throws.
  if (deps.removeOrphanParts) {
    await deps.removeOrphanParts(projectsDir).catch(() => undefined);
  }

  deps.log(
    `[studio-recovery] candidate ${c.id} (${c.topic_slug}) attempt ${newAttempts}/${MAX_ATTEMPTS} ` +
      `pending=[${productNames.join(",")}] age~${ageHours}h`,
  );

  // Per pending product (design §7). M5: check the on-disk file FIRST — a product
  // re-downloaded on a prior tick is already in hand, so we must NOT re-list (its
  // artifact id may have aged out of NLM's completed list) or re-download it; that
  // would lose partial recovery to a spurious artifact-gone exhaust. C1: a list
  // FAILURE (realListArtifacts → null on CLI status≠0 / parse error) is a TRANSIENT
  // blip, NOT proof the artifact is gone — treat it as a not-recovered pass (retry
  // via the caps), never an artifact-gone exhaust (that re-creates the exact S156
  // transient-kill this feature exists to prevent). Only a SUCCESSFUL list whose
  // completed set lacks our id (and no on-disk file) is a genuine artifact-gone.
  let allPresent = true;
  for (const product of payload.products) {
    const outPath = path.join(projectsDir, product.filename);
    if (await deps.isFilePresent(outPath)) {
      deps.log(
        `[studio-recovery] ${c.id}: ${product.product} already on disk (${product.filename}) — ` +
          `skipping re-list/re-download (M5)`,
      );
      continue;
    }
    const arts = deps.listArtifacts(payload.notebookId, product.nlmType);
    if (arts === null) {
      // C1: transient artifact-list failure — do NOT exhaust. Retry via the caps.
      allPresent = false;
      deps.log(
        `[studio-recovery] ${c.id}: artifact list FAILED for ${product.product} ` +
          `(transient) — will retry, not exhausting`,
      );
      continue;
    }
    const stillConfirmed = arts.some((a) => a.id === product.artifactId);
    if (!stillConfirmed) {
      // List SUCCEEDED, our id is absent, and the file isn't on disk ⇒ genuinely
      // gone: fast terminality (design §10), doesn't wait for the caps.
      deps.log(
        `[studio-recovery] ${c.id}: artifact ${product.artifactId} (${product.product}) no longer ` +
          `status_id 3 and not on disk — exhausting (artifact-gone)`,
      );
      return finishExhausted(deps, c, newAttempts, "artifact-gone", productNames, ageHours);
    }
    const dl = await deps.downloadArtifact(
      payload.notebookId,
      product.artifactId,
      product.nlmType,
      outPath,
      DOWNLOAD_TIMEOUT_MS,
    );
    if (dl.ok) {
      deps.log(`[studio-recovery] ${c.id}: re-downloaded ${product.product} → ${product.filename}`);
    } else {
      allPresent = false;
      deps.log(
        `[studio-recovery] ${c.id}: ${product.product} re-download still failing ` +
          `(exit=${dl.exitCode ?? "?"} signal=${dl.signal ?? "-"})`,
      );
    }
  }

  // Full recovery attempt: every pending product re-downloaded → finalize, which
  // re-asserts the FULL S129 obligation set (presentBefore + recovered) before it
  // can PATCH completed (Codex MAJOR-4 keystone). A refusal means an obliged
  // product is still absent on disk → treat as a continued-transient pass (the
  // caps backstop it), never a silent completion.
  if (allPresent) {
    // S162 (Codex QA round-3 CRITICAL — finalize-throw strands a recovery row
    // forever): finalizeRecoveredRun is NOT internally try/caught around its
    // awaited Supabase/storage deps — defaultFinalizeDeps.fetchRow/patchRow do a
    // bare `await fetch(...)` (which REJECTS on a network/transport error) and
    // upload()/readDir() can throw too. An uncaught throw here would propagate to
    // the OUTER maybeRunStudioRecoverySweep wrapper, which returns {ran:false}
    // BEFORE the attempt-bump patchRecovery + the attempt/age caps below ever run.
    // A PERSISTENT throw (e.g. a Storage outage while the DB is healthy, so the
    // simple patchRecovery PATCH would still succeed) would then repeat every tick
    // FOREVER: attempts never bump, caps never trip → the row sits non-terminal
    // forever (the UI hides terminal controls). Convert a throw to a NON-OK finalize
    // result — handled identically to fin.ok===false (continued-transient) — so it
    // flows through the existing retry/cap path (bump attempts, schedule the next
    // attempt, and eventually exhaust at the attempt cap). A real recovery (a
    // non-throwing fin.ok) is unaffected. This per-dep guard is the FIRST line; the
    // caller's structural backstop (S162 Codex grounded BLOCK) catches any OTHER
    // unexpected throw in this function so no dep can strand the row.
    let fin: FinalizeResult;
    try {
      fin = await deps.finalize({
        jobId: c.id,
        workDir: projectsDir,
        slug: c.topic_slug,
        status: "completed",
        errorMessage: null,
        force: false,
        extraPatch: { studio_recovery_status: "recovered", studio_recovery_attempts: newAttempts },
      });
    } catch (err) {
      deps.log(
        `[studio-recovery] ${c.id}: finalize THREW (${(err as Error).message}) — ` +
          `treating as continued-transient (caps will backstop)`,
      );
      fin = {
        ok: false,
        reason: `finalize threw: ${(err as Error).message}`,
        uploaded: 0,
        skipped: 0,
        failed: 0,
      };
    }
    if (fin.ok) {
      deps.log(
        `[studio-recovery] ${c.id}: RECOVERED → completed (${fin.uploaded} uploaded) after ${newAttempts} attempt(s)`,
      );
      if (c.notify_email) {
        await deps
          .sendCompleted({ to: c.notify_email, slug: c.topic_slug, topic: c.topic })
          .catch(() => undefined);
      }
      return { ran: true, outcome: "recovered", jobId: c.id, attempts: newAttempts };
    }
    deps.log(
      `[studio-recovery] ${c.id}: finalize did NOT complete (${fin.refused ? "obligation REFUSED" : "error"}: ` +
        `${fin.reason ?? ""}) — treating as continued-transient`,
    );
  }

  // Not recovered this pass → caller runs the cap/bump tail.
  return null;
}

/** Terminalize a candidate: flip to exhausted, notify requester + operator. */
async function finishExhausted(
  deps: RecoverySweepDeps,
  c: RecoveryCandidate,
  attempts: number,
  reason: ExhaustReason,
  products: string[],
  ageHours: number,
): Promise<RecoverySweepResult> {
  const errorMessage =
    `Studio recovery exhausted (${reason}): selected product(s) ${products.join(", ") || "(unknown)"} ` +
    `confirmed complete in NotebookLM but unrecoverable after ${attempts} attempt(s) / ~${ageHours}h.`;
  // status STAYS 'failed' — only the recovery dimension + error_message change.
  // The 'exhausted' flip is the idempotency latch for the once-only alerts.
  const patched = await deps.patchRecovery(c.id, {
    studio_recovery_status: "exhausted",
    studio_recovery_attempts: attempts,
    error_message: errorMessage.slice(0, 2000),
  });
  // M4: send the once-only alerts ONLY after the 'exhausted' latch is durably
  // written. If the PATCH fails (e.g. Supabase 500) the row stays pending and a
  // later tick re-attempts the flip; emailing now would re-fire requester +
  // operator alerts on EVERY tick until the PATCH lands (Resend cascade). Report
  // a retry outcome (the job is NOT terminal yet) so the caps re-evaluate later.
  if (!patched) {
    deps.log(
      `[studio-recovery] ${c.id}: exhaust PATCH failed (${reason}) — deferring alerts to a later tick`,
    );
    return { ran: true, outcome: "retry", jobId: c.id, attempts, detail: "exhaust-patch-failed" };
  }
  if (c.notify_email) {
    await deps
      .sendFailed({ to: c.notify_email, slug: c.topic_slug, topic: c.topic, errorMessage })
      .catch(() => undefined);
  }
  await deps
    .sendExhaustedAlert({
      jobId: c.id,
      slug: c.topic_slug,
      topic: c.topic,
      attempts,
      reason,
      products,
      ageHours,
    })
    .catch(() => undefined);
  deps.log(`[studio-recovery] ${c.id}: EXHAUSTED (${reason}) after ${attempts} attempt(s)`);
  return { ran: true, outcome: "exhausted", jobId: c.id, attempts, exhaustReason: reason };
}

/**
 * C3 (defense-in-depth): flip any structurally-malformed pending row to
 * exhausted so it can't sit non-terminal forever (it is invisible to the
 * due-candidate query, whose `.lte(first_failed_at, …)` predicate excludes a NULL
 * anchor). The migration 20260623 CHECK is the PRIMARY guard (prevents creation);
 * this is the belt-and-suspenders. Best-effort: never throws; operator-alerts on
 * a successful quarantine, sends NO requester email (an integrity event, not a
 * normal exhaust). Idempotent — a quarantined row no longer matches the query.
 */
async function quarantineMalformedPending(deps: RecoverySweepDeps): Promise<void> {
  try {
    const malformed = await deps.fetchMalformedPending();
    for (const m of malformed) {
      const patched = await deps.patchRecovery(m.id, {
        studio_recovery_status: "exhausted",
        error_message:
          "Studio recovery quarantined: malformed pending row (missing recovery anchor / next-attempt / payload, or attempts<1)."
            .slice(0, 2000),
      });
      if (!patched) {
        deps.log(`[studio-recovery] ${m.id}: quarantine PATCH failed — will retry next tick`);
        continue;
      }
      deps.log(`[studio-recovery] ${m.id}: QUARANTINED malformed pending → exhausted`);
      await deps
        .sendExhaustedAlert({
          jobId: m.id,
          slug: m.topic_slug,
          topic: m.topic,
          attempts: m.studio_recovery_attempts ?? 0,
          reason: "payload-missing",
          products: [],
          ageHours: 0,
        })
        .catch(() => undefined);
    }
  } catch (err) {
    deps.log(`[studio-recovery] malformed-pending quarantine error (non-fatal): ${(err as Error).message}`);
  }
}

// ── Worker-tick wrapper (best-effort; lazy client; NEVER throws) ─────

export interface MaybeRecoverySweepOptions {
  logFn?: (msg: string) => void;
  /** Injected deps (tests). When set, the env/creds path is skipped. */
  deps?: RecoverySweepDeps;
}

/**
 * Build the real, Supabase-backed deps. Service-role client bypasses RLS for
 * the candidate query + the studio_recovery_* PATCH (these are off the agent
 * PATCH allowlist by design — only the executor's initial transient write goes
 * through the allowlisted route). finalize uses the shared defaultFinalizeDeps.
 */
function buildDefaultDeps(
  url: string,
  key: string,
  log: (msg: string) => void,
): RecoverySweepDeps {
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const finalizeDeps = defaultFinalizeDeps(url, key, log);
  return {
    fetchDueCandidate: async (nowIso, graceIso) => {
      const { data, error } = await sb
        .from("research_queue")
        .select(
          "id, topic, topic_slug, notify_email, organization_id, studio_recovery_attempts, studio_recovery_first_failed_at, studio_recovery_payload",
        )
        // S161 (Codex grounded MINOR): a recovery-pending row ALWAYS lives inside a
        // status='failed' row (the executor writes both atomically; the sweep only
        // moves it to recovered/exhausted). Pinning status='failed' honors that
        // documented invariant so a future stray studio_recovery_status='pending' on
        // a non-failed row can't be claimed. pending⇒failed holds in shipped code, so
        // this excludes no legitimate candidate.
        .eq("status", "failed")
        .eq("studio_recovery_status", "pending")
        .lte("studio_recovery_next_attempt_at", nowIso)
        .lte("studio_recovery_first_failed_at", graceIso)
        .order("studio_recovery_next_attempt_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) {
        log(`[studio-recovery] candidate query failed (non-fatal): ${error.message}`);
        return null;
      }
      return (data as RecoveryCandidate | null) ?? null;
    },
    fetchMalformedPending: async () => {
      // C3: pending rows that the due-candidate predicate can never see because a
      // required recovery field is NULL (or attempts<1). Bounded; uses the partial
      // index on status='pending'. Normally returns [] (the migration CHECK keeps
      // it empty).
      const { data, error } = await sb
        .from("research_queue")
        .select(
          "id, topic, topic_slug, notify_email, organization_id, studio_recovery_attempts, studio_recovery_first_failed_at, studio_recovery_payload",
        )
        // S161 (Codex grounded MINOR): same status='failed' invariant pin as the
        // due-candidate query — a malformed pending row also lives inside a failed row.
        .eq("status", "failed")
        .eq("studio_recovery_status", "pending")
        .or(
          "studio_recovery_first_failed_at.is.null,studio_recovery_next_attempt_at.is.null,studio_recovery_payload.is.null,studio_recovery_attempts.lt.1",
        )
        .limit(20);
      if (error) {
        log(`[studio-recovery] malformed-pending query failed (non-fatal): ${error.message}`);
        return [];
      }
      return (data as RecoveryCandidate[] | null) ?? [];
    },
    isFilePresent: async (filePath) => {
      try {
        const st = await fs.stat(filePath);
        return st.isFile() && st.size > 0;
      } catch {
        return false;
      }
    },
    removeOrphanParts: async (dir) => {
      // S161 R2-1: best-effort sweep of `*.part` temps in the candidate dir.
      try {
        const dirents = await fs.readdir(dir, { withFileTypes: true });
        for (const d of dirents) {
          if (d.isFile() && d.name.endsWith(".part")) {
            await fs.rm(path.join(dir, d.name), { force: true }).catch(() => undefined);
          }
        }
      } catch {
        // dir absent/unreadable — nothing to clean
      }
    },
    listArtifacts: realListArtifacts,
    downloadArtifact: realDownloadArtifact,
    finalize: (args) => finalizeRecoveredRun(args, finalizeDeps),
    patchRecovery: async (jobId, body) => {
      const res = await fetch(`${url}/rest/v1/research_queue?id=eq.${jobId}`, {
        method: "PATCH",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        log(`[studio-recovery] recovery PATCH failed (HTTP ${res.status}) for ${jobId}`);
      }
      return res.ok;
    },
    sendCompleted: (a) =>
      sendCompletionEmail({ to: a.to, slug: a.slug, topic: a.topic, status: "completed" }),
    sendFailed: (a) =>
      sendCompletionEmail({
        to: a.to,
        slug: a.slug,
        topic: a.topic,
        status: "failed",
        errorMessage: a.errorMessage,
      }),
    sendExhaustedAlert: (a) => sendStudioRecoveryExhaustedEmail(a),
    projectsDir: PROJECTS_DIR,
    now: () => Date.now(),
    log,
  };
}

/**
 * Worker-tick entry point. Best-effort: builds the service-role client lazily,
 * runs at most one recovery pass, and NEVER throws/exits (a sweep failure must
 * never crash the worker poll chain — wrapped in try/catch). Called BOTH at the
 * top of poll() (before claimJob) AND before probeBackoff()'s exit.
 */
export async function maybeRunStudioRecoverySweep(
  opts: MaybeRecoverySweepOptions = {},
): Promise<RecoverySweepResult> {
  const log = opts.logFn ?? (() => {});
  try {
    let deps = opts.deps;
    if (!deps) {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
      if (!url || !key) {
        log("[studio-recovery] skipped: Supabase credentials not configured");
        return { ran: false };
      }
      deps = buildDefaultDeps(url, key, log);
    }
    return await runStudioRecoverySweepOnce(deps);
  } catch (err) {
    log(`[studio-recovery] unexpected error (non-fatal): ${(err as Error).message}`);
    return { ran: false };
  }
}
