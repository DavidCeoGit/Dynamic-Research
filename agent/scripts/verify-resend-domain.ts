/**
 * verify-resend-domain.ts — Poll the Resend API for the Dynamic Research
 * sending domain's verification status.
 *
 * Use after adding the three DNS records (see
 * Documentation/resend-domain-verification-handoff.md) to confirm Resend
 * has detected and validated them. DNS propagation can take 5-60 minutes;
 * re-run this every few minutes until all records show "verified".
 *
 * Usage:
 *   cd "Dynamic Research/agent"
 *   node --env-file=.env --import=tsx scripts/verify-resend-domain.ts
 *
 * Exit codes:
 *   0 — domain fully verified (overall status === "verified")
 *   1 — domain not yet fully verified, OR any record still pending
 *   2 — environment/API error (missing key, non-2xx response, parse failure)
 *
 * Shipped S40 (2026-05-15) alongside the domain registration.
 */

const RESEND_DOMAINS_API = "https://api.resend.com/domains";
const DOMAIN_ID = "c05332aa-a06a-496e-8767-54c00986b5de";
const DOMAIN_NAME = "send.secure-regenerative.ai";

type ResendRecord = {
  record: string;
  name: string;
  type: string;
  value: string;
  status: string;
  ttl: string;
  priority?: number;
};

type ResendDomainResponse = {
  object: string;
  id: string;
  name: string;
  status: string;
  region: string;
  records: ResendRecord[];
  created_at: string;
};

async function main(): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("[verify-resend-domain] RESEND_API_KEY not set in env.");
    process.exit(2);
  }

  let res: Response;
  try {
    res = await fetch(`${RESEND_DOMAINS_API}/${DOMAIN_ID}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    console.error(`[verify-resend-domain] fetch failed: ${(err as Error).message}`);
    process.exit(2);
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(
      `[verify-resend-domain] HTTP ${res.status}: ${body.slice(0, 300)}`,
    );
    process.exit(2);
  }

  let domain: ResendDomainResponse;
  try {
    domain = (await res.json()) as ResendDomainResponse;
  } catch (err) {
    console.error(`[verify-resend-domain] JSON parse failed: ${(err as Error).message}`);
    process.exit(2);
  }

  console.log(`Domain : ${domain.name}`);
  console.log(`Id     : ${domain.id}`);
  console.log(`Region : ${domain.region}`);
  console.log(`Status : ${domain.status}`);
  console.log("");
  console.log("Records:");
  for (const r of domain.records) {
    const marker = r.status === "verified" ? "✓" : "·";
    const pri = r.priority !== undefined ? ` priority=${r.priority}` : "";
    console.log(`  ${marker} [${r.type}] ${r.name}${pri} — ${r.status}`);
  }
  console.log("");

  if (domain.status === "verified") {
    console.log(`Domain ${DOMAIN_NAME} is fully verified.`);
    console.log("");
    console.log("Next step: set RESEND_FROM_EMAIL in agent/.env to:");
    console.log(`  RESEND_FROM_EMAIL="Dynamic Research <noreply@${DOMAIN_NAME}>"`);
    console.log("Then restart the worker daemon.");
    process.exit(0);
  }

  const pending = domain.records.filter((r) => r.status !== "verified");
  console.log(
    `${pending.length} record(s) still pending. Add them to Cloudflare ` +
      `(zone: secure-regenerative.ai) and re-run this script in a few minutes.`,
  );
  process.exit(1);
}

void main();
