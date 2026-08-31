import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

// Super-admin: system overview — all tenants, counts, activity
//
// 9b-N10 — previously this route issued 4 "list-all-tenants" queries
// (listPartners / listDeals / listOffers / listInvoices with
// `{ limit: 1000 }`) and then did an in-memory `filter(p => p.tenant_id
// === t.id)` for each of N tenants — O(N²) memory + CPU. Worse, the
// 1000-row cap SILENTLY TRUNCATED: a platform with 1,247 partners saw
// only the first 1000 in the overview counts, with no error and no
// indication that the number was a floor rather than the truth. The
// super-admin dashboard could report "1,000 partners" when the actual
// count was 1,247 — a false KPI for the platform operator.
//
// FIX: per-tenant head-only count queries. For each tenant we call
// `listPartners(t.id, { limit: 1 })` etc. The store's `paginateQuery`
// (supabase-store.ts:86) always sets `count: "exact"` on the underlying
// PostgREST `.select("*", { count: "exact" })`, so even with `limit: 1`
// only ONE row is transferred but `total` reflects the true COUNT(*)
// for that tenant. 4N requests instead of 4 + N², and the silent
// truncation is gone.
//
// `listUsers` is left in-memory because it does NOT paginate — it
// returns the full user list (typically small: a few hundred at most
// even on large deployments). The per-tenant filter for users is O(N×U)
// in memory, which is acceptable.
//
// Global totals are now computed as Σ per-tenant counts (instead of
// `.total` from the truncated 1000-row queries). This is compatible
// with the FK constraint that requires every entity row to reference a
// `tenants(id)` row — there are no orphan rows whose tenant was
// deleted, so summing per-tenant counts is equivalent to COUNT(*) on
// the table.
export async function GET(req: NextRequest) {
  try {
    const auth = await requireSuperAdmin(req);
    if (auth instanceof NextResponse) return auth;
    const store = auth.store;

    // 9b-N10: listTenants + listUsers (no truncation) + listAudit are
    // queried ONCE in parallel with the per-tenant count fan-out. The
    // per-tenant counts are themselves parallelised via Promise.all.
    const [tenants, users, audit] = await Promise.all([
      store.listTenants(),
      store.listUsers(""),
      store.listAudit("", { limit: 50 }),
    ]);

    const perTenantCounts = await Promise.all(
      tenants.map(async (t) => {
        // 4N head-only count queries. Each listX call uses
        // `paginateQuery` which sets `count: "exact"` — the returned
        // `total` is the true COUNT(*) for this tenant even though only
        // 1 row (or 0 if the tenant has no rows) is materialised.
        const [partners, deals, offers, invoices] = await Promise.all([
          store.listPartners(t.id, { limit: 1 }),
          store.listDeals(t.id, { limit: 1 }),
          store.listOffers(t.id, { limit: 1 }),
          store.listInvoices(t.id, { limit: 1 }),
        ]);
        return {
          tenantId: t.id,
          partner_count: partners.total,
          deal_count: deals.total,
          offer_count: offers.total,
          invoice_count: invoices.total,
          // Users: listUsers does NOT truncate (no limit param), so the
          // in-memory filter is safe here.
          user_count: users.filter((u) => u.tenant_id === t.id).length,
        };
      }),
    );

    // Build per-tenant stats with the original tenant object.
    const tenantStats = tenants.map((t, i) => {
      const c = perTenantCounts[i];
      return {
        tenant: t,
        partner_count: c.partner_count,
        deal_count: c.deal_count,
        offer_count: c.offer_count,
        invoice_count: c.invoice_count,
        user_count: c.user_count,
      };
    });

    // Global totals = Σ per-tenant counts. (See FK note above — this is
    // equivalent to COUNT(*) on each table; no orphan rows exist.)
    const totals = perTenantCounts.reduce(
      (acc, c) => {
        acc.partners += c.partner_count;
        acc.deals += c.deal_count;
        acc.offers += c.offer_count;
        acc.invoices += c.invoice_count;
        return acc;
      },
      { partners: 0, deals: 0, offers: 0, invoices: 0 },
    );

    return NextResponse.json({
      total_tenants: tenants.length,
      total_users: users.length,
      total_partners: totals.partners,
      total_offers: totals.offers,
      total_invoices: totals.invoices,
      active_tenants: tenants.filter((t) => t.status === "active").length,
      tenants: tenantStats,
      recent_activity: audit.items,
    });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}
