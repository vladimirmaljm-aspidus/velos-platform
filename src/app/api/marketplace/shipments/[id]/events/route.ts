import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import {
  addShipmentEvent,
  getShipmentIfAuthorised,
} from "@/lib/data/marketplace-logistics-store";
import { sanitizeFields } from "@/lib/security/sanitize-input";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { triggerWebhooks } from "@/lib/webhooks/deliver";
import { withApm } from "@/lib/monitoring/apm";
import type { ShipmentStatus } from "@/lib/supabase/marketplace-logistics-types";

export const runtime = "nodejs";

// GET /api/marketplace/shipments/[id]/events — list the tracking events
// for a shipment, chronological order. Caller must be authorised to view
// the shipment (booking partner, post owner, or negotiation party).
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
    const sb = (await import("@/lib/supabase/client")).getSupabase();
    const { data, error } = await sb
      .from("marketplace_shipment_events")
      .select("*")
      .eq("shipment_id", id)
      .order("event_date", { ascending: true });
    if (error) throw error;
    return NextResponse.json({ items: data || [] });
  } catch (e: any) {
    console.error("[marketplace.shipment_events.list]", e);
    return NextResponse.json({ error: "Failed to load tracking events." }, { status: 500 });
  }
}

// POST /api/marketplace/shipments/[id]/events — append a tracking event.
// Booking partner only. The event is append-only; the store ALSO bumps
// the shipment's denormalised `status` column to match (when the
// transition is permitted by the lifecycle graph).
async function _post(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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

  const allowedStatuses: ShipmentStatus[] = [
    "pending", "booked", "loading", "in_transit",
    "arrived_port", "customs", "delivered", "delayed", "cancelled",
  ];
  if (!body.status || !allowedStatuses.includes(body.status)) {
    return NextResponse.json({ error: "status is required and must be a valid shipment status." }, { status: 400 });
  }
  if (body.location && typeof body.location === "string" && body.location.length > 500) {
    return NextResponse.json({ error: "location is too long (max 500 chars)." }, { status: 400 });
  }
  if (body.description && typeof body.description === "string" && body.description.length > 2000) {
    return NextResponse.json({ error: "description is too long (max 2000 chars)." }, { status: 400 });
  }

  body = sanitizeFields(body, ["location", "description"]);

  try {
    const evt = await addShipmentEvent(id, access.tenant_id, access.partner_id, {
      status: body.status,
      location: body.location ?? null,
      event_date: body.event_date ?? null,
      description: body.description ?? null,
      created_by: access.partner_id,
    });
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.shipment_event_added",
        "marketplace_shipment_events",
        evt.id,
        { shipment_id: id, status: body.status, location: body.location },
      );
      // Phase 12 — fire marketplace.shipment_status webhook
      // (fire-and-forget). Receivers can use this to update their own
      // dashboards / trigger downstream logistics flows (e.g. customs
      // filing on "arrived_port", invoice issuance on "delivered").
      void triggerWebhooks(store, access.tenant_id, "marketplace.shipment_status", "marketplace_shipment", id, {
        shipment_id: id,
        event_id: evt.id,
        status: body.status,
        location: body.location ?? null,
        event_date: evt.event_date,
      }).catch(() => {});
    } catch (e) {
      console.error("[marketplace.shipment_events.add] audit failed:", e);
    }
    return NextResponse.json(evt);
  } catch (e: any) {
    console.error("[marketplace.shipment_events.add]", e);
    const msg = sanitizeError(e);
    const status = /not found/i.test(msg) ? 404 : /cannot transition|invalid/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/shipments/[id]/events");
export const POST = withApm(_post, "POST /api/marketplace/shipments/[id]/events");
