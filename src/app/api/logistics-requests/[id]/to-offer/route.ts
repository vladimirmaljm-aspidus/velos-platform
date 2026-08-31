import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

/**
 * POST /api/logistics-requests/[id]/to-offer
 * Convert a logistics request into an Offer draft, then link it back on the
 * logistics row via `linked_offer_id` and flip status to "quoted".
 * The admin can then edit / send the offer through the normal Offers UI.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "logistics.convert"); if (_d) return _d; }
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d2 = requirePermission(auth, "offers.create"); if (_d2) return _d2; }

    const { id } = await params;
    const sb = getSupabase();
    const { data: lr } = await sb.from("logistics_requests").select("*").eq("id", id).maybeSingle();
    if (!lr) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && lr.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (lr.linked_offer_id) {
      return NextResponse.json({ error: "This request is already linked to an offer.", offer_id: lr.linked_offer_id }, { status: 409 });
    }

    const price = Number(lr.quoted_price || 0);
    const currency = lr.quoted_currency || lr.cargo_currency || "USD";
    const modeLabel = (lr.mode || "shipment").replace(/_/g, " ").toUpperCase();
    const route = `${lr.origin_city || lr.origin_country || "?"} → ${lr.destination_city || lr.destination_country || "?"}`;
    const subject = `Freight quote — ${modeLabel} · ${route} (${lr.number})`;

    const offer = await auth.store.upsertOffer({
      tenant_id: lr.tenant_id,
      partner_id: lr.partner_id,
      owner_id: auth.user.id,
      status: "draft",
      currency,
      subject,
      notes: [
        `Freight quote generated from logistics request ${lr.number}.`,
        lr.quoted_notes ? `Notes: ${lr.quoted_notes}` : "",
        lr.quoted_transit_days ? `Estimated transit: ${lr.quoted_transit_days} days.` : "",
        lr.incoterm ? `Incoterm: ${lr.incoterm}.` : "",
      ].filter(Boolean).join("\n"),
      items: [{
        description: `${modeLabel} freight — ${route}${lr.container_type ? ` · ${lr.container_type}` : ""}`,
        quantity: 1,
        unit_price: price,
        discount: 0,
        tax_rate: 0,
        total: price,
      }],
      subtotal: price,
      discount_total: 0,
      tax_total: 0,
      total: price,
    } as any);

    // Link it back and flip status to "quoted"
    await sb.from("logistics_requests").update({
      linked_offer_id: (offer as any).id,
      status: "quoted",
      updated_at: new Date().toISOString(),
    }).eq("id", id);

    await audit(auth.store, auth.user, req, "logistics.to_offer", "logistics_request", id, {
      offer_id: (offer as any).id, price, currency,
    });

    try {
      const { logLogisticsEvent } = await import("@/lib/logistics/events");
      await logLogisticsEvent({
        tenant_id: lr.tenant_id,
        logistics_request_id: id,
        event_type: "converted_to_offer",
        from_status: lr.status,
        to_status: "quoted",
        actor_id: auth.user.id,
        actor_role: "admin",
        message: `Converted to Offer (price ${currency} ${price})`,
        metadata: { offer_id: (offer as any).id, price, currency },
      });
    } catch { /* non-critical */ }

    return NextResponse.json({ ok: true, offer_id: (offer as any).id });
  } catch (e: any) {
    console.error("[logistics.to-offer.POST]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}
