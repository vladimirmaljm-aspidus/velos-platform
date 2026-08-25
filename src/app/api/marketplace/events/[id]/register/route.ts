import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { registerForEvent, unregisterFromEvent } from "@/lib/data/marketplace-community-store";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";
import { getSupabase } from "@/lib/supabase/client";
import { notifyEventRegistered } from "@/lib/notif/helper";

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

    // FIX-NOTIF-A11Y: notify the event organiser that someone
    // registered for their event. Only fires on the actual
    // registration path (`result.registered === true`); the idempotent
    // "already registered" return value skips the notify so the
    // organiser isn't spammed by accidental double-clicks. Best-effort
    // — failures are caught inside notifyEventRegistered and never
    // break the response. We resolve the organiser + event title from
    // marketplace_events and the registrant's name from the partners
    // table via the store.
    if (result.registered) {
      try {
        const sb = getSupabase();
        const { data: eventRow } = await sb
          .from("marketplace_events")
          .select("organizer_partner_id, title")
          .eq("id", id)
          .maybeSingle();
        const evt = eventRow as { organizer_partner_id: string | null; title: string } | null;
        const organiserId = evt?.organizer_partner_id;
        const eventTitle = evt?.title || "your event";
        if (organiserId && organiserId !== access.partner_id) {
          let registrantName = "A partner";
          try {
            const store2 = await getStore();
            const reg = await store2.getPartner(access.partner_id);
            if (reg?.name) registrantName = reg.name;
          } catch {
            /* non-fatal — fallback name used */
          }
          void notifyEventRegistered(
            access.tenant_id,
            organiserId,
            id,
            eventTitle,
            registrantName,
          );
        }
      } catch (e) {
        console.error("[marketplace.community.events.register] notify failed:", e);
      }
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
