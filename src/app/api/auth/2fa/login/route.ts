import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/data/store";
import {
  createSession,
  setSessionCookie,
  verifyTwoFactorTempToken,
  enforceConcurrentSessionLimit,
} from "@/lib/auth/session";
import { verifyTotp } from "@/lib/auth/totp";
import { getIp, audit, sanitizeError } from "@/lib/api/helpers";
import { lookupIp } from "@/lib/utils/geo-ip";
import { createHash } from "crypto";

export const runtime = "nodejs";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — session.ts overrides per-role

function deriveDeviceName(ua: string | null): string {
  if (!ua) return "Unknown device";
  const lower = ua.toLowerCase();
  let browser = "Browser";
  if (lower.includes("edg/")) browser = "Edge";
  else if (lower.includes("opr/") || lower.includes("opera")) browser = "Opera";
  else if (lower.includes("chrome/")) browser = "Chrome";
  else if (lower.includes("firefox/")) browser = "Firefox";
  else if (lower.includes("safari/")) browser = "Safari";
  let os = "Unknown OS";
  if (lower.includes("iphone") || lower.includes("ipad")) os = "iOS";
  else if (lower.includes("android")) os = "Android";
  else if (lower.includes("mac os") || lower.includes("macintosh")) os = "macOS";
  else if (lower.includes("windows")) os = "Windows";
  else if (lower.includes("linux")) os = "Linux";
  return `${browser} on ${os}`;
}

function coarseIpBucket(ip: string): string {
  if (!ip) return "0.0.0.0/24";
  if (ip.includes(":")) return ip.split(":")[0] + "::/64";
  const parts = ip.split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  return ip + "/32";
}

function deviceFingerprint(ua: string | null, ip: string): string {
  return createHash("sha256")
    .update(`${ua || "no-ua"}|${coarseIpBucket(ip)}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * POST /api/auth/2fa/login
 *
 * Complete the 2FA login flow. The client posts the short-lived temp
 * token (issued by /api/auth/login after a valid password but BEFORE
 * TOTP verification) plus the TOTP token from the user's authenticator
 * app. On success, a full session cookie is issued and the user is
 * logged in.
 *
 * Body: { tempToken: string, token: string }
 *
 * CRITICAL: super_admin NEVER reaches this endpoint — the login route
 * bypasses 2FA for super_admin and issues a full session directly. If
 * this route somehow receives a temp token minted for a super_admin
 * (only possible if the login route is misconfigured), we still issue
 * the session — the bypass is enforced at the login route, not here.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const tempToken = typeof body?.tempToken === "string" ? body.tempToken : "";
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!tempToken || !token) {
      return NextResponse.json(
        { error: "tempToken and token are required." },
        { status: 400 },
      );
    }

    const payload = await verifyTwoFactorTempToken(tempToken);
    if (!payload) {
      return NextResponse.json(
        { error: "Invalid or expired 2FA session. Please log in again." },
        { status: 401 },
      );
    }

    const store = await getStore();
    const user = await store.getUserById(payload.sub);
    if (!user || !user.active) {
      return NextResponse.json({ error: "Account not found or inactive." }, { status: 401 });
    }

    // Re-check token_version — if the user's password was reset (or
    // their token_version was bumped for any reason) between the temp
    // token issue and now, refuse. Defense against a stale temp token
    // continuing to authenticate after a security event.
    if (user.token_version !== payload.token_version) {
      return NextResponse.json({ error: "Session expired." }, { status: 401 });
    }

    // Re-check 2FA is active on the account. If it was disabled
    // between the temp token issue and now (e.g. by a recovery code),
    // we shouldn't accept the TOTP token — that's a stale flow.
    if (!user.totp_enabled || !user.totp_secret) {
      return NextResponse.json(
        { error: "Two-factor authentication is no longer active on this account. Please log in again." },
        { status: 401 },
      );
    }

    if (!(await verifyTotp(token, user.totp_secret))) {
      const ip = getIp(req);
      await audit(
        store,
        { id: user.id, username: user.username, tenant_id: user.tenant_id },
        req,
        "auth.2fa.login_failed",
        "auth",
        user.id,
        { reason: "bad_token" },
      );
      return NextResponse.json({ error: "Invalid TOTP token." }, { status: 400 });
    }

    // ── Success: issue a full session. ───────────────────────────────
    const ip = getIp(req);
    const userAgent = req.headers.get("user-agent") || null;
    const geo = await lookupIp(ip).catch(() => ({
      country: null as string | null,
      city: null, region: null, latitude: null, longitude: null,
    }));
    const country = geo?.country ?? null;

    // Tenant / subscription gate — mirror /api/auth/login. Super_admin
    // bypasses (mirrors login).
    if (user.role !== "super_admin" && user.tenant_id) {
      const tenant = await store.getTenant(user.tenant_id) as any;
      if (tenant?.status === "suspended" || tenant?.status === "cancelled") {
        return NextResponse.json(
          { error: "Your workspace is suspended. Contact the platform administrator.", subscription_blocked: true },
          { status: 402 },
        );
      }
      const now = new Date();
      const subEnd = tenant?.subscription_end ? new Date(tenant.subscription_end) : null;
      const trialEnd = tenant?.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
      if (subEnd && subEnd < now && tenant.status !== "trial") {
        return NextResponse.json({ error: "Subscription expired.", subscription_expired: true }, { status: 402 });
      }
      if (String(tenant?.status) === "trial" && trialEnd && trialEnd < now) {
        return NextResponse.json({ error: "Trial period has ended.", subscription_expired: true }, { status: 402 });
      }
    }

    // Reset failed attempts (in case the temp-token flow clocked any).
    await store.upsertUser({ id: user.id, failed_attempts: 0, locked_until: null });
    await store.updateUserLastLogin(user.id, ip);

    // Session row + LRU cap — mirrors /api/auth/login. Only for
    // tenant-scoped users (super_admin has no tenant_id and the table
    // has NOT NULL on tenant_id).
    if (user.tenant_id) {
      try {
        await store.createSession({
          user_id: user.id,
          tenant_id: user.tenant_id,
          ip,
          user_agent: userAgent,
          country,
          expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
          current: true,
        } as any);
      } catch (e) {
        console.error("[2fa.login] createSession failed:", e);
      }
      await enforceConcurrentSessionLimit(user.id, user.tenant_id);

      try {
        await store.recordLoginHistory({
          user_id: user.id,
          username: user.username,
          ip,
          user_agent: userAgent,
          country,
          success: true,
          reason: "2fa",
        });
      } catch (e) {
        console.error("[2fa.login] recordLoginHistory failed:", e);
      }

      try {
        await store.upsertKnownIp({
          user_id: user.id,
          tenant_id: user.tenant_id,
          ip,
          country,
        } as any);
      } catch (e) {
        console.error("[2fa.login] upsertKnownIp failed:", e);
      }

      try {
        await store.upsertTrustedDevice({
          user_id: user.id,
          tenant_id: user.tenant_id,
          device_name: deriveDeviceName(userAgent),
          fingerprint: deviceFingerprint(userAgent, ip),
          ip,
        } as any);
      } catch (e) {
        console.error("[2fa.login] upsertTrustedDevice failed:", e);
      }
    }

    // createSession() applies the per-role TTL from SessionConfig.
    const fullToken = await createSession({
      sub: user.id,
      username: user.username,
      role: user.role,
      token_version: user.token_version,
      tenant_id: user.tenant_id,
    });
    await setSessionCookie(fullToken);

    await audit(
      store,
      { id: user.id, username: user.username, tenant_id: user.tenant_id },
      req,
      "auth.2fa.login",
      "auth",
      user.id,
      { method: "totp" },
    );

    const { password_hash, totp_secret, recovery_codes, ...safe } = user;
    return NextResponse.json({ user: safe });
  } catch (e) {
    console.error("[2fa.login]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
