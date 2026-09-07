-- 096_cron_vercel_urls.sql
-- ============================================================================
-- RE-POINT pg_cron HTTP JOBS FROM THE RETIRED RENDER HOST TO VERCEL.
--
-- Background
-- ----------
-- The platform moved from Render (aspidus.onrender.com — now DEAD) to
-- Vercel (https://velos-platform.vercel.app) a long time ago, but the
-- pg_cron jobs scheduled by older migrations (023/025/034/036/039) still
-- called the dead Render host. Every HTTP-based cron job therefore failed
-- silently in the background (net.http_get to a host that no longer
-- resolves / serves the app):
--   • subscription-sweep-hourly  (023/036)
--   • webhook-retry              (023/036) — every 5 minutes!
--   • invoice-overdue-check      (025/036)
--   • breach-notification-check  (039)
--   • data-retention-cleanup     (034)
--
-- Owner directive (2026-04): "NE STAVLJAMO APLIKACIJU NA RENDER VEC NA
-- VERCEL" — the app lives on Vercel only. Render is not used at all.
--
-- This migration re-schedules all five jobs with:
--   • url := 'https://velos-platform.vercel.app/api/cron/<endpoint>'
--   • the SAME hybrid token lookup introduced by 036:
--       COALESCE(
--         nullif(current_setting('app.cron_token', true), ''),
--         (SELECT value FROM public.app_config WHERE key = 'cron_token')
--       )
--   • the schedules the LIVE database was running when 096 was authored
--     (verified via `SELECT jobid, schedule FROM cron.job`).
--
-- Idempotent
-- ----------
-- Every unschedule is guarded with `WHERE EXISTS`, and cron.schedule with
-- a jobname UPSERTS the existing job (same name → replaced command). Safe
-- to re-run; a second run produces identical cron.job state.
-- ============================================================================

-- ─── 1. subscription-sweep-hourly ──────────────────────────────────────────
SELECT cron.unschedule('subscription-sweep-hourly')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'subscription-sweep-hourly');

SELECT cron.schedule(
  'subscription-sweep-hourly',
  '0 * * * *',  -- every hour at minute 0 (live schedule at time of 096)
  $cmd$
    SELECT net.http_get(
      url := 'https://velos-platform.vercel.app/api/cron/subscription-sweep',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || COALESCE(
          nullif(current_setting('app.cron_token', true), ''),
          (SELECT value FROM public.app_config WHERE key = 'cron_token')
        )
      )
    )
  $cmd$
);

-- ─── 2. webhook-retry ──────────────────────────────────────────────────────
SELECT cron.unschedule('webhook-retry')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'webhook-retry');

SELECT cron.schedule(
  'webhook-retry',
  '*/5 * * * *',  -- every 5 minutes
  $cmd$
    SELECT net.http_get(
      url := 'https://velos-platform.vercel.app/api/cron/webhook-retry',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || COALESCE(
          nullif(current_setting('app.cron_token', true), ''),
          (SELECT value FROM public.app_config WHERE key = 'cron_token')
        )
      )
    )
  $cmd$
);

-- ─── 3. invoice-overdue-check ──────────────────────────────────────────────
SELECT cron.unschedule('invoice-overdue-check')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'invoice-overdue-check');

SELECT cron.schedule(
  'invoice-overdue-check',
  '0 9 * * *',  -- daily at 09:00 UTC
  $cmd$
    SELECT net.http_get(
      url := 'https://velos-platform.vercel.app/api/cron/invoice-overdue',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || COALESCE(
          nullif(current_setting('app.cron_token', true), ''),
          (SELECT value FROM public.app_config WHERE key = 'cron_token')
        )
      )
    )
  $cmd$
);

-- ─── 4. breach-notification-check ──────────────────────────────────────────
SELECT cron.unschedule('breach-notification-check')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'breach-notification-check');

SELECT cron.schedule(
  'breach-notification-check',
  '0 * * * *',  -- hourly (live schedule at time of 096)
  $cmd$
    SELECT net.http_get(
      url := 'https://velos-platform.vercel.app/api/cron/breach-notification-check',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || COALESCE(
          nullif(current_setting('app.cron_token', true), ''),
          (SELECT value FROM public.app_config WHERE key = 'cron_token')
        )
      )
    )
  $cmd$
);

-- ─── 5. data-retention-cleanup ─────────────────────────────────────────────
SELECT cron.unschedule('data-retention-cleanup')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'data-retention-cleanup');

SELECT cron.schedule(
  'data-retention-cleanup',
  '0 4 * * *',  -- daily at 04:00 UTC
  $cmd$
    SELECT net.http_get(
      url := 'https://velos-platform.vercel.app/api/cron/data-retention',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || COALESCE(
          nullif(current_setting('app.cron_token', true), ''),
          (SELECT value FROM public.app_config WHERE key = 'cron_token')
        )
      )
    )
  $cmd$
);

-- ─── 6. Verification: no HTTP cron job may reference the dead Render host ──
--   Expected: 0 rows after a successful apply.
SELECT jobname, schedule, active
  FROM cron.job
  WHERE command LIKE '%net.http_get%'
    AND command LIKE '%onrender.com%'
  ORDER BY jobname;

-- ─── 7. Summary: all HTTP-based cron jobs (for ops visibility) ─────────────
SELECT jobname, schedule, active
  FROM cron.job
  WHERE command LIKE '%net.http_get%'
  ORDER BY jobname;
-- ============================================================================
