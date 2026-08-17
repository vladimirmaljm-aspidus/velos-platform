-- 015_portal_access_gps_verified_at.sql
-- ============================================================================
-- Adds a `gps_verified_at` timestamp column to `portal_access`.
--
-- WHY?
--   The portal shell blocks rendering UI until the browser shares GPS
--   (client-side), but every portal data endpoint only checked
--   `getPortalSessionAccess()` + KYC — none verified GPS was actually shared.
--   A portal user with a valid session cookie could `curl /api/portal/offers`
--   and receive data without ever granting location. (Audit finding P0-3/D-3.)
--
--   This column is the server-side gate. It is set to `now()` by
--   `/api/portal/log-location` whenever the browser shares precise GPS
--   (source === "browser"), and checked by `src/lib/portal/require-gps.ts`,
--   which returns 403 for non-premium / non-exempt clients whose
--   `gps_verified_at` is missing or older than 24 hours.
--
-- BACKWARD COMPATIBILITY:
--   The application code in src/lib/data/supabase-store.ts (upsertPortalAccess)
--   tolerates the absence of this column: it is listed in
--   `columnsThatMayNotExist`, so when migration 015 hasn't been applied yet,
--   the upsert strips the column from the payload and retries on schema
--   error. The prisma-store also handles this gracefully via try/catch at
--   the caller. Apply this migration to enable population of
--   `gps_verified_at` and unlock the server-side GPS gate.
-- ============================================================================

ALTER TABLE portal_access
  ADD COLUMN IF NOT EXISTS gps_verified_at timestamptz;

COMMENT ON COLUMN portal_access.gps_verified_at IS
  'ISO timestamp of the most recent precise GPS verification shared by the portal client (POST /api/portal/log-location with source = "browser"). Checked by src/lib/portal/require-gps.ts to gate portal data endpoints. Nullable when the client has not yet shared location, or when migration 015 has not been applied. Premium tier and exempt_location_share rows bypass the gate.';

-- Backfill is intentionally NOT performed: existing rows have never had a
-- browser GPS share recorded, so leaving them NULL is correct — those
-- clients will be prompted to share location on their next portal session.
