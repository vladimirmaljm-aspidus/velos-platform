import { NextRequest, NextResponse } from "next/server";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";
import { authorizeCron } from "@/lib/api/cron-auth";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";

export const runtime = "nodejs";

/**
 * Cron endpoint — hourly sweep that marks proformas as `expired` when
 * their `valid_until` has passed while still in `sent` / `accepted`
 * status. Idempotent; safe to run hourly (or more often).
 *
 * Background
 * ----------
 * Proformas carry a `valid_until` timestamptz that signals how long the
 * commercial commitment stays open. Before this cron, a proforma whose
 * `valid_until` had passed stayed in `sent` or `accepted` forever — the
 * partner could still "accept" a stale proforma weeks after it expired,
 * and finance teams had no clean `expired` cohort to filter on. The
 * proforma status enum already includes `expired` (see
 * `ProformaStatus` in src/lib/supabase/types.ts) but nothing was setting
 * it automatically. This route closes that gap.
 *
 * Behaviour
 * ---------
 *   1. SELECT all proformas where `status IN ('sent','accepted')` AND
 *      `valid_until IS NOT NULL` AND `valid_until < now()`.
 *   2. For each row, UPDATE `status='expired'`. Per-row try/catch so a
 *      single failure (e.g. a trigger error on one row) doesn't abort
 *      the rest of the cohort.
 *   3. Audit-log the sweep: a single `cron.proforma_overdue` audit
 *      entry with `updated`, `by_tenant`, and `proforma_ids` in
 *      `details` (same shape as the invoice-overdue cron for parity).
 *   4. Returns `{ ok, updated }`.
 *
 * Idempotent
 * ----------
 * The `WHERE status IN ('sent','accepted')` filter means a row that's
 * already `expired` (or moved to `paid`, `draft`, etc.) is left
 * untouched. Running the cron twice in a row is safe — the second run
 * finds zero rows.
 *
 * Authentication
 * --------------
 * Caller must supply `Authorization: Bearer <CRON_TOKEN>` header
 * (preferred), `?token=…` URL query (legacy), OR a valid super_admin
 * session cookie (for manual runs from the browser). See
 * `authorizeCron` in src/lib/api/cron-auth.ts.
 *
 * Scheduling
 * ----------
 * Hourly via pg_cron — see migration 059_proforma_overdue_cron.sql.
 * Hourly is frequent enough that an expired proforma flips to
 * `expired` within ~60 minutes of its `valid_until`, and infrequent
 * enough not to add meaningful load (the query is a single indexed
 * range scan on `valid_until`).
 */
export async function GET(req: NextRequest) {
  try {
    // Auth: shared cron token (header preferred, URL query legacy) OR a
    // super_admin session cookie (for manual runs from the browser).
    // P1 timing-attack fix: token comparison is constant-time via
    // `crypto.timingSafeEqual` — see `authorizeCron`.
    const unauth = await authorizeCron(req);
    if (unauth) return unauth;

    if (!isSupabaseConfigured()) {
      return NextResponse.json(
        { error: "Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." },
        { status: 503 },
      );
    }

    const sb = getSupabase();
    const nowIso = new Date().toISOString();

    // ── 1. Fetch the cohort: sent/accepted proformas whose valid_until
    // is in the past. We do this in two steps (SELECT then per-row
    // UPDATE) instead of a single bulk `UPDATE ... RETURNING` because
    // the per-row UPDATE pattern lets us wrap each one in its own
    // try/catch — a single row failure (e.g. a trigger error on a row
    // with stale data) doesn't abort the rest. The bulk UPDATE would
    // either succeed entirely or roll back entirely.
    let rows: Array<{ id: string; number: string; tenant_id: string; valid_until: string | null }> = [];
    try {
      const { data, error } = await sb
        .from("proformas")
        .select("id, number, tenant_id, valid_until")
        .in("status", ["sent", "accepted"])
        .not("valid_until", "is", null)
        .lt("valid_until", nowIso);
      if (error) throw error;
      rows = (data as Array<{ id: string; number: string; tenant_id: string; valid_until: string | null }>) || [];
    } catch (e: any) {
      console.error("[cron/proforma-overdue] cohort fetch failed:", e);
      // Re-throw so the outer catch returns a 500 — the operator needs
      // to know the cron is failing entirely (not just per-row).
      throw e;
    }

    // ── 2. Per-row UPDATE to 'expired'. Per-row try/catch so one
    // failure doesn't abort the others. Idempotent: rows that flipped
    // to 'expired' between our SELECT and UPDATE (e.g. by a concurrent
    // cron run or a manual admin edit) no longer match the WHERE
    // clause `status IN ('sent','accepted')`, so the UPDATE is a no-op
    // and `data` comes back empty.
    const updated: Array<{ id: string; number: string; tenant_id: string }> = [];
    const failures: Array<{ id: string; error: string }> = [];
    for (const row of rows) {
      try {
        const { data: updRows, error: updErr } = await sb
          .from("proformas")
          .update({ status: "expired" })
          .eq("id", row.id)
          .in("status", ["sent", "accepted"])
          .lt("valid_until", nowIso)
          .select("id, number, tenant_id");
        if (updErr) throw updErr;
        // If the row was already flipped (race), updRows is empty —
        // don't count it as updated.
        const updatedRow = (updRows as Array<{ id: string; number: string; tenant_id: string }> | null)?.[0];
        if (updatedRow) {
          updated.push(updatedRow);
        }
      } catch (e: any) {
        // One row's failure must not abort the rest. Capture it so the
        // audit trail + response can report partial failure.
        console.error(`[cron/proforma-overdue] failed for proforma ${row.id}:`, e);
        failures.push({ id: row.id, error: e?.message || String(e) });
      }
    }

    // ── 3. Audit-log the sweep. Group by tenant so the audit trail
    // shows per-tenant impact (a single cron run can touch multiple
    // tenants). Same shape as the invoice-overdue cron (migration 025)
    // for ops-tooling parity.
    const byTenant = new Map<string, string[]>();
    for (const p of updated) {
      const arr = byTenant.get(p.tenant_id) || [];
      arr.push(p.id);
      byTenant.set(p.tenant_id, arr);
    }
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: "cron", tenant_id: null },
        req,
        "cron.proforma_overdue",
        "system",
        "cron",
        {
          ran_at: nowIso,
          updated: updated.length,
          by_tenant: Object.fromEntries(byTenant),
          proforma_ids: updated.map((p) => p.id),
          failures,
        },
      );
    } catch (e) {
      // Audit-logging is best-effort — a failure here must not change
      // the response. The status updates are the source of truth.
      console.error("[cron/proforma-overdue] audit log failed:", e);
    }

    console.info(
      `[cron/proforma-overdue] ran_at=${nowIso} updated=${updated.length} failed=${failures.length}`,
    );

    return NextResponse.json({ ok: true, updated: updated.length, failed: failures.length });
  } catch (e: any) {
    console.error("[cron/proforma-overdue]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}
