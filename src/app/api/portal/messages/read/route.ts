import { NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { markThreadRead } from "@/lib/portal/messages";

export const runtime = "nodejs";

/**
 * POST /api/portal/messages/read → explicit "mark thread read" call.
 *
 * PORTAL-M7 — the GET /api/portal/messages handler used to call markThreadRead
 * on every fetch, but PortalMessages polls every 15s, so every incoming
 * admin→portal message was being marked read instantly even if the user had
 * never opened the thread. We moved marking-read out of the GET poll and into
 * this dedicated endpoint, which the frontend calls once on mount (and/or on
 * deliberate user focus) — not on every 15s poll.
 */
export async function POST() {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    await markThreadRead(access.tenant_id, access.partner_id, "portal").catch(
      () => {},
    );
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
