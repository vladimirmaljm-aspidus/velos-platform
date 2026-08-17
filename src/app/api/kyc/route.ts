import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (kyc.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "kyc.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_kyc)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_kyc", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  let tenantId = resolveTenantId(auth, req);
  // Super-admin without ?tenant_id= must not silently fall back to the first
  // tenant (would leak / cross-show data). Return an empty list instead.
  if (!tenantId) {
    if (auth.isSuperAdmin) {
      return NextResponse.json({ items: [], total: 0 });
    }
    return NextResponse.json({ error: "No tenant context." }, { status: 400 });
  }
  const url = new URL(req.url);
  const search = url.searchParams.get("search") || undefined;
  const status = url.searchParams.get("status") || undefined;
  const result = await auth.store.listKycSubmissions(tenantId, { search, filters: { status } });
  return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
