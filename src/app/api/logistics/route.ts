/**
 * API Route — Logistics Tracking
 *
 * Read-only view over the `logistics_requests` Supabase table. Returns shipment
 * objects in the shape the existing consumers (api-integrations-view and
 * custom-dashboard-view) expect: `{ shipments, total, summary }`.
 *
 * Authenticated access only. Tenant-scoped via `resolveTenantId`.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

interface ShipmentEvent {
  timestamp: string;
  location: string;
  description: string;
  type: "departure" | "arrival" | "customs" | "transit" | "delay";
}

interface Shipment {
  id: string;
  trackingNumber: string;
  status: "in_transit" | "customs" | "delivered" | "loading" | "delayed";
  origin: string;
  destination: string;
  carrier: string;
  mode: "sea" | "air" | "road" | "rail";
  eta: string;
  departureDate: string;
  currentLocation: string;
  progress: number;
  containers: string[];
  weight: string;
  value: string;
  customsStatus: "cleared" | "pending" | "inspection" | "held";
  lastUpdate: string;
  events: ShipmentEvent[];
}

/** Status values the consumer UI knows about (summary cards + filter dropdown). */
const SHIPMENT_STATUSES = ["in_transit", "customs", "delivered", "loading", "delayed"] as const;
type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

const VALID_MODES = new Set(["sea", "air", "road", "rail"]);

/**
 * Map a `logistics_requests.status` value (pending/quoted/accepted/in_progress/
 * completed/cancelled/rejected) to the 5-status vocabulary the consumer UI
 * renders. The store-side vocabulary is finer-grained than the dashboard — we
 * collapse quote/preparation stages into "loading" and treat cancellations as
 * "delayed" so they still surface in the UI rather than disappearing.
 */
function mapStatus(raw: string | null | undefined): ShipmentStatus {
  switch (raw) {
    case "completed":
      return "delivered";
    case "in_progress":
      return "in_transit";
    case "cancelled":
    case "rejected":
      return "delayed";
    case "pending":
    case "quoted":
    case "accepted":
    default:
      return "loading";
  }
}

/** Coerce an arbitrary mode string into the union the UI renders. */
function coerceMode(raw: unknown): "sea" | "air" | "road" | "rail" {
  return typeof raw === "string" && VALID_MODES.has(raw) ? (raw as "sea" | "air" | "road" | "rail") : "sea";
}

/** Best-effort progress estimate (0-100) from the request's lifecycle stage. */
function progressFor(status: ShipmentStatus): number {
  switch (status) {
    case "loading":
      return 25;
    case "in_transit":
      return 75;
    case "customs":
      return 85;
    case "delivered":
      return 100;
    case "delayed":
      return 50;
  }
}

function firstNonEmpty(...vals: Array<unknown>): string {
  for (const v of vals) {
    if (v !== null && v !== undefined && v !== "") return String(v);
  }
  return "";
}

/**
 * Map a `logistics_requests` row to the consumer-facing `Shipment` shape.
 * Field names (trackingNumber, currentLocation, customsStatus, …) are kept
 * verbatim because two React views read them by those exact names.
 */
function rowToShipment(r: any): Shipment {
  const status = mapStatus(r?.status);
  const origin = firstNonEmpty(r?.origin_city, r?.origin_country, r?.origin_port);
  const destination = firstNonEmpty(r?.destination_city, r?.destination_country, r?.destination_port);
  const carrier = firstNonEmpty(r?.carrier, r?.carrier_reference);
  const trackingNumber = firstNonEmpty(r?.tracking_number, r?.number);
  const eta = firstNonEmpty(r?.target_delivery_date, r?.delivered_at, r?.shipped_at, r?.created_at);
  const departureDate = firstNonEmpty(r?.shipped_at, r?.accepted_at, r?.created_at);
  const currentLocation = firstNonEmpty(r?.origin_port, r?.destination_port, origin);

  const weight = r?.total_weight_kg != null ? `${r.total_weight_kg} kg` : "";
  const value =
    r?.cargo_value != null ? `${r?.cargo_currency || "USD"} ${Number(r.cargo_value).toLocaleString()}` : "";

  const containers: string[] = r?.container_type ? [String(r.container_type)] : [];

  // Events live in a separate `logistics_events` table — fetching them per-row
  // here would turn this list endpoint into an N+1. The consumer renders an
  // empty timeline gracefully ("Show Timeline (0 events)"), so we leave the
  // array empty and let the dedicated [id]/events route populate details on
  // demand.
  const events: ShipmentEvent[] = [];

  return {
    id: String(r?.id || ""),
    trackingNumber,
    status,
    origin,
    destination,
    carrier,
    mode: coerceMode(r?.mode),
    eta,
    departureDate,
    currentLocation,
    progress: progressFor(status),
    containers,
    weight,
    value,
    customsStatus: "pending",
    lastUpdate: firstNonEmpty(r?.updated_at, r?.created_at),
    events,
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate — logistics.read matches the sidebar entry (previously
  // gated on documents.read which is a different domain).
  {
    const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "logistics.read");
    if (_d) return _d;
  }
  // Feature gate (module_logistics)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_logistics", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  try {
    const tenantId = resolveTenantId(auth, req);
    if (!tenantId) {
      return NextResponse.json({
        shipments: [],
        total: 0,
        summary: Object.fromEntries(SHIPMENT_STATUSES.map((s) => [s, 0])) as Record<string, number>,
      });
    }

    const { searchParams } = new URL(req.url);
    const statusFilter = searchParams.get("status");
    const modeFilter = searchParams.get("mode");

    const sb = getSupabase();
    const { data, error } = await sb
      .from("logistics_requests")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      console.error("[logistics] Supabase error:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Map rows → shipment shape, then apply consumer-facing filters in memory.
    let shipments: Shipment[] = (data || []).map(rowToShipment);
    if (statusFilter && statusFilter !== "all") {
      shipments = shipments.filter((s) => s.status === statusFilter);
    }
    if (modeFilter && modeFilter !== "all") {
      shipments = shipments.filter((s) => s.mode === modeFilter);
    }

    // Summary counts use the same 5-status vocabulary the consumer renders.
    const summary = Object.fromEntries(
      SHIPMENT_STATUSES.map((s) => [s, shipments.filter((sh) => sh.status === s).length])
    ) as Record<string, number>;

    return NextResponse.json({
      shipments,
      total: shipments.length,
      summary,
    });
  } catch (error) {
    console.error("[logistics] Error fetching shipments:", error);
    return NextResponse.json({ error: "Failed to fetch logistics data." }, { status: 500 });
  }
}
