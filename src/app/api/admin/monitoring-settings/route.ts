import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { ALERT_THRESHOLDS } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

/**
 * Monitoring & alerts configuration.
 *
 *   • Sentry — READ-ONLY mirror of the env-var config (the super-
 *              admin can't change env vars from the UI; this is for
 *              visibility into the current state).
 *   • Security-event webhook — a single URL + secret that receives
 *              POST notifications on significant security events
 *              (login lockouts, SoD violations, vault rotations,
 *              role changes). Distinct from per-tenant webhooks in
 *              /api/webhooks — this is a platform-level sink.
 *   • Anomaly detection thresholds — the APM thresholds (avg
 *              response time, error rate, slow request count) plus a
 *              login-anomaly threshold (failed-logins-per-hour that
 *              triggers a security alert).
 *   • Alert routing — map of alert type → recipient email(s).
 */

export interface MonitoringConfig {
  sentry: {
    dsn_configured: boolean;
    client_dsn_configured: boolean;
    environment: string;
    // Read-only — sample rate is set in sentry.client.config.ts;
    // we mirror it here so the UI can show the value.
    sampleRate: number;
  };
  securityWebhook: {
    enabled: boolean;
    url: string;
    events: string[];
    // Whether to include the raw event payload or just a digest.
    includePayload: boolean;
  };
  anomaly: {
    avgResponseTimeMs: number;
    errorRatePct: number; // stored as percent (0–100), not 0–1
    slowRequests: number;
    loginFailsPerHour: number;
  };
  alertRouting: Array<{
    type: string;
    recipients: string[];
    severity: "low" | "medium" | "high" | "critical";
    active: boolean;
  }>;
}

export const DEFAULT_MONITORING_CONFIG: MonitoringConfig = {
  sentry: {
    dsn_configured: false,
    client_dsn_configured: false,
    environment: process.env.NODE_ENV || "development",
    sampleRate: 1.0,
  },
  securityWebhook: {
    enabled: false,
    url: "",
    events: [
      "auth.login_locked",
      "auth.sod_violation",
      "vault.rotate",
      "settings.security.update",
      "settings.role_override.create",
      "settings.role_override.delete",
      "incident.create",
    ],
    includePayload: false,
  },
  anomaly: {
    avgResponseTimeMs: ALERT_THRESHOLDS.avgResponseTimeMs,
    errorRatePct: ALERT_THRESHOLDS.errorRate * 100,
    slowRequests: ALERT_THRESHOLDS.slowRequests,
    loginFailsPerHour: 20,
  },
  alertRouting: [
    {
      type: "auth.login_locked",
      recipients: ["security@example.com"],
      severity: "medium",
      active: true,
    },
    {
      type: "auth.sod_violation",
      recipients: ["security@example.com", "compliance@example.com"],
      severity: "high",
      active: true,
    },
    {
      type: "vault.rotate",
      recipients: ["ops@example.com"],
      severity: "low",
      active: true,
    },
    {
      type: "incident.create",
      recipients: ["security@example.com", "dpo@example.com"],
      severity: "critical",
      active: true,
    },
  ],
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

function mergeDefaults(stored: Record<string, unknown> | null): MonitoringConfig {
  if (!stored) {
    // Always re-read live env vars so the Sentry mirror is accurate.
    return {
      ...DEFAULT_MONITORING_CONFIG,
      sentry: {
        dsn_configured: !!process.env.SENTRY_DSN,
        client_dsn_configured: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
        environment: process.env.NODE_ENV || "development",
        sampleRate: 1.0,
      },
    };
  }

  const s = (stored.sentry as Record<string, unknown> | undefined) ?? {};
  const w = (stored.securityWebhook as Record<string, unknown> | undefined) ?? {};
  const a = (stored.anomaly as Record<string, unknown> | undefined) ?? {};
  const r = (stored.alertRouting as unknown[] | undefined) ?? [];

  return {
    sentry: {
      // Always live from env — never trust the stored value (env may
      // have changed between writes).
      dsn_configured: !!process.env.SENTRY_DSN,
      client_dsn_configured: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
      environment: process.env.NODE_ENV || "development",
      sampleRate: asNum(s.sampleRate, DEFAULT_MONITORING_CONFIG.sentry.sampleRate),
    },
    securityWebhook: {
      enabled: asBool(w.enabled, DEFAULT_MONITORING_CONFIG.securityWebhook.enabled),
      url: typeof w.url === "string" ? w.url : "",
      events: Array.isArray(w.events) ? w.events.map(String) : DEFAULT_MONITORING_CONFIG.securityWebhook.events,
      includePayload: asBool(w.includePayload, DEFAULT_MONITORING_CONFIG.securityWebhook.includePayload),
    },
    anomaly: {
      avgResponseTimeMs: asNum(a.avgResponseTimeMs, DEFAULT_MONITORING_CONFIG.anomaly.avgResponseTimeMs),
      errorRatePct: asNum(a.errorRatePct, DEFAULT_MONITORING_CONFIG.anomaly.errorRatePct),
      slowRequests: asNum(a.slowRequests, DEFAULT_MONITORING_CONFIG.anomaly.slowRequests),
      loginFailsPerHour: asNum(a.loginFailsPerHour, DEFAULT_MONITORING_CONFIG.anomaly.loginFailsPerHour),
    },
    alertRouting: r.map((row, i) => {
      const rr = (row || {}) as Record<string, unknown>;
      return {
        type: typeof rr.type === "string" ? rr.type : `alert-${i + 1}`,
        recipients: Array.isArray(rr.recipients) ? rr.recipients.map(String) : [],
        severity: ["low", "medium", "high", "critical"].includes(rr.severity as string)
          ? (rr.severity as "low" | "medium" | "high" | "critical")
          : "medium",
        active: asBool(rr.active, true),
      };
    }),
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const sb = getSupabase();
    const { data } = await sb
      .from("settings")
      .select("value")
      .eq("key", "monitoring_config")
      .is("tenant_id", "null")
      .maybeSingle();

    const stored = (data?.value as Record<string, unknown> | null) ?? null;
    const config = mergeDefaults(stored);

    return NextResponse.json({ config, defaults: DEFAULT_MONITORING_CONFIG });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

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

  // Re-derive sentry from env — caller's sentry field is ignored.
  const bodyWithoutSentry = { ...(body as Record<string, unknown>), sentry: undefined };
  const config = mergeDefaults(bodyWithoutSentry as Record<string, unknown>);

  // Preserve the live env-derived sentry section
  config.sentry = {
    dsn_configured: !!process.env.SENTRY_DSN,
    client_dsn_configured: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    sampleRate: (body as any)?.sentry?.sampleRate
      ? asNum((body as any).sentry.sampleRate, DEFAULT_MONITORING_CONFIG.sentry.sampleRate)
      : DEFAULT_MONITORING_CONFIG.sentry.sampleRate,
  };

  try {
    const sb = getSupabase();
    const { data: existing } = await sb
      .from("settings")
      .select("id")
      .eq("key", "monitoring_config")
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
          key: "monitoring_config",
          value: config,
          tenant_id: null,
          updated_at: new Date().toISOString(),
        });
      if (error) return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
    }

    await audit(auth.store, auth.user, req, "settings.monitoring.update", "settings", "monitoring_config", {
      webhook_enabled: config.securityWebhook.enabled,
      alert_routing_count: config.alertRouting.length,
    });

    // Invalidate the in-process caches so the next IDS event, APM
    // checkAlerts() call, alert-routing evaluation, and security-webhook
    // fan-out pick up the new values immediately. See
    // src/lib/monitoring/monitoring-config.ts.
    try {
      const { invalidateMonitoringConfigCache } = await import("@/lib/monitoring/monitoring-config");
      invalidateMonitoringConfigCache();
    } catch {
      // Non-fatal — the cache TTL is 5 minutes so the change still
      // propagates within that window even if the invalidate call fails.
    }

    return NextResponse.json({ config });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
