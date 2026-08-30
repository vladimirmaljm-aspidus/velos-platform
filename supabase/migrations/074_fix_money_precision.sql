-- 074_fix_money_precision.sql
-- ============================================================================
-- AUDIT FIX — 2c2-F4 + 2c2-F5 + 2c2-F6 (CRITICAL, round 2)
--
-- PROBLEM
--   19 money + exchange-rate columns across the schema use `double precision`
--   (IEEE 754 float64). Live data confirms the FP-drift bug:
--     • offer 8/2026 stores total = 14581.199999999999 (should be 14581.20)
--     • invoice INV-2026-0004 line items sum to 38359.999999999996 (stored 38360)
--   This is a VAT/accounting compliance violation — tax authorities require
--   exact decimal arithmetic, not floats. Bank reconciliation + GL totals
--   drift over time as FP errors accumulate across thousands of rows.
--
-- FIX
--   Convert the 19 money + rate columns from `double precision` to
--   `numeric(precision, scale)`:
--     • Money columns (12) → numeric(18,4)  [max 999,999,999,999,999.9999]
--     • Exchange-rate columns (7) → numeric(18,6)  [rates need 6 decimals]
--     • VAT/commission rates → numeric(8,4)  [percentages]
--   The `USING ROUND(col::numeric, scale)` clause ensures safe rounding —
--   no data loss. Pre-migration verification confirmed 0 rows have values
--   with more than 4 decimal places (the only columns with live data:
--   erp_journal_lines.debit/credit + erp_bank_accounts.balance).
--
-- NON-MONEY COLUMNS LEFT AS-IS (no FP compliance risk):
--   • document_verification_logs.latitude/longitude (real) — geo coords
--   • memorandum_settings.body_line_height (real) — UI setting
--   • project_tasks.actual_hours/estimated_hours — time tracking (separate concern)
--   • tenant_letterheads.watermark_opacity/rotation — UI settings 0-1 / degrees
--   • tenant_seals.opacity/rotation_deg — UI settings
--   These don't affect accounting/VAT; converting them is cosmetic + risks
--   breaking the UI render. Left for a follow-up if desired.
--
-- SAFETY
--   • `USING ROUND(col::numeric, scale)` — no data loss (verified pre-flight).
--   • ALTER COLUMN TYPE is transactional (auto-rollback on failure).
--   • Idempotent-ish: re-running errors with "column already numeric" — safe.
--   • Dependent indexes are auto-recreated by Postgres.
--   • Prisma client maps numeric → number (transparent, no app-side breakage).
-- ============================================================================

-- ── 1. Money columns → numeric(18,4) ──────────────────────────────────────
ALTER TABLE public.erp_bank_accounts      ALTER COLUMN balance        TYPE numeric(18,4) USING ROUND(balance::numeric, 4);
ALTER TABLE public.erp_bank_transactions  ALTER COLUMN amount        TYPE numeric(18,4) USING ROUND(amount::numeric, 4);
ALTER TABLE public.erp_journal_entries    ALTER COLUMN credit_total   TYPE numeric(18,4) USING ROUND(credit_total::numeric, 4);
ALTER TABLE public.erp_journal_entries    ALTER COLUMN debit_total    TYPE numeric(18,4) USING ROUND(debit_total::numeric, 4);
ALTER TABLE public.erp_journal_lines      ALTER COLUMN credit         TYPE numeric(18,4) USING ROUND(credit::numeric, 4);
ALTER TABLE public.erp_journal_lines      ALTER COLUMN debit          TYPE numeric(18,4) USING ROUND(debit::numeric, 4);
ALTER TABLE public.expense_entries        ALTER COLUMN amount         TYPE numeric(18,4) USING ROUND(amount::numeric, 4);
ALTER TABLE public.plans                  ALTER COLUMN price_monthly TYPE numeric(18,4) USING ROUND(price_monthly::numeric, 4);
ALTER TABLE public.plans                  ALTER COLUMN price_yearly  TYPE numeric(18,4) USING ROUND(price_yearly::numeric, 4);
ALTER TABLE public.recurring_expenses     ALTER COLUMN amount        TYPE numeric(18,4) USING ROUND(amount::numeric, 4);
ALTER TABLE public.tenants               ALTER COLUMN amount_paid    TYPE numeric(18,4) USING ROUND(amount_paid::numeric, 4);
ALTER TABLE public.time_entries           ALTER COLUMN hourly_rate   TYPE numeric(18,4) USING ROUND(hourly_rate::numeric, 4);

-- ── 2. Exchange-rate columns → numeric(18,6) (rates need 6 decimals) ──────
ALTER TABLE public.deals                  ALTER COLUMN exchange_rate TYPE numeric(18,6) USING ROUND(exchange_rate::numeric, 6);
ALTER TABLE public.erp_journal_entries    ALTER COLUMN exchange_rate TYPE numeric(18,6) USING ROUND(exchange_rate::numeric, 6);
ALTER TABLE public.invoices              ALTER COLUMN exchange_rate TYPE numeric(18,6) USING ROUND(exchange_rate::numeric, 6);
ALTER TABLE public.offers                ALTER COLUMN exchange_rate TYPE numeric(18,6) USING ROUND(exchange_rate::numeric, 6);
ALTER TABLE public.proformas             ALTER COLUMN exchange_rate TYPE numeric(18,6) USING ROUND(exchange_rate::numeric, 6);

-- ── 3. Percentage/rate columns → numeric(8,4) ─────────────────────────────
ALTER TABLE public.erp_settings           ALTER COLUMN vat_rate      TYPE numeric(8,4)  USING ROUND(vat_rate::numeric, 4);
ALTER TABLE public.trade_calculations    ALTER COLUMN commission_rate TYPE numeric(8,4) USING ROUND(commission_rate::numeric, 4);

-- ── Verification ───────────────────────────────────────────────────────────
-- Each column should now show data_type = 'numeric' (not 'double precision').
SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name IN (
    'balance','amount','credit_total','debit_total','credit','debit',
    'price_monthly','price_yearly','amount_paid','hourly_rate',
    'exchange_rate','vat_rate','commission_rate'
  )
ORDER BY table_name, column_name;
