import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, resolveTenantId, audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

// GET /api/erp/bank-transactions — List bank transactions (optional bank_account_id filter)
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (erp.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "erp.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */


  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ items: [], total: 0 });

  try {
    const url = new URL(req.url);
    const bank_account_id = url.searchParams.get("bank_account_id") || undefined;
    const search = url.searchParams.get("search") || undefined;
    // FIX-MARKET-UI / FIX 4 — pagination.
    const limit = url.searchParams.get("limit")
      ? Math.min(Number(url.searchParams.get("limit")), 500)
      : undefined;
    const offset = url.searchParams.get("offset")
      ? Math.max(Number(url.searchParams.get("offset")), 0)
      : undefined;

    const result = await auth.store.listErpBankTransactions(tenantId, bank_account_id, {
      search,
      limit,
      offset,
    });
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/erp/bank-transactions — Create bank transaction (requires admin)
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (erp.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "erp.create"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */


  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) {
    return NextResponse.json({ error: "Tenant ID required." }, { status: 400 });
  }

  try {
    const body = await req.json();
    // FIX-MED-1 / Fix 1 — verify the bank_account_id belongs to the caller's
    // tenant BEFORE creating the transaction. Without this check a user with
    // `erp.create` permission could POST a bank transaction against another
    // tenant's `bank_account_id` (the upsertErpBankTransaction store method
    // stamps `tenant_id` on the *transaction* row but never verifies the
    // referenced `bank_account_id` row — so the FK is satisfied across
    // tenants and the cross-tenant leak goes unnoticed).
    //
    // `getErpBankAccount` is not part of the store interface, so we use a
    // direct Supabase lookup on `erp_bank_accounts(tenant_id)` and require
    // an exact match. The service_role client bypasses RLS — which is the
    // correct behavior here because we're enforcing a tenant boundary at
    // the application layer (the route already gated on `requireAdmin` +
    // `erp.create` + `module_finance` feature gate).
    if (!body.bank_account_id) {
      return NextResponse.json({ error: "bank_account_id is required." }, { status: 400 });
    }
    const { getSupabase } = await import("@/lib/supabase/client");
    const sb = getSupabase();
    const { data: bankAccount, error: baErr } = await sb
      .from("erp_bank_accounts")
      .select("tenant_id")
      .eq("id", body.bank_account_id)
      .maybeSingle();
    if (baErr) {
      console.error("[erp/bank-transactions POST] bank account lookup failed:", baErr);
      return NextResponse.json({ error: "Failed to verify bank account." }, { status: 500 });
    }
    if (!bankAccount || bankAccount.tenant_id !== tenantId) {
      return NextResponse.json(
        { error: "Bank account not found or doesn't belong to your tenant." },
        { status: 403 },
      );
    }

    // ── IDEMPOTENCY (audit 2d2-F17) ───────────────────────────────────
    // A client retrying a POST due to a network glitch can create a
    // DUPLICATE erp_bank_transactions row with identical (bank_account_id,
    // reference, amount, date). The bank ledger then shows 2× the credit;
    // the cumulative-txn lookup in record-payment (migration 071 RPC)
    // sums BOTH → invoice marked "paid" prematurely or double-paid.
    //
    // Migration 073 adds a partial UNIQUE index on
    //   (tenant_id, bank_account_id, reference, amount, date)
    //   WHERE reference IS NOT NULL
    // We catch the unique-violation (PSQL 23505) and return 409 with the
    // existing txn id so the client can treat the duplicate as a
    // successful replay. Idempotency is only enforced when the caller
    // supplies a non-empty `reference` (NULL references would otherwise
    // block legitimate duplicates).
    let created: any;
    try {
      created = await auth.store.upsertErpBankTransaction({ ...body, tenant_id: tenantId });
    } catch (e: any) {
      // PostgREST surfaces the PSQL error code on the error object. The
      // unique-violation code is 23505. We match loosely on the code +
      // the message ("unique" / "duplicate") for defense against the
      // store method's error normalization (it may rethrow with a
      // different shape than the raw PostgREST error).
      const code = String(e?.code || "");
      const msg = String(e?.message || "");
      if (code === "23505" || /unique constraint|duplicate key/i.test(msg)) {
        // Look up the existing row that won the race — return its id so
        // the caller can treat the retry as a successful replay.
        try {
          const { data: existing } = await sb
            .from("erp_bank_transactions")
            .select("id, bank_account_id, amount, date, reference, transaction_type, description, counterparty, is_reconciled, reconciled_with, journal_entry_id, category, deal_id, invoice_number, is_auto_generated, created_at, updated_at")
            .eq("tenant_id", tenantId)
            .eq("bank_account_id", body.bank_account_id)
            .eq("amount", body.amount)
            .eq("date", body.date)
            .eq("reference", body.reference)
            .maybeSingle();
          if (existing) {
            return NextResponse.json(
              { ...existing, idempotent_replay: true },
              { status: 409 },
            );
          }
        } catch (lookupErr: any) {
          console.warn("[erp/bank-transactions POST] idempotency replay lookup failed:", lookupErr.message);
        }
        return NextResponse.json(
          { error: "A bank transaction with the same (bank_account_id, reference, amount, date) already exists.", idempotent_replay: true },
          { status: 409 },
        );
      }
      throw e;
    }
    await audit(auth.store, auth.user, req, "bank_transaction.create", "erp_bank_transaction", created.id, {
      bank_account_id: created.bank_account_id,
      amount: created.amount,
      transaction_type: created.transaction_type,
    });
    return NextResponse.json(created);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
