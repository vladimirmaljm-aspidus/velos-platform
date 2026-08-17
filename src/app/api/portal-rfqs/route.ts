import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

// Admin: list all portal RFQs
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (portal.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "portal.read"); if (_d) return _d; } /* requirePermission wired */
    // Feature gate (module_portal)
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_portal", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    let tenantId = resolveTenantId(auth, req);
    // Super-admin without ?tenant_id= must not silently fall back to the first
    // tenant (which would leak / cross-show data). Return an empty list instead.
    if (!tenantId) {
      if (auth.isSuperAdmin) {
        return NextResponse.json({ items: [], total: 0 });
      }
      return NextResponse.json({ error: "No tenant context." }, { status: 400 });
    }
    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const partner_id = url.searchParams.get("partner_id") || undefined;
    const result = await auth.store.listPortalRfqs(tenantId, { search, filters: { status, partner_id } });
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
