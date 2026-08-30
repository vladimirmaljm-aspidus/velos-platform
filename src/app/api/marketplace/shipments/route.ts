import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
// 8c-2: KYC gate — mirror top-level marketplace POST route. Without this,
// a portal client whose KYC is `rejected` / `suspended` could still create
// shipments / sign trade documents / post community content — binding
// commitments that affect counterparty's downstream flows.
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import {
  createShipment,
  listShipments,
} from "@/lib/data/marketplace-logistics-store";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";
import type { ContainerType, ShipmentStatus } from "@/lib/supabase/marketplace-logistics-types";

export const runtime = "nodejs";

// GET /api/marketplace/shipments — list the caller's shipments.
// Optional query: ?status=<pending|booked|…>&limit=50&offset=0
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    const url = new URL(req.url);
    const status = url.searchParams.get("status") || undefined;
    const limit = url.searchParams.get("limit");
    const offset = url.searchParams.get("offset");
    const items = await listShipments(access.tenant_id, access.partner_id, {
      status,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return NextResponse.json(items);
  } catch (e: any) {
    console.error("[marketplace.shipments.list]", e);
    return NextResponse.json({ error: "Failed to load shipments." }, { status: 500 });
  }
}

// POST /api/marketplace/shipments — create a new shipment.
// Body: see ShipmentCreate in marketplace-logistics-types.ts. tenant_id +
// partner_id are stamped from the auth context — never trust a body-
// supplied partner_id.
async function _post(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // 8c-2: KYC gate — defence-in-depth, mirror top-level marketplace POST.
  const _kycBlock = await requireKycApproved(access);
  if (_kycBlock) return _kycBlock;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Validate container_type when supplied.
  const allowedContainerTypes: ContainerType[] = [
    "20gp", "40gp", "40hc", "40ot", "40fr", "lcl", "bulk", "tank",
  ];
  if (body.container_type && !allowedContainerTypes.includes(body.container_type)) {
    return NextResponse.json({ error: "Invalid container_type." }, { status: 400 });
  }
  // Validate status when supplied.
  const allowedStatuses: ShipmentStatus[] = [
    "pending", "booked", "loading", "in_transit",
    "arrived_port", "customs", "delivered", "delayed", "cancelled",
  ];
  if (body.status && !allowedStatuses.includes(body.status)) {
    return NextResponse.json({ error: "Invalid status." }, { status: 400 });
  }
  // Numeric validations.
  for (const k of ["gross_weight", "net_weight", "volume", "packages_count"] as const) {
    const v = body[k];
    if (v !== undefined && v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
      return NextResponse.json({ error: `${k} must be a non-negative number.` }, { status: 400 });
    }
  }
  // Length cap on free-text fields.
  for (const k of ["carrier_name", "carrier_tracking_number", "container_number", "bill_of_lading_number", "loading_port", "discharge_port", "vessel_name", "notes"] as const) {
    const v = body[k];
    if (typeof v === "string" && v.length > 500) {
      return NextResponse.json({ error: `${k} is too long (max 500 chars).` }, { status: 400 });
    }
  }

  try {
    const created = await createShipment(access.tenant_id, access.partner_id, body);
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.shipment_created",
        "marketplace_shipments",
        created.id,
        { carrier_name: created.carrier_name, loading_port: created.loading_port, discharge_port: created.discharge_port },
      );
    } catch (e) {
      console.error("[marketplace.shipments.create] audit failed:", e);
    }
    return NextResponse.json(created);
  } catch (e: any) {
    console.error("[marketplace.shipments.create]", e);
    const msg = e?.message || "Failed to create shipment.";
    const status = /not found/i.test(msg) ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/shipments");
export const POST = withApm(_post, "POST /api/marketplace/shipments");
