import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { getStore } from "@/lib/data/store";

const COOKIE_NAME = "crm_session";
const SESSION_TTL_DAYS = 7;

/**
 * TTL for the short-lived 2FA temp token (issued by /api/auth/login after a
 * valid password but BEFORE TOTP verification). 5 minutes is long enough
 * that a user typing a 6-digit code by hand won't time out, but short
 * enough that a stolen temp token is a narrow window.
 */
const TWO_FACTOR_TEMP_TTL_SEC = 5 * 60;

export interface ImpersonationClaim {
  original_super_admin_id: string;
  original_username: string;
  target_user_id: string;
  target_tenant_id: string | null;
  expires_at: string; // ISO
  /**
   * Snapshot of `users.token_version` for the impersonation target at the
   * time the claim was minted. P1 ghost-JWT hardening (task C-5 Fix 6):
   * if the target's password is reset (or their token_version is bumped
   * for any other reason) while a super_admin is impersonating them, the
   * next request will detect the mismatch and revoke the impersonation.
   * Without this snapshot, the super_admin's own JWT (which carries the
   * super_admin's token_version, NOT the target's) would keep working
   * for up to MAX_DURATION_MIN minutes after the target was supposed to
   * be revoked — a narrow but real ghost-JWT window for the target user.
   *
   * Optional for backward compatibility — sessions issued before this
   * field was added simply omit it, and `requireAuth` falls back to the
   * expiry-only check for those.
   */
  target_token_version?: number;
}

export interface SessionPayload {
  sub: string;
  username: string;
  role: string;
  token_version: number;
  tenant_id: string | null;
  /** Optional impersonation context — present only while a super_admin is acting as another user. */
  impersonating?: ImpersonationClaim;
  /**
   * Application-level absolute session expiry (ms since epoch). Distinct
   * from the JWT `exp` claim (which is the cryptographic-validity cap set
   * to SESSION_TTL_DAYS = 7d). `requireAuth` rejects sessions whose
   * `expires_at` is in the past — this is the role-based TTL surface
   * (admin = 8h, user = 8h by default) enforced by SessionConfig.
   *
   * P0-1 CRITICAL INVARIANT: super_admin sessions carry a far-future
   * `expires_at` (100 years from issue) AND `requireAuth` skips the
   * absolute-TTL check for them — they never expire on idle or absolute
   * TTL. Set at createSession time via `getSessionTtlForRole(role, config)`
   * (see session-config.ts).
   */
  expires_at?: number;
  /**
   * Last activity timestamp (ms since epoch). Bumped by
   * `bumpSessionActivity` (called from POST /api/auth/touch). requireAuth
   * rejects sessions whose last_activity_at is older than
   * SessionConfig.idleTimeoutMs (admin + user only; super_admin exempt).
   */
  last_activity_at?: number;
  iat?: number;
  exp?: number;
}

function getSecret(): Uint8Array {
  // P0-3 / Feature 1 — vault key separation: prefer JWT_SECRET_KEY (a
  // JWT-only secret decoupled from the vault / field-encryption layer),
  // falling back to SECRET_KEY for backward compatibility. Deployments
  // that set ONLY SECRET_KEY keep working bit-for-bit; deployments that
  // want the separation set JWT_SECRET_KEY (different random value) AND
  // keep SECRET_KEY for the vault / field-encryption fallbacks. A
  // JWT-key compromise therefore cannot decrypt the vault, and a vault-
  // key leak cannot forge session tokens.
  const s = process.env.JWT_SECRET_KEY || process.env.SECRET_KEY;
  if (!s || s.length < 32) {
    throw new Error(
      "JWT_SECRET_KEY (or SECRET_KEY) environment variable is required in every " +
      "environment and must be at least 32 characters. " +
      "Generate one with: openssl rand -hex 32"
    );
  }
  return new TextEncoder().encode(s);
}

/**
 * Mint a session JWT for a freshly-authenticated user.
 *
 * P0-1 (Auth Security): the JWT now carries `expires_at` (application-level
 * absolute expiry, derived from SessionConfig by role) and
 * `last_activity_at` (seeded to Date.now() so the idle-timeout clock
 * starts the moment the session is issued). `requireAuth` checks both:
 *   - `expires_at` past now → 401 "Session expired" (super_admin exempt).
 *   - `last_activity_at` older than idleTimeoutMs → 401 "Session expired
 *     due to inactivity" (super_admin exempt).
 *
 * The JWT's cryptographic `exp` claim is set to SESSION_TTL_DAYS (7d) as
 * the hard upper cap on signature validity — even if the SessionConfig
 * TTL were misconfigured to 30 days, the JWT itself stops verifying at
 * 7d and `verifySession` returns null.
 *
 * For super_admin the SessionConfig returns Infinity; Infinity coerces
 * to `null` when JSON-serialised, which would lose the value in the JWT
 * claim set. We materialise it as a 100-year far-future timestamp so
 * the value survives the round-trip. `requireAuth`'s
 * `isAbsoluteTtlApplicable` check still skips the comparison for
 * super_admin regardless, so the 100-year placeholder is never actually
 * consulted — it just has to be a finite, large number.
 */
export async function createSession(payload: Omit<SessionPayload, "iat" | "exp">): Promise<string> {
  // P0-1: derive the role-based absolute TTL from SessionConfig. We
  // intentionally load the config inside createSession so a config
  // update (PUT /api/settings/session-config) takes effect on the next
  // login, not just on the next server restart. Failures fall back to
  // the 7-day JWT-exp cap so a DB outage doesn't break login entirely.
  let expiresAt: number;
  try {
    const { getSessionConfig, getSessionTtlForRole } = await import("@/lib/auth/session-config");
    const config = await getSessionConfig();
    const ttl = getSessionTtlForRole(payload.role, config);
    // Infinity → 100-year far-future so the value survives JSON
    // serialisation in the JWT claim set without becoming `null`.
    expiresAt = ttl === Infinity
      ? Date.now() + 100 * 365 * 24 * 60 * 60 * 1000
      : Date.now() + ttl;
  } catch {
    expiresAt = Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
  }

  const token = await new SignJWT({
    ...payload,
    expires_at: expiresAt,
    last_activity_at: Date.now(),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_DAYS}d`)
    .sign(getSecret());
  return token;
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    // Audit 2a-F1 fix: reject 2FA temp tokens presented as full session
    // cookies. A temp token (kind:"2fa_temp") is only valid for the
    // /api/auth/2fa/login flow (5-minute TTL, issued after password verify
    // but before TOTP). If accepted here, an attacker who knows the password
    // can plant the tempToken in the crm_session cookie and bypass 2FA
    // entirely — every requireAuth-protected route would admit them for the
    // temp token's 5-minute lifetime (and, combined with 2a-F6, the touch
    // route would re-sign it into a 7-day full session).
    //
    // The `kind` marker is set by `issueTwoFactorTempToken` and is
    // cryptographically bound to the JWT signature (an attacker cannot strip
    // it without invalidating the signature). Checking it here is the single
    // fix that closes the 2FA-bypass hole for every protected route at once.
    if ((payload as { kind?: string } | null)?.kind === "2fa_temp") {
      return null;
    }
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

export async function getSessionFromCookie(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return verifySession(token);
}

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;

// ─────────────────────────────────────────────────────────────────────────────
// 2FA temp-token helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Payload carried by the short-lived 2FA temp token. Issued by
 * /api/auth/login AFTER the password verifies but BEFORE TOTP, and
 * consumed by /api/auth/2fa/login to complete the 2FA flow.
 *
 * `token_version` is snapshotted from the user row at issue time and
 * re-checked at /2fa/login — if the user's password was reset (or their
 * token_version bumped for any reason) between temp-token issue and
 * TOTP verification, the temp token is refused.
 */
export interface TwoFactorTempPayload {
  sub: string;
  username: string;
  role: string;
  token_version: number;
  tenant_id: string | null;
  /** Cryptographic marker — distinguishes 2FA temp tokens from full session JWTs. */
  kind: "2fa_temp";
  iat?: number;
  exp?: number;
}

/**
 * Mint a short-lived (5min) JWT identifying a user who has verified their
 * password but not yet their TOTP. The /api/auth/2fa/login route consumes
 * this + the TOTP code from the user's authenticator app, and on success
 * issues a FULL session cookie (createSession).
 *
 * CRITICAL: this is NEVER issued for super_admin — the login route skips
 * the 2FA branch for super_admin and issues a full session directly.
 * (An attacker who steals a super_admin's password still has no TOTP
 * bypass to attempt because there's no temp token to attack.)
 */
export async function issueTwoFactorTempToken(
  payload: Omit<TwoFactorTempPayload, "kind" | "iat" | "exp">,
): Promise<string> {
  const token = await new SignJWT({ ...payload, kind: "2fa_temp" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TWO_FACTOR_TEMP_TTL_SEC}s`)
    .sign(getSecret());
  return token;
}

/**
 * Verify a 2FA temp token. Returns the payload on success, null on any
 * failure (expired, malformed, wrong secret, missing `kind: "2fa_temp"`
 * marker — the marker guards against a full session JWT being passed
 * in place of a temp token).
 */
export async function verifyTwoFactorTempToken(
  token: string,
): Promise<TwoFactorTempPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (payload.kind !== "2fa_temp") return null;
    return payload as unknown as TwoFactorTempPayload;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Idle-timeout bump helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-sign the session JWT with `last_activity_at = Date.now()`. Preserves
 * the original `exp` and `expires_at` so the absolute TTL clock is NOT
 * reset by activity — only the idle window is. Called by
 * POST /api/auth/touch on every heartbeat from the frontend.
 *
 * The caller passes the current payload (from `getSessionFromCookie`);
 * we re-sign with the same secret + a fresh iat. The 7-day JWT-exp cap
 * is re-applied (the new token's exp = now + 7d). This is intentional —
 * `setExpirationTime("7d")` is the cryptographic-validity cap, distinct
 * from the application-level `expires_at` which carries the role-based
 * TTL and is preserved from the original session. If `expires_at` is
 * missing (legacy session minted before P0-1), fall back to a fresh
 * 7d so we don't accidentally mint a never-expiring admin session.
 */
export async function bumpSessionActivity(
  session: SessionPayload,
): Promise<string> {
  // Audit 2a-F6 fix: refuse to re-sign a 2FA temp token as a full session.
  // Even though `verifySession` now rejects `kind:"2fa_temp"` (2a-F1 fix),
  // the /api/auth/touch route may decode the JWT payload directly and pass
  // it here. Defense-in-depth: throw if a temp token reaches us, forcing the
  // caller's try/catch to return 401 instead of minting a 7-day session.
  // Without this guard, the touch route would re-sign the temp token with a
  // fresh 7-day `exp` AND a fallback 7-day `expires_at`, turning a 5-minute
  // 2FA temp token into a permanent full session cookie.
  if ((session as { kind?: string } | null)?.kind === "2fa_temp") {
    throw new Error("Refusing to bump 2FA temp token as a full session.");
  }
  const expiresAt =
    typeof session.expires_at === "number"
      ? session.expires_at
      : Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

  // Strip iat/exp — Jose will re-set them on re-sign. Keeping the
  // originals would produce a malformed JWT (Jose refuses duplicate
  // registered claims).
  const { iat: _omitIat, exp: _omitExp, ...rest } = session;
  void _omitIat;
  void _omitExp;

  const token = await new SignJWT({
    ...rest,
    expires_at: expiresAt,
    last_activity_at: Date.now(),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_DAYS}d`)
    .sign(getSecret());
  return token;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session security helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum number of concurrent active sessions a single user may hold.
 * Enforced by `enforceConcurrentSessionLimit` below on every successful
 * login — oldest session is revoked (LRU) when the limit is exceeded.
 *
 * 5 is generous enough that a user with a phone, laptop, tablet, and two
 * browser profiles never hits it, but tight enough that a stolen-cookie
 * farm can't accumulate hundreds of sessions.
 */
export const MAX_CONCURRENT_SESSIONS = 5;

/**
 * Revoke every active session for a user.
 *
 * Called after a password change (admin reset OR user self-change) so that
 * any session cookies issued before the change — including ones on lost or
 * stolen devices — stop being accepted on their very next request.
 *
 * The JWT layer's `token_version` check already short-circuits revoked
 * sessions at the auth layer (`requireAuth`); this function performs the
 * matching DB-side cleanup so the admin "Sessions" panel reflects reality
 * and revocation survives across server restarts (JWT validation alone
 * can't, because the JWT is stateless).
 *
 * Failures are logged but never thrown — a password change must succeed even
 * if the sessions table is briefly unreachable.
 */
export async function rotateUserSessions(userId: string, tenantId: string | null): Promise<void> {
  if (!tenantId) {
    // Platform-level (super_admin) accounts have no tenant_id and the
    // sessions table has a NOT NULL constraint on tenant_id — there's
    // nothing to revoke. Their token_version is still bumped by callers
    // for the JWT-side invalidation.
    return;
  }
  try {
    const store = await getStore();
    const sessions = await store.listSessions(tenantId, userId);
    const active = sessions.filter((s) => !s.revoked);
    if (active.length === 0) return;
    // Revoke in parallel — best-effort, individual failures don't abort the rest.
    await Promise.all(
      active.map((s) =>
        store.revokeSession(s.id).catch((e) => {
          console.error("[rotateUserSessions] revokeSession failed for", s.id, e);
        })
      )
    );
  } catch (e) {
    console.error("[rotateUserSessions] failed for", userId, e);
  }
}

/**
 * Enforce the concurrent-session limit by revoking the OLDEST active sessions
 * that exceed the cap.
 *
 * CRITICAL FIX (audit P2-11): this MUST be called AFTER the new session row
 * has been created (not before). The previous "read-then-revoke-before-create"
 * flow had a race: two concurrent logins could both observe `count < max`
 * (stale read before either creates), then both create sessions, leaving the
 * user with `max + 1` active sessions. By running the cleanup AFTER the new
 * session exists, the new session is included in the count — if the total
 * exceeds `max`, the oldest (NOT the just-created one) is revoked.
 *
 * Idempotent + safe to call on every login: if the user is at or under the
 * limit, this is a no-op.
 */
export async function enforceConcurrentSessionLimit(
  userId: string,
  tenantId: string,
  max: number = MAX_CONCURRENT_SESSIONS
): Promise<void> {
  try {
    const store = await getStore();
    const sessions = await store.listSessions(tenantId, userId);
    // Only consider sessions that are BOTH unrevoked AND not yet expired —
    // expired rows are cleaned up by a separate cron and shouldn't count
    // against the limit (otherwise we'd evict live sessions to make room
    // for already-dead ones).
    const active = sessions
      .filter((s) => !s.revoked && new Date(s.expires_at) > new Date())
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
    // If we're over the limit, revoke the OLDEST session(s) — `active` is
    // sorted oldest-first, so `slice(0, active.length - max)` yields exactly
    // the surplus. The just-created session is at the END of the array
    // (newest) and is never revoked.
    if (active.length > max) {
      const toRevoke = active.slice(0, active.length - max);
      for (const s of toRevoke) {
        try {
          // AUDIT29: bumpToken:false — evicting the OLDEST session must only
          // revoke that row. Bumping token_version here logged the user out
          // of EVERY device on their 6th login (the "random client logouts"
          // root cause). The evicted session's JWT still honors its own
          // absolute/idle TTL (≤8h), which bounds the residual window.
          await store.revokeSession(s.id, { bumpToken: false });
        } catch (e) {
          console.error("[enforceConcurrentSessionLimit] revokeSession failed:", e);
        }
      }
    }
  } catch (e) {
    console.error("[enforceConcurrentSessionLimit] failed for", userId, e);
  }
}
