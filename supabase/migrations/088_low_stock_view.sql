-- 088_low_stock_view.sql
-- ============================================================================
-- BUG 31-e / E2 (P1) — Inventory "Low Stock" view always 500.
--
-- Background
-- ----------
-- SupabaseStore.listLowStockProducts (src/lib/data/supabase-store.ts) built
-- its PostgREST query as:
--
--     .gt("reorder_level", 0)
--     .filter("stock", "lte", "reorder_level")
--
-- The PostgREST `.filter(column, operator, value)` third argument is a
-- LITERAL value, NOT a column reference — PostgREST has no syntax for
-- column-to-column comparison. The request therefore reached Postgres as
-- `stock <= 'reorder_level'`, and Postgres rejected the string as
-- 22P02 "invalid input syntax for type numeric: reorder_level". Every
-- `GET /api/inventory?low_stock=1` returned 500.
--
-- Why a VIEW (and not some other construct)
-- -----------------------------------------
-- PostgREST cannot express "column <= other column" in any filter form
-- (.filter/.or/embedded filters all take literal values). The comparison
-- must run INSIDE the database. Options:
--   • an RPC — possible, but then the store loses the whole PostgREST
--     chain it relies on for tenant filter + ordering + Range pagination
--     (paginateQuery), and would need a hand-rolled pagination path;
--   • a VIEW — transparent: the store keeps using .from(...) with the
--     exact same .eq("tenant_id", …) / .order(...) / .range(...) chain,
--     and the row-level predicate lives in SQL where it belongs.
-- The view is the minimal, surgical fix.
--
-- security_invoker = on — WHY it matters
-- -------------------------------------
-- By default (classic security-definer view semantics), a view executes
-- with the privileges of the view OWNER: if the owner is the table owner
-- (postgres), RLS on `products` is silently BYPASSED for anyone who can
-- SELECT the view — every tenant's low-stock rows would be readable by
-- anon/authenticated roles through the view, defeating the tenant-scoped
-- RLS policies installed by migration 001.
-- `WITH (security_invoker = on)` (PostgreSQL 15+, Supabase default) makes
-- the view execute with the CALLER's privileges and RLS context instead:
--   • the app (service_role key — bypasses RLS) sees all rows and applies
--     the tenant filter itself, exactly as it does on `products` today;
--   • anon/authenticated roles are still subject to `products` RLS.
--
-- The predicate `reorder_level > 0 AND stock <= reorder_level` encodes the
-- two filters the store used to apply (the `.gt("reorder_level", 0)` is
-- folded in so the view alone defines "low stock" — NULL stock or NULL
-- reorder_level rows are excluded by ordinary NULL-comparison semantics).
--
-- Idempotency: CREATE OR REPLACE VIEW is safe to re-run; the definition is
-- deterministic and touches no data.
-- ============================================================================

CREATE OR REPLACE VIEW public.v_low_stock_products
  WITH (security_invoker = on) AS
SELECT *
  FROM public.products
 WHERE reorder_level > 0
   AND stock <= reorder_level;

-- Match the grant style of 064 (lois): full access for the service role the
-- app uses; read-only for the API roles (still gated by `products` RLS via
-- security_invoker, and by the app's explicit tenant filter).
GRANT SELECT ON public.v_low_stock_products TO service_role;
GRANT SELECT ON public.v_low_stock_products TO anon, authenticated;

COMMENT ON VIEW public.v_low_stock_products IS
  'Products at or below their reorder level (reorder_level > 0 AND stock <= reorder_level). Column-to-column comparison is impossible in PostgREST filters, so the inventory Low Stock list queries this view instead. security_invoker=on keeps products RLS enforced for non-service roles. Backing store method: SupabaseStore.listLowStockProducts.';

-- ============================================================================
-- Verification (run in Supabase Studio after applying):
--
--   SELECT * FROM public.v_low_stock_products LIMIT 5;
--   -- Must not error. Expect only rows where reorder_level > 0
--   -- and stock <= reorder_level.
--
--   SELECT count(*) FROM public.v_low_stock_products v
--   JOIN public.products p ON p.id = v.id
--   WHERE NOT (p.reorder_level > 0 AND p.stock <= p.reorder_level);
--   -- Expect 0 (view predicate is exact).
--
--   SELECT reloptions FROM pg_class WHERE relname = 'v_low_stock_products';
--   -- Expect {security_invoker=true}
-- ============================================================================
