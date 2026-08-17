import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey, hasPermission, sanitizeError, type AuthContext, type ApiKeyAuthContext } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { renderPackingListPdf } from "@/lib/pdf/packing-list";

export const runtime = "nodejs";

// Admin: download the professional packing list PDF for a logistics request.
// F-FINAL: allow API key auth (Bearer asp_...) in addition to cookie sessions,
// matching the offer/invoice/proforma PDF routes — unblocks programmatic
// packing-list archive to external storage.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const auth = await requireAuthOrApiKey(_req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (logistics.read) — cookie session enforces via requirePermission,
  // API key enforces via hasPermission below.
  { const { requirePermission } = await import("@/lib/permissions/can");
    if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "logistics.read"); if (_d) return _d; } }
  // Feature gate (module_logistics)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_logistics", _isSA); if (_f) return _f; }
  if ("apiKeyId" in auth && !hasPermission(auth.permissions, "logistics:read")) {
    return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
  }

  const { id } = await params;
  const sb = getSupabase();
  const { data: lr } = await sb.from("logistics_requests").select("*").eq("id", id).maybeSingle();
  if (!lr) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
  if (!isSuperAdmin && (lr as any).tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const tenant = await auth.store.getTenant((lr as any).tenant_id);
  const buffer = await renderPackingListPdf(buildPackingListInput(lr as any, tenant?.name || "VELOS"));
  const bytes = new Uint8Array(buffer);
  return new Response(bytes as any, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="packing-list-${(lr as any).number || id}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
  } catch (error: any) {
    console.error("[logistics-requests.packing-list.pdf]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

function buildPackingListInput(lr: any, tenantName: string) {
  return {
    tenantName,
    requestNumber: lr.number,
    mode: lr.mode,
    containerType: lr.container_type,
    incoterm: lr.incoterm,
    createdAt: lr.created_at,
    targetPickupDate: lr.target_pickup_date,
    targetDeliveryDate: lr.target_delivery_date,
    origin: {
      company: lr.origin_company, address_line: lr.origin_address_line,
      city: lr.origin_city, postal_code: lr.origin_postal_code, country: lr.origin_country,
      port: lr.origin_port, contact_name: lr.origin_contact_name, contact_phone: lr.origin_contact_phone,
    },
    destination: {
      company: lr.destination_company, address_line: lr.destination_address_line,
      city: lr.destination_city, postal_code: lr.destination_postal_code, country: lr.destination_country,
      port: lr.destination_port, contact_name: lr.destination_contact_name, contact_phone: lr.destination_contact_phone,
    },
    cargo: {
      description: lr.cargo_description, hs_codes: lr.hs_codes,
      is_hazardous: lr.is_hazardous, is_temperature_controlled: lr.is_temperature_controlled,
      temperature_range: lr.temperature_range, insurance_required: lr.insurance_required,
      cargo_value: lr.cargo_value, cargo_currency: lr.cargo_currency,
      total_weight_kg: lr.total_weight_kg, total_volume_cbm: lr.total_volume_cbm, total_packages: lr.total_packages,
    },
    packingList: Array.isArray(lr.packing_list) ? lr.packing_list : [],
    specialInstructions: lr.special_instructions,
  };
}
