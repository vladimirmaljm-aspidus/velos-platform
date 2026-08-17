import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/api/helpers";

export const runtime = "nodejs";

// Super-admin: system overview — all tenants, counts, activity
export async function GET(req: NextRequest) {
  try {
    const auth = await requireSuperAdmin(req);
    if (auth instanceof NextResponse) return auth;
    const store = auth.store;

    const [tenants, users, allPartners, allDeals, allOffers, allInvoices, audit] = await Promise.all([
      store.listTenants(),
      store.listUsers(""),
      store.listPartners("", { limit: 1000 }),
      store.listDeals("", { limit: 1000 }),
      store.listOffers("", { limit: 1000 }),
      store.listInvoices("", { limit: 1000 }),
      store.listAudit("", { limit: 50 }),
    ]);

    // Group by tenant
    const tenantStats = tenants.map((t) => ({
      tenant: t,
      partner_count: allPartners.items.filter((p) => p.tenant_id === t.id).length,
      deal_count: allDeals.items.filter((d) => d.tenant_id === t.id).length,
      offer_count: allOffers.items.filter((o) => o.tenant_id === t.id).length,
      invoice_count: allInvoices.items.filter((i) => i.tenant_id === t.id).length,
      user_count: users.filter((u) => u.tenant_id === t.id).length,
    }));

    return NextResponse.json({
      total_tenants: tenants.length,
      total_users: users.length,
      total_partners: allPartners.total,
      total_offers: allOffers.total,
      total_invoices: allInvoices.total,
      active_tenants: tenants.filter((t) => t.status === "active").length,
      tenants: tenantStats,
      recent_activity: audit.items,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
