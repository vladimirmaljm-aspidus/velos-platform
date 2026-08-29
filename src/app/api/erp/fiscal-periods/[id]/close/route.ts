import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, audit } from "@/lib/api/helpers";
import { assertNoSoDViolation } from "@/lib/permissions/sod-matrix";

export const runtime = "nodejs";

// POST /api/erp/fiscal-periods/[id]/close — Close a fiscal period
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (erp.close_period)
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

    // ADMIN-M17: Separation-of-Duties check. The user closing the period
    // must NOT be one of the users who posted a Journal Entry to it —
    // otherwise they're approving their own work (the classic SoD
    // violation that audit frameworks like SOC 2 CC7.2 and ISO 27001
    // A.6.3.1 specifically require controls against). We look up the
    // distinct user_ids who posted JEs (status="posted", posted_by NOT
    // NULL) into this period; if the current user is in that set, we
    // delegate to `assertNoSoDViolation` which walks the active SoD
    // matrix and returns 403 if the user holds both sides of any rule
    // (e.g. "JE creator cannot post their own entry" + this approval
    // step). Super-admin is bypassed by `assertNoSoDViolation` itself.
    if (auth.user.id) {
      const { data: jePosters } = await (auth.store as any)
        .sb()
        .from("erp_journal_entries")
        .select("posted_by")
        .eq("fiscal_period_id", id)
        .eq("status", "posted")
        .not("posted_by", "is", null);
      const posterIds = new Set<string>(
        ((jePosters as { posted_by: string }[] | null) || [])
          .map((r) => r.posted_by)
          .filter((uid): uid is string => !!uid),
      );
      if (posterIds.has(auth.user.id)) {
        const sodBlock = await assertNoSoDViolation(auth, auth.user.id, {
          create_perm: "erp.create",
          approve_perm: "erp.close_period",
        });
        if (sodBlock) return sodBlock;
      }
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
