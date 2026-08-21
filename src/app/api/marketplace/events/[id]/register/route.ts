import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { registerForEvent, unregisterFromEvent } from "@/lib/data/marketplace-community-store";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// POST /api/marketplace/events/[id]/register — register for an event.
// Idempotent (UNIQUE (event_id, partner_id) at the DB level).
async function _post(req: NextRequest, ctx: RouteCtx) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const result = await registerForEvent(id, access.partner_id);
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.event_registered",
        "marketplace_event_registrations",
        id,
        { already_registered: !result.registered },
      );
    } catch (e) {
      console.error("[marketplace.community.events.register] audit failed:", e);
    }
    return NextResponse.json({
      registered: result.registered,
      registration: result.registration,
    });
  } catch (e: any) {
    console.error("[marketplace.community.events.register]", e);
    const msg = e?.message || "Failed to register for event.";
    const status = /not found/i.test(msg) ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

// DELETE /api/marketplace/events/[id]/register — unregister. Idempotent.
async function _delete(req: NextRequest, ctx: RouteCtx) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    await unregisterFromEvent(id, access.partner_id);
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.event_unregistered",
        "marketplace_event_registrations",
        id,
        {},
      );
    } catch (e) {
      console.error("[marketplace.community.events.unregister] audit failed:", e);
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[marketplace.community.events.unregister]", e);
    return NextResponse.json({ error: "Failed to unregister." }, { status: 500 });
  }
}

export const POST = withApm(_post, "POST /api/marketplace/events/[id]/register");
export const DELETE = withApm(_delete, "DELETE /api/marketplace/events/[id]/register");
