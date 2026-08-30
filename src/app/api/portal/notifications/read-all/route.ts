import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getStore } from "@/lib/data/store";
import { audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * POST /api/portal/notifications/read-all
 *
 * Bulk "mark all as read" for a portal partner — fixes 2b2-F2.
 *
 * BEFORE this route existed, the portal-notifications page and the bell
 * dropdown's "Mark all read" buttons each fired N parallel PUTs to
 * `/api/portal/notifications/<id>/read`. Each PUT internally called
 * `listNotificationsByPartner` (unbounded SELECT *) and then
 * `.find(id)` — N² row reads per click. For a partner with 100 unread
 * notifications, a single click did 100 × full_table_scan = ~10,000
 * row reads.
 *
 * This route does a SINGLE `UPDATE notifications SET read_at = now(),
 * read = true WHERE partner_id = $1 AND tenant_id = $2 AND type IN
 * (PORTAL_SAFE_TYPES) AND read = false` — one SQL statement, one
 * round-trip. The store's `markAllNotificationsReadForPartner`
 * returns the count of rows actually updated (for the response
 * envelope + audit).
 *
 * 2b2-F2 — see worklog Task 2-b (round 2).
 */
export async function POST(req: NextRequest) {
  try {
    const access = await getPortalSessionAccess();
    if (!access) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    const store = await getStore();

    const updated = await store.markAllNotificationsReadForPartner(
      access.tenant_id,
      access.partner_id,
    );

    // Audit the bulk action — `updated` is the count of rows actually
    // flipped (which the UI can show as "Marked N as read"). Mirrors
    // the audit pattern in the per-id PUT route.
    try {
      await audit(
        store,
        {
          id: undefined,
          username: access.portal_email || `portal:${access.id}`,
          tenant_id: access.tenant_id,
        },
        req,
        "portal.notifications.marked_all_read",
        "notification",
        undefined,
        { updated_count: updated, partner_id: access.partner_id },
      );
    } catch (e) {
      console.error("[audit portal.notifications.marked_all_read]", e);
    }

    return NextResponse.json({ success: true, updated });
  } catch (e: any) {
    console.error("[portal.notifications.read-all]", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
