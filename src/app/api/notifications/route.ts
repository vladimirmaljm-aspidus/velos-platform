import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (notifications.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "notifications.read"); if (_d) return _d; } /* requirePermission wired */

  const tenantId = resolveTenantId(auth, req);
  // FEAT-2 / Issue 1: Super-admins browsing the app WITHOUT a tenant
  // context (no ?tenant_id= and not impersonating) used to get an empty
  // bell — `resolveTenantId` returns null in that case and the early-return
  // below short-circuited to { items: [], unread_count: 0 }. That made
  // every super_admin think "we don't have any active notifications visible".
  // Fall back to the super_admin's OWN tenant_id (the tenant they're
  // attached to in the users table — typically the platform's primary
  // tenant in seeded environments, or their own tenant in self-serve
  // deployments). For super_admins without any tenant_id, we still return
  // empty (notifications.tenant_id is NOT NULL in the schema so there's no
  // platform-level row to surface).
  const effectiveTenantId = tenantId ?? (auth.isSuperAdmin ? (auth.user.tenant_id ?? null) : null);
  if (!effectiveTenantId) return NextResponse.json({ items: [], unread_count: 0 });

  const url = new URL(req.url);
  const unreadOnly = url.searchParams.get("unreadOnly") === "true";

  const [items, unreadCount] = await Promise.all([
    auth.store.listNotifications(effectiveTenantId, auth.user.id, unreadOnly),
    auth.store.getUnreadCount(effectiveTenantId, auth.user.id),
  ]);
  return NextResponse.json({ items, unread_count: unreadCount });
}

export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (notifications.update)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "notifications.update"); if (_d) return _d; } /* requirePermission wired */

  const tenantId = resolveTenantId(auth, req);
  // FEAT-2 / Issue 1: Same super_admin fallback as GET — without it, a
  // super_admin clicking "Mark all as read" would silently no-op because
  // tenantId was null and we returned early with `{ ok: true }`.
  const effectiveTenantId = tenantId ?? (auth.isSuperAdmin ? (auth.user.tenant_id ?? null) : null);
  if (!effectiveTenantId) return NextResponse.json({ ok: true });

  const url = new URL(req.url);
  const markAllRead = url.searchParams.get("markAllRead") === "true";

  if (markAllRead) {
    await auth.store.markAllNotificationsRead(effectiveTenantId, auth.user.id);
    try {
      await audit(auth.store, auth.user, req, "notification.mark_all_read", "notification", undefined, {});
    } catch (e) { console.error("[audit]", e); }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Invalid request" }, { status: 400 });
}
