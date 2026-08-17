-- 020_normalize_legacy_offer_items.sql
-- ============================================================================
-- CRITICAL FIX (audit F-13): normalize legacy offer line items.
--
-- 5 of 10 live offers have line items in the legacy inventory format:
--   {productId, price, invIndex, offerIndex, isInventory, quantity, unit}
-- instead of the modern format:
--   {product_id, product_name, sku, unit_price, discount, tax_rate, total, ...}
--
-- This migration:
-- 1. For each offer with legacy items, converts camelCase → snake_case
-- 2. Maps productId → product_id, price → unit_price
-- 3. Drops invIndex, offerIndex, isInventory
-- 4. Normalizes unit from "MT - Metric Ton" → "MT"
-- 5. Adds defaults: discount=0, tax_rate=0, total=quantity*unit_price
-- ============================================================================

-- Normalize unit labels to canonical codes
UPDATE offers SET items = (
  SELECT jsonb_agg(
    CASE
      WHEN elem ? 'productId' THEN
        -- Legacy format: convert to modern
        jsonb_build_object(
          'product_id', elem->>'productId',
          'product_name', '',
          'sku', '',
          'quantity', (elem->>'quantity')::numeric,
          'unit', CASE
            WHEN elem->>'unit' LIKE 'MT%' THEN 'MT'
            WHEN elem->>'unit' LIKE 'kg%' THEN 'kg'
            WHEN elem->>'unit' LIKE 'pcs%' THEN 'pcs'
            WHEN elem->>'unit' LIKE 'piece%' THEN 'pcs'
            WHEN elem->>'unit' LIKE 'ton%' THEN 'ton'
            ELSE elem->>'unit'
          END,
          'unit_price', (elem->>'price')::numeric,
          'discount', 0,
          'tax_rate', 0,
          'total', ROUND(((elem->>'quantity')::numeric * (elem->>'price')::numeric)::numeric, 2)
        )
      ELSE
        -- Modern format: just normalize unit if needed
        jsonb_set(
          elem,
          '{unit}',
          to_jsonb(CASE
            WHEN elem->>'unit' LIKE 'MT -%' THEN 'MT'
            WHEN elem->>'unit' LIKE 'kg -%' THEN 'kg'
            WHEN elem->>'unit' LIKE 'pcs -%' THEN 'pcs'
            WHEN elem->>'unit' LIKE 'piece%' THEN 'pcs'
            WHEN elem->>'unit' LIKE 'ton -%' THEN 'ton'
            WHEN lower(elem->>'unit') = 'mt' THEN 'MT'
            ELSE elem->>'unit'
          END)
        )
    END
  )
  FROM jsonb_array_elements(items) AS elem
)
WHERE items IS NOT NULL
  AND jsonb_typeof(items) = 'array'
  AND jsonb_array_length(items) > 0
  AND items::text LIKE '%productId%';

-- Also normalize units on all other offers (modern format with "MT - Metric Ton")
UPDATE offers SET items = (
  SELECT jsonb_agg(
    jsonb_set(
      elem,
      '{unit}',
      to_jsonb(CASE
        WHEN elem->>'unit' LIKE 'MT -%' THEN 'MT'
        WHEN elem->>'unit' LIKE 'kg -%' THEN 'kg'
        WHEN elem->>'unit' LIKE 'pcs -%' THEN 'pcs'
        WHEN elem->>'unit' LIKE 'piece%' THEN 'pcs'
        WHEN elem->>'unit' LIKE 'ton -%' THEN 'ton'
        WHEN lower(elem->>'unit') = 'mt' THEN 'MT'
        ELSE elem->>'unit'
      END)
    )
  )
  FROM jsonb_array_elements(items) AS elem
)
WHERE items IS NOT NULL
  AND jsonb_typeof(items) = 'array'
  AND jsonb_array_length(items) > 0
  AND items::text LIKE '%MT -%';

-- Normalize units on products table
UPDATE products SET unit = 'MT' WHERE unit ILIKE 'mt' OR unit LIKE 'MT -%';
UPDATE products SET unit = 'kg' WHERE unit ILIKE 'kg -%';
UPDATE products SET unit = 'pcs' WHERE unit ILIKE 'piece' OR unit ILIKE 'pcs -%';
UPDATE products SET unit = 'ton' WHERE unit ILIKE 'ton -%';

-- Verify
SELECT 'offers with legacy items remaining' as check_name,
       count(*) as count
FROM offers
WHERE items::text LIKE '%productId%';

SELECT 'product unit distribution' as check_name,
       unit, count(*) as count
FROM products
GROUP BY unit
ORDER BY count DESC;
