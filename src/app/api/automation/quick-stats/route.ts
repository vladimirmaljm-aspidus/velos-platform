import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * GET /api/automation/quick-stats?tenant_id=xxx&user_id=xxx
 *
 * Return quick dashboard stats for the current user's tenant:
 * - Active deals count
 * - Pending offers count
 * - Overdue invoices count
 * - Unread notifications count
 * - Recent activity (last 5 audit logs)
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (dashboard.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "dashboard.read"); if (_d) return _d; } /* requirePermission wired */


  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ items: [], total: 0 });

  const url = new URL(req.url);
  const userId = url.searchParams.get("user_id") || auth.user.id;

  try {
    const store = auth.store;

    // 1. Active deals count (not won or lost)
    const allDeals = await store.listDeals(tenantId, { limit: 1000 });
    const activeDeals = allDeals.items.filter(
      (d) => d.stage !== "won" && d.stage !== "lost"
    );

    // 2. Pending offers count (draft or sent)
    const allOffers = await store.listOffers(tenantId, { limit: 1000 });
    const pendingOffers = allOffers.items.filter(
      (o) => o.status === "draft" || o.status === "sent"
    );

    // 3. Overdue invoices count
    const allInvoices = await store.listInvoices(tenantId, { limit: 1000 });
    const now = new Date();
    const overdueInvoices = allInvoices.items.filter((inv) => {
      if (inv.status === "paid" || inv.status === "cancelled") return false;
      const dueDate = new Date(inv.due_date);
      return dueDate < now;
    });

    // 4. Unread notifications count
    const unreadCount = await store.getUnreadCount(tenantId, userId);

    // 5. Recent activity (last 5 audit logs)
    const recentAudit = await store.listAudit(tenantId, { limit: 5 });

    // 6. Additional useful stats
    const activeDealsValue = activeDeals.reduce((sum, d) => sum + d.value, 0);
    const pendingOffersValue = pendingOffers.reduce((sum, o) => sum + o.total, 0);
    const overdueInvoicesValue = overdueInvoices.reduce((sum, i) => sum + i.total, 0);

    // 7. Deals by stage
    const dealsByStage: Record<string, number> = {};
    for (const d of allDeals.items) {
      dealsByStage[d.stage] = (dealsByStage[d.stage] || 0) + 1;
    }

    // 8. Offers by status
    const offersByStatus: Record<string, number> = {};
    for (const o of allOffers.items) {
      offersByStatus[o.status] = (offersByStatus[o.status] || 0) + 1;
    }

    // 9. Invoices by status
    const invoicesByStatus: Record<string, number> = {};
    for (const i of allInvoices.items) {
      invoicesByStatus[i.status] = (invoicesByStatus[i.status] || 0) + 1;
    }

    return NextResponse.json({
      activeDealsCount: activeDeals.length,
      activeDealsValue,
      pendingOffersCount: pendingOffers.length,
      pendingOffersValue,
      overdueInvoicesCount: overdueInvoices.length,
      overdueInvoicesValue,
      unreadNotificationsCount: unreadCount,
      recentActivity: recentAudit.items,
      dealsByStage,
      offersByStatus,
      invoicesByStatus,
    });
  } catch (e) {
    console.error("[automation/quick-stats]", e);
    return NextResponse.json(
      { error: "Failed to load quick stats." },
      { status: 500 }
    );
  }
}
