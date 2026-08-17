import { NextRequest } from "next/server";

/**
 * Password policy validation.
 * Used at user creation + password change to enforce tenant security settings.
 */

export interface PasswordPolicy {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumbers: boolean;
  requireSymbols: boolean;
}

export const DEFAULT_POLICY: PasswordPolicy = {
  minLength: 8,
  requireUppercase: true,
  requireLowercase: true,
  requireNumbers: true,
  requireSymbols: false,
};

/**
 * Portal client password policy.
 *
 * Audit finding P1-7: `setup-password` previously used a permissive policy
 * (minLength: 8, no character-class requirements) that accepted passwords
 * like "abcdefgh", while `reset-password` and `change-password` enforced the
 * strong DEFAULT_POLICY (uppercase + lowercase + number). That inconsistency
 * meant a client could set a weak password at first login that they could
 * then never re-use via the change-password flow.
 *
 * Portal clients now use the same strong policy as staff users: 8+ chars
 * with at least one uppercase, one lowercase, and one number. Symbols are
 * intentionally NOT required (mobile-keyboard UX).
 *
 * This is exported as a named constant (rather than re-using DEFAULT_POLICY
 * inline) so there's a single source of truth if the product team later
 * wants to diverge portal and staff policies again.
 */
export const PORTAL_POLICY: PasswordPolicy = {
  minLength: 8,
  requireUppercase: true,
  requireLowercase: true,
  requireNumbers: true,
  requireSymbols: false,
};

export interface PasswordValidationResult {
  ok: boolean;
  errors: string[];
}

export function validatePassword(
  password: string,
  policy: PasswordPolicy = DEFAULT_POLICY
): PasswordValidationResult {
  const errors: string[] = [];

  if (password.length < policy.minLength) {
    errors.push(`Password must be at least ${policy.minLength} characters long.`);
  }
  if (policy.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push("Password must contain at least one uppercase letter.");
  }
  if (policy.requireLowercase && !/[a-z]/.test(password)) {
    errors.push("Password must contain at least one lowercase letter.");
  }
  if (policy.requireNumbers && !/[0-9]/.test(password)) {
    errors.push("Password must contain at least one number.");
  }
  if (policy.requireSymbols && !/[^A-Za-z0-9]/.test(password)) {
    errors.push("Password must contain at least one symbol.");
  }

  // Common weak passwords check
  const weak = [
    "password", "password123", "12345678", "qwerty", "abc123",
    "letmein", "admin", "welcome", "monkey", "dragon",
  ];
  if (weak.includes(password.toLowerCase())) {
    errors.push("This password is too common. Choose a more unique one.");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Generate a secure random password that meets the default policy.
 * Used when admin clicks "Generate" in the user creation form.
 */
export async function generateSecurePassword(length: number = 12): Promise<string> {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const numbers = "23456789";
  const symbols = "!@#$%^&*-_=+?";
  const all = upper + lower + numbers + symbols;

  // Use crypto for secure randomness
  const { randomBytes } = await import("crypto");
  const bytes = randomBytes(length);

  // Ensure at least one of each required type
  let pwd = "";
  pwd += upper[bytes[0] % upper.length];
  pwd += lower[bytes[1] % lower.length];
  pwd += numbers[bytes[2] % numbers.length];
  pwd += symbols[bytes[3] % symbols.length];

  for (let i = 4; i < length; i++) {
    pwd += all[bytes[i] % all.length];
  }

  // Shuffle
  return pwd
    .split("")
    .sort(() => randomBytes(1)[0] - 128)
    .join("");
}

/* ───────────────────────────────────────────────────────────────────────
   D-AUDIT-3: platform-wide password policy loader.

   The super-admin Security tab saves its passwordPolicy block under
   `settings.key = "security_config"` (tenant_id = NULL). Previously
   nothing read it back — `validatePassword()` was called with the
   `DEFAULT_POLICY` constant or the `PORTAL_POLICY` constant, so the
   super-admin's configured minimum length / char-class toggles had
   no effect at runtime.

   `getPlatformPasswordPolicy()` loads the platform row (with a 5-min
   in-process cache, same pattern as rate-limit-config.ts and
   session-config.ts). It always falls back to DEFAULT_POLICY when
   the DB is unreachable, the row is missing, or any field is invalid.
   ─────────────────────────────────────────────────────────────────────── */

let cachedPolicy: PasswordPolicy | null = null;
let policyCacheExpiry = 0;
const POLICY_CACHE_TTL_MS = 5 * 60 * 1000;

function coercePolicy(raw: unknown): PasswordPolicy {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_POLICY };
  const r = raw as Record<string, unknown>;
  const n = typeof r.minLength === "number"
    ? r.minLength
    : typeof r.minLength === "string"
    ? Number(r.minLength)
    : DEFAULT_POLICY.minLength;
  return {
    minLength: Number.isFinite(n) && n >= 4 && n <= 256 ? n : DEFAULT_POLICY.minLength,
    requireUppercase: typeof r.requireUppercase === "boolean"
      ? r.requireUppercase
      : r.requireUppercase === "true"
      ? true
      : DEFAULT_POLICY.requireUppercase,
    requireLowercase: typeof r.requireLowercase === "boolean"
      ? r.requireLowercase
      : r.requireLowercase === "true"
      ? true
      : DEFAULT_POLICY.requireLowercase,
    requireNumbers: typeof r.requireNumbers === "boolean"
      ? r.requireNumbers
      : r.requireNumbers === "true"
      ? true
      : DEFAULT_POLICY.requireNumbers,
    requireSymbols: typeof r.requireSymbols === "boolean"
      ? r.requireSymbols
      : r.requireSymbols === "true"
      ? true
      : DEFAULT_POLICY.requireSymbols,
  };
}

/**
 * Load the platform-wide password policy from DB. Caches for 5min.
 * Falls back to DEFAULT_POLICY on any error so a DB outage never
 * breaks login.
 */
export async function getPlatformPasswordPolicy(): Promise<PasswordPolicy> {
  if (cachedPolicy && Date.now() < policyCacheExpiry) {
    return cachedPolicy;
  }
  try {
    const { getSupabase, isSupabaseConfigured } = await import("@/lib/supabase/client");
    if (!isSupabaseConfigured()) {
      return DEFAULT_POLICY;
    }
    const supabase = getSupabase();
    const { data } = await supabase
      .from("settings")
      .select("value")
      .eq("key", "security_config")
      .is("tenant_id", "null")
      .maybeSingle();
    const stored = (data?.value as Record<string, unknown> | null) ?? null;
    const pp = stored && typeof stored === "object"
      ? (stored as { passwordPolicy?: unknown }).passwordPolicy
      : undefined;
    cachedPolicy = pp ? coercePolicy(pp) : { ...DEFAULT_POLICY };
    policyCacheExpiry = Date.now() + POLICY_CACHE_TTL_MS;
    return cachedPolicy;
  } catch {
    return DEFAULT_POLICY;
  }
}

export function invalidatePlatformPasswordPolicyCache(): void {
  cachedPolicy = null;
  policyCacheExpiry = 0;
}

/**
 * Validate a password against the platform-wide policy (loaded from DB
 * via getPlatformPasswordPolicy). Falls back to DEFAULT_POLICY on error.
 */
export async function validatePasswordWithPlatformPolicy(
  password: string,
): Promise<PasswordValidationResult> {
  const policy = await getPlatformPasswordPolicy().catch(() => DEFAULT_POLICY);
  return validatePassword(password, policy);
}
