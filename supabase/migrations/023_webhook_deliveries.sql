-- 023_webhook_deliveries.sql
-- ============================================================================
-- F-4 (Webhooks): outbound webhook delivery log + retry queue.
--
-- BACKGROUND
--   The webhooks subsystem was a "vapor feature" — UI promised signed-payload
--   delivery but no delivery code existed. This migration creates the
--   webhook_deliveries table that backs the new delivery pipeline
--   (src/lib/webhooks/deliver.ts) and the cron retry endpoint
--   (src/app/api/cron/webhook-retry/route.ts).
--
-- SCHEMA NOTES
--   • `webhooks.id` and `webhooks.tenant_id` are TEXT (not UUID) on the live
--     DB — see information_schema.columns for `public.webhooks`. We mirror
--     those types here so the FK and joins work without a cast.
--   • `payload` is JSONB — holds the FULL signed payload that was sent
--     (event, entity_type, entity_id, tenant_id, timestamp, data). This lets
--     us retry with the exact original body (deterministic signature).
--   • `status` is one of: 'pending' | 'delivered' | 'failed'.
--   • `attempts` counts total HTTP attempts (1 on first try, up to 5).
--   • `next_attempt_at` gates the retry — null means "no further retry".
--   • `response_status` / `response_body` capture the remote's reply for
--     debugging (body truncated to 2000 chars in code).
--
-- RLS
--   Enabled + tenant-scoped (parity with `webhooks` table — see 001_fix_rls).
--   The app uses service_role (bypasses RLS) for writes; RLS is defense-in-
--   depth against anon-key access.
--
-- PG_CRON
--   A `webhook-retry` job calls /api/cron/webhook-retry every 5 minutes via
--   the `net.http_get` wrapper (same pattern as subscription-sweep-hourly).
--   The CRON_TOKEN is the same shared secret used by other cron endpoints.
-- ============================================================================

-- ─── 1. Table ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  webhook_id      TEXT NOT NULL REFERENCES public.webhooks(id) ON DELETE CASCADE,
  tenant_id       TEXT NOT NULL,
  event           TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  response_body   TEXT,
  delivered_at    TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 2. Indexes ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id
  ON public.webhook_deliveries(webhook_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_tenant_id
  ON public.webhook_deliveries(tenant_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status
  ON public.webhook_deliveries(status);
-- Partial index for the retry sweep — only rows that still need a retry.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_next_attempt
  ON public.webhook_deliveries(next_attempt_at)
  WHERE next_attempt_at IS NOT NULL;
-- Compound index for the cron sweep's main query: status='failed' AND
-- attempts < 5 AND next_attempt_at <= now().
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry
  ON public.webhook_deliveries(status, attempts, next_attempt_at)
  WHERE status = 'failed';

-- ─── 3. Row Level Security ────────────────────────────────────────────────
ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

-- Drop any pre-existing policies (idempotent re-runs).
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'webhook_deliveries'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.webhook_deliveries', rec.policyname);
  END LOOP;
END $$;

-- Tenant-scoped policies (defense-in-depth — service_role bypasses RLS).
CREATE POLICY webhook_deliveries_tenant_select
  ON public.webhook_deliveries
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY webhook_deliveries_tenant_insert
  ON public.webhook_deliveries
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY webhook_deliveries_tenant_update
  ON public.webhook_deliveries
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY webhook_deliveries_tenant_delete
  ON public.webhook_deliveries
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true));

-- ─── 4. pg_cron: retry failed deliveries every 5 minutes ──────────────────
-- Uses the same net.http_get + CRON_TOKEN pattern as subscription-sweep-hourly.
-- The endpoint is idempotent: it re-reads the failed deliveries list and
-- retries each up to MAX_WEBHOOK_ATTEMPTS (5) times.
SELECT cron.unschedule('webhook-retry')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'webhook-retry');

-- Audit 2c-F2 fix: the literal CRON_TOKEN `DSn63EDE...` that was previously
-- hardcoded in this URL has been removed. It was committed to public git
-- history and must be rotated. The token is now read at runtime from the
-- Postgres setting `app.cron_token` (set via
--   ALTER DATABASE postgres SET app.cron_token = '<rotated-token>';
-- ). Migrations 025 and 036 already applied this pattern to the LIVE DB;
-- this redaction only affects fresh DBs (the live DB skips 023 because it
-- is already recorded in supabase_migrations). The operator MUST:
--   1. Generate a new token: openssl rand -hex 32
--   2. Set it in the Next.js env: CRON_TOKEN=<new-token>
--   3. Set it in the DB: ALTER DATABASE postgres SET app.cron_token = '<new-token>';
--   4. Scrub git history: git filter-repo --replace-text (replace the old
--      literal token string with `REDACTED` across all commits).
-- If app.cron_token is unset, the URL has `?token=` (empty) and the cron-auth
-- check rejects the request — fail-loud, no silent breakage.
SELECT cron.schedule(
  'webhook-retry',
  '*/5 * * * *',  -- every 5 minutes
  $$
    SELECT net.http_get(
      url := 'https://aspidus.onrender.com/api/cron/webhook-retry?token='
            || COALESCE(nullif(current_setting('app.cron_token', true), ''), '')
    );
  $$
);

-- ─── 5. Verify ────────────────────────────────────────────────────────────
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'webhook-retry';
