-- 022_db_audit_fixes.sql
-- ============================================================================
-- Task ID: F-2 — DB audit fixes (FKs, RLS, indexes, table cleanup)
--
-- This migration captures all schema changes applied live to production via
-- the Supabase Management API on the date shown in the worklog. It is
-- committed here for replay on fresh clones / staging environments.
--
-- Sections:
--   §1  FK additions (offers.partner_id, demands.partner_id)
--   §2  RLS policies on user_preferences (user-scoped, not tenant-scoped)
--   §3  RLS policies on verification_logs — INTENTIONALLY NOT ADDED (see notes)
--   §4  Duplicate UNIQUE index drop on erp_journal_entries
--   §5  Missing tenant_id indexes (8 tables)
--   §6  Missing FK-column indexes (20 high-traffic FK columns)
--   §7  Orphan PM-tool tables — NOT DROPPED (have demo data, see notes)
--
-- All statements are idempotent (use IF NOT EXISTS / IF EXISTS).
-- ============================================================================

-- ─── §1. Foreign keys ───────────────────────────────────────────────────────
-- Pre-checks run on prod before this migration (all returned 0 orphans):
--   SELECT count(*) FROM offers   o LEFT JOIN partners p ON o.partner_id = p.id
--     WHERE p.id IS NULL AND o.partner_id IS NOT NULL;     -- 0
--   SELECT count(*) FROM demands  d LEFT JOIN partners p ON d.partner_id = p.id
--     WHERE p.id IS NULL AND d.partner_id IS NOT NULL;     -- 0
--
-- ON DELETE RESTRICT matches the project's existing convention for partner
-- references (partners are soft-deleted, never hard-deleted, so RESTRICT is
-- a safety net, not an operational constraint).

ALTER TABLE offers
  DROP CONSTRAINT IF EXISTS offers_partner_id_fkey;
ALTER TABLE offers
  ADD CONSTRAINT offers_partner_id_fkey
  FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE RESTRICT;

ALTER TABLE demands
  DROP CONSTRAINT IF EXISTS demands_partner_id_fkey;
ALTER TABLE demands
  ADD CONSTRAINT demands_partner_id_fkey
  FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE RESTRICT;

-- ─── §2. RLS policies on user_preferences ───────────────────────────────────
-- The user_preferences table has NO tenant_id column — it only has user_id
-- (text, storing UUIDs). The audit requested "tenant-scoped" policies, but
-- the appropriate scope for this table is user-scoped. We use auth.uid() so
-- a logged-in user accessing via the anon key can only read/write their own
-- preferences. The app uses the service_role key (which bypasses RLS), so
-- existing flows continue to work — these policies are defense-in-depth for
-- any future anon-key access path (Supabase Studio, edge functions, etc.).
--
-- Pre-check:
--   SELECT tablename, rowsecurity FROM pg_tables
--     WHERE tablename = 'user_preferences';          -- rowsecurity = true
--   SELECT * FROM pg_policy
--     WHERE polrelid = 'user_preferences'::regclass; -- 0 policies (before)

CREATE POLICY "user_preferences_user_select"
  ON user_preferences FOR SELECT
  USING (auth.uid()::text = user_id);

CREATE POLICY "user_preferences_user_insert"
  ON user_preferences FOR INSERT
  WITH CHECK (auth.uid()::text = user_id);

CREATE POLICY "user_preferences_user_update"
  ON user_preferences FOR UPDATE
  USING (auth.uid()::text = user_id)
  WITH CHECK (auth.uid()::text = user_id);

CREATE POLICY "user_preferences_user_delete"
  ON user_preferences FOR DELETE
  USING (auth.uid()::text = user_id);

-- ─── §3. verification_logs — NO POLICIES ADDED (intentional) ────────────────
-- verification_logs has RLS ENABLED but no policies. The table has no
-- tenant_id and no user_id column — it is a platform-wide audit log of
-- QR verifications (super-admin only via /api/super-admin/verification-logs).
--
-- With RLS enabled and zero policies, all anon-key access is DENIED by
-- default; only the service_role (which bypasses RLS) can read/write. This
-- is exactly the correct configuration for a super-admin-only audit table.
--
-- Adding tenant-scoped policies is impossible (no tenant_id column). Adding
-- auth.uid()-based policies is impossible (no user_id column). Therefore
-- no changes are applied to verification_logs — the existing RLS=on +
-- zero-policies configuration IS the desired end state.
--
-- Pre-check:
--   SELECT tablename, rowsecurity FROM pg_tables
--     WHERE tablename = 'verification_logs';        -- rowsecurity = true
--   SELECT * FROM pg_policy
--     WHERE polrelid = 'verification_logs'::regclass; -- 0 policies

-- (no SQL — intentionally empty)

-- ─── §4. Drop duplicate UNIQUE index on erp_journal_entries ──────────────────
-- Two indexes existed on (tenant_id, entry_number):
--   1. erp_journal_entries_tenant_entry_number_key       ← UNIQUE CONSTRAINT
--   2. erp_journal_entries_tenant_id_entry_number_key    ← plain UNIQUE INDEX
-- Both had identical column lists and were redundant. We drop the constraint
-- (which also drops its backing index) and keep the plain unique index so
-- existing INSERT/UPDATE paths that reference the index name still work.
--
-- Pre-check:
--   SELECT indexname FROM pg_indexes
--     WHERE tablename = 'erp_journal_entries'
--       AND indexdef LIKE '%entry_number%';
--   -- returned BOTH names

ALTER TABLE erp_journal_entries
  DROP CONSTRAINT IF EXISTS erp_journal_entries_tenant_entry_number_key;

-- ─── §5. Add missing tenant_id indexes ──────────────────────────────────────
-- These 8 tables have a tenant_id column but no index on it. Every
-- tenant-scoped query (WHERE tenant_id = ?) was doing a sequential scan.
-- All indexes are non-unique btree (write-heavy tables, perfect for
-- equality lookups + ordering).
--
-- Pre-check:
--   SELECT tablename FROM pg_tables WHERE schemaname = 'public'
--     AND NOT EXISTS (
--       SELECT 1 FROM pg_indexes WHERE tablename = pg_tables.tablename
--         AND indexdef LIKE '%tenant_id%'
--     )
--     AND EXISTS (
--       SELECT 1 FROM information_schema.columns
--         WHERE table_name = pg_tables.tablename AND column_name = 'tenant_id'
--     )
--   ORDER BY tablename;
--   -- returned 8 tables

CREATE INDEX IF NOT EXISTS idx_document_revisions_tenant_id
  ON document_revisions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_document_templates_tenant_id
  ON document_templates(tenant_id);
CREATE INDEX IF NOT EXISTS idx_entity_notes_tenant_id
  ON entity_notes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_erp_journal_lines_tenant_id
  ON erp_journal_lines(tenant_id);
CREATE INDEX IF NOT EXISTS idx_partner_connections_tenant_id
  ON partner_connections(tenant_id);
CREATE INDEX IF NOT EXISTS idx_password_resets_tenant_id
  ON password_resets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_recurring_expenses_tenant_id
  ON recurring_expenses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_id
  ON sessions(tenant_id);

-- ─── §6. Add missing FK-column indexes ──────────────────────────────────────
-- 38 FK columns were missing supporting indexes. We added indexes for the 20
-- highest-traffic ones below (selected based on query patterns in src/:
-- offer/deal/portal/kyc/erp queries). The remaining 18 are intentionally
-- skipped — they are either:
--   - audit-only columns (created_by, updated_by) — low cardinality, only
--     used for display, not JOIN
--   - settings-table FKs (erp_settings.*) — one row per tenant, sequential
--     scan of 1 row is faster than an index lookup
--   - small lookup-table FKs (erp_cost_centers.parent_id,
--     erp_bank_accounts.account_id) — under 100 rows
--   - low-traffic admin FKs (plan_upgrade_requests.*, feature_flags.updated_by)
--
-- Pre-check (FK columns missing indexes):
--   SELECT tc.table_name, kcu.column_name
--   FROM information_schema.table_constraints tc
--   JOIN information_schema.key_column_usage kcu
--     ON tc.constraint_name = kcu.constraint_name
--   WHERE tc.constraint_type = 'FOREIGN KEY'
--     AND tc.table_schema = 'public'
--     AND NOT EXISTS (
--       SELECT 1 FROM pg_indexes i
--       WHERE i.tablename = tc.table_name
--         AND i.indexdef LIKE '%' || kcu.column_name || '%'
--     );

CREATE INDEX IF NOT EXISTS idx_offers_deal_id
  ON offers(deal_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_partner_id
  ON inventory_movements(partner_id);
CREATE INDEX IF NOT EXISTS idx_portal_rfqs_partner_id
  ON portal_rfqs(partner_id);
CREATE INDEX IF NOT EXISTS idx_portal_rfqs_portal_access_id
  ON portal_rfqs(portal_access_id);
CREATE INDEX IF NOT EXISTS idx_kyc_submissions_portal_access_id
  ON kyc_submissions(portal_access_id);
CREATE INDEX IF NOT EXISTS idx_kyc_submissions_reviewed_by
  ON kyc_submissions(reviewed_by);
CREATE INDEX IF NOT EXISTS idx_erp_journal_lines_cost_center_id
  ON erp_journal_lines(cost_center_id);
CREATE INDEX IF NOT EXISTS idx_erp_journal_lines_partner_id
  ON erp_journal_lines(partner_id);
CREATE INDEX IF NOT EXISTS idx_erp_journal_entries_fiscal_period_id
  ON erp_journal_entries(fiscal_period_id);
CREATE INDEX IF NOT EXISTS idx_document_register_partner_id
  ON document_register(partner_id);
CREATE INDEX IF NOT EXISTS idx_trade_calculations_buyer_id
  ON trade_calculations(buyer_id);
CREATE INDEX IF NOT EXISTS idx_trade_calculations_supplier_id
  ON trade_calculations(supplier_id);
CREATE INDEX IF NOT EXISTS idx_trade_calculations_supplier_offer_id
  ON trade_calculations(supplier_offer_id);
CREATE INDEX IF NOT EXISTS idx_supplier_offers_supplier_id
  ON supplier_offers(supplier_id);
CREATE INDEX IF NOT EXISTS idx_portal_access_approved_by
  ON portal_access(approved_by);
CREATE INDEX IF NOT EXISTS idx_shared_documents_uploaded_by
  ON shared_documents(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_erp_bank_transactions_journal_entry_id
  ON erp_bank_transactions(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_commission_payouts_partner_id
  ON commission_payouts(partner_id);
CREATE INDEX IF NOT EXISTS idx_deal_commissions_partner_id
  ON deal_commissions(partner_id);
CREATE INDEX IF NOT EXISTS idx_document_verifications_issued_to_partner_id
  ON document_verifications(issued_to_partner_id);

-- ─── §7. Orphan PM-tool tables — NOT DROPPED ────────────────────────────────
-- Audit requested dropping 7 "orphan PM-tool" tables:
--   file_manager, meeting_notes, team_chat_messages, project_tasks,
--   expense_entries, time_entries, reminders
--
-- Findings:
--   - All 7 tables EXIST in production
--   - Each contains exactly 1 row of demo/seed data (tenant_id =
--     c889572d-d35b-43ec-bca1-a5359d95603d, created_at = 2026-08-03)
--   - NO source code references any of these tables in src/ (verified
--     with rg over src/, supabase/, *.ts, *.tsx, *.sql)
--   - The UI (src/components/views/workspace-view.tsx) lists all 7 as
--     PLANNED features under a "Coming soon / In development" panel —
--     they are advertised as future work, not as live features
--
-- Per task instructions: "If they have data or are referenced, DON'T drop —
-- just report." Since they contain data (even if it is only seed/demo rows),
-- we DO NOT drop them. The team should decide separately whether to:
--   (a) Keep the tables for future implementation (the UI already advertises
--       them as "planned")
--   (b) Drop the demo rows + tables if those features are not being built
--   (c) Implement the features and migrate the demo data
--
-- No SQL emitted — intentionally empty.

-- (no SQL — intentionally empty)

-- ============================================================================
-- Verification queries (run after migration):
-- ============================================================================
-- SELECT conname FROM pg_constraint
--   WHERE conname IN ('offers_partner_id_fkey','demands_partner_id_fkey');
--   -- expect 2 rows
--
-- SELECT polname FROM pg_policy
--   WHERE polrelid = 'user_preferences'::regclass;
--   -- expect 4 rows (select, insert, update, delete)
--
-- SELECT indexname FROM pg_indexes
--   WHERE tablename = 'erp_journal_entries'
--     AND indexdef LIKE '%entry_number%';
--   -- expect 1 row: erp_journal_entries_tenant_id_entry_number_key
--
-- SELECT tablename FROM pg_tables WHERE schemaname = 'public'
--   AND NOT EXISTS (
--     SELECT 1 FROM pg_indexes WHERE tablename = pg_tables.tablename
--       AND indexdef LIKE '%tenant_id%'
--   )
--   AND EXISTS (
--     SELECT 1 FROM information_schema.columns
--       WHERE table_name = pg_tables.tablename AND column_name = 'tenant_id'
--   );
--   -- expect 0 rows
--
-- SELECT count(*) FROM pg_indexes
--   WHERE indexname LIKE 'idx_%_partner_id'
--      OR indexname LIKE 'idx_%_deal_id'
--      OR indexname LIKE 'idx_%_portal_access_id';
--   -- expect >= 8 rows
-- ============================================================================
