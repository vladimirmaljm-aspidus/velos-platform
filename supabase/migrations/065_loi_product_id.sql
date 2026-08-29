-- 065_loi_product_id.sql
-- ============================================================================
-- VELOS — add product_id column to lois table.
--
-- When the LOI is created for a product that exists in the tenant's catalog,
-- we store the product_id so the LOI can be linked back to the catalog entry.
-- The product_name/description/hs_code/origin_country/unit/unit_price are
-- auto-populated from the product at creation time (defence in depth — the
-- LOI is self-contained even if the product is later edited/deleted).
-- ============================================================================

ALTER TABLE public.lois
  ADD COLUMN IF NOT EXISTS product_id text;

CREATE INDEX IF NOT EXISTS lois_product_id_idx
  ON public.lois (product_id) WHERE product_id IS NOT NULL;
