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
  if (!tenantId) return NextResponse.json({ items: [], unread_count: 0 });

  const url = new URL(req.url);
  const unreadOnly = url.searchParams.get("unreadOnly") === "true";

  const [items, unreadCount] = await Promise.all([
    auth.store.listNotifications(tenantId, auth.user.id, unreadOnly),
    auth.store.getUnreadCount(tenantId, auth.user.id),
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
  if (!tenantId) return NextResponse.json({ ok: true });

  const url = new URL(req.url);
  const markAllRead = url.searchParams.get("markAllRead") === "true";

  if (markAllRead) {
    await auth.store.markAllNotificationsRead(tenantId, auth.user.id);
    try {
      await audit(auth.store, auth.user, req, "notification.mark_all_read", "notification", undefined, {});
    } catch (e) { console.error("[audit]", e); }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Invalid request" }, { status: 400 });
}
