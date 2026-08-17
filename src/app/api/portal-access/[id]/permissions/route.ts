import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * PUT /api/portal-access/[id]/permissions
 *
 * Admin updates portal access permissions for a client.
 * Body: {
 *   can_view_offers, can_view_documents, can_view_catalog,
 *   can_view_invoices, can_view_profile, can_view_company_info,
 *   can_submit_rfq, can_download_pdf,
 *   exempt_kyc, exempt_document_upload, exempt_location_share,
 *   tier, status
 * }
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (portal.update)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "portal.manage"); if (_d) return _d; } /* requirePermission wired */
    // Feature gate (module_portal)
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_portal", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    if (!auth.isSuperAdmin && auth.user.role !== "admin") {
      return NextResponse.json({ error: "Admin access required." }, { status: 403 });
    }

    const { id } = await params;
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    // Whitelist permission fields
    const allowedFields = [
      "can_view_offers", "can_view_documents", "can_view_catalog",
      "can_view_invoices", "can_view_profile", "can_view_company_info",
      "can_submit_rfq", "can_download_pdf",
      "exempt_kyc", "exempt_document_upload", "exempt_location_share",
      "tier", "status", "portal_email", "portal_level",
    ];

    const update: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        update[field] = body[field];
      }
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "No valid fields to update." }, { status: 400 });
    }

    try {
      // Tenant ownership check
      const existing = await auth.store.getPortalAccessById(id);
      if (!existing) return NextResponse.json({ error: "Portal access not found." }, { status: 404 });
      if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
        return NextResponse.json({ error: "Portal access not found." }, { status: 404 });
      }
      const updated = await auth.store.upsertPortalAccess({ id, ...update });
      await audit(auth.store, auth.user, req, "portal_access.permissions_update", "portal_access", id, update);

      return NextResponse.json({ ...updated, password_hash: undefined });
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  } catch (e: any) {
    console.error("[portal-access.permissions.PUT]", e);
    return NextResponse.json({ error: e?.message || "Internal server error." }, { status: 500 });
  }
}
