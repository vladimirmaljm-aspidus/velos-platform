import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * POST /api/automation/create-deal-from-demand
 *
 * Auto-create a deal from a CRM demand. Bridges the Demand (request-for-
 * quote intent) → Deal (sell-side opportunity) hand-off so operators don't
 * have to re-key the partner / product / quantity / target price into the
 * Deals view manually.
 *
 * Body: `{ demand_id: string }`
 *
 * Behaviour:
 *   1. Loads the demand (with tenant ownership check).
 *   2. Builds a Deal payload:
 *        - title: "Deal: " + demand.product_name (falls back to demand.subject)
 *        - partner_id: demand.partner_id (if set; otherwise null)
 *        - product_id: demand.product_id (if set)
 *        - quantity: sum of demand.items[].quantity, or 1 if no items
 *        - unit: first demand.items[].unit, or "pcs" fallback
 *        - selling_price / value: demand.target_price (if set)
 *        - currency: demand.currency
 *        - stage: "lead"  (DealStage has no "draft" — "lead" is the entry
 *          stage of the CRM pipeline; the task spec said "draft" which is
 *          the equivalent concept on the demand side)
 *        - description: demand.subject + description
 *   3. Inserts the deal via `upsertDeal` (the same store method
 *      `/api/deals` POST uses, so the required-field defaults are applied
 *      consistently — see deals/route.ts F-FINAL/P1).
 *   4. Marks the demand as "quoted" — the standard CRM "we've responded"
 *      status. The task spec allowed "quoted" OR "closed"; we pick
 *      "quoted" because the deal may not be won yet — closing the demand
 *      prematurely would hide it from the open-demands funnel.
 *   5. Returns the new deal.
 *
 * Permissions: requires `deals.create` (mirrors `/api/deals` POST gate).
 * Feature gate: `module_crm` (same as `/api/deals` POST).
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;

    // Permission gate (deals.create) — mirrors /api/deals POST.
    {
      const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "deals.create");
      if (_d) return _d;
    }
    // Feature gate (module_crm).
    {
      const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_crm", auth.isSuperAdmin);
      if (_f) return _f;
    }

    const tid = resolveTenantId(auth, req);
    if (!tid) {
      return NextResponse.json({ error: "No tenant context." }, { status: 400 });
    }

    let body: { demand_id?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const { demand_id } = body;
    if (!demand_id) {
      return NextResponse.json({ error: "demand_id is required." }, { status: 400 });
    }

    const store = auth.store;

    // 1. Load the demand (with tenant ownership check). A 404 for a
    //    cross-tenant demand is the same shape as a 404 for a missing one —
    //    no enumeration leak (matches /api/demands/[id] GET pattern).
    const demand = await store.getDemand(demand_id);
    if (!demand) {
      return NextResponse.json({ error: "Demand not found." }, { status: 404 });
    }
    if (!auth.isSuperAdmin && demand.tenant_id !== tid) {
      return NextResponse.json({ error: "Demand not found." }, { status: 404 });
    }

    // 2. Build the deal payload. The deals table has 4 NOT NULL columns
    //    (probability, buy_cost, quantity, unit) — `upsertDeal` calls
    //    `smartUpsert` which passes whatever we give it, so we set sane
    //    defaults here too (mirrors /api/deals POST F-FINAL defaults).
    const items = Array.isArray(demand.items) ? demand.items : [];
    const totalQuantity = items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
    const firstItem = items[0];
    const dealTitle = `Deal: ${demand.product_name || demand.subject || demand.number || "Untitled"}`;

    const dealPayload: Record<string, unknown> = {
      tenant_id: tid,
      title: dealTitle,
      partner_id: demand.partner_id || null,
      owner_id: auth.user.id,
      stage: "lead", // DealStage: lead | qualified | proposal | negotiation | won | lost
      currency: demand.currency || "EUR",
      probability: 0,
      buy_cost: 0,
      quantity: totalQuantity > 0 ? totalQuantity : 1,
      unit: firstItem?.unit || "pcs",
      value: Number(demand.target_price) || 0,
      // Trade / import fields carried over from the demand.
      product_id: demand.product_id || null,
      selling_price: demand.target_price != null ? Number(demand.target_price) : null,
      description: [
        demand.subject,
        demand.description,
      ].filter(Boolean).join(" — ") || null,
      // Carrying buyer_id over so the partner 360 view links the deal to the
      // same buyer as the originating demand.
      buyer_id: demand.buyer_id || null,
      delivery_location: demand.destination || null,
      delivery_date: demand.needed_by || null,
      payment_account_id: null,
      incoterm: null,
      // Useful provenance: keep the demand's number in the deal's notes so
      // an operator viewing the deal can jump back to the original demand.
      documents: [`demand:${demand.number || demand.id}`],
    };

    // 3. Insert the deal. `upsertDeal` → `smartUpsert` handles the INSERT
    //    path (no `id` supplied → INSERT).
    const created = await store.upsertDeal(dealPayload as any);

    // 4. Mark the demand as "quoted" so it leaves the open funnel. The
    //    operator can still flip it to "closed" once the deal reaches "won".
    try {
      await store.upsertDemand({
        id: demand.id,
        tenant_id: demand.tenant_id,
        status: "quoted",
      });
    } catch (markErr) {
      // Marking the demand is best-effort — the deal was already created.
      // Don't roll back the deal; just log the failure.
      console.error("[automation/create-deal-from-demand] mark demand failed", markErr);
    }

    // 5. Audit log.
    await audit(
      store,
      auth.user,
      req,
      "automation.create_deal_from_demand",
      "deal",
      created.id,
      {
        demand_id: demand.id,
        demand_number: demand.number,
        deal_title: created.title,
        partner_id: created.partner_id,
      },
    );

    return NextResponse.json(created);
  } catch (error: any) {
    console.error("[automation/create-deal-from-demand]", error);
    return NextResponse.json(
      { error: sanitizeError(error) },
      { status: 500 },
    );
  }
}
