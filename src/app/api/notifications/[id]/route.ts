import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (notifications.update)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "notifications.update"); if (_d) return _d; } /* requirePermission wired */

    const { id } = await params;
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (body.read) {
      const existing = await auth.store.getNotificationById(id);
      if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
      if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
        return NextResponse.json({ error: "Not found." }, { status: 404 });
      }
      // AUDIT19 / F6 — in-tenant horizontal access: tenant match alone let
      // any notifications:update holder mark-read ANY user's notification
      // in the same tenant. Notifications are per-user inboxes (user_id is
      // set on every targeted notification; null = tenant broadcast, which
      // any tenant member may mark read). Super-admins keep cross-user
      // access for support workflows.
      if (
        !auth.isSuperAdmin &&
        (existing as any).user_id &&
        (existing as any).user_id !== auth.user.id
      ) {
        return NextResponse.json({ error: "Not found." }, { status: 404 });
      }
      // CRITICAL FIX (audit A3): pass the notification's tenant_id to scope
      // the UPDATE. For regular users this matches auth.tenantId (verified
      // above); for super-admins we use the notification's actual tenant so
      // cross-tenant admin actions still work.
      await auth.store.markNotificationRead(id, existing.tenant_id);
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[notifications.PUT]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Mark all as read for this user
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (notifications.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "notifications.update"); if (_d) return _d; } /* requirePermission wired */

    const url = new URL(req.url);
    const action = url.searchParams.get("action");
    if (action === "mark_all_read") {
      const tid = resolveTenantId(auth, req);
      if (!tid) {
        // Super-admin without tenant context — return success with 0 updated.
        return NextResponse.json({ ok: true, updated: 0 });
      }
      await auth.store.markAllNotificationsRead(tid, auth.user.id);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (e: any) {
    console.error("[notifications.POST]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (notifications.delete)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "notifications.delete"); if (_d) return _d; } /* requirePermission wired */

    const { id } = await params;
    // Use a direct fetch by ID — works for both regular users (tenant-scoped
    // at the policy level) and super_admin (no scope). (Audit finding H-9.)
    const { data: existing, error } = await (auth.store as any)
      .sb()
      .from("notifications")
      .select("id, tenant_id, user_id")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    // Tenant ownership check for non-super-admins.
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    // AUDIT19 / F6 — same in-tenant horizontal rule as the PUT above: a
    // notifications:delete holder may only delete their OWN targeted
    // notifications (user_id null = broadcast — deletable by any tenant
    // member with the permission).
    if (
      !auth.isSuperAdmin &&
      existing.user_id &&
      existing.user_id !== auth.user.id
    ) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await auth.store.deleteNotification(id);
    try {
      await audit(auth.store, auth.user, req, "notification.delete", "notification", id, {});
    } catch (e) { console.error("[audit]", e); }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[notifications.DELETE]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}
