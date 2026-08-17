import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (security.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "security.delete"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_security)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_security", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  const { id } = await params;
  if (!auth.isSuperAdmin) {
    const owned = await auth.store.listTrustedDevices(auth.tenantId || "");
    if (!owned.some((x) => x.id === id)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
  }
  await auth.store.revokeTrustedDevice(id);
  await audit(auth.store, auth.user, req, "device.revoke", "trusted_device", id);
  return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
