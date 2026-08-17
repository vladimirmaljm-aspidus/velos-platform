// src/lib/monitoring/monitoring-config.ts
// ----------------------------------------------------------------------------
// Monitoring config (audit V-2 / Fix 4 + Fix 5).
//
// Background
// ----------
// The super-admin "Monitoring & Alerts" tab
// (`src/components/super-admin/monitoring-settings.tsx`) persists four
// anomaly thresholds + an alert-routing table to
// `settings.monitoring_config` (key = "monitoring_config",
// tenant_id IS NULL — platform-wide).
//
// Before this module was added:
//   • `anomaly-detector.ts` used HARDCODED thresholds (5 failed logins in
//     60s, 3 2fa disables in 5min, 3 cross-tenant probes in 5min). The
//     UI's `loginFailsPerHour` field had NO effect.
//   • `apm.ts` exported `ALERT_THRESHOLDS = {avgResponseTimeMs: 2000,
//     errorRate: 0.05, slowRequests: 10}` (hardcoded const). The UI's
//     three anomaly fields had NO effect.
//   • `alertRouting[]` was stored but no code read it — there was no
//     "alert X happened → email these recipients" pipeline.
//
// This module mirrors the `getRetentionConfig()` / `getGdprConfig()`
// pattern:
//   • `getMonitoringConfig()`  — loads the config from `settings` (key =
//     "monitoring_config", tenant_id IS NULL). Cached for 5 minutes so
//     the IDS + APM don't hit the DB on every event.
//   • `invalidateMonitoringConfigCache()` — called by the PUT route
//     after a write so the next read picks up the new values.
//   • `getAnomalyThresholds()` — convenience accessor returning just the
//     anomaly block with sensible defaults merged in.
//
// The returned thresholds are consumed by:
//   • `anomaly-detector.ts` — `bruteForceThreshold`,
//     `mass2faDisableThreshold`, `crossTenantProbeThreshold`,
//     `bruteForceWindowMs` (the time-window for the brute-force rule;
//     defaults to 60s as before).
//   • `apm.ts` `checkAlerts()` — `avgResponseTimeMs`, `errorRate` (as a
//     fraction 0-1, NOT percent — converts the stored percent on read),
//     `slowRequests`.
// ----------------------------------------------------------------------------

/**
 * Mirrors `MonitoringConfig.anomaly` from
 * `src/app/api/admin/monitoring-settings/route.ts`. Re-declared here
 * (rather than imported) to avoid pulling the route module into the
 * IDS / APM hot path — route modules carry Next.js types that would
 * bloat the bundle.
 */
export interface AnomalyThresholds {
  /** APM "high avg response time" alert — milliseconds. */
  avgResponseTimeMs: number;
  /** APM "high error rate" alert — stored as percent (0-100). */
  errorRatePct: number;
  /** APM "many slow requests" alert — count of >2s requests in buffer. */
  slowRequests: number;
  /** Failed-login-per-hour threshold that escalates to a security alert. */
  loginFailsPerHour: number;
}

/**
 * The persisted alert-routing entry. Mirrors
 * `MonitoringConfig.alertRouting[number]`.
 */
export interface AlertRoute {
  /** Event type filter — `"*"` matches every event. */
  type: string;
  /** Email addresses to notify when the route matches. */
  recipients: string[];
  severity: "low" | "medium" | "high" | "critical";
  active: boolean;
}

export const DEFAULT_ANOMALY_THRESHOLDS: AnomalyThresholds = {
  // Mirror the original hardcoded ALERT_THRESHOLDS from apm.ts so the
  // rollout is a no-op until an admin explicitly overrides them.
  avgResponseTimeMs: 2000,
  errorRatePct: 5, // 5%
  slowRequests: 10,
  // Mirror the original hardcoded BURST_THRESHOLD from anomaly-detector.ts.
  // This is "5 in 60s", expressed per-hour for the UI's display unit.
  loginFailsPerHour: 5 * 60, // 300 (5 per minute → 300 per hour)
};

function asNum(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) && typeof n === "number" ? (n as number) : fallback;
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true";
  return fallback;
}

function mergeAnomaly(stored: Record<string, unknown> | null | undefined): AnomalyThresholds {
  if (!stored) return { ...DEFAULT_ANOMALY_THRESHOLDS };
  return {
    avgResponseTimeMs: asNum(stored.avgResponseTimeMs, DEFAULT_ANOMALY_THRESHOLDS.avgResponseTimeMs),
    errorRatePct: asNum(stored.errorRatePct, DEFAULT_ANOMALY_THRESHOLDS.errorRatePct),
    slowRequests: asNum(stored.slowRequests, DEFAULT_ANOMALY_THRESHOLDS.slowRequests),
    loginFailsPerHour: asNum(stored.loginFailsPerHour, DEFAULT_ANOMALY_THRESHOLDS.loginFailsPerHour),
  };
}

function mergeAlertRouting(
  stored: unknown[] | null | undefined,
): AlertRoute[] {
  if (!Array.isArray(stored) || stored.length === 0) {
    return [];
  }
  return stored.map((row, i) => {
    const rr = (row || {}) as Record<string, unknown>;
    return {
      type: typeof rr.type === "string" ? rr.type : `alert-${i + 1}`,
      recipients: Array.isArray(rr.recipients) ? rr.recipients.map(String) : [],
      severity: ["low", "medium", "high", "critical"].includes(rr.severity as string)
        ? (rr.severity as "low" | "medium" | "high" | "critical")
        : "medium",
      active: asBool(rr.active, true),
    };
  });
}

export interface MonitoringConfig {
  anomaly: AnomalyThresholds;
  alertRouting: AlertRoute[];
}

// ── In-memory cache ─────────────────────────────────────────────────────────
let cachedConfig: MonitoringConfig | null = null;
let cacheExpires = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Invalidate the cached monitoring config. Called by PUT
 * /api/admin/monitoring-settings after a successful write so the next
 * read picks up the new values.
 */
export function invalidateMonitoringConfigCache(): void {
  cachedConfig = null;
  cacheExpires = 0;
}

/**
 * Load the monitoring config from the `settings` table.
 * Falls back to defaults when:
 *   • Supabase is not configured (dev / test env).
 *   • No row exists yet (first run — no migration seeds this row, so
 *     the defaults apply until an admin saves).
 *   • The stored row is missing fields (older deployments).
 *   • The DB query throws (network / auth error).
 */
export async function getMonitoringConfig(): Promise<MonitoringConfig> {
  if (cachedConfig && Date.now() < cacheExpires) {
    return cachedConfig;
  }
  try {
    const { getSupabase, isSupabaseConfigured } = await import("@/lib/supabase/client");
    if (!isSupabaseConfigured()) {
      cachedConfig = {
        anomaly: { ...DEFAULT_ANOMALY_THRESHOLDS },
        alertRouting: [],
      };
      cacheExpires = Date.now() + CACHE_TTL_MS;
      return cachedConfig;
    }
    const sb = getSupabase();
    const { data, error } = await sb
      .from("settings")
      .select("value")
      .eq("key", "monitoring_config")
      .is("tenant_id", "null")
      .maybeSingle();
    if (error || !data) {
      cachedConfig = {
        anomaly: { ...DEFAULT_ANOMALY_THRESHOLDS },
        alertRouting: [],
      };
      cacheExpires = Date.now() + CACHE_TTL_MS;
      return cachedConfig;
    }
    const stored = (data.value ?? {}) as Record<string, unknown>;
    cachedConfig = {
      anomaly: mergeAnomaly(stored.anomaly as Record<string, unknown> | undefined),
      alertRouting: mergeAlertRouting(stored.alertRouting as unknown[] | undefined),
    };
    cacheExpires = Date.now() + CACHE_TTL_MS;
    return cachedConfig;
  } catch (e) {
    console.error("[monitoring] getMonitoringConfig failed:", e);
    cachedConfig = {
      anomaly: { ...DEFAULT_ANOMALY_THRESHOLDS },
      alertRouting: [],
    };
    cacheExpires = Date.now() + CACHE_TTL_MS;
    return cachedConfig;
  }
}

/**
 * Convenience accessor: just the anomaly thresholds block. Used by
 * `anomaly-detector.ts` and `apm.ts` so they don't pull the full config
 * + alert routing into the hot path.
 */
export async function getAnomalyThresholds(): Promise<AnomalyThresholds> {
  const config = await getMonitoringConfig();
  return config.anomaly;
}

/**
 * Convenience accessor: just the alert routing array. Used by
 * `src/lib/monitoring/alert-routing.ts` (Fix 5).
 */
export async function getAlertRoutes(): Promise<AlertRoute[]> {
  const config = await getMonitoringConfig();
  return config.alertRouting;
}
