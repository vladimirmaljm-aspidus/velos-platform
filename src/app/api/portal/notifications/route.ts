import { NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getStore } from "@/lib/data/store";

export const runtime = "nodejs";

/**
 * GET /api/portal/notifications?limit=20
 *
 * List notifications for the logged-in portal partner.
 * Returns notifications that are either partner-specific or broadcast (partner_id = null).
 *
 * Response shape (PORTAL-L1):
 *   { items: Notification[], count: number, unread_count: number }
 * `count` is the number of items returned (after the optional `limit` slice);
 * `unread_count` is the number of unread items in the returned slice.
 *
 * Query:
 *   limit  — optional cap on the number of items returned (e.g. the bell
 *            dropdown only needs the most recent ~20). Defaults to "all".
 */
export async function GET(req: Request) {
  try {
    const access = await getPortalSessionAccess();
    if (!access) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }

    const store = await getStore();
    let items = await store.listNotificationsByPartner(access.tenant_id, access.partner_id);

    // PORTAL-L7 — honour the optional ?limit= so the bell fetch doesn't
    // load every notification ever issued for the tenant. Items are
    // returned newest-first by the store layer; slice AFTER sorting so
    // the limit takes the most recent N (the store currently returns
    // created_at DESC, but we sort defensively here so the limit is
    // stable regardless of the store's ordering).
    const url = new URL(req.url);
    const limitRaw = url.searchParams.get("limit");
    if (limitRaw) {
      const limit = Number.parseInt(limitRaw, 10);
      if (Number.isFinite(limit) && limit > 0) {
        items = items
          .slice()
          .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
          .slice(0, limit);
      }
    }

    // AUDIT2-LOGIC-UX M1 — compute unread_count from a SEPARATE total
    // count query, NOT from the (possibly sliced) items list. The bell
    // badge uses ?limit=20 so a partner with 50 unread previously saw a
    // badge of "20" (or less) — the underreported count masked the true
    // backlog. The store-side getUnreadCountByPartner runs a COUNT
    // WHERE read=false (no LIMIT) and returns the true total.
    let unreadCount = 0;
    try {
      unreadCount = await store.getUnreadCountByPartner(access.tenant_id, access.partner_id);
    } catch (e) {
      // Fall back to the sliced-items length if the COUNT query fails
      // (defense-in-depth — better to under-report than to 500).
      console.warn("[portal.notifications] getUnreadCountByPartner failed, using slice length:", e);
      unreadCount = items.filter((n) => !n.read).length;
    }

    return NextResponse.json({
      items,
      count: items.length,
      unread_count: unreadCount,
    });
  } catch (e: any) {
    console.error("[portal.notifications]", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
