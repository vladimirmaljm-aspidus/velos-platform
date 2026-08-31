import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/data/store";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { audit, getIp } from "@/lib/api/helpers";
import { lookupIp } from "@/lib/utils/geo-ip";
import { checkRateLimit, resetRateLimit } from "@/lib/security/rate-limiter";
import { getRateLimitConfig } from "@/lib/security/rate-limit-config";

export const runtime = "nodejs";

// F-7 (Rate Limiting): portal login attempts per IP are now configurable by
// super-admins via the Settings UI (src/lib/security/rate-limit-config.ts).
// Defaults: 20 attempts / 15 min. Same layered defense as /api/auth/login.

// P0-1 (Auth Security) per-portal-user rate limit — separate from the per-IP
// cap above. Portal clients are NEVER super_admin (super_admin uses
// /api/auth/login), so the per-user cap applies uniformly to every portal
// access record. Defends against a single attacker rotating IPs against one
// portal account — mirrors the per-user cap on /api/auth/login.
const PER_PORTAL_USER_LOGIN_MAX_ATTEMPTS = 5;
const PER_PORTAL_USER_LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 min

// Portal login — separate session type (partner, not user)
export async function POST(req: NextRequest) {
  try {
    const { email, password, tenant_id } = await req.json();
    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
    }
    const store = await getStore();
    const ip = getIp(req);

    // ── F-7: DB-backed per-IP rate limit ──────────────────────────────────
    // Checked early so even requests for non-existent emails consume a slot
    // (prevents email enumeration via response-timing or status differential).
    const rateLimitKey = `portal-login:ip:${ip}`;
    const config = await getRateLimitConfig();
    const rl = await checkRateLimit(
      rateLimitKey,
      config.portalLoginMaxAttempts,
      config.portalLoginWindowMs,
    );
    if (!rl.allowed) {
      const retryAfterSec = Math.ceil((rl.retryAfter ?? 60_000) / 1000);
      return NextResponse.json(
        { error: "Too many login attempts from this address. Try again later." },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
      );
    }

    // ── IP → Country resolution ───────────────────────────────────────────
    // Kick off the geo lookup early (runs concurrently with the credential
    // verification below). 5s timeout + null fallback means this can never
    // block a portal login. Country is recorded in the audit log details and,
    // when migration 005 is applied, on portal_access.last_login_country.
    const geoPromise = lookupIp(ip).catch(() => ({
      country: null as string | null,
      city: null, region: null, latitude: null, longitude: null,
    }));

    // If no tenant_id is provided, look up ALL matching accounts for this email.
    // If more than one exists (same email across tenants), the client MUST
    // specify which tenant they are logging into — otherwise we risk
    // authenticating against the wrong tenant (data leakage).
    if (!tenant_id) {
      const allByEmail = await store.listPortalAccessByEmail(email);
      if (allByEmail.length > 1) {
        // 8b-4 / 8a-10 (Task 10-B-v2): previously this branch looked up
        // each tenant's display name via store.getTenant() and returned
        // `tenant_name` per tenant in the 409 body. That made every
        // workspace the email belongs to enumerable to an unauthenticated
        // attacker — they could probe a single email and walk away with
        // the list of organizations it is registered with (email +
        // tenant enumeration vector). The frontend now labels
        // workspaces by array index ("Workspace 1", "Workspace 2",
        // …) and the user authenticates by selecting one, so we only
        // need the opaque `tenant_id` here. The getTenant() lookup +
        // Promise.all have been removed since tenant_name is no longer
        // surfaced.
        const tenants = allByEmail.map((pa) => ({ tenant_id: pa.tenant_id }));
        return NextResponse.json({
          error: "This email is registered with multiple organizations. Please select which one to sign into.",
          multiple_tenants: true,
          tenants,
        }, { status: 409 });
      }
    }

    // Look up the account first (independent of the password check) so a
    // lockout/failure counter can be tracked even on a wrong password.
    const existing = tenant_id
      ? await store.getPortalAccessByEmail(tenant_id, email)
      : await store.getPortalAccessByEmailAnyTenant(email);

    // ── P0-1: per-portal-user rate limit ────────────────────────────────
    // Only applies when we have a known portal_access record (so an
    // attacker probing random emails can't lock out a different account
    // — they're throttled by the per-IP cap above). Portal clients are
    // NEVER super_admin, so no role exemption is needed here.
    if (existing) {
      const portalRlKey = `login:portal:${existing.id}`;
      const portalRl = await checkRateLimit(
        portalRlKey,
        PER_PORTAL_USER_LOGIN_MAX_ATTEMPTS,
        PER_PORTAL_USER_LOGIN_WINDOW_MS,
      );
      if (!portalRl.allowed) {
        try {
          await audit(
            store,
            { id: undefined, username: email, tenant_id: existing.tenant_id },
            req,
            "portal.login_rate_limited",
            "portal_access",
            existing.id,
            { email, ip, country: null, scope: "per_user", count: portalRl.count },
          );
        } catch (e) { console.error("[audit]", e); }
        const retryAfterSec = Math.ceil((portalRl.retryAfter ?? 60_000) / 1000);
        return NextResponse.json(
          { error: "Too many login attempts for this account. Try again later." },
          { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
        );
      }
    }


    // ── Resolve geo (by now the lookup has been running in parallel with the
    //    existing-account query above, so this await is usually instant).
    const geo = await geoPromise;
    const country = geo?.country ?? null;

    if (existing?.locked_until && new Date(existing.locked_until) > new Date()) {
      try {
        await audit(
          store,
          { id: undefined, username: email, tenant_id: existing.tenant_id },
          req,
          "portal.login_failed",
          "portal_access",
          existing.id,
          { email, ip, country, reason: "account_locked" },
        );
      } catch (e) { console.error("[audit]", e); }
      // Surface the exact unlock time + a Retry-After header so the portal
      // client UI can show a live countdown instead of a vague "try again
      // later". Math.max(0, …) guards against clock drift between the lock
      // check above and this response.
      const lockedUntil = existing.locked_until;
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

    // If tenant_id is provided, verify with it; otherwise look up by email alone
    let access;
    if (tenant_id) {
      access = await store.verifyPortalCredentials(tenant_id, email, password);
    } else {
      // Look up portal access by email alone — find the matching record
      access = await store.verifyPortalCredentialsByEmail(email, password);
    }

    if (!access) {
      // Bump the failed-attempt counter on a known account (best-effort —
      // we don't fail the request if this write has trouble).
      if (existing) {
        const next = (existing.failed_attempts || 0) + 1;
        const lockUntil = next >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : null;
        try {
          await store.upsertPortalAccess({ id: existing.id, failed_attempts: next, locked_until: lockUntil });
        } catch { /* non-critical */ }
      }
      try {
        await audit(
          store,
          { id: undefined, username: email, tenant_id: existing?.tenant_id ?? null },
          req,
          "portal.login_failed",
          "portal_access",
          existing?.id,
          { email, ip, country, reason: existing ? "invalid_credentials" : "account_not_found" },
        );
      } catch (e) { console.error("[audit]", e); }
      // 8b-5 (Task 10-B-v2): previously this branch returned a distinct
      // 403 `{error: "Your account is suspended…"}` when `existing.status`
      // was "suspended" or "revoked". That distinguished the case from a
      // wrong-password 401 — which leaked account-existence AND account-
      // suspension state to an unauthenticated attacker (an email probe
      // would return "suspended" for a known frozen account vs. "invalid
      // email or password" for an unknown one). The detailed reason is
      // still captured in the audit log entry above (`invalid_credentials`
      // when the row exists but the password is wrong, `account_not_found`
      // when there is no row at all) — the audit trail is internal-only,
      // and the user-facing response is now identical across all three
      // failure cases (missing-email / wrong-password / suspended-account):
      // the same 401 `{error: "Invalid email or password."}`. The
      // tenant-status gate further down (which returns 402 for a
      // workspace-level suspension) is unaffected — that surfaces only
      // AFTER the password verifies, so it does not leak email-existence.
      return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
    }

    // Check status is active
    if (access.status !== "active") {
      try {
        await audit(
          store,
          { id: undefined, username: access.portal_email, tenant_id: access.tenant_id },
          req,
          "portal.login_failed",
          "portal_access",
          access.id,
          { email, ip, country, reason: "account_not_active" },
        );
      } catch (e) { console.error("[audit]", e); }
      return NextResponse.json({ error: "Account is not yet active. Please set up your password first." }, { status: 403 });
    }

    // Tenant status gate — a suspended / cancelled workspace must not let
    // its portal clients keep logging in.
    const tenant = await store.getTenant(access.tenant_id) as any;
    if (tenant?.status === "suspended" || tenant?.status === "cancelled") {
      try {
        await audit(
          store,
          { id: undefined, username: access.portal_email, tenant_id: access.tenant_id },
          req,
          "portal.login_failed",
          "portal_access",
          access.id,
          { email, ip, country, reason: "tenant_suspended", tenant_status: tenant.status },
        );
      } catch (e) { console.error("[audit]", e); }
      return NextResponse.json({
        error: "This workspace is not currently active. Please contact your account manager.",
        tenant_status: tenant.status,
      }, { status: 402 });
    }
    const now = new Date();
    const subEnd = tenant?.subscription_end ? new Date(tenant.subscription_end) : null;
    const trialEnd = tenant?.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
    if (subEnd && subEnd < now && String(tenant?.status) !== "trial") {
      try {
        await audit(
          store,
          { id: undefined, username: access.portal_email, tenant_id: access.tenant_id },
          req,
          "portal.login_failed",
          "portal_access",
          access.id,
          { email, ip, country, reason: "subscription_expired" },
        );
      } catch (e) { console.error("[audit]", e); }
      return NextResponse.json({ error: "This workspace's subscription has expired.", subscription_expired: true }, { status: 402 });
    }
    if (String(tenant?.status) === "trial" && trialEnd && trialEnd < now) {
      try {
        await audit(
          store,
          { id: undefined, username: access.portal_email, tenant_id: access.tenant_id },
          req,
          "portal.login_failed",
          "portal_access",
          access.id,
          { email, ip, country, reason: "trial_expired" },
        );
      } catch (e) { console.error("[audit]", e); }
      return NextResponse.json({ error: "This workspace's trial period has ended.", subscription_expired: true }, { status: 402 });
    }

    const token = await createSession({
      sub: `portal:${access.id}`,
      username: access.portal_email || "",
      role: "portal_client",
      token_version: access.token_version || 0,
      tenant_id: access.tenant_id,
    });
    await setSessionCookie(token);

    // F-7 / 8b-3: per-IP rate-limit counter is NO LONGER reset on
    // successful login. With the reset, an attacker holding ONE valid
    // portal credential could enumerate unknown portal_email-_values
    // up to the per-IP cap (20/15min default), then re-login with the
    // known credential to reset the bucket and start a new enumeration
    // wave — indefinitely. The per-portal-user reset (line below) is
    // kept because that bucket only ever fills on attempts against a
    // KNOWN portal_email, which is the legitimate fat-finger case.
    // Per-IP bucket now expires naturally (15 min window).
    // P0-1: per-portal-user reset is still desirable for the fat-finger case.
    void resetRateLimit(`login:portal:${access.id}`).catch(() => {});

    // Success: reset the failed-attempt counter and record the login.
    // Also persist the resolved country on portal_access.last_login_country
    // (no-op on deployments where migration 005 hasn't been applied — the
    // store layer retries the upsert without the column on schema error).
    try {
      await store.upsertPortalAccess({
        id: access.id,
        failed_attempts: 0,
        locked_until: null,
        last_login_at: new Date().toISOString(),
        last_login_ip: ip,
        last_login_country: country,
      });
    } catch { /* non-critical */ }

    try {
      await audit(
        store,
        { id: undefined, username: access.portal_email, tenant_id: access.tenant_id },
        req,
        "portal.login",
        "portal_access",
        access.id,
        { email, ip, country },
      );
    } catch (e) { console.error("[audit]", e); }

    return NextResponse.json({ access: { ...access, password_hash: undefined } });
  } catch (e) {
    console.error("[portal.login]", e);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
