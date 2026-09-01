-- 081_document_template_bank_accounts.sql
-- ============================================================================
-- audit20 / 20-b — give document_templates the selected_bank_accounts column.
-- ============================================================================
-- audit20: selected_bank_accounts — which tenant bank accounts (indexes into the
-- tenant.bank_accounts JSON array) this template's PDFs should show. NULL = all.
-- The field existed on the TS type + template-editor UI but never had a column:
-- smartUpsert silently dropped it on every save. Wiring document_templates into
-- the PDF generator (audit20 20-a) makes this column load-bearing.
ALTER TABLE document_templates ADD COLUMN IF NOT EXISTS selected_bank_accounts jsonb;
ALTER TABLE document_templates ALTER COLUMN selected_bank_accounts SET DEFAULT NULL;
