import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import {
  getShipmentIfAuthorised,
  sanitisePublicShipment,
  updateShipment,
} from "@/lib/data/marketplace-logistics-store";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { triggerWebhooks } from "@/lib/webhooks/deliver";
import { withApm } from "@/lib/monitoring/apm";
import type { ContainerType, ShipmentStatus } from "@/lib/supabase/marketplace-logistics-types";

export const runtime = "nodejs";

// GET /api/marketplace/shipments/[id] — fetch a shipment + its tracking events.
// Auth: booking partner, post owner, or negotiation party (see store).
async function _get(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const auth = await getShipmentIfAuthorised(id, access.tenant_id, access.partner_id);
    if (!auth) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    // Booking partner sees the full row; others get the sanitised shape
    // (partner_id stripped so the booking partner's exact internal id does
    // not leak).
    const shipmentShape = auth.is_booking_partner
      ? (auth.shipment as unknown as Record<string, unknown>)
      : sanitisePublicShipment(auth.shipment);

    // Fetch the events for the timeline (one extra round-trip — kept
    // separate from the auth check so the auth check stays simple).
    const events = await (async () => {
      const sb = (await import("@/lib/supabase/client")).getSupabase();
      const { data, error } = await sb
        .from("marketplace_shipment_events")
        .select("*")
        .eq("shipment_id", id)
        .order("event_date", { ascending: true });
      if (error) throw error;
      return data || [];
    })();

    return NextResponse.json({
      shipment: shipmentShape,
      events,
      is_booking_partner: auth.is_booking_partner,
    });
  } catch (e: any) {
    console.error("[marketplace.shipments.get]", e);
    return NextResponse.json({ error: "Failed to load shipment." }, { status: 500 });
  }
}

// PUT /api/marketplace/shipments/[id] — update a shipment. Booking partner
// only (the store filters by tenant_id + partner_id).
async function _put(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Validate fields when supplied.
  const allowedContainerTypes: ContainerType[] = [
    "20gp", "40gp", "40hc", "40ot", "40fr", "lcl", "bulk", "tank",
  ];
  if (body.container_type !== undefined && body.container_type !== null && !allowedContainerTypes.includes(body.container_type)) {
    return NextResponse.json({ error: "Invalid container_type." }, { status: 400 });
  }
  const allowedStatuses: ShipmentStatus[] = [
    "pending", "booked", "loading", "in_transit",
    "arrived_port", "customs", "delivered", "delayed", "cancelled",
  ];
  if (body.status !== undefined && body.status !== null && !allowedStatuses.includes(body.status)) {
    return NextResponse.json({ error: "Invalid status." }, { status: 400 });
  }
  for (const k of ["gross_weight", "net_weight", "volume", "packages_count"] as const) {
    const v = body[k];
    if (v !== undefined && v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
      return NextResponse.json({ error: `${k} must be a non-negative number.` }, { status: 400 });
    }
  }
  for (const k of ["carrier_name", "carrier_tracking_number", "container_number", "bill_of_lading_number", "loading_port", "discharge_port", "vessel_name", "notes"] as const) {
    const v = body[k];
    if (typeof v === "string" && v.length > 500) {
      return NextResponse.json({ error: `${k} is too long (max 500 chars).` }, { status: 400 });
    }
  }

  try {
    const updated = await updateShipment(id, access.tenant_id, access.partner_id, body);
    if (!updated) {
      return NextResponse.json({ error: "Not found or not authorised." }, { status: 404 });
    }
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.shipment_updated",
        "marketplace_shipments",
        updated.id,
        { status: updated.status, carrier_name: updated.carrier_name },
      );
      // Phase 12 — fire marketplace.shipment_updated webhook
      // (fire-and-forget). Receivers use this to sync their own
      // shipment-tracker UIs, trigger customs filing on `arrived_port`,
      // release escrow on `delivered`, etc. The payload mirrors the
      // audit log entry — triggerWebhooks() additionally sanitises PII
      // markers before signing + sending, so no carrier account numbers
      // leak even if a future column adds them.
      void triggerWebhooks(store, access.tenant_id, "marketplace.shipment_updated", "marketplace_shipment", updated.id, {
        shipment_id: updated.id,
        status: updated.status,
        carrier_name: updated.carrier_name ?? null,
        carrier_tracking_number: updated.carrier_tracking_number ?? null,
        container_number: updated.container_number ?? null,
        bill_of_lading_number: updated.bill_of_lading_number ?? null,
        loading_port: updated.loading_port ?? null,
        discharge_port: updated.discharge_port ?? null,
        vessel_name: updated.vessel_name ?? null,
        updated_at: updated.updated_at,
      }).catch(() => {});
    } catch (e) {
      console.error("[marketplace.shipments.update] audit failed:", e);
    }
    return NextResponse.json(updated);
  } catch (e: any) {
    console.error("[marketplace.shipments.update]", e);
    const msg = e?.message || "Failed to update shipment.";
    const status = /cannot transition/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/shipments/[id]");
export const PUT = withApm(_put, "PUT /api/marketplace/shipments/[id]");
