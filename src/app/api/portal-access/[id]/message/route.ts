import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { insertMessage, sanitizeMessageBody, markThreadRead, listThread } from "@/lib/portal/messages";
import { sendEmail, newMessageEmail } from "@/lib/email/service";
import { notifyNewMessage } from "@/lib/realtime/notify";
// AUDIT15 / EMAIL-ADDR — portal_email is encrypted at rest (enc: prefix,
// P0-3 / Feature 2). `getPortalAccessById` returns the row as stored, so
// the email must be decrypted before it is used as the To: address (and
// in the greeting). Legacy plaintext rows pass through untouched.
import { decryptField } from "@/lib/crypto/field-encryption";

export const runtime = "nodejs";

/**
 * GET  /api/portal-access/[id]/message  → full thread for this partner
 * POST /api/portal-access/[id]/message  body: { message, send_email? }
 *      Admin sends a message to the partner behind this portal_access.
 */

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(_req);
  if (auth instanceof NextResponse) return auth;
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "portal.read"); if (_d) return _d; }
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_portal", auth.isSuperAdmin); if (_f) return _f; }

  const { id } = await params;
  const access = await auth.store.getPortalAccessById(id);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!auth.isSuperAdmin && access.tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const items = await listThread(access.tenant_id, access.partner_id);
  await markThreadRead(access.tenant_id, access.partner_id, "admin").catch(() => {});
  return NextResponse.json({ items });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "portal.message"); if (_d) return _d; }
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_portal", auth.isSuperAdmin); if (_f) return _f; }

    if (!auth.isSuperAdmin && auth.user.role !== "admin") {
      return NextResponse.json({ error: "Admin access required." }, { status: 403 });
    }

    const { id } = await params;
    let _reqBody;
    try {
      _reqBody = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const { message, send_email, attachment_url, attachment_name, attachment_type } = _reqBody;
    const body = sanitizeMessageBody(message);
    if (!body) return NextResponse.json({ error: "Message is required." }, { status: 400 });

    const access = await auth.store.getPortalAccessById(id);
    if (!access) return NextResponse.json({ error: "Portal access not found." }, { status: 404 });
    if (!auth.isSuperAdmin && access.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Portal access not found." }, { status: 404 });
    }

    try {
      const msg = await insertMessage({
        tenant_id: access.tenant_id,
        partner_id: access.partner_id,
        portal_access_id: access.id,
        direction: "admin_to_portal",
        body,
        sender_username: auth.user.username,
        sender_user_id: auth.user.id,
        attachment_url: attachment_url || null,
        attachment_name: attachment_name || null,
        attachment_type: attachment_type || null,
      });

      // Notify the portal client via in-app notification (visible in portal).
      try {
        const tenant = await auth.store.getTenant(access.tenant_id);
        await auth.store.createNotification({
          tenant_id: access.tenant_id,
          user_id: null,
          partner_id: access.partner_id,
          type: "portal_message" as any,
          title: `New message from ${tenant?.name || "your account manager"}`,
          message: body.slice(0, 200),
          entity_type: "portal_access",
          entity_id: access.id,
          action_url: `/portal/messages`,
          action_label: "Open messages",
        } as any);
      } catch (e) { console.warn("[admin.message notify]", e); }

      if (send_email && access.portal_email) {
        // AUDIT15 / EMAIL-ADDR — decrypt before send; an `enc:` ciphertext
        // in the To: field is rejected by every provider (Postmark/Resend/
        // SMTP) which silently killed admin→client message emails for
        // every portal account created through the (encrypting) API route.
        const clientEmail = decryptField(access.portal_email);
        if (clientEmail && !clientEmail.startsWith("enc:")) {
          const tenant = await auth.store.getTenant(access.tenant_id);
          const { subject, html } = newMessageEmail({
            toName: clientEmail,
            fromName: tenant?.name || "VELOS",
            preview: body,
            tenantName: tenant?.name || "VELOS",
            // AUDIT15 — the hardcoded aspidus.onrender.com fallback was a
            // sandbox artifact; production sets APP_BASE_URL. Fall back to
            // a relative-free empty string is never OK for a link, so we
            // only send the email when a base URL is actually configured.
            portalUrl: process.env.APP_BASE_URL ? `${process.env.APP_BASE_URL}/portal/login` : "",
            direction: "admin_to_portal",
          });
          await sendEmail({ to: clientEmail, subject, html, tenantId: access.tenant_id }).catch((e) => console.warn("[admin.message.email]", e));
        }
      }

      await audit(auth.store, auth.user, req, "admin.message.sent", "portal_access", id, { partner_id: access.partner_id, preview: body.slice(0, 200) });

      // ── D-4: real-time push to the portal client ──────────────────────────
      // Fire-and-forget — the notification row has already been created above
      // (the `createNotification` call). This push just pings any open portal
      // tab so the partner sees the new message without a manual refresh.
      // `access.id` is the portal_access id which the portal-side realtime
      // hook will use as its socket identity (when wired up — admin SPA uses
      // `user.id` instead, see `src/hooks/use-realtime.ts`).
      void notifyNewMessage(access.tenant_id, access.id, {
        messageId: msg.id,
        partnerId: access.partner_id,
        direction: "admin_to_portal",
        preview: body.slice(0, 200),
        sender: auth.user.username,
      });

      return NextResponse.json(msg);
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  } catch (e: any) {
    console.error("[portal-access.message.POST]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}
