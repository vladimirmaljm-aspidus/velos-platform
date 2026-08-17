import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireSuperAdmin, audit, resolveTenantId } from "@/lib/api/helpers";

export const runtime = "nodejs";

// GET: Any authenticated user can read their own tenant's feature flags
// (needed by sidebar to show/hide modules). Super-admin can pass ?tenant_id=xxx.
// No platform.* permission gate — the response is scoped to the caller's own
// tenant via resolveTenantId, so a tenant user sees only their own flags.
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ flags: {} });
  const flags = await auth.store.getFeatureFlags(tenantId);
  if (!flags) {
    return NextResponse.json({ flags: {} });
  }
  // Return a flat map of boolean flags for easy sidebar consumption
  const flagMap: Record<string, boolean> = {
    module_crm: (flags as any).module_crm ?? true,
    module_trade: (flags as any).module_trade ?? false,
    module_finance: (flags as any).module_finance ?? true,
    module_inventory: (flags as any).module_inventory ?? false,
    module_portal: (flags as any).module_portal ?? false,
    module_logistics: (flags as any).module_logistics ?? false,
    module_kyc: (flags as any).module_kyc ?? false,
    module_document_templates: (flags as any).module_document_templates ?? false,
    module_document_verification: (flags as any).module_document_verification ?? false,
    module_vault: (flags as any).module_vault ?? false,
    module_api_keys: (flags as any).module_api_keys ?? false,
    module_webhooks: (flags as any).module_webhooks ?? false,
    module_mail_queue: (flags as any).module_mail_queue ?? false,
    module_security: (flags as any).module_security ?? false,
  };
  return NextResponse.json({ flags: flagMap, raw: flags });
}

// PUT: Only super-admin can modify feature flags
export async function PUT(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (platform.feature_flags.write)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "platform.feature_flags.write"); if (_d) return _d; } /* requirePermission wired */

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.tenant_id) {
    body.tenant_id = resolveTenantId(auth, req) || undefined;
  }
  if (!body.tenant_id) return NextResponse.json({ error: "tenant_id required." }, { status: 400 });
  body.updated_by = auth.user.id;
  const updated = await auth.store.upsertFeatureFlags(body);
  await audit(auth.store, auth.user, req, "feature_flags.update", "feature_flags", updated.id, { tenant_id: body.tenant_id });
  return NextResponse.json(updated);
}
