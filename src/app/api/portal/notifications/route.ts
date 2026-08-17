import { NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getStore } from "@/lib/data/store";

export const runtime = "nodejs";

/**
 * GET /api/portal/notifications
 *
 * List notifications for the logged-in portal partner.
 * Returns notifications that are either partner-specific or broadcast (partner_id = null).
 */
export async function GET() {
  try {
    const access = await getPortalSessionAccess();
    if (!access) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }

    const store = await getStore();
    const items = await store.listNotificationsByPartner(access.tenant_id, access.partner_id);

    return NextResponse.json({ items, total: items.length });
  } catch (e: any) {
    console.error("[portal.notifications]", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
