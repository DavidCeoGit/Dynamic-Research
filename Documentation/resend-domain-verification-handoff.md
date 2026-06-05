# Resend Domain Verification — Handoff

**Status:** Domain registered with Resend, awaiting DNS records in Cloudflare.
**Registered:** 2026-05-15 (S40, deferred item 2).
**Domain:** `send.secure-regenerative.ai`
**Resend domain id:** `c05332aa-a06a-496e-8767-54c00986b5de`
**Region:** `us-east-1`

Once these records propagate and Resend marks the domain verified, the email-completion-notification feature (`agent/lib/notify.ts`) will send to ANY external recipient — closes [[feedback_resend_free_tier_own_email_only]].

---

## Manual Steps Remaining

### 1. Add three DNS records in Cloudflare (zone: `secure-regenerative.ai`)

| Type | Name (Cloudflare field) | Content / Value | Priority | TTL |
|------|-------------------------|-----------------|----------|-----|
| TXT  | `resend._domainkey.send` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDJ/R4Y0WYn3D/sW3AWTYtJqH5WKgKVnFOFr0+yvSPf3+ztgvsPoApe3zDClJ06Vun2n+wkAOL3nD4zdwdkzjfYGLgHnKQfnBLt+9Ozj+O1WMsuX9I4tB5aDI5+EJHKEpCXewtsBsG1gpa1oGTAiZpAFhwmRayOCHjpLK6mz7MvBQIDAQAB` | — | Auto |
| MX   | `send.send` | `feedback-smtp.us-east-1.amazonses.com` | 10 | Auto |
| TXT  | `send.send` | `v=spf1 include:amazonses.com ~all` | — | Auto |

**Notes on the `send.send` records:** Resend uses `send.<subdomain>` as the bounce-handling subdomain. Since we verified the subdomain `send.secure-regenerative.ai`, the bounce-handling FQDN is `send.send.secure-regenerative.ai`. The Cloudflare "Name" field above is the prefix relative to the zone root.

**Cloudflare DNS proxy:** Leave "DNS only" (grey cloud). Email-auth records must NOT be proxied through Cloudflare's HTTP proxy.

### 2. Trigger verification in Resend

Either click "Verify DNS Records" in the Resend dashboard, or run the verify script:

```bash
cd "Dynamic Research/agent"
node --env-file=.env --import=tsx scripts/verify-resend-domain.ts
```

Re-run every few minutes until all three records show `status: "verified"` and the overall domain status flips to `verified`. DNS propagation is typically 5-60 minutes (Cloudflare's flat-namespace TTL is near-instant for new records, but Resend caches its lookups).

### 3. Set `RESEND_FROM_EMAIL` after the domain is verified

In `agent/.env` (and Vercel project env vars if email sending ever moves to Vercel):

```
RESEND_FROM_EMAIL="Dynamic Research <noreply@send.secure-regenerative.ai>"
```

The `agent/lib/notify.ts` sender already reads this env var ([notify.ts:43](agent/lib/notify.ts#L43)) — when set, it overrides the default `onboarding@resend.dev` from-address.

### 4. Restart the worker daemon

The worker reads env vars at startup, so the new `RESEND_FROM_EMAIL` is picked up on restart:

```bash
# Find PID
tasklist | grep node.exe
# Kill old PID (PID-file singleton auto-handles stale entries on next start)
taskkill /F /PID <old-pid>
# Restart
cd "Dynamic Research/agent"
node --env-file=.env --import=tsx worker.ts
```

### 5. Send a test email

Submit a tiny research run with `notify_email` set to a non-account-owner address (e.g., Kim) and watch worker logs for `[notify] email sent to ...`. Verify the recipient actually received it.

---

## What was already done in this session (S40)

- Registered domain via Resend API:
  ```
  POST https://api.resend.com/domains
  body: {"name":"send.secure-regenerative.ai","region":"us-east-1"}
  ```
- Captured the DNS records (above).
- Wrote the verify script at [agent/scripts/verify-resend-domain.ts](agent/scripts/verify-resend-domain.ts).
- This handoff doc.

## What is NOT done

- Cloudflare DNS records (step 1) — user action.
- Resend verification trigger (step 2) — user action OR run the verify script.
- `RESEND_FROM_EMAIL` env update (step 3) — blocked on verification.
- Test send (step 5) — blocked on verification.

## Rollback / re-create

If the subdomain naming feels awkward (`send.send.secure-regenerative.ai` for bounce records) and the user prefers verifying the root domain `secure-regenerative.ai` directly:

```bash
# Delete the subdomain domain registration
curl -X DELETE https://api.resend.com/domains/c05332aa-a06a-496e-8767-54c00986b5de \
  -H "Authorization: Bearer $RESEND_API_KEY"

# Register the root
curl -X POST https://api.resend.com/domains \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"secure-regenerative.ai","region":"us-east-1"}'
```

Tradeoff: root verification gives cleaner record names (`resend._domainkey`, `send`, `send` instead of `resend._domainkey.send`, `send.send`, `send.send`), but shares the SPF surface with any other service that also sends from the root (currently none — bot.secure-regenerative.ai is webhook-receive only, not a sender).
