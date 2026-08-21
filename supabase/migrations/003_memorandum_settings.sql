-- 003_memorandum_settings.sql
-- ============================================================================
-- Per-tenant memorandum (PDF header + footer) settings.
--
-- This replaces the complex `document_templates` module with a simpler
-- per-tenant configuration: each tenant configures their memorandum
-- (header + footer + body defaults) once, and the PDF generator reads it.
--
-- ONE row per tenant (UNIQUE(tenant_id)). The GET /api/memorandum-settings
-- endpoint auto-creates a row with all defaults on first fetch, so tenants
-- never have to "save" before they can preview.
--
-- RLS
--   The app uses the service_role key (src/lib/supabase/client.ts) which
--   BYPASSES RLS — primary isolation is enforced in src/app/api/**/route.ts.
--   The policy below is defense-in-depth: blocks anon-key access (anon client
--   does not set app.tenant_id) and protects against direct DB / Studio access.
-- ============================================================================

CREATE TABLE IF NOT EXISTS memorandum_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- HEADER settings
  header_enabled BOOLEAN DEFAULT true,
  header_height_mm INT DEFAULT 30,
  header_bg_color TEXT DEFAULT '#ffffff',

  -- Header: LEFT column (company name)
  header_left_font_family TEXT DEFAULT 'Helvetica',
  header_left_font_size INT DEFAULT 14,
  header_left_font_color TEXT DEFAULT '#000000',
  header_left_font_bold BOOLEAN DEFAULT true,

  -- Header: RIGHT column (logo)
  logo_enabled BOOLEAN DEFAULT true,
  logo_max_width_mm INT DEFAULT 50,
  logo_max_height_mm INT DEFAULT 20,
  logo_position_x_mm INT DEFAULT 0,  -- horizontal offset within right column
  logo_position_y_mm INT DEFAULT 0,  -- vertical offset
  logo_fit_mode TEXT DEFAULT 'contain',  -- contain | cover | fill (image fit)

  -- FOOTER settings
  footer_enabled BOOLEAN DEFAULT true,
  footer_height_mm INT DEFAULT 25,
  footer_bg_color TEXT DEFAULT '#ffffff',

  -- Footer: LEFT column (QR code)
  qr_enabled BOOLEAN DEFAULT true,
  qr_size_mm INT DEFAULT 15,
  qr_position_x_mm INT DEFAULT 0,
  qr_position_y_mm INT DEFAULT 0,

  -- Footer: CENTER column (address/website/email)
  footer_center_font_family TEXT DEFAULT 'Helvetica',
  footer_center_font_size INT DEFAULT 8,
  footer_center_font_color TEXT DEFAULT '#666666',
  footer_center_alignment TEXT DEFAULT 'center',

  -- Footer: RIGHT column (page number)
  footer_right_font_family TEXT DEFAULT 'Helvetica',
  footer_right_font_size INT DEFAULT 8,
  footer_right_font_color TEXT DEFAULT '#666666',

  -- Column widths (percentages, must sum to 100)
  footer_left_width_pct INT DEFAULT 25,
  footer_center_width_pct INT DEFAULT 50,
  footer_right_width_pct INT DEFAULT 25,

  -- Body settings (for document content area)
  body_font_family TEXT DEFAULT 'Helvetica',
  body_font_size INT DEFAULT 9,
  body_line_height REAL DEFAULT 1.4,
  body_text_color TEXT DEFAULT '#1a1a1a',
  primary_color TEXT DEFAULT '#0d9488',

  UNIQUE(tenant_id)
);

-- ----------------------------------------------------------------------------
-- RLS (defense-in-depth — see note at top of file)
-- ----------------------------------------------------------------------------
ALTER TABLE memorandum_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memorandum_settings_tenant_isolated ON memorandum_settings;
CREATE POLICY memorandum_settings_tenant_isolated ON memorandum_settings
  FOR ALL USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- ----------------------------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS memorandum_settings_tenant_id_idx
  ON memorandum_settings(tenant_id);
