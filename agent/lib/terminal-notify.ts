import { sendCompletionEmail } from "./notify.js";
import type { ResearchJob } from "../types.js";
import type { ReviewFinding } from "./plan-types.js";

function log(context: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${context.slice(0, 8)}] ${msg}`);
}

// ── Email notification on terminal state transitions ────────────────

export async function notifyTerminal(
  job: ResearchJob,
  status: "completed" | "failed",
  errorMessage?: string,
  // S85 (design §5b option 2) — advisory R5 reservations folded into the
  // completion email as non-blocking notes. Only meaningful on the "completed"
  // path; ignored on failure.
  reservations?: ReviewFinding[],
): Promise<void> {
  if (!job.notify_email) return;
  try {
    await sendCompletionEmail({
      to: job.notify_email,
      slug: job.topic_slug,
      topic: job.topic,
      status,
      errorMessage,
      reservations: status === "completed" ? reservations : undefined,
    });
  } catch (err) {
    log(job.id, `[notify] email send failed (non-fatal): ${(err as Error).message}`);
  }
}
