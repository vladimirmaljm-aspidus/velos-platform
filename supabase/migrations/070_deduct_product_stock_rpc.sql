-- 070_deduct_product_stock_rpc.sql
-- ============================================================================
-- CRITICAL FIX — audit 2d2-F1 + 2d2-F5 (round 2)
--
-- PROBLEM
--   `src/lib/api/inventory-cascade.ts::deductStockForOffer` performs a
--   read-modify-write on `products.stock` across FOUR separate PostgREST
--   calls with no row lock:
--     1. SELECT products.stock            (line 82)
--     2. SELECT inventory_movements       (line 110 — idempotency check)
--     3. INSERT inventory_movements        (line 145)
--     4. UPDATE products.stock            (line 159)
--   Two concurrent offer-acceptances on the SAME product (different
--   offers, since the idempotency check is keyed per-offer) both read
--   stock=10, both compute newStock=5, both UPDATE to 5 → 5 units
--   silently oversold (2d2-F1). Two concurrent acceptances on the SAME
--   offer+product both read priorMovements=[] (idempotency TOCTOU) and
--   both INSERT a -5 movement → stock decremented twice (2d2-F5).
--
-- FIX
--   Single SECURITY DEFINER plpgsql function `deduct_product_stock` that
--   performs all four steps INSIDE ONE Postgres transaction:
--     * SELECT ... FOR UPDATE on the products row  (serializes concurrent
--       callers on the same product — closes BOTH F1 cross-offer races
--       AND F5 same-offer TOCTOU)
--     * Idempotency check inside the same tx (sees committed writes of
--       any concurrent caller that finished first — closes F5)
--     * INSERT inventory_movements
--     * UPDATE products.stock = GREATEST(0, stock - qty)
--   Postgres auto-rollbacks on any error.
--
-- SECURITY
--   SECURITY DEFINER + SET search_path = public, pg_temp (Supabase
--   advisory 2023-09, matches migration 069 pattern). GRANT EXECUTE to
--   service_role ONLY — REVOKE from PUBLIC/anon/authenticated. The
--   caller is the application's service_role client; no anon access.
--
-- IDEMPOTENCY
--   CREATE OR REPLACE FUNCTION. Re-running the migration is a no-op.
--   The function is per-product; the JS caller (inventory-cascade.ts)
--   still loops over the offer's line items — but each iteration is now
--   a single atomic RPC call, and concurrent calls on the same product
--   serialize via the products row lock.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.deduct_product_stock(
  p_product_id   text,
  p_quantity     numeric,
  p_tenant_id    text,
  p_offer_id     text,
  p_partner_id   text DEFAULT NULL,
  p_offer_number text DEFAULT NULL,
  p_source_label text DEFAULT 'admin',
  p_reason_suffix text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_product        RECORD;
  v_qty            numeric;
  v_actual         numeric;
  v_new_stock      numeric;
  v_deductions     int;
  v_restorations   int;
  v_reason         text;
  v_result         jsonb;
BEGIN
  IF p_product_id IS NULL OR p_quantity IS NULL OR p_tenant_id IS NULL OR p_offer_id IS NULL THEN
    RAISE EXCEPTION 'deduct_product_stock: p_product_id, p_quantity, p_tenant_id, p_offer_id are all required';
  END IF;

  v_qty := ABS(p_quantity);
  IF v_qty <= 0 THEN
    RETURN jsonb_build_object('deducted', false, 'reason', 'non_positive_quantity');
  END IF;

  -- 1) SELECT ... FOR UPDATE on the products row. This SERIALISES
  --    concurrent callers operating on the same product (both 2d2-F1
  --    cross-offer races and 2d2-F5 same-offer TOCTOU). The lock is
  --    held until the end of the transaction (COMMIT/ROLLBACK), so the
  --    idempotency SELECT + movement INSERT + product UPDATE below all
  --    see a consistent snapshot relative to any other concurrent caller.
  SELECT id, name, sku, stock, reorder_level, unit
    INTO v_product
    FROM products
    WHERE id = p_product_id
      AND tenant_id = p_tenant_id
    FOR UPDATE;

  IF NOT FOUND THEN
    -- Product not in caller's tenant (or doesn't exist). Return
    -- not_found so the JS caller can skip this line item.
    RETURN jsonb_build_object(
      'deducted', false,
      'reason', 'product_not_found',
      'product_id', p_product_id
    );
  END IF;

  -- 2) Idempotency check inside the same transaction. Because we hold
  --    the products row lock, any concurrent caller that finished BEFORE
  --    us will have its committed movement row visible to this SELECT.
  --    If the net is already a deduction (deductions > restorations),
  --    we bail — closes 2d2-F5 (same-offer TOCTOU).
  SELECT
    COUNT(*) FILTER (WHERE delta < 0),
    COUNT(*) FILTER (WHERE delta > 0)
    INTO v_deductions, v_restorations
  FROM inventory_movements
  WHERE tenant_id = p_tenant_id
    AND reference = p_offer_id
    AND product_id = p_product_id;

  IF v_deductions > v_restorations THEN
    RETURN jsonb_build_object(
      'deducted', false,
      'reason', 'already_deducted',
      'product_id', p_product_id,
      'new_stock', COALESCE(v_product.stock, 0),
      'deductions', v_deductions,
      'restorations', v_restorations
    );
  END IF;

  -- 3) Compute the ACTUAL deducted amount (audit P2-13: clamps to
  --    current stock so the movement row records reality, not the
  --    requested qty — restoreStockForOffer reads this delta).
  v_actual := LEAST(v_qty, COALESCE(v_product.stock, 0));
  v_new_stock := GREATEST(0, COALESCE(v_product.stock, 0) - v_qty);

  -- 4) Build the reason string (mirrors the JS implementation).
  v_reason := 'Offer ' || COALESCE(p_offer_number, p_offer_id) || ' accepted by ' || p_source_label;
  IF p_reason_suffix IS NOT NULL AND p_reason_suffix <> '' THEN
    v_reason := v_reason || ' — ' || p_reason_suffix;
  END IF;

  -- 5) INSERT the inventory_movements audit row (delta negative = out).
  INSERT INTO inventory_movements (
    tenant_id, product_id, partner_id, delta, reason, reference
  ) VALUES (
    p_tenant_id, p_product_id, p_partner_id, -v_actual, v_reason, p_offer_id
  );

  -- 6) UPDATE the products row. The FOR UPDATE lock above guarantees
  --    no concurrent caller overwrites our write between the SELECT
  --    and this UPDATE.
  UPDATE products
    SET stock = v_new_stock, updated_at = now()
    WHERE id = p_product_id AND tenant_id = p_tenant_id;

  v_result := jsonb_build_object(
    'deducted', true,
    'product_id', p_product_id,
    'new_stock', v_new_stock,
    'actual_deducted', v_actual,
    'product_name', COALESCE(v_product.name, '(unnamed)'),
    'sku', COALESCE(v_product.sku, ''),
    'reorder_level', COALESCE(v_product.reorder_level, 0)
  );
  RETURN v_result;
END;
$$;

-- SECURITY: GRANT to service_role only. The application uses
-- getSupabase() (service_role client) for all inventory cascade writes.
-- Anon/authenticated MUST NOT be able to call this function directly —
-- it writes to products + inventory_movements bypassing the route's
-- auth/permission gates.
REVOKE EXECUTE ON FUNCTION public.deduct_product_stock(text, numeric, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.deduct_product_stock(text, numeric, text, text, text, text, text, text) TO service_role;

COMMENT ON FUNCTION public.deduct_product_stock(text, numeric, text, text, text, text, text, text) IS
  'Atomic per-product stock deduction. SELECT FOR UPDATE on products row serializes concurrent offer-acceptance calls. Idempotency check inside the same tx prevents same-offer TOCTOU (audit 2d2-F1 + 2d2-F5). Returns {deducted, new_stock, actual_deducted, product_name, sku, reorder_level} or {deducted:false, reason}.';

-- ── Verification ───────────────────────────────────────────────────────────
-- SELECT p.proname, p.prosecdef, p.proconfig
-- FROM pg_proc p
-- JOIN pg_namespace n ON p.pronamespace = n.oid
-- WHERE n.nspname = 'public' AND p.proname = 'deduct_product_stock';
-- Expected: prosecdef = true; proconfig = {search_path=public,pg_temp}
--
-- SELECT has_function_privilege('anon','deduct_product_stock(text,numeric,text,text,text,text,text,text)','EXECUTE') AS anon_can,
--        has_function_privilege('authenticated','deduct_product_stock(text,numeric,text,text,text,text,text,text)','EXECUTE') AS auth_can,
--        has_function_privilege('service_role','deduct_product_stock(text,numeric,text,text,text,text,text,text)','EXECUTE') AS svc_can;
-- Expected: anon_can=false, auth_can=false, svc_can=true
