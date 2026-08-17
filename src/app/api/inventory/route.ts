import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (inventory.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "inventory.read"); if (_d) return _d; } /* requirePermission wired */
    // Feature gate (module_inventory)
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_inventory", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const tid = auth.tenantId!;
    const url = new URL(req.url);
    const partner_id = url.searchParams.get("partner_id") || undefined;
    const result = await auth.store.listAllInventory(tid, { filters: { partner_id } });
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
