/**
 * Cancel a research_queue job by ID.
 *
 * Usage:
 *   cd agent && node --env-file=.env --import=tsx scripts/cancel-job.ts <job-id> [reason]
 *
 * Reads SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL from agent/.env.
 * PATCHes the row to status=cancelled, sets completed_at, and writes a reason.
 *
 * Single-purpose, narrow scope: only modifies the research_queue table,
 * only one row at a time, only sets cancellation fields.
 */

const id = process.argv[2];
const reason = process.argv[3] ?? "Cancelled by operator (autonomous cleanup script)";

if (!id) {
  console.error("usage: cancel-job.ts <job-id> [reason]");
  process.exit(2);
}

if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
  console.error(`refusing: "${id}" is not a UUID — bail out to avoid hitting wrong rows`);
  process.exit(2);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env");
  process.exit(2);
}

const body = JSON.stringify({
  status: "cancelled",
  error_message: reason,
  completed_at: new Date().toISOString(),
});

const res = await fetch(`${url}/rest/v1/research_queue?id=eq.${id}`, {
  method: "PATCH",
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  },
  body,
});

const text = await res.text();
console.log(`HTTP ${res.status}`);
console.log(text);

if (!res.ok) {
  process.exit(1);
}

export {};
