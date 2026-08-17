import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, getIp } from "@/lib/api/helpers";
import { sendEmail, welcomePortalEmail } from "@/lib/email/service";
import { notifyPortalInviteSent } from "@/lib/notif/helper";
import { createPasswordReset } from "@/lib/auth/password-reset";
// P0-3 / Feature 2 — field-level encryption. portal_email is encrypted at
// rest (enc: prefix) on the row; the invite route decrypts it before
// sending the welcome email so the recipient address is plaintext.
import { decryptField } from "@/lib/crypto/field-encryption";

export const runtime = "nodejs";

// 7-day TTL for portal invite tokens (audit F-6/P1-3).
// Matches the "This link will expire in 7 days" copy in the welcome email.
const PORTAL_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Send welcome email to a portal client with password setup link
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (portal.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "portal.invite"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_portal)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_portal", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  const { id } = await params;
  const access = await auth.store.getPortalAccessById(id);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  // Tenant ownership check
  if (!auth.isSuperAdmin && access.tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (!access.portal_email) return NextResponse.json({ error: "No portal email set." }, { status: 400 });
  // P0-3 / Feature 2: portal_email is stored encrypted (enc: prefix);
  // decrypt before sending the welcome email. Legacy plaintext rows pass
  // through untouched (decryptField is a no-op on non-enc: strings).
  const portalEmail = decryptField(access.portal_email);

  // Always refresh invite metadata; only downgrade status if not already active
  // (previously the `if (access.status !== "active")` guard meant re-inviting an
  // active user silently no-oped on invited_at / welcome_email_sent).
  const newStatus = access.status === "active" ? "active" : "invited";
  await auth.store.upsertPortalAccess({
    ...access,
    status: newStatus,
    invited_at: new Date().toISOString(),
    welcome_email_sent: false,
  });

  // ── Mint a single-use, 7-day-expiring setup token (audit F-6/P1-3) ──
  // Previously the invite email embedded the bare `access_id` UUID, which is
  // a permanent identifier that NEVER expires — a leaked/forwarded invite
  // could be used to set a password months later as long as
  // `must_set_password` was still true. We now reuse the existing
  // `password_resets` table (which already supports
  // `target_type: "portal_access"`) to mint a hashed, single-use,
  // 7-day-expiring token. The plaintext token goes only in the email link;
  // the database stores the SHA-256 hash so a DB leak cannot be replayed.
  // `createPasswordReset` also invalidates any prior outstanding tokens for
  // the same target so only the most recent invite link works.
  let setupToken: string | null = null;
  try {
    const issued = await createPasswordReset({
      targetType: "portal_access",
      targetId: access.id,
      tenantId: access.tenant_id,
      ip: getIp(req),
      userAgent: req.headers.get("user-agent") || null,
      ttlMs: PORTAL_INVITE_TTL_MS,
    });
    setupToken = issued.token;
  } catch (e) {
    // Fail-closed: if we can't mint a token, we MUST NOT send a permanent
    // access_id link — that's the very bug we're fixing. Surface the error
    // to the admin so they can retry.
    console.error("[portal.invite] createPasswordReset failed:", e);
    return NextResponse.json(
      { error: "Failed to issue a setup token. Please try again." },
      { status: 500 }
    );
  }

  const tenant = await auth.store.getTenant(access.tenant_id);
  const partner = await auth.store.getPartner(access.partner_id);
  const baseUrl = process.env.APP_BASE_URL || "https://aspidus.onrender.com";

  const { subject, html } = welcomePortalEmail({
    partnerName: partner?.name || "Client",
    portalEmail: portalEmail,
    accessId: access.id,
    tenantName: tenant?.name || "VELOS",
    baseUrl,
    tier: access.tier,
    setupToken,
  });

  const result = await sendEmail({
    to: portalEmail,
    subject,
    html,
    tenantId: access.tenant_id,
  });

  await audit(auth.store, auth.user, req, "portal.invite", "portal_access", id, {
    email: portalEmail,
    sent: result.success,
    token_issued: !!setupToken,
  });
  // Notify
  await notifyPortalInviteSent(access.tenant_id, partner?.name || "Client", portalEmail || "", id);

  if (!result.success) {
    return NextResponse.json({ error: "Email failed to send. Queued for retry.", details: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, sent: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
