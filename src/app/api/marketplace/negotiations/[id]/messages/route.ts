import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import {
  addNegotiationMessage,
  listNegotiationMessages,
} from "@/lib/data/marketplace-store";
import { getSupabase } from "@/lib/supabase/client";
import { sanitizeFields } from "@/lib/security/sanitize-input";
// 8c-3: validate the attachment_url against the platform's own
// attachment-URL allow-list. Without this, a malicious partner could
// send `attachment_url: "javascript:..."` or
// `"https://evil.example.com/phishing"` — the URL would be stored and
// later rendered as `<a href="..." target="_blank">` in
// `negotiation-room.tsx`, exposing the recipient to XSS / phishing.
import { sanitizeAttachmentUrl } from "@/lib/security/sanitize-attachment-url";
// 8b-10: per-portal-access rate limit on negotiation-message send —
// without this, a malicious partner can spam thousands of messages
// per minute, each triggering a notification + counterparty email +
// audit-log row. 20/min is well above any legit human typing speed.
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { notify } from "@/lib/notif/helper";
import { getStore } from "@/lib/data/store";
import { triggerWebhooks } from "@/lib/webhooks/deliver";
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

  // 8b-10: per-portal-access rate limit (20 msgs/min). See import comment.
  const rl = await checkRateLimit(`mkt-neg-msg:${access.id}`, 20, 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many messages. Please slow down." }, { status: 429 });
  }

  // 8c-11: negotiation status lock — fail-fast BEFORE body parse. The
  // previous implementation parsed the body, ran the rate-limit budget
  // against the recipient's notification queue, and only THEN called
  // addNegotiationMessage() — which threw on a terminal-status
  // negotiation. That meant a partner could keep hitting a closed /
  // rejected / signed negotiation and burn rate-limit budget + notification
  // attempts against a conversation the other side had already terminated.
  // This pre-check fetches the negotiation row's `status` column
  // directly; when it's in a terminal state, we 409 before any side
  // effect fires. System-message insert paths (cancel, accept-handshake,
  // contract-creation) bypass this check because they don't go through
  // this POST route — they write to marketplace_messages directly via
  // the store / supabase client from their own route handlers.
  //
  // The set of terminal states covers everything the spec calls out:
  //   • accepted — both parties shook hands; no further negotiation.
  //   • rejected — either party walked away.
  //   • expired — 48h auto-expiry or explicit expiry.
  //   • cancelled — admin / either-party cancellation.
  //   • signed — contract was countersigned; the room is now read-only.
  //   • closed — generic terminal lifecycle state.
  // `active` (and Phase 2's `awaiting` sub-state, when set) is the only
  // state in which a new message is allowed.
  {
    const sb = getSupabase();
    const { data: negRow, error: negErr } = await sb
      .from("marketplace_negotiations")
      .select("id, status, tenant_id_a, tenant_id_b, partner_id_a, partner_id_b")
      .eq("id", id)
      .maybeSingle();
    if (negErr) {
      console.error("[marketplace.messages.create] status pre-check failed:", negErr);
      return NextResponse.json({ error: "Failed to load negotiation." }, { status: 500 });
    }
    if (!negRow) {
      return NextResponse.json({ error: "Negotiation not found." }, { status: 404 });
    }
    const n = negRow as {
      id: string;
      status: string;
      tenant_id_a: string;
      tenant_id_b: string;
      partner_id_a: string;
      partner_id_b: string;
    };
    // Tenant + party membership check — a partner probing another tenant's
    // negotiation gets the same 404 as a missing row (no information leak).
    if (n.tenant_id_a !== access.tenant_id && n.tenant_id_b !== access.tenant_id) {
      return NextResponse.json({ error: "Negotiation not found." }, { status: 404 });
    }
    if (n.partner_id_a !== access.partner_id && n.partner_id_b !== access.partner_id) {
      return NextResponse.json({ error: "Negotiation not found." }, { status: 404 });
    }
    const TERMINAL_STATUSES = new Set([
      "accepted", "rejected", "expired", "cancelled", "signed", "closed",
    ]);
    if (TERMINAL_STATUSES.has(n.status)) {
      return NextResponse.json(
        { error: `Negotiation is ${n.status} — no further messages can be sent.` },
        { status: 409 },
      );
    }
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.message && typeof body.message === "string" && body.message.length > 10000) {
    return NextResponse.json({ error: "Message too long (max 10000 chars)." }, { status: 400 });
  }

  // 8c-6 / 8d-2: do NOT allow clients to forge `message_type: "system"`
  // — system messages are inserted by route handlers (cancel, accept,
  // contract creation) to record lifecycle events. Allowing a portal
  // client to write one would let them impersonate the platform in the
  // negotiation room (e.g. "System: this negotiation is now binding").
  const allowedTypes = ["text", "offer", "counter_offer", "accept", "reject", "document"];
  if (body.message_type && !allowedTypes.includes(body.message_type)) {
    return NextResponse.json({ error: "Invalid message_type." }, { status: 400 });
  }

  // 8c-3: sanitise the message body (HTML-entity escape) for the free-text
  // fields, then validate the attachment_url against the platform's own
  // attachment-URL allow-list. `sanitizeFields` alone is NOT enough — it
  // converts `< > \" '` to entities but accepts ANY URL scheme, including
  // `javascript:` (which React 16.9+ warns about but does NOT strip when
  // rendered as `<a href>`). The sanitiser rejects anything that's not a
  // path under `/api/portal-uploads/<uuid>/download` or
  // `/api/portal/attachments/<uuid>` — phishing / XSS URLs become `null`
  // and are stored as such (rather than rejected with a 400, so the rest
  // of the message body still goes through for a normal conversation).
  body = sanitizeFields(body, ["message"]);
  const safeAttachmentUrl = sanitizeAttachmentUrl(body.attachment_url);
  if (body.attachment_url && safeAttachmentUrl === null) {
    // The caller explicitly tried to attach a non-allow-listed URL —
    // log + drop the URL but keep the message body (could still be a
    // legit message with a malicious / fat-fingered link field).
    console.warn(
      `[marketplace.messages] attachment_url rejected by sanitiser — partner=${access.partner_id} negotiation=${id}`,
    );
  }

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
        // 8c-3: use the SANITISED attachment URL (null if it failed the
        // allow-list) — never the raw client-supplied value.
        attachment_url: safeAttachmentUrl,
      },
    );

    // ── Phase 2: notification + contact-reveal handshake ──────────────
    // Both are fire-and-forget — a failure here must NOT block the
    // sender's HTTP response (the message is already in the DB).
    //
    // (1) Notify the OTHER party that a new message arrived. We look
    //     up the negotiation row to find partner_id_a / partner_id_b
    //     and pick the one that ISN'T the caller.
    //
    // (2) When the sender just sent an 'accept' message, check whether
    //     the OTHER party has also sent an 'accept' message earlier in
    //     this negotiation. If BOTH sides have accepted, flip the
    //     negotiation's `contact_revealed` flag to TRUE so the room's
    //     Contact Info section unlocks for both parties.
    try {
      const sb = getSupabase();
      const { data: negRow } = await sb
        .from("marketplace_negotiations")
        .select("id, partner_id_a, partner_id_b, contact_revealed")
        .eq("id", id)
        .maybeSingle();
      const n = negRow as
        | {
            id: string;
            partner_id_a: string;
            partner_id_b: string;
            contact_revealed?: boolean;
          }
        | null;
      if (n) {
        const otherPartnerId =
          access.partner_id === n.partner_id_a
            ? n.partner_id_b
            : n.partner_id_a;

        // (1) Notification to the other party (any message type).
        // 8c-10: dedup key collapses a burst of messages in the same
        // negotiation into ONE notification per 5-minute window —
        // a partner typing 100 messages in 60s produces ONE bell-badge
        // entry for the recipient (not 100). The dedup is scoped by
        // (partner, type, entityType=marketplace_negotiation, entityId=
        // negotiation_id) so two parallel negotiations on the same post
        // don't collapse into each other. notify() consults the store's
        // new findRecentNotification() probe before the insert.
        if (otherPartnerId && otherPartnerId !== access.partner_id) {
          await notify({
            tenantId: access.tenant_id,
            partnerId: otherPartnerId,
            type: "marketplace_message_received",
            title: "New marketplace message",
            message: "You have a new message in a marketplace negotiation.",
            entityType: "marketplace_negotiation",
            entityId: id,
            actionUrl: `/portal/marketplace/negotiations/${id}`,
            actionLabel: "Open room",
            dedupKey: `marketplace_negotiation:${id}:message`,
            dedupWindowMs: 5 * 60 * 1000, // 5 min — one badge per burst
          });
        }

        // (2) Contact-reveal handshake: only when the caller just sent
        //     an 'accept' message. We check whether the other party
        //     has previously sent an 'accept' message in this same
        //     negotiation. If yes, flip contact_revealed = true.
        if (body.message_type === "accept" && !n.contact_revealed) {
          const { count } = await sb
            .from("marketplace_messages")
            .select("id", { count: "exact", head: true })
            .eq("negotiation_id", id)
            .eq("sender_partner_id", otherPartnerId)
            .eq("message_type", "accept");
          if ((count ?? 0) > 0) {
            // Both parties have sent an 'accept' → reveal contacts.
            await sb
              .from("marketplace_negotiations")
              .update({ contact_revealed: true })
              .eq("id", id);
            // Insert a system message announcing the contact reveal so
            // the chat thread surfaces the state change in-line.
            try {
              await sb.from("marketplace_messages").insert({
                negotiation_id: id,
                sender_partner_id: access.partner_id,
                message: null,
                message_type: "system",
                offer_data: null,
                attachment_url: null,
              });
            } catch (sysErr) {
              console.error(
                "[marketplace.messages.create] system-insert failed:",
                sysErr,
              );
            }
          }
        }
      }
    } catch (e) {
      console.error("[marketplace.messages.create] notify/reveal failed:", e);
    }

    // Phase 12 — fire marketplace.message_sent webhook (fire-and-forget).
    // Payload excludes the message body (which is free-text and could
    // contain sensitive negotiation terms); receivers that need the
    // body can call the auth-gated GET /api/marketplace/negotiations/[id]/messages
    // with their own API key.
    try {
      const store = await getStore();
      void triggerWebhooks(store, access.tenant_id, "marketplace.message_sent", "marketplace_message", created.id, {
        id: created.id,
        negotiation_id: created.negotiation_id,
        sender_partner_id: created.sender_partner_id,
        message_type: created.message_type,
        created_at: created.created_at,
      }).catch(() => {});
    } catch (e) {
      console.error("[marketplace.messages.create] webhook failed:", e);
    }

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
