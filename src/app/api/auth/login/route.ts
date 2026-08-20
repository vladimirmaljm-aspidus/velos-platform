import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/data/store";
import { verifyPassword } from "@/lib/auth/password";
import {
  createSession,
  setSessionCookie,
  enforceConcurrentSessionLimit,
  issueTwoFactorTempToken,
} from "@/lib/auth/session";
import { lookupIp } from "@/lib/utils/geo-ip";
import { createHash } from "crypto";
import { getIp } from "@/lib/api/helpers";
import { checkRateLimit, resetRateLimit } from "@/lib/security/rate-limiter";
import { getRateLimitConfig } from "@/lib/security/rate-limit-config";
// P0-2 (Monitoring) — security event reporting for login attempts.
// Failed / blocked / rate-limited logins fire `reportSecurityEvent` BEFORE
// the route returns the 401/423/429, so Sentry + the IDS + the security
// webhooks see every auth failure. Super-admins are subject to the same
// per-IP rate limit as everyone else (rate-limiting is a transport-level
// defense, not an authorization decision) — "super-admin is never blocked"
// applies to permission gates, not to rate limits.
import { reportSecurityEvent } from "@/lib/monitoring/security-alerts";

export const runtime = "nodejs";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// P0-1 (Auth Security) per-user login rate limit — separate from the
// per-IP cap above. Where the per-IP cap defends against distributed
// brute-force from many IPs against one account, the per-user cap defends
// against a single attacker rotating IPs against one account (e.g. a botnet
// trying 1000 passwords for "admin" from 1000 different source IPs — the
// per-IP cap would see 1 attempt per IP and never fire, but the per-user
// cap sees 1000 attempts for "admin" and locks the account out).
//
// CRITICAL: super_admin is NEVER subject to the per-user rate limit —
// the platform owner must always be able to log in. The check below
// explicitly skips super_admin accounts, so even an accidental lockout
// (e.g. a forgotten password on a shared super_admin account) can be
// self-recovered without DB intervention.
const PER_USER_LOGIN_MAX_ATTEMPTS = 5;
const PER_USER_LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 min

// F-7 (Rate Limiting): login attempts per IP are now configurable by
// super-admins via the Settings UI (see src/lib/security/rate-limit-config.ts
// and GET/PUT /api/settings/rate-limits). Defaults: 20 attempts / 15 min.

// NOTE (audit F-6/S-1): previously this read the FIRST value of
// X-Forwarded-For, which is attacker-controlled and trivially spoofable.
// `getIp()` (src/lib/api/helpers.ts) takes the LAST value of the XFF chain
// (the one appended by Render's trusted proxy), falling back to x-real-ip
// and then "127.0.0.1". Use `getIp(req)` everywhere IP attribution matters
// (rate-limiting, audit logs, login history, GPS-gate keying).
function getRequestIp(req: NextRequest): string {
  return getIp(req);
}

/**
 * Derive a human-readable device name from a User-Agent string.
 * e.g. "Mozilla/5.0 (Macintosh) ... Chrome/120 ..." -> "Chrome on macOS"
 */
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

/**
 * Coarse IP bucket — /24 for IPv4 (192.168.1.x -> 192.168.1.0/24),
 * /64 prefix for IPv6 (collapsed to first group). Combined with the
 * user-agent hash so the same browser on the same network is recognized.
 */
function coarseIpBucket(ip: string): string {
  if (!ip) return "0.0.0.0/24";
  if (ip.includes(":")) {
    // IPv6 — use first group as a coarse bucket
    return ip.split(":")[0] + "::/64";
  }
  const parts = ip.split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  return ip + "/32";
}

function deviceFingerprint(ua: string | null, ip: string): string {
  const fp = `${ua || "no-ua"}|${coarseIpBucket(ip)}`;
  return createHash("sha256").update(fp).digest("hex").slice(0, 32);
}

export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json();
    if (!username || !password) {
      return NextResponse.json({ error: "Please enter username and password." }, { status: 400 });
    }

    const store = await getStore();
    // FIX-ALL-2 / Fix 5 — wrap the user lookup in try/catch so a
    // malformed username (e.g. one containing SQL-breaking characters
    // that confuses a non-parameterised query path) or a transient DB
    // error NEVER surfaces as a 500 with a leaky Postgres message.
    // We always return 401 "Invalid username or password." for any
    // failure here — the caller cannot tell a DB error from a wrong
    // password, which is the correct security posture (no info leak).
    // The audit + security-event pipeline still records the failure
    // server-side so ops can triage.
    let user: Awaited<ReturnType<typeof store.getUserByUsername>>;
    try {
      user = await store.getUserByUsername(username);
    } catch (lookupErr) {
      console.error("[login] user lookup failed:", lookupErr);
      // Best-effort audit so the security pipeline sees the anomaly.
      try {
        const ip0 = getRequestIp(req);
        await store.appendAudit({
          user_id: null,
          username,
          action: "login.failed",
          entity_type: "auth",
          entity_id: null,
          details: { reason: "user_lookup_threw", error: lookupErr instanceof Error ? lookupErr.message : String(lookupErr) },
          ip: ip0,
          user_agent: req.headers.get("user-agent") || null,
        });
      } catch { /* non-critical */ }
      return NextResponse.json(
        { error: "Invalid username or password." },
        { status: 401 },
      );
    }

    const ip = getRequestIp(req);
    const userAgent = req.headers.get("user-agent") || null;

    // ── F-7: DB-backed per-IP rate limit (atomic, multi-instance safe) ────
    // Checked BEFORE the user-existence branch so a request for a
    // non-existent username still consumes a rate-limit slot — otherwise an
    // attacker could enumerate usernames without ever hitting the cap.
    const rateLimitKey = `login:ip:${ip}`;
    const config = await getRateLimitConfig();
    const rl = await checkRateLimit(
      rateLimitKey,
      config.loginMaxAttempts,
      config.loginWindowMs,
    );
    if (!rl.allowed) {
      // P0-2 (Monitoring) — fire `rate.limit.hit` BEFORE returning the 429.
      // The per-IP cap is the primary brute-force backstop; a hit here is a
      // meaningful security signal. The burst tracker + IDS in
      // security-alerts.ts / anomaly-detector.ts will further escalate if a
      // pattern emerges.
      reportSecurityEvent({
        type: "rate.limit.hit",
        ip,
        details: { scope: "per_ip", key: rateLimitKey, count: rl.count },
        severity: "warning",
      });
      const retryAfterSec = Math.ceil((rl.retryAfter ?? 60_000) / 1000);
      return NextResponse.json(
        { error: "Too many login attempts from this address. Try again later." },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
      );
    }

    // ── IP → Country resolution ───────────────────────────────────────────
    // Kick off the geo lookup early (runs concurrently with the lookup work
    // below). 5s timeout + null fallback means this can never block a login.
    const geoPromise = lookupIp(ip).catch(() => ({
      country: null as string | null,
      city: null, region: null, latitude: null, longitude: null,
    }));

    // ---- User does not exist OR is inactive ----
    if (!user || !user.active) {
      // The LoginHistoryEntry model has a non-nullable user_id with a FK to User.
      // For non-existent users we cannot persist a row without violating the FK
      // constraint. The audit log below still captures the attempt.
      console.warn(
        `[login] Login attempt for non-existent/inactive user "${username}" from ${ip} — skipping LoginHistoryEntry (FK constraint).`
      );
      await store.appendAudit({
        user_id: null,
        username,
        action: "login.failed",
        entity_type: "auth",
        entity_id: null,
        details: { reason: user ? "User inactive" : "User not found" },
        ip,
        user_agent: userAgent,
      });
      // P0-2 (Monitoring) — fire `login.failed` for the IDS / Sentry / webhook
      // pipeline. The `details.reason` distinguishes enumeration (User not
      // found) from reactivation attempts (User inactive). No `userId` is
      // available because the user doesn't exist; the IP is the only signal,
      // which is exactly what the brute-force-login IDS rule keys on.
      reportSecurityEvent({
        type: "login.failed",
        ip,
        details: { reason: user ? "User inactive" : "User not found", username },
        severity: "info",
      });
      return NextResponse.json(
        { error: "Invalid username or password." },
        { status: 401 }
      );
    }

    // ── P0-1: per-user login rate limit (super_admin NEVER blocked) ───────
    // Distinct from the per-IP cap above: defends against a single attacker
    // rotating IPs against one account. CRITICAL: super_admin skips this
    // entirely — the platform owner must always be able to log in, even
    // under sustained attack from a botnet that has the right password
    // (e.g. a compromised super_admin credential needs to be resettable
    // from the super_admin's own browser without DB surgery).
    if (user.role !== "super_admin") {
      const userRlKey = `login:user:${user.username}`;
      const userRl = await checkRateLimit(
        userRlKey,
        PER_USER_LOGIN_MAX_ATTEMPTS,
        PER_USER_LOGIN_WINDOW_MS,
      );
      if (!userRl.allowed) {
        // Audit + security event BEFORE the 429 — same pattern as the
        // per-IP cap above. The `scope: per_user` detail lets the IDS
        // distinguish "one IP burning through many accounts" from
        // "many IPs hammering one account" (the latter is what this
        // cap exists to stop).
        try {
          await store.appendAudit({
            user_id: user.id,
            username: user.username,
            action: "login.rate_limited",
            entity_type: "auth",
            entity_id: user.id,
            details: { scope: "per_user", count: userRl.count },
            ip,
            user_agent: userAgent,
          });
        } catch (e) {
          console.error("[login] appendAudit (per_user rate-limit) failed:", e);
        }
        reportSecurityEvent({
          type: "rate.limit.hit",
          userId: user.id,
          tenantId: user.tenant_id ?? undefined,
          ip,
          details: { scope: "per_user", key: userRlKey, count: userRl.count },
          severity: "warning",
        });
        const retryAfterSec = Math.ceil((userRl.retryAfter ?? 60_000) / 1000);
        return NextResponse.json(
          { error: "Too many login attempts for this account. Try again later." },
          { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
        );
      }
    }

    // ── Resolve geo (awaited here — by now the lookup has run in parallel
    //    with the user query above, so this await is usually instant).
    const geo = await geoPromise;
    const country = geo?.country ?? null;

    // ---- Lockout check ----
    // P0 / task D-FIX: super_admin bypasses the per-account lockout
    // entirely. The previous logic applied the locked_until check + the
    // failed_attempts bump to ALL users, including super_admin — so 5
    // wrong passwords would lock the platform owner out for 15 minutes,
    // violating the "super_admin is never blocked" invariant. The bypass
    // here mirrors the per-user rate-limit bypass above (line 197) and
    // the 2FA / tenant-status bypasses below. The per-IP cap (line 117)
    // still applies — rate-limiting is a transport-level defense, not
    // an authorization decision.
    if (user.role !== "super_admin" && user.locked_until && new Date(user.locked_until) > new Date()) {
      try {
        await store.recordLoginHistory({
          user_id: user.id,
          username: user.username,
          ip,
          user_agent: userAgent,
          country,
          success: false,
          reason: "Account locked",
        });
      } catch (e) {
        console.error("[login] recordLoginHistory (locked) failed:", e);
      }
      await store.appendAudit({
        user_id: user.id,
        username: user.username,
        action: "login.failed",
        entity_type: "auth",
        entity_id: user.id,
        details: { reason: "Account locked" },
        ip,
        user_agent: userAgent,
      });
      // P0-2 (Monitoring) — fire `login.blocked` (severity=warning) — the
      // account-lock surface is hit only after 5 consecutive failures, so a
      // `login.blocked` event implies a sustained attack (the burst tracker
      // will already have paged; this is the durable record in Sentry /
      // webhook deliveries).
      reportSecurityEvent({
        type: "login.blocked",
        userId: user.id,
        tenantId: user.tenant_id ?? undefined,
        ip,
        details: { reason: "account_locked", locked_until: user.locked_until },
        severity: "warning",
      });
      // Surface the exact unlock time + a Retry-After header so the client
      // can show a live countdown instead of a vague "try again later".
      // Math.max(0, …) guards against clock drift pushing retry_after
      // negative between the lock check above and here.
      const lockedUntil = user.locked_until;
      const retryAfter = Math.max(
        0,
        Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 1000),
      );
      return NextResponse.json(
        {
          error: "Account is temporarily locked. Try again later.",
          locked_until: lockedUntil,
          retry_after: retryAfter,
        },
        {
          status: 423,
          headers: { "Retry-After": String(retryAfter) },
        },
      );
    }

    // ---- Verify password ----
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      // bump failed attempts (best-effort) — but NEVER for super_admin.
      // P0 / task D-FIX: the per-account lockout (failed_attempts >= 5
      // → locked_until = +15min) is the per-account counterpart to the
      // per-user rate-limit bypass at line 197. Without this guard, 5
      // wrong super_admin passwords set locked_until, and the lockout
      // check above (now also guarded) would have blocked the next
      // attempt. Skipping the upsert here means super_admin's
      // failed_attempts counter stays at its current value forever —
      // which is the intended behaviour for a "never blocked" account.
      // The audit log + reportSecurityEvent below still fire so the
      // security pipeline sees the wrong-password signal; only the
      // enforcement (counter bump + lock) is skipped.
      const next = (user.failed_attempts || 0) + 1;
      if (user.role !== "super_admin") {
        const lockUntil = next >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : null;
        await store.upsertUser({ id: user.id, failed_attempts: next, locked_until: lockUntil });
      }

      try {
        await store.recordLoginHistory({
          user_id: user.id,
          username: user.username,
          ip,
          user_agent: userAgent,
          country,
          success: false,
          reason: "Wrong password",
        });
      } catch (e) {
        console.error("[login] recordLoginHistory (wrong pw) failed:", e);
      }
      await store.appendAudit({
        user_id: user.id,
        username: user.username,
        action: "login.failed",
        entity_type: "auth",
        entity_id: user.id,
        details: { reason: "Wrong password", failed_attempts: next },
        ip,
        user_agent: userAgent,
      });
      // P0-2 (Monitoring) — fire `login.failed` (severity=warning) for each
      // wrong-password attempt. This is the canonical brute-force signal —
      // the anomaly-detector.ts brute-force-login rule fires when 5+ of
      // these accumulate from the same IP in 60 s, escalating to a single
      // `suspicious.activity` event. We report on EVERY attempt (not just
      // after the lockout) so a slow-drip attack that never trips the
      // per-IP cap is still visible in Sentry / the webhook fan-out.
      reportSecurityEvent({
        type: "login.failed",
        userId: user.id,
        tenantId: user.tenant_id ?? undefined,
        ip,
        details: { reason: "Wrong password", failed_attempts: next, country },
        severity: "warning",
      });
      return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
    }

    // ---- Tenant status gate ---------------------------------------------
    // Suspended / cancelled tenants must not be able to log in — otherwise a
    // client whose subscription expired could keep working normally. Super
    // admins bypass (they need to be able to unblock the tenant).
    if (user.role !== "super_admin" && user.tenant_id) {
      const tenant = await store.getTenant(user.tenant_id) as any;
      if (tenant?.status === "suspended" || tenant?.status === "cancelled") {
        try {
          await store.recordLoginHistory({
            user_id: user.id,
            username: user.username,
            ip,
            user_agent: userAgent,
            country,
            success: false,
            reason: `Tenant ${tenant.status}`,
          });
        } catch { /* non-critical */ }
        await store.appendAudit({
          user_id: user.id,
          username: user.username,
          action: "login.blocked",
          entity_type: "auth",
          entity_id: user.id,
          details: { reason: `tenant_${tenant.status}` },
          ip,
          user_agent: userAgent,
        });
        // P0-2 (Monitoring) — fire `login.blocked` for the tenant-status
        // denial. NOTE: super-admin bypasses the tenant gate entirely (the
        // guard at line 233 above skips for `role === "super_admin"`), so
        // this event NEVER fires for super-admin callers — "super-admin is
        // never blocked" is preserved by the audit-time check, not by the
        // security-event report.
        reportSecurityEvent({
          type: "login.blocked",
          userId: user.id,
          tenantId: user.tenant_id ?? undefined,
          ip,
          details: { reason: `tenant_${tenant.status}` },
          severity: "warning",
        });
        return NextResponse.json(
          {
            error: tenant.status === "suspended"
              ? "Your workspace is suspended. Contact the platform administrator to reactivate it."
              : "Your workspace has been cancelled. Contact the platform administrator.",
            subscription_blocked: true,
            tenant_status: tenant.status,
          },
          { status: 402 },
        );
      }
      // Also block on expired subscription / trial (belt + braces on top of the cron sweep).
      const now = new Date();
      const subEnd = tenant?.subscription_end ? new Date(tenant.subscription_end) : null;
      const trialEnd = tenant?.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
      if (subEnd && subEnd < now && tenant.status !== "trial") {
        return NextResponse.json({ error: "Subscription expired. Contact the platform administrator to renew.", subscription_expired: true }, { status: 402 });
      }
      if (String(tenant?.status) === "trial" && trialEnd && trialEnd < now) {
        return NextResponse.json({ error: "Trial period has ended. Upgrade to continue using VELOS.", subscription_expired: true }, { status: 402 });
      }
    }

    // ---- SUCCESS: reset failed attempts + record login ----
    await store.upsertUser({ id: user.id, failed_attempts: 0, locked_until: null });
    await store.updateUserLastLogin(user.id, ip);

    // F-7: on successful login, clear the per-IP rate-limit counter so a
    // user who fat-fingered their password a few times doesn't carry that
    // count forward. Best-effort — failures here don't block login.
    void resetRateLimit(rateLimitKey).catch(() => {});

    // P0-1: also clear the per-user rate-limit counter (super_admin was
    // never counted, so this is a no-op for them).
    if (user.role !== "super_admin") {
      void resetRateLimit(`login:user:${user.username}`).catch(() => {});
    }

    // ── P0-1: 2FA / TOTP check (super_admin bypasses) ──────────────────
    // After the password verifies, if the user has 2FA activated AND is
    // not super_admin, do NOT issue a full session. Instead, mint a short-
    // lived (5min) temp token and return it to the client — the client
    // then posts {tempToken, token:<6-digit code>} to /api/auth/2fa/login
    // to complete the flow.
    //
    // CRITICAL: super_admin NEVER hits this branch — they log straight in
    // with just their password, regardless of totp_enabled. The bypass is
    // here (in the login route), not in the TOTP helpers — see the header
    // comment in src/lib/auth/totp.ts.
    //
    // We DO NOT reset failed_attempts on this branch — that happens at
    // the final /2fa/login success. If the user abandons the 2FA flow,
    // the failed_attempts from the password stage stay (which is fine:
    // a successful password check does not bump failed_attempts anyway).
    if (user.totp_enabled && user.totp_secret && user.role !== "super_admin") {
      const tempToken = await issueTwoFactorTempToken({
        sub: user.id,
        username: user.username,
        role: user.role,
        token_version: user.token_version,
        tenant_id: user.tenant_id,
      });
      await store.appendAudit({
        user_id: user.id,
        username: user.username,
        action: "auth.2fa.temp_token_issued",
        entity_type: "auth",
        entity_id: user.id,
        details: { method: "password" },
        ip,
        user_agent: userAgent,
      });
      // Do NOT return the user object here — the client must complete 2FA
      // before we surface any account details. Returning only
      // {requiresTwoFactor, tempToken} is the minimal viable response.
      return NextResponse.json({ requiresTwoFactor: true, tempToken });
    }

    await store.appendAudit({
      user_id: user.id,
      username: user.username,
      action: "login",
      entity_type: "auth",
      entity_id: user.id,
      details: { method: "password" },
      ip,
      user_agent: userAgent,
    });

    // ---- Security module: write session, login history, known IP, trusted device ----
    // NOTE: sessions/known_ips/trusted_devices all have NOT NULL tenant_id
    // in Postgres, and super_admin users have no tenant. Skip these tables
    // entirely for platform-level accounts — nothing meaningful to write and
    // trying to insert null tenant_id crashes with 23502.
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    if (user.tenant_id) {
      // ── Concurrent session limit (LRU eviction) ───────────────────────
      // Cap each user to MAX_CONCURRENT_SESSIONS active sessions.
      // CRITICAL FIX (audit P2-11): enforce AFTER createSession, not before.
      // The previous "revoke-before-create" flow raced on concurrent logins:
      // two logins could both see count < max and neither would revoke, then
      // both would create sessions, leaving the user with max+1 sessions.
      // Running the cleanup AFTER the new row exists means the new session
      // is counted, and any surplus (oldest, not the just-created one) is
      // evicted. Defense against stolen-cookie farms and "session sharing"
      // abuse. Implemented centrally in session.ts so the cap is enforced
      // identically across every login surface.
      try {
        await store.createSession({
          user_id: user.id,
          tenant_id: user.tenant_id,
          ip,
          user_agent: userAgent,
          country,
          expires_at: expiresAt,
          current: true,
        } as any);
      } catch (e) {
        console.error("[login] createSession failed:", e);
      }
      // Run the LRU cleanup AFTER the new session row exists so the count
      // includes it. Best-effort: failures are logged inside the helper and
      // must not block the login response.
      await enforceConcurrentSessionLimit(user.id, user.tenant_id);
    }

    try {
      await store.recordLoginHistory({
        user_id: user.id,
        username: user.username,
        ip,
        user_agent: userAgent,
        country,
        success: true,
        reason: null,
      });
    } catch (e) {
      console.error("[login] recordLoginHistory (success) failed:", e);
    }

    if (user.tenant_id) {
      try {
        await store.upsertKnownIp({
          user_id: user.id,
          tenant_id: user.tenant_id,
          ip,
          country,
        } as any);
      } catch (e) {
        console.error("[login] upsertKnownIp failed:", e);
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
        console.error("[login] upsertTrustedDevice failed:", e);
      }
    }

    const token = await createSession({
      sub: user.id,
      username: user.username,
      role: user.role,
      token_version: user.token_version,
      tenant_id: user.tenant_id,
    });
    await setSessionCookie(token);

    // strip sensitive fields — recovery_codes is hashed SHA-256 hex strings
    // (see src/lib/auth/totp.ts) so it's not directly usable by an attacker,
    // but still must not leak to the client. The /api/auth/me route strips
    // the same set.
    const { password_hash, totp_secret, recovery_codes, ...safeUser } = user;
    return NextResponse.json({ user: safeUser });
  } catch (e) {
    console.error("[login]", e);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
