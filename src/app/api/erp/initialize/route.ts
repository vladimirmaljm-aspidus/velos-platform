import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, resolveTenantId, audit } from "@/lib/api/helpers";
import type { ErpAccount } from "@/lib/supabase/types";

export const runtime = "nodejs";

// EU standard chart of accounts (simplified PCG/MNC equivalent)
const EU_ACCOUNTS = [
  { code: "1000", name: "Share Capital", name_en: "Share Capital", account_type: "equity", account_category: "share_capital", is_system: true },
  { code: "1100", name: "Retained Earnings", name_en: "Retained Earnings", account_type: "equity", account_category: "retained_earnings", is_system: true },
  { code: "1200", name: "Current Year Earnings", name_en: "Current Year Earnings", account_type: "equity", account_category: "current_earnings", is_system: true },
  { code: "2000", name: "Accounts Receivable", name_en: "Accounts Receivable", account_type: "asset", account_category: "current_asset", is_system: true },
  { code: "2100", name: "Cash", name_en: "Cash", account_type: "asset", account_category: "current_asset", is_system: true },
  { code: "2200", name: "Bank", name_en: "Bank", account_type: "asset", account_category: "current_asset", is_system: true },
  { code: "2300", name: "Inventory", name_en: "Inventory", account_type: "asset", account_category: "current_asset", is_system: true },
  { code: "2400", name: "Prepaid Expenses", name_en: "Prepaid Expenses", account_type: "asset", account_category: "current_asset", is_system: true },
  { code: "2500", name: "Fixed Assets", name_en: "Fixed Assets", account_type: "asset", account_category: "fixed_asset", is_system: true },
  { code: "3000", name: "Accounts Payable", name_en: "Accounts Payable", account_type: "liability", account_category: "current_liability", is_system: true },
  { code: "3100", name: "Accrued Expenses", name_en: "Accrued Expenses", account_type: "liability", account_category: "current_liability", is_system: true },
  { code: "3200", name: "VAT Payable", name_en: "VAT Payable", account_type: "liability", account_category: "current_liability", is_system: true },
  { code: "3300", name: "Long-term Liabilities", name_en: "Long-term Liabilities", account_type: "liability", account_category: "long_term_liability", is_system: true },
  { code: "4000", name: "Sales Revenue", name_en: "Sales Revenue", account_type: "revenue", account_category: "operating_revenue", is_system: true },
  { code: "4100", name: "Other Revenue", name_en: "Other Revenue", account_type: "revenue", account_category: "other_revenue", is_system: true },
  { code: "5000", name: "Cost of Goods Sold", name_en: "Cost of Goods Sold", account_type: "expense", account_category: "cost_of_sales", is_system: true },
  { code: "5100", name: "Salaries & Wages", name_en: "Salaries & Wages", account_type: "expense", account_category: "operating_expense", is_system: true },
  { code: "5200", name: "Rent Expense", name_en: "Rent Expense", account_type: "expense", account_category: "operating_expense", is_system: true },
  { code: "5300", name: "Utilities Expense", name_en: "Utilities Expense", account_type: "expense", account_category: "operating_expense", is_system: true },
  { code: "5400", name: "Office Supplies", name_en: "Office Supplies", account_type: "expense", account_category: "operating_expense", is_system: true },
  { code: "5500", name: "Travel Expense", name_en: "Travel Expense", account_type: "expense", account_category: "operating_expense", is_system: true },
  { code: "5600", name: "Bank Charges", name_en: "Bank Charges", account_type: "expense", account_category: "operating_expense", is_system: true },
  { code: "5700", name: "Depreciation Expense", name_en: "Depreciation Expense", account_type: "expense", account_category: "operating_expense", is_system: true },
  { code: "5800", name: "VAT Expense", name_en: "VAT Expense", account_type: "expense", account_category: "tax", is_system: true },
  { code: "5900", name: "Retention", name_en: "Retention", account_type: "liability", account_category: "current_liability", is_system: true },
  { code: "5950", name: "Round Off", name_en: "Round Off", account_type: "expense", account_category: "other_expense", is_system: true },
];

// UAE standard chart of accounts (IFRS-based)
const UAE_ACCOUNTS = [
  { code: "1000", name: "Share Capital", name_en: "Share Capital", account_type: "equity", account_category: "share_capital", is_system: true },
  { code: "1100", name: "Retained Earnings", name_en: "Retained Earnings", account_type: "equity", account_category: "retained_earnings", is_system: true },
  { code: "1200", name: "Current Year Earnings", name_en: "Current Year Earnings", account_type: "equity", account_category: "current_earnings", is_system: true },
  { code: "1300", name: "Statutory Reserve", name_en: "Statutory Reserve", account_type: "equity", account_category: "reserve", is_system: true },
  { code: "2000", name: "Accounts Receivable", name_en: "Accounts Receivable", account_type: "asset", account_category: "current_asset", is_system: true },
  { code: "2100", name: "Cash & Cash Equivalents", name_en: "Cash & Cash Equivalents", account_type: "asset", account_category: "current_asset", is_system: true },
  { code: "2200", name: "Bank", name_en: "Bank", account_type: "asset", account_category: "current_asset", is_system: true },
  { code: "2300", name: "Inventory", name_en: "Inventory", account_type: "asset", account_category: "current_asset", is_system: true },
  { code: "2400", name: "Prepayments", name_en: "Prepayments", account_type: "asset", account_category: "current_asset", is_system: true },
  { code: "2500", name: "Property, Plant & Equipment", name_en: "Property, Plant & Equipment", account_type: "asset", account_category: "fixed_asset", is_system: true },
  { code: "2600", name: "Intangible Assets", name_en: "Intangible Assets", account_type: "asset", account_category: "intangible_asset", is_system: true },
  { code: "3000", name: "Accounts Payable", name_en: "Accounts Payable", account_type: "liability", account_category: "current_liability", is_system: true },
  { code: "3100", name: "Accrued Liabilities", name_en: "Accrued Liabilities", account_type: "liability", account_category: "current_liability", is_system: true },
  { code: "3200", name: "VAT Payable", name_en: "VAT Payable", account_type: "liability", account_category: "current_liability", is_system: true },
  { code: "3300", name: "Non-current Liabilities", name_en: "Non-current Liabilities", account_type: "liability", account_category: "long_term_liability", is_system: true },
  { code: "4000", name: "Revenue from Sales", name_en: "Revenue from Sales", account_type: "revenue", account_category: "operating_revenue", is_system: true },
  { code: "4100", name: "Other Income", name_en: "Other Income", account_type: "revenue", account_category: "other_revenue", is_system: true },
  { code: "5000", name: "Cost of Sales", name_en: "Cost of Sales", account_type: "expense", account_category: "cost_of_sales", is_system: true },
  { code: "5100", name: "Employee Benefits Expense", name_en: "Employee Benefits Expense", account_type: "expense", account_category: "operating_expense", is_system: true },
  { code: "5200", name: "Rent & Lease Expense", name_en: "Rent & Lease Expense", account_type: "expense", account_category: "operating_expense", is_system: true },
  { code: "5300", name: "Utilities Expense", name_en: "Utilities Expense", account_type: "expense", account_category: "operating_expense", is_system: true },
  { code: "5400", name: "General & Administrative", name_en: "General & Administrative", account_type: "expense", account_category: "operating_expense", is_system: true },
  { code: "5500", name: "Travel & Entertainment", name_en: "Travel & Entertainment", account_type: "expense", account_category: "operating_expense", is_system: true },
  { code: "5600", name: "Bank Charges", name_en: "Bank Charges", account_type: "expense", account_category: "operating_expense", is_system: true },
  { code: "5700", name: "Depreciation", name_en: "Depreciation", account_type: "expense", account_category: "operating_expense", is_system: true },
  { code: "5800", name: "VAT Expense", name_en: "VAT Expense", account_type: "expense", account_category: "tax", is_system: true },
  { code: "5900", name: "Retention", name_en: "Retention", account_type: "liability", account_category: "current_liability", is_system: true },
  { code: "5950", name: "Round Off", name_en: "Round Off", account_type: "expense", account_category: "other_expense", is_system: true },
];

// POST /api/erp/initialize — Initialize ERP with default chart of accounts
// Body: { standard: "eu" | "uae", tenant_id?: string }
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
    const standard = body.standard || "eu";

    if (standard !== "eu" && standard !== "uae") {
      return NextResponse.json({ error: "Standard must be 'eu' or 'uae'." }, { status: 400 });
    }

    const accounts = standard === "eu" ? EU_ACCOUNTS : UAE_ACCOUNTS;
    const createdAccounts: ErpAccount[] = [];

    for (const account of accounts) {
      const created = await auth.store.upsertErpAccount({
        ...account,
        tenant_id: tenantId,
        standard,
        is_active: true,
      });
      createdAccounts.push(created);
    }

    // Create default ERP settings
    const settings = await auth.store.upsertErpSettings({
      tenant_id: tenantId,
      accounting_standard: standard,
      fiscal_year_start: standard === "uae" ? "01-01" : "01-01",
      fiscal_year_end: standard === "uae" ? "12-31" : "12-31",
      default_currency: standard === "uae" ? "AED" : "EUR",
      vat_enabled: true,
      vat_rate: standard === "uae" ? 5 : 20,
      vat_return_period: "quarterly",
      auto_post_journal: false,
      revenue_account_id: createdAccounts.find((a) => a.code === "4000")?.id || null,
      expense_account_id: createdAccounts.find((a) => a.code === "5000")?.id || null,
      receivable_account_id: createdAccounts.find((a) => a.code === "2000")?.id || null,
      payable_account_id: createdAccounts.find((a) => a.code === "3000")?.id || null,
      vat_account_id: createdAccounts.find((a) => a.code === "3200")?.id || null,
      bank_charges_account_id: createdAccounts.find((a) => a.code === "5600")?.id || null,
      cash_account_id: createdAccounts.find((a) => a.code === "2100")?.id || null,
      retention_account_id: createdAccounts.find((a) => a.code === "5900")?.id || null,
      round_off_account_id: createdAccounts.find((a) => a.code === "5950")?.id || null,
    });

    await audit(auth.store, auth.user, req, "erp.initialize", "erp_setting", settings.id, {
      standard,
      accounts_created: createdAccounts.length,
    });

    return NextResponse.json({
      standard,
      accounts_created: createdAccounts.length,
      settings,
      accounts: createdAccounts,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
