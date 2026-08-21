import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, sanitizeError } from "@/lib/api/helpers";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";
import {
  getMetricsSummary,
  checkAlerts,
  ALERT_THRESHOLDS,
  SLOW_THRESHOLD_MS,
} from "@/lib/monitoring/apm";
import { RETENTION_POLICY } from "@/lib/compliance/retention";

export const runtime = "nodejs";

/**
 * System health dashboard data (super-admin only).
 *
 * Aggregates everything the "System Health" tab needs in one round
 * trip:
 *
 *   • process: Node uptime + memory snapshot (rss / heap / external)
 *   • apm: live in-memory APM summary (per-route p50/p95/max, slow
 *          requests, error rate, slow threshold) — same shape as
 *          /api/admin/performance
 *   • db: real Postgres metrics via the get_db_metrics() RPC — DB
 *          size (bytes + pretty), active/max connections, top-10
 *          largest public-schema tables. Plus the row-count liveness
 *          probe per table (HEAD request, capped at 1000).
 *   • sentry: enabled / server_only / client_only / disabled
 *   • crons: the actual pg_cron job list via the get_cron_status()
 *            RPC — every job (not just 4 hard-coded ones), with the
 *            real last-run status + start_time + end_time + return
 *            message from cron.job_run_details. Replaces the broken
 *            audit_logs lookup that used the wrong action-name format.
 *   • retention: the policy table from lib/compliance/retention.ts
 *
 * Auth: super_admin only. Same rationale as the other admin routes —
 * exposing per-tenant traffic patterns to a tenant admin is a
 * cross-tenant info leak.
 */

interface DbMetrics {
  status: "ok" | "error" | "not_configured";
  error: string | null;
  db_size_pretty: string | null;
  db_size_bytes: number | null;
  active_connections: number | null;
  max_connections: number | null;
  largest_tables: Array<{
    schemaname: string;
    tablename: string;
    size_pretty: string;
    size_bytes: number;
  }>;
  table_counts: Record<string, number>;
}

interface CronJob {
  jobid: number;
  jobname: string;
  schedule: string;
  active: boolean;
  path: string | null;
  description: string | null;
  last_run_status: string | null;
  last_run_start: string | null;
  last_run_end: string | null;
  last_return_message: string | null;
}

// Static, human-readable descriptions for the canonical pg_cron jobs.
// Sourced from the migration that schedules each job. Surfaced in the
// UI for ops (a row's "what does this cron do?"). New crons added via
// a future migration will simply appear with a null description —
// the UI degrades to showing just the jobname + schedule.
const CRON_DESCRIPTIONS: Record<string, { description: string; path: string | null }> = {
  "session-cleanup": {
    path: null,
    description: "Deletes expired portal sessions (sessions table).",
  },
  "password-reset-cleanup": {
    path: null,
    description: "Expires stale password-reset tokens past their validity window.",
  },
  "vacuum-settings": {
    path: null,
    description: "pg_cron AUTOVACUUM tuning probe (admin only).",
  },
  "vacuum-users": {
    path: null,
    description: "VACUUM ANALYZE the users table (churn-heavy).",
  },
  "vacuum-sessions": {
    path: null,
    description: "VACUUM ANALYZE the sessions table (highest churn).",
  },
  "vacuum-audit": {
    path: null,
    description: "VACUUM ANALYZE the audit_logs table (write-heavy append-only).",
  },
  "vacuum-known-ips": {
    path: null,
    description: "VACUUM ANALYZE the known_ips table.",
  },
  "vacuum-inv-mov": {
    path: null,
    description: "VACUUM ANALYZE the inventory_movements table.",
  },
  "rate-limits-cleanup": {
    path: null,
    description: "Deletes expired rate-limit rows (rate_limits table).",
  },
  "subscription-sweep": {
    path: "/api/cron/subscription-sweep",
    description: "Cancels expired trials; suspends tenants with overdue invoices.",
  },
  "subscription-sweep-hourly": {
    path: "/api/cron/subscription-sweep",
    description: "Cancels expired trials; suspends tenants with overdue invoices.",
  },
  "webhook-retry": {
    path: "/api/cron/webhook-retry",
    description: "Retries failed webhook deliveries with exponential backoff (cap 5).",
  },
  "invoice-overdue": {
    path: "/api/cron/invoice-overdue",
    description: "Marks invoices as overdue when their due date has passed.",
  },
  "invoice-overdue-check": {
    path: "/api/cron/invoice-overdue",
    description: "Marks invoices as overdue when their due date has passed.",
  },
  "breach-notification-check": {
    path: "/api/cron/breach-notification-check",
    description: "GDPR Art. 33 — escalates incidents whose 72h deadline is < 24h away.",
  },
  "data-retention": {
    path: "/api/cron/data-retention",
    description: "Executes the GDPR retention policy — purges stale rows past their retention window.",
  },
  "data-retention-cleanup": {
    path: "/api/cron/data-retention",
    description: "Executes the GDPR retention policy — purges stale rows past their retention window.",
  },
};

export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const summary = getMetricsSummary();
  const alerts = await checkAlerts();
  const mem = process.memoryUsage();
  const memory = {
    rssMb: Math.round(mem.rss / 1024 / 1024),
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
    externalMb: Math.round(mem.external / 1024 / 1024),
  };

  // Sentry status — mirrors the /api/health helper.
  const sentry = ((): "enabled" | "server_only" | "client_only" | "disabled" => {
    const server = !!process.env.SENTRY_DSN;
    const client = !!process.env.NEXT_PUBLIC_SENTRY_DSN;
    if (server && client) return "enabled";
    if (server) return "server_only";
    if (client) return "client_only";
    return "disabled";
  })();

  // ─── Cron status (real pg_cron metadata via RPC) ──────────────────────
  // Replaces the broken audit_logs lookup that searched for the wrong
  // action-name format (cron.<path>.run vs the actual cron.<underscore>).
  // The get_cron_status() RPC (migration 043) is SECURITY DEFINER so
  // the service_role can read cron.job + cron.job_run_details.
  let crons: CronJob[] = [];
  try {
    if (isSupabaseConfigured()) {
      const sb = getSupabase();
      const { data: cronRows, error: cronErr } = await sb.rpc("get_cron_status");
      if (cronErr) throw cronErr;
      crons = ((cronRows ?? []) as any[]).map((r) => {
        const meta = CRON_DESCRIPTIONS[r.jobname] ?? { description: null, path: null };
        return {
          jobid: r.jobid,
          jobname: r.jobname,
          schedule: r.schedule,
          active: r.active,
          path: meta.path,
          description: meta.description,
          last_run_status: r.last_run_status ?? null,
          last_run_start: r.last_run_start ?? null,
          last_run_end: r.last_run_end ?? null,
          last_return_message: r.last_return_message ?? null,
        };
      });
    }
  } catch {
    // Degrade to an empty list — the UI shows "no crons visible" rather
    // than crashing the whole dashboard. (Likely cause: migration 043
    // not yet applied to this env.)
    crons = [];
  }

  // ─── DB metrics (real Postgres introspection via RPC) ────────────────
  // Replaces the row-count-only stub. The get_db_metrics() RPC
  // (migration 043) is SECURITY DEFINER so the service_role can read
  // pg_database_size, pg_stat_activity, and pg_total_relation_size.
  const TABLE_PROBES = [
    "tenants",
    "users",
    "partners",
    "deals",
    "offers",
    "invoices",
    "audit_logs",
    "sessions",
    "login_history",
    "mail_queue",
    "vault_secrets",
    "rate_limits",
    "notifications",
    "kyc_submissions",
    "webhook_deliveries",
  ];

  let db: DbMetrics = {
    status: "not_configured",
    error: null,
    db_size_pretty: null,
    db_size_bytes: null,
    active_connections: null,
    max_connections: null,
    largest_tables: [],
    table_counts: {},
  };

  try {
    if (!isSupabaseConfigured()) {
      db = {
        ...db,
        status: "not_configured",
        error: "SUPABASE_URL / service-role key not set",
      };
    } else {
      const sb = getSupabase();

      // Real DB metrics via RPC — single round trip.
      try {
        const { data: m, error: mErr } = await sb.rpc("get_db_metrics");
        if (mErr) throw mErr;
        const metrics = (m ?? {}) as any;
        db.db_size_pretty = metrics.db_size_pretty ?? null;
        db.db_size_bytes = Number(metrics.db_size_bytes ?? 0) || null;
        db.active_connections = Number(metrics.active_connections ?? 0) || null;
        db.max_connections = Number(metrics.max_connections ?? 0) || null;
        db.largest_tables = Array.isArray(metrics.largest_tables)
          ? metrics.largest_tables
          : [];
      } catch {
        // Migration 043 not applied yet — degrade gracefully (UI shows
        // null for these tiles; the row-count liveness still works).
      }

      // Per-table row counts (HEAD request, capped at 1000 by PostgREST).
      // Kept as a liveness probe — confirms each table is readable.
      const counts: Record<string, number> = {};
      for (const table of TABLE_PROBES) {
        const { count, error } = await sb
          .from(table)
          .select("id", { count: "exact", head: true });
        if (!error && typeof count === "number") {
          counts[table] = count;
        } else {
          counts[table] = -1; // signal error per-table without aborting the loop
        }
      }
      db.status = "ok";
      db.error = null;
      db.table_counts = counts;
    }
  } catch (e: any) {
    db = { ...db, status: "error", error: sanitizeError(e) };
  }

  return NextResponse.json({
    process: {
      uptimeSeconds: Math.round(process.uptime()),
      memory,
      nodeVersion: process.version,
      platform: process.platform,
    },
    apm: {
      summary,
      alerts,
      thresholds: ALERT_THRESHOLDS,
      slowThresholdMs: SLOW_THRESHOLD_MS,
      bufferCapacity: 1000,
    },
    db,
    sentry,
    crons,
    retention: RETENTION_POLICY,
    timestamp: new Date().toISOString(),
  });
}
