import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

// POST /api/erp/fiscal-periods/[id]/close — Close a fiscal period
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (erp.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "erp.close_period"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */


  const { id } = await params;
  try {
    const existing = await auth.store.getFiscalPeriod(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    // Tenant Ownership check
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (existing.status === "closed" || existing.status === "locked") {
      return NextResponse.json({ error: "Period is already closed or locked." }, { status: 400 });
    }

    const body = await req.json();
    const closedBy = body.closed_by || auth.user.id;

    const closed = await auth.store.closeFiscalPeriod(id, closedBy);
    await audit(auth.store, auth.user, req, "fiscal_period.close", "fiscal_period", id, {
      name: closed.name,
      closed_by: closedBy,
    });
    return NextResponse.json(closed);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
