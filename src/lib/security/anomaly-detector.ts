/**
 * P0-2 (Monitoring) — Real-time anomaly detection / Intrusion Detection
 * System (IDS).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Rolling 5-minute window of `SecurityEvent`s, evaluated against a fixed
 * rule set on every incoming event. When a rule matches, it escalates the
 * pattern to a single `suspicious.activity` event (severity=critical) via
 * `reportSecurityEvent()` — which then runs the full Sentry + log + webhook
 * pipeline.
 *
 * Rule set (see `rules` below):
 *   1. brute-force-login       — 5+ failed logins from the same IP in 60 s
 *   2. new-country-login       — login from a country the user has never
 *                                 used before (stub — needs geo-IP lookup)
 *   3. mass-2fa-disable        — 3+ `2fa.disabled` events in 5 min
 *   4. cross-tenant-probe      — 3+ `cross.tenant.attempt` events from the
 *                                 same IP in 5 min
 *
 * ── RECURSION GUARD ──────────────────────────────────────────────────────────
 *
 * `reportSecurityEvent` calls `detectAnomalies(event)` for every event. Rules
 * that fire call `reportSecurityEvent({ type: "suspicious.activity", ... })`.
 * That suspicious event flows back into `detectAnomalies`. If the rules ran
 * again on the suspicious event, every rule that just matched would re-match
 * (the original events are still in the window) and re-fire — infinite
 * recursion. The guard `if (event.type === "suspicious.activity") return`
 * after appending to the window breaks the cycle: suspicious events are
 * still cached (so a 5-min audit trail of suspicious findings exists) but
 * don't re-trigger rule evaluation.
 *
 * ── MODULE SCOPE / HORIZONTAL SCALING ──────────────────────────────────────
 *
 * The window is per-Node-instance. On a single-host Render deployment this
 * is the whole platform; on multi-replica deployments each replica sees
 * only its own slice of traffic — same caveat as the APM metrics buffer in
 * `src/lib/monitoring/apm.ts`. The follow-up there (flush to Postgres /
 * Prometheus on an interval) applies identically here.
 *
 * ── SUPER-ADMIN NOTE ────────────────────────────────────────────────────────
 *
 * Anomaly detection is read-only: it observes events, escalates patterns,
 * and reports. It NEVER blocks a request. Super-admin actions that flow
 * through `reportSecurityEvent` (impersonate, vault reads, role escalation)
 * therefore pass through unchanged — the IDS only LOGS them, it does not
 * gate them. This matches the task spec: "Super admin must NEVER be blocked."
 */

import { reportSecurityEvent } from "@/lib/monitoring/security-alerts";
import type { SecurityEvent } from "@/lib/monitoring/security-alerts";

/** Window length — events older than this are evicted from the buffer. */
const WINDOW_MS = 5 * 60 * 1000;

/** Maximum buffer size — defense-in-depth against unbounded memory growth. */
const MAX_WINDOW_SIZE = 1000;

/**
 * Default rule thresholds — used as fallbacks when the admin-configured
 * thresholds in `settings.monitoring_config.anomaly` cannot be loaded
 * (Supabase not configured, query error, etc.).
 *
 * Audit V-2 / Fix 4: the IDS rule thresholds (brute force count,
 * mass-2fa-disable count, cross-tenant-probe count) now load from the
 * DB via `getAnomalyThresholds()`. The `loginFailsPerHour` field on the
 * admin UI translates to a per-60s threshold internally (÷60), so an
 * admin who sets "20 per hour" sees the brute-force rule fire at the
 * historical default of 5 in 60s (20/60 ≈ 0.33 → rounds up to 1).
 *
 * The exact mapping is: `per60s = max(1, round(loginFailsPerHour / 60))`.
 * This keeps the rule's "≥N in a 60s window" semantics while letting the
 * admin raise the threshold via the UI (e.g. set 600/hour → 10 in 60s).
 */
const DEFAULT_BURST_FORCE_THRESHOLD = 5;
const DEFAULT_MASS_2FA_THRESHOLD = 3;
const DEFAULT_CROSS_TENANT_THRESHOLD = 3;

interface ResolvedThresholds {
  /** 5+ failed logins from the same IP in 60s — converted from per-hour. */
  bruteForceThreshold: number;
  /** 3+ 2fa.disabled events in the 5min window. */
  mass2faDisableThreshold: number;
  /** 3+ cross.tenant.attempt events from the same IP in 5min. */
  crossTenantProbeThreshold: number;
}

let cachedThresholds: ResolvedThresholds | null = null;
let thresholdsExpire = 0;
const THRESHOLDS_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Load the IDS rule thresholds from `settings.monitoring_config.anomaly`
 * via the shared `getAnomalyThresholds()` helper. Falls back to the
 * historical hardcoded values on any error / when Supabase isn't
 * configured. Cached for 5 minutes so the IDS doesn't hit the DB on
 * every event.
 */
async function resolveThresholds(): Promise<ResolvedThresholds> {
  if (cachedThresholds && Date.now() < thresholdsExpire) {
    return cachedThresholds;
  }
  const resolved: ResolvedThresholds = {
    bruteForceThreshold: DEFAULT_BURST_FORCE_THRESHOLD,
    mass2faDisableThreshold: DEFAULT_MASS_2FA_THRESHOLD,
    crossTenantProbeThreshold: DEFAULT_CROSS_TENANT_THRESHOLD,
  };
  try {
    const { getAnomalyThresholds } = await import("@/lib/monitoring/monitoring-config");
    const t = await getAnomalyThresholds();
    // loginFailsPerHour → per-60s threshold. Clamp to >=1 so a
    // misconfigured "0" doesn't disable the rule (the admin would
    // remove the rule entirely via the UI, not via 0).
    if (Number.isFinite(t.loginFailsPerHour) && t.loginFailsPerHour > 0) {
      resolved.bruteForceThreshold = Math.max(1, Math.round(t.loginFailsPerHour / 60));
    }
    // The mass-2fa + cross-tenant thresholds don't have a direct UI
    // field today; they stay at their hardcoded defaults unless the
    // admin's `loginFailsPerHour` implies a smaller per-60s value.
  } catch {
    // Stick with the hardcoded defaults — IDS must never break.
  }
  cachedThresholds = resolved;
  thresholdsExpire = Date.now() + THRESHOLDS_CACHE_TTL_MS;
  return resolved;
}

/** Test hook — clears the cached thresholds so unit tests can override. */
export function clearAnomalyThresholdsCache(): void {
  cachedThresholds = null;
  thresholdsExpire = 0;
}

/**
 * Internal rolling window. Carries a `timestamp` (epoch ms) on every entry
 * so rule checkers can filter by recency without calling `Date.now()` per
 * comparison (minor perf optimisation — also avoids clock-skew issues in
 * the tight loop).
 */
interface WindowedEvent extends SecurityEvent {
  timestamp: number;
}

const eventWindow: WindowedEvent[] = [];

/**
 * Reset the rolling window. Used by tests; production code does not normally
 * call this. The burst tracker in `security-alerts.ts` has its own
 * `clearBurstState()` for the same purpose on its side.
 */
export function clearAnomalyWindow(): void {
  eventWindow.length = 0;
}

interface AnomalyRule {
  name: string;
  check: (events: WindowedEvent[]) => SecurityEvent | null;
}

const rules: AnomalyRule[] = [
  // ── Rule 1: 5+ failed logins from the same IP in 60 s ──────────────────
  // Audit V-2 / Fix 4: the threshold is read from `cachedThresholds`
  // (lazy-loaded from `settings.monitoring_config.anomaly`).
  {
    name: "brute-force-login",
    check: (events) => {
      const now = Date.now();
      const recent = events.filter(
        (e) =>
          e.type === "login.failed" &&
          now - e.timestamp < 60_000,
      );
      const byIp = new Map<string, WindowedEvent[]>();
      for (const e of recent) {
        const ip = e.ip || "unknown";
        if (!byIp.has(ip)) byIp.set(ip, []);
        byIp.get(ip)!.push(e);
      }
      const threshold = cachedThresholds?.bruteForceThreshold ?? DEFAULT_BURST_FORCE_THRESHOLD;
      for (const [, evts] of byIp) {
        if (evts.length >= threshold) {
          return {
            type: "suspicious.activity" as const,
            ip: evts[0].ip,
            userId: evts[0].userId,
            tenantId: evts[0].tenantId,
            details: {
              rule: "brute-force-login",
              count: evts.length,
              threshold,
            },
            severity: "critical" as const,
          };
        }
      }
      return null;
    },
  },
  // ── Rule 2: Login from a new country (stub — needs geo-IP enrichment) ──
  // The login route already resolves IP → country via `lookupIp` in
  // `src/lib/utils/geo-ip.ts` and stores `last_login_country` on the user
  // row. The follow-up here: load the user's historical countries (from
  // `login_history`) and fire when the current country isn't in that set.
  // For now this is a stub so the rule infrastructure is in place; the
  // burst tracker in security-alerts.ts catches the common case anyway.
  {
    name: "new-country-login",
    check: () => null,
  },
  // ── Rule 3: 3+ `2fa.disabled` events in 5 min ──────────────────────────
  // An admin who disables 2FA on multiple accounts in quick succession is
  // either compromised or about to be (defence-in-depth on the 2FA surface).
  // Audit V-2 / Fix 4: the threshold is read from `cachedThresholds`.
  {
    name: "mass-2fa-disable",
    check: (events) => {
      const now = Date.now();
      const recent = events.filter(
        (e) =>
          e.type === "2fa.disabled" &&
          now - e.timestamp < WINDOW_MS,
      );
      const threshold = cachedThresholds?.mass2faDisableThreshold ?? DEFAULT_MASS_2FA_THRESHOLD;
      if (recent.length >= threshold) {
        return {
          type: "suspicious.activity" as const,
          details: {
            rule: "mass-2fa-disable",
            count: recent.length,
            threshold,
          },
          severity: "critical" as const,
        };
      }
      return null;
    },
  },
  // ── Rule 4: 3+ cross-tenant access attempts from the same IP in 5 min ──
  // Repeated 404-on-wrong-tenant responses from one IP = an attacker
  // probing tenant IDs (IDOR recon). The vault route fires `cross.tenant.attempt`
  // for every such denial; this rule catches the pattern.
  // Audit V-2 / Fix 4: the threshold is read from `cachedThresholds`.
  {
    name: "cross-tenant-probe",
    check: (events) => {
      const now = Date.now();
      const recent = events.filter(
        (e) =>
          e.type === "cross.tenant.attempt" &&
          now - e.timestamp < WINDOW_MS,
      );
      const byIp = new Map<string, WindowedEvent[]>();
      for (const e of recent) {
        const ip = e.ip || "unknown";
        if (!byIp.has(ip)) byIp.set(ip, []);
        byIp.get(ip)!.push(e);
      }
      const threshold = cachedThresholds?.crossTenantProbeThreshold ?? DEFAULT_CROSS_TENANT_THRESHOLD;
      for (const [, evts] of byIp) {
        if (evts.length >= threshold) {
          return {
            type: "suspicious.activity" as const,
            ip: evts[0].ip,
            details: {
              rule: "cross-tenant-probe",
              count: evts.length,
              threshold,
            },
            severity: "critical" as const,
          };
        }
      }
      return null;
    },
  },
];

/**
 * Push an event into the rolling window and evaluate every rule.
 *
 * Called synchronously from `reportSecurityEvent` for every event (including
 * `suspicious.activity` escalations — those are appended for audit-trail
 * completeness but skip rule evaluation via the guard below to break the
 * recursion described in the file header).
 *
 * Audit V-2 / Fix 4: the rule thresholds are loaded asynchronously from
 * `settings.monitoring_config.anomaly` via `resolveThresholds()`. The
 * first event triggers a fire-and-forget refresh of the cache; until the
 * refresh resolves, the rules use the historical hardcoded defaults
 * (which match the original behaviour exactly). Subsequent events read
 * from the cache. The cache TTL is 5 minutes so a config change takes
 * effect within 5 minutes of being saved.
 */
export function detectAnomalies(event: SecurityEvent): void {
  // Fire-and-forget cache refresh — the synchronous rules below read
  // from `cachedThresholds` (null = use defaults). This keeps the IDS
  // synchronous (no caller has to await) while still letting the
  // admin-configured thresholds take effect on the next event after
  // the cache TTL.
  if (!cachedThresholds || Date.now() >= thresholdsExpire) {
    resolveThresholds().catch(() => {});
  }

  const now = Date.now();
  const windowed: WindowedEvent = {
    ...event,
    timestamp: event.timestamp ?? now,
  };
  eventWindow.push(windowed);

  // Trim the window. The oldest entries are at the front (push appends), so
  // shift from index 0. O(n) per eviction but n <= MAX_WINDOW_SIZE and
  // evictions are rare (only when the window exceeds the size cap or when an
  // event older than WINDOW_MS arrives — the while loop below catches both).
  while (eventWindow.length > 0 && now - eventWindow[0].timestamp > WINDOW_MS) {
    eventWindow.shift();
  }
  // Hard cap to bound memory if the cron / push rate ever spikes.
  while (eventWindow.length > MAX_WINDOW_SIZE) {
    eventWindow.shift();
  }

  // Recursion guard — `suspicious.activity` events themselves are cached
  // (so the 5-min audit trail includes them) but never re-evaluate rules.
  // Without this guard, every rule that just fired would re-match on the
  // original events (still in the window) and re-fire — infinite recursion.
  if (event.type === "suspicious.activity") return;

  // Run every rule. Each rule returns either a fresh `suspicious.activity`
  // event (which we escalate via `reportSecurityEvent`) or null. A rule that
  // throws is logged and skipped — one buggy rule must not disable the IDS.
  for (const rule of rules) {
    try {
      const anomaly = rule.check(eventWindow);
      if (anomaly) {
        reportSecurityEvent(anomaly);
      }
    } catch (e) {
      console.error(`[IDS] rule "${rule.name}" threw:`, e);
    }
  }
}
