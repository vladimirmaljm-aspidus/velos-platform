import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
// 8c-2: KYC gate — mirror top-level marketplace POST route. Without this,
// a portal client whose KYC is `rejected` / `suspended` could still create
// shipments / sign trade documents / post community content — binding
// commitments that affect counterparty's downstream flows.
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { createEvent, listEvents } from "@/lib/data/marketplace-community-store";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";
import type { EventType } from "@/lib/supabase/marketplace-community-types";

export const runtime = "nodejs";

const VALID_EVENT_TYPES: EventType[] = [
  "conference", "webinar", "trade_show", "auction", "meeting", "workshop",
];

// GET /api/marketplace/events — list events (default: upcoming).
// Optional query: ?event_type=&upcoming=1&search=&limit=50&offset=0
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    const url = new URL(req.url);
    const event_type = url.searchParams.get("event_type") as EventType | null;
    const upcoming = url.searchParams.get("upcoming") !== "0"; // default true
    const search = url.searchParams.get("search") || undefined;
    const limit = url.searchParams.get("limit");
    const offset = url.searchParams.get("offset");
    if (event_type && !VALID_EVENT_TYPES.includes(event_type)) {
      return NextResponse.json({ error: "Invalid event_type." }, { status: 400 });
    }
    const items = await listEvents({
      event_type: event_type || undefined,
      upcoming,
      search,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return NextResponse.json(items);
  } catch (e: any) {
    console.error("[marketplace.community.events.list]", e);
    return NextResponse.json({ error: "Failed to load events." }, { status: 500 });
  }
}

// POST /api/marketplace/events — create an event. The caller becomes the
// organizer; only the organizer can later PUT/DELETE the event.
// Body: { title, description?, event_type?, start_date, end_date,
//         location?, is_online?, meeting_url? }
async function _post(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // 8c-2: KYC gate — defence-in-depth, mirror top-level marketplace POST.
  const _kycBlock = await requireKycApproved(access);
  if (_kycBlock) return _kycBlock;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.title !== "string" || body.title.length < 3 || body.title.length > 200) {
    return NextResponse.json({ error: "title must be 3–200 chars." }, { status: 400 });
  }
  if (typeof body.start_date !== "string" || Number.isNaN(Date.parse(body.start_date))) {
    return NextResponse.json({ error: "start_date must be an ISO 8601 date string." }, { status: 400 });
  }
  if (typeof body.end_date !== "string" || Number.isNaN(Date.parse(body.end_date))) {
    return NextResponse.json({ error: "end_date must be an ISO 8601 date string." }, { status: 400 });
  }
  if (Date.parse(body.end_date) < Date.parse(body.start_date)) {
    return NextResponse.json({ error: "end_date must be after start_date." }, { status: 400 });
  }
  if (body.event_type !== undefined && body.event_type !== null && !VALID_EVENT_TYPES.includes(body.event_type)) {
    return NextResponse.json({ error: "Invalid event_type." }, { status: 400 });
  }
  if (body.location && (typeof body.location !== "string" || body.location.length > 300)) {
    return NextResponse.json({ error: "location must be ≤ 300 chars." }, { status: 400 });
  }
  if (body.meeting_url && (typeof body.meeting_url !== "string" || body.meeting_url.length > 500)) {
    return NextResponse.json({ error: "meeting_url must be ≤ 500 chars." }, { status: 400 });
  }

  try {
    const created = await createEvent(access.partner_id, {
      title: body.title,
      description: body.description ?? undefined,
      event_type: body.event_type ?? undefined,
      start_date: body.start_date,
      end_date: body.end_date,
      location: body.location ?? undefined,
      is_online: typeof body.is_online === "boolean" ? body.is_online : undefined,
      meeting_url: body.meeting_url ?? undefined,
    });
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.event_created",
        "marketplace_events",
        created.id,
        { title: created.title, start_date: created.start_date },
      );
    } catch (e) {
      console.error("[marketplace.community.events.create] audit failed:", e);
    }
    return NextResponse.json(created, { status: 201 });
  } catch (e: any) {
    console.error("[marketplace.community.events.create]", e);
    const msg = sanitizeError(e);
    const status = /invalid|must be|after/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/events");
export const POST = withApm(_post, "POST /api/marketplace/events");
