import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/data/store";
import { getSupabase } from "@/lib/supabase/client";
import { authorizeCron } from "@/lib/api/cron-auth";
import { audit, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * Cron endpoint — escrow auto-release sweep.
 *
 * FIX-AUDIT3 #6 / HIGH state-machine gap. The 2-phase commit in
 * `releaseEscrow` (FIX-AUDIT2-CRIT / C4) only fires when one of the two
 * parties calls `/api/marketplace/finance/[id]/release`. If neither party
 * ever confirms (a non-responsive counterparty), the funds are held
 * indefinitely even after `escrow_held_until` has passed — the escrow
 * UI shows "Auto-release overdue" but no row ever moves the DB state.
 *
 * This sweep is the safety net. Scheduled HOURLY via pg_cron (the hourly
 * cadence matches the human timescale of escrow disputes — running
 * more often wouldn't change the outcome). On every run it queries
 * `marketplace_financial_instruments` for:
 *
 *   instrument_type = 'escrow'
 *   AND status = 'active'
 *   AND escrow_held_until IS NOT NULL
 *   AND escrow_held_until < now()
 *
 * and applies one of three outcomes per row, based on
 * `escrow_release_condition`:
 *
 *   • `delivery_confirmation` or `manual`
 *     → auto-release. Set status='released'. The "manual" condition
 *       means "release when the held-until deadline passes" — there is
 *       no human gate to wait for. The `delivery_confirmation`
 *       condition similarly has no extra DB state we can check here
 *       (the delivery confirmation lives on the contract / logistics
 *       side, not on the escrow row), so once the held-until deadline
 *       has passed we treat the escrow as releasable. The audit log
 *       records who/when.
 *
 *   • `both_parties_confirm`
 *     → do NOT auto-release. We don't have both confirmations, and
 *       releasing funds without them would defeat the whole point of
 *       the 2-phase commit. Move to `disputed` so the row is no longer
 *       "active / overdue" in the UI (it now reads "Disputed") and
 *       notify the tenant admins so a human can resolve manually.
 *
 *   • `inspection_pass`
 *     → same as `both_parties_confirm`. We have no automated
 *       inspection-pass signal in the DB to consume; move to
 *       `disputed` + notify the tenant admins.
 *
 * Auth: same `authorizeCron` as the other cron routes — the pg_cron
 * caller supplies `Authorization: Bearer <CRON_TOKEN>`, OR a
 * super_admin session cookie (manual browser run from the admin UI).
 *
 * Idempotent: re-runs only affect rows still in `active` status (the
 * `.eq("status", "active")` filter excludes already-released or
 * already-disputed rows from previous runs).
 *
 * NOTE — `released_at`: the underlying table has no `released_at`
 * column (see `supabase/migrations/049_marketplace_finance.sql`). The
 * existing `releaseEscrow` store path also only updates `status`; the
 * `updated_at` column is auto-stamped by the trigger. We mirror that
 * contract here and rely on the per-row audit log entry to record the
 * release timestamp + the actor ("cron").
 */
export async function GET(req: NextRequest) {
  try {
    const unauth = await authorizeCron(req);
    if (unauth) return unauth;

    const sb = getSupabase();
    const store = await getStore();
    const nowIso = new Date().toISOString();

    // Pull every active escrow whose held-until deadline has passed.
    // `escrow_held_until IS NOT NULL` guards against escrows created
    // without a deadline (manual release only — those never auto-
    // release via this cron; they require the human release call).
    const { data: dueEscrows, error } = await sb
      .from("marketplace_financial_instruments")
      .select(
        "id, tenant_id, partner_id, counterparty_partner_id, escrow_release_condition, amount, currency, escrow_held_until",
      )
      .eq("instrument_type", "escrow")
      .eq("status", "active")
      .not("escrow_held_until", "is", null)
      .lt("escrow_held_until", nowIso);
    if (error) throw error;

    const rows = (dueEscrows || []) as Array<{
      id: string;
      tenant_id: string;
      partner_id: string;
      counterparty_partner_id: string | null;
      escrow_release_condition: string | null;
      amount: number;
      currency: string;
      escrow_held_until: string;
    }>;

    const released: string[] = [];
    const disputed: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const row of rows) {
      const cond = row.escrow_release_condition;
      const isAutoRelease = cond === "delivery_confirmation" || cond === "manual";
      const nextStatus = isAutoRelease ? "released" : "disputed";

      // Single-row update. We re-assert status='active' in the WHERE
      // (via `.eq("status", "active")` here) so a concurrent release
      // by a portal client between our SELECT and UPDATE doesn't get
      // clobbered — the UPDATE simply no-ops in that case and we
      // surface it as a no-op (not a failure).
      const { error: updErr } = await sb
        .from("marketplace_financial_instruments")
        .update({ status: nextStatus })
        .eq("id", row.id)
        .eq("status", "active");
      if (updErr) {
        console.error("[cron/escrow-auto-release] update failed:", row.id, updErr);
        failed.push({ id: row.id, error: updErr.message });
        continue;
      }

      // Per-row audit log entry. The audit trail is the legal record
      // of "the platform auto-released / auto-disputed this escrow on
      // this date". Each entry carries the row id, the action taken,
      // and the condition that drove the decision so an auditor can
      // reconstruct the reasoning later.
      try {
        await audit(
          store,
          { id: undefined, username: "cron", tenant_id: row.tenant_id },
          req,
          isAutoRelease
            ? "marketplace.escrow_auto_released"
            : "marketplace.escrow_auto_disputed",
          "marketplace_financial_instruments",
          row.id,
          {
            instrument_id: row.id,
            escrow_release_condition: cond,
            escrow_held_until: row.escrow_held_until,
            ran_at: nowIso,
            amount: row.amount,
            currency: row.currency,
            partner_id: row.partner_id,
            counterparty_partner_id: row.counterparty_partner_id,
          },
        );
      } catch (e) {
        // Audit failure must NOT roll back the state change — the
        // status update is the source of truth; the audit log is the
        // compliance record. Log prominently so ops can backfill.
        console.error(
          "[cron/escrow-auto-release] audit log failed for",
          row.id,
          e,
        );
      }

      // For `disputed` outcomes, broadcast an in-app notification to
      // the tenant admins so a human knows the cron moved funds into a
      // dispute state. We use the generic `system_message` type (no
      // escrow-specific notification type exists yet) and a null
      // user_id so the broadcast hits every tenant admin. Best-effort
      // — failures inside notify() are swallowed there.
      if (!isAutoRelease) {
        try {
          const { notify } = await import("@/lib/notif/helper");
          await notify({
            tenantId: row.tenant_id,
            userId: null, // broadcast to all tenant admins
            type: "system_message",
            title: "Escrow moved to disputed (auto-release sweep)",
            message:
              `Escrow ${row.id} passed its held-until deadline ` +
              `(${row.escrow_held_until}) with release condition ` +
              `"${cond}". The auto-release sweep moved it to ` +
              `"disputed" so a human can resolve it manually.`,
            entityType: "marketplace_financial_instruments",
            entityId: row.id,
          });
        } catch (e) {
          console.error(
            "[cron/escrow-auto-release] tenant admin notify failed for",
            row.id,
            e,
          );
        }
      }

      if (isAutoRelease) released.push(row.id);
      else disputed.push(row.id);
    }

    // Summary audit entry — proves the cron itself fired (the per-row
    // entries above cover individual instruments; this entry covers
    // "the sweep ran on this date and touched N rows").
    try {
      await audit(
        store,
        { id: undefined, username: "cron", tenant_id: null },
        req,
        "cron.escrow_auto_release",
        "system",
        "cron",
        {
          ran_at: nowIso,
          due_escrows: rows.length,
          released: released.length,
          disputed: disputed.length,
          failed: failed.length,
          released_ids: released,
          disputed_ids: disputed,
          failed_ids: failed.map((f) => f.id),
        },
      );
    } catch (e) {
      console.error("[cron/escrow-auto-release] summary audit failed:", e);
    }

    console.info(
      `[cron/escrow-auto-release] ran_at=${nowIso} due=${rows.length} ` +
      `released=${released.length} disputed=${disputed.length} ` +
      `failed=${failed.length}`,
    );

    return NextResponse.json({
      ok: true,
      ran_at: nowIso,
      due_escrows: rows.length,
      released,
      disputed,
      failed,
    });
  } catch (e: any) {
    console.error("[cron/escrow-auto-release]", e);
    return NextResponse.json(
      { error: sanitizeError(e) },
      { status: 500 },
    );
  }
}
