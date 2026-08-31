import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { notify } from "@/lib/notif/helper";

export const runtime = "nodejs";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (portal.update)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "portal.rfq_update"); if (_d) return _d; } /* requirePermission wired */
    // Feature gate (module_portal)
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_portal", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    if (!auth.isSuperAdmin && auth.user.role !== "admin") {
      return NextResponse.json({ error: "Admin access required." }, { status: 403 });
    }
    const { id } = await params;
    // Tenant ownership check
    const existing = await auth.store.getPortalRfq(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const updated = await auth.store.upsertPortalRfq({ ...body, id, tenant_id: existing.tenant_id });
    await audit(auth.store, auth.user, req, "portal_rfq.update", "portal_rfq", id, { status: updated.status });

    // Notify the portal client when their RFQ gets a quote — this is the one
    // status change they're actively waiting on.
    if (updated.status === "quoted" && existing.status !== "quoted") {
      await notify({
        tenantId: updated.tenant_id,
        partnerId: updated.partner_id,
        type: "rfq_quoted",
        title: `Quote ready for ${updated.number}`,
        message: updated.target_price != null
          ? `${updated.currency || ""} ${updated.target_price} · ${updated.product_name}`
          : `Your request for ${updated.product_name} has been quoted.`,
        entityType: "portal_rfq",
        entityId: id,
        actionUrl: "/portal/rfq",
        actionLabel: "View quote",
      });
    }
    return NextResponse.json(updated);
  } catch (e: any) {
    console.error("[portal-rfqs.PUT]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (portal.delete)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "portal.rfq_update"); if (_d) return _d; } /* requirePermission wired */
    // Feature gate (module_portal)
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_portal", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    if (!auth.isSuperAdmin && auth.user.role !== "admin") {
      return NextResponse.json({ error: "Admin access required." }, { status: 403 });
    }
    const { id } = await params;
    const existing = await auth.store.getPortalRfq(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await auth.store.deletePortalRfq(id);
    await audit(auth.store, auth.user, req, "portal_rfq.delete", "portal_rfq", id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[portal-rfqs.DELETE]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}
