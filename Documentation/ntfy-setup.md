# Phone push alerts on new research requests (Phase A, S103)

What this is: a Supabase `AFTER INSERT` trigger on `public.research_queue` that
POSTs a REDACTED payload to **ntfy.sh**. Your phone subscribes to the same topic
and shows a push notification within ~1 second of any new submission.

## Privacy contract (HARD — Gemini MERGE-gate M-2 hardened)

The trigger sends ONLY:

- `new.id` (the row UUID)
- `substr(new.organization_id::text, 1, 8)` (first 8 chars of org id)

It NEVER sends `new.topic`, `new.context`, or anything user-supplied. The
ntfy.sh public server therefore sees only timing + opaque identifiers — no
research content.

The ntfy **topic name** itself is treated as a secret (anyone with it can
subscribe and read every future notification). It lives in
**Supabase Vault** (`vault.decrypted_secrets[name=dr_ntfy_topic]`),
encrypted at rest, and is NOT exported in plaintext by `pg_dump`. Earlier
v1 of this design stored the topic in a private table; Gemini's holistic-
adversarial pass blocked it on the pg_dump exposure.

## Failure semantics (operator MUST know this — M-1)

`pg_net.http_post` runs ASYNC. The trigger queues the request and returns;
the actual HTTP call happens in a background worker. Consequence:

- **Sync errors** (URL parse, queue full, Vault read failure) → caught by the
  function's EXCEPTION block, logged as WARNING, never blocks the INSERT.
- **HTTP errors** (ntfy.sh 5xx, timeout, 429 rate-limit) → recorded in
  `net._http_response` and **silent everywhere else**. Phone simply won't buzz.

**Operator monitoring query** (paste into Studio SQL periodically):

```sql
select created, status_code, error_msg, content
  from net._http_response
  where created > now() - interval '24 hours'
    and (status_code is null or status_code >= 400);
```

If results appear consistently → topic broken, rate-limited, or ntfy down.

## Setup (one-time, ~10 minutes)

### Step 1 — Pick an unguessable topic name

A pre-generated suggestion (cryptographically random, 16 bytes → base64url):

    dr-queue-FRQXniWBILakC_s8PNoirA

Treat this as a SECRET. Don't commit it; don't share it. If you'd rather
generate your own:

    node -e "console.log('dr-queue-' + require('crypto').randomBytes(16).toString('base64url'))"

### Step 2 — Install the ntfy app

- iOS:     https://apps.apple.com/us/app/ntfy/id1625396347
- Android: https://play.google.com/store/apps/details?id=io.heckel.ntfy
- F-Droid: https://f-droid.org/en/packages/io.heckel.ntfy/

### Step 3 — Subscribe on phone

Open the app → "+" → Subscribe to topic → paste your topic name from Step 1
(no `https://ntfy.sh/` prefix — just `dr-queue-FRQXniWBILakC_s8PNoirA`).
Default server `ntfy.sh` is fine.

### Step 4 — Apply the migration

After `/promote` lands the SQL file under `supabase/migrations/`:

    supabase db push

This installs `pg_net` + `supabase_vault`, creates `private.notification_config`
(disabled), the SECURITY DEFINER trigger function, and the trigger. Nothing
fires yet — `enabled = false` AND no vault secret is configured.

### Step 5 — Store the topic in Vault (Studio SQL Editor)

```sql
select vault.create_secret(
  'dr-queue-FRQXniWBILakC_s8PNoirA',           -- your topic name from Step 1
  'dr_ntfy_topic',                              -- fixed name; the trigger reads this
  'Unguessable ntfy.sh topic for DR phone alerts (S103 Phase A)'
);
```

Verify it landed:

```sql
select name, description, created_at
  from vault.secrets
  where name = 'dr_ntfy_topic';
```

The `vault.decrypted_secrets` VIEW (which the trigger reads) is not directly
SELECTable for the topic value — that's the point. The `vault.secrets` table
shows metadata only.

### Step 6 — Enable the trigger (Studio SQL Editor)

```sql
update private.notification_config
   set enabled    = true,
       updated_at = now()
 where id = 1;
```

The `private` schema is not exposed via PostgREST, so this UPDATE must run
from Studio SQL Editor or psql with service-role — `supabase-js` won't reach
it.

### Step 7 — Smoke test

Submit any research request via the web form. Phone should buzz within ~1s
with title "Dynamic Research" and body `New request id=<uuid> org=<8-char>`.

After the buzz, sanity-check telemetry:

```sql
select enabled, last_notified_at
  from private.notification_config
  where id = 1;
-- expect last_notified_at within the last minute.

select created, status_code
  from net._http_response
  order by created desc
  limit 1;
-- expect status_code = 200.
```

## Operations

**Disable without removing the trigger:**

```sql
update private.notification_config set enabled = false where id = 1;
```

**Rotate the topic** (e.g., if you suspect the topic name leaked):

1. Pick a new topic name.
2. Subscribe to it in the phone app.
3. Update Vault:
   ```sql
   select vault.update_secret(
     (select id from vault.secrets where name = 'dr_ntfy_topic'),
     '<new-topic-name>'
   );
   ```
4. Unsubscribe from the old topic in the phone app.

No app redeploy needed.

## What's promoted where

- `20260610_phase_a_notifications_ntfy_webhook.sql` → `supabase/migrations/`
- `NTFY-SETUP.md` → `Documentation/ntfy-setup.md`

The topic name itself never enters git — it's stored only in Vault.

## MRPF gate provenance

MERGE gate, labels = **INFRA + PRIVACY**, severity NORMAL. Reviewer chain:

1. **Gemini 3.1 Pro holistic-adversarial** — verdict BLOCK on v1; B-1 (pg_net
   schema mismatch), B-2 (missing automated-test justification), M-1 (async
   semantics misclaim), M-2 (plaintext-secret pg_dump exposure), m-1 (bulk-
   write amplification), m-2 (naming) all integrated into v2 above.
2. **Codex grounded-adversarial** (via API-key fallback per ~/CLAUDE.md §1a;
   ChatGPT-Codex quota was exhausted, reset 19:03 local) — pending at time
   of this writing; findings will land in the synthesis doc at
   `Documentation/ntfy-webhook-merge-gate-peer-review.md`.

Test coverage: **not automated** (justified in the SQL file header). Manual
smoke test at Steps 7 covers the only failure mode that matters.
