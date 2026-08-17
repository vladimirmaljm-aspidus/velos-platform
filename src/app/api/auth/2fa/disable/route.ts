import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError, getIp } from "@/lib/api/helpers";
import { verifyTotp } from "@/lib/auth/totp";
import { verifyPassword } from "@/lib/auth/password";
// P0-2 (Monitoring) — fire `2fa.disabled` for the IDS / Sentry / webhook
// pipeline. The anomaly-detector.ts `mass-2fa-disable` rule escalates when
// 3+ of these accumulate in 5 minutes — the canonical "account takeover
// cascade" pattern (admin disabling 2FA across many accounts in a row).
import { reportSecurityEvent } from "@/lib/monitoring/security-alerts";

export const runtime = "nodejs";

/**
 * POST /api/auth/2fa/disable
 *
 * Disable 2FA on the authenticated account. Requires EITHER the current
 * password OR a valid TOTP token (defense-in-depth: a stolen session
 * cookie alone is NOT enough to disable 2FA). On success, the secret,
 * recovery codes, and totp_enabled are cleared.
 *
 * Body: { password?: string, token?: string }
 *
 * CRITICAL: super_admin's 2FA (if they activated it) can be disabled
 * the same way. Disabling does NOT affect the login-route bypass —
 * super_admin continues to skip 2FA after disable just as before.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;

    // Refetch the user so we can read totp_secret + password_hash.
    const user = await auth.store.getUserById(auth.user.id);
    if (!user || !user.active) {
      return NextResponse.json({ error: "Account not found." }, { status: 404 });
    }
    if (!user.totp_enabled) {
      return NextResponse.json(
        { error: "Two-factor authentication is not active on this account." },
        { status: 400 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const password = typeof body?.password === "string" ? body.password : "";
    const token = typeof body?.token === "string" ? body.token.trim() : "";

    // Two acceptable proofs: current password OR a valid TOTP token.
    let proved = false;
    if (password) {
      const ok = await verifyPassword(password, user.password_hash);
      if (ok) proved = true;
    }
    if (!proved && token && user.totp_secret) {
      if (await verifyTotp(token, user.totp_secret)) proved = true;
    }
    if (!proved) {
      await audit(
        auth.store,
        auth.user,
        req,
        "auth.2fa.disable_failed",
        "auth",
        user.id,
        { reason: "no_valid_proof" },
      );
      return NextResponse.json(
        { error: "Provide your current password or a valid TOTP token to disable 2FA." },
        { status: 400 },
      );
    }

    await auth.store.upsertUser({
      id: user.id,
      totp_secret: null,
      totp_enabled: false,
      recovery_codes: null,
    });

    // Bump token_version so the existing session is force-refreshed —
    // defense in depth. Best-effort; failures don't block the disable.
    try {
      await auth.store.bumpUserTokenVersion(user.id);
    } catch (e) {
      console.error("[2fa.disable] bumpUserTokenVersion failed:", e);
    }

    await audit(
      auth.store,
      auth.user,
      req,
      "auth.2fa.disable",
      "auth",
      user.id,
      { method: password ? "password" : "totp" },
    );

    // P0-2 (Monitoring) — fire `2fa.disabled` AFTER the disable succeeds.
    // severity=warning — a single disable is a legitimate user action, but
    // the anomaly-detector.ts `mass-2fa-disable` rule escalates to a
    // critical `suspicious.activity` event when 3+ accumulate in 5 minutes
    // (the account-takeover-cascade pattern). NOTE: super-admin can disable
    // their own 2FA here just like any user — this event fires for them
    // too, but the disable itself is the user's own action; "super-admin is
    // never blocked" still holds (the route never denies them).
    reportSecurityEvent({
      type: "2fa.disabled",
      userId: user.id,
      tenantId: user.tenant_id ?? undefined,
      ip: getIp(req),
      details: { method: password ? "password" : "totp" },
      severity: "warning",
    });

    return NextResponse.json({ disabled: true });
  } catch (e) {
    console.error("[2fa.disable]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
