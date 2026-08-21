import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getSupabase } from "@/lib/supabase/client";
import { getStore } from "@/lib/data/store";
import { renderPackingListPdf } from "@/lib/pdf/packing-list";

export const runtime = "nodejs";

// Portal client: download the packing list for their OWN logistics request.
// Ownership is enforced against the caller's partner_id + tenant_id — a
// request from another partner returns 404 (not 403) so we don't leak
// existence across tenants.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const access = await getPortalSessionAccess();
  if (!access) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const { id } = await params;
  const sb = getSupabase();
  const { data: lr } = await sb.from("logistics_requests").select("*").eq("id", id).maybeSingle();
  if (!lr) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if ((lr as any).partner_id !== access.partner_id || (lr as any).tenant_id !== access.tenant_id) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const store = await getStore();
  const tenant = await store.getTenant((lr as any).tenant_id);
  const buffer = await renderPackingListPdf({
    tenantName: tenant?.name || "VELOS",
    requestNumber: (lr as any).number,
    mode: (lr as any).mode,
    containerType: (lr as any).container_type,
    incoterm: (lr as any).incoterm,
    createdAt: (lr as any).created_at,
    targetPickupDate: (lr as any).target_pickup_date,
    targetDeliveryDate: (lr as any).target_delivery_date,
    origin: {
      company: (lr as any).origin_company, address_line: (lr as any).origin_address_line,
      city: (lr as any).origin_city, postal_code: (lr as any).origin_postal_code, country: (lr as any).origin_country,
      port: (lr as any).origin_port, contact_name: (lr as any).origin_contact_name, contact_phone: (lr as any).origin_contact_phone,
    },
    destination: {
      company: (lr as any).destination_company, address_line: (lr as any).destination_address_line,
      city: (lr as any).destination_city, postal_code: (lr as any).destination_postal_code, country: (lr as any).destination_country,
      port: (lr as any).destination_port, contact_name: (lr as any).destination_contact_name, contact_phone: (lr as any).destination_contact_phone,
    },
    cargo: {
      description: (lr as any).cargo_description, hs_codes: (lr as any).hs_codes,
      is_hazardous: (lr as any).is_hazardous, is_temperature_controlled: (lr as any).is_temperature_controlled,
      temperature_range: (lr as any).temperature_range, insurance_required: (lr as any).insurance_required,
      cargo_value: (lr as any).cargo_value, cargo_currency: (lr as any).cargo_currency,
      total_weight_kg: (lr as any).total_weight_kg, total_volume_cbm: (lr as any).total_volume_cbm, total_packages: (lr as any).total_packages,
    },
    packingList: Array.isArray((lr as any).packing_list) ? (lr as any).packing_list : [],
    specialInstructions: (lr as any).special_instructions,
  });
  const bytes = new Uint8Array(buffer);
  return new Response(bytes as any, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="packing-list-${(lr as any).number || id}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
