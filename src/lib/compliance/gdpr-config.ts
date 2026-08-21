// src/lib/compliance/gdpr-config.ts
// ----------------------------------------------------------------------------
// GDPR config (audit V-2 / Fix 2).
//
// Background
// ----------
// The super-admin "Data Protection" tab (`src/components/super-admin/data-protection.tsx`)
// exposes 5 GDPR toggles + inputs (`rightToErasure`, `dataExportEnabled`,
// `breachNotificationTracking`, `dpoEmail`, `dataResidency`). Before this
// module was added, those values were PERSISTED to `settings.gdpr_config`
// by PUT /api/admin/data-protection, but NEVER READ by any backend
// behaviour — making every toggle decorative (audit V-2 Part D).
//
// This module mirrors the `getRetentionConfig()` pattern in `retention.ts`:
//   • `getGdprConfig()`  — loads the config from `settings` (key =
//     "gdpr_config", tenant_id IS NULL — platform-wide). Cached for 5
//     minutes to keep the read hot.
//   • `invalidateGdprConfigCache()` — called by the PUT route after a
//     write so the next read picks up the new values.
//
// The toggles gate the following behaviours:
//   • `rightToErasure` — when `false`, DELETE /api/users/[id] returns
//     403 "Right to erasure disabled" and DOES NOT call
//     `anonymizeUserAuditLogs()` or `deleteUserCascade()`. When `true`
//     (the platform default), the existing Art. 17 cascade runs.
//   • `dataExportEnabled` — when `false`, GET /api/export returns
//     403 "Data export disabled" without serving the CSV. When `true`,
//     the existing export flow runs.
//   • `breachNotificationTracking` — when `false`, the breach-notify
//     endpoint (`POST /api/admin/incidents/[id]/notify`) returns 403
//     "Breach notification tracking disabled" without sending the
//     email. When `true`, the existing notify flow runs.
//   • `dpoEmail` — used by `breach-notification.ts.getDpoContactEmail()`
//     as the Reply-To on outbound Art. 33 notifications, falling back
//     to `BREACH_NOTIFICATION_DPO_EMAIL` then `NOREPLY_EMAIL`.
//   • `dataResidency` — informational; surfaced in the UI / privacy
//     policy. Not used as a runtime gate.
//
// The platform-wide defaults (true / true / true / dpo@example.com / "EU")
// preserve the existing behaviour: erasure + export + breach-notify all
// work by default, so the toggles only become restrictive when an
// admin explicitly disables one.
// ----------------------------------------------------------------------------

/**
 * The persisted GDPR configuration shape. Mirrors the `GdprConfig` interface
 * exported from `/api/admin/data-protection/route.ts` so the GET / PUT
 * round-trip is consistent.
 */
export interface GdprConfig {
  /** Right to erasure (GDPR Art. 17) on user delete. Default true. */
  rightToErasure: boolean;
  /** Tenant-data CSV export endpoint enable. Default true. */
  dataExportEnabled: boolean;
  /** Breach notification email dispatch enable. Default true. */
  breachNotificationTracking: boolean;
  /** DPO contact email — Reply-To on outbound breach notifications. */
  dpoEmail: string;
  /** Data residency label (informational — surfaced in UI / privacy policy). */
  dataResidency: string;
}

export const DEFAULT_GDPR_CONFIG: GdprConfig = {
  rightToErasure: true,
  dataExportEnabled: true,
  breachNotificationTracking: true,
  dpoEmail: "dpo@example.com",
  dataResidency: "EU",
};

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true";
  return fallback;
}

function mergeGdpr(stored: Record<string, unknown> | null | undefined): GdprConfig {
  if (!stored) return { ...DEFAULT_GDPR_CONFIG };
  return {
    rightToErasure: asBool(stored.rightToErasure, DEFAULT_GDPR_CONFIG.rightToErasure),
    dataExportEnabled: asBool(stored.dataExportEnabled, DEFAULT_GDPR_CONFIG.dataExportEnabled),
    breachNotificationTracking: asBool(
      stored.breachNotificationTracking,
      DEFAULT_GDPR_CONFIG.breachNotificationTracking,
    ),
    dpoEmail:
      typeof stored.dpoEmail === "string" && stored.dpoEmail.trim() !== ""
        ? stored.dpoEmail
        : DEFAULT_GDPR_CONFIG.dpoEmail,
    dataResidency:
      typeof stored.dataResidency === "string" && stored.dataResidency.trim() !== ""
        ? stored.dataResidency
        : DEFAULT_GDPR_CONFIG.dataResidency,
  };
}

// ── In-memory cache ─────────────────────────────────────────────────────────
// Same pattern as `retention.ts`: cache the loaded config for 5 minutes so
// the cron, route handlers, and any in-process admin reads don't hit the
// DB on every call. The cache is invalidated by the data-protection PUT
// route after a write.
let cachedConfig: GdprConfig | null = null;
let cacheExpires = 0;
const GDPR_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Invalidate the cached GDPR config. Called by PUT /api/admin/data-protection
 * after a successful write so the next read picks up the new values.
 */
export function invalidateGdprConfigCache(): void {
  cachedConfig = null;
  cacheExpires = 0;
}

/**
 * Load the GDPR config from the `settings` table.
 * Falls back to `DEFAULT_GDPR_CONFIG` when:
 *   • Supabase is not configured (dev / test env).
 *   • No row exists yet (first run — no migration seeds this row, so the
 *     defaults apply until an admin saves).
 *   • The stored row is missing fields (older deployments).
 *   • The DB query throws (network / auth error).
 *
 * This function is read-only and does NOT gate on role — the caller is
 * responsible for permission checks. The DELETE /api/users/[id] route,
 * GET /api/export route, and POST /api/admin/incidents/[id]/notify route
 * all call this synchronously to decide whether to allow the action.
 */
export async function getGdprConfig(): Promise<GdprConfig> {
  if (cachedConfig && Date.now() < cacheExpires) {
    return cachedConfig;
  }
  try {
    const { getSupabase, isSupabaseConfigured } = await import("@/lib/supabase/client");
    if (!isSupabaseConfigured()) {
      cachedConfig = DEFAULT_GDPR_CONFIG;
      cacheExpires = Date.now() + GDPR_CACHE_TTL_MS;
      return cachedConfig;
    }
    const sb = getSupabase();
    const { data, error } = await sb
      .from("settings")
      .select("value")
      .eq("key", "gdpr_config")
      .is("tenant_id", "null")
      .maybeSingle();
    if (error || !data) {
      cachedConfig = DEFAULT_GDPR_CONFIG;
      cacheExpires = Date.now() + GDPR_CACHE_TTL_MS;
      return cachedConfig;
    }
    const stored = (data.value ?? {}) as Record<string, unknown>;
    cachedConfig = mergeGdpr(stored);
    cacheExpires = Date.now() + GDPR_CACHE_TTL_MS;
    return cachedConfig;
  } catch (e) {
    console.error("[gdpr] getGdprConfig failed:", e);
    cachedConfig = DEFAULT_GDPR_CONFIG;
    cacheExpires = Date.now() + GDPR_CACHE_TTL_MS;
    return cachedConfig;
  }
}
