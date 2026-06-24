/**
 * Email notifications via Resend on job terminal-state transitions.
 *
 * Triggered from executor.ts after every completeJob() and failJob() call.
 * Reads RESEND_API_KEY from env; if missing, logs a one-line warning and
 * returns — does NOT throw. Notification failure must never break a research
 * run. Same for HTTP errors from Resend (logged, swallowed).
 *
 * S64: extended with three preflight/terminal-error helpers used by the
 * file-backed circuit breaker (preflight-cost-architecture-design-gate.md
 * §3.4 + §3.5.F). Recipient for these operator-alerts is PREFLIGHT_NOTIFY_EMAIL
 * (separate from per-job notify_email). If unset, the helpers log + return.
 *
 * Setup (one-time, user action):
 *   1. Sign up at https://resend.com (free tier: 3000 emails/mo, 100/day)
 *   2. Create API key in dashboard, copy the `re_...` string
 *   3. Add to agent/.env: RESEND_API_KEY=re_...
 *   4. Optionally: RESEND_FROM_EMAIL="Dynamic Research <noreply@your-domain.com>"
 *      (requires verifying your-domain.com in Resend dashboard).
 *      If unset, sends from "onboarding@resend.dev" — works without verification
 *      but lands in spam more often.
 *   5. Optionally: PREFLIGHT_NOTIFY_EMAIL=ops@your-domain.com to receive
 *      preflight backoff + terminal-exit + recovery alerts. If unset, the
 *      S64 preflight emails are skipped (warning logged).
 *   6. Restart worker daemon.
 *
 * Shipped S36 (2026-05-12) — gates external team-member submissions.
 */

import type { FailureKind } from "./preflight-backoff.js";

const RESEND_API = "https://api.resend.com/emails";
const GALLERY_BASE_URL = "https://dynamic-research.vercel.app/runs";

type NotifyArgs = {
  to: string;
  slug: string;
  topic: string;
  status: "completed" | "failed";
  errorMessage?: string;
  // S85 plan-review convergence (design §5b option 2) — advisory reservations
  // recorded when the plan proceeded under terminal-ladder rule R5. Folded into
  // the success email as non-blocking notes. Local shape mirrors
  // plan-types.ts:ReviewFinding without a cross-module type import.
  reservations?: Array<{
    severity: "CRITICAL" | "MAJOR" | "MINOR";
    origin: string;
    message: string;
  }>;
};

export async function sendCompletionEmail(args: NotifyArgs): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      `[notify] RESEND_API_KEY not set — skipping email to ${args.to} for slug ${args.slug}. ` +
      `To enable: see agent/lib/notify.ts setup steps.`,
    );
    return;
  }

  const from = process.env.RESEND_FROM_EMAIL || "Dynamic Research <onboarding@resend.dev>";
  const galleryUrl = `${GALLERY_BASE_URL}/${args.slug}/gallery`;
  // Resend rejects \n in subject (HTTP 422). Collapse all whitespace before slice
  // so multi-line markdown topics (S73 dogfood: A4 smoke job 75855a73) don't break
  // the email POST. Body uses args.topic verbatim — newlines render fine in HTML.
  const topicSanitized = args.topic.replace(/\s+/g, " ").trim();
  const topicShort = topicSanitized.length > 100 ? topicSanitized.slice(0, 97) + "..." : topicSanitized;

  const body =
    args.status === "completed"
      ? buildSuccessEmail(args, galleryUrl, topicShort, from)
      : buildFailureEmail(args, galleryUrl, topicShort, from);

  try {
    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.warn(
        `[notify] Resend POST failed (HTTP ${res.status}) for ${args.to}: ${errBody.slice(0, 300)}`,
      );
      return;
    }
    const data = (await res.json()) as { id?: string };
    console.log(`[notify] email sent to ${args.to} (status=${args.status}, slug=${args.slug}, resend_id=${data.id ?? "?"})`);
  } catch (err) {
    console.warn(`[notify] Resend request threw for ${args.to}: ${(err as Error).message}`);
  }
}

function buildSuccessEmail(
  args: NotifyArgs,
  galleryUrl: string,
  topicShort: string,
  from: string,
): Record<string, unknown> {
  const subject = `Your Dynamic Research run is ready: ${topicShort}`;
  // S85 (design §5b option 2) — advisory R5 reservations as non-blocking notes.
  const reservations = args.reservations ?? [];
  const reservationText =
    reservations.length > 0
      ? `\n\nAdvisory notes (${reservations.length}) — the plan proceeded, but the ` +
        `peer reviewers flagged these optional refinements:\n` +
        reservations
          .slice(0, 8)
          .map((r) => `  • [${r.severity}] ${r.message}`)
          .join("\n") +
        (reservations.length > 8 ? `\n  • (+${reservations.length - 8} more)` : "")
      : "";
  const reservationHtml =
    reservations.length > 0
      ? `<div style="margin:20px 0 0 0;padding:12px 14px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px">` +
        `<p style="margin:0 0 8px 0;color:#92400e;font-weight:600;font-size:14px">Advisory notes (${reservations.length})</p>` +
        `<p style="margin:0 0 8px 0;color:#78350f;font-size:13px">The plan proceeded, but the peer reviewers flagged these optional refinements:</p>` +
        `<ul style="margin:0;padding-left:18px;color:#78350f;font-size:13px">` +
        reservations
          .slice(0, 8)
          .map(
            (r) =>
              `<li style="margin:0 0 4px 0"><strong>[${escapeHtml(r.severity)}]</strong> ${escapeHtml(r.message)}</li>`,
          )
          .join("") +
        (reservations.length > 8
          ? `<li style="margin:0;color:#92400e">(+${reservations.length - 8} more)</li>`
          : "") +
        `</ul></div>`
      : "";
  const text =
    `Your research run finished and the deliverables are ready to view.\n\n` +
    `Topic: ${args.topic}\n\n` +
    `Gallery: ${galleryUrl}\n\n` +
    `The gallery includes every deliverable produced for this topic — audio overview, ` +
    `cinematic video, slide deck, executive report, and infographic — plus the underlying ` +
    `research artifacts (Perplexity output, NotebookLM synthesis, and the three-way comparison).` +
    reservationText +
    `\n\nIf anything looks off, reply to this email.\n\n` +
    `— Dynamic Research`;
  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5">` +
    `<h2 style="margin:0 0 16px 0">Your Dynamic Research run is ready</h2>` +
    `<p style="margin:0 0 12px 0"><strong>Topic:</strong> ${escapeHtml(args.topic)}</p>` +
    `<p style="margin:0 0 24px 0">` +
    `<a href="${galleryUrl}" style="display:inline-block;padding:10px 18px;background:#0070f3;color:#fff;text-decoration:none;border-radius:6px;font-weight:500">View gallery →</a>` +
    `</p>` +
    `<p style="margin:0 0 12px 0;color:#555">The gallery includes every deliverable produced for this topic — audio overview, cinematic video, slide deck, executive report, and infographic — plus the underlying research artifacts (Perplexity output, NotebookLM synthesis, three-way comparison).</p>` +
    reservationHtml +
    `<p style="margin:24px 0 0 0;color:#888;font-size:13px">If anything looks off, reply to this email.</p>` +
    `</div>`;
  return { from, to: args.to, subject, text, html };
}

function buildFailureEmail(
  args: NotifyArgs,
  galleryUrl: string,
  topicShort: string,
  from: string,
): Record<string, unknown> {
  const subject = `Your Dynamic Research run hit an error: ${topicShort}`;
  const errSnippet = (args.errorMessage ?? "Unknown error").slice(0, 500);
  const text =
    `Your research run encountered an error and did not complete.\n\n` +
    `Topic: ${args.topic}\n\n` +
    `Error: ${errSnippet}\n\n` +
    `We've logged the issue and will investigate. Reply to this email if you'd like an update or a re-run.\n\n` +
    `— Dynamic Research`;
  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5">` +
    `<h2 style="margin:0 0 16px 0;color:#b91c1c">Your Dynamic Research run hit an error</h2>` +
    `<p style="margin:0 0 12px 0"><strong>Topic:</strong> ${escapeHtml(args.topic)}</p>` +
    `<p style="margin:0 0 12px 0"><strong>Error:</strong></p>` +
    `<pre style="background:#f8fafc;padding:12px;border-radius:6px;font-size:13px;overflow-x:auto;white-space:pre-wrap;word-break:break-word">${escapeHtml(errSnippet)}</pre>` +
    `<p style="margin:24px 0 0 0;color:#555">We've logged the issue and will investigate. Reply to this email if you'd like an update or a re-run.</p>` +
    `</div>`;
  return { from, to: args.to, subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── S158 transient-tolerant studio gate notifications ───────────────

type DeliveryDelayedArgs = {
  to: string;
  slug: string;
  topic: string;
};

/**
 * S158 (design §7/§10) — NON-TERMINAL "delivery delayed, retrying
 * automatically" email, sent to the requester on the recoverable branch
 * INSTEAD of notifyTerminal('failed'). A dedicated helper is required because
 * notifyTerminal/sendCompletionEmail can only render the hardcoded "failed"
 * body (Codex MAJOR-6) — a softer error string still reads as failure. Distinct
 * subject/body, NO "failed"/"error" language. Reads RESEND_API_KEY; if missing,
 * logs + returns (never throws — a notification failure must never break a run).
 */
export async function sendDeliveryDelayedEmail(args: DeliveryDelayedArgs): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      `[notify] RESEND_API_KEY not set — skipping delivery-delayed email to ${args.to} for slug ${args.slug}.`,
    );
    return;
  }
  const from = process.env.RESEND_FROM_EMAIL || "Dynamic Research <onboarding@resend.dev>";
  const galleryUrl = `${GALLERY_BASE_URL}/${args.slug}/gallery`;
  const topicSanitized = args.topic.replace(/\s+/g, " ").trim();
  const topicShort = topicSanitized.length > 100 ? topicSanitized.slice(0, 97) + "..." : topicSanitized;
  const subject = `Your Dynamic Research run is finalizing: ${topicShort}`;
  const text =
    `Good news — your research is done; we're finalizing the media deliverables.\n\n` +
    `Topic: ${args.topic}\n\n` +
    `One or more outputs (audio / video / slides / infographic) finished generating but a ` +
    `brief delivery hiccup delayed the download. The system is automatically retrying — no ` +
    `action is needed on your part. You'll get a final email with the gallery link as soon as ` +
    `everything lands.\n\n` +
    `Gallery (will populate when finalization completes): ${galleryUrl}\n\n` +
    `— Dynamic Research`;
  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5">` +
    `<h2 style="margin:0 0 16px 0;color:#c2410c">Finalizing your media — retrying automatically</h2>` +
    `<p style="margin:0 0 12px 0"><strong>Topic:</strong> ${escapeHtml(args.topic)}</p>` +
    `<p style="margin:0 0 12px 0;color:#555">Your research is done; one or more media outputs finished generating but a brief delivery hiccup delayed the download. The system is automatically retrying — <strong>no action is needed</strong>. You'll get a final email with the gallery link as soon as everything lands.</p>` +
    `<p style="margin:24px 0 0 0;color:#888;font-size:13px">If you don't receive the completion email within ~48 hours, reply to this email.</p>` +
    `</div>`;
  const body = { from, to: args.to, subject, text, html };
  try {
    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.warn(`[notify] delivery-delayed POST failed (HTTP ${res.status}) for ${args.to}: ${errBody.slice(0, 300)}`);
      return;
    }
    const data = (await res.json()) as { id?: string };
    console.log(`[notify] delivery-delayed email sent to ${args.to} (slug=${args.slug}, resend_id=${data.id ?? "?"})`);
  } catch (err) {
    console.warn(`[notify] delivery-delayed email threw for ${args.to}: ${(err as Error).message}`);
  }
}

// ── S59 plan-review gate notifications ──────────────────────────────

/**
 * Lightweight finding shape (mirrors agent/lib/plan-types.ts:ReviewFinding
 * without creating a cross-module import that would push plan-review types
 * into the notify module).
 */
type PlanReviewFinding = {
  severity: "CRITICAL" | "MAJOR" | "MINOR";
  origin: string;
  message: string;
};

type PlanReviewNotifyArgs = {
  to: string | null;
  slug: string;
  topic: string;
  /** Terminal ReviewResult.status (NOT plan_review_status DB enum). */
  status: "REQUEST_CHANGES" | "BLOCKED" | "SYSTEM_BLOCKED";
  user_message: string;
  /** Findings collected across all reviewer rounds (truncated to top 20). */
  findings: PlanReviewFinding[];
};

/**
 * Send plan-review terminal-state email to the submitter.
 */
export async function sendPlanReviewEmail(args: PlanReviewNotifyArgs): Promise<void> {
  if (!args.to) return;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      `[notify] RESEND_API_KEY not set — skipping plan-review email to ${args.to} for slug ${args.slug}.`,
    );
    return;
  }

  const from = process.env.RESEND_FROM_EMAIL || "Dynamic Research <onboarding@resend.dev>";
  const galleryUrl = `${GALLERY_BASE_URL}/${args.slug}/gallery`;
  // Resend rejects \n in subject (HTTP 422). See sibling site at sendCompletionEmail
  // for the same bug. Observed S73 (2026-05-30) on A4 smoke job 75855a73 whose
  // multi-line markdown topic produced topicShort with embedded \n → Resend 422.
  const topicSanitized = args.topic.replace(/\s+/g, " ").trim();
  const topicShort = topicSanitized.length > 100 ? topicSanitized.slice(0, 97) + "..." : topicSanitized;
  const body = buildPlanReviewEmail(args, galleryUrl, topicShort, from);

  try {
    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.warn(
        `[notify] plan-review email POST failed (HTTP ${res.status}) for ${args.to}: ${errBody.slice(0, 300)}`,
      );
      return;
    }
    const data = (await res.json()) as { id?: string };
    console.log(
      `[notify] plan-review email sent to ${args.to} (status=${args.status}, slug=${args.slug}, resend_id=${data.id ?? "?"})`,
    );
  } catch (err) {
    console.warn(`[notify] plan-review email threw for ${args.to}: ${(err as Error).message}`);
  }
}

function buildPlanReviewEmail(
  args: PlanReviewNotifyArgs,
  galleryUrl: string,
  topicShort: string,
  from: string,
): Record<string, unknown> {
  const subjectByStatus: Record<PlanReviewNotifyArgs["status"], string> = {
    REQUEST_CHANGES: `Your research plan needs a quick look — ${topicShort}`,
    BLOCKED: `Your research plan was rejected — ${topicShort}`,
    SYSTEM_BLOCKED: `Your research run hit a system issue — ${topicShort}`,
  };
  const headlineByStatus: Record<PlanReviewNotifyArgs["status"], string> = {
    REQUEST_CHANGES: "Your research plan needs a quick look",
    BLOCKED: "Your research plan was rejected",
    SYSTEM_BLOCKED: "Your research run hit a system issue",
  };
  const headlineColorByStatus: Record<PlanReviewNotifyArgs["status"], string> = {
    REQUEST_CHANGES: "#c2410c",
    BLOCKED: "#b91c1c",
    SYSTEM_BLOCKED: "#525252",
  };

  const ctaText =
    args.status === "REQUEST_CHANGES"
      ? "Review the findings and revise →"
      : args.status === "BLOCKED"
        ? "See full review details →"
        : "Check status →";

  const top = args.findings.slice(0, 8);
  const more = args.findings.length > 8 ? ` and ${args.findings.length - 8} more` : "";
  const findingsText = top.length
    ? top
        .map(
          (f, i) =>
            `${i + 1}. [${f.severity}/${f.origin}] ${f.message.slice(0, 300)}`,
        )
        .join("\n")
    : "(no specific findings — see the review log on the run page)";
  const findingsHtml = top.length
    ? `<ol style="margin:0 0 16px 0;padding:0 0 0 20px;color:#333">` +
      top
        .map(
          (f) =>
            `<li style="margin:0 0 8px 0"><span style="display:inline-block;padding:2px 6px;border-radius:4px;background:#f1f5f9;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#475569;margin-right:6px">${escapeHtml(f.severity)} · ${escapeHtml(f.origin)}</span>${escapeHtml(f.message.slice(0, 300))}</li>`,
        )
        .join("") +
      `</ol>` +
      (more ? `<p style="margin:0 0 16px 0;color:#666;font-size:13px">${escapeHtml(more)}</p>` : "")
    : `<p style="margin:0 0 16px 0;color:#666">(no specific findings — see the review log on the run page)</p>`;

  const text =
    `${headlineByStatus[args.status]}.\n\n` +
    `Topic: ${args.topic}\n\n` +
    `Reviewer summary: ${args.user_message}\n\n` +
    `Findings:\n${findingsText}${more}\n\n` +
    `View run: ${galleryUrl}\n\n` +
    `— Dynamic Research`;

  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5">` +
    `<h2 style="margin:0 0 16px 0;color:${headlineColorByStatus[args.status]}">${headlineByStatus[args.status]}</h2>` +
    `<p style="margin:0 0 12px 0"><strong>Topic:</strong> ${escapeHtml(args.topic)}</p>` +
    `<p style="margin:0 0 12px 0"><strong>Reviewer summary:</strong> ${escapeHtml(args.user_message)}</p>` +
    `<p style="margin:0 0 8px 0;font-weight:600">Findings:</p>` +
    findingsHtml +
    `<p style="margin:24px 0 0 0">` +
    `<a href="${galleryUrl}" style="display:inline-block;padding:10px 18px;background:#0070f3;color:#fff;text-decoration:none;border-radius:6px;font-weight:500">${ctaText}</a>` +
    `</p>` +
    `<p style="margin:24px 0 0 0;color:#888;font-size:13px">If anything looks off, reply to this email.</p>` +
    `</div>`;

  return { from, to: args.to, subject: subjectByStatus[args.status], text, html };
}

// ── S64 preflight + terminal-error operator alerts ──────────────────

/**
 * Internal helper that posts a Resend email shaped for the preflight/
 * terminal-error alert channel. Reads PREFLIGHT_NOTIFY_EMAIL recipient
 * from env; if unset, logs + returns (consistent with the
 * sendCompletionEmail-no-key path). All errors swallowed; never throws.
 */
async function postOperatorAlert(subject: string, text: string, html: string): Promise<void> {
  const recipient = process.env.PREFLIGHT_NOTIFY_EMAIL?.trim();
  if (!recipient) {
    console.warn(
      `[notify] PREFLIGHT_NOTIFY_EMAIL not set — skipping operator alert "${subject.slice(0, 80)}".`,
    );
    return;
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      `[notify] RESEND_API_KEY not set — skipping operator alert "${subject.slice(0, 80)}".`,
    );
    return;
  }
  const from = process.env.RESEND_FROM_EMAIL || "Dynamic Research <onboarding@resend.dev>";
  const body = { from, to: recipient, subject, text, html };
  try {
    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.warn(
        `[notify] operator-alert POST failed (HTTP ${res.status}): ${errBody.slice(0, 300)}`,
      );
      return;
    }
    const data = (await res.json()) as { id?: string };
    console.log(`[notify] operator-alert sent (resend_id=${data.id ?? "?"}, subject="${subject.slice(0, 80)}")`);
  } catch (err) {
    console.warn(`[notify] operator-alert threw: ${(err as Error).message}`);
  }
}

export interface PreflightBackoffEmailArgs {
  /** "preflight" = startup check failed; "terminal" = mid-execution classifier fired. */
  origin: "preflight" | "terminal";
  kind: FailureKind;
  /** Set when origin === "terminal" (executor:claude-spawn etc). */
  source?: string;
  /** Set when origin === "terminal" (regex:credit-balance-low etc). */
  signature?: string;
  consecutiveFailures: number;
  backoffUntil: string;
  detail: string;
  remediation: string;
}

/**
 * Per design §3.4 + §3.5.F: fires ONCE when consecutiveFailures crosses
 * the N=3 threshold (the first failure producing a non-trivial 20-min
 * backoff window). Subsequent failures within the same outage do NOT
 * re-notify (alert fatigue). Recovery is its own email (sendPreflightRecoveryEmail).
 */
export async function sendPreflightBackoffEmail(args: PreflightBackoffEmailArgs): Promise<void> {
  const minutesUntil = Math.max(0, Math.round((new Date(args.backoffUntil).getTime() - Date.now()) / 60000));
  const subject =
    args.origin === "preflight"
      ? `[Dynamic Research] Worker preflight backoff active (${args.kind})`
      : `[Dynamic Research] Worker exited on terminal provider error (${args.kind})`;

  const headline =
    args.origin === "preflight"
      ? `Worker preflight failed ${args.consecutiveFailures}× in a row — backing off ${minutesUntil} min`
      : `Worker exited on terminal provider error — backing off ${minutesUntil} min`;

  const sourceLine = args.origin === "terminal" && args.source
    ? `\nDetected at: ${args.source}${args.signature ? ` (${args.signature})` : ""}`
    : "";

  const tailHint = `\nTail worker.log:\n  Get-Content -Tail 100 "C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/agent/worker.log"\n`;
  const text =
    `${headline}.\n\n` +
    `Failure kind: ${args.kind}\n` +
    `Consecutive failures: ${args.consecutiveFailures}\n` +
    `Backoff window expires: ${args.backoffUntil} (~${minutesUntil} min)${sourceLine}\n\n` +
    `Detail: ${args.detail}\n\n` +
    `Remediation: ${args.remediation}\n` +
    tailHint +
    `\n— Dynamic Research preflight`;

  const sourceHtml = args.origin === "terminal" && args.source
    ? `<p style="margin:0 0 12px 0"><strong>Detected at:</strong> ${escapeHtml(args.source)}${args.signature ? ` <span style="color:#666">(${escapeHtml(args.signature)})</span>` : ""}</p>`
    : "";

  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;color:#111;line-height:1.5">` +
    `<h2 style="margin:0 0 16px 0;color:#b91c1c">${escapeHtml(headline)}</h2>` +
    `<p style="margin:0 0 8px 0"><strong>Failure kind:</strong> ${escapeHtml(args.kind)}</p>` +
    `<p style="margin:0 0 8px 0"><strong>Consecutive failures:</strong> ${args.consecutiveFailures}</p>` +
    `<p style="margin:0 0 12px 0"><strong>Backoff window expires:</strong> ${escapeHtml(args.backoffUntil)} (~${minutesUntil} min)</p>` +
    sourceHtml +
    `<p style="margin:0 0 8px 0"><strong>Detail:</strong></p>` +
    `<pre style="background:#f8fafc;padding:12px;border-radius:6px;font-size:13px;overflow-x:auto;white-space:pre-wrap;word-break:break-word">${escapeHtml(args.detail)}</pre>` +
    `<p style="margin:16px 0 8px 0"><strong>Remediation:</strong></p>` +
    `<p style="margin:0 0 16px 0">${escapeHtml(args.remediation)}</p>` +
    `<p style="margin:24px 0 0 0;color:#666;font-size:13px">Future cron ticks will exit cheaply during the backoff window. Recovery email will fire on next successful preflight.</p>` +
    `</div>`;

  await postOperatorAlert(subject, text, html);
}

export interface PreflightRecoveryEmailArgs {
  consecutiveFailures: number;
  lastFailureKind: FailureKind;
  outageDurationMin: number;
}

/**
 * Per design §3.4: fires on first successful preflight after a backoff
 * was active. Closes the loop for the operator who got the backoff email.
 */
export async function sendPreflightRecoveryEmail(args: PreflightRecoveryEmailArgs): Promise<void> {
  const subject = `[Dynamic Research] Worker preflight recovered`;
  const text =
    `Worker preflight just passed — backoff cleared.\n\n` +
    `Consecutive failures observed before recovery: ${args.consecutiveFailures}\n` +
    `Last failure kind: ${args.lastFailureKind}\n` +
    `Outage duration: ~${args.outageDurationMin} min\n\n` +
    `Cron-driven worker will resume polling on the next tick.\n\n` +
    `— Dynamic Research preflight`;
  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5">` +
    `<h2 style="margin:0 0 16px 0;color:#16a34a">Worker preflight recovered</h2>` +
    `<p style="margin:0 0 8px 0"><strong>Consecutive failures observed:</strong> ${args.consecutiveFailures}</p>` +
    `<p style="margin:0 0 8px 0"><strong>Last failure kind:</strong> ${escapeHtml(args.lastFailureKind)}</p>` +
    `<p style="margin:0 0 12px 0"><strong>Outage duration:</strong> ~${args.outageDurationMin} min</p>` +
    `<p style="margin:24px 0 0 0;color:#555">Cron-driven worker will resume polling on the next tick.</p>` +
    `</div>`;
  await postOperatorAlert(subject, text, html);
}

// ── S158 studio-recovery exhaustion operator alert ──────────────────

export interface StudioRecoveryExhaustedEmailArgs {
  jobId: string;
  slug: string;
  topic: string;
  attempts: number;
  /** Why recovery terminalized: "attempt-cap" | "age-cap" | "artifact-gone". */
  reason: string;
  /** Products that never recovered. */
  products: string[];
  /** Hours since the first failure (for context in the alert). */
  ageHours: number;
}

/**
 * S158 (design §7/§10) — operator alert via PREFLIGHT_NOTIFY_EMAIL when the
 * decoupled studio-recovery sweep EXHAUSTS a job (attempt/age cap breached OR
 * the artifact is no longer status_id 3 in NLM). Fires ONCE — idempotent by the
 * studio_recovery_status='exhausted' flip that the caller does before sending.
 * Does NOT feed the S64 preflight circuit breaker: an NLM domain failure is not
 * a provider auth/quota/infra outage. postOperatorAlert swallows all errors +
 * skips on an unset recipient (never throws).
 */
export async function sendStudioRecoveryExhaustedEmail(
  args: StudioRecoveryExhaustedEmailArgs,
): Promise<void> {
  const subject = `[Dynamic Research] Studio recovery EXHAUSTED (${args.reason}) — ${args.slug}`;
  const text =
    `A studio-completeness recovery has exhausted and the job is now a genuine hard-failure.\n\n` +
    `Job: ${args.jobId}\n` +
    `Slug: ${args.slug}\n` +
    `Topic: ${args.topic}\n` +
    `Unrecovered product(s): ${args.products.join(", ") || "(unknown)"}\n` +
    `Reason: ${args.reason}\n` +
    `Recovery passes: ${args.attempts}\n` +
    `Age since first failure: ~${args.ageHours}h\n\n` +
    `The artifact(s) were confirmed complete in NotebookLM at the time of the gate but could not ` +
    `be downloaded within the recovery window. Manual recourse: re-run the download by id, or ` +
    `scripts/finalize-recovered-run.ts once the artifacts re-download.\n\n` +
    `— Dynamic Research studio-recovery`;
  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;color:#111;line-height:1.5">` +
    `<h2 style="margin:0 0 16px 0;color:#b91c1c">Studio recovery exhausted (${escapeHtml(args.reason)})</h2>` +
    `<p style="margin:0 0 8px 0"><strong>Job:</strong> ${escapeHtml(args.jobId)}</p>` +
    `<p style="margin:0 0 8px 0"><strong>Slug:</strong> ${escapeHtml(args.slug)}</p>` +
    `<p style="margin:0 0 8px 0"><strong>Topic:</strong> ${escapeHtml(args.topic)}</p>` +
    `<p style="margin:0 0 8px 0"><strong>Unrecovered product(s):</strong> ${escapeHtml(args.products.join(", ") || "(unknown)")}</p>` +
    `<p style="margin:0 0 8px 0"><strong>Recovery passes:</strong> ${args.attempts}</p>` +
    `<p style="margin:0 0 12px 0"><strong>Age since first failure:</strong> ~${args.ageHours}h</p>` +
    `<p style="margin:16px 0 0 0;color:#555">Manual recourse: re-run the download by id, or scripts/finalize-recovered-run.ts once the artifacts re-download.</p>` +
    `</div>`;
  await postOperatorAlert(subject, text, html);
}
