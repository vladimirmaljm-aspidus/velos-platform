import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * GET /api/super-admin/health
 * Platform health snapshot: DB status, tenant/user/subscription counts,
 * expiring subscriptions, permission-consistency issues, suspended tenants.
 */
export async function GET() {
  const auth = await requireSuperAdmin();
  if (auth instanceof NextResponse) return auth;

  const now = Date.now();
  const in7d = now + 7 * 24 * 60 * 60 * 1000;

  let db_status: "ok" | "error" = "ok";
  let tenants: any[] = [];
  let users: any[] = [];
  try {
    tenants = await auth.store.listTenants();
    users = await auth.store.listUsers("");
  } catch (e) {
    db_status = "error";
  }

  const active_subs = tenants.filter((t) => t.status === "active").length;
  const suspended = tenants.filter((t) => t.status === "suspended" || t.status === "cancelled").length;

  const expiring = tenants.filter((t) => {
    const end = (t as any).subscription_end;
    if (!end) return false;
    const ts = new Date(end).getTime();
    return ts > now && ts <= in7d;
  }).length;

  // Permission consistency: users whose permissions reference a module the
  // tenant's plan does not include. We can't fully compute plan.included_modules
  // without a plans lookup — flag any user with permissions that are non-empty
  // while their tenant has status !== active, as a first heuristic.
  const consistency_issues = users.filter((u: any) => {
    if (!u.tenant_id) return false;
    const tenant = tenants.find((t) => t.id === u.tenant_id);
    if (!tenant) return true;
    if (tenant.status === "suspended" && Array.isArray(u.permissions) && u.permissions.length > 0) return true;
    return false;
  }).length;

  return NextResponse.json({
    db_status,
    tenant_count: tenants.length,
    user_count: users.length,
    active_subscriptions: active_subs,
    suspended_tenants: suspended,
    expiring_within_7d: expiring,
    permission_consistency_issues: consistency_issues,
    generated_at: new Date().toISOString(),
  });
}
