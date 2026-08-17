// src/app/api/admin/retention-status/route.ts
// ----------------------------------------------------------------------------
// Data-retention status dashboard (P1-1 / Feature 3).
//
//   GET /api/admin/retention-status
//     → per-table row counts (total + pending-deletion), the configured
//       retention window, and the next cleanup time for every table
//       the data-retention cron touches.
//     → Super-admin only.
//
// SUPER-ADMIN RULE
// ----------------
// Only super_admin can read this route. The route is gated by
// `requireSuperAdmin` (NEVER blocked for super_admin; everyone else
// gets 401 / 403 with a `role.escalation` security event). This
// matches the `/api/settings/retention-config` route (the companion
// writer) and the rest of the super-admin admin surface.
//
// The output is consumed by the super-admin retention dashboard so
// the operator can answer:
//   • "Is the cron still firing?" → last_run_at + last_run_summary.
//   • "How many rows will the next run delete?" → pending_deletion
//     per table.
//   • "When will the cron run again?" → next_run_at.
//   • "Are my configured windows being honoured?" → config field
//     echoes back so the dashboard can diff against defaults.
// ----------------------------------------------------------------------------

import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, sanitizeError } from "@/lib/api/helpers";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";
import {
  RETENTION_POLICY,
  getRetentionConfig,
  getEnforceableRetentionRules,
  type RetentionRule,
} from "@/lib/compliance/retention";

export const runtime = "nodejs";

interface TableStatus {
  table: string;
  description: string;
  kind: RetentionRule["kind"];
  /** Configured retention window in days (or null for indefinite/regulatory). */
  days: number | null;
  /** Column the cron filters on (null when N/A — e.g. indefinite). */
  column: string | null;
  /** For `delete_after_status`: the status value that qualifies for deletion. */
  status_column: string | null;
  status_value: string | null;
  /** Total row count in the table (null = query failed / table missing). */
  total_rows: number | null;
  /** Rows whose retention window has already elapsed (eligible for the next delete). */
  pending_deletion: number | null;
  /** Per-table error from the count query (null on success). */
  error: string | null;
}

interface CronInfo {
  /** Cron schedule string (e.g. "0 3 * * *"). Null when pg_cron isn't installed. */
  schedule: string | null;
  /** ISO timestamp of the next scheduled run. Null when unknown. */
  next_run_at: string | null;
  /** ISO timestamp of the last run (from audit_logs.cron.data_retention). */
  last_run_at: string | null;
  /** Summary of the last run (total_deleted + tables_failed). */
  last_run_summary: {
    total_deleted: number;
    tables_ok: number;
    tables_failed: number;
  } | null;
}

/**
 * Compute the next occurrence of "daily at HH:MM UTC" relative to `now`.
 * Returns null if the inputs are invalid. Used as the fallback when the
 * pg_cron `cron.job` table isn't reachable from the service-role client.
 */
function nextDailyRunUtc(now: Date, hourUtc: number, minuteUtc: number): Date | null {
  if (
    !Number.isFinite(hourUtc) ||
    !Number.isFinite(minuteUtc) ||
    hourUtc < 0 ||
    hourUtc > 23 ||
    minuteUtc < 0 ||
    minuteUtc > 59
  ) {
    return null;
  }
  const next = new Date(now);
  next.setUTCHours(hourUtc, minuteUtc, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

/**
 * Count rows in a single retention table that are eligible for deletion
 * under the given rule (i.e. whose `<column>` value is older than the
 * cutoff). Also returns the total row count for context.
 *
 * For `delete_after_status` rules, only rows whose status matches the
 * rule's `statusValue` are counted as pending-deletion (mirroring the
 * cron's `enforceRule` semantics — pending / failed mail_queue rows are
 * NEVER auto-deleted even when old).
 *
 * Returns `{ total_rows, pending_deletion, error }`. Both counts are
 * `null` and `error` is set when the query fails (e.g. table missing
 * in the current env, RLS denial — should not happen with the service
 * role — or a malformed column). The caller surfaces the error per-
 * table; a single table failure does NOT abort the rest.
 */
async function countTable(
  sb: ReturnType<typeof getSupabase>,
  rule: RetentionRule,
): Promise<{
  total_rows: number | null;
  pending_deletion: number | null;
  error: string | null;
}> {
  if (rule.kind !== "delete_after" && rule.kind !== "delete_after_status") {
    // Indefinite / regulatory — no pending-deletion concept.
    // We still return the total row count below (so the dashboard can
    // surface "audit_logs has X rows, regulatory 7-year retention").
    // Fall through with a sentinel that disables the pending count.
  }

  const column = rule.column ?? "created_at";
  const days = rule.days ?? 0;

  // Total row count.
  let total_rows: number | null = null;
  try {
    const { count, error } = await sb
      .from(rule.table)
      .select("*", { count: "exact", head: true });
    if (error) {
      return { total_rows: null, pending_deletion: null, error: sanitizeError(error) };
    }
    total_rows = count ?? 0;
  } catch (e: any) {
    return {
      total_rows: null,
      pending_deletion: null,
      error: sanitizeError(e),
    };
  }

  // For indefinite / regulatory rules, pending-deletion is not meaningful.
  if (rule.kind !== "delete_after" && rule.kind !== "delete_after_status") {
    return { total_rows, pending_deletion: 0, error: null };
  }

  // Pending-deletion count: rows older than the cutoff (filtered by status
  // for `delete_after_status` rules). Mirrors `enforceRule` in the cron.
  const cutoff = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000,
  ).toISOString();

  try {
    let q = sb
      .from(rule.table)
      .select("*", { count: "exact", head: true })
      .lt(column, cutoff);
    if (
      rule.kind === "delete_after_status" &&
      rule.statusColumn &&
      rule.statusValue
    ) {
      q = q.eq(rule.statusColumn, rule.statusValue);
    }
    const { count, error } = await q;
    if (error) {
      return { total_rows, pending_deletion: null, error: sanitizeError(error) };
    }
    return { total_rows, pending_deletion: count ?? 0, error: null };
  } catch (e: any) {
    return { total_rows, pending_deletion: null, error: sanitizeError(e) };
  }
}

/**
 * Query pg_cron's `cron.job` table for the `data-retention-cleanup` job.
 * Returns `{ schedule, next_run_at }`. Both are `null` when the table
 * isn't accessible (the service-role client can usually read pg_cron
 * tables, but a self-hosted / RBAC'd deploy might deny it — we fall
 * back to a computed "next 03:00 UTC" in that case).
 *
 * pg_cron exposes `next_run` as a timestamptz column on `cron.job` —
 * reading it directly is the most accurate "next cleanup time" source
 * (it accounts for the actual cron schedule, including any manual
 * unschedule/reschedule).
 */
async function getCronSchedule(
  sb: ReturnType<typeof getSupabase>,
): Promise<{ schedule: string | null; next_run_at: string | null }> {
  try {
    const { data, error } = await sb
      .from("cron.job")
      .select("jobname, schedule, next_run, active")
      .eq("jobname", "data-retention-cleanup")
      .maybeSingle();
    if (error || !data) {
      return { schedule: null, next_run_at: null };
    }
    const row = data as {
      jobname: string;
      schedule: string | null;
      next_run: string | null;
      active: boolean | null;
    };
    // If the job is inactive, the next_run column is unreliable —
    // treat it as "not scheduled".
    if (row.active === false) {
      return { schedule: row.schedule, next_run_at: null };
    }
    return { schedule: row.schedule, next_run_at: row.next_run };
  } catch {
    // pg_cron not installed / table not readable — fall back below.
    return { schedule: null, next_run_at: null };
  }
}

/**
 * Read the most recent `cron.data_retention` audit-log entry to surface
 * "last run" stats. The cron route writes one audit_logs row per run
 * with the per-table breakdown in `details`.
 *
 * Returns `null` when there's no audit_logs row yet (cron hasn't fired
 * since this route was deployed, or audit_logs is empty in this env).
 */
async function getLastRun(
  sb: ReturnType<typeof getSupabase>,
): Promise<{ last_run_at: string | null; last_run_summary: CronInfo["last_run_summary"] } | null> {
  try {
    const { data, error } = await sb
      .from("audit_logs")
      .select("created_at, details")
      .eq("action", "cron.data_retention")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) {
      return null;
    }
    const row = data as { created_at: string | null; details: any };
    const details = (row.details ?? {}) as {
      total_deleted?: number;
      tables_ok?: number;
      tables_failed?: number;
    };
    return {
      last_run_at: row.created_at,
      last_run_summary: {
        total_deleted: typeof details.total_deleted === "number" ? details.total_deleted : 0,
        tables_ok: typeof details.tables_ok === "number" ? details.tables_ok : 0,
        tables_failed: typeof details.tables_failed === "number" ? details.tables_failed : 0,
      },
    };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  // Supabase not configured — return an empty shape so the dashboard
  // can still render (with zeros and "next 03:00 UTC" computed locally).
  if (!isSupabaseConfigured()) {
    const config = await getRetentionConfig();
    const rules = getEnforceableRetentionRules(config);
    const next = nextDailyRunUtc(new Date(), 3, 0);
    return NextResponse.json({
      config,
      defaults: null,
      tables: rules.map((r) => ({
        table: r.table,
        description: r.description,
        kind: r.kind,
        days: r.days ?? null,
        column: r.column ?? null,
        status_column: r.statusColumn ?? null,
        status_value: r.statusValue ?? null,
        total_rows: null,
        pending_deletion: null,
        error: "Supabase is not configured.",
      })),
      cron: {
        schedule: "0 3 * * *",
        next_run_at: next ? next.toISOString() : null,
        last_run_at: null,
        last_run_summary: null,
      },
      generated_at: new Date().toISOString(),
    });
  }

  try {
    const sb = getSupabase();

    // Load the configured windows (5-min-cached inside getRetentionConfig).
    const config = await getRetentionConfig();
    // Build the rule list — every rule from RETENTION_POLICY with `days`
    // overridden by the config's values where applicable. This is the
    // exact list the cron iterates, so the dashboard is in lockstep.
    const enforceableRules = getEnforceableRetentionRules(config);

    // Per-table counts. We iterate every rule in `RETENTION_POLICY`
    // (not just the enforceable subset) so the dashboard also shows
    // indefinite / regulatory tables (users, partners, audit_logs,
    // kyc_submissions) with their current row counts — those are the
    // tables the operator most wants visibility into for GDPR Art. 5
    // "storage limitation" reviews.
    const tables: TableStatus[] = [];
    for (const rule of RETENTION_POLICY) {
      // For enforceable rules, use the rule returned by
      // getEnforceableRetentionRules (which carries the configured
      // `days`). For non-enforceable (regulatory/indefinite) rules,
      // use the static policy entry directly.
      const effectiveRule =
        enforceableRules.find((r) => r.table === rule.table) ?? rule;

      const { total_rows, pending_deletion, error } = await countTable(
        sb,
        effectiveRule,
      );
      tables.push({
        table: effectiveRule.table,
        description: effectiveRule.description,
        kind: effectiveRule.kind,
        days: effectiveRule.days ?? null,
        column: effectiveRule.column ?? null,
        status_column: effectiveRule.statusColumn ?? null,
        status_value: effectiveRule.statusValue ?? null,
        total_rows,
        pending_deletion,
        error,
      });
    }

    // Cron schedule + last run.
    const { schedule, next_run_at } = await getCronSchedule(sb);
    const last = await getLastRun(sb);

    // Fallback for next_run_at when pg_cron isn't readable: the cron
    // route is scheduled daily at 03:00 UTC (migration 034). Compute
    // the next 03:00 UTC locally so the dashboard always has SOME
    // "next cleanup time" to show.
    let resolvedNextRun = next_run_at;
    if (!resolvedNextRun) {
      const computed = nextDailyRunUtc(new Date(), 3, 0);
      resolvedNextRun = computed ? computed.toISOString() : null;
    }

    return NextResponse.json({
      config,
      tables,
      cron: {
        schedule: schedule ?? "0 3 * * *",
        next_run_at: resolvedNextRun,
        last_run_at: last?.last_run_at ?? null,
        last_run_summary: last?.last_run_summary ?? null,
      },
      generated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
