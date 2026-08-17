-- 041_retention_config_setting.sql
-- ============================================================================
-- P1-1 / Feature 3 — Configurable per-table retention windows.
--
-- Background
-- ----------
-- Until now the data-retention policy (`src/lib/compliance/retention.ts`)
-- used HARDCODED windows — a super-admin who wanted to tighten or
-- loosen a retention period had to file a code change + redeploy. The
-- new `RetentionConfig` interface lets the admin change windows from
-- the `/api/settings/retention-config` route (super-admin only).
--
-- This migration seeds the platform-wide `settings` row with the
-- defaults so the cron route sees a known-good config on first run
-- even if no admin has saved a config yet.
--
-- The cron route (`src/app/api/cron/data-retention/route.ts`) calls
-- `getRetentionConfig()` to load this row, then
-- `getEnforceableRetentionRules(config)` to build the per-table
-- DELETE list using the config's `days` / `hours` values.
--
-- Idempotent: `ON CONFLICT DO NOTHING` so re-running the migration
-- doesn't overwrite an admin-configured value.
-- ============================================================================

INSERT INTO public.settings (key, value, tenant_id)
VALUES (
  'retention_config',
  '{
    "sessions_days": 30,
    "login_history_days": 365,
    "password_resets_hours": 24,
    "rate_limits_hours": 24,
    "mail_queue_days": 90,
    "notifications_days": 90,
    "audit_logs_years": 7,
    "kyc_submissions_years": 5
  }'::jsonb,
  NULL
)
ON CONFLICT DO NOTHING;

-- ─── Verify ────────────────────────────────────────────────────────────────
SELECT key, value, tenant_id
  FROM public.settings
  WHERE key = 'retention_config';
