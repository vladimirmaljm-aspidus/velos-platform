import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (api-keys.delete)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "api-keys.delete"); if (_d) return _d; } /* requirePermission wired */
    // Feature gate (module_api_keys)
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_api_keys", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;

    // Verify the key belongs to the user's tenant.
    // listApiKeys ignores _tenantId in the store, so we fetch all and
    // filter for non-super_admin.
    const keys = await auth.store.listApiKeys(auth.tenantId!);
    const key = keys.find((k) => k.id === id);
    if (!key) {
      return NextResponse.json({ error: "API key not found." }, { status: 404 });
    }
    if (!auth.isSuperAdmin && key.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "API key not found." }, { status: 404 });
    }

    await auth.store.deleteApiKey(id);
    await audit(auth.store, auth.user, req, "api_key.delete", "api_key", id);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
