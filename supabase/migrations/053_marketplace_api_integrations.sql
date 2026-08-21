-- Marketplace Phase 12 — public API, integrations, white-label.
--
-- Schema changes for Phase 12 of the VELOS Marketplace:
--
--   1. ADD COLUMN partner_id to api_keys — so the new
--      /api/marketplace/api-keys route can scope keys to a specific
--      partner (a portal partner generating a key for external use).
--      Existing rows are NULL → tenant-level keys created by tenant
--      admins via /api/api-keys retain their original behaviour.
--      The new /api/marketplace/api-keys route filters by partner_id
--      so a partner can only see / revoke their own keys.
--
--   2. The white-label config + the marketplace webhook event types
--      require NO schema changes — they're stored in the existing
--      `settings` table (key=`marketplace_white_label`, value=JSON,
--      tenant-scoped) and the `webhooks` table's existing `events`
--      text-array column respectively.
--
-- The migration is IDEMPOTENT — `ADD COLUMN IF NOT EXISTS` means
-- re-running it on an already-migrated DB is a no-op. The new column
-- is NULLABLE so the existing tenant-admin API key path (which never
-- sets partner_id) keeps working unchanged.

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS partner_id TEXT;

-- Index for the partner-scoped list query (listApiKeys returns all
-- tenant keys; the marketplace route filters by partner_id in JS, but
-- a direct index here lets a future store-side filter hit the index
-- if we extend listApiKeys to accept a partner_id filter).
CREATE INDEX IF NOT EXISTS idx_api_keys_partner_id ON public.api_keys (partner_id)
  WHERE partner_id IS NOT NULL;

-- ─── Verification ─────────────────────────────────────────────────────────
-- After running this migration, the following should return a row:
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'api_keys' AND column_name = 'partner_id';
-- Expected: partner_id | text | YES
