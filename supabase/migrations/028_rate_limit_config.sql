-- 028_rate_limit_config.sql
-- Rate limit configuration is stored as a platform-wide setting (tenant_id IS NULL).
-- This migration adds a partial unique index to ensure only one row per key
-- when tenant_id is null, and seeds the default config.

CREATE UNIQUE INDEX IF NOT EXISTS settings_global_key_idx
ON public.settings (key)
WHERE tenant_id IS NULL;

-- Seed default rate limit config (idempotent)
INSERT INTO public.settings (key, value, tenant_id)
VALUES (
  'rate_limit_config',
  '{
    "loginMaxAttempts": 20,
    "loginWindowMs": 900000,
    "portalLoginMaxAttempts": 20,
    "portalLoginWindowMs": 900000,
    "forgotPasswordMaxAttempts": 5,
    "forgotPasswordWindowMs": 900000,
    "setupPasswordMaxAttempts": 10,
    "setupPasswordWindowMs": 900000,
    "middlewareLoginMaxRequests": 30,
    "middlewarePortalLoginMaxRequests": 30
  }'::jsonb,
  NULL
)
ON CONFLICT DO NOTHING;
