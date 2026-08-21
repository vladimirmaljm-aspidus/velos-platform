-- 039_security_incidents.sql
-- ============================================================================
-- Security incident response & GDPR Art. 33 breach notification framework
-- (audit P0-3 / Features 3 + 4 — incident runbook + breach notification).
--
-- Background
-- ----------
-- GDPR Article 33 requires notifying the supervisory authority of a
-- personal-data breach within 72 hours of becoming aware of it. Article 34
-- requires notifying affected data subjects without delay when the breach
-- is likely to result in a high risk to their rights and freedoms. The
-- platform previously had NO incident-response framework — no schema, no
-- runbook, no deadline tracking, no escalation path for missed deadlines.
--
-- This migration provisions the `security_incidents` table that backs the
-- runbook + API + cron layer:
--   • src/lib/compliance/incident-response.ts    — SecurityIncident shape,
--     per-type runbook, deadline arithmetic.
--   • src/lib/compliance/breach-notification.ts   — Art. 33(3)(a)–(d)
--     compliant email generator + dispatcher.
--   • src/app/api/admin/incidents/*              — super-admin CRUD +
--     notify endpoints.
--   • src/app/api/cron/breach-notification-check — hourly pg_cron that
--     escalates incidents whose 72-hour deadline is < 24h away and
--     not yet notified.
--
-- RLS
-- ---
-- RLS is ENABLED with NO policies — only the service_role key (server-side
-- only, never exposed to the browser) can read / write this table. Tenant
-- admins and portal users have no business reading or writing incident
-- records; incidents are inherently cross-tenant or platform-level and
-- are managed by super_admins exclusively (the API routes enforce this
-- via `requireSuperAdmin`).
-- ============================================================================

-- ─── 1. security_incidents table ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS security_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL for platform-wide incidents (e.g. key compromise); a tenant UUID
  -- for tenant-scoped incidents (e.g. partner portal breach).
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,

  type TEXT NOT NULL,
  -- CHECK: enforce the documented enum so a typo doesn't silently create
  -- an incident of type "databreach" that no runbook knows about.
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',

  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reported_at TIMESTAMPTZ,

  affected_tenants JSONB NOT NULL DEFAULT '[]'::jsonb,
  affected_users JSONB NOT NULL DEFAULT '[]'::jsonb,

  description TEXT NOT NULL,
  root_cause TEXT,
  mitigation_steps JSONB NOT NULL DEFAULT '[]'::jsonb,

  gdpr_notified BOOLEAN NOT NULL DEFAULT FALSE,
  gdpr_notification_deadline TIMESTAMPTZ NOT NULL,

  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Type / severity / status enums — kept as CHECKs (not Postgres enums)
  -- so adding a new type is a migration-free code change (just append to
  -- `IncidentType` in src/lib/compliance/incident-response.ts). The CHECK
  -- still catches typos at insert time.
  CONSTRAINT security_incidents_type_check CHECK (
    type IN ('data_breach', 'unauthorized_access', 'malware', 'system_compromise', 'phishing', 'other')
  ),
  CONSTRAINT security_incidents_severity_check CHECK (
    severity IN ('low', 'medium', 'high', 'critical')
  ),
  CONSTRAINT security_incidents_status_check CHECK (
    status IN ('open', 'investigating', 'contained', 'resolved', 'reported')
  )
);

COMMENT ON TABLE security_incidents IS
  'GDPR Art. 33 personal-data breach incident register. Each row is a single '
  || 'declared incident; the 72-hour supervisory-authority notification deadline '
  || 'is precomputed at insert time (gdpr_notification_deadline) so the cron '
  || 'escalation route can poll without re-deriving the deadline each run. '
  || 'RLS denies all tenant-level access — super_admin (via service_role) only.';

COMMENT ON COLUMN security_incidents.gdpr_notification_deadline IS
  'ISO timestamp = detected_at + 72 hours, per GDPR Art. 33(1). Set at insert; '
  || 'never updated (audit-trail integrity — if the detection time was wrong, '
  || 'redeclare the incident rather than mutating the deadline).';
COMMENT ON COLUMN security_incidents.gdpr_notified IS
  'TRUE once the supervisory authority has been notified (Art. 33). The cron '
  || 'escalates incidents whose deadline is < 24h away and this flag is still FALSE.';

-- ─── 2. Indexes ─────────────────────────────────────────────────────────────
-- The cron's escalation query: WHERE gdpr_notified = FALSE AND
-- gdpr_notification_deadline < (now() + 24h). This composite index covers
-- it without a seq scan as the incident table grows.
CREATE INDEX IF NOT EXISTS security_incidents_deadline_idx
  ON security_incidents (gdpr_notification_deadline)
  WHERE gdpr_notified = FALSE;

-- Status filter for the admin UI list endpoint (open incidents first).
CREATE INDEX IF NOT EXISTS security_incidents_status_detected_idx
  ON security_incidents (status, detected_at DESC);

-- Tenant filter for the admin UI (most incidents are platform-wide; the
-- index on (tenant_id) IS NULL is sparse and stays small).
CREATE INDEX IF NOT EXISTS security_incidents_tenant_idx
  ON security_incidents (tenant_id);

-- ─── 3. updated_at trigger ──────────────────────────────────────────────────
-- Auto-bump updated_at on every UPDATE so the API can rely on it as the
-- "last touched" timestamp without the calling route having to set it
-- manually (defence-in-depth — the API does set it explicitly, but the
-- trigger is the source of truth).
CREATE OR REPLACE FUNCTION security_incidents_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS security_incidents_touch_updated_at ON security_incidents;
CREATE TRIGGER security_incidents_touch_updated_at
  BEFORE UPDATE ON security_incidents
  FOR EACH ROW
  EXECUTE FUNCTION security_incidents_touch_updated_at();

-- ─── 4. RLS — service_role only ─────────────────────────────────────────────
-- No policies → only the service_role (server-side) can read / write.
-- Tenant admins and portal users have no business with incident records.
ALTER TABLE security_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_incidents FORCE ROW LEVEL SECURITY;
-- (No GRANTs beyond what PUBLIC has by default — the API route uses the
-- service_role key which bypasses RLS entirely.)

-- ─── 5. Schedule the hourly breach-notification-check cron ──────────────────
-- The cron route escalates incidents whose 72-hour deadline is < 24h away
-- and not yet notified (gdpr_notified = FALSE). Hourly is the right
-- granularity — sooner would not change the outcome (the deadline is in
-- hours, not minutes); later would risk missing the deadline by more than
-- an hour, eating into the operator's reaction time.
--
-- Pattern follows migrations 025 / 034 — the cron command reads
-- `app.cron_token` via `current_setting(..., true)` so the token does not
-- appear in `cron.job.command` (visible to anyone with SELECT on cron.job).
SELECT cron.unschedule('breach-notification-check')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'breach-notification-check');

SELECT cron.schedule(
  'breach-notification-check',
  '0 * * * * *',  -- every hour at minute 0
  $cmd$
    SELECT net.http_get(
      url := 'https://aspidus.onrender.com/api/cron/breach-notification-check',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || current_setting('app.cron_token', true)
      )
    )
  $cmd$
);

-- ─── 6. Verify ─────────────────────────────────────────────────────────────
SELECT jobname, schedule, active
  FROM cron.job
  WHERE jobname = 'breach-notification-check'
  ORDER BY jobname;
