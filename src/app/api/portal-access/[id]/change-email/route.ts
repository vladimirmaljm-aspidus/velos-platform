import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, getIp, sanitizeError } from "@/lib/api/helpers";
import { sendEmail, welcomePortalEmail } from "@/lib/email/service";
import { createPasswordReset } from "@/lib/auth/password-reset";
// P0-3 / Feature 2 — field-level encryption. portal_email is encrypted at
// rest (enc: prefix) + a deterministic HMAC token (portal_email_hmac) for
// equality search (login, duplicate-check). The change-email flow reads
// the OLD email for the audit trail, writes the NEW email encrypted, and
// recomputes the HMAC. See src/lib/crypto/field-encryption.ts.
import { encryptField, decryptField, hmacField } from "@/lib/crypto/field-encryption";

export const runtime = "nodejs";

/**
 * POST /api/portal-access/[id]/change-email
 * body: { new_email: string, send_reset_link?: boolean, silent?: boolean }
 *
 * Admin changes the portal client's login email. This is destructive to the
 * client's ability to log in with the OLD address, so we:
 *   1. update portal_access.portal_email
 *   2. bump token_version → any existing session is invalidated
 *   3. flag must_set_password so the next login forces a new password
 *   4. by default send a "welcome" email to the NEW address containing a
 *      set-password link (unless silent=true)
 *   5. audit-log the change with the old + new address for the record
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "portal.change_email"); if (_d) return _d; }
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_portal", auth.isSuperAdmin); if (_f) return _f; }

    if (!auth.isSuperAdmin && auth.user.role !== "admin") {
      return NextResponse.json({ error: "Admin access required." }, { status: 403 });
    }

    const { id } = await params;
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const { new_email, send_reset_link = true, silent = false } = body;
    if (!new_email || typeof new_email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(new_email)) {
      return NextResponse.json({ error: "Valid email is required." }, { status: 400 });
    }

    const access = await auth.store.getPortalAccessById(id);
    if (!access) return NextResponse.json({ error: "Portal access not found." }, { status: 404 });
    if (!auth.isSuperAdmin && access.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Portal access not found." }, { status: 404 });
    }

    const oldEmail = decryptField(access.portal_email || "");
    if (oldEmail === new_email) {
      return NextResponse.json({ ok: true, message: "Email unchanged." });
    }

    // Guard: don't allow two portal_access rows to share the same email in the same tenant.
    // P0-3 / Feature 2: getPortalAccessByEmail looks up by HMAC token, so
    // this check works even when portal_email is encrypted at rest.
    const existing = await auth.store.getPortalAccessByEmail(access.tenant_id, new_email).catch(() => null);
    if (existing && existing.id !== id) {
      return NextResponse.json({ error: `Another portal account already uses ${new_email}.` }, { status: 409 });
    }

    const updated = await auth.store.upsertPortalAccess({
      id,
      portal_email: encryptField(new_email),
      // Recompute the HMAC token for the new plaintext email so login +
      // duplicate-check continue to find the row.
      portal_email_hmac: hmacField(new_email),
      // Force re-authentication with a new password.
      must_set_password: send_reset_link,
      token_version: (access.token_version || 0) + 1,
      welcome_email_sent: false,
    } as any);

    await audit(auth.store, auth.user, req, "portal_access.email_change", "portal_access", id, {
      old_email: oldEmail,
      new_email,
      sent_reset_link: !!send_reset_link,
    });

    // Optionally email the NEW address so the client knows to log in fresh.
    let email_sent: string | null = null;
    if (send_reset_link && !silent) {
      try {
        const tenant = await auth.store.getTenant(access.tenant_id);
        const partner = access.partner_id ? await auth.store.getPartner(access.partner_id) : null;
        // SEC-L6 — prefer the Next.js public env var (required for
        // client-side rendering, so always present in production) and
        // fall back to APP_BASE_URL. Throw in production if NEITHER is
        // set — the previous hardcoded fallback `https://aspidus.onrender.com`
        // was a sandbox artifact that would have leaked into real
        // customer emails if the env was misconfigured.
        const baseUrl =
          process.env.NEXT_PUBLIC_APP_URL ||
          process.env.APP_BASE_URL ||
          (process.env.NODE_ENV === "production"
            ? (() => {
                throw new Error("NEXT_PUBLIC_APP_URL or APP_BASE_URL required in production for portal change-email notifications");
              })()
            : "http://localhost:3000");
        // Audit F-6/P1-3: mint a single-use, 7-day-expiring setup token for
        // the NEW email address (the old invite token, if any, was tied to
        // the old email and is invalidated by createPasswordReset). Best-
        // effort: if minting fails, fall back to the legacy access_id link,
        // which the setup-password route will still honour for 7 days based
        // on invited_at.
        let setupToken: string | null = null;
        try {
          const issued = await createPasswordReset({
            targetType: "portal_access",
            targetId: id,
            tenantId: access.tenant_id,
            ip: getIp(req),
            userAgent: req.headers.get("user-agent") || null,
            ttlMs: 7 * 24 * 60 * 60 * 1000,
          });
          setupToken = issued.token;
        } catch (e) {
          console.warn("[change-email] createPasswordReset failed, falling back to access_id link:", e);
        }
        const { subject, html } = welcomePortalEmail({
          partnerName: partner?.name || "Client",
          portalEmail: new_email,
          accessId: id,
          tenantName: tenant?.name || "VELOS",
          baseUrl,
          tier: access.tier || "business",
          setupToken,
        });
        await sendEmail({ to: new_email, subject: `Portal email changed — ${subject}`, html, tenantId: access.tenant_id });
        email_sent = new_email;
        await auth.store.upsertPortalAccess({ id, welcome_email_sent: true } as any);
      } catch (e) { console.warn("[change-email.email]", e); }
    }

    // P0-3 / Feature 2: decrypt portal_email for the response so the admin
    // UI shows plaintext, and strip the HMAC column (internal-only).
    const { password_hash: _omitPw, portal_email_hmac: _omitHmac, ...safeUpdated } = updated as any;
    if (safeUpdated.portal_email && typeof safeUpdated.portal_email === "string") {
      safeUpdated.portal_email = decryptField(safeUpdated.portal_email);
    }
    return NextResponse.json({ ok: true, updated: safeUpdated, email_sent });
  } catch (e: any) {
    console.error("[portal-access.change-email.POST]", e);
    // SEC-L4 — never leak raw e?.message. The change-email chain spans
    // store + email + token-mint + HMAC recompute; a PostgrestError
    // .message would leak the portal_email / portal_email_hmac column
    // names + constraint names to the admin client. Sanitize first.
    return NextResponse.json({ error: sanitizeError(e) || "Internal server error." }, { status: 500 });
  }
}
