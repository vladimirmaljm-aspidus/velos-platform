import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
// 31-f — items[] validation shared with the collection POST route (audit
// 30a-04: demands accepted malformed items and stored them verbatim).
// Same cross-route import pattern as partners/[id] importing
// whitelistPartnerFields from "@/app/api/partners/route".
import { validateDemandItems } from "@/app/api/demands/route";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(_req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (demands.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "demands.read"); if (_d) return _d; } /* requirePermission wired */

    const { id } = await params;
    const item = await auth.store.getDemand(id);
    if (!item) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && item.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json(item);
  } catch (error: any) {
    console.error("[demands GET id]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (demands.update)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "demands.update"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_crm)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_crm", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const existing = await auth.store.getDemand(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    // 31-f — guard the JSON parse (malformed body previously hit the
    // generic catch → 500) + items[] per-line validation (audit 30a-04:
    // same malformed-items acceptance as the POST route — the PUT path
    // feeds the same upsertDemand call, so the same 400 applies).
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    {
      const bad = validateDemandItems(body.items);
      if (bad) return bad;
    }
    // ADMIN-H5: if the caller is changing the partner_id, validate that
    // the new partner belongs to the SAME tenant as the demand itself.
    // Without this, a tenant admin could move a demand from their own
    // partner to another tenant's partner (the FK passes, but the
    // demand would now be cross-tenant-linked). Super-admin bypasses.
    if (body.partner_id && body.partner_id !== existing.partner_id) {
      const partner = await auth.store.getPartner(body.partner_id);
      if (!partner || partner.tenant_id !== existing.tenant_id) {
        return NextResponse.json({ error: "Not found." }, { status: 404 });
      }
    }
    const updated = await auth.store.upsertDemand({ ...body, id, tenant_id: existing.tenant_id });
    await audit(auth.store, auth.user, req, "demand.update", "demand", id, { status: updated.status });
    return NextResponse.json(updated);
  } catch (error: any) {
    console.error("[demands PUT id]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (demands.delete)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "demands.delete"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_crm)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_crm", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const existing = await auth.store.getDemand(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await auth.store.deleteDemand(id);
    await audit(auth.store, auth.user, req, "demand.delete", "demand", id);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("[demands DELETE id]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
