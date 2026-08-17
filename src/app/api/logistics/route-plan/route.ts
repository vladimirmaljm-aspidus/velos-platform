import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { buildRoutePlan, type AddressInput } from "@/lib/logistics/route-plan";

export const runtime = "nodejs";

/**
 * POST /api/logistics/route-plan
 *
 * Computes a full door-to-door route plan (road → sea → road) for a
 * logistics request, or for manually supplied origin/destination fields.
 * Body: { requestId: string } | { origin: AddressInput, destination: AddressInput }
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "logistics.read"); if (_d) return _d; }
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_logistics", auth.isSuperAdmin); if (_f) return _f; }

    const body = await req.json().catch(() => ({}));
    let origin: AddressInput;
    let destination: AddressInput;

    if (body.requestId) {
      const tid = resolveTenantId(auth, req);
      if (!tid) return NextResponse.json({ error: "No tenant context" }, { status: 400 });
      const sb = getSupabase();
      const { data: lr, error } = await sb
        .from("logistics_requests")
        .select("*")
        .eq("id", body.requestId)
        .eq("tenant_id", tid)
        .maybeSingle();
      if (error || !lr) return NextResponse.json({ error: "Logistics request not found" }, { status: 404 });

      origin = {
        addressLine: lr.origin_address_line,
        city: lr.origin_city,
        state: lr.origin_state,
        postalCode: lr.origin_postal_code,
        country: lr.origin_country,
        port: lr.origin_port,
      };
      destination = {
        addressLine: lr.destination_address_line,
        city: lr.destination_city,
        state: lr.destination_state,
        postalCode: lr.destination_postal_code,
        country: lr.destination_country,
        port: lr.destination_port,
      };
    } else if (body.origin && body.destination) {
      origin = body.origin;
      destination = body.destination;
    } else {
      return NextResponse.json({ error: "Provide requestId or origin+destination" }, { status: 400 });
    }

    const plan = await buildRoutePlan(origin, destination);
    return NextResponse.json({ plan });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Failed to build route plan" }, { status: 500 });
  }
}
