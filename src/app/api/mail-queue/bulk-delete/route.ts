import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";

export const runtime = "nodejs";

// ADMIN-H1: bulk delete of (typically non-sent / failed) mail-queue
// rows. Previously this route existed but did NOT emit an audit_log
// entry, so a platform operator could purge hundreds of queued emails
// with no trail. We now log `mail.bulk_delete` with the status filter
// used, the number actually deleted, and whether the call crossed
// tenant boundaries (super-admin with no tenant context).
export async function DELETE(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (mail-queue.delete)
    {
      const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "mail-queue.delete");
      if (_d) return _d;
    } /* requirePermission wired */
    // Feature gate (module_mail_queue)
    {
      const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(
        auth.tenantId,
        "module_mail_queue",
        auth.isSuperAdmin,
      );
      if (_f) return _f;
    } /* requireFeature wired */

    const url = new URL(req.url);
    const statusFilter = url.searchParams.get("status") || undefined;
    const tid = resolveTenantId(auth, req);

    // Build the delete query. Non-super-admin callers are scoped to
    // their own tenant by RLS. Super-admin with no tenant context gets
    // the cross-tenant bulk delete (intentional — the mail-queue admin
    // page advertises this capability).
    let q = (auth.store as any)
      .sb()
      .from("mail_queue")
      .delete({ count: "exact" });
    if (tid) {
      q = q.eq("tenant_id", tid);
    }
    // If no status filter is supplied, default to deleting only non-sent
    // rows (everything that is NOT already `sent`) — purging sent mail
    // is rare and should be a deliberate, scoped operation.
    if (statusFilter) {
      q = q.eq("status", statusFilter);
    } else {
      q = q.neq("status", "sent");
    }

    const { count, error } = await q;
    if (error) throw error;

    const deletedCount = count ?? 0;

    try {
      await audit(
        auth.store,
        auth.user,
        req,
        "mail.bulk_delete",
        "mail_queue",
        undefined,
        {
          status_filter: statusFilter || "(non-sent)",
          deleted: deletedCount,
          cross_tenant: !tid,
        },
      );
    } catch (e) {
      console.error("[mail-queue bulk-delete audit]", e);
    }

    return NextResponse.json({ ok: true, deleted: deletedCount });
  } catch (e: any) {
    console.error("[mail-queue bulk-delete]", e);
    return NextResponse.json(
      { error: e.message || "Internal server error" },
      { status: 500 },
    );
  }
}
