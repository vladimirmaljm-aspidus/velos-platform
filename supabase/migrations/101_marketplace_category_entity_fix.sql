-- ═══════════════════════════════════════════════════════════════════════
-- 101 — marketplace category entity-encoding data fix
-- ═══════════════════════════════════════════════════════════════════════
-- Found during the 100 production E2E: POST/PUT /api/marketplace ran
-- product_category through sanitizeFields (HTML-escaping), so the
-- taxonomy value "Food & Beverage" was stored as "Food &amp; Beverage".
-- Every downstream consumer (feed category filter, saved-search alert
-- matching, intelligence aggregations) compares the RAW taxonomy name,
-- so the escaped rows were invisible to filters and never triggered
-- alerts.
--
-- The route-level fix (100 follow-up) validates product_category against
-- the active taxonomy instead of escaping it. This migration repairs the
-- rows the escaping corrupted. Only one taxonomy name contains `&`
-- ("Food & Beverage"), so a single guarded UPDATE covers every case.

UPDATE marketplace_posts
SET product_category = 'Food & Beverage'
WHERE product_category = 'Food &amp; Beverage';

-- Verify: no escaped categories remain.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM marketplace_posts WHERE product_category LIKE '%&amp;%'
  ) THEN
    RAISE EXCEPTION 'marketplace_posts still contains entity-encoded categories';
  END IF;
END $$;
