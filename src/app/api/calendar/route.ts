import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * GET /api/calendar?from=2026-01-01&to=2026-12-31
 *
 * Returns calendar events: tasks with due dates, invoices with due dates,
 * deals with expected close dates, offers with valid_until.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (calendar.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "calendar.read"); if (_d) return _d; } /* requirePermission wired */

  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ items: [] });

  const url = new URL(req.url);
  const from = url.searchParams.get("from") || new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
  const to = url.searchParams.get("to") || new Date(Date.now() + 90 * 86400000).toISOString().split("T")[0];

  const events: Array<{
    id: string;
    type: "task" | "invoice" | "deal" | "offer";
    title: string;
    date: string;
    status?: string;
    amount?: number;
    currency?: string;
    entity_id: string;
    color: string;
  }> = [];

  // Tasks with due dates
  try {
    const tasks = await auth.store.listTasks(tenantId);
    for (const t of tasks) {
      if (t.due_date && t.due_date >= from && t.due_date <= to) {
        events.push({
          id: `task-${t.id}`,
          type: "task",
          title: t.title,
          date: t.due_date,
          status: t.done ? "done" : ((t as any).status || "todo"),
          entity_id: t.id,
          color: t.done ? "#22c55e" : (t.priority === "urgent" ? "#ef4444" : t.priority === "high" ? "#f59e0b" : "#3b82f6"),
        });
      }
    }
  } catch {}

  // Invoices with due dates
  try {
    const invoices = await auth.store.listInvoices(tenantId, { limit: 1000 });
    for (const inv of invoices.items) {
      if (inv.due_date && inv.due_date >= from && inv.due_date <= to) {
        events.push({
          id: `invoice-${inv.id}`,
          type: "invoice",
          title: `Invoice ${inv.number}`,
          date: inv.due_date,
          status: inv.status,
          amount: inv.total,
          currency: inv.currency,
          entity_id: inv.id,
          color: inv.status === "paid" ? "#22c55e" : inv.status === "overdue" ? "#ef4444" : "#f59e0b",
        });
      }
    }
  } catch {}

  // Deals with expected close dates
  try {
    const deals = await auth.store.listDeals(tenantId, { limit: 1000 });
    for (const d of deals.items) {
      if (d.expected_close && d.expected_close >= from && d.expected_close <= to) {
        events.push({
          id: `deal-${d.id}`,
          type: "deal",
          title: d.title,
          date: d.expected_close,
          status: d.stage,
          amount: d.value,
          currency: d.currency,
          entity_id: d.id,
          color: d.stage === "won" ? "#22c55e" : d.stage === "lost" ? "#ef4444" : "#8b5cf6",
        });
      }
    }
  } catch {}

  // Offers with valid_until
  try {
    const offers = await auth.store.listOffers(tenantId, { limit: 1000 });
    for (const o of offers.items) {
      if (o.valid_until && o.valid_until >= from && o.valid_until <= to) {
        events.push({
          id: `offer-${o.id}`,
          type: "offer",
          title: `Offer ${o.number}`,
          date: o.valid_until,
          status: o.status,
          amount: o.total,
          currency: o.currency,
          entity_id: o.id,
          color: o.status === "accepted" ? "#22c55e" : o.status === "expired" ? "#ef4444" : "#06b6d4",
        });
      }
    }
  } catch {}

  // Sort by date
  events.sort((a, b) => a.date.localeCompare(b.date));

  return NextResponse.json({ items: events, from, to });
}
