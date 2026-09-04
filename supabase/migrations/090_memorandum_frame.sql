-- 090_memorandum_frame.sql
-- ============================================================================
-- MEMORANDUM ENGINE v2 (audit33) — the memorandum becomes the single source
-- of truth for the document FRAME (page setup + header + footer), locked
-- from per-template editing.
--
-- Canonical layout (the "LOI look", now applied to EVERY document):
--   HEADER:  company name (LEFT)  + logo (RIGHT)
--   FOOTER:  company address (LEFT) + QR code (CENTER) + page number (RIGHT)
--
-- New columns (all additive, all defaulted, all idempotent):
--   • Page setup:      page_size, margin_top/bottom/left/right_mm
--                      (the template's page_* fields are now legacy — the
--                       memo owns the page frame for consistency)
--   • Header:          header_border_enabled/color/width,
--                      header_show_subtitle (city/country under the name),
--                      logo_side (right default)
--   • Footer left:     footer_left_enabled + footer_left_font_* +
--                      footer_address_source (tenant|custom) +
--                      footer_address_custom + footer_show_contact
--                      (the tenant address block — LOI-canonical left zone)
--   • Footer QR:       qr_position (left|center|right|none — CENTER default),
--                      qr_opacity
--   • Footer border:   footer_border_enabled/color
--   • Page number:     page_number_enabled
--
-- Revived dead columns (wired for the first time):
--   footer_left/center/right_width_pct → real footer zone widths
--   footer_center_font_*                → styling of the small note lines
--                                          rendered under the QR (template
--                                          footer segments / bank lines)
--   logo_fit_mode                       → objectFit in the header
--
-- The GET /api/memorandum-settings auto-create keeps working: new tenants
-- get every default for free.
-- ============================================================================

ALTER TABLE memorandum_settings
  ADD COLUMN IF NOT EXISTS page_size TEXT DEFAULT 'A4',
  ADD COLUMN IF NOT EXISTS margin_top_mm INT DEFAULT 20,
  ADD COLUMN IF NOT EXISTS margin_bottom_mm INT DEFAULT 20,
  ADD COLUMN IF NOT EXISTS margin_left_mm INT DEFAULT 15,
  ADD COLUMN IF NOT EXISTS margin_right_mm INT DEFAULT 15,

  -- Header (canonical: company name LEFT + logo RIGHT)
  ADD COLUMN IF NOT EXISTS header_border_enabled BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS header_border_color TEXT,
  ADD COLUMN IF NOT EXISTS header_border_width REAL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS header_show_subtitle BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS logo_side TEXT DEFAULT 'right',

  -- Footer LEFT zone — company address block
  ADD COLUMN IF NOT EXISTS footer_left_enabled BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS footer_left_font_family TEXT DEFAULT 'Helvetica',
  ADD COLUMN IF NOT EXISTS footer_left_font_size INT DEFAULT 8,
  ADD COLUMN IF NOT EXISTS footer_left_font_color TEXT DEFAULT '#666666',
  ADD COLUMN IF NOT EXISTS footer_address_source TEXT DEFAULT 'tenant',
  ADD COLUMN IF NOT EXISTS footer_address_custom TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS footer_show_contact BOOLEAN DEFAULT false,

  -- Footer QR zone (canonical: CENTER)
  ADD COLUMN IF NOT EXISTS qr_position TEXT DEFAULT 'center',
  ADD COLUMN IF NOT EXISTS qr_opacity REAL DEFAULT 1,

  -- Footer band border
  ADD COLUMN IF NOT EXISTS footer_border_enabled BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS footer_border_color TEXT DEFAULT '#cccccc',

  -- Footer RIGHT zone — page number
  ADD COLUMN IF NOT EXISTS page_number_enabled BOOLEAN DEFAULT true;

-- ----------------------------------------------------------------------------
-- Backfill: existing rows get the new defaults (ADD COLUMN … DEFAULT already
-- fills them for NULL-free columns, but be explicit for TEXT defaults that
-- must not stay NULL in older-PG semantics).
-- ----------------------------------------------------------------------------
UPDATE memorandum_settings
SET qr_position = COALESCE(qr_position, 'center'),
    logo_side = COALESCE(logo_side, 'right'),
    footer_address_source = COALESCE(footer_address_source, 'tenant'),
    footer_address_custom = COALESCE(footer_address_custom, ''),
    footer_border_color = COALESCE(footer_border_color, '#cccccc'),
    page_size = COALESCE(page_size, 'A4')
WHERE qr_position IS NULL
   OR logo_side IS NULL
   OR footer_address_source IS NULL
   OR footer_address_custom IS NULL
   OR footer_border_color IS NULL
   OR page_size IS NULL;

-- ----------------------------------------------------------------------------
-- CHECK-style constraints (defense-in-depth against junk writes)
-- ----------------------------------------------------------------------------
ALTER TABLE memorandum_settings
  DROP CONSTRAINT IF EXISTS memo_qr_position_chk;
ALTER TABLE memorandum_settings
  ADD CONSTRAINT memo_qr_position_chk
  CHECK (qr_position IN ('left','center','right','none'));

ALTER TABLE memorandum_settings
  DROP CONSTRAINT IF EXISTS memo_logo_side_chk;
ALTER TABLE memorandum_settings
  ADD CONSTRAINT memo_logo_side_chk
  CHECK (logo_side IN ('left','right'));

ALTER TABLE memorandum_settings
  DROP CONSTRAINT IF EXISTS memo_page_size_chk;
ALTER TABLE memorandum_settings
  ADD CONSTRAINT memo_page_size_chk
  CHECK (page_size IN ('A4','Letter'));

ALTER TABLE memorandum_settings
  DROP CONSTRAINT IF EXISTS memo_footer_addr_source_chk;
ALTER TABLE memorandum_settings
  ADD CONSTRAINT memo_footer_addr_source_chk
  CHECK (footer_address_source IN ('tenant','custom'));

-- ----------------------------------------------------------------------------
-- Verification (run in Studio after applying)
--   SELECT qr_position, logo_side, page_size, footer_left_enabled
--   FROM memorandum_settings LIMIT 5;
-- ----------------------------------------------------------------------------
