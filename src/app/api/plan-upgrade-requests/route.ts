import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

/**
 * Tenant users request a plan change. Super-admin reviews the queue,
 * approves (which updates tenants.plan + subscription_end) or rejects.
 * A tenant admin can see only their own tenant's requests; super_admin
 * sees everything.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const sb = getSupabase();
  let q = sb.from("plan_upgrade_requests").select("*", { count: "exact" }).order("created_at", { ascending: false });
  if (!auth.isSuperAdmin) {
    if (!auth.tenantId) return NextResponse.json({ items: [], total: 0 });
    q = q.eq("tenant_id", auth.tenantId);
  } else {
    const url = new URL(req.url);
    const tid = url.searchParams.get("tenant_id");
    if (tid) q = q.eq("tenant_id", tid);
    const status = url.searchParams.get("status");
    if (status) q = q.eq("status", status);
  }
  const { data, count, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data || [], total: count || 0 });
}

// A tenant user (admin or user) submits an upgrade request.
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (!auth.tenantId) return NextResponse.json({ error: "Tenant context required." }, { status: 400 });

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.requested_plan) {
    return NextResponse.json({ error: "requested_plan is required." }, { status: 400 });
  }

  const tenant = await auth.store.getTenant(auth.tenantId) as any;
  const sb = getSupabase();
  const { data, error } = await sb.from("plan_upgrade_requests").insert({
    tenant_id: auth.tenantId,
    requested_by: auth.user.id,
    requested_plan: body.requested_plan,
    current_plan: tenant?.plan || null,
    message: body.message || null,
    status: "pending",
  }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await audit(auth.store, auth.user, req, "plan.upgrade_request", "plan_upgrade_request", (data as any).id, {
    from: tenant?.plan, to: body.requested_plan,
  });
  return NextResponse.json(data);
}
