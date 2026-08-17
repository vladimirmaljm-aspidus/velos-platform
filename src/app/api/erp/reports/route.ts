import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId } from "@/lib/api/helpers";

export const runtime = "nodejs";

// GET /api/erp/reports — Get financial reports
// Query params:
//   type=trial_balance&as_of_date=2025-12-31
//   type=balance_sheet&as_of_date=2025-12-31
//   type=profit_and_loss&period_start=2025-01-01&period_end=2025-12-31
//   type=general_ledger&account_id=xxx&date_from=2025-01-01&date_to=2025-12-31
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
    const type = url.searchParams.get("type");

    if (!type) {
      return NextResponse.json({ error: "Report type is required. Use: trial_balance, balance_sheet, profit_and_loss, general_ledger" }, { status: 400 });
    }

    switch (type) {
      case "trial_balance": {
        const asOfDate = url.searchParams.get("as_of_date");
        if (!asOfDate) {
          return NextResponse.json({ error: "as_of_date is required for trial balance." }, { status: 400 });
        }
        const report = await auth.store.getTrialBalance(tenantId, asOfDate);
        return NextResponse.json(report);
      }

      case "balance_sheet": {
        const asOfDate = url.searchParams.get("as_of_date");
        if (!asOfDate) {
          return NextResponse.json({ error: "as_of_date is required for balance sheet." }, { status: 400 });
        }
        const report = await auth.store.getBalanceSheet(tenantId, asOfDate);
        return NextResponse.json(report);
      }

      case "profit_and_loss": {
        const periodStart = url.searchParams.get("period_start");
        const periodEnd = url.searchParams.get("period_end");
        if (!periodStart || !periodEnd) {
          return NextResponse.json({ error: "period_start and period_end are required for profit and loss." }, { status: 400 });
        }
        const report = await auth.store.getProfitAndLoss(tenantId, periodStart, periodEnd);
        return NextResponse.json(report);
      }

      case "general_ledger": {
        const accountId = url.searchParams.get("account_id");
        if (!accountId) {
          return NextResponse.json({ error: "account_id is required for general ledger." }, { status: 400 });
        }
        const dateFrom = url.searchParams.get("date_from") || undefined;
        const dateTo = url.searchParams.get("date_to") || undefined;
        const report = await auth.store.getGeneralLedger(tenantId, accountId, dateFrom, dateTo);
        return NextResponse.json(report);
      }

      default:
        return NextResponse.json({ error: `Unknown report type: ${type}. Use: trial_balance, balance_sheet, profit_and_loss, general_ledger` }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
