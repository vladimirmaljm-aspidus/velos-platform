import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requirePortalModule } from "@/lib/portal/module-permissions";
import { requireMarketplaceEnabled } from "@/lib/portal/marketplace-gate";
// 8c-2: KYC gate — mirror top-level marketplace POST route. Without this,
// a portal client whose KYC is `rejected` / `suspended` could still create
// shipments / sign trade documents / post community content — binding
// commitments that affect counterparty's downstream flows.
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import {
  createShipment,
  listShipments,
} from "@/lib/data/marketplace-logistics-store";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";
import type { ContainerType, ShipmentStatus } from "@/lib/supabase/marketplace-logistics-types";

export const runtime = "nodejs";

// GET /api/marketplace/shipments — list the caller's shipments.
// Optional query: ?status=<pending|booked|…>&limit=50&offset=0
// 100 — ?post_id=<uuid> switches to DEAL-ROOM mode: every shipment on
// that post the caller may see (post owner / negotiation party / own).
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // 099 — module permission gate (marketplace.logistics).
  const _moduleBlock = await requirePortalModule(access, "marketplace.logistics");
  if (_moduleBlock) return _moduleBlock;
  // 100 — tenant marketplace switch (Layer 0).
  const _enabledBlock = await requireMarketplaceEnabled(access);
  if (_enabledBlock) return _enabledBlock;
  try {
    const url = new URL(req.url);
    const status = url.searchParams.get("status") || undefined;
    const limit = url.searchParams.get("limit");
    const offset = url.searchParams.get("offset");
    // 100 — deal-room mode: list the shipments of one marketplace post
    // (visibility enforced in the store: post owner / negotiation party /
    // booking partner).
    const rawPostId = url.searchParams.get("post_id");
    if (rawPostId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawPostId)) {
      return NextResponse.json({ error: "post_id must be a valid UUID." }, { status: 400 });
    }
    const items = await listShipments(access.tenant_id, access.partner_id, {
      status,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      post_id: rawPostId || undefined,
    });
    return NextResponse.json(items);
  } catch (e: any) {
    console.error("[marketplace.shipments.list]", e);
    const msg = sanitizeError(e);
    const notFound = /not found/i.test(msg);
    return NextResponse.json(
      { error: notFound ? msg : "Failed to load shipments." },
      { status: notFound ? 404 : 500 },
    );
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
  // 099 — module permission gate (marketplace.logistics).
  const _moduleBlock = await requirePortalModule(access, "marketplace.logistics");
  if (_moduleBlock) return _moduleBlock;
  // 100 — tenant marketplace switch (Layer 0).
  const _enabledBlock = await requireMarketplaceEnabled(access);
  if (_enabledBlock) return _enabledBlock;
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
    const msg = sanitizeError(e);
    const status = /not found/i.test(msg) ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/shipments");
export const POST = withApm(_post, "POST /api/marketplace/shipments");
