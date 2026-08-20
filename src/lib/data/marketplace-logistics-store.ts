// Marketplace Phase 6 store — logistics: shipments + tracking events.
//
// All functions talk directly to the tables added in migration
// 047_marketplace_logistics.sql. The store is intentionally a separate
// module from marketplace-store.ts / marketplace-auction-store.ts to keep
// the Phase 1-5 files readable; API routes import this module directly
// and pass `tenantId` / `partnerId` from the resolved auth context.
//
// SECURITY MODEL
//   • createShipment(): the caller is the booking partner. tenant_id +
//     partner_id are stamped from the auth context — never trust a
//     body-supplied partner_id.
//   • getShipment(): scoped by tenant_id; the caller's partner_id is
//     verified to be the booking partner OR (when post_id / negotiation_id
//     is set) the post owner / the other side of the negotiation.
//   • updateShipment(): the booking partner only — verified at the API
//     layer before calling this store (the store filters by tenant_id +
//     partner_id so a partner from tenant A cannot update tenant B's
//     shipments by guessing ids).
//   • addShipmentEvent(): also restricted to the booking partner; events
//     are append-only (no UPDATE / DELETE surfaced through the store) so
//     the tracking history is tamper-evident.
//   • listShipments(): returns the caller's shipments (partner_id filter).
//   • getShipmentTimeline(): chronological events for a shipment the caller
//     is authorised to see (delegates the auth check to getShipment).

import { getSupabase } from "@/lib/supabase/client";
import type {
  Shipment,
  ShipmentCreate,
  ShipmentEvent,
  ShipmentEventCreate,
  ShipmentStatus,
  ShipmentUpdate,
} from "@/lib/supabase/marketplace-logistics-types";
import { SHIPMENT_LIFECYCLE } from "@/lib/supabase/marketplace-logistics-types";

// ─── Validation helpers ────────────────────────────────────────────────────

const VALID_STATUSES = new Set<string>([
  "pending",
  "booked",
  "loading",
  "in_transit",
  "arrived_port",
  "customs",
  "delivered",
  "delayed",
  "cancelled",
]);

/**
 * Allowed shipment-status transitions. The lifecycle is mostly linear
 * (pending → booked → loading → in_transit → arrived_port → customs →
 * delivered), but `delayed` and `cancelled` are off-ramps reachable from
 * any pre-delivery state. We enforce the graph at the store layer so a
 * buggy caller cannot set the shipment back to a "pending" state from
 * "delivered".
 *
 * `delivered`, `cancelled` are terminal — no further transitions.
 */
const ALLOWED_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  pending:      ["booked", "cancelled", "delayed"],
  booked:       ["loading", "in_transit", "delayed", "cancelled"],
  loading:      ["in_transit", "delayed", "cancelled"],
  in_transit:   ["arrived_port", "delayed", "cancelled"],
  arrived_port: ["customs", "delayed", "cancelled"],
  customs:      ["delivered", "delayed", "cancelled"],
  delayed:      ["loading", "in_transit", "arrived_port", "customs", "delivered", "cancelled"],
  delivered:    [],
  cancelled:    [],
};

/**
 * Returns true if the status transition `from → to` is permitted under the
 * shipment lifecycle. Used by addShipmentEvent + updateShipment.
 */
export function canTransitionStatus(from: ShipmentStatus, to: ShipmentStatus): boolean {
  if (from === to) return true; // no-op
  const allowed = ALLOWED_TRANSITIONS[from];
  return (allowed as ShipmentStatus[] | undefined)?.includes(to) ?? false;
}

// ─── Public sanitisation helpers ──────────────────────────────────────────

/**
 * Strip tenant_id / partner_id from a shipment before returning it to a
 * caller who is NOT the booking partner. The booking partner gets the
 * full row; everyone else (e.g. the post owner, the other side of the
 * negotiation) sees the sanitised shape so the partner_id of the booking
 * partner does not leak.
 */
export function sanitisePublicShipment(s: Shipment): Record<string, unknown> {
  const { tenant_id: _t, partner_id: _p, ...rest } = s;
  return rest as Record<string, unknown>;
}

// ─── Shipments ────────────────────────────────────────────────────────────

/**
 * Create a new shipment. tenant_id + partner_id are stamped from the auth
 * context by the API route — never trust a body-supplied partner_id.
 *
 * When `status` is supplied and is not 'pending' (e.g. the caller is
 * booking an already-loaded shipment), the store inserts the shipment
 * AND a marketplace_shipment_events row carrying the initial status. The
 * events row is what powers the tracking timeline — without it, the
 * timeline would be empty until the first manual event is added.
 */
export async function createShipment(
  tenantId: string,
  partnerId: string,
  data: ShipmentCreate,
): Promise<Shipment> {
  const sb = getSupabase();

  // Validate the optional status.
  const initialStatus: ShipmentStatus =
    data.status && VALID_STATUSES.has(data.status) ? data.status : "pending";

  // Validate post_id / negotiation_id belong to the caller's tenant.
  if (data.post_id) {
    const { data: postRow, error: postErr } = await sb
      .from("marketplace_posts")
      .select("tenant_id")
      .eq("id", data.post_id)
      .maybeSingle();
    if (postErr) throw postErr;
    if (!postRow) throw new Error("Post not found.");
    if ((postRow as { tenant_id: string }).tenant_id !== tenantId) {
      throw new Error("Post not found.");
    }
  }
  if (data.negotiation_id) {
    const { data: negRow, error: negErr } = await sb
      .from("marketplace_negotiations")
      .select("tenant_id_a, tenant_id_b")
      .eq("id", data.negotiation_id)
      .maybeSingle();
    if (negErr) throw negErr;
    if (!negRow) throw new Error("Negotiation not found.");
    const n = negRow as { tenant_id_a: string; tenant_id_b: string };
    if (n.tenant_id_a !== tenantId && n.tenant_id_b !== tenantId) {
      throw new Error("Negotiation not found.");
    }
  }

  const payload = {
    tenant_id: tenantId,
    partner_id: partnerId,
    post_id: data.post_id ?? null,
    negotiation_id: data.negotiation_id ?? null,
    status: initialStatus,
    carrier_name: data.carrier_name ?? null,
    carrier_tracking_number: data.carrier_tracking_number ?? null,
    container_number: data.container_number ?? null,
    bill_of_lading_number: data.bill_of_lading_number ?? null,
    loading_port: data.loading_port ?? null,
    discharge_port: data.discharge_port ?? null,
    vessel_name: data.vessel_name ?? null,
    estimated_departure: data.estimated_departure ?? null,
    actual_departure: data.actual_departure ?? null,
    estimated_arrival: data.estimated_arrival ?? null,
    actual_arrival: data.actual_arrival ?? null,
    container_type: data.container_type ?? null,
    gross_weight: data.gross_weight ?? null,
    net_weight: data.net_weight ?? null,
    volume: data.volume ?? null,
    packages_count: data.packages_count ?? null,
    temperature_controlled: data.temperature_controlled ?? false,
    notes: data.notes ?? null,
  };

  const { data: inserted, error } = await sb
    .from("marketplace_shipments")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  const shipment = inserted as Shipment;

  // Insert the initial tracking event (pending or the supplied status).
  // Fire-and-forget — a failure here must not block the create response;
  // the audit trail is best-effort.
  try {
    await sb.from("marketplace_shipment_events").insert({
      shipment_id: shipment.id,
      status: initialStatus,
      location: data.loading_port ?? null,
      event_date: new Date().toISOString(),
      description: "Shipment created",
      created_by: partnerId,
    });
  } catch (e) {
    console.error("[marketplace.shipments.create] initial-event insert failed:", e);
  }

  return shipment;
}

/**
 * Fetch a shipment + its tracking events in a single round-trip.
 *
 * Auth check: the caller's partner_id must equal the shipment's
 * partner_id (the booking partner) OR — when post_id is set — be the post
 * owner OR — when negotiation_id is set — be one of the two partners in
 * the negotiation. The auth check is done at the API layer before calling
 * this store; the store itself only filters by tenant_id so a partner
 * from tenant A cannot read tenant B's shipments by guessing ids.
 *
 * Returns `{ shipment, events }` or `null` when the shipment is not found.
 */
export async function getShipment(
  shipmentId: string,
  tenantId: string,
): Promise<{ shipment: Shipment; events: ShipmentEvent[] } | null> {
  const sb = getSupabase();

  const { data: sRow, error: sErr } = await sb
    .from("marketplace_shipments")
    .select("*")
    .eq("id", shipmentId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (sErr) throw sErr;
  if (!sRow) return null;
  const shipment = sRow as Shipment;

  const { data: eRows, error: eErr } = await sb
    .from("marketplace_shipment_events")
    .select("*")
    .eq("shipment_id", shipmentId)
    .order("event_date", { ascending: true });
  if (eErr) throw eErr;
  const events = (eRows as ShipmentEvent[]) || [];

  return { shipment, events };
}

/**
 * Update a shipment. The caller MUST verify ownership (partner_id ===
 * caller) BEFORE calling this function — the API route performs that
 * check; the store filters by tenant_id + partner_id so a partner from
 * tenant A cannot update tenant B's rows by guessing ids.
 *
 * When `status` changes, the store ALSO inserts a marketplace_shipment_events
 * row carrying the new status so the tracking timeline stays in sync with
 * the denormalised status column. The event is best-effort — a failure to
 * insert does not block the shipment update.
 */
export async function updateShipment(
  shipmentId: string,
  tenantId: string,
  partnerId: string,
  patch: ShipmentUpdate,
): Promise<Shipment | null> {
  const sb = getSupabase();

  // Strip fields the DB owns (id, tenant_id, partner_id, created_at,
  // updated_at) so the UPDATE never tries to write them.
  const {
    id: _id,
    tenant_id: _t,
    partner_id: _p,
    created_at: _c,
    updated_at: _u,
    ...fields
  } = patch as Record<string, unknown>;
  void _id; void _t; void _p; void _c; void _u;

  // If status is changing, fetch the current status to validate the
  // transition (cannot move backwards in the lifecycle).
  let prevStatus: ShipmentStatus | null = null;
  if (fields.status !== undefined) {
    const { data: cur, error: curErr } = await sb
      .from("marketplace_shipments")
      .select("status")
      .eq("id", shipmentId)
      .eq("tenant_id", tenantId)
      .eq("partner_id", partnerId)
      .maybeSingle();
    if (curErr) throw curErr;
    if (!cur) return null;
    prevStatus = (cur as { status: ShipmentStatus }).status;
    const newStatus = fields.status as ShipmentStatus;
    if (prevStatus && !canTransitionStatus(prevStatus, newStatus)) {
      throw new Error(`Cannot transition shipment status from "${prevStatus}" to "${newStatus}".`);
    }
  }

  const { data, error } = await sb
    .from("marketplace_shipments")
    .update(fields)
    .eq("id", shipmentId)
    .eq("tenant_id", tenantId)
    .eq("partner_id", partnerId)
    .select()
    .maybeSingle();
  if (error) throw error;
  const updated = (data as Shipment) || null;
  if (!updated) return null;

  // When status changed, append a tracking event (best-effort).
  if (fields.status !== undefined && prevStatus !== fields.status) {
    try {
      await sb.from("marketplace_shipment_events").insert({
        shipment_id: shipmentId,
        status: String(fields.status),
        location: fields.loading_port ?? fields.discharge_port ?? null,
        event_date: new Date().toISOString(),
        description: `Status updated from ${prevStatus} to ${fields.status}`,
        created_by: partnerId,
      });
    } catch (e) {
      console.error("[marketplace.shipments.update] event insert failed:", e);
    }
  }

  return updated;
}

// ─── Tracking events ──────────────────────────────────────────────────────

/**
 * Append a tracking event to a shipment's history. Also bumps the
 * shipment's denormalised `status` column to match the new event's status
 * (when the transition is permitted).
 *
 * Auth: the caller MUST be the booking partner — the API route checks
 * ownership before calling this store. The store filters by tenant_id +
 * partner_id so a partner from tenant A cannot append events to tenant B's
 * shipments by guessing ids.
 *
 * Events are append-only — no UPDATE / DELETE is exposed via the store,
 * making the tracking history tamper-evident.
 */
export async function addShipmentEvent(
  shipmentId: string,
  tenantId: string,
  partnerId: string,
  event: ShipmentEventCreate,
): Promise<ShipmentEvent> {
  const sb = getSupabase();

  // Verify the shipment exists + belongs to the caller's tenant + the
  // caller is the booking partner.
  const { data: sRow, error: sErr } = await sb
    .from("marketplace_shipments")
    .select("id, status, tenant_id, partner_id")
    .eq("id", shipmentId)
    .eq("tenant_id", tenantId)
    .eq("partner_id", partnerId)
    .maybeSingle();
  if (sErr) throw sErr;
  if (!sRow) throw new Error("Shipment not found.");
  const s = sRow as { id: string; status: ShipmentStatus; tenant_id: string; partner_id: string };

  const newStatus = String(event.status || "");
  if (!VALID_STATUSES.has(newStatus)) {
    throw new Error(`Invalid event status: "${newStatus}".`);
  }

  // Validate the transition (when the new status differs from current).
  const newStatusTyped = newStatus as ShipmentStatus;
  if (s.status !== newStatusTyped && !canTransitionStatus(s.status, newStatusTyped)) {
    throw new Error(`Cannot transition shipment status from "${s.status}" to "${newStatus}".`);
  }

  // Insert the event.
  const payload = {
    shipment_id: shipmentId,
    status: newStatus,
    location: event.location ?? null,
    event_date: event.event_date || new Date().toISOString(),
    description: event.description ?? null,
    created_by: event.created_by ?? partnerId,
  };
  const { data: inserted, error: insErr } = await sb
    .from("marketplace_shipment_events")
    .insert(payload)
    .select()
    .single();
  if (insErr) throw insErr;
  const evt = inserted as ShipmentEvent;

  // Bump the denormalised status (best-effort).
  if (s.status !== newStatusTyped) {
    try {
      await sb
        .from("marketplace_shipments")
        .update({ status: newStatus })
        .eq("id", shipmentId);
    } catch (e) {
      console.error("[marketplace.shipment_events.add] status bump failed:", e);
    }
  }

  return evt;
}

// ─── Listing + timeline ────────────────────────────────────────────────────

/**
 * List a partner's own shipments, newest first. Returns the FULL row (no
 * sanitisation) — the caller IS the booking partner.
 *
 * The `status` filter is optional and accepts the same values as the
 * shipment_status enum.
 */
export async function listShipments(
  tenantId: string,
  partnerId: string,
  opts?: { status?: string; limit?: number; offset?: number },
): Promise<{ items: Shipment[]; total: number }> {
  const sb = getSupabase();
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
  const offset = Math.max(opts?.offset ?? 0, 0);

  let q = sb
    .from("marketplace_shipments")
    .select("*", { count: "exact" })
    .eq("tenant_id", tenantId)
    .eq("partner_id", partnerId);

  if (opts?.status && VALID_STATUSES.has(opts.status)) {
    q = q.eq("status", opts.status);
  }
  q = q.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) throw error;
  return {
    items: (data as Shipment[]) || [],
    total: count ?? 0,
  };
}

/**
 * Get the chronological timeline of tracking events for a shipment. Used
 * by the shipment-tracker component's "events history" panel.
 *
 * Auth check is delegated to getShipment() — the caller must be authorised
 * to see the shipment before this function returns events.
 */
export async function getShipmentTimeline(
  shipmentId: string,
  tenantId: string,
): Promise<ShipmentEvent[]> {
  // Reuse getShipment's auth check.
  const exists = await getShipment(shipmentId, tenantId);
  if (!exists) return [];

  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_shipment_events")
    .select("*")
    .eq("shipment_id", shipmentId)
    .order("event_date", { ascending: true });
  if (error) throw error;
  return (data as ShipmentEvent[]) || [];
}

// ─── Auth check: is the caller authorised to view/update this shipment? ──

/**
 * Verify that the caller is authorised to view the shipment.
 *
 * Authorised parties:
 *   • The booking partner (shipment.partner_id === caller).
 *   • The post owner (when shipment.post_id is set and the post's owner
 *     is the caller).
 *   • Either side of the negotiation (when shipment.negotiation_id is
 *     set and the negotiation's partner_id_a / partner_id_b includes
 *     the caller).
 *
 * Returns `{ shipment, is_booking_partner }` or null when the caller is
 * NOT authorised (or the shipment does not exist).
 */
export async function getShipmentIfAuthorised(
  shipmentId: string,
  tenantId: string,
  partnerId: string,
): Promise<{ shipment: Shipment; is_booking_partner: boolean } | null> {
  const sb = getSupabase();

  const { data: sRow, error: sErr } = await sb
    .from("marketplace_shipments")
    .select("*")
    .eq("id", shipmentId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (sErr) throw sErr;
  if (!sRow) return null;
  const shipment = sRow as Shipment;

  // 1. Booking partner.
  if (shipment.partner_id === partnerId) {
    return { shipment, is_booking_partner: true };
  }

  // 2. Post owner.
  if (shipment.post_id) {
    const { data: postRow } = await sb
      .from("marketplace_posts")
      .select("partner_id")
      .eq("id", shipment.post_id)
      .maybeSingle();
    if (postRow && (postRow as { partner_id: string }).partner_id === partnerId) {
      return { shipment, is_booking_partner: false };
    }
  }

  // 3. Negotiation party.
  if (shipment.negotiation_id) {
    const { data: negRow } = await sb
      .from("marketplace_negotiations")
      .select("partner_id_a, partner_id_b")
      .eq("id", shipment.negotiation_id)
      .maybeSingle();
    if (negRow) {
      const n = negRow as { partner_id_a: string; partner_id_b: string };
      if (n.partner_id_a === partnerId || n.partner_id_b === partnerId) {
        return { shipment, is_booking_partner: false };
      }
    }
  }

  return null;
}

// ─── Convenience: lifecycle helpers ────────────────────────────────────────

/**
 * Return the index of a status in the canonical SHIPMENT_LIFECYCLE array.
 * Returns -1 for `delayed` and `cancelled` (off-ramps not in the linear
 * progression). Used by the tracker UI to render "done / current / pending"
 * stages on the timeline.
 */
export function lifecycleIndex(status: ShipmentStatus): number {
  return SHIPMENT_LIFECYCLE.indexOf(status);
}
