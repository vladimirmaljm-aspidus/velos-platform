import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, getIp, sanitizeError } from "@/lib/api/helpers";
import { sendEmail, welcomePortalEmail } from "@/lib/email/service";
import { notifyPortalInviteSent } from "@/lib/notif/helper";
import { createPasswordReset } from "@/lib/auth/password-reset";
// P0-3 / Feature 2 — field-level encryption. portal_email is encrypted at
// rest (enc: prefix) on the row; the invite route decrypts it before
// sending the welcome email so the recipient address is plaintext.
import { decryptField } from "@/lib/crypto/field-encryption";
import { checkRateLimit } from "@/lib/security/rate-limiter";

export const runtime = "nodejs";

// 7-day TTL for portal invite tokens (audit F-6/P1-3).
// Matches the "This link will expire in 7 days" copy in the welcome email.
const PORTAL_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// IDEMPOTENCY: minimum interval between invites to the SAME portal_access.
// Prevents the "spam invite" bug where a user (or a re-firing UI effect) can
// trigger dozens of invites + emails in seconds by clicking rapidly or
// re-rendering. 60s is generous for a genuine "I want to re-send" intent,
// tight enough to stop a runaway loop. Per-access_id rate limit (not per-IP)
// because the legitimate caller is always the same authenticated admin.
const RE_INVITE_MIN_INTERVAL_MS = 60 * 1000;

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

  // ── IDEMPOTENCY GUARD (email-spam fix) ─────────────────────────────────
  // If this portal_access was invited within the last RE_INVITE_MIN_INTERVAL_MS,
  // refuse the re-send. This stops the "Portal Invite Sent" notification +
  // welcome-email flood that happens when:
  //   • the admin double-clicks the Send Invite button (the button's
  //     `disabled` state is based on a local `inviteSending` useState that
  //     can be stale across rapid re-renders), or
  //   • a list view re-mounts and a UI effect re-fires the invite mutation,
  //   • a cron / retry loop re-triggers this endpoint.
  // Without this guard, every click mints a new setup_token + sends a new
  // email + creates a new "Portal Invite Sent" notification — which is
  // exactly the flood the user saw (same recipient, 1-2-3-4 minute intervals,
  // including recipients the admin did not intend to invite right now).
  // The guard is per-access_id (not per-IP) so a legit "re-send after 60s"
  // still works, but a runaway loop is capped at 1 email per minute per
  // portal account. Combined with the `checkRateLimit` below, this makes
  // the spam impossible even if the guard is somehow bypassed.
  if (access.invited_at) {
    const lastInviteMs = new Date(access.invited_at).getTime();
    const elapsedMs = Date.now() - lastInviteMs;
    if (Number.isFinite(lastInviteMs) && elapsedMs < RE_INVITE_MIN_INTERVAL_MS) {
      const retryAfterSec = Math.ceil((RE_INVITE_MIN_INTERVAL_MS - elapsedMs) / 1000);
      return NextResponse.json(
        {
          error: `An invite was sent to this portal account ${elapsedMs < 60_000 ? "just now" : Math.floor(elapsedMs / 1000) + "s ago"}. Please wait ${retryAfterSec}s before re-sending to avoid spamming the recipient.`,
          retry_after: retryAfterSec,
          already_sent: true,
        },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
      );
    }
  }

  // ── Per-access_id rate limit (defense-in-depth) ────────────────────────
  // Even if the idempotency guard above is somehow bypassed (clock skew,
  // concurrent requests racing the invited_at write), this caps re-sends to
  // 5 per 15 min per portal_access. The idempotency guard is the primary
  // defense; this is the backstop.
  const rl = await checkRateLimit(
    `portal-invite:${access.id}`,
    5,
    15 * 60 * 1000,
  );
  if (!rl.allowed) {
    const retryAfterSec = Math.ceil((rl.retryAfter ?? 60_000) / 1000);
    return NextResponse.json(
      { error: "Too many invites sent to this portal account recently. Please try again later.", retry_after: retryAfterSec },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
    );
  }

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
  // SEC-L6 — prefer the Next.js public env var (required for
  // client-side rendering, so always present in production) and fall
  // back to APP_BASE_URL. Throw in production if NEITHER is set — the
  // previous hardcoded fallback `https://aspidus.onrender.com` was a
  // sandbox artifact that would have leaked into real customer
  // invite emails if the env was misconfigured.
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_BASE_URL ||
    (process.env.NODE_ENV === "production"
      ? (() => {
          throw new Error("NEXT_PUBLIC_APP_URL or APP_BASE_URL required in production for portal invite emails");
        })()
      : "http://localhost:3000");

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

  // AUDIT15 / EMAIL-STATE — on a successful send, mark the welcome email
  // as sent. The route above resets `welcome_email_sent: false` before
  // sending (so a failed attempt shows as "Not sent" and the admin can
  // retry), but it previously NEVER flipped the flag back to true on
  // success. Production evidence: 5 of 8 portal_access rows were stuck
  // on "Not sent" in the partners UI even though their invites had gone
  // out — inviting the admin to re-send (and spam the client). KYC
  // automation and the change-email route already set this correctly;
  // this is the one path that didn't. Best-effort: a failure here must
  // not fail the (already-sent) invite response.
  if (result.success) {
    try {
      await auth.store.upsertPortalAccess({
        id: access.id,
        welcome_email_sent: true,
      } as any);
    } catch (flagErr) {
      console.error("[portal.invite] welcome_email_sent flag update failed:", flagErr);
    }
  }

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
    console.error("[portal-access.invite]", error);
    // SEC-L4 — never leak raw error.message. The invite chain spans
    // store + email + token-mint, any of which can raise a
    // PostgrestError whose .message leaks schema/column names.
    return NextResponse.json({ error: sanitizeError(error) || "Internal server error" }, { status: 500 });
  }
}
