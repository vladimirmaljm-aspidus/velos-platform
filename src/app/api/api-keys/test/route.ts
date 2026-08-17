import { NextRequest, NextResponse } from "next/server";
import { requireApiKeyAuth, hasPermission } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * Test API key authentication.
 * GET /api/api-keys/test — verifies the API key and returns auth context info.
 *
 * FIX (audit P3-26): no longer returns partner_count / product_count —
 * that's minor info disclosure. Only returns whether the key is valid
 * and what permissions it has.
 */
export async function GET(req: NextRequest) {
  const auth = await requireApiKeyAuth(req);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({
    authenticated: true,
    method: "api_key",
    key_name: auth.apiKeyName,
    tenant_id: auth.tenantId,
    permissions: auth.permissions,
    can_read_partners: hasPermission(auth.permissions, "partners:read"),
    can_write_partners: hasPermission(auth.permissions, "partners:write"),
    can_read_offers: hasPermission(auth.permissions, "offers:read"),
    can_write_offers: hasPermission(auth.permissions, "offers:write"),
    can_read_products: hasPermission(auth.permissions, "products:read"),
    can_write_products: hasPermission(auth.permissions, "products:write"),
  });
}
