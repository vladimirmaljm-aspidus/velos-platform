import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase/client";

/**
 * Plan-limit enforcement.
 *
 * Each tenant has a plan (Trial / Starter / Business / Enterprise) with hard
 * caps on max_users, max_partners, max_products, max_monthly_documents.
 * Convention: a value of `0` means ZERO — not "unlimited". Plans that want
 * "unlimited" should use a very large number (e.g. 999999) at seed time.
 *
 * Call `enforceQuota()` inside a POST route BEFORE inserting the row.
 * Returns a NextResponse (402) if the limit is reached; otherwise null.
 */

export type QuotaResource = "users" | "partners" | "products" | "monthly_documents";

interface PlanRow {
  max_users: number | null;
  max_partners: number | null;
  max_products: number | null;
  max_monthly_documents: number | null;
}

interface TenantRow {
  id: string;
  plan: string | null;
  max_users: number | null;
}

async function getPlanForTenant(tenantId: string): Promise<{ tenant: TenantRow; plan: PlanRow | null } | null> {
  const supabase = getSupabase();
  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, plan, max_users")
    .eq("id", tenantId)
    .maybeSingle();
  if (!tenant) return null;

  let plan: PlanRow | null = null;
  if (tenant.plan) {
    // `tenants.plan` stores the plan NAME (e.g. "business"), plans table has a `name` column.
    const { data: p } = await supabase
      .from("plans")
      .select("max_users, max_partners, max_products, max_monthly_documents")
      .ilike("name", tenant.plan)
      .maybeSingle();
    plan = p as PlanRow | null;
  }
  return { tenant, plan };
}

async function countCurrent(tenantId: string, resource: QuotaResource): Promise<number> {
  const supabase = getSupabase();
  if (resource === "monthly_documents") {
    // Sum invoices + proformas + offers created in the current calendar month.
    const startOfMonth = new Date();
    startOfMonth.setUTCDate(1);
    startOfMonth.setUTCHours(0, 0, 0, 0);
    const iso = startOfMonth.toISOString();
    const tables = ["invoices", "proformas", "offers"];
    let total = 0;
    for (const t of tables) {
      const { count } = await supabase
        .from(t)
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .gte("created_at", iso);
      total += count ?? 0;
    }
    return total;
  }
  const table = resource === "users" ? "users" : resource === "partners" ? "partners" : "products";
  const q = supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId);
  if (table === "users") q.eq("active", true);
  const { count } = await q;
  return count ?? 0;
}

/**
 * Return a 402 NextResponse if creating a new `resource` would exceed the
 * tenant's plan limit, or null when the caller may proceed.
 *
 * Super-admins bypass all limits.
 */
export async function enforceQuota(
  tenantId: string | null,
  resource: QuotaResource,
  isSuperAdmin: boolean = false
): Promise<NextResponse | null> {
  if (isSuperAdmin) return null;
  if (!tenantId) {
    return NextResponse.json({ error: "Tenant context is required." }, { status: 400 });
  }

  const info = await getPlanForTenant(tenantId);
  if (!info) {
    return NextResponse.json({ error: "Tenant not found." }, { status: 404 });
  }

  // Resolve the limit — prefer plan row (source of truth). Fall back to
  // tenants.max_users for backward-compat with older records.
  let limit: number | null = null;
  if (info.plan) {
    limit = info.plan[`max_${resource}` as keyof PlanRow] as number | null;
  }
  if (limit == null && resource === "users") limit = info.tenant.max_users;

  // No limit configured → allow (open plan).
  if (limit == null) return null;

  const current = await countCurrent(tenantId, resource);
  if (current >= limit) {
    return NextResponse.json(
      {
        error: `Plan limit reached for ${resource.replace("_", " ")}. Your plan allows ${limit}, currently ${current}. Upgrade your subscription to add more.`,
        limit_reached: true,
        resource,
        limit,
        current,
      },
      { status: 402 }
    );
  }
  return null;
}
