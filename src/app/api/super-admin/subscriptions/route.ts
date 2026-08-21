import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

/**
 * GET /api/super-admin/subscriptions
 *
 * Cross-tenant subscription overview for the Platform → Subscriptions view.
 * Returns each tenant with: current plan, status, expiry dates, days remaining,
 * amount paid, billing cycle, and computed warning level.
 */
export async function GET(_req: NextRequest) {
  try {
  const auth = await requireSuperAdmin(_req);
  if (auth instanceof NextResponse) return auth;

  const supabase = getSupabase();
  const { data: tenants, error } = await supabase
    .from("tenants")
    .select("id, name, plan, status, subscription_start, subscription_end, trial_ends_at, billing_cycle, amount_paid, currency_paid, max_users")
    .order("name", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const now = new Date();
  const items = (tenants || []).map((t: any) => {
    const subEnd = t.subscription_end ? new Date(t.subscription_end) : null;
    const trialEnd = t.trial_ends_at ? new Date(t.trial_ends_at) : null;
    const isTrial = t.status === "trial";
    const relevantEnd = isTrial ? trialEnd : subEnd;
    const daysRemaining = relevantEnd
      ? Math.ceil((relevantEnd.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
      : null;
    const isExpired = relevantEnd ? relevantEnd < now : false;
    let warningLevel: "none" | "warning" | "critical" | "expired" = "none";
    if (isExpired) warningLevel = "expired";
    else if (daysRemaining !== null && daysRemaining <= 3) warningLevel = "critical";
    else if (daysRemaining !== null && daysRemaining <= 7) warningLevel = "warning";

    return {
      id: t.id,
      name: t.name,
      plan: t.plan,
      status: t.status,
      is_trial: isTrial,
      is_expired: isExpired,
      subscription_start: t.subscription_start,
      subscription_end: t.subscription_end,
      trial_ends_at: t.trial_ends_at,
      days_remaining: daysRemaining,
      billing_cycle: t.billing_cycle || null,
      amount_paid: Number(t.amount_paid) || 0,
      currency_paid: t.currency_paid || t.currency || "EUR",
      max_users: t.max_users,
      warning_level: warningLevel,
    };
  });

  const totals = {
    total_tenants: items.length,
    active: items.filter((i) => i.status === "active").length,
    trial: items.filter((i) => i.is_trial).length,
    suspended: items.filter((i) => i.status === "suspended").length,
    expired: items.filter((i) => i.is_expired).length,
    expiring_within_7d: items.filter((i) => !i.is_expired && (i.days_remaining ?? 999) <= 7).length,
    monthly_recurring_revenue: items
      .filter((i) => i.status === "active" && i.billing_cycle === "monthly")
      .reduce((sum, i) => sum + i.amount_paid, 0),
  };

  return NextResponse.json({ items, totals });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
