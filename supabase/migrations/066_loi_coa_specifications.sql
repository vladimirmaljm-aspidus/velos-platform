-- 066_loi_coa_specifications.sql
-- ============================================================================
-- VELOS — add coa_params + specifications columns to lois table.
--
-- LOI needs to carry the product's Certificate of Analysis (COA) parameters
-- and product specifications so the PDF can render a full technical
-- specification section. Both are JSONB columns populated from the product
-- at LOI creation time (or manually entered).
-- ============================================================================

ALTER TABLE public.lois
  ADD COLUMN IF NOT EXISTS coa_params jsonb;

ALTER TABLE public.lois
  ADD COLUMN IF NOT EXISTS specifications jsonb;
