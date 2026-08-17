-- 005_portal_access_last_login_country.sql
-- ============================================================================
-- Adds a `last_login_country` column to `portal_access`.
--
-- WHY?
--   The portal login flow resolves the caller's IP to a country (via the
--   ipapi.co integration in src/lib/utils/geo-ip.ts) and we want that country
--   to be visible alongside the existing `last_login_at` / `last_login_ip`
--   columns on the portal access admin screen.
--
-- BACKWARD COMPATIBILITY:
--   The application code in src/lib/data/supabase-store.ts (upsertPortalAccess)
--   gracefully tolerates the absence of this column: if the migration has not
--   been applied yet, the upsert detects the "column does not exist" error
--   and retries without the column, so portal logins keep working. Apply this
--   migration to enable population of `last_login_country`.
-- ============================================================================

ALTER TABLE portal_access
  ADD COLUMN IF NOT EXISTS last_login_country text;

COMMENT ON COLUMN portal_access.last_login_country IS
  'Country name (ISO long form, e.g. "United Arab Emirates") of the IP that performed the most recent successful portal login. Populated by src/app/api/portal/login/route.ts via src/lib/utils/geo-ip.ts. Nullable when geo lookup failed or migration not yet applied.';
