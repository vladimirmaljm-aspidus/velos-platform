import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (webhooks.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "webhooks.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_webhooks)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_webhooks", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  // FIX-FUNC-2: resolve tenant via resolveTenantId so super-admins acting
  // under ?tenant_id=xxx (or impersonation) are scoped correctly. The
  // previous `if (!auth.tenantId)` check returned 400 "Tenant context
  // required" for super-admins without an impersonation context because
  // super-admin's own tenantId is null at the platform level.
  const tid = resolveTenantId(auth, req);
  if (!tid) return NextResponse.json({ error: "Tenant context required." }, { status: 400 });
  const items = await auth.store.listWebhooks(tid);
  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (webhooks.create)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "webhooks.create"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_webhooks)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_webhooks", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  // FIX-FUNC-2: resolve tenant via resolveTenantId so super-admins acting
  // under ?tenant_id=xxx (or impersonation) are scoped correctly. See
  // the matching note in GET above.
  const tid = resolveTenantId(auth, req);
  if (!tid) return NextResponse.json({ error: "Tenant context required." }, { status: 400 });
  body.tenant_id = tid;
  const created = await auth.store.upsertWebhook(body);
  await audit(auth.store, auth.user, req, body.id ? "webhook.update" : "webhook.create", "webhook", created.id, { name: created.name });
  return NextResponse.json(created);
}
