import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit, sanitizeError } from "@/lib/api/helpers";
import type { FxRevaluationAdjustment } from "@/lib/supabase/types";

export const runtime = "nodejs";

// POST /api/erp/journal-entries/revalue — generate an FX revaluation entry.
//
// Request body:
//   {
//     "reval_date":     "2025-12-31",        // ISO date (required)
//     "base_currency":  "USD",                // optional, defaults to tenant's setting
//     "adjustments":    [                     // optional, can be empty
//       {
//         "account_id":          "<erp_accounts.id>",
//         "currency":            "EUR",
//         "fx_rate_old":         1.10,
//         "fx_rate_new":         1.18,
//         "balance_foreign":     10000.00,
//         "gain_loss_account_id":"<erp_accounts.id>",
//         "description":         "AR reval EUR"
//       }
//     ]
//   }
//
// Response:
//   {
//     "id":               "<new erp_journal_entries.id>",
//     "entry_number":     "REVAL-20251231-0001",
//     "line_count":       2,
//     "total_debit_base":  800.00,
//     "total_credit_base": 800.00
//   }
//
// The created entry is in `draft` status — the user must review the lines
// and post it via POST /api/erp/journal-entries/[id]/post before it affects
// the GL. The entry has `is_revaluation = true` so reports can identify it.
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (erp.create) — revaluation is a write op
  {
    const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "erp.create");
    if (_d) return _d;
  }
  // Feature gate (module_finance)
  {
    const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin);
    if (_f) return _f;
  }

  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) {
    return NextResponse.json({ error: "Tenant ID required." }, { status: 400 });
  }

  try {
    const body = await req.json();
    const revalDate: string | undefined = body?.reval_date;
    if (!revalDate || typeof revalDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(revalDate)) {
      return NextResponse.json(
        { error: "reval_date is required and must be YYYY-MM-DD." },
        { status: 400 },
      );
    }
    // base_currency is optional — fall back to the tenant's erp_settings.default_currency
    let baseCurrency: string | undefined = typeof body?.base_currency === "string" ? body.base_currency : undefined;
    if (!baseCurrency) {
      const settings = await auth.store.getErpSettings(tenantId);
      baseCurrency = settings?.default_currency || "USD";
    }
    // Validate adjustments shape
    const adjustments: FxRevaluationAdjustment[] = Array.isArray(body?.adjustments) ? body.adjustments : [];
    for (const [i, a] of adjustments.entries()) {
      if (!a || typeof a !== "object") {
        return NextResponse.json({ error: `adjustments[${i}] must be an object.` }, { status: 400 });
      }
      if (!a.account_id || typeof a.account_id !== "string") {
        return NextResponse.json({ error: `adjustments[${i}].account_id is required.` }, { status: 400 });
      }
      if (!a.gain_loss_account_id || typeof a.gain_loss_account_id !== "string") {
        return NextResponse.json({ error: `adjustments[${i}].gain_loss_account_id is required.` }, { status: 400 });
      }
      if (!a.currency || typeof a.currency !== "string") {
        return NextResponse.json({ error: `adjustments[${i}].currency is required.` }, { status: 400 });
      }
      const rOld = Number(a.fx_rate_old);
      const rNew = Number(a.fx_rate_new);
      const bal = Number(a.balance_foreign);
      if (!Number.isFinite(rOld) || rOld <= 0) {
        return NextResponse.json({ error: `adjustments[${i}].fx_rate_old must be a positive number.` }, { status: 400 });
      }
      if (!Number.isFinite(rNew) || rNew <= 0) {
        return NextResponse.json({ error: `adjustments[${i}].fx_rate_new must be a positive number.` }, { status: 400 });
      }
      if (!Number.isFinite(bal)) {
        return NextResponse.json({ error: `adjustments[${i}].balance_foreign must be a number.` }, { status: 400 });
      }
      a.fx_rate_old = rOld;
      a.fx_rate_new = rNew;
      a.balance_foreign = bal;
    }

    // E-8-style fiscal-period gate: refuse to create a revaluation entry
    // dated inside a closed fiscal period. The store-level
    // postErpJournalEntry enforces this at post-time, but blocking at
    // creation time prevents the user from drafting a revaluation they
    // can never post.
    {
      const { getSupabase } = await import("@/lib/supabase/client");
      const { data: period, error: periodErr } = await getSupabase()
        .from("fiscal_periods")
        .select("id, status")
        .eq("tenant_id", tenantId)
        .lte("start_date", revalDate)
        .gte("end_date", revalDate)
        .maybeSingle();
      if (periodErr) {
        return NextResponse.json(
          { error: `Failed to validate fiscal period: ${periodErr.message}` },
          { status: 500 },
        );
      }
      if (period && period.status === "closed") {
        return NextResponse.json(
          { error: "Cannot create a revaluation entry in a closed fiscal period." },
          { status: 409 },
        );
      }
    }

    const result = await auth.store.createFxRevaluation(
      tenantId,
      revalDate,
      baseCurrency,
      adjustments,
      auth.user.id,
    );
    await audit(auth.store, auth.user, req, "journal_entry.fx_revaluation", "erp_journal_entry", result.id, {
      entry_number: result.entry_number,
      reval_date: revalDate,
      base_currency: baseCurrency,
      adjustment_count: adjustments.length,
      total_debit_base: result.total_debit_base,
      total_credit_base: result.total_credit_base,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
