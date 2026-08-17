import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";

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
  // Super-admin with no explicit user_id filter sees ALL sessions system-wide.
  // Tenant admins/users default to their own sessions.
  const userId = explicitUserId ?? (auth.isSuperAdmin ? undefined : auth.user.id);
  const sessions = await auth.store.listSessions(tid, userId);
  return NextResponse.json({ items: sessions });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
