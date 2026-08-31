import { NextRequest, NextResponse } from "next/server";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";
import { authorizeCron } from "@/lib/api/cron-auth";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import {
  getRetentionConfig,
  getEnforceableRetentionRules,
  type RetentionRule,
  type RetentionConfig,
} from "@/lib/compliance/retention";

export const runtime = "nodejs";

/**
 * Cron endpoint — enforces the PII data retention policy
 * (`src/lib/compliance/retention.ts`). Runs daily at 03:00 UTC via pg_cron.
 *
 * P1-1 / Feature 3: the retention windows are now CONFIGURABLE per-table
 * via the `/api/settings/retention-config` super-admin route. The cron
 * loads the current config via `getRetentionConfig()` and builds the
 * enforceable rule list via `getEnforceableRetentionRules(config)` —
 * the rule list mirrors the hardcoded `ENFORCEABLE_RETENTION_RULES`
 * shape, but with `days` fields overridden by the config's values.
 *
 * For each `delete_after` / `delete_after_status` rule in the policy,
 * this route issues a `DELETE FROM <table> WHERE <column> < now() - interval '<days> days'`
 * (filtered by status for `delete_after_status` rules). The route is
 * idempotent — running it twice in the same day is safe; the second
 * run just deletes 0 rows.
 *
 * Authentication: caller must supply `Authorization: Bearer <CRON_TOKEN>`
 * header (preferred), `?token=…` URL query (legacy), OR a valid super_admin
 * session cookie (for manual runs from the browser — super_admin is NEVER
 * blocked, can trigger the cleanup at will). See `authorizeCron`.
 *
 * Audit finding B-1 / P3-1: previously, PII tables (sessions,
 * login_history, password_resets, rate_limits, mail_queue, notifications)
 * were kept indefinitely — GDPR Article 5(1)(e) storage-limitation
 * violation + unbounded table growth. This cron enforces the documented
 * retention periods. Migration 034 schedules this route via pg_cron; the
 * existing migration-level pg_cron jobs (013, 024) remain as defence-in-
 * depth and are NOT removed by this change.
 *
 * Safety:
 *   • Each table DELETE is wrapped in its own try/catch — a failure on one
 *     table (e.g. a missing column, a lock conflict) does NOT abort the
 *     other cleanups. The per-table result is returned in the response so
 *     ops can see which tables failed.
 *   • The route NEVER deletes from `regulatory` or `indefinite` retention
 *     tables (audit_logs, kyc_submissions, users, partners, portal_access).
 *     Those rules exist for transparency and are filtered out at module
 *     load time via `getEnforceableRetentionRules(config)`.
 *   • The route does NOT log individual deleted row ids to audit_logs —
 *     logging the deletion would itself create new PII rows in audit_logs,
 *     defeating the purpose (see migration 030 comment).
 *   • All deletes use the service_role client which bypasses RLS — this is
 *     intentional for a cleanup cron, and the route is gated behind
 *     `authorizeCron` so only the pg_cron token / super_admin can invoke it.
 */
export async function GET(req: NextRequest) {
  try {
    // Auth: shared cron token (header preferred, URL query legacy) OR a
    // super_admin session cookie (for manual runs from the browser).
    const unauth = await authorizeCron(req);
    if (unauth) return unauth;

    // Fail fast if env vars aren't set — avoids the getSupabase() throw.
    if (!isSupabaseConfigured()) {
      return NextResponse.json(
        { error: "Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." },
        { status: 503 },
      );
    }

    const sb = getSupabase();
    const nowIso = new Date().toISOString();

    // ── P1-1 / Feature 3: load the configurable retention config ──
    // The config is loaded fresh on every cron run (the in-memory cache
    // has a 5-minute TTL but we don't want to rely on it for a daily
    // cron — `getRetentionConfig()` returns the cache if fresh, else
    // hits the DB). Falls back to DEFAULT_RETENTION_CONFIG if the
    // settings row is missing or Supabase is unreachable.
    const config = await getRetentionConfig();
    const enforceableRules = getEnforceableRetentionRules(config);

    const results: Array<{
      table: string;
      status: "deleted" | "skipped" | "error";
      deleted_count?: number;
      error?: string;
    }> = [];

    for (const rule of enforceableRules) {
      try {
        const deleted = await enforceRule(sb, rule);
        results.push({ table: rule.table, status: "deleted", deleted_count: deleted });
      } catch (e: any) {
        // A missing table / column in a given env should NOT abort the rest
        // of the cleanup. Log + record the failure and continue.
        const msg = e?.message || String(e) || "Unknown error";
        console.error(`[cron/data-retention] ${rule.table}: cleanup failed:`, msg);
        results.push({ table: rule.table, status: "error", error: msg });
      }
    }

    const totalDeleted = results
      .filter((r) => r.status === "deleted")
      .reduce((sum, r) => sum + (r.deleted_count ?? 0), 0);
    const failedTables = results.filter((r) => r.status === "error").map((r) => r.table);

    console.info(
      `[cron/data-retention] ran_at=${nowIso} total_deleted=${totalDeleted} ` +
      `tables_ok=${results.filter((r) => r.status === "deleted").length} ` +
      `tables_failed=${failedTables.length}`,
    );

    // P2 / task C-6 Fix 4: audit-log the retention sweep outcome so ops
    // can verify the cron is firing and triage which tables were cleaned
    // vs. which failed. The per-table breakdown (including deleted counts
    // and error messages for failed tables) goes into `details`.
    const store = await getStore();
    await audit(
      store,
      { id: undefined, username: "cron", tenant_id: null },
      req,
      "cron.data_retention",
      "system",
      "cron",
      {
        ran_at: nowIso,
        total_deleted: totalDeleted,
        tables_ok: results.filter((r) => r.status === "deleted").length,
        tables_failed: failedTables.length,
        results,
        config_used: config,
      },
    );

    return NextResponse.json({
      ok: true,
      ran_at: nowIso,
      total_deleted: totalDeleted,
      config_used: config,
      results,
    });
  } catch (e: any) {
    console.error("[cron/data-retention]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}

/**
 * Execute a single retention rule against the database.
 *
 * Uses the Supabase JS client's `.delete()` chained with `.lt()` for the
 * timestamp filter. The PostgREST translation is:
 *   DELETE FROM <table> WHERE <column> < <threshold_iso>
 *
 * For `delete_after_status` rules, also chains `.eq(<statusColumn>, <value>)`
 * so only rows with the matching status are deleted.
 *
 * Returns the number of rows actually deleted. The Supabase JS client
 * returns the count only when `.select()` is NOT chained — we use the
 * `count: "exact"` option on the delete call to get the row count.
 */
async function enforceRule(
  sb: ReturnType<typeof getSupabase>,
  rule: RetentionRule,
): Promise<number> {
  if (rule.kind !== "delete_after" && rule.kind !== "delete_after_status") {
    // Defensive — should be filtered out by getEnforceableRetentionRules,
    // but never delete from a table whose rule we don't understand.
    return 0;
  }

  const column = rule.column ?? "created_at";
  const days = rule.days ?? 0;
  // Compute the cutoff ISO timestamp in JS rather than relying on the DB's
  // now() — this keeps the cutoff deterministic across the per-table
  // iterations (a long-running cron would otherwise see now() drift by
  // a few ms between tables, which is irrelevant but harder to reason about).
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  let query = sb.from(rule.table).delete({ count: "exact" }).lt(column, cutoff);

  if (rule.kind === "delete_after_status" && rule.statusColumn && rule.statusValue) {
    query = query.eq(rule.statusColumn, rule.statusValue);
  }

  // `.delete({ count: "exact" })` sets the `Prefer: return=representation;
  // count=exact` header — PostgREST returns the deleted-row count in the
  // `Content-Range` response header WITHOUT putting the deleted rows in
  // the body (we'd otherwise download thousands of rows for a big mail_queue
  // cleanup, which would defeat the purpose of a low-overhead cron).
  //
  // The returned `data` is the deleted rows' representations (per
  // `Prefer: return=representation`) — we ignore it. Only `count` is read.
  const { count, error } = await query;

  if (error) {
    // Common errors:
    //   • "Could not find the table" — table doesn't exist in this env
    //     (e.g. a dev snapshot missing mail_queue). Treat as 0-deleted so
    //     the cron continues.
    //   • "column does not exist" — the rule's column is wrong. Surfaces
    //     in the per-table error so ops can fix the rule.
    //   • RLS denial — should not happen (service_role bypasses RLS) but
    //     if it does, the route returns 500.
    throw error;
  }

  return count ?? 0;
}
