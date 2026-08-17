import { NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { unreadCountForPartner } from "@/lib/portal/messages";

export const runtime = "nodejs";

/** GET /api/portal/messages/unread → { count } for the sidebar badge. */
export async function GET() {
  const access = await getPortalSessionAccess();
  if (!access) return NextResponse.json({ count: 0 }, { status: 401 });
  try {
    const count = await unreadCountForPartner(access.tenant_id, access.partner_id, "portal");
    return NextResponse.json({ count });
  } catch {
    return NextResponse.json({ count: 0 });
  }
}
