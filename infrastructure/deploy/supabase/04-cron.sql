-- Unattended SLA processing while the free web service sleeps (run as `postgres`; requires the pg_cron and pg_net
-- extensions and Vault — verify availability on the project's plan first). The machine credential lives in Vault,
-- never in the job text. Idempotency-Key = the scheduled minute, so pg_net/cron retries of one slot replay.
--   psql "$SUPABASE_ADMIN_URL" -v app_url="https://<service>.onrender.com" -v token="$SWEEP_TRIGGER_TOKEN" \
--        -v schedule='*/30 * * * *' -f infrastructure/deploy/supabase/04-cron.sql
\set ON_ERROR_STOP on
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
SELECT vault.create_secret(:'token', 'frontdesk_sweep_trigger_token', 'Machine credential for POST /api/internal/sweep');
SELECT cron.schedule(
  'frontdesk-sla-sweep',
  :'schedule',
  format($job$
    SELECT net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'frontdesk_sweep_trigger_token'),
        'Idempotency-Key', 'cron-' || to_char(date_trunc('minute', now() AT TIME ZONE 'UTC'), 'YYYYMMDDHH24MI'),
        'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000 -- a sleeping free instance needs ~1 min to start
    )$job$, :'app_url' || '/api/internal/sweep')
);
SELECT jobid, schedule, jobname FROM cron.job WHERE jobname = 'frontdesk-sla-sweep';
