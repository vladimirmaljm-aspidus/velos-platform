import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireSuperAdmin, audit, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function GET() {
  try {
    // Super-admin sees all tenants; regular admin sees only their own tenant.
    // No platform.* gate — non-super-admins are already limited to their own
    // tenant below, and many client views (impersonation banner, tenant
    // switcher, portal-uploads folder headers) need this endpoint to work
    // for any signed-in user.
    const auth = await requireAuth();
    if (auth instanceof NextResponse) return auth;

    if (auth.isSuperAdmin) {
      const tenants = await auth.store.listTenants();
      return NextResponse.json({ items: tenants });
    }
    // Regular admin/user: return only their own tenant
    if (auth.tenantId) {
      const tenant = await auth.store.getTenant(auth.tenantId);
      return NextResponse.json({ items: tenant ? [tenant] : [] });
    }
    return NextResponse.json({ items: [] });
  } catch (error: any) {
    console.error("[tenants GET]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireSuperAdmin(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (platform.tenants.write)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "platform.tenants.write"); if (_d) return _d; } /* requirePermission wired */

    const body = await req.json();
    // Auto-compute trial_ends_at when creating a fresh trial tenant so the
    // countdown starts today. Skip if the super_admin explicitly set a date
    // or if trial_days=0 (opting the tenant out of trial entirely).
    if (!body.id) {
      const isTrial = body.plan === "trial" || body.status === "trial" || (!body.plan && !body.status);
      const days = Number(body.trial_days ?? 10);
      if (isTrial && days > 0 && !body.trial_ends_at) {
        const end = new Date();
        end.setDate(end.getDate() + days);
        body.trial_ends_at = end.toISOString();
        if (!body.status) body.status = "trial";
        if (!body.plan) body.plan = "trial";
      }
    }
    const created = await auth.store.upsertTenant(body);
    await audit(auth.store, auth.user, req, body.id ? "tenant.update" : "tenant.create", "tenant", created.id, { name: created.name });
    return NextResponse.json(created);
  } catch (error: any) {
    console.error("[tenants POST]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
