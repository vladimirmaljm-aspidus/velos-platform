/**
 * Bulk-operation failure capture (audit47).
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS: on 2026-09-06 a tenant admin fired 13 bulk operations in
 * 22 seconds (products.bulk_deactivate / hide_from_portal / delete, 72–73 rows
 * each) and EVERY row failed — yet nothing reached the Error Audit:
 *
 *   • The route returns HTTP 200 with per-row `results[].error` — the client
 *     fetch wrapper only reports status ≥ 500, so a "200 with 0/72 success"
 *     is invisible to /api/client-errors.
 *   • The audit entry stored only `{ action, count, successCount }` — the
 *     per-row error strings were dropped, so even the audit trail could not
 *     answer "why did every row fail?".
 *
 * 936 lost error strings later, this module makes every bulk route
 * diagnosable by construction:
 *
 *   1. summarizeBulkFailures() — aggregates per-row reasons into
 *      `{ failureCount, failureReasons: [{ error, count }] }` (top 5 distinct
 *      reasons, capped) — merged into the audit entry's `details`.
 *   2. recordBulkFailures() — writes an error_logs row (source 'server',
 *      fingerprinted) whenever failureCount > 0. Full failure = level
 *      'error'; partial failure = level 'warning'. Best-effort, never throws —
 *      auditability must not be able to break the bulk flow itself.
 *
 * Used by /api/offers/bulk, /api/products/bulk, /api/invoices/bulk.
 */

import type { NextRequest } from "next/server";
import { recordError } from "@/lib/monitoring/error-audit";

/** Minimal per-row result shape shared by every bulk route. */
export interface BulkResultRow {
  id: string;
  success: boolean;
  error?: string;
  status?: string;
}

/** Aggregated failure reasons, sorted by frequency, top `maxReasons`. */
export interface BulkFailureSummary {
  failureCount: number;
  failureReasons: { error: string; count: number }[];
  /** A few failing row IDs for correlation with the entity tables. */
  sampleFailedIds: string[];
}

/** Distinct reasons kept in the summary (keeps audit rows + context small). */
const MAX_REASONS = 5;
/** Failing row IDs kept as samples. */
const MAX_SAMPLE_IDS = 5;
/** Max length of a single reason string before truncation. */
const MAX_REASON_LEN = 300;

/**
 * Aggregate per-row failure reasons.
 * Pure function, never throws — suitable for building audit `details`.
 */
export function summarizeBulkFailures(results: BulkResultRow[]): BulkFailureSummary {
  const failed = results.filter((r) => !r.success);
  if (failed.length === 0) {
    return { failureCount: 0, failureReasons: [], sampleFailedIds: [] };
  }
  const counts = new Map<string, number>();
  for (const f of failed) {
    const reason = (String(f.error || "(no error message)").slice(0, MAX_REASON_LEN)).trim() || "(no error message)";
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  const failureReasons = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_REASONS)
    .map(([error, count]) => ({ error, count }));
  return {
    failureCount: failed.length,
    failureReasons,
    sampleFailedIds: failed.slice(0, MAX_SAMPLE_IDS).map((r) => r.id),
  };
}

/**
 * Merge the failure summary into the audit details object the route passes
 * to `audit()`. Returns a NEW object — never mutates the input.
 */
export function enrichAuditDetails(
  base: Record<string, unknown>,
  summary: BulkFailureSummary,
): Record<string, unknown> {
  if (summary.failureCount === 0) return { ...base };
  return {
    ...base,
    failureCount: summary.failureCount,
    failureReasons: summary.failureReasons,
    sampleFailedIds: summary.sampleFailedIds,
  };
}

/** Auth-user shape as returned by getAuthUser() — SafeUser or API-key pseudo-user. */
export interface BulkAuthUser {
  id?: string;
  username?: string;
  email?: string;
  role?: string;
  tenant_id?: string | null;
}

/**
 * Write an error_logs row for a bulk operation with failed rows.
 *
 * Best-effort: swallows every failure (the bulk response must never be
 * delayed or broken by audit capture). Level: full failure (0 successes) →
 * 'error'; partial → 'warning'.
 */
export async function recordBulkFailures(opts: {
  entity: string; // "offers" | "products" | "invoices" — used in message + route
  action: string;
  results: BulkResultRow[];
  summary: BulkFailureSummary;
  attemptedCount: number;
  succeededCount: number;
  user?: BulkAuthUser;
  tenantId?: string | null;
  req?: NextRequest;
}): Promise<void> {
  const { entity, action, summary, attemptedCount, succeededCount } = opts;
  if (summary.failureCount === 0) return;
  try {
    const top = summary.failureReasons
      .map((r) => `${r.error} (x${r.count})`)
      .join("; ")
      .slice(0, 900);
    const level = succeededCount === 0 ? "error" : "warning";
    const message =
      `bulk ${entity}.${action}: ${succeededCount}/${attemptedCount} rows succeeded — ${top}`;
    const req = opts.req;
    const url = req ? new URL(req.url).pathname : undefined;
    await recordError({
      source: "server",
      level,
      message,
      url: url ?? null,
      user_email: opts.user?.email ?? null,
      user_role: opts.user?.role ?? null,
      tenant_id: opts.tenantId ?? opts.user?.tenant_id ?? null,
      context: {
        type: "bulk_failure",
        route: url ? `${url}` : `/api/${entity}/bulk`,
        entity,
        action,
        attempted: attemptedCount,
        succeeded: succeededCount,
        failureCount: summary.failureCount,
        failureReasons: summary.failureReasons,
        sampleFailedIds: summary.sampleFailedIds,
      },
    });
  } catch {
    // Never throw out of the audit path.
  }
}
