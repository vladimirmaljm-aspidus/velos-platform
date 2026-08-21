-- 056_auction_sweep_cron.sql
-- ============================================================================
-- LOGIC-AUDIT Fix 1 — schedule the auction-sweep cron.
--
-- Background
-- ----------
-- The /api/cron/auction-sweep route (src/app/api/cron/auction-sweep/route.ts)
-- implements three marketplace maintenance sweeps:
--   1. Settle ended auctions whose auction_ends_at is in the past and
--      auction_winner_id IS NULL.
--   2. Lower Dutch auction current_price by the configured step
--      (5% of start_price, minimum 1 currency unit, capped at reserve).
--   3. Expire stale posts whose expires_at is in the past (soft-delete).
--
-- The route was implemented in Phase 4 (marketplace-auctions-contracts,
-- migration 046) but NO pg_cron job was scheduled to invoke it. The route
-- comment says "this cron is meant to run every 5-15 minutes" — but the
-- only way it was running was via the lazy on-demand trigger when a
-- bidder GETs /api/marketplace/[id]/bids on an expired-but-unsettled
-- auction. That lazy path:
--   • Doesn't lower Dutch prices on a schedule (a Dutch auction whose
--     end is hours away wouldn't drop price until someone happened to
--     view the bid list — defeating the "descending ask" mechanic).
--   • Doesn't expire stale posts (the lazy path only fires for posts
--     that are still 'active' AND have someone reading the bid list;
--     a post with no viewers stays 'active' forever).
--
-- This migration schedules the route via pg_cron + net.http_get using
-- the same hybrid token-lookup pattern established in migration 036
-- (current_setting GUC first, app_config table fallback for Supabase).
--
-- Cadence: every 10 minutes. The route comment says "5-15 minutes";
-- 10 is the midpoint — frequent enough that ended auctions settle
-- within a few minutes of their end_time (so bidders see the result
-- quickly), infrequent enough not to hammer Supabase / the marketplace
-- index backing the queries (idx_mp_auction_ends_active +
-- idx_mp_auction_dutch_active, migration 048).
--
-- Auth
-- ----
-- Same shared `authorizeCron` helper as the other cron routes. The
-- pg_cron command sends `Authorization: Bearer <CRON_TOKEN>` via the
-- hybrid COALESCE lookup — no literal token in cron.job.command.
--
-- Idempotent
-- ----------
-- All cron.unschedule calls are guarded by `WHERE EXISTS`. The
-- route itself is idempotent (processAuctionEnd no-ops on rows whose
-- auction_winner_id is already set; the Dutch price-drop is no-op when
-- already at reserve; the expire-stale UPDATE only affects rows still
-- in 'active' status).
--
-- Related
-- -------
-- Migration 046 (marketplace_auctions_contracts.sql) created the
-- underlying tables + the /api/cron/auction-sweep route.
-- Migration 048 (marketplace_ai_indexes.sql) added the backing indexes
-- (idx_mp_expires_active_phase5, idx_mp_auction_dutch_active).
-- ============================================================================

-- ─── 1. Schedule auction-sweep — every 10 minutes ──────────────────────────
SELECT cron.unschedule('auction-sweep')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auction-sweep');

SELECT cron.schedule(
  'auction-sweep',
  '*/10 * * * *',  -- every 10 minutes at minute 0,10,20,30,40,50
  $cmd$
    SELECT net.http_get(
      url := 'https://aspidus.onrender.com/api/cron/auction-sweep',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || COALESCE(
          nullif(current_setting('app.cron_token', true), ''),
          (SELECT value FROM public.app_config WHERE key = 'cron_token')
        )
      )
    )
  $cmd$
);

-- ─── 2. Verify ──────────────────────────────────────────────────────────────
SELECT jobname, schedule, active
  FROM cron.job
  WHERE jobname = 'auction-sweep'
  ORDER BY jobname;

-- ─── 3. Summary: all HTTP-based cron jobs (for ops visibility) ─────────────
SELECT jobname, schedule, active
  FROM cron.job
  WHERE command LIKE '%net.http_get%'
  ORDER BY jobname;
