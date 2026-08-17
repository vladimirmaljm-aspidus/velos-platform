# Supabase Migrations

These SQL files should be applied via Supabase Studio → SQL Editor, **in order**:

| # | File | Fixes | Status |
|---|---|---|---|
| 1 | `001_fix_rls_policies.sql` | CRIT-3 — replaces permissive `USING(true)` RLS policies with tenant-scoped ones | Ready (not applied) |
| 2 | `002_add_rpc_functions.sql` | TXN-1, TXN-2, TXN-4, TXN-5 + SCH-4 — adds transaction-safe RPC functions and the missing unique constraint | Ready (not applied) |

## How to apply

1. Open **Supabase Studio → SQL Editor** for the target project.
2. Paste the **entire** contents of `001_fix_rls_policies.sql` and click **Run**.
3. Review the `NOTICE` messages — they list which tables were enabled, skipped (missing), or had policies created. Any "no tenant_id column" notices should be reviewed.
4. Run the verification queries at the bottom of the file.
5. Repeat for `002_add_rpc_functions.sql`.
6. Run its verification queries — confirm the four RPC functions exist and the `erp_journal_entries_tenant_entry_number_key` constraint is present.

## Important notes

- **Idempotent.** Both files are safe to run multiple times. `001` uses `DROP POLICY IF EXISTS` and `to_regclass()` checks; `002` uses `CREATE OR REPLACE FUNCTION` and an `IF NOT EXISTS` constraint check.
- **Schema-aware.** The migrations were verified against `supabase-schema-full.sql` (the production snapshot) — not the dev `supabase-schema.sql`. Known production-only differences (e.g. `erp_journal_lines.tenant_id` exists in production but not in dev) are handled inline.
- **Defense-in-depth RLS.** `001` uses `current_setting('app.tenant_id', true)`. The app uses the **service_role** key (which bypasses RLS), so these policies do **not** affect normal app traffic. They protect against anon-key access, Supabase Studio access, and any future code path that uses the anon key. If the app ever switches to anon-key auth, it MUST set `SET app.tenant_id = '<uuid>'` before any tenant-scoped query.
- **SECURITY DEFINER RPCs.** The functions in `002` run with the privileges of their owner (typically `postgres`). This is required because the app calls them via the service_role key, which bypasses RLS but still needs explicit table grants. SECURITY DEFINER ensures the functions can read/write all referenced tables.
- **No data loss.** Neither migration deletes or modifies data. `001` only drops and re-creates RLS policies (which are access-control rules, not data). `002` only creates functions and adds a constraint (existing rows that violate the constraint, if any, will cause the constraint addition to fail with a clear error — review and fix those rows before retrying).

## After applying — required follow-up (separate task)

The migrations add the **DB-layer** fixes, but the application code still uses the old non-atomic patterns. A follow-up task should update the store methods and route handlers to call the new RPC functions instead:

| Current code | Replace with |
|---|---|
| `src/lib/data/supabase-store.ts:1567-1580` (`upsertErpJournalEntry`) | `sb.rpc('upsert_journal_entry', { p_entry, p_lines })` |
| `src/lib/data/supabase-store.ts:1607-1662` (`reverseErpJournalEntry`) | `sb.rpc('reverse_journal_entry', { ... })` |
| `src/app/api/commission-payouts/route.ts:55-60` (mark-paid loop) | `sb.rpc('create_commission_payout', { ... })` |
| `src/lib/data/supabase-store.ts:2027-2065` (`autoJournalFromInvoice`) | `sb.rpc('auto_journal_from_invoice', { ... })` |

Until that follow-up is done, the migrations are inert — they add safety nets that the app does not yet use.
