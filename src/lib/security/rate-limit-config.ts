/**
 * Rate limit configuration — loaded from the database (settings table).
 * Super-admins can adjust these via the Settings UI.
 * Falls back to sensible defaults if not configured or if DB is unreachable.
 */

export interface RateLimitConfig {
  loginMaxAttempts: number;
  loginWindowMs: number;
  portalLoginMaxAttempts: number;
  portalLoginWindowMs: number;
  forgotPasswordMaxAttempts: number;
  forgotPasswordWindowMs: number;
  setupPasswordMaxAttempts: number;
  setupPasswordWindowMs: number;
  middlewareLoginMaxRequests: number;
  middlewarePortalLoginMaxRequests: number;
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  loginMaxAttempts: 20,
  loginWindowMs: 15 * 60 * 1000,
  portalLoginMaxAttempts: 20,
  portalLoginWindowMs: 15 * 60 * 1000,
  forgotPasswordMaxAttempts: 5,
  forgotPasswordWindowMs: 15 * 60 * 1000,
  setupPasswordMaxAttempts: 10,
  setupPasswordWindowMs: 15 * 60 * 1000,
  middlewareLoginMaxRequests: 30,
  middlewarePortalLoginMaxRequests: 30,
};

let cachedConfig: RateLimitConfig | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function getRateLimitConfig(): Promise<RateLimitConfig> {
  if (cachedConfig && Date.now() < cacheExpiry) {
    return cachedConfig;
  }
  try {
    const { getSupabase, isSupabaseConfigured } = await import("@/lib/supabase/client");
    if (!isSupabaseConfigured()) {
      return DEFAULT_RATE_LIMIT_CONFIG;
    }
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("settings")
      .select("value")
      .eq("key", "rate_limit_config")
      .is("tenant_id", "null")
      .maybeSingle();

    if (error || !data) {
      cachedConfig = DEFAULT_RATE_LIMIT_CONFIG;
    } else {
      cachedConfig = { ...DEFAULT_RATE_LIMIT_CONFIG, ...(data.value as Partial<RateLimitConfig>) };
    }
    cacheExpiry = Date.now() + CACHE_TTL_MS;
    return cachedConfig;
  } catch {
    return DEFAULT_RATE_LIMIT_CONFIG;
  }
}

export function invalidateRateLimitCache(): void {
  cachedConfig = null;
  cacheExpiry = 0;
}

export function validateRateLimitConfig(config: Partial<RateLimitConfig>): string[] {
  const errors: string[] = [];
  const numericFields: Array<[keyof RateLimitConfig, number, number]> = [
    ["loginMaxAttempts", 1, 1000],
    ["loginWindowMs", 1000, 24 * 60 * 60 * 1000],
    ["portalLoginMaxAttempts", 1, 1000],
    ["portalLoginWindowMs", 1000, 24 * 60 * 60 * 1000],
    ["forgotPasswordMaxAttempts", 1, 100],
    ["forgotPasswordWindowMs", 1000, 24 * 60 * 60 * 1000],
    ["setupPasswordMaxAttempts", 1, 100],
    ["setupPasswordWindowMs", 1000, 24 * 60 * 60 * 1000],
    ["middlewareLoginMaxRequests", 1, 1000],
    ["middlewarePortalLoginMaxRequests", 1, 1000],
  ];

  for (const [field, min, max] of numericFields) {
    const val = config[field];
    if (val !== undefined) {
      if (typeof val !== "number" || isNaN(val)) {
        errors.push(`${field} must be a number.`);
      } else if (val < min || val > max) {
        errors.push(`${field} must be between ${min} and ${max}.`);
      }
    }
  }
  return errors;
}
