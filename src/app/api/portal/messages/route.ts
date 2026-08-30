import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { listThread, insertMessage, markThreadRead, sanitizeMessageBody } from "@/lib/portal/messages";
import { sendEmail, newMessageEmail } from "@/lib/email/service";
import { getStore } from "@/lib/data/store";
import { audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * Allowed attachment_url patterns.
 * AUDIT2-LOGIC-UX C3 — portal clients could previously submit arbitrary URLs
 * (e.g. https://evil.com/phish) and have them rendered as clickable links in
 * the admin partners-view. We now require attachment_url to be null OR to
 * point at one of the two portal-upload download paths. Anything else is
 * silently stripped (the message still inserts with attachment_name/metadata
 * but no clickable URL), so a portal client cannot inject a phishing link.
 *
 * 2b2-F1 — added the SINGULAR portal-side download path
 * `/api/portal/attachments/<uuid>` (handled by the new
 * `src/app/api/portal/attachments/[id]/route.ts`). The frontend
 * portal-messages composer and marketplace negotiation-room upload
 * flow now use this URL form (it goes through `getPortalSessionAccess`,
 * NOT admin `requireAuth`). The legacy PLURAL admin path
 * `/api/portal-uploads/<uuid>/download` is still accepted so that
 * historical message rows continue to resolve (admins reading the
 * thread can still click through to the admin-scoped download).
 */
const ATTACHMENT_URL_RE_PLURAL = /^\/api\/portal-uploads\/[a-f0-9-]+\/download(\?|$)/;
const ATTACHMENT_URL_RE_SINGULAR = /^\/api\/portal\/attachments\/[a-f0-9-]+(\?|$)/;

function sanitizeAttachmentUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (!ATTACHMENT_URL_RE_PLURAL.test(value) && !ATTACHMENT_URL_RE_SINGULAR.test(value)) {
    return null;
  }
  return value;
}

/**
 * GET  /api/portal/messages          → returns full thread (no auto-mark-read).
 *                                       PORTAL-M7: previously the GET handler
 *                                       called markThreadRead on every fetch,
 *                                       but PortalMessages polls every 15s —
 *                                       that meant every incoming message was
 *                                       marked read instantly, even if the user
 *                                       never scrolled. Marking read is now an
 *                                       explicit user action (frontend calls
 *                                       /api/portal/messages/read on mount or
 *                                       focus).
 * POST /api/portal/messages          → portal client sends message to admin,
 *                                      notifies (in-app + email to tenant contact)
 */

export async function GET() {
  const access = await getPortalSessionAccess();
  if (!access) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  try {
    const items = await listThread(access.tenant_id, access.partner_id);
    return NextResponse.json({ items });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  let raw;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const body = sanitizeMessageBody(raw?.body ?? raw?.message);
  if (!body && !raw?.attachment_url) return NextResponse.json({ error: "Message body is required." }, { status: 400 });

  // AUDIT2-LOGIC-UX C3 — strip any attachment_url that does not point at the
  // admin-scoped portal-upload download path. attachment_name/type are kept
  // (the admin still sees a placeholder) but the href is dropped, so a
  // phishing URL the client injected is never rendered as a link.
  const safeAttachmentUrl = sanitizeAttachmentUrl(raw?.attachment_url);

  try {
    const msg = await insertMessage({
      tenant_id: access.tenant_id,
      partner_id: access.partner_id,
      portal_access_id: access.id,
      direction: "portal_to_admin",
      body,
      sender_username: `portal:${access.portal_email || access.id}`,
      sender_user_id: null,
      attachment_url: safeAttachmentUrl,
      attachment_name: raw?.attachment_name || null,
      attachment_type: raw?.attachment_type || null,
    });

    // Audit the sent message
    try {
      const auditStore = await getStore();
      await audit(
        auditStore,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "portal.message_sent",
        "portal_message",
        (msg as any)?.id,
        {
          body_preview: body.slice(0, 200),
          has_attachment: !!safeAttachmentUrl,
          attachment_name: raw?.attachment_name || null,
        },
      );
    } catch (e) { console.error("[audit]", e); }

    // Notify admins in-app + optionally email tenant contact.
    try {
      const store = await getStore();
      const partner = await store.getPartner(access.partner_id);
      await store.createNotification({
        tenant_id: access.tenant_id,
        user_id: null,
        partner_id: access.partner_id,
        type: "portal_message" as any,
        title: `New message from ${partner?.name || access.portal_email}`,
        message: body.slice(0, 200),
        entity_type: "portal_access",
        entity_id: access.id,
        action_url: `/portal-access?open=${access.id}`,
        action_label: "Open thread",
      } as any);

      const tenant = await store.getTenant(access.tenant_id);
      const notifyTo = tenant?.email;
      if (notifyTo) {
        const { subject, html } = newMessageEmail({
          toName: tenant?.name || "Team",
          fromName: partner?.name || access.portal_email || "Portal client",
          preview: body,
          tenantName: tenant?.name || "VELOS",
          portalUrl: `${process.env.APP_BASE_URL || ""}/portal-access?open=${access.id}`,
          direction: "portal_to_admin",
        });
        await sendEmail({ to: notifyTo, subject, html, tenantId: access.tenant_id }).catch(() => {});
      }
    } catch (e) { console.warn("[portal.messages.POST notify]", e); }

    return NextResponse.json(msg);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
