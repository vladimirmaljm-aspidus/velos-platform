-- Migration 076: Marketplace tables — replace USING(true) RLS policies
-- with service_role-only policies (audit 8d-5 / 2c-F15 INCOMPLETE).
--
-- Background
-- ----------
-- Migration 060 (Task 7 batch 1) replaced `USING(true) WITH CHECK(true)`
-- policies with `auth.role() = 'service_role'` policies on 14 community/ESG
-- marketplace tables (groups, questions, answers, …). But 17 PARTNER-scoped
-- marketplace tables in migrations 044-054 were SILENTLY LEFT with the
-- permissive `USING(true) WITH CHECK(true)` policy. A leak of the anon key
-- (env var leak, Supabase Studio compromise, employee laptop, future code
-- path using the anon client) would let an attacker `GET /rest/v1/
-- marketplace_posts?select=*` and read EVERY marketplace post in EVERY
-- tenant (cross-tenant leak) — including `partner_id`, `tenant_id`,
-- `auction_winner_id`, `agreed_terms` (with prices), `payment_milestones`
-- (JSON with bank details of contracted parties). Same for messages (the
-- negotiation contents cross-tenant), negotiations (deal terms), bids
-- (bid_amount + bidder partner_id).
--
-- This migration applies the same `auth.role() = 'service_role'` policy to
-- the remaining 17 marketplace tables. The app uses `service_role` for all
-- marketplace queries (RLS bypass), so this is transparent — anon /
-- authenticated clients get a 42501 (insufficient_privilege) when they try
-- to read these tables directly via PostgREST, which is the intended
-- defence-in-depth posture.
--
-- Standing rules respected:
--   • NO data is deleted — only policy DDL.
--   • ADDITIVE / idempotent — `DROP POLICY IF EXISTS` + `CREATE POLICY`
--     are both safe to re-run.
--   • `ALTER TABLE … FORCE ROW LEVEL SECURITY` is re-applied so even the
--     table owner is subject to the policies (defence-in-depth against a
--     future role escalation that grants table ownership).
--
-- Tables in scope (17):
--   From 044_marketplace.sql:
--     marketplace_posts, marketplace_responses,
--     marketplace_negotiations, marketplace_messages
--   From 045_marketplace_profiles.sql:
--     marketplace_company_profiles, marketplace_reviews, marketplace_follows
--   From 046_marketplace_auctions_contracts.sql:
--     marketplace_auction_bids, marketplace_contracts,
--     marketplace_contract_deliveries
--   From 047_marketplace_logistics.sql:
--     marketplace_shipments, marketplace_shipment_events
--   From 049_marketplace_finance.sql:
--     marketplace_financial_instruments, marketplace_payment_milestones
--   From 050_marketplace_documents.sql:
--     marketplace_trade_documents
--   From 054_marketplace_admin.sql:
--     marketplace_categories, marketplace_blacklist

DO $$
DECLARE
  tbl text;
  pol text;
  tables text[] := ARRAY[
    'marketplace_posts',
    'marketplace_responses',
    'marketplace_negotiations',
    'marketplace_messages',
    'marketplace_company_profiles',
    'marketplace_reviews',
    'marketplace_follows',
    'marketplace_auction_bids',
    'marketplace_contracts',
    'marketplace_contract_deliveries',
    'marketplace_shipments',
    'marketplace_shipment_events',
    'marketplace_financial_instruments',
    'marketplace_payment_milestones',
    'marketplace_trade_documents',
    'marketplace_categories',
    'marketplace_blacklist'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    IF to_regclass(('public.' || tbl)::text) IS NOT NULL THEN
      -- Re-enable + force RLS (no-op if already enabled).
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);

      -- Drop EVERY existing policy on the table. The original migrations
      -- created a single `USING(true) WITH CHECK(true)` policy each (named
      -- `<table>_service_role_all` or similar); we drop it (and any
      -- other stray policy that may have been added by a previous patch)
      -- so the new policy below is the only one in effect.
      FOR pol IN
        SELECT policyname
        FROM pg_policies
        WHERE schemaname = 'public' AND tablename = tbl
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol, tbl);
      END LOOP;

      -- Create the single service_role-only policy. Anonymous /
      -- authenticated clients get a 42501 (insufficient_privilege) when
      -- they try to read or write — the application uses service_role
      -- (which bypasses RLS) so legitimate flows are unaffected.
      EXECUTE format($f$
        CREATE POLICY %I ON public.%I
          FOR ALL
          USING (auth.role() = 'service_role')
          WITH CHECK (auth.role() = 'service_role')
      $f$, tbl || '_service_role_only', tbl);
    END IF;
  END LOOP;
END $$;

-- Verification query (run manually after applying):
--   SELECT tablename, policyname, cmd, qual
--   FROM pg_policies
--   WHERE schemaname = 'public'
--     AND tablename LIKE 'marketplace_%'
--   ORDER BY tablename, policyname;
--
-- Expected: every marketplace_* table has exactly one policy with
-- `qual = "(auth.role() = 'service_role'::text)"`.
