import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * GET /api/super-admin/signup-requests
 *
 * FEAT-1 (Trial approval system): lists every tenant in
 * `pending_approval` status — i.e. self-registered signups waiting for
 * a super_admin to approve or reject them. Each row carries the
 * requesting admin user's contact info (name, email, phone) so the
 * reviewer can sanity-check who's asking for access.
 *
 * The list is sourced by joining `listTenants()` (filter
 * `status === "pending_approval"`) with `listUsers("")` (filter
 * `tenant_id === pending_tenant.id && role === "admin"`) — the store
 * interface doesn't expose a per-tenant user list, but a single
 * `listUsers("")` call returns every user across every tenant, so we
 * join in-memory. The pending-approval volume is expected to be low
 * (tens at most per platform), so an in-memory join is fine — no need
 * for a SQL JOIN RPC.
 *
 * Returns `{ items: Array<SignupRequest> }` sorted newest-first.
 */
export interface SignupRequest {
  id: string; // tenant id
  company_name: string;
  contact_name: string;
  email: string;
  phone: string | null;
  country: string | null;
  plan: string;
  requested_at: string; // tenant.created_at
  currency: string | null;
}

export async function GET(_req: NextRequest) {
  try {
    const auth = await requireSuperAdmin();
    if (auth instanceof NextResponse) return auth;

    // Parallel fetch — listTenants + listUsers are independent.
    const [tenants, users] = await Promise.all([
      auth.store.listTenants(),
      auth.store.listUsers(""),
    ]);

    // Index admin users by tenant_id so the join is O(N+M) not O(N*M).
    // A self-registered trial tenant has exactly one admin user (the
    // one created by /api/auth/register), so Map<tenantId, user> is
    // the right shape. (If a super_admin manually creates more users
    // on a pending tenant before approval — edge case — we just take
    // the first admin.)
    const adminByTenant = new Map<string, (typeof users)[number]>();
    for (const u of users) {
      if (u.role === "admin" && u.tenant_id) {
        if (!adminByTenant.has(u.tenant_id)) adminByTenant.set(u.tenant_id, u);
      }
    }

    const items: SignupRequest[] = tenants
      .filter((t) => (t as { status?: string }).status === "pending_approval")
      .map((t) => {
        const admin = adminByTenant.get(t.id);
        return {
          id: t.id,
          company_name: t.name,
          contact_name: admin?.full_name || admin?.username || "—",
          email: admin?.email || t.email || "",
          phone: t.phone ?? null,
          country: t.country,
          plan: t.plan,
          requested_at: t.created_at,
          currency: t.currency,
        };
      })
      .sort(
        (a, b) =>
          new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime(),
      );

    return NextResponse.json({ items });
  } catch (e: any) {
    console.error("[signup-requests.list]", e);
    return NextResponse.json(
      { error: e?.message || "Internal server error" },
      { status: 500 },
    );
  }
}
