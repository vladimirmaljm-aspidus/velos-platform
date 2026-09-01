-- 082_document_template_style_layout.sql
-- ============================================================================
-- audit22 "Template Studio" — Word-grade template editing.
--
-- Two new jsonb columns on document_templates:
--   style_json  — extended document styling that does not fit the existing
--                 scalar columns: body typography, line-items table styling
--                 (column widths, cell padding, header treatment), party
--                 boxes, totals block, notice box, document title treatment.
--                 Parsed/normalized by src/lib/utils/style-config.ts and read
--                 by the PDF renderer (src/lib/pdf/templates.tsx).
--   layout_json — persisted visual layout from the drag-and-drop editor:
--                 field positions (x/y/width/height in mm), visibility,
--                 locks and per-field props. Stored as { fields: [...] }.
--                 The PDF renderer honors visibility + custom text/image
--                 absolute positions from this layout.
--
-- NULL (the default) = "use the built-in defaults" — every existing template
-- keeps its exact current output until the user edits the new controls.
-- ============================================================================
ALTER TABLE document_templates ADD COLUMN IF NOT EXISTS style_json jsonb;
ALTER TABLE document_templates ALTER COLUMN style_json SET DEFAULT NULL;

ALTER TABLE document_templates ADD COLUMN IF NOT EXISTS layout_json jsonb;
ALTER TABLE document_templates ALTER COLUMN layout_json SET DEFAULT NULL;

COMMENT ON COLUMN document_templates.style_json IS 'audit22 Template Studio: body/table/party/totals/notice/title styling (see src/lib/utils/style-config.ts)';
COMMENT ON COLUMN document_templates.layout_json IS 'audit22 Template Studio: visual editor field layout { fields: [{id,type,x,y,width,height,visible,locked,props}] } in mm';
