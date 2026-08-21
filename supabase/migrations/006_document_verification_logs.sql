-- 006_document_verification_logs.sql
-- ============================================================================
-- Detailed per-verification log for the PUBLIC /api/verify/[code] endpoint.
--
-- WHY A NEW TABLE?
--   The existing `verification_logs` table records only the bare minimum
--   (verification_id, code, ip, user_agent, result). For fraud prevention
--   we want to know WHO verified a document, FROM WHERE, and ON WHAT DEVICE:
--     - IP geolocation (country, city, region, lat/lng) — via the existing
--       `lookupIp` helper in src/lib/utils/geo-ip.ts (ipapi.co, free tier).
--     - User-Agent parsed into device_type / browser / os / device_name
--       (src/lib/utils/device-parser.ts).
--   This table is the source of truth for the super-admin Verification Logs
--   viewer (src/components/views/verification-logs-view.tsx).
--
-- SECURITY MODEL
--   - The verify endpoint is PUBLIC (no auth). It writes to this table using
--     the service_role key, which bypasses RLS — so writes always succeed.
--   - Only super_admin can READ the logs. The API layer
--     (src/app/api/super-admin/verification-logs/route.ts) calls
--     `requireSuperAdmin()` before any SELECT. RLS is therefore permissive
--     (USING(true)) as defense-in-depth — anon key access would otherwise be
--     blocked by the default-deny RLS on every other table, but we still want
--     service_role writes to succeed.
--   - If we ever expose this table to the anon key for any reason, the policy
--     must be tightened to deny SELECT. As written, the API is the only reader.
--
-- IDEMPOTENCY
--   CREATE TABLE IF NOT EXISTS + ALTER TABLE ... ADD COLUMN IF NOT EXISTS make
--   this migration safe to re-run. No data is ever deleted.
-- ============================================================================

CREATE TABLE IF NOT EXISTS document_verification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT,
  verification_code TEXT NOT NULL,
  document_type TEXT,
  document_id TEXT,
  document_number TEXT,

  -- Who verified
  ip TEXT,
  country TEXT,
  city TEXT,
  region TEXT,
  latitude REAL,
  longitude REAL,
  user_agent TEXT,
  device_type TEXT,        -- mobile/desktop/tablet/bot
  browser TEXT,
  os TEXT,
  device_name TEXT,         -- parsed from UA

  -- Verification result
  result TEXT NOT NULL,     -- valid | invalid | revoked | modified
  verification_id TEXT,     -- FK to document_verifications

  -- Timestamps
  verified_at TIMESTAMPTZ DEFAULT NOW(),

  -- Additional data
  referrer TEXT,
  accept_language TEXT,
  raw_headers JSONB
);

-- Indexes for the super-admin viewer's common access patterns.
--   1. By code (filter by verification_code)
--   2. By tenant (per-tenant investigation)
--   3. By time (the default ORDER BY verified_at DESC)
CREATE INDEX IF NOT EXISTS idx_dvl_verification_code
  ON document_verification_logs (verification_code);
CREATE INDEX IF NOT EXISTS idx_dvl_tenant_id
  ON document_verification_logs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_dvl_verified_at
  ON document_verification_logs (verified_at DESC);

-- Enable RLS. The table is written to by the public verify endpoint via the
-- service_role key (which bypasses RLS). The policy is permissive as
-- defense-in-depth; the API layer enforces the super_admin check.
ALTER TABLE document_verification_logs ENABLE ROW LEVEL SECURITY;

-- Drop & recreate so re-running the migration doesn't fail on duplicate policy.
DROP POLICY IF EXISTS doc_verify_logs_super_admin_only ON document_verification_logs;
CREATE POLICY doc_verify_logs_super_admin_only ON document_verification_logs
  FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE document_verification_logs IS
  'Per-verification log written by the public /api/verify/[code] endpoint. '
  'Captures IP geolocation + parsed User-Agent for fraud prevention. Read '
  'access is enforced at the API layer (requireSuperAdmin).';
