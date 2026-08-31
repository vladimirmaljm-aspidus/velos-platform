import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, requireAuthOrApiKey, requireAuthOrApiKeyPermission, resolveTenantId, audit, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

// GET /api/erp/settings — Get ERP settings
export async function GET(req: NextRequest) {
  const auth = await requireAuthOrApiKey(req);
  if (auth instanceof NextResponse) return auth;
  // U-FIX (RBAC audit D-1): gate BOTH session AND API-key callers.
  // ERP settings expose accounting standard, default currency, fiscal
  // year — sensitive financial configuration. Previously any API key
  // could read these.
  const denied = requireAuthOrApiKeyPermission(auth, "erp.read");
  if (denied) return denied;
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_finance", _isSA); if (_f) return _f; } /* requireFeature wired */


  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ items: [], total: 0 });

  try {
    const settings = await auth.store.getErpSettings(tenantId);
    if (!settings) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json(settings);
  } catch (e: any) {
    console.error("[erp/settings GET]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

// POST /api/erp/settings — Create/update ERP settings (requires admin)
export async function POST(req: NextRequest) {
  const auth = await requireAuthOrApiKey(req);
  if (auth instanceof NextResponse) return auth;
  // U-FIX (RBAC audit D-1): gate BOTH session AND API-key callers.
  // This is the most severe bypass of the 9: POST MUTATES ERP
  // settings (accounting standard, default currency, fiscal year).
  // Previously any API key — even one created with `permissions: []`
  // — could rewrite a tenant's accounting configuration. API-key
  // callers MUST now hold `erp:manage_settings` (or `*`).
  const denied = requireAuthOrApiKeyPermission(auth, "erp.manage_settings");
  if (denied) return denied;
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_finance", _isSA); if (_f) return _f; } /* requireFeature wired */

  // Defense-in-depth: for session auth, ALSO require admin role (the
  // catalog permission alone is insufficient because a non-admin user
  // could in principle be granted erp.manage_settings — that grant is
  // honored by `can()`, but the route historically required admin
  // role on top. Keep that belt-and-suspenders check for session
  // callers; the API-key path is gated by the helper above.)
  if (!("apiKeyId" in auth) && !auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }

  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) {
    return NextResponse.json({ error: "Tenant ID required." }, { status: 400 });
  }

  try {
    const body = await req.json();
    const upserted = await auth.store.upsertErpSettings({ ...body, tenant_id: tenantId });
    await audit(auth.store, "user" in auth ? auth.user : { id: auth.apiKeyId, username: auth.apiKeyName, tenant_id: auth.tenantId }, req, "erp_settings.update", "erp_setting", upserted.id, {
      accounting_standard: upserted.accounting_standard,
      default_currency: upserted.default_currency,
    });
    return NextResponse.json(upserted);
  } catch (e: any) {
    console.error("[erp/settings POST]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
