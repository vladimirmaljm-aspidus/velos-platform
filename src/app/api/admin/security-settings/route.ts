import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { DEFAULT_POLICY, invalidatePlatformPasswordPolicyCache } from "@/lib/auth/password-policy";
import { invalidateSessionConfigCache } from "@/lib/auth/session-config";

export const runtime = "nodejs";

/**
 * GET /api/admin/security-settings  (super-admin only)
 *
 * Returns the platform-level security configuration stored under
 * `settings.key = "security_config"` (tenant_id = NULL).
 *
 * The payload covers the four security knobs a super-admin tunes:
 *   • 2FA / TOTP enforcement policy (force for super_admin, allow per role)
 *   • Session TTLs (per role + idle timeout)
 *   • CSRF enforcement toggle (P2-18)
 *   • Password policy (min length + char-class requirements)
 *
 * All values fall back to platform-wide defaults if the settings row
 * has never been written. Defaults are exported so the client UI can
 * offer a "Reset to defaults" action.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const sb = getSupabase();
    const { data } = await sb
      .from("settings")
      .select("value")
      .eq("key", "security_config")
      .is("tenant_id", "null")
      .maybeSingle();

    const stored = (data?.value as Record<string, unknown> | null) ?? null;

    const config = mergeDefaults(stored);
    return NextResponse.json({ config, defaults: DEFAULT_SECURITY_CONFIG });
  } catch (e: any) {
    return NextResponse.json(
      { error: sanitizeError(e) },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/admin/security-settings  (super-admin only)
 *
 * Persists the full security-config payload. The client is expected to
 * send the complete document (the GET shape); the route replaces the
 * stored row wholesale rather than merging, so omitted fields reset to
 * their defaults via `mergeDefaults` on the next read.
 *
 * Validation is intentionally lenient (type coercion only) — the
 * super-admin is trusted, and the UI validates before submit. If a
 * future tightening is needed, add per-field guards here.
 */
export async function PUT(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be an object." }, { status: 400 });
  }

  const config = mergeDefaults(body as Record<string, unknown>);

  try {
    const sb = getSupabase();

    // D-AUDIT-3: persist the session block ALSO to the canonical
    // `session_config` setting key (ms units) so session-config.ts
    // picks up runtime TTL changes from this UI. Previously the UI
    // saved only to `security_config` with minute units — a key &
    // unit mismatch that made every session setting non-functional.
    const sessionConfigMs = {
      superAdminTtlMs: config.session.superAdminTtlMinutes * 60 * 1000,
      adminTtlMs: config.session.adminTtlMinutes * 60 * 1000,
      userTtlMs: config.session.userTtlMinutes * 60 * 1000,
      idleTimeoutMs: config.session.idleTimeoutMinutes * 60 * 1000,
    };
    const { data: existingSession } = await sb
      .from("settings")
      .select("id")
      .eq("key", "session_config")
      .is("tenant_id", "null")
      .maybeSingle();
    if (existingSession) {
      await sb
        .from("settings")
        .update({ value: sessionConfigMs, updated_at: new Date().toISOString() })
        .eq("id", (existingSession as any).id);
    } else {
      await sb
        .from("settings")
        .insert({
          key: "session_config",
          value: sessionConfigMs,
          tenant_id: null,
          updated_at: new Date().toISOString(),
        });
    }
    // Bust the in-process cache so the new TTLs apply on the very next
    // login rather than up to 5 minutes later.
    invalidateSessionConfigCache();
    // Same for the password-policy cache — the next /portal/setup-password
    // /portal/reset-password /portal/change-password call must pick up the
    // new minLength / char-class toggles.
    invalidatePlatformPasswordPolicyCache();

    const { data: existing } = await sb
      .from("settings")
      .select("id")
      .eq("key", "security_config")
      .is("tenant_id", "null")
      .maybeSingle();

    if (existing) {
      const { error } = await sb
        .from("settings")
        .update({ value: config, updated_at: new Date().toISOString() })
        .eq("id", (existing as any).id);
      if (error) return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
    } else {
      const { error } = await sb
        .from("settings")
        .insert({
          key: "security_config",
          value: config,
          tenant_id: null,
          updated_at: new Date().toISOString(),
        });
      if (error) return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
    }

    await audit(auth.store, auth.user, req, "settings.security.update", "settings", "security_config", {
      totp_force_super_admin: config.totp.forceSuperAdmin,
      session_super_admin_ttl: config.session.superAdminTtlMinutes,
      password_min_length: config.passwordPolicy.minLength,
    });

    return NextResponse.json({ config });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

/* ─── Defaults & merging ──────────────────────────────────────────────── */

export interface TotpConfig {
  forceSuperAdmin: boolean;
  forceAdmin: boolean;
  forceStaff: boolean;
  // Optional grace period (hours) after login before 2FA must be set up,
  // so existing users aren't locked out on first enable.
  enrollmentGraceHours: number;
}

export interface SessionConfig {
  superAdminTtlMinutes: number;
  adminTtlMinutes: number;
  userTtlMinutes: number;
  idleTimeoutMinutes: number;
  // FIX-V1 (Fix 6): maxConcurrentSessions removed — the field was saved
  // to DB but never read (enforceConcurrentSessionLimit hardcodes
  // MAX_CONCURRENT_SESSIONS=5). Don't persist fields that aren't
  // enforced; re-add when the runtime learns to read it.
}

export interface CsrfConfig {
  // When true, the Origin-header check in requireAuth applies to
  // state-changing methods (POST/PUT/PATCH/DELETE) on every route.
  enforceOrigin: boolean;
  // When true, SameSite=Strict is used; otherwise Lax (default).
  sameSiteStrict: boolean;
}

export interface PasswordPolicyConfig {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumbers: boolean;
  requireSymbols: boolean;
  // FIX-V1 (Fix 4): expiryDays + historyCount removed — they were saved
  // to DB but never read by any code (no password_changed_at column, no
  // password_history table). Re-add when the runtime learns to enforce
  // rotation / reuse prevention.
}

export interface SecurityConfig {
  totp: TotpConfig;
  session: SessionConfig;
  csrf: CsrfConfig;
  passwordPolicy: PasswordPolicyConfig;
}

export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  totp: {
    forceSuperAdmin: true,
    forceAdmin: false,
    forceStaff: false,
    enrollmentGraceHours: 24,
  },
  session: {
    superAdminTtlMinutes: 60 * 8, // 8 hours
    adminTtlMinutes: 60 * 12, // 12 hours
    userTtlMinutes: 60 * 24 * 7, // 7 days
    idleTimeoutMinutes: 30,
  },
  csrf: {
    enforceOrigin: true,
    sameSiteStrict: false,
  },
  passwordPolicy: {
    minLength: DEFAULT_POLICY.minLength,
    requireUppercase: DEFAULT_POLICY.requireUppercase,
    requireLowercase: DEFAULT_POLICY.requireLowercase,
    requireNumbers: DEFAULT_POLICY.requireNumbers,
    requireSymbols: DEFAULT_POLICY.requireSymbols,
  },
};

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true";
  return fallback;
}
function asNum(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) && typeof n === "number" ? n : fallback;
}

export function mergeDefaults(stored: Record<string, unknown> | null): SecurityConfig {
  if (!stored) return { ...DEFAULT_SECURITY_CONFIG };

  const t = (stored.totp as Record<string, unknown> | undefined) ?? {};
  const s = (stored.session as Record<string, unknown> | undefined) ?? {};
  const c = (stored.csrf as Record<string, unknown> | undefined) ?? {};
  const p = (stored.passwordPolicy as Record<string, unknown> | undefined) ?? {};

  return {
    totp: {
      forceSuperAdmin: asBool(t.forceSuperAdmin, DEFAULT_SECURITY_CONFIG.totp.forceSuperAdmin),
      forceAdmin: asBool(t.forceAdmin, DEFAULT_SECURITY_CONFIG.totp.forceAdmin),
      forceStaff: asBool(t.forceStaff, DEFAULT_SECURITY_CONFIG.totp.forceStaff),
      enrollmentGraceHours: asNum(t.enrollmentGraceHours, DEFAULT_SECURITY_CONFIG.totp.enrollmentGraceHours),
    },
    session: {
      superAdminTtlMinutes: asNum(s.superAdminTtlMinutes, DEFAULT_SECURITY_CONFIG.session.superAdminTtlMinutes),
      adminTtlMinutes: asNum(s.adminTtlMinutes, DEFAULT_SECURITY_CONFIG.session.adminTtlMinutes),
      userTtlMinutes: asNum(s.userTtlMinutes, DEFAULT_SECURITY_CONFIG.session.userTtlMinutes),
      idleTimeoutMinutes: asNum(s.idleTimeoutMinutes, DEFAULT_SECURITY_CONFIG.session.idleTimeoutMinutes),
    },
    csrf: {
      enforceOrigin: asBool(c.enforceOrigin, DEFAULT_SECURITY_CONFIG.csrf.enforceOrigin),
      sameSiteStrict: asBool(c.sameSiteStrict, DEFAULT_SECURITY_CONFIG.csrf.sameSiteStrict),
    },
    passwordPolicy: {
      minLength: asNum(p.minLength, DEFAULT_SECURITY_CONFIG.passwordPolicy.minLength),
      requireUppercase: asBool(p.requireUppercase, DEFAULT_SECURITY_CONFIG.passwordPolicy.requireUppercase),
      requireLowercase: asBool(p.requireLowercase, DEFAULT_SECURITY_CONFIG.passwordPolicy.requireLowercase),
      requireNumbers: asBool(p.requireNumbers, DEFAULT_SECURITY_CONFIG.passwordPolicy.requireNumbers),
      requireSymbols: asBool(p.requireSymbols, DEFAULT_SECURITY_CONFIG.passwordPolicy.requireSymbols),
    },
  };
}
