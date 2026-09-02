/**
 * Session TTL configuration — loaded from the DB settings table.
 *
 * Audit C1 / 2a-F2 fix (2026-08-30): super_admin sessions now have a
 * FINITE absolute TTL (24h default) AND are subject to idle timeout
 * (30min, same as admin/user). The previous "never expires, never
 * idle-times-out" posture meant a stolen super_admin cookie was a
 * permanent, undetectable backdoor — the JWT exp cap of 7d was refreshed
 * on every /api/auth/touch heartbeat via bumpSessionActivity, so an
 * attacker who stole the cookie and ran the heartbeat had access forever.
 * A finite 24h TTL bounds the exposure window; the 30min idle timeout
 * kills inactive stolen sessions quickly.
 *
 * The "super_admin is never locked out of LOGIN" guarantee is preserved
 * — that refers to the per-user LOGIN rate-limit (super_admin is exempt
 * from the per-user login attempt cap so they can't be locked out by a
 * brute-force botnet). It does NOT mean their SESSION never expires. If
 * a super_admin's session expires, they log in again (the login rate-limit
 * won't block them).
 *
 * To revoke a stolen super_admin session BEFORE the 24h TTL hits:
 *   - POST /api/auth/logout-all (bumps token_version, invalidating all
 *     their JWTs immediately — the requireAuth token_version check
 *     rejects the old JWT on the very next request)
 *   - Change the super_admin's password (also bumps token_version)
 *
 * NOTE for operators deploying this fix: existing super_admin sessions
 * (minted before the fix) carry a 100-year placeholder `expires_at`.
 * They are now subject to the 30min idle timeout, so they will expire
 * naturally on the next 30min gap. To force immediate revocation of ALL
 * existing super_admin sessions, bump the super_admin's token_version
 * via POST /api/auth/logout-all after deploying.
 *
 * Defaults (post-fix):
 *   - super_admin: 24h absolute, 30min idle (was Infinity / no idle)
 *   - admin:        8h, 30min idle
 *   - user:         7d, 30min idle
 *
 * Configurable by super-admins via PUT /api/settings/session-config.
 *
 * audit25 INCIDENT NOTE (2026-09-02): production had userTtlMs=4h
 * (4,000,000-class override set at some point without an audit row).
 * Every portal client + regular user was therefore hard-logged-out
 * 4 HOURS after login EVEN WHILE ACTIVELY WORKING (bumpSessionActivity
 * preserves expires_at by design — activity extends the idle window,
 * never the absolute cap). Users reported it as "the app logs me out
 * for no reason". Fixed in production: userTtlMs=7d (matches the 7-day
 * cookie maxAge + JWT exp cap — there is no security benefit to an
 * absolute TTL shorter than the cookie), idleTimeoutMs=60min.
 * LESSON: userTtlMs below 24h for a B2B portal is a UX foot-gun; the
 * JWT layer (exp cap 7d) + token_version revocation already bound the
 * exposure of a stolen cookie. If you tighten these values, tell the
 * clients first — the frontend now warns 15min before absolute expiry
 * (see /api/auth/touch + use-session-heartbeat).
 */

export interface SessionConfig {
  /**
   * Absolute TTL for super_admin sessions. Audit C1 fix: NOW ENFORCED
   * (was "stored but not enforced" — super_admin never expired). Default
   * 24h. See file header for rationale.
   */
  superAdminTtlMs: number;
  /** TTL for admin role sessions. */
  adminTtlMs: number;
  /** TTL for user role sessions. */
  userTtlMs: number;
  /**
   * Idle timeout — applies to admin + user sessions. A session whose
   * last_activity_at is older than this is rejected with 401 "Session
   * expired due to inactivity". Super_admin sessions skip this check.
   */
  idleTimeoutMs: number;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  // Audit C1 fix: was Infinity. A finite 24h absolute TTL bounds the
  // exposure window of a stolen super_admin cookie (was permanent).
  superAdminTtlMs: 24 * 60 * 60 * 1000, // 24h (was Infinity)
  adminTtlMs: 8 * 60 * 60 * 1000, // 8h
  userTtlMs: 7 * 24 * 60 * 60 * 1000, // 7d (matches the login cookie maxAge)
  idleTimeoutMs: 30 * 60 * 1000, // 30min (applies to admin/user/super_admin — C1 fix)
};

let cachedConfig: SessionConfig | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Load session-config from the platform-level settings row
 * (`key=session_config`, `tenant_id IS NULL`). Falls back to defaults
 * when DB is unreachable or the row is absent. Caches for 5min to
 * avoid hammering the DB on every auth check.
 */
export async function getSessionConfig(): Promise<SessionConfig> {
  if (cachedConfig && Date.now() < cacheExpiry) {
    return cachedConfig;
  }
  try {
    const { getSupabase, isSupabaseConfigured } = await import("@/lib/supabase/client");
    if (!isSupabaseConfigured()) {
      return DEFAULT_SESSION_CONFIG;
    }
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("settings")
      .select("value")
      .eq("key", "session_config")
      .is("tenant_id", "null")
      .maybeSingle();

    if (error || !data) {
      cachedConfig = DEFAULT_SESSION_CONFIG;
    } else {
      cachedConfig = { ...DEFAULT_SESSION_CONFIG, ...(data.value as Partial<SessionConfig>) };
    }
    cacheExpiry = Date.now() + CACHE_TTL_MS;
    return cachedConfig;
  } catch {
    return DEFAULT_SESSION_CONFIG;
  }
}

/**
 * Resolve the TTL for a given role. The login route uses this to compute
 * the session's `expires_at` when minting a JWT. Audit C1 fix: super_admin
 * now returns config.superAdminTtlMs (default 24h) — was Infinity.
 * Portal-client sessions (role=portal_client) get the same TTL as regular
 * users.
 */
export function getSessionTtlForRole(
  role: string,
  config: SessionConfig,
): number {
  // C1 fix: was `return Infinity` — made stolen cookies permanent.
  if (role === "super_admin") return config.superAdminTtlMs;
  if (role === "admin") return config.adminTtlMs;
  return config.userTtlMs;
}

/**
 * Whether the idle-timeout check should apply to this role. Audit C1 fix:
 * super_admin is NOW subject to idle timeout (30min default, same as
 * admin/user). Was exempt, which let stolen cookies stay alive indefinitely
 * as long as /api/auth/touch heartbeated every <30min. If the touch
 * route stops heartbeating (e.g. attacker closes the tab), the session
 * dies in 30min.
 */
export function isIdleTimeoutApplicable(role: string): boolean {
  return true; // C1 fix: was `role !== "super_admin"`
}

/**
 * Whether the absolute-TTL check should apply to this role. Audit C1 fix:
 * super_admin is NOW subject to the absolute TTL (24h default). Was exempt,
 * which made stolen cookies valid for the full 7d JWT exp cap (refreshed
 * on every touch).
 */
export function isAbsoluteTtlApplicable(role: string): boolean {
  return true; // C1 fix: was `role !== "super_admin"`
}

export function invalidateSessionConfigCache(): void {
  cachedConfig = null;
  cacheExpiry = 0;
}

/**
 * Validate a partial SessionConfig update. Returns a list of human-readable
 * error strings; empty array means valid.
 */
export function validateSessionConfig(config: Partial<SessionConfig>): string[] {
  const errors: string[] = [];
  // 8a-9: superAdminTtlMs MUST be a finite number between 1min and 7d.
  // Previously accepted `Infinity` — which `createSession` materialised as
  // a 100-year `expires_at`, reintroducing the C1 permanent-session
  // backdoor via a single `PUT /api/settings/session-config` call from a
  // super_admin (or any future code path that allowed Infinity through).
  // The C1 fix set the default to 24h; this validator now enforces that
  // upper bound at the API surface too. `isAbsoluteTtlApplicable` still
  // returns `true` for super_admin post-C1, so `Infinity` is no longer
  // "safe" even as a documentation placeholder.
  if (config.superAdminTtlMs !== undefined) {
    const v = config.superAdminTtlMs;
    if (typeof v !== "number" || isNaN(v) || v < 60_000 || v > 7 * 24 * 60 * 60 * 1000) {
      errors.push(
        "superAdminTtlMs must be between 60000 (1min) and 604800000 (7d) — Infinity is rejected (C1 fix: super_admin is now subject to absolute TTL).",
      );
    }
  }
  const finiteFields: Array<[keyof SessionConfig, number, number]> = [
    ["adminTtlMs", 60_000, 365 * 24 * 60 * 60 * 1000],
    ["userTtlMs", 60_000, 365 * 24 * 60 * 60 * 1000],
    ["idleTimeoutMs", 60_000, 24 * 60 * 60 * 1000],
  ];
  for (const [field, min, max] of finiteFields) {
    const val = config[field];
    if (val !== undefined) {
      if (typeof val !== "number" || isNaN(val) || val < min || val > max) {
        errors.push(`${field} must be between ${min} and ${max} (in ms).`);
      }
    }
  }
  return errors;
}
