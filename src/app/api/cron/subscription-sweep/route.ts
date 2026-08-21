import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase/client";
import { authorizeCron } from "@/lib/api/cron-auth";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { notifyTrialExpiringSoon } from "@/lib/notif/helper";

export const runtime = "nodejs";

/**
 * Cron endpoint — sweeps subscription state and auto-suspends tenants whose
 * trial or paid subscription window has expired. Idempotent; safe to run
 * every hour.
 *
 * Authentication: caller must supply an `Authorization: Bearer <CRON_TOKEN>`
 * header matching the CRON_TOKEN env var (preferred — F-8 security fix),
 * OR `?token=…` URL query (legacy, kept for backward compatibility), OR a
 * valid super_admin session (for manual runs from the browser).
 *
 * P2 / task C-6 Fix 4: each successful run appends a `cron.subscription_sweep`
 * audit log entry so ops can verify the cron is firing and which tenants it
 * suspended. The entry uses a system-level user (`id="system"`, `username="cron"`,
 * `tenant_id=null`).
 *
 * FEAT-2 (Issue 1): the sweep now ALSO warns tenant admins 48h before their
 * trial expires. Previously the cron only acted AFTER expiry (silent
 * suspension with no warning) — admins got locked out with no chance to add
 * a payment method or request an extension. The warning fan-out is
 * idempotent: we skip a tenant if a "Trial expiring soon" notification for
 * that tenant already exists (so a re-run within the same hour doesn't
 * spam). The hourly cron ticks the warning window down 48h → 47h → 46h…
 * but the existing-notification guard means each tenant gets at most one
 * warning per trial.
 */
export async function GET(req: NextRequest) {
  try {
    // Auth: shared cron token (header preferred, URL query legacy) OR a
    // super_admin session cookie (for manual runs from the browser).
    // P1 timing-attack fix (task C-5 Fix 1): token comparison is now
    // constant-time via `crypto.timingSafeEqual` — see `authorizeCron`.
    const unauth = await authorizeCron(req);
    if (unauth) return unauth;

    const sb = getSupabase();
    const nowIso = new Date().toISOString();

    // 0) FEAT-2: warn trials expiring within 48h (idempotent per-tenant).
    //    We notify the tenant admins BEFORE the suspension step so they
    //    have a chance to act. Skips trials already in their last hour
    //    (suspension will fire next anyway) and trials that already have
    //    a "Trial expiring soon" notification row.
    const warnThreshold = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const { data: soonToExpireTrials } = await sb
      .from("tenants")
      .select("id, name, trial_ends_at")
      .eq("status", "trial")
      .not("trial_ends_at", "is", null)
      .gt("trial_ends_at", nowIso) // not already expired (handled below)
      .lt("trial_ends_at", warnThreshold); // expires within 48h
    const trialWarnings = [] as string[];
    for (const t of (soonToExpireTrials as { id: string; name: string; trial_ends_at: string }[] | null) || []) {
      // Idempotency guard: skip if we already warned this tenant.
      const { count } = await sb
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", t.id)
        .eq("type", "system_message")
        .eq("entity_type", "tenant")
        .eq("entity_id", t.id)
        .ilike("title", "Trial expiring soon");
      if ((count ?? 0) > 0) continue; // already warned — don't spam
      const msLeft = new Date(t.trial_ends_at).getTime() - Date.now();
      const daysLeft = Math.max(1, Math.round(msLeft / (24 * 60 * 60 * 1000)));
      try {
        await notifyTrialExpiringSoon(t.id, t.name, t.trial_ends_at, daysLeft);
        trialWarnings.push(t.id);
      } catch (e) {
        console.error("[subscription-sweep] trial warning failed", t.id, e);
      }
    }

    // 1) Trials that have expired → suspend the tenant.
    const { data: expiredTrials } = await sb
      .from("tenants")
      .select("id, name")
      .eq("status", "trial")
      .not("trial_ends_at", "is", null)
      .lt("trial_ends_at", nowIso);

    const trialSuspended = [] as string[];
    for (const t of (expiredTrials as { id: string; name: string }[] | null) || []) {
      await sb.from("tenants").update({ status: "suspended", updated_at: nowIso }).eq("id", t.id);
      trialSuspended.push(t.id);
    }

    // 2) Paid subscriptions whose subscription_end has passed → suspend.
    const { data: expiredPaid } = await sb
      .from("tenants")
      .select("id, name")
      .eq("status", "active")
      .not("subscription_end", "is", null)
      .lt("subscription_end", nowIso);

    const paidSuspended = [] as string[];
    for (const t of (expiredPaid as { id: string; name: string }[] | null) || []) {
      await sb.from("tenants").update({ status: "suspended", updated_at: nowIso }).eq("id", t.id);
      paidSuspended.push(t.id);
    }

    // P2 / task C-6 Fix 4: audit-log the sweep outcome.
    const store = await getStore();
    await audit(
      store,
      { id: undefined, username: "cron", tenant_id: null },
      req,
      "cron.subscription_sweep",
      "system",
      "cron",
      {
        trial_suspended: trialSuspended.length,
        paid_suspended: paidSuspended.length,
        trial_suspended_ids: trialSuspended,
        paid_suspended_ids: paidSuspended,
        trial_warning_sent: trialWarnings.length,
        trial_warning_ids: trialWarnings,
      },
    );

    return NextResponse.json({
      ok: true,
      ran_at: nowIso,
      trial_suspended: trialSuspended.length,
      paid_suspended: paidSuspended.length,
      trial_suspended_ids: trialSuspended,
      paid_suspended_ids: paidSuspended,
      trial_warning_sent: trialWarnings.length,
      trial_warning_ids: trialWarnings,
    });
  } catch (e: any) {
    console.error("[cron/subscription-sweep]", e);
    return NextResponse.json(
      { error: e.message || "Internal server error" },
      { status: 500 },
    );
  }
}
