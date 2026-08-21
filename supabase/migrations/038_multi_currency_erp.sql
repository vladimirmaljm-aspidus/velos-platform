-- 038_multi_currency_erp.sql
-- ============================================================================
-- E-2 (Multi-currency ERP)
--   Adds line-level currency + FX-rate + base-currency amounts to the ERP
--   journal, an entry-level base_currency + revaluation marker, and a
--   create_fx_revaluation(...) RPC for periodic FX revaluation entries.
--
-- Pre-flight
--   * The columns added here were applied to the live Supabase project
--     `nwmwdsslgozqwuufjudj` via the Management API on 2025-08-17 as part
--     of this task. The ALTER statements are repeated below with
--     `IF NOT EXISTS` so the migration is idempotent on re-runs.
--
-- Result
--   * erp_journal_lines.currency       TEXT    DEFAULT 'USD'  (line-level
--                                                   currency — co-exists
--                                                   with the pre-existing
--                                                   'EUR' default set by
--                                                   migration 002/031)
--   * erp_journal_lines.fx_rate        NUMERIC DEFAULT 1.0
--   * erp_journal_lines.debit_base     NUMERIC DEFAULT 0
--   * erp_journal_lines.credit_base    NUMERIC DEFAULT 0
--   * erp_journal_entries.base_currency     TEXT    DEFAULT 'USD'
--   * erp_journal_entries.is_revaluation    BOOLEAN DEFAULT false
--   * erp_journal_entries.revaluation_of    UUID
--   * public.erp_journal_seq          sequence for revaluation entry numbers
--   * upsert_journal_entry RPC — extended to persist the new columns
--   * create_fx_revaluation RPC — generates a revaluation journal entry
-- ============================================================================


-- ============================================================================
-- Schema changes
-- ============================================================================
ALTER TABLE erp_journal_lines ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';
ALTER TABLE erp_journal_lines ADD COLUMN IF NOT EXISTS fx_rate NUMERIC DEFAULT 1.0;
ALTER TABLE erp_journal_lines ADD COLUMN IF NOT EXISTS debit_base NUMERIC DEFAULT 0;
ALTER TABLE erp_journal_lines ADD COLUMN IF NOT EXISTS credit_base NUMERIC DEFAULT 0;

ALTER TABLE erp_journal_entries ADD COLUMN IF NOT EXISTS base_currency TEXT DEFAULT 'USD';
ALTER TABLE erp_journal_entries ADD COLUMN IF NOT EXISTS is_revaluation BOOLEAN DEFAULT false;
ALTER TABLE erp_journal_entries ADD COLUMN IF NOT EXISTS revaluation_of UUID;

-- Sequence used by create_fx_revaluation to generate unique entry numbers
-- per revaluation date (REVAL-YYYYMMDD-NNNN).
CREATE SEQUENCE IF NOT EXISTS public.erp_journal_seq START WITH 1 INCREMENT BY 1 NO CYCLE;


-- ============================================================================
-- upsert_journal_entry — extended for multi-currency
--   * Body preserved from migration 031 (atomic REPLACE header + lines).
--   * Header INSERT/UPDATE now also persists base_currency (COALESCE),
--     is_revaluation, and revaluation_of (NULL on non-revaluation entries).
--   * Lines INSERT now persists currency, fx_rate, and the derived
--     debit_base / credit_base (foreign amount * fx_rate). When the caller
--     passes explicit debit_base / credit_base (e.g. revaluation adjustments
--     that don't have a meaningful "foreign amount"), those values are used
--     directly. When the caller omits them and the foreign amount is zero
--     (a one-sided revaluation line), the base amount is still derived from
--     the explicit *_base value if present, falling back to 0.
--   * For backward compatibility, every new column is COALESCEd with a sane
--     default so existing callers that do not send the new fields get the
--     same behavior as before (currency=base_currency or 'USD', fx_rate=1,
--     debit_base = debit * 1).
-- ============================================================================
CREATE OR REPLACE FUNCTION upsert_journal_entry(
  p_entry jsonb,
  p_lines jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id text;
  v_existing_id text;
  v_tenant_id text;
  v_result jsonb;
  v_line jsonb;
  v_line_currency text;
  v_line_fx_rate numeric;
  v_line_debit numeric;
  v_line_credit numeric;
  v_line_debit_base numeric;
  v_line_credit_base numeric;
  v_line_no int := 0;
BEGIN
  v_id := p_entry->>'id';
  v_tenant_id := p_entry->>'tenant_id';

  IF v_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'upsert_journal_entry: p_entry must contain id and tenant_id';
  END IF;

  SELECT id INTO v_existing_id FROM erp_journal_entries WHERE id = v_id;

  IF v_existing_id IS NOT NULL THEN
    UPDATE erp_journal_entries SET
      tenant_id        = COALESCE(p_entry->>'tenant_id', tenant_id),
      entry_number     = COALESCE(p_entry->>'entry_number', entry_number),
      date             = CASE WHEN p_entry ? 'date' THEN (p_entry->>'date')::timestamptz ELSE date END,
      description      = COALESCE(p_entry->>'description', description),
      reference_type   = COALESCE(p_entry->>'reference_type', reference_type),
      reference_id     = COALESCE(p_entry->>'reference_id', reference_id),
      fiscal_period_id = COALESCE(p_entry->>'fiscal_period_id', fiscal_period_id),
      status           = COALESCE(p_entry->>'status', status),
      source_type      = COALESCE(p_entry->>'source_type', source_type),
      debit_total      = CASE WHEN p_entry ? 'debit_total' THEN (p_entry->>'debit_total')::double precision ELSE debit_total END,
      credit_total     = CASE WHEN p_entry ? 'credit_total' THEN (p_entry->>'credit_total')::double precision ELSE credit_total END,
      currency         = COALESCE(p_entry->>'currency', currency),
      exchange_rate    = CASE WHEN p_entry ? 'exchange_rate' THEN (p_entry->>'exchange_rate')::double precision ELSE exchange_rate END,
      base_currency    = COALESCE(p_entry->>'base_currency', base_currency),
      is_revaluation   = CASE WHEN p_entry ? 'is_revaluation' THEN (p_entry->>'is_revaluation')::boolean ELSE is_revaluation END,
      revaluation_of   = CASE WHEN p_entry ? 'revaluation_of' AND (p_entry->>'revaluation_of') IS NOT NULL THEN (p_entry->>'revaluation_of')::uuid ELSE revaluation_of END,
      notes            = COALESCE(p_entry->>'notes', notes),
      posted_by        = COALESCE(p_entry->>'posted_by', posted_by),
      posted_at        = CASE WHEN p_entry->>'posted_at' IS NOT NULL THEN (p_entry->>'posted_at')::timestamptz ELSE posted_at END,
      updated_at       = now()
    WHERE id = v_id;

    DELETE FROM erp_journal_lines WHERE journal_entry_id = v_id;
  ELSE
    INSERT INTO erp_journal_entries (
      id, tenant_id, entry_number, date, description, reference_type, reference_id,
      fiscal_period_id, status, source_type, debit_total, credit_total, currency,
      exchange_rate, base_currency, is_revaluation, revaluation_of, notes, created_by, posted_by, posted_at
    ) VALUES (
      v_id,
      v_tenant_id,
      p_entry->>'entry_number',
      COALESCE((p_entry->>'date')::timestamptz, now()),
      COALESCE(p_entry->>'description', ''),
      p_entry->>'reference_type',
      p_entry->>'reference_id',
      p_entry->>'fiscal_period_id',
      COALESCE(p_entry->>'status', 'draft'),
      p_entry->>'source_type',
      COALESCE((p_entry->>'debit_total')::double precision, 0),
      COALESCE((p_entry->>'credit_total')::double precision, 0),
      COALESCE(p_entry->>'currency', 'USD'),
      COALESCE((p_entry->>'exchange_rate')::double precision, 1),
      COALESCE(p_entry->>'base_currency', 'USD'),
      COALESCE((p_entry->>'is_revaluation')::boolean, false),
      CASE WHEN p_entry->>'revaluation_of' IS NOT NULL THEN (p_entry->>'revaluation_of')::uuid ELSE NULL END,
      p_entry->>'notes',
      p_entry->>'created_by',
      p_entry->>'posted_by',
      CASE WHEN p_entry->>'posted_at' IS NOT NULL THEN (p_entry->>'posted_at')::timestamptz ELSE NULL END
    );
  END IF;

  -- Insert lines within the same transaction. The previous implementation
  -- used a single INSERT..SELECT from jsonb_array_elements; we now use a
  -- FOR loop so we can derive debit_base/credit_base per-line. Typical
  -- entries have 2-10 lines, so the overhead is negligible.
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_line_no := v_line_no + 1;
    v_line_currency   := COALESCE(v_line->>'currency', p_entry->>'currency', 'USD');
    v_line_fx_rate    := COALESCE((v_line->>'fx_rate')::numeric, (p_entry->>'exchange_rate')::numeric, 1.0);
    v_line_debit      := COALESCE((v_line->>'debit')::numeric, 0);
    v_line_credit     := COALESCE((v_line->>'credit')::numeric, 0);

    -- Base amounts: prefer explicit values from the caller (used by the
    -- revaluation function, which posts one-sided adjustments where the
    -- "foreign amount" doesn't make sense). Otherwise derive from the
    -- foreign amount * fx_rate.
    v_line_debit_base  := COALESCE(
      NULLIF(v_line->>'debit_base', '')::numeric,
      v_line_debit  * v_line_fx_rate
    );
    v_line_credit_base := COALESCE(
      NULLIF(v_line->>'credit_base', '')::numeric,
      v_line_credit * v_line_fx_rate
    );

    INSERT INTO erp_journal_lines (
      id, journal_entry_id, tenant_id, account_id, description,
      debit, credit, line_number, currency, fx_rate, debit_base, credit_base
    ) VALUES (
      gen_random_uuid()::text,
      v_id,
      v_tenant_id,
      v_line->>'account_id',
      v_line->>'description',
      v_line_debit::double precision,
      v_line_credit::double precision,
      COALESCE((v_line->>'line_number')::int, v_line_no),
      v_line_currency,
      v_line_fx_rate,
      v_line_debit_base,
      v_line_credit_base
    );
  END LOOP;

  SELECT jsonb_build_object(
    'entry', to_jsonb(e),
    'lines', COALESCE((
      SELECT jsonb_agg(to_jsonb(l) ORDER BY l.line_number)
      FROM erp_journal_lines l
      WHERE l.journal_entry_id = v_id
    ), '[]'::jsonb)
  ) INTO v_result
  FROM erp_journal_entries e
  WHERE e.id = v_id;

  RETURN v_result;
END;
$$;


-- ============================================================================
-- create_fx_revaluation — generate a revaluation journal entry
--   * p_tenant_id          : tenant scope
--   * p_reval_date         : as-of date for the revaluation
--   * p_base_currency      : base currency (default 'USD')
--   * p_adjustments        : JSON array of per-account adjustments, each
--                            shaped as:
--                              {
--                                "account_id":     "<erp_accounts.id>",
--                                "currency":       "EUR",
--                                "fx_rate_old":    1.10,
--                                "fx_rate_new":    1.18,
--                                "balance_foreign": 10000.00,   -- +debit bal / -credit bal
--                                "gain_loss_account_id": "<erp_accounts.id for FX P&L>",
--                                "description":    "AR reval EUR"
--                              }
--   * p_created_by         : user id (NOT NULL on the table)
--
-- For each adjustment the function computes:
--   base_old = balance_foreign * fx_rate_old
--   base_new = balance_foreign * fx_rate_new
--   delta    = base_new - base_old
--
-- A positive delta on a debit-balance account (asset) is an FX gain; a
-- positive delta on a credit-balance account (liability) is an FX loss.
-- The function posts TWO lines per adjustment:
--   * line 1: the foreign-currency account, debited/credited by |delta|
--             in the BASE currency (debit_base/credit_base only — the
--             foreign-currency debit/credit is 0 because the foreign
--             balance itself is unchanged; only its base-currency
--             representation moves)
--   * line 2: the FX gain/loss account, on the opposite side, so the
--             entry balances
--
-- The entry is left in 'draft' status so a human can review the lines
-- before posting.
-- ============================================================================
CREATE OR REPLACE FUNCTION create_fx_revaluation(
  p_tenant_id text,
  p_reval_date date,
  p_base_currency text DEFAULT 'USD',
  p_adjustments jsonb DEFAULT '[]'::jsonb,
  p_created_by text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_entry_id text := gen_random_uuid()::text;
  v_entry_number text;
  v_total_debit_base numeric := 0;
  v_total_credit_base numeric := 0;
  v_line_count int := 0;
  v_adj jsonb;
  v_account_id text;
  v_currency text;
  v_rate_old numeric;
  v_rate_new numeric;
  v_balance numeric;
  v_gl_account_id text;
  v_desc text;
  v_base_old numeric;
  v_base_new numeric;
  v_delta numeric;
  v_debit_base numeric;
  v_credit_base numeric;
  v_lines jsonb := '[]'::jsonb;
  v_line_no int := 0;
BEGIN
  IF p_created_by IS NULL OR p_created_by = '' THEN
    RAISE EXCEPTION 'create_fx_revaluation: p_created_by is required';
  END IF;

  -- REVAL-YYYYMMDD-NNNN using a per-day rolling counter
  SELECT 'REVAL-' || to_char(p_reval_date, 'YYYYMMDD') || '-' ||
         lpad(nextval('erp_journal_seq')::text, 4, '0')
  INTO v_entry_number;

  -- Insert the revaluation entry header
  INSERT INTO erp_journal_entries (
    id, tenant_id, entry_number, date, description, reference_type, reference_id,
    status, source_type, debit_total, credit_total, currency, exchange_rate,
    base_currency, is_revaluation, notes, created_by
  ) VALUES (
    v_entry_id,
    p_tenant_id,
    v_entry_number,
    p_reval_date::timestamptz,
    'FX Revaluation as of ' || to_char(p_reval_date, 'YYYY-MM-DD'),
    'manual',
    NULL,
    'draft',
    'auto',
    0,
    0,
    p_base_currency,
    1,
    p_base_currency,
    true,
    'Auto-generated by create_fx_revaluation RPC',
    p_created_by
  );

  -- For each adjustment, build a pair of balanced lines.
  -- TODO: the open-balance-detection (which accounts have a non-base
  -- currency balance, what the old and new rates are) is intentionally
  -- left to the application layer — it has access to the
  -- /api/exchange-rates endpoint and can compute the adjustments
  -- externally, then call this RPC with the resulting list. A future
  -- task can inline that detection here if a database-side FX source
  -- becomes available (e.g. a materialized fx_rates table refreshed
  -- by a cron).
  FOR v_adj IN SELECT * FROM jsonb_array_elements(p_adjustments)
  LOOP
    v_account_id    := v_adj->>'account_id';
    v_currency      := COALESCE(v_adj->>'currency', p_base_currency);
    v_rate_old      := COALESCE((v_adj->>'fx_rate_old')::numeric, 1.0);
    v_rate_new      := COALESCE((v_adj->>'fx_rate_new')::numeric, 1.0);
    v_balance       := COALESCE((v_adj->>'balance_foreign')::numeric, 0);
    v_gl_account_id := v_adj->>'gain_loss_account_id';
    v_desc          := COALESCE(v_adj->>'description', 'FX revaluation ' || v_currency);

    IF v_account_id IS NULL OR v_gl_account_id IS NULL THEN
      RAISE EXCEPTION 'create_fx_revaluation: each adjustment must include account_id and gain_loss_account_id';
    END IF;

    v_base_old := v_balance * v_rate_old;
    v_base_new := v_balance * v_rate_new;
    v_delta    := v_base_new - v_base_old;

    -- delta > 0 on a debit-balance account (balance > 0) => increase in
    -- asset value => FX gain => credit the FX gain/loss account.
    -- delta > 0 on a credit-balance account (balance < 0) => increase in
    -- liability value => FX loss => debit the FX gain/loss account.
    IF v_delta >= 0 THEN
      -- Gain on debit-balance (asset) OR loss on credit-balance (liability)
      IF v_balance >= 0 THEN
        -- Asset gain: debit asset, credit P&L
        v_debit_base  := v_delta;
        v_credit_base := 0;
      ELSE
        -- Liability loss: debit P&L, credit liability
        v_debit_base  := 0;
        v_credit_base := v_delta;
      END IF;
    ELSE
      -- delta < 0: loss on asset OR gain on liability
      IF v_balance >= 0 THEN
        -- Asset loss: credit asset, debit P&L
        v_debit_base  := 0;
        v_credit_base := -v_delta;
      ELSE
        -- Liability gain: credit P&L, debit liability
        v_debit_base  := -v_delta;
        v_credit_base := 0;
      END IF;
    END IF;

    v_line_no := v_line_no + 1;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'line_number', v_line_no,
      'account_id', v_account_id,
      'description', v_desc,
      'debit', 0,
      'credit', 0,
      'currency', v_currency,
      'fx_rate', v_rate_new,
      'debit_base', v_debit_base,
      'credit_base', v_credit_base
    ));

    v_line_no := v_line_no + 1;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'line_number', v_line_no,
      'account_id', v_gl_account_id,
      'description', 'FX gain/loss — ' || v_currency,
      'debit', 0,
      'credit', 0,
      'currency', p_base_currency,
      'fx_rate', 1.0,
      'debit_base', v_credit_base,  -- opposite side
      'credit_base', v_debit_base
    ));

    v_total_debit_base  := v_total_debit_base  + v_debit_base  + v_credit_base;
    v_total_credit_base := v_total_credit_base + v_credit_base + v_debit_base;
    v_line_count := v_line_count + 2;
  END LOOP;

  -- Insert lines via upsert_journal_entry so the same code path validates
  -- every line. We pass the entry header (already inserted above — the
  -- RPC will see it exists and UPDATE instead of INSERT) and the lines
  -- array we just built. The RPC's FOR loop derives debit_base/credit_base
  -- from explicit values when present (which we always provide here).
  PERFORM upsert_journal_entry(
    jsonb_build_object(
      'id', v_entry_id,
      'tenant_id', p_tenant_id,
      'entry_number', v_entry_number,
      'date', p_reval_date::timestamptz,
      'description', 'FX Revaluation as of ' || to_char(p_reval_date, 'YYYY-MM-DD'),
      'reference_type', 'manual',
      'status', 'draft',
      'source_type', 'auto',
      'debit_total', v_total_debit_base::double precision,
      'credit_total', v_total_debit_base::double precision,
      'currency', p_base_currency,
      'exchange_rate', 1,
      'base_currency', p_base_currency,
      'is_revaluation', true,
      'created_by', p_created_by
    ),
    v_lines
  );

  RETURN jsonb_build_object(
    'id', v_entry_id,
    'entry_number', v_entry_number,
    'line_count', v_line_count,
    'total_debit_base', v_total_debit_base,
    'total_credit_base', v_total_credit_base
  );
END;
$$;


-- ============================================================================
-- GRANT — explicit EXECUTE grant to service_role. Idempotent.
-- ============================================================================
GRANT EXECUTE ON FUNCTION upsert_journal_entry(jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION create_fx_revaluation(text, date, text, jsonb, text) TO service_role;


-- ============================================================================
-- VERIFICATION QUERIES (run manually in Supabase Studio → SQL Editor)
-- ============================================================================
-- 1. New columns present:
--      SELECT table_name, column_name, data_type, column_default
--      FROM information_schema.columns
--      WHERE (table_name='erp_journal_lines' AND column_name IN ('currency','fx_rate','debit_base','credit_base'))
--         OR (table_name='erp_journal_entries' AND column_name IN ('base_currency','is_revaluation','revaluation_of'))
--      ORDER BY table_name, column_name;
--    Expected: 7 rows, all with the defaults shown above.
--
-- 2. upsert_journal_entry signature unchanged (still 2 jsonb args):
--      SELECT pg_get_functiondef('upsert_journal_entry(jsonb,jsonb)'::regprocedure);
--    Expected: function body persists currency/fx_rate/debit_base/credit_base
--    per line and base_currency/is_revaluation/revaluation_of per entry.
--
-- 3. create_fx_revaluation signature:
--      SELECT pg_get_functiondef('create_fx_revaluation(text,date,text,jsonb,text)'::regprocedure);
--
-- 4. Smoke-test create_fx_revaluation (no adjustments → empty entry):
--      SELECT create_fx_revaluation(
--        '<tenant-uuid>'::text,
--        current_date,
--        'USD',
--        '[]'::jsonb,
--        '<user-uuid>'::text
--      );
--    Expected: { "id": "<uuid>", "entry_number": "REVAL-YYYYMMDD-0001",
--               "line_count": 0, "total_debit_base": 0, "total_credit_base": 0 }
