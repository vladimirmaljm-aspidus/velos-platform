/**
 * Session TTL configuration — loaded from the DB settings table.
 *
 * CRITICAL INVARIANT: super_admin sessions never expire and never hit an
 * idle timeout. This is enforced in `requireAuth` (and the login route)
 * — `getSessionTtlForRole(super_admin)` returns `Infinity` regardless of
 * what is stored in the DB, so even an accidental misconfiguration can't
 * lock the platform owner out. The DB-backed `superAdminTtlMs` is kept
 * for API symmetry but `requireAuth` ignores it.
 *
 * Defaults:
 *   - super_admin: Infinity (never expires)
 *   - admin:        8h
 *   - user:         8h
 *   - idle timeout: 30min
 *
 * Configurable by super-admins via PUT /api/settings/session-config.
 */

export interface SessionConfig {
  /**
   * TTL for super_admin sessions. Stored but NOT enforced — super_admin
   * sessions never expire (see CRITICAL INVARIANT above). Kept in the
   * interface so the Settings UI can show / restore the stored value.
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
  superAdminTtlMs: Infinity,
  adminTtlMs: 8 * 60 * 60 * 1000, // 8h
  userTtlMs: 7 * 24 * 60 * 60 * 1000, // 7d (matches the login cookie maxAge)
  idleTimeoutMs: 30 * 60 * 1000, // 30min
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
 * the session's `expires_at` when minting a JWT. Super_admin always
 * returns Infinity — see CRITICAL INVARIANT above. Portal-client sessions
 * (role=portal_client) get the same TTL as regular users.
 */
export function getSessionTtlForRole(
  role: string,
  config: SessionConfig,
): number {
  if (role === "super_admin") return Infinity;
  if (role === "admin") return config.adminTtlMs;
  return config.userTtlMs;
}

/**
 * Whether the idle-timeout check should apply to this role. Super_admin
 * is exempt; portal_client is treated like a regular user (idle timeout
 * applies).
 */
export function isIdleTimeoutApplicable(role: string): boolean {
  return role !== "super_admin";
}

/**
 * Whether the absolute-TTL check should apply to this role. Super_admin
 * is exempt; everyone else is checked against `expires_at`.
 */
export function isAbsoluteTtlApplicable(role: string): boolean {
  return role !== "super_admin";
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
  // superAdminTtlMs is allowed to be Infinity or a finite positive number.
  // The check still runs (for the Settings UI) even though `requireAuth`
  // ignores the value for super_admin.
  if (config.superAdminTtlMs !== undefined) {
    const v = config.superAdminTtlMs;
    if (typeof v !== "number" || isNaN(v) || (v !== Infinity && (v < 60_000 || v > 365 * 24 * 60 * 60 * 1000))) {
      errors.push("superAdminTtlMs must be Infinity or between 60000 and 1 year (in ms).");
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
