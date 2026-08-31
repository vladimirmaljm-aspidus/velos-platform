import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (security.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "security.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_security)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_security", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  const tid = resolveTenantId(auth, req) ?? "";
  const url = new URL(req.url);
  const explicitUserId = url.searchParams.get("user_id");
  // Super-admin with no explicit user_id filter sees ALL known IPs system-wide.
  // Tenant admins/users default to their own known IPs.
  const userId = explicitUserId ?? (auth.isSuperAdmin ? undefined : auth.user.id);
  const items = await auth.store.listKnownIps(tid, userId);
  return NextResponse.json({ items });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) || "Internal server error" }, { status: 500 });
  }
}
