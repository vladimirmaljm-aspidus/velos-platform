-- 019_portal_access_locale.sql
-- ============================================================================
-- Add per-client locale preference to portal_access.
-- Each portal client can choose their preferred language (en/sr/tr/de/ru).
-- The locale is saved when they switch languages in the portal UI and
-- restored on next login.
-- ============================================================================

ALTER TABLE public.portal_access
  ADD COLUMN IF NOT EXISTS locale text DEFAULT 'en';

COMMENT ON COLUMN public.portal_access.locale IS
  'Per-client language preference (en/sr/tr/de/ru). Set by the portal '
  'language selector, restored on login.';

-- Verify
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'portal_access' AND column_name = 'locale';
