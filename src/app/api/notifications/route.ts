import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

// ── NOTIF-UX / Pagination + type filter ─────────────────────────────────────
// The previous GET returned the entire tenant notification list and the
// topbar sliced to 10 client-side. That worked for the bell but every
// full-page view fetched every row. We now accept `limit` / `offset` /
// `type` / `q` query params so the full-page Notifications view can paginate
// and filter without pulling the full history. The previous `unreadOnly`
// param is still supported for backward compatibility (the bell still uses
// it); `unreadOnly=true` is equivalent to `read=unread`.
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function parseLimit(v: string | null): number {
  const n = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(v) || DEFAULT_PAGE_SIZE));
  return Number.isFinite(n) ? n : DEFAULT_PAGE_SIZE;
}
function parseOffset(v: string | null): number {
  const n = Math.max(0, Number(v) || 0);
  return Number.isFinite(n) ? n : 0;
}

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
  if (!effectiveTenantId) return NextResponse.json({ items: [], unread_count: 0, total: 0 });

  const url = new URL(req.url);
  const unreadOnly = url.searchParams.get("unreadOnly") === "true";
  // NOTIF-UX: read filter — "all" (default), "unread", "read".
  const readFilter = url.searchParams.get("read"); // "unread" | "read" | null
  const typeFilter = url.searchParams.get("type"); // "offer" | "invoice" | ... (group)
  const search = (url.searchParams.get("q") || "").trim().toLowerCase();
  const limit = parseLimit(url.searchParams.get("limit"));
  const offset = parseOffset(url.searchParams.get("offset"));

  // Map group filter → set of notification types. Each group covers the
  // NotificationType variants that "belong" to that family.
  const TYPE_GROUPS: Record<string, string[]> = {
    offer: ["offer_sent", "offer_accepted", "offer_rejected", "offer_expired", "offer_countered"],
    invoice: ["invoice_sent", "invoice_overdue", "invoice_paid"],
    proforma: ["proforma_sent", "proforma_accepted", "proforma_rejected"],
    message: ["portal_message", "marketplace_message_received", "email_failed"],
    kyc: ["kyc_submitted", "kyc_approved", "kyc_rejected"],
    marketplace: [
      "marketplace_response_received", "marketplace_response_accepted",
      "marketplace_response_rejected", "marketplace_message_received",
    ],
    portal: [
      "rfq_received", "rfq_quoted", "portal_access_requested",
      "portal_access_approved", "portal_invite_sent", "document_shared",
    ],
    task: ["task_assigned", "task_due_soon"],
    system: ["system_message", "low_stock_alert", "signup_request"],
  };

  const [items, unreadCount] = await Promise.all([
    auth.store.listNotifications(effectiveTenantId, auth.user.id, unreadOnly),
    auth.store.getUnreadCount(effectiveTenantId, auth.user.id),
  ]);

  // Apply read filter on top of unreadOnly for fine-grained "read only" view.
  let filtered = items;
  if (readFilter === "read") filtered = filtered.filter((n) => n.read);
  else if (readFilter === "unread") filtered = filtered.filter((n) => !n.read);
  else if (unreadOnly) filtered = filtered.filter((n) => !n.read);

  // Group filter — accept either a group key ("offer") or a literal type.
  if (typeFilter) {
    const group = TYPE_GROUPS[typeFilter];
    const set = new Set(group ?? [typeFilter]);
    filtered = filtered.filter((n) => set.has(n.type));
  }

  // Search filter — title + message contains (case-insensitive).
  if (search) {
    filtered = filtered.filter(
      (n) =>
        (n.title || "").toLowerCase().includes(search) ||
        (n.message || "").toLowerCase().includes(search),
    );
  }

  const total = filtered.length;
  const paged = filtered.slice(offset, offset + limit);

  return NextResponse.json({
    items: paged,
    unread_count: unreadCount,
    total,
    limit,
    offset,
  });
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

  // NOTIF-UX: per-item "mark as read". When the body carries `{ id }` we
  // mark just that one notification. Without a body (or with
  // `?markAllRead=true`) we mark every notification for this user.
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // Empty body = mark-all (existing behaviour, preserved for back-compat
    // with the topbar's existing `markAllRead()` call which sends no body).
    body = {};
  }

  if (markAllRead || !body || !body.id) {
    await auth.store.markAllNotificationsRead(effectiveTenantId, auth.user.id);
    try {
      await audit(auth.store, auth.user, req, "notification.mark_all_read", "notification", undefined, {});
    } catch (e) { console.error("[audit]", e); }
    return NextResponse.json({ ok: true });
  }

  // Per-item mark read. Look up first to enforce tenant ownership (audit
  // A3) — same pattern as the dynamic [id] route.
  const existing = await auth.store.getNotificationById(body.id);
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  // Use the notification's actual tenant for the UPDATE so super-admins
  // operating cross-tenant still mark the right row.
  await auth.store.markNotificationRead(body.id, existing.tenant_id);
  try {
    await audit(auth.store, auth.user, req, "notification.mark_read", "notification", body.id, {});
  } catch (e) { console.error("[audit]", e); }
  return NextResponse.json({ ok: true });
}
