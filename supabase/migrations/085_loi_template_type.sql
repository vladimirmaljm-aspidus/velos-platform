-- 085_loi_template_type.sql
-- ============================================================================
-- audit23 — dedicated "loi" document template type + starter seeding.
--
-- document_templates.type is a plain TEXT column (no CHECK constraint), so
-- "loi" needs no DDL. What existing tenants DO need is a starter LOI row:
-- they already have offer/invoice/proforma starters (seeded when the
-- Document Templates page first opened), but no tenant could ever have
-- created a "loi" template before the type existed — nothing to delete,
-- nothing to resurrect. This one-time INSERT back-fills the amber LOI
-- starter for every tenant that has at least one template but no LOI row.
--
-- Resolver order for LOI PDFs becomes: loi → generic → offer
-- (src/lib/pdf/doc-template.ts TEMPLATE_TYPE_CANDIDATES).
-- ============================================================================

INSERT INTO document_templates (
  tenant_id, name, type, is_default,
  page_size, page_margin_top, page_margin_bottom, page_margin_left, page_margin_right,
  header_enabled, header_height, header_content,
  header_show_logo, header_show_company_name, header_show_contact,
  footer_enabled, footer_height, footer_content,
  footer_show_page_number, footer_show_bank_details, footer_show_tax_id,
  body_font_family, body_font_size, body_line_height,
  primary_color, accent_color,
  table_header_bg, table_header_color, table_border_color, table_stripe,
  letterhead_id, seal_id, seal_enabled, selected_bank_accounts,
  style_json, layout_json, created_by
)
SELECT
  t.id,
  'Letter of Intent',
  'loi',
  true,
  'A4', 20, 20, 15, 15,
  true, 30, NULL,
  true, true, true,
  true, 20,
  'This Letter of Intent expresses a serious intention to proceed and does not constitute a binding purchase contract unless explicitly agreed in writing by both parties.',
  true, false, true,
  'Helvetica', 9, 1.4,
  '#b45309', '#64748b',
  '#b45309', '#ffffff', '#e2e8f0', true,
  NULL, NULL, true, NULL,
  NULL, NULL, NULL
FROM tenants t
WHERE EXISTS (SELECT 1 FROM document_templates dt WHERE dt.tenant_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM document_templates dl WHERE dl.tenant_id = t.id AND dl.type = 'loi');

-- One default per (tenant, type): any tenant that had a different type
-- flagged as default is untouched (defaults are per-type, no conflict).
-- Reset is handled for future saves by the app store (audit20/20-b).

COMMENT ON COLUMN document_templates.type IS 'Template family: offer | invoice | proforma | contract | loi | generic (loi added in 085 — resolver: loi -> generic -> offer)';
