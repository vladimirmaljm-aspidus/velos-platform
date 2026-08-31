import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError, getIp } from "@/lib/api/helpers";
import { hashRecoveryCode } from "@/lib/auth/totp";
import { checkRateLimit } from "@/lib/security/rate-limiter";

export const runtime = "nodejs";

/**
 * POST /api/auth/2fa/recovery
 *
 * Verify a one-time recovery code against the stored hashes. On success,
 * the consumed hash is removed from the user's `recovery_codes` array
 * (single-use) AND 2FA is temporarily disabled — `totp_enabled` becomes
 * false but `totp_secret` is kept, so the user can re-enroll without
 * starting over (they keep the same authenticator-app entry). The user
 * should re-activate via /api/auth/2fa/verify with a fresh TOTP token
 * (and a fresh set of recovery codes).
 *
 * The user must be authenticated (current session). Recovery codes do
 * NOT bypass the session requirement — they bypass the TOTP prompt at
 * login, but you can't use them blind from an unauthenticated browser.
 *
 * Body: { code: string }
 *
 * CRITICAL: super_admin's 2FA (if active) works the same way; super_admin
 * is also exempt from the 2FA login check regardless.
 */
export async function POST(req: NextRequest) {
  try {
    // 9b-N8: per-IP rate limit — /auth/2fa/recovery had no rate limit.
    // A stolen-session attacker (XSS, leaked cookie) can fire 1000s of
    // attempts/min at the 10 recovery codes (each is 8-char alphanumeric,
    // ~2^47 bits of entropy — out of brute-force reach, but the noise
    // floods audit logs + can DoS the account by draining codes).
    // 5 attempts per IP per 5 minutes matches 2fa/login (5/5min per temp-token).
    const _ipRl = await checkRateLimit(`2fa:recovery:ip:${getIp(req)}`, 5, 5 * 60_000);
    if (!_ipRl.allowed) {
      return NextResponse.json(
        { error: "Too many recovery attempts. Try again later." },
        { status: 429, headers: { "Retry-After": String(Math.ceil((_ipRl.retryAfter ?? 300_000) / 1000)) } },
      );
    }
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;

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
    if (!Array.isArray(user.recovery_codes) || user.recovery_codes.length === 0) {
      return NextResponse.json(
        { error: "No recovery codes are stored on this account." },
        { status: 400 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const code = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
    if (!code) {
      return NextResponse.json({ error: "Recovery code is required." }, { status: 400 });
    }

    const hash = hashRecoveryCode(code);
    const idx = user.recovery_codes.indexOf(hash);
    if (idx === -1) {
      await audit(
        auth.store,
        auth.user,
        req,
        "auth.2fa.recovery_failed",
        "auth",
        user.id,
        { reason: "bad_code" },
      );
      return NextResponse.json({ error: "Invalid or already-used recovery code." }, { status: 400 });
    }

    // Remove the consumed hash — single-use. Temporarily disable 2FA so
    // the user can log back in without TOTP until they re-enroll. Keep
    // the secret so re-enrollment is a /verify call (not a full /enroll).
    const remaining = user.recovery_codes.slice();
    remaining.splice(idx, 1);
    await auth.store.upsertUser({
      id: user.id,
      totp_enabled: false,
      // Keep totp_secret so re-enrollment is a single verify call.
      // Clear recovery_codes — they're stale after a partial drain,
      // and re-enrolling via /verify mints a fresh set.
      recovery_codes: null,
    });

    // 9b-N15 (Task 10-B-v2): recovery-code usage signals device compromise
    // — the user typed a recovery code because they couldn't generate a
    // TOTP, which on a controlled device they always can. So we treat
    // every successful recovery like a logout-all: bump
    // `users.token_version` so EVERY other JWT previously issued for this
    // user (including the one on the stolen / compromised device that may
    // have been used to GET here — though note the route requires a
    // valid session, so the caller's OWN cookie is one of those)
    // immediately fails the `requireAuth` token_version check. The
    // caller's CURRENT request still completes (the bump invalidates
    // FUTURE requests; this one is mid-flight and unaffected). The
    // user will then need to log back in (and, since totp_enabled is
    // now false, that next login will NOT prompt for TOTP — but they
    // can re-enroll via /api/auth/2fa/verify afterward).
    //
    // Best-effort: recovery has already succeeded at this point. A
    // transient DB error bumping token_version must NOT strand the
    // user in a state where 2FA is disabled but the old device is
    // still valid (we'd rather have the bump throw and surface here
    // than silently skip it). However, since the bump is itself best-
    // effort at the route layer (the user's recovery is already
    // recorded), we wrap in try/catch and log via console.error for
    // ops triage rather than 500'ing the recovery response.
    try {
      await auth.store.bumpUserTokenVersion(user.id);
    } catch (bumpErr) {
      console.error(
        "[2fa.recovery] FAILED to bump token_version after recovery — " +
          "the user's other sessions may remain valid until next logout. " +
          "Ops should investigate; the recovery itself has succeeded.",
        bumpErr,
      );
    }

    await audit(
      auth.store,
      auth.user,
      req,
      "auth.2fa.recovery_used",
      "auth",
      user.id,
      { remaining: remaining.length },
    );

    return NextResponse.json({
      used: true,
      remaining: remaining.length,
      message:
        "Recovery code accepted. 2FA is temporarily disabled — please re-enroll by verifying a fresh TOTP token at /api/auth/2fa/verify (after re-running /enroll to get a new secret).",
    });
  } catch (e) {
    console.error("[2fa.recovery]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
