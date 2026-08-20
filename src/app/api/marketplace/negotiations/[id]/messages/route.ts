import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import {
  addNegotiationMessage,
  listNegotiationMessages,
} from "@/lib/data/marketplace-store";
import { sanitizeFields } from "@/lib/security/sanitize-input";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/negotiations/[id]/messages — list messages in a
// negotiation. Caller must be a party to the negotiation.
async function _get(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const items = await listNegotiationMessages(id, access.tenant_id, access.partner_id);
    return NextResponse.json({ items });
  } catch (e: any) {
    console.error("[marketplace.messages.list]", e);
    return NextResponse.json({ error: "Failed to load messages." }, { status: 500 });
  }
}

// POST /api/marketplace/negotiations/[id]/messages — send a message.
// Caller must be a party to the negotiation (verified by the store).
async function _post(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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

  if (body.message && typeof body.message === "string" && body.message.length > 10000) {
    return NextResponse.json({ error: "Message too long (max 10000 chars)." }, { status: 400 });
  }

  const allowedTypes = ["text", "offer", "counter_offer", "accept", "reject", "document", "system"];
  if (body.message_type && !allowedTypes.includes(body.message_type)) {
    return NextResponse.json({ error: "Invalid message_type." }, { status: 400 });
  }

  body = sanitizeFields(body, ["message", "attachment_url"]);

  try {
    const created = await addNegotiationMessage(
      id,
      access.tenant_id,
      access.partner_id,
      {
        negotiation_id: id,
        message: body.message ?? null,
        message_type: body.message_type,
        offer_data: body.offer_data ?? null,
        attachment_url: body.attachment_url ?? null,
      },
    );
    return NextResponse.json(created);
  } catch (e: any) {
    console.error("[marketplace.messages.create]", e);
    const msg = e?.message || "Failed to send message.";
    const status = /not found|negotiation not found/i.test(msg) ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/negotiations/[id]/messages");
export const POST = withApm(_post, "POST /api/marketplace/negotiations/[id]/messages");
