import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// AUDIT19 / F7 — column whitelist for plan writes (mass-assignment guard).
// These were the only two routes in the codebase passing the raw request
// body straight to PostgREST/Prisma: a platform:plans grantee could set
// ANY column (id, created_at, unknown columns → raw 500s). Mirror the
// offers/proformas/invoices whitelists: business columns only; identity +
// timestamps are owned by the DB.
const PLAN_FIELDS = new Set([
  "name", "description", "price_monthly", "price_yearly", "currency",
  "max_users", "max_partners", "max_monthly_documents", "max_products",
  "storage_mb", "trial_days", "included_modules", "custom_branding",
  "api_access", "priority_support", "white_label", "is_active",
  "is_public", "sort_order",
]);
function whitelistPlanFields(body: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (PLAN_FIELDS.has(key)) result[key] = value;
  }
  return result;
}

export async function GET(_req: NextRequest) {
  try {
    // Any authenticated user (including tenant users on trial) needs to see
    // the public plan catalog so they can pick an upgrade. Non-public plans
    // and admin-only plans stay hidden for anyone who isn't super_admin.
    const auth = await requireAuth(_req);
    if (auth instanceof NextResponse) return auth;

    if (isSupabaseConfigured()) {
      const sb = getSupabase();
      let q = sb.from("plans").select("*").eq("is_active", true).order("sort_order", { ascending: true });
      if (!auth.isSuperAdmin) q = q.eq("is_public", true);
      const { data, error } = await q;
      if (error) throw error;
      return NextResponse.json({ items: data || [] });
    }
    const plans = await db.plan.findMany({
      where: auth.isSuperAdmin ? { is_active: true } : { is_active: true, is_public: true },
      orderBy: { sort_order: "asc" },
    });
    return NextResponse.json({ items: plans });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (platform.plans.write)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "platform.plans.write"); if (_d) return _d; } /* requirePermission wired */

    if (!auth.isSuperAdmin) return NextResponse.json({ error: "Super-admin access required." }, { status: 403 });
    const body = await req.json();
    // AUDIT19 / F7 — whitelist + require the name (plans are keyed by name).
    const safeBody = whitelistPlanFields(body as Record<string, unknown>);
    if (!safeBody.name || typeof safeBody.name !== "string") {
      return NextResponse.json({ error: "Plan name is required." }, { status: 400 });
    }
    if (isSupabaseConfigured()) {
      const sb = getSupabase();
      const { data, error } = await sb.from("plans").insert(safeBody).select().single();
      if (error) throw error;
      await audit(auth.store, auth.user, req, "plan.create", "plan", data.id, { name: data.name });
      return NextResponse.json(data);
    }
    const created = await db.plan.create({ data: safeBody as any });
    await audit(auth.store, auth.user, req, "plan.create", "plan", created.id, { name: created.name });
    return NextResponse.json(created);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}
