import { NextRequest, NextResponse } from "next/server";
import { getSessionFromCookie, ImpersonationClaim } from "@/lib/auth/session";
import { getStore } from "@/lib/data/store";
import { SafeUser } from "@/lib/store/app-store";
import { createHash } from "crypto";
// NOTE: `@/lib/permissions/can` only imports `type { AuthContext,
// ApiKeyAuthContext }` from this module (`import type` is erased at compile
// time), so this static import does NOT create a runtime circular dependency.
import { requirePermission } from "@/lib/permissions/can";
// P0-2 (Monitoring) — `reportSecurityEvent` fires Sentry + log + IDS +
// webhook fan-out for security-relevant events. Imported here so the CSRF
// defense, the permission gate, and the admin/super-admin role gates can
// each report a denial BEFORE returning the 403. NOTE: the import direction
// is helpers.ts → security-alerts.ts (one-way) — security-alerts.ts does NOT
// import helpers.ts, so there is no cycle. The chain that DOES form a cycle
// (security-alerts.ts ↔ anomaly-detector.ts) resolves via function hoisting
// (see the header comments in those two files).
import { reportSecurityEvent } from "@/lib/monitoring/security-alerts";

export interface AuthContext {
  user: SafeUser;
  store: Awaited<ReturnType<typeof getStore>>;
  ip: string;
  tenantId: string | null; // null = super-admin (platform level, sees all)
  isSuperAdmin: boolean;
  /** Present when a super_admin is currently impersonating another user. */
  impersonation?: ImpersonationClaim;
}

export interface ApiKeyAuthContext {
  store: Awaited<ReturnType<typeof getStore>>;
  ip: string;
  tenantId: string;
  apiKeyId: string;
  apiKeyName: string;
  permissions: string[];
}

/**
 * Authenticate via session cookie OR API key (Bearer token).
 * API keys are checked first, then falls back to session auth.
 *
 * P2-18 (CSRF): callers MAY pass the inbound `req` so this helper can enforce
 * a server-side Origin check on state-changing requests (POST/PUT/PATCH/
 * DELETE). `SameSite=Lax` blocks cookies on cross-site sub-resource requests,
 * but top-level navigations still send the cookie — an explicit Origin check
 * closes that gap. The parameter is optional so existing call sites keep
 * working unchanged; routes that want the CSRF defense pass `req` through.
 * API-key-authenticated requests (detected via the `Authorization: Bearer`
 * header) are exempt — bearer tokens are not sent automatically by browsers,
 * so they are not vulnerable to CSRF.
 */
export async function requireAuth(req?: NextRequest): Promise<AuthContext | NextResponse> {
  const session = await getSessionFromCookie();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const store = await getStore();
  const baseUser = await store.getUserById(session.sub);
  if (!baseUser || !baseUser.active) {
    return NextResponse.json({ error: "Account not active." }, { status: 401 });
  }
  // ── P1 ghost-JWT check (task C-5 Fix 6) ────────────────────────────────
  // The JWT carries `token_version` at issue time. The DB-side
  // `users.token_version` is bumped whenever the user's password is
  // changed, their account is force-logged-out, or their sessions are
  // rotated — so a mismatch here means the JWT was issued BEFORE the
  // invalidation event and must be rejected. This is the primary
  // defence against "ghost JWTs" continuing to authenticate after a
  // password reset / logout-all / admin-initiated session revoke.
  if (baseUser.token_version !== session.token_version) {
    return NextResponse.json({ error: "Session expired." }, { status: 401 });
  }

  // ── P0-1 Session TTL + idle-timeout check (super_admin exempt) ─────────
  // The JWT now carries `expires_at` (application-level absolute expiry,
  // derived from SessionConfig at createSession time) and
  // `last_activity_at` (bumped by POST /api/auth/touch). Both are
  // enforced here for admin + user sessions; super_admin is exempt
  // (CRITICAL INVARIANT — see src/lib/auth/session-config.ts) so a
  // misconfigured TTL can never lock the platform owner out.
  //
  // The check runs BEFORE the impersonation swap so a super_admin's
  // own session is the one being checked (and exempted); the
  // impersonation target's TTL is irrelevant because the impersonation
  // claim carries its own expiry.
  //
  // Legacy sessions minted before P0-1 lack these claims — for those,
  // we fall through (no TTL / idle enforcement) so existing cookies
  // aren't abruptly invalidated. Once every active session has been
  // rotated through the new createSession, this fallback is dead code.
  if (baseUser.role !== "super_admin") {
    try {
      const {
        getSessionConfig,
        isAbsoluteTtlApplicable,
        isIdleTimeoutApplicable,
      } = await import("@/lib/auth/session-config");
      const config = await getSessionConfig();
      // Absolute-TTL check — `expires_at` is ms since epoch.
      if (
        isAbsoluteTtlApplicable(baseUser.role) &&
        typeof session.expires_at === "number" &&
        Date.now() > session.expires_at
      ) {
        return NextResponse.json(
          { error: "Session expired. Please sign in again." },
          { status: 401 },
        );
      }
      // Idle-timeout check — `last_activity_at` is ms since epoch.
      // Only applies if the claim is present (legacy sessions fall
      // through; the JWT-exp cap is the backstop for those).
      if (
        isIdleTimeoutApplicable(baseUser.role) &&
        typeof session.last_activity_at === "number" &&
        Date.now() - session.last_activity_at > config.idleTimeoutMs
      ) {
        return NextResponse.json(
          { error: "Session expired due to inactivity. Please sign in again." },
          { status: 401 },
        );
      }
    } catch (e) {
      // Fail-open on config-load error — better a stale session than
      // locking a real user out when the DB is briefly unreachable.
      // The token_version check above + the JWT-exp cryptographic
      // cap are still in force as backstops.
      console.error("[requireAuth] Session TTL check failed:", e);
    }
  }

  // ── Impersonation handling ────────────────────────────────────────────
  // If the session carries an `impersonating` claim, and it hasn't expired,
  // swap the effective user to the impersonation target. Only super_admins
  // can hold this claim (defense-in-depth check here).
  let impersonation: ImpersonationClaim | undefined;
  let effectiveUser = baseUser;
  if (session.impersonating && baseUser.role === "super_admin") {
    const expired = new Date(session.impersonating.expires_at).getTime() < Date.now();
    if (!expired) {
      const target = await store.getUserById(session.impersonating.target_user_id);
      if (target && target.active) {
        // P1 ghost-JWT hardening (task C-5 Fix 6): the impersonation claim
        // snapshots the target's token_version at impersonation start. If
        // the target's password is reset (or their token_version is bumped
        // for any other reason) while the super_admin is impersonating
        // them, the snapshot no longer matches and the impersonation is
        // revoked — the super_admin falls back to their own identity.
        // Without this check, the super_admin's own JWT (whose
        // token_version was checked above) would keep the impersonation
        // alive for up to MAX_DURATION_MIN minutes after the target was
        // supposed to be revoked.
        //
        // `target_token_version` is optional for backward compatibility
        // with sessions minted before this field was added — for those,
        // we fall back to the expiry-only check (the original behaviour).
        const snap = session.impersonating.target_token_version;
        if (snap !== undefined && snap !== target.token_version) {
          console.warn(
            `[requireAuth] impersonation revoked — target token_version changed ` +
            `(expected ${snap}, current ${target.token_version}). ` +
            `super_admin=${baseUser.id} target=${target.id}`,
          );
          // Fall through as the original super_admin — do NOT set
          // effectiveUser = target. The next /api/super-admin/impersonate/end
          // call (or the client banner's timer) will explicitly restore
          // the cookie.
        } else {
          effectiveUser = target;
          impersonation = session.impersonating;
        }
      }
    }
    // else: expired → fall through as the original super_admin. The next
    // /api/super-admin/impersonate/end call (or the client banner's timer)
    // will explicitly restore the cookie; the session still works meanwhile.
  }

  const { password_hash, totp_secret, ...safe } = effectiveUser;
  const isSuperAdmin = effectiveUser.role === "super_admin" && !impersonation;

  // ── Subscription enforcement ──────────────────────────────────────────
  // SUPER-ADMIN IS NEVER BLOCKED — they manage the platform.
  // Regular users are blocked if their tenant's subscription has expired.
  // When impersonating, we bypass this too — the super_admin is diagnosing.
  if (!isSuperAdmin && !impersonation && effectiveUser.tenant_id) {
    try {
      const tenant = await store.getTenant(effectiveUser.tenant_id);
      if (tenant) {
        // Suspended or cancelled tenants are always blocked
        if (tenant.status === "suspended" || tenant.status === "cancelled") {
          return NextResponse.json(
            { error: "Account suspended. Contact your platform administrator.", subscription_expired: true },
            { status: 402 }
          );
        }
        const now = new Date();
        const subEnd = (tenant as any).subscription_end ? new Date((tenant as any).subscription_end) : null;
        const trialEnd = (tenant as any).trial_ends_at ? new Date((tenant as any).trial_ends_at) : null;
        // Check expiry: if subscription_end is in the past, block
        if (subEnd && subEnd < now) {
          return NextResponse.json(
            { error: "Subscription expired. Contact your platform administrator to renew.", subscription_expired: true },
            { status: 402 }
          );
        }
        // Check trial expiry
        if (String(tenant.status) === "trial" && trialEnd && trialEnd < now) {
          return NextResponse.json(
            { error: "Trial period expired. Subscribe to continue.", subscription_expired: true },
            { status: 402 }
          );
        }
      }
    } catch (e) {
      console.error("[requireAuth] Subscription check failed:", e);
    }
  }

  // ── CSRF defense (P2-18 / F-7) ───────────────────────────────────────
  // Reject cross-site state-changing requests. SameSite=Lax blocks cookies
  // on cross-site sub-resource requests, but top-level navigations still
  // send the cookie — an explicit Origin check closes this gap. We only
  // run the check when the caller has passed the inbound `req` (optional
  // parameter, kept optional so legacy call sites compile unchanged) AND
  // the request is cookie-authenticated (no `Authorization: Bearer` header
  // — bearer-token API-key auth is not vulnerable to CSRF and is exempt).
  //
  // F-7 (audit): hardened two ways —
  //   1. Replace `origin.startsWith(appBaseUrl)` with proper URL.origin
  //      comparison. `startsWith` is vulnerable to prefix attacks
  //      (e.g. `https://aspidus.onrender.com.evil.com` would pass).
  //   2. Add a Host-header fallback when APP_BASE_URL is unset so the CSRF
  //      check is not silently disabled in dev / preview deployments.
  if (req) {
    const authHeader = req.headers.get("authorization");
    const isApiKeyRequest =
      !!authHeader && authHeader.startsWith("Bearer ") && authHeader.slice(7).trim().startsWith("asp_");
    if (!isApiKeyRequest) {
      const method = req.method.toUpperCase();
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        const origin = req.headers.get("origin");
        const appBaseUrl = process.env.APP_BASE_URL;
        // P0-2 (Monitoring) — fire a `csrf.blocked` security event BEFORE
        // returning the 403, so Sentry + the IDS + the security webhooks
        // see every cross-site state-change attempt. NOTE: this applies to
        // super-admin sessions too — CSRF defense is the worst-case
        // scenario the check exists to stop; "super-admin is never blocked"
        // applies to authorization gates, not to transport-level defenses
        // like CSRF / rate limit / TLS. The `csrfBlock()` helper both
        // reports the event and returns the NextResponse.
        const csrfIp = getIp(req);
        const csrfBlock = (details: Record<string, unknown>) => {
          reportSecurityEvent({
            type: "csrf.blocked",
            ip: csrfIp,
            severity: "warning",
            details: { method, ...details },
          });
          return NextResponse.json(
            { error: "Cross-site requests are not allowed." },
            { status: 403 },
          );
        };
        const invalidOriginBlock = (details: Record<string, unknown>) => {
          reportSecurityEvent({
            type: "csrf.blocked",
            ip: csrfIp,
            severity: "warning",
            details: { method, reason: "malformed_origin", ...details },
          });
          return NextResponse.json(
            { error: "Invalid origin." },
            { status: 403 },
          );
        };
        if (appBaseUrl) {
          if (origin) {
            try {
              const allowedOrigin = new URL(appBaseUrl).origin;
              const requestOrigin = new URL(origin).origin;
              if (requestOrigin !== allowedOrigin) {
                return csrfBlock({ allowed: allowedOrigin, got: requestOrigin });
              }
            } catch {
              // Malformed APP_BASE_URL or Origin — reject defensively.
              return invalidOriginBlock({});
            }
          }
          // If origin is missing (same-origin requests sometimes omit it),
          // allow — SameSite=Lax covers this case.
        } else {
          // Fallback when APP_BASE_URL is not configured: compare the
          // Origin header's host to the Host header. They MUST match for
          // same-origin requests. Without this, the entire CSRF check
          // would be silently skipped in dev / preview environments.
          const host = req.headers.get("host");
          if (origin && host) {
            try {
              const originHost = new URL(origin).host;
              if (originHost !== host) {
                return csrfBlock({ allowed_host: host, got_host: originHost });
              }
            } catch {
              return invalidOriginBlock({});
            }
          }
          // If origin is missing, allow — SameSite=Lax covers this case.
        }
      }
    }
  }

  // ── FIX-V1: warm the role-override cache (UI subsystem) ───────────────
  // The super-admin Roles tab writes per-(tenant_id, role) overrides to
  // `settings.role_overrides` (a JSON blob). `can()` consults a SYNC
  // accessor (`getCachedRoleOverrides`) on the hot path — it doesn't await
  // a DB query per check. We warm the cache here (async) so by the time
  // the route handler calls `requirePermission(auth, ...)` the cache is
  // hot. Super-admin + impersonation skip the warmup (super-admin is
  // NEVER subject to overrides; when impersonating, the super-admin's
  // own role is what matters for the bypass, not the target's override).
  //
  // Fail-open: a DB hiccup just means no override applies this request
  // (the cache will retry on the next request when the DB is back). We
  // also re-warm on every request that hits requireAuth — the in-process
  // 5-min cache makes this a no-op once warmed.
  if (!isSuperAdmin && !impersonation && effectiveUser.tenant_id && effectiveUser.role) {
    try {
      const { loadRoleOverrides } = await import("@/lib/permissions/tenant-roles");
      await loadRoleOverrides(effectiveUser.role, effectiveUser.tenant_id);
    } catch (e) {
      // Non-fatal — overrides are additive; a missed warmup just means
      // base perms apply this request. The 5-min cache will retry on
      // the next request.
      console.warn("[requireAuth] loadRoleOverrides warmup failed:", e);
    }
  }

  return {
    user: safe as SafeUser,
    store,
    // 8a-2: pass real client IP (was hardcoded `""` — every audit_log / security
    // event written via `auth.ip` lost the IP, blinding per-IP IDS burst detection).
    // `getIp()` is hoisted (function declaration), and accepts the optional req.
    ip: req ? getIp(req) : "",
    tenantId: effectiveUser.tenant_id,
    isSuperAdmin,
    impersonation,
  };
}

/**
 * Authenticate via API key (Authorization: Bearer asp_xxx).
 * Returns ApiKeyAuthContext with tenant_id and permissions.
 */
export async function requireApiKeyAuth(req: NextRequest): Promise<ApiKeyAuthContext | NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return NextResponse.json({ error: "API key required. Use Authorization: Bearer asp_xxx" }, { status: 401 });
  }
  const rawKey = authHeader.slice(7).trim();
  if (!rawKey.startsWith("asp_")) {
    return NextResponse.json({ error: "Invalid API key format." }, { status: 401 });
  }

  const store = await getStore();
  const result = await store.authenticateApiKey(rawKey);
  if (!result) {
    return NextResponse.json({ error: "Invalid or expired API key." }, { status: 401 });
  }

  // FIX-P1-LOGIC Fix 4: enforce tenant suspension/expiry for API key auth,
  // mirroring the same checks `requireAuth` applies to cookie sessions.
  // Without this, a suspended tenant's API key kept working indefinitely.
  try {
    const tenant = await store.getTenant(result.tenantId);
    if (tenant) {
      if (tenant.status === "suspended" || tenant.status === "cancelled") {
        return NextResponse.json(
          { error: "Account suspended. Contact your platform administrator.", subscription_expired: true },
          { status: 402 }
        );
      }
      const now = new Date();
      const subEnd = (tenant as any).subscription_end ? new Date((tenant as any).subscription_end) : null;
      const trialEnd = (tenant as any).trial_ends_at ? new Date((tenant as any).trial_ends_at) : null;
      if (subEnd && subEnd < now) {
        return NextResponse.json(
          { error: "Subscription expired. Contact your platform administrator to renew.", subscription_expired: true },
          { status: 402 }
        );
      }
      if (String(tenant.status) === "trial" && trialEnd && trialEnd < now) {
        return NextResponse.json(
          { error: "Trial period expired. Subscribe to continue.", subscription_expired: true },
          { status: 402 }
        );
      }
    }
  } catch (e) {
    console.error("[requireApiKeyAuth] Subscription check failed:", e);
  }

  const ip = getIp(req);

  // Update last used (fire-and-forget)
  store.updateApiKeyLastUsed(result.apiKey.id, ip).catch(() => {});

  return {
    store,
    ip,
    tenantId: result.tenantId,
    apiKeyId: result.apiKey.id,
    apiKeyName: result.apiKey.name,
    permissions: result.apiKey.permissions || [],
  };
}

/**
 * Check if an API key has the required permission.
 * Permissions format: "resource:action" or "resource:*" or "*"
 * e.g. "partners:read", "offers:*", "*"
 */
export function hasPermission(permissions: string[], required: string): boolean {
  if (permissions.includes("*")) return true;
  const [resource, action] = required.split(":");
  // Check for resource:* or resource:action
  return permissions.includes(`${resource}:*`) || permissions.includes(required);
}

/**
 * Check permissions for BOTH session-auth and API-key-auth callers.
 *
 * U-FIX (RBAC audit D-1 / P1): nine routes previously wrapped
 * `requirePermission(auth, ...)` inside `if (!("apiKeyId" in auth))`,
 * which meant API-key callers were NEVER permission-checked — any API
 * key (even one created with `permissions: []`) could access the
 * dashboard KPIs, trade calculator, supplier offers, ERP settings
 * (POST mutates!), and automation routes. This helper closes that
 * bypass for any route that adopts it.
 *
 * Usage (replaces the broken pattern):
 *   const auth = await requireAuthOrApiKey(req);
 *   if (auth instanceof NextResponse) return auth;
 *   const denied = requireAuthOrApiKeyPermission(auth, "dashboard.read");
 *   if (denied) return denied;
 *
 * Permission format:
 *   - Pass dot format (e.g. "dashboard.read", "erp.manage_settings") —
 *     this is what the catalog (`lib/permissions/catalog.ts`) and the
 *     session-side `requirePermission()` use.
 *   - For API-key callers, this helper converts dots to colons before
 *     calling `hasPermission()` (which expects colon format like
 *     "dashboard:read"). The conversion is idempotent for callers
 *     that already pass colon format.
 */
export function requireAuthOrApiKeyPermission(
  auth: AuthContext | ApiKeyAuthContext,
  permission: string
): NextResponse | null {
  if ("apiKeyId" in auth) {
    // API-key caller — convert dot format to colon format for
    // `hasPermission()` (which splits on `:` to derive `resource:*`
    // wildcards). Conversion is idempotent for colon-format input.
    const colonPerm = permission.replace(/\./g, ":");
    if (!hasPermission(auth.permissions, colonPerm)) {
      // P0-2 (Monitoring) — fire a `permission.denied` security event
      // BEFORE returning the 403. NOTE: API-key callers are NEVER
      // super-admin (super-admins always auth via session cookie), so
      // every API-key 403 here is a genuine authorization denial — a
      // possible attack signal worth escalating to Sentry + the IDS.
      reportSecurityEvent({
        type: "permission.denied",
        ip: auth.ip,
        details: {
          permission,
          apiKeyId: auth.apiKeyId,
          apiKeyName: auth.apiKeyName,
        },
        severity: "warning",
      });
      return NextResponse.json(
        {
          error: "Insufficient permissions for this API key.",
          required_permission: permission,
        },
        { status: 403 }
      );
    }
    return null;
  }
  // Session-auth caller — delegate to the catalog-aware evaluator.
  // `requirePermission()` runs `can()`, which accepts both dot and
  // colon formats and understands role-based implicit grants.
  //
  // SUPER-ADMIN IS NEVER BLOCKED: `can()` returns true for
  // `role === "super_admin"` (rule 1), so `requirePermission()` returns
  // `null` for super-admin callers — the security event below only
  // fires for actual authorization denials (regular users / API keys
  // lacking the permission). This is the canonical "super-admin is
  // never blocked" guarantee: the report is on the denial path, and
  // super-admins never reach the denial path.
  const denied = requirePermission(auth, permission);
  if (denied) {
    reportSecurityEvent({
      type: "permission.denied",
      userId: auth.user?.id,
      tenantId: auth.tenantId ?? undefined,
      ip: auth.ip,
      details: {
        permission,
        role: auth.user?.role,
      },
      severity: "warning",
    });
  }
  return denied;
}

/**
 * Authenticate via session cookie OR API key.
 * Returns either AuthContext (session) or ApiKeyAuthContext (API key).
 * Use this for endpoints that should support both auth methods.
 */
export async function requireAuthOrApiKey(req: NextRequest): Promise<AuthContext | ApiKeyAuthContext | NextResponse> {
  // Check API key first
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const rawKey = authHeader.slice(7).trim();
    if (rawKey.startsWith("asp_")) {
      return requireApiKeyAuth(req);
    }
  }

  // Fall back to session auth (pass req through so CSRF defense runs).
  return requireAuth(req);
}

/**
 * Require admin or super_admin role.
 *
 * P2-18 / F-7: callers MAY pass the inbound `req` so the CSRF Origin check
 * inside `requireAuth` runs. The parameter is optional so legacy call sites
 * keep compiling, but mutation routes (POST/PUT/PATCH/DELETE) SHOULD pass it.
 */
export async function requireAdmin(req?: NextRequest): Promise<AuthContext | NextResponse> {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    // P0-2 (Monitoring) — fire `permission.denied` for non-admin callers
    // attempting an admin-only route. SUPER-ADMIN IS NEVER BLOCKED: the
    // guard `!auth.isSuperAdmin` is false for super-admin callers, so
    // super-admins never enter this branch. The report fires only for
    // genuine denials (regular users hitting an admin endpoint), which is
    // a meaningful attack signal (privilege-escalation probe).
    reportSecurityEvent({
      type: "permission.denied",
      userId: auth.user.id,
      tenantId: auth.tenantId ?? undefined,
      ip: auth.ip,
      details: { required: "admin_or_super_admin", role: auth.user.role },
      severity: "warning",
    });
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  return auth;
}

/**
 * Require super_admin role (platform-level operations: create tenants, etc.)
 *
 * P2-18 / F-7: callers MAY pass the inbound `req` so the CSRF Origin check
 * inside `requireAuth` runs. The parameter is optional so legacy call sites
 * keep compiling, but mutation routes (POST/PUT/PATCH/DELETE) SHOULD pass it.
 */
export async function requireSuperAdmin(req?: NextRequest): Promise<AuthContext | NextResponse> {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (!auth.isSuperAdmin) {
    // 8a-1: do NOT report when the caller is a super_admin currently
    // impersonating another user — `auth.isSuperAdmin` is intentionally false
    // during impersonation (effectiveUser is the target). Those callers must
    // use `requireSuperAdminOrImpersonating` instead of this helper. Avoid
    // spamming `role.escalation` for legitimate super-admins returning to
    // their own session and calling a super-admin route mid-impersonation.
    if (auth.impersonation) {
      return NextResponse.json(
        { error: "Super-admin access required. End impersonation first." },
        { status: 403 },
      );
    }
    // P0-2 (Monitoring) — fire `role.escalation` for non-super-admin
    // callers attempting a super-admin-only route. The event type is
    // `role.escalation` (not `permission.denied`) because the
    // distinguishable attack pattern is "low-privilege caller probing
    // for super-admin-only surfaces" — that's the platform's #1
    // privilege-escalation recon signal. SUPER-ADMIN IS NEVER BLOCKED:
    // super-admins have `isSuperAdmin === true` and skip this branch
    // entirely (the report only fires for actual denials).
    reportSecurityEvent({
      type: "role.escalation",
      userId: auth.user.id,
      tenantId: auth.tenantId ?? undefined,
      ip: auth.ip,
      details: { required: "super_admin", role: auth.user.role },
      severity: "critical",
    });
    return NextResponse.json({ error: "Super-admin access required." }, { status: 403 });
  }
  return auth;
}

/**
 * 8a-1: Variant of `requireSuperAdmin` used by `/api/super-admin/impersonate/end`.
 *
 * During an active impersonation, `requireAuth` swaps `effectiveUser` to the
 * impersonation TARGET (a regular user) and sets `impersonation = session.impersonating`.
 * Consequently `auth.isSuperAdmin === false` for the duration of the impersonation.
 * Calling `requireSuperAdmin()` from `/impersonate/end` therefore always 403s
 * while impersonation is active — which makes the "End Impersonation" button
 * in the ImpersonateBanner non-functional (super_admin can only escape via
 * full logout, losing the matching `impersonate.end` audit event).
 *
 * This helper allows either:
 *   - a true super_admin (no impersonation active), OR
 *   - a super_admin mid-impersonation (`auth.impersonation` is set + baseUser
 *     role is super_admin — verified by `requireAuth`'s guard at line 139).
 */
export async function requireSuperAdminOrImpersonating(
  req?: NextRequest,
): Promise<AuthContext | NextResponse> {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // `requireAuth` (line 139) only sets `impersonation` when `baseUser.role ===
  // "super_admin"` AND the session carries an `impersonating` claim that has
  // not expired AND the target token_version still matches. Therefore, the
  // presence of `auth.impersonation` is sufficient proof that the original
  // session holder is a super_admin.
  if (auth.isSuperAdmin || auth.impersonation) {
    return auth;
  }
  reportSecurityEvent({
    type: "role.escalation",
    userId: auth.user.id,
    tenantId: auth.tenantId ?? undefined,
    ip: auth.ip,
    details: { required: "super_admin_or_impersonating", role: auth.user.role },
    severity: "critical",
  });
  return NextResponse.json({ error: "Super-admin access required." }, { status: 403 });
}

/**
 * Resolve the effective tenant ID for a request.
 * Super-admins can pass ?tenant_id=xxx to act on a specific tenant.
 * Regular users are locked to their own tenant.
 * API key auth always uses the key's tenant_id.
 */
export function resolveTenantId(auth: AuthContext | ApiKeyAuthContext, req: NextRequest): string | null {
  if ("apiKeyId" in auth) {
    // API key auth — always scoped to the key's tenant
    return auth.tenantId;
  }
  if (auth.isSuperAdmin) {
    // Super-admin: prefer explicit ?tenant_id=xxx. If none is provided, return
    // NULL — tenant-scoped routes MUST refuse rather than silently fall back
    // to the super-admin's own tenant_id (which is null anyway). Platform-
    // level routes (that don't need a tenant scope) shouldn't be calling this.
    const url = new URL(req.url);
    return url.searchParams.get("tenant_id") || null;
  }
  // Impersonation: auth.tenantId already reflects the impersonated user's
  // tenant (requireAuth sets tenantId from effectiveUser.tenant_id).
  return auth.tenantId;
}

/**
 * Resolve the audit "user" object from either auth context flavour.
 * audit12: previously copy-pasted verbatim in 13 API route files — now the
 * single canonical export (routes import it instead of redefining).
 */
export function getAuthUser(auth: AuthContext | ApiKeyAuthContext) {
  if ("user" in auth) return auth.user;
  return { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
}

// AUDIT18: getIp moved to lib/utils/ip.ts (canonical, edge-safe) — the
// middleware's hand-mirrored copy is gone; both import the same function.
import { getIp } from "@/lib/utils/ip";
export { getIp };

export async function audit(
  store: AuthContext["store"],
  user: SafeUser | { id?: string | null; username: string; tenant_id?: string | null },
  req: NextRequest,
  action: string,
  entityType?: string,
  entityId?: string,
  details?: Record<string, unknown>
): Promise<void> {
  try {
    await store.appendAudit({
      // F-FINAL / P1: portal routes previously passed `id: "portal:<uuid>"`
      // here, which failed the audit_logs.user_id FK to users(id). The
      // signature now accepts `id?: string | null | undefined` — when
      // the caller is a portal client, pass `id: undefined` (or omit) so
      // the FK column is set to NULL. The `username` field remains a
      // free-form string carrying "portal:<email>" for traceability.
      user_id: user.id ?? null,
      username: user.username,
      tenant_id: user.tenant_id || null,
      action,
      entity_type: entityType || null,
      entity_id: entityId || null,
      details: details || null,
      ip: getIp(req),
      user_agent: req.headers.get("user-agent") || null,
    });
  } catch (e) {
    // P1 audit-trail fix (task C-5 Fix 2): previously the error was
    // swallowed with a generic `console.error("[audit]", e)` line that
    // gave ops no way to triage WHERE the audit gap occurred. The audit
    // trail is the compliance record of "who did what to which entity" —
    // a silent gap is itself a compliance violation (GDPR Art. 5(2)
    // integrity + accountability; SOC 2 CC7.2). We still don't throw —
    // the main operation must succeed even if audit logging fails — but
    // we DO log prominently with enough context to investigate.
    console.error("[AUDIT FAILED]", {
      action,
      entityType: entityType || null,
      entityId: entityId || null,
      userId: user.id,
      tenantId: user.tenant_id || null,
      ip: getIp(req),
      error: e instanceof Error ? e.message : String(e),
      // Include the stack for non-trivial errors so the log entry points
      // at the call site. `String(e)` covers non-Error throws (e.g. a
      // string thrown by a legacy code path).
      stack: e instanceof Error ? e.stack : undefined,
    });
  }
}

/**
 * Sanitize a thrown error before exposing it to the API client.
 *
 * P2 / task C-6 Fix 5: raw Postgres error messages leak database internals
 * — table names, column names, constraint names, schema details — that an
 * attacker can use to map the schema for follow-on attacks. Common leaks
 * from PostgREST/Postgres:
 *
 *   • `relation "public.users" does not exist` → leaks schema + table name
 *   • `column "password_hash" of relation "users" does not exist` → leaks
 *     both the column and the table
 *   • `violates foreign key constraint "fk_offers_partner_id"` → leaks
 *     the constraint name (and thus the FK relationship)
 *   • `duplicate key value violates unique constraint "users_email_key"`
 *     → leaks the indexed column
 *   • `syntax error at or near "FROM"` → leaks that the server is building
 *     raw SQL (a code-injection indicator)
 *
 * The original error is still logged server-side via `console.error` by
 * the caller; this helper only controls what the HTTP response body says.
 * Returns a generic message when the input doesn't match a known pattern
 * — fail closed (don't leak anything) rather than open.
 *
 * IMPORTANT: callers should still `console.error` the original error so
 * ops can triage. This helper is for the OUTBOUND response only.
 */
export function sanitizeError(e: unknown): string {
  // F-FINAL / P0: supabase-js returns plain-object PostgrestError shapes
  // (NOT `Error` instances) — `{ message, code, details, hint }` — so the
  // previous `e instanceof Error ? e.message : String(e ?? "")` branch
  // produced `[object Object]` for every DB error. Strip the .message
  // property off plain objects first, then fall back to String coercion.
  let msg: string;
  if (e instanceof Error) {
    msg = e.message;
  } else if (typeof e === "object" && e !== null && "message" in e) {
    msg = String((e as { message: unknown }).message ?? "");
  } else {
    msg = String(e ?? "");
  }
  if (!msg) return "Internal server error.";
  return msg
    // ── Schema/table/column leaks ────────────────────────────────────────
    // PostgREST surfaces these verbatim. Order matters: the SPECIFIC patterns
    // (column-of-relation, value-of-column-of-relation) MUST run before the
    // general ones (relation/column/does-not-exist), otherwise the general
    // pattern consumes a substring of the specific one and leaves the column
    // name in the output. (Regression caught by the api-helpers test suite.)
    .replace(/column "[^"]+" of relation "[^"]+" does not exist/gi, "Database error.")
    .replace(/null value in column "[^"]+" of relation "[^"]+"/gi, "Database error")
    .replace(/update or delete on table "[^"]+"/gi, "Database error")
    .replace(/on table "[^"]+"/gi, "Database error")
    .replace(/null value in column "[^"]+"/gi, "Database error")
    .replace(/relation "[^"]+" does not exist/gi, "Database error.")
    .replace(/column "[^"]+" does not exist/gi, "Database error.")
    .replace(/schema "[^"]+" does not exist/gi, "Database error.")
    // ── Constraint leaks ─────────────────────────────────────────────────
    // Names hint at FK relationships + indexed columns. The constraint
    // violation clause itself is replaced with a category-level message
    // (Duplicate entry / Referential integrity error / etc.); the
    // surrounding table/column references were already stripped above.
    .replace(/violates foreign key constraint[^.]*\.?/gi, "Referential integrity error.")
    .replace(/violates unique constraint[^.]*\.?/gi, "Duplicate entry.")
    .replace(/duplicate key value[^.]*\.?/gi, "Duplicate entry.")
    .replace(/violates not-null constraint[^.]*\.?/gi, "Missing required field.")
    .replace(/violates check constraint[^.]*\.?/gi, "Value violates constraint.")
    // ── SQL syntax errors ────────────────────────────────────────────────
    // Leak that the server is constructing raw SQL — strip the offending
    // token so an attacker can't tell which clause was malformed.
    .replace(/syntax error at or near[^.]*\.?/gi, "Database error.")
    .replace(/invalid input syntax for type[^.]*\.?/gi, "Invalid input format.")
    // ── Permission / RLS errors ──────────────────────────────────────────
    // Keep generic so we don't confirm the existence of a row the caller
    // shouldn't know about. RLS denials look like "Not found." so the
    // caller can't distinguish "row doesn't exist" from "you can't see it".
    .replace(/permission denied for (table|sequence|function) [^.\s]+/gi, "Permission denied.")
    .replace(/new row for relation "[^"]+" violates row-level security policy[^.]*\.?/gi, "Not found.")
    // ── FIX-ALL-2 / Fix 4: strip "Record not found (table=…)" table-name
    // leak. Postgres RPC functions (e.g. the atomic doc-number insert in
    // migration 032) raise `Record not found (table=offers)` when a
    // pre-condition join fails. The literal table name in the parentheses
    // leaks the schema to the API client. Strip just the parenthesised
    // clause, leaving the human-readable "Record not found." prefix.
    .replace(/Record not found\s*\(\s*table=[^)]*\)/gi, "Record not found")
    .replace(/\(\s*table=[^)]*\)/gi, "")
    // ── Collapse the leftover double-spaces that come from chained
    // substitutions (e.g. "Database error Database error. Missing required
    // field." → "Database error. Missing required field."). Cosmetic, but
    // keeps the response body readable when the original Postgres message
    // hit several patterns at once.
    .replace(/\s{2,}/g, " ")
    // ── FIX-ALL-2 / Fix 4: remove the "Database error" prefix that the
    // chained schema/table/column substitutions leave in front of a more
    // specific suffix (audit Part D, "Database error Missing required
    // field."). The bare `Database error.` message (period, no further
    // text) is preserved — only the prefix-then-other-word form is
    // stripped, so existing api-helpers.test.ts assertions that expect
    // `toBe("Database error.")` still pass.
    .replace(/^Database error\s+(?=\S)/i, "")
    .replace(/(\s)Database error\s+(?=\S)/gi, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Wrap an error in a sanitized message for the NextResponse body, while
 * still logging the full original error server-side. Convenience wrapper
 * for routes that follow the standard `catch (e: any) { return 500 }`
 * pattern.
 *
 * Usage:
 *   } catch (e: any) {
 *     console.error("[route/name]", e);
 *     return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
 *   }
 */
export function sanitizeErrorMessage(e: unknown): string {
  return sanitizeError(e);
}
