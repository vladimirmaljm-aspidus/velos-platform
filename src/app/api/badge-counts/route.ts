import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId } from "@/lib/api/helpers";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";
import { unreadCountForTenant } from "@/lib/portal/messages";

export const runtime = "nodejs";

/**
 * GET /api/badge-counts
 *
 * Single batched endpoint the sidebar polls to drive the small numeric
 * badges next to module names (e.g. "KYC Review (3)"). Every count here is
 * a cheap `head: true` count query — no rows are fetched.
 *
 * Returns 0 for any module whose feature flag is off — cheaper than the
 * client tracking that itself, and avoids a badge appearing for a module
 * the tenant can't even see.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const tenantId = resolveTenantId(auth, req);
  const isSuperAdmin = auth.user.role === "super_admin";

  // Super_admins without a tenant context still need the signup_requests
  // badge count (platform-wide metric, not tenant-scoped).
  if (!tenantId && !isSuperAdmin) {
    return NextResponse.json({
      kyc_review: 0,
      portal_rfqs: 0,
      logistics_requests: 0,
      notifications: 0,
      tasks: 0,
      portal_messages: 0,
      signup_requests: 0,
    });
  }

  // AUDIT18 (live E2E finding): store-backed path for self-hosted /
  // DB_BACKEND=prisma deployments where SUPABASE_URL is unset. Previously
  // this route 500'd on every sidebar poll (getSupabase() hard-throws).
  // Counts degrade to 0 for entities without a store abstraction
  // (logistics_requests, portal_messages) — badges are cosmetic, a 500 is
  // not. Supabase deployments keep the exact original query path below.
  if (!isSupabaseConfigured()) {
    const [kyc, rfqs, tasks, notifs, tenants] = await Promise.all([
      auth.store.listKycSubmissions(tenantId ?? "", { filters: { status: "submitted" } }).catch(() => ({ total: 0 })),
      tenantId ? auth.store.listPortalRfqs(tenantId, { filters: { status: "pending" } }).catch(() => ({ total: 0 })) : Promise.resolve({ total: 0 }),
      auth.store.listTasks(tenantId ?? "", auth.user.id).catch(() => [] as never[]),
      tenantId && auth.user.id ? auth.store.getUnreadCount(tenantId, auth.user.id).catch(() => 0) : Promise.resolve(0),
      isSuperAdmin ? auth.store.listTenants().catch(() => [] as never[]) : Promise.resolve([] as never[]),
    ]);
    return NextResponse.json({
      kyc_review: kyc.total ?? 0,
      portal_rfqs: rfqs.total ?? 0,
      logistics_requests: 0,
      notifications: notifs ?? 0,
      tasks: Array.isArray(tasks) ? tasks.filter((t) => !t.done).length : 0,
      portal_messages: 0,
      signup_requests: Array.isArray(tenants) ? tenants.filter((t) => (t as { status?: string }).status === "pending_approval").length : 0,
    });
  }

  const sb = getSupabase();

  // Super_admin signup-request count (pending_approval tenants).
  const signupCount = isSuperAdmin
    ? sb.from("tenants").select("id", { count: "exact", head: true })
        .eq("status", "pending_approval")
    : Promise.resolve({ count: 0 });

  // Super_admin without tenant context: return just the signup count.
  if (!tenantId) {
    const sr = await signupCount;
    return NextResponse.json({
      kyc_review: 0,
      portal_rfqs: 0,
      logistics_requests: 0,
      notifications: 0,
      tasks: 0,
      portal_messages: 0,
      signup_requests: sr.count || 0,
    });
  }

  const [
    kycRes,
    rfqRes,
    logisticsRes,
    unreadNotifCount,
    tasksRes,
    messagesCount,
  ] = await Promise.all([
    sb.from("kyc_submissions").select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId).eq("status", "submitted"),
    sb.from("portal_rfqs").select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId).eq("status", "pending"),
    sb.from("logistics_requests").select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId).eq("status", "pending"),
    auth.store.getUnreadCount(tenantId, auth.user.id).catch(() => 0),
    sb.from("user_tasks").select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId).eq("user_id", auth.user.id).eq("done", false),
    unreadCountForTenant(tenantId).catch(() => 0),
  ]);

  return NextResponse.json({
    kyc_review: kycRes.count || 0,
    portal_rfqs: rfqRes.count || 0,
    logistics_requests: logisticsRes.count || 0,
    notifications: unreadNotifCount || 0,
    tasks: tasksRes.count || 0,
    portal_messages: messagesCount || 0,
    signup_requests: (await signupCount).count || 0,
  });
}
