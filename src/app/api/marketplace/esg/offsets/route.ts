import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import {
  VALID_OFFSET_TYPES,
  createCarbonOffset,
  listCarbonOffsets,
} from "@/lib/data/marketplace-esg-store";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";
import type { CarbonOffsetType } from "@/lib/supabase/marketplace-esg-types";

export const runtime = "nodejs";

const VALID_OFFSET_LIST: CarbonOffsetType[] = [
  "tree_planting", "renewable_energy", "methane_capture", "direct_air_capture",
];

// GET /api/marketplace/esg/offsets?partnerId=... — list a company's carbon
// offset transactions. Owning partner only — offset purchases are private
// (the public profile surfaces the AGGREGATE tonnes-offset, not the
// individual transactions).
//
// When `partnerId` is omitted, the caller's own partner_id is used (so the
// carbon-offset widget can omit it on the self-profile page).
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    const url = new URL(req.url);
    const requestedPartnerId = url.searchParams.get("partnerId");
    const partnerId = requestedPartnerId || access.partner_id;
    // The store does NOT filter by tenant — but a partner from tenant A
    // cannot meaningfully query tenant B's offsets because they don't know
    // tenant B's partner_ids (the partner_ids are tenant-scoped opaque
    // strings). For belt-and-braces, only the owning partner sees their own
    // offsets — anyone else gets a 403.
    if (partnerId !== access.partner_id) {
      return NextResponse.json(
        { error: "Not authorised — offset list is private to the owning partner." },
        { status: 403 },
      );
    }
    const items = await listCarbonOffsets(partnerId);
    return NextResponse.json({ items });
  } catch (e: any) {
    console.error("[marketplace.esg.offsets.list]", e);
    return NextResponse.json({ error: "Failed to load carbon offsets." }, { status: 500 });
  }
}

// POST /api/marketplace/esg/offsets — create a carbon offset. Owning
// partner only. partner_id is stamped from the auth context.
//
// Body:
//   { shipment_id?, co2_tons, offset_cost?, currency?, offset_type?,
//     certificate_url? }
//
// When `offset_cost` is not supplied, the store auto-derives it from
// `offset_type` + `co2_tons` (see `estimateOffsetCost()`).
async function _post(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.co2_tons !== "number" || !Number.isFinite(body.co2_tons) || body.co2_tons <= 0) {
    return NextResponse.json({ error: "co2_tons must be a positive number." }, { status: 400 });
  }
  if (body.shipment_id !== undefined && body.shipment_id !== null && typeof body.shipment_id !== "string") {
    return NextResponse.json({ error: "shipment_id must be a string UUID." }, { status: 400 });
  }
  if (body.offset_type !== undefined && body.offset_type !== null) {
    if (!VALID_OFFSET_TYPES.has(body.offset_type) || !VALID_OFFSET_LIST.includes(body.offset_type)) {
      return NextResponse.json({ error: "Invalid offset_type." }, { status: 400 });
    }
  }
  if (body.offset_cost !== undefined && body.offset_cost !== null && (typeof body.offset_cost !== "number" || !Number.isFinite(body.offset_cost) || body.offset_cost < 0)) {
    return NextResponse.json({ error: "offset_cost must be a non-negative number." }, { status: 400 });
  }
  if (body.currency !== undefined && (typeof body.currency !== "string" || body.currency.length !== 3)) {
    return NextResponse.json({ error: "currency must be a 3-letter ISO code." }, { status: 400 });
  }
  if (body.certificate_url !== undefined && body.certificate_url !== null && (typeof body.certificate_url !== "string" || body.certificate_url.length > 1000)) {
    return NextResponse.json({ error: "certificate_url must be ≤ 1000 chars." }, { status: 400 });
  }

  try {
    const created = await createCarbonOffset(access.partner_id, {
      shipment_id: body.shipment_id ?? undefined,
      co2_tons: body.co2_tons,
      offset_cost: body.offset_cost ?? undefined,
      currency: body.currency ?? undefined,
      offset_type: body.offset_type ?? undefined,
      certificate_url: body.certificate_url ?? undefined,
    });
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.carbon_offset_created",
        "marketplace_carbon_offsets",
        created.id,
        { co2_tons: created.co2_tons, offset_type: created.offset_type, offset_cost: created.offset_cost },
      );
    } catch (e) {
      console.error("[marketplace.esg.offsets.create] audit failed:", e);
    }
    return NextResponse.json(created, { status: 201 });
  } catch (e: any) {
    console.error("[marketplace.esg.offsets.create]", e);
    const msg = e?.message || "Failed to create carbon offset.";
    const status = /invalid|must be/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/esg/offsets");
export const POST = withApm(_post, "POST /api/marketplace/esg/offsets");
