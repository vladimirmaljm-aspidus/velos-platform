import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import {
  CLIENT_TRACKABLE_TYPES,
  sanitizeEventDetails,
  sanitizeEventLabel,
  trackPortalEvent,
} from "@/lib/portal/partner-events";
import type { PortalEventType } from "@/lib/portal/partner-events";

export const runtime = "nodejs";

/**
 * POST /api/portal/track — client-side partner-interest signals.
 *
 * The portal catalog / marketplace UI fires this when the client opens a
 * PRODUCT DETAIL drawer or submits a catalog search — the "what interests
 * them" signal that no server-side list endpoint can see (the catalog list
 * is fetched once and filtered client-side).
 *
 * Security posture:
 *   • Portal-session auth required (401 otherwise).
 *   • type whitelist (CLIENT_TRACKABLE_TYPES) — a browser can never forge
 *     login / download / bid events through this endpoint.
 *   • tenant_id / partner_id / portal_access_id are stamped from the
 *     session; body-supplied values are ignored.
 *   • label + details are sanitized + length-capped (partner-events.ts).
 *   • Fire-and-forget semantics: always 200 (silent no-op pre-migration-091).
 *
 * Deliberately NOT rate-limited like the auth routes: a client would have
 * to open hundreds of product drawers per minute to matter, the payload is
 * one small row, and the insert is capped by the table contract. The
 * shared middleware rate-limit layer still applies.
 */
export async function POST(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  let body: {
    type?: string;
    entity_id?: string;
    label?: string;
    details?: unknown;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.type || typeof body.type !== "string") {
    return NextResponse.json({ error: "type is required." }, { status: 400 });
  }
  if (!CLIENT_TRACKABLE_TYPES.includes(body.type)) {
    return NextResponse.json({ error: "Unsupported event type." }, { status: 400 });
  }

  // entity_id / label are informational only — clamp them hard.
  const entityId =
    typeof body.entity_id === "string" ? body.entity_id.slice(0, 64) : null;

  void trackPortalEvent(access, req, {
    type: body.type as PortalEventType,
    entity_type: body.type.startsWith("marketplace") ? "marketplace" : "product",
    entity_id: entityId,
    label: sanitizeEventLabel(body.label),
    details: sanitizeEventDetails(body.details),
  });

  return NextResponse.json({ ok: true });
}
