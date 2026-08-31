import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, sanitizeError } from "@/lib/api/helpers";
import { listPortalUploads, summarizeByPartner } from "@/lib/portal/uploads";

export const runtime = "nodejs";

/**
 * GET /api/portal-uploads
 *   List uploads for the tenant. Params:
 *     partner_id   — filter to one partner
 *     category     — kyc|rfq|message|general|other
 *     search       — filename contains
 *     limit, offset
 *     summary=1    — return { partners: [{partner_id, total, last_upload, categories}] } instead
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "portal-uploads.read"); if (_d) return _d; }
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_portal", auth.isSuperAdmin); if (_f) return _f; }

    const tid = resolveTenantId(auth, req);
    if (!tid) return NextResponse.json({ items: [], total: 0, partners: [] });

    const url = new URL(req.url);
    if (url.searchParams.get("summary")) {
      const partners = await summarizeByPartner(tid);
      return NextResponse.json({ partners });
    }
    const { items, total } = await listPortalUploads(tid, {
      partnerId: url.searchParams.get("partner_id") || undefined,
      category: (url.searchParams.get("category") as any) || undefined,
      search: url.searchParams.get("search") || undefined,
      includeDeleted: url.searchParams.get("include_deleted") === "1",
      limit: Math.min(Number(url.searchParams.get("limit")) || 100, 500),
      offset: Number(url.searchParams.get("offset")) || 0,
    });
    return NextResponse.json({ items, total });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) || "Internal server error" }, { status: 500 });
  }
}
