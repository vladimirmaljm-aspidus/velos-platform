import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/data/store";
import { sendEmail } from "@/lib/email/service";
import { createPasswordReset } from "@/lib/auth/password-reset";
import { getIp } from "@/lib/api/helpers";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { getRateLimitConfig } from "@/lib/security/rate-limit-config";
import { escapeHtml } from "@/lib/security/escape-html";

export const runtime = "nodejs";

// F-7 (Rate Limiting): password-reset requests per IP are now configurable
// by super-admins via the Settings UI. Defaults: 5 / 15 min.
// Tighter than login because each request triggers an outbound email — an
// attacker could otherwise use this endpoint as an email-bomb vector
// against arbitrary inboxes. Always returns 200 + the same message so the
// 429 only leaks to the attacker themselves (defense-in-depth — the
// endpoint already returns a generic "if account exists" response).

/**
 * HTML-escape a string before interpolating into the email HTML body.
 * EMAIL-AUDIT (MEDIUM) — `tenant.name` is admin-settable; an admin
 * (or a malicious actor who compromised the admin session) could
 * rename a tenant to `<img src=x onerror=alert(1)>` and have it land
 * in the password reset email that goes to their own portal clients.
 * Same escape discipline as `src/lib/email/service.ts:escapeHtml`.
 */

/**
 * POST /api/portal/forgot-password
 * Body: { email: "client@example.com" }
 *
 * Sends a password reset email. Always returns 200 to prevent enumeration.
 * Token is stored HASHED in `password_resets` (plaintext token is only in the email).
 */
export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();
    if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "Valid email is required." }, { status: 400 });
    }

    // ── F-7: DB-backed per-IP rate limit ──────────────────────────────────
    // Checked BEFORE the email lookup so a flood of requests for arbitrary
    // addresses can't be used as an email-bomb vector. The 429 response is
    // distinct from the 200 "if account exists" message — only the attacker
    // themselves will see it (the legitimate user who fat-fingered 5 times
    // in 15 min will just have to wait, which is acceptable UX).
    const ip = getIp(req);
    const config = await getRateLimitConfig();
    const rl = await checkRateLimit(
      `portal-forgot-password:ip:${ip}`,
      config.forgotPasswordMaxAttempts,
      config.forgotPasswordWindowMs,
    );
    if (!rl.allowed) {
      const retryAfterSec = Math.ceil((rl.retryAfter ?? 60_000) / 1000);
      return NextResponse.json(
        { error: "Too many password-reset requests from this address. Try again later." },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
      );
    }

    const store = await getStore();

    // SEC-M6 (PORTAL-H10): the previous implementation iterated every
    // tenant (`for (const t of tenants) store.getPortalAccessByEmail(...)`)
    // — an N+1 that fired one DB query per tenant on every forgot-
    // password request. With ~10 tenants that's 10 sequential round
    // trips per request; the loop also caught the FIRST matching tenant
    // and silently ignored duplicate-email conflicts in later tenants.
    // `getPortalAccessByEmailAnyTenant` is a single tenant-agnostic
    // lookup (HMAC token + plaintext fallback) that returns the access
    // row plus its tenant_id in one query.
    const access = await store.getPortalAccessByEmailAnyTenant(email);
    let tenant: any = null;
    if (access) {
      tenant = (await store.getTenant(access.tenant_id)) || null;
    }

    // Always return the same message to prevent email enumeration.
    const genericOk = NextResponse.json({
      ok: true,
      message: "If an account exists for this email, a reset link has been sent.",
    });

    if (!access) return genericOk;

    // AUDIT15 — the access row exists but its tenant is gone (deleted
    // tenant). Previously `tenant.id` below threw a TypeError → 500 "Server
    // error", which leaks that the address exists (differs from the generic
    // 200) and pollutes the logs. Treat it exactly like a miss: generic OK,
    // no token, no email.
    if (!tenant) {
      console.warn(`[portal.forgot-password] portal_access ${access.id} references missing tenant ${access.tenant_id}; returning generic response`);
      return genericOk;
    }

    const ua = req.headers.get("user-agent") || null;

    const { token, expiresAt } = await createPasswordReset({
      targetType: "portal_access",
      targetId: access.id,
      tenantId: tenant.id,
      ip, userAgent: ua,
    });

    await store.appendAudit({
      tenant_id: tenant.id,
      user_id: null,
      username: `portal:${email}`,
      action: "portal.password_reset_requested",
      entity_type: "portal_access",
      entity_id: access.id,
      details: { email, expires_at: expiresAt },
      ip: ip || "unknown",
      user_agent: ua,
    });

    // SEC-L6 — prefer the Next.js public env var (required for
    // client-side rendering, so always present in production) and fall
    // back to APP_BASE_URL. Throw in production if NEITHER is set — the
    // previous hardcoded fallback `https://aspidus.onrender.com` was a
    // sandbox artifact that would have leaked into real customer
    // password-reset emails if the env was misconfigured.
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.APP_BASE_URL ||
      (process.env.NODE_ENV === "production"
        ? (() => {
            throw new Error("NEXT_PUBLIC_APP_URL or APP_BASE_URL required in production for portal password-reset emails");
          })()
        : "http://localhost:3000");
    const resetUrl = `${baseUrl}/portal/login?reset_token=${token}`;

    await sendEmail({
      to: email,
      subject: `Password Reset — ${tenant.name || "VELOS"}`,
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:32px 20px;">
          <div style="background:#0f766e;color:white;padding:24px 28px;border-radius:12px 12px 0 0;">
            <h1 style="margin:0;font-size:18px;font-weight:600;">Password Reset Request</h1>
            <p style="margin:6px 0 0;opacity:0.9;font-size:13px;">${escapeHtml(tenant.name || "VELOS")} Client Portal</p>
          </div>
          <div style="background:white;padding:28px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
            <p style="color:#333;font-size:14px;">Hello,</p>
            <p style="color:#555;font-size:14px;line-height:1.6;">
              We received a request to reset your portal password. Click the button below
              to set a new password. This link will expire in 1 hour.
            </p>
            <div style="text-align:center;margin:24px 0;">
              <a href="${resetUrl}" style="background:#0f766e;color:white;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;font-size:14px;">Reset My Password</a>
            </div>
            <p style="color:#888;font-size:12px;line-height:1.5;">
              If you didn't request this reset, you can safely ignore this email.
            </p>
          </div>
        </div>
      `,
      tenantId: tenant.id,
    });

    return genericOk;
  } catch (e: any) {
    console.error("[portal.forgot-password]", e);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
