import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { deleteEvent, getEvent, isRegisteredForEvent, updateEvent } from "@/lib/data/marketplace-community-store";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";
import type { EventType } from "@/lib/supabase/marketplace-community-types";

export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const VALID_EVENT_TYPES: EventType[] = [
  "conference", "webinar", "trade_show", "auction", "meeting", "workshop",
];

// GET /api/marketplace/events/[id] — fetch one event + the caller's
// registration status (so the UI can render the "Register"/"Registered"
// button without an extra round-trip).
async function _get(req: NextRequest, ctx: RouteCtx) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const event = await getEvent(id);
    if (!event) {
      return NextResponse.json({ error: "Event not found." }, { status: 404 });
    }
    const registered = await isRegisteredForEvent(id, access.partner_id);
    return NextResponse.json({ event, registered });
  } catch (e: any) {
    console.error("[marketplace.community.events.get]", e);
    return NextResponse.json({ error: "Failed to load event." }, { status: 500 });
  }
}

// PUT /api/marketplace/events/[id] — update an event (organizer only).
async function _put(req: NextRequest, ctx: RouteCtx) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Validate any supplied fields.
  if (body.title !== undefined && (typeof body.title !== "string" || body.title.length < 3 || body.title.length > 200)) {
    return NextResponse.json({ error: "title must be 3–200 chars." }, { status: 400 });
  }
  if (body.event_type !== undefined && body.event_type !== null && !VALID_EVENT_TYPES.includes(body.event_type)) {
    return NextResponse.json({ error: "Invalid event_type." }, { status: 400 });
  }
  if (body.start_date !== undefined && (typeof body.start_date !== "string" || Number.isNaN(Date.parse(body.start_date)))) {
    return NextResponse.json({ error: "start_date must be an ISO 8601 date string." }, { status: 400 });
  }
  if (body.end_date !== undefined && (typeof body.end_date !== "string" || Number.isNaN(Date.parse(body.end_date)))) {
    return NextResponse.json({ error: "end_date must be an ISO 8601 date string." }, { status: 400 });
  }
  if (body.start_date && body.end_date && Date.parse(body.end_date) < Date.parse(body.start_date)) {
    return NextResponse.json({ error: "end_date must be after start_date." }, { status: 400 });
  }

  try {
    const updated = await updateEvent(id, access.partner_id, {
      title: body.title,
      description: body.description ?? undefined,
      event_type: body.event_type ?? undefined,
      start_date: body.start_date,
      end_date: body.end_date,
      location: body.location ?? undefined,
      is_online: typeof body.is_online === "boolean" ? body.is_online : undefined,
      meeting_url: body.meeting_url ?? undefined,
    });
    if (!updated) {
      return NextResponse.json({ error: "Event not found." }, { status: 404 });
    }
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.event_updated",
        "marketplace_events",
        updated.id,
        {},
      );
    } catch (e) {
      console.error("[marketplace.community.events.update] audit failed:", e);
    }
    return NextResponse.json(updated);
  } catch (e: any) {
    console.error("[marketplace.community.events.update]", e);
    const msg = sanitizeError(e);
    const status = /authorised/i.test(msg) ? 403 : /invalid|must be|after/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

// DELETE /api/marketplace/events/[id] — organizer only. Cascades to registrations.
async function _delete(req: NextRequest, ctx: RouteCtx) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const ok = await deleteEvent(id, access.partner_id);
    if (!ok) {
      return NextResponse.json({ error: "Event not found." }, { status: 404 });
    }
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.event_deleted",
        "marketplace_events",
        id,
        {},
      );
    } catch (e) {
      console.error("[marketplace.community.events.delete] audit failed:", e);
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[marketplace.community.events.delete]", e);
    const msg = sanitizeError(e);
    const status = /authorised/i.test(msg) ? 403 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/events/[id]");
export const PUT = withApm(_put, "PUT /api/marketplace/events/[id]");
export const DELETE = withApm(_delete, "DELETE /api/marketplace/events/[id]");
