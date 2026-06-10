-- Phase A: ntfy.sh phone push notification on new research request (S103, v2).
--
-- Trigger:   AFTER INSERT ON public.research_queue
-- Action:    POST a REDACTED payload (id + 8-char org prefix) to ntfy.sh
-- Privacy:   no topic body, no user-supplied content. Just "something landed".
-- Failure:   pg_net.http_post is ASYNC — see "FAILURE SEMANTICS" below.
--
-- MRPF: MERGE gate, labels = INFRA + PRIVACY. Sequential Gemini -> Codex.
-- v2 integrates Gemini holistic-adversarial findings:
--   B-1 → pg_net schema clause dropped (extension hardcodes `net`).
--   B-2 → automated-test justification block below.
--   M-1 → pg_net async semantics documented + operator monitoring query.
--   M-2 → ntfy topic moved to Supabase Vault (was plaintext in private.*).
--   m-1 → write-amplification note (acceptable Phase A; single insert path).
--
-- Post-deploy config (one-time, NOT in this migration):
--   select vault.create_secret(
--            '<unguessable-topic-name>',
--            'dr_ntfy_topic',
--            'Unguessable ntfy.sh topic for Dynamic Research phone alerts (S103)');
--   update private.notification_config set enabled = true where id = 1;
-- See Documentation/ntfy-setup.md for phone-side setup + topic-name generation.
--
-- ─────────────────────────────────────────────────────────────────────────
-- TEST COVERAGE JUSTIFICATION (MRPF PRIVACY-labeled change, B-2):
-- This migration has NO automated test. Reasons:
--   (1) pg_net.http_post is ASYNC — the request is queued to a background
--       worker; a synchronous "did the call happen" assertion in node --test
--       would race the worker.
--   (2) Integration test requires either a controllable ntfy.sh test endpoint
--       OR a mock at the pg_net layer; neither fixture exists in DR today.
--   (3) The trigger logic is dead-simple: read flag, read vault secret, format
--       redacted payload, call http_post. The only branching is "disabled →
--       no call" + "enabled → 1 call", which the manual smoke test in
--       Documentation/ntfy-setup.md covers in one step.
-- FOLLOW-UP (NOT blocking Phase A): when the notification surface grows beyond
-- this single trigger (e.g., job-completion / error alerts), add an
-- integration test that polls net._http_response after a research_queue
-- INSERT and asserts on url+body. Track in handoff under "parked".
--
-- ─────────────────────────────────────────────────────────────────────────
-- FAILURE SEMANTICS (M-1 — operator must know this):
-- The `exception when others` block in the trigger function catches
-- SYNCHRONOUS errors only (URL parse, queue-insert errors, vault read
-- failures). HTTP-level failures from ntfy.sh (5xx, timeouts, 429 rate
-- limits) occur in pg_net's BACKGROUND WORKER and are recorded in
-- `net._http_response`. They do NOT propagate to the trigger context, so
-- a silent ntfy outage will not raise anywhere visible.
--
-- OPERATOR MONITORING QUERY (run periodically or wire to cron):
--   select created, status_code, error_msg, content
--     from net._http_response
--     where created > now() - interval '24 hours'
--       and (status_code is null or status_code >= 400);
-- If results appear consistently, the ntfy topic is broken or rate-limited.

-- ---------------------------------------------------------------------------
-- 1. Extensions. pg_net hardcodes schema `net` in its control file — do NOT
-- pass `with schema extensions` (Gemini B-1: schema mismatch error at apply).
-- supabase_vault provides encrypted secret storage at `vault` schema (M-2);
-- canonical extension name is `supabase_vault` per the official control file
-- (github.com/supabase/vault/blob/main/supabase_vault.control). Codex
-- grounded-adversarial flagged this name as `vault` instead; that claim was
-- REJECTED after primary-source verification — see
-- Documentation/ntfy-webhook-merge-gate-peer-review.md §Codex-B-1.
--
-- Defensive precondition (addresses Codex B-1's robustness intent): give a
-- clear operator-actionable error if Vault isn't available on this project
-- (Vault must be enabled via the Supabase dashboard for some older projects).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'supabase_vault')
     and not exists (select 1 from pg_available_extensions where name = 'supabase_vault') then
    raise exception
      'supabase_vault extension not available on this project. Enable Vault in the Supabase dashboard (Database → Extensions → supabase_vault) before applying this migration. (Phase A ntfy webhook).';
  end if;
end$$;

create extension if not exists pg_net;
create extension if not exists supabase_vault;

-- ---------------------------------------------------------------------------
-- 2. Defensive runtime check: fail loudly if pg_net.http_post is unreachable.
-- Belt-and-suspenders for B-1: if a future pg_net version moves the function
-- OR Supabase changes its install schema, the migration aborts here instead
-- of producing a silent runtime failure inside the EXCEPTION block.
-- ---------------------------------------------------------------------------
do $$
begin
  perform 1
    from pg_proc p
    join pg_namespace n on p.pronamespace = n.oid
    where n.nspname = 'net' and p.proname = 'http_post';
  if not found then
    raise exception 'pg_net.http_post() not reachable at schema "net" — verify pg_net is installed at expected schema. Migration aborted (Phase A ntfy webhook).';
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- 3. Private config schema. RLS not needed; we revoke all grants from anon +
-- authenticated, and the schema is not exposed via PostgREST. The SECURITY
-- DEFINER trigger function runs as postgres which retains access.
-- The TOPIC ITSELF lives in supabase_vault (M-2); this table holds only the
-- enabled flag + operational metadata.
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to postgres, service_role;

create table if not exists private.notification_config (
  id                integer primary key default 1,
  enabled           boolean not null default false,
  last_notified_at  timestamptz,
  updated_at        timestamptz not null default now(),
  constraint notification_config_single_row check (id = 1)
);

revoke all on private.notification_config from public, anon, authenticated;
grant select, update on private.notification_config to postgres, service_role;

insert into private.notification_config (id, enabled)
values (1, false)
on conflict (id) do nothing;

comment on table private.notification_config is
  'Single-row enabled-flag for phone-push notifications (S103). The actual ntfy topic name is in supabase_vault as secret "dr_ntfy_topic" — NOT in this table (Gemini-MERGE-gate M-2: pg_dump would export plaintext). enabled=false short-circuits the trigger; last_notified_at is operational telemetry.';

-- ---------------------------------------------------------------------------
-- 4. Trigger function. SECURITY DEFINER + empty search_path; every identifier
-- below is schema-qualified.
-- ---------------------------------------------------------------------------
create or replace function public.notify_new_request_ntfy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_enabled boolean;
  v_topic   text;
  v_payload jsonb;
begin
  select enabled into v_enabled from private.notification_config where id = 1;
  if not coalesce(v_enabled, false) then
    return new;
  end if;

  -- Read ntfy topic from Vault. Encrypted at rest; not exported by pg_dump
  -- in plaintext (M-2). If no secret is configured, no-op.
  select decrypted_secret into v_topic
    from vault.decrypted_secrets
    where name = 'dr_ntfy_topic'
    limit 1;

  if v_topic is null or v_topic = '' then
    return new;
  end if;

  -- REDACTED payload contract (HARD): id + 8-char org prefix ONLY.
  -- NEVER include new.topic / new.context / any user-supplied prose —
  -- ntfy.sh's public server would see whatever we send.
  v_payload := jsonb_build_object(
    'topic',    v_topic,
    'title',    'Dynamic Research',
    'message',  format(
                  'New request id=%s org=%s',
                  new.id::text,
                  coalesce(substr(new.organization_id::text, 1, 8), 'unknown')
                ),
    'priority', 4,
    'tags',     jsonb_build_array('inbox_tray')
  );

  -- ASYNC: queues to net._http_response background worker. Sync errors caught
  -- below; HTTP-level errors land in net._http_response (see FAILURE
  -- SEMANTICS at file head + operator monitoring query).
  perform net.http_post(
    url                  := 'https://ntfy.sh',
    body                 := v_payload,
    headers              := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 3000
  );

  update private.notification_config set last_notified_at = now() where id = 1;

  return new;
exception
  when others then
    raise warning 'notify_new_request_ntfy failed (sync): % (sqlstate %)', sqlerrm, sqlstate;
    return new;
end;
$$;

revoke all on function public.notify_new_request_ntfy() from public, anon, authenticated;

comment on function public.notify_new_request_ntfy() is
  'AFTER INSERT trigger on public.research_queue: posts a REDACTED notification (id + 8-char org prefix; NO user content) to the ntfy.sh topic held in vault.decrypted_secrets[name=dr_ntfy_topic]. Synchronous errors are warned. ASYNC HTTP failures land in net._http_response (operator must poll). enabled flag in private.notification_config gates the whole path.';

-- ---------------------------------------------------------------------------
-- 5. Trigger. AFTER INSERT only — status transitions are operational noise.
-- m-1 (write amplification on bulk insert): acceptable Phase A. The ONLY
-- insert path today is POST /api/queue (one row per submission). If a bulk
-- replay/import path lands, revisit: either add `when (pg_trigger_depth() = 0
-- and TG_OP = 'INSERT')` gating, or convert to STATEMENT trigger that
-- aggregates rows from the insertion into one notification.
-- ---------------------------------------------------------------------------
drop trigger if exists trg_notify_new_request_ntfy on public.research_queue;

create trigger trg_notify_new_request_ntfy
after insert on public.research_queue
for each row
execute function public.notify_new_request_ntfy();
