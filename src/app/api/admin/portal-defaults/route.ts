import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import {
  getTenantPortalDefaults,
  invalidateTenantPortalDefaults,
  PORTAL_MODULE_KEYS,
} from "@/lib/portal/module-permissions";
import { withApm } from "@/lib/monitoring/apm";
import { requirePermission } from "@/lib/permissions/can";

export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/portal-defaults[?tenant_id=]
//
// Per-tenant portal module defaults (tenant_portal_defaults, migration 099)
// — the baseline applied to every portal user of the tenant who has no
// explicit per-user override. Super admins read any tenant; tenant admins
// read their own.
//
// Auth: `portal.manage` permission.
// ─────────────────────────────────────────────────────────────────────────────
async function _get(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  {
    const _d = requirePermission(auth, "portal.manage");
    if (_d) return _d;
  }
  const url = new URL(req.url);
  const tenantId = auth.isSuperAdmin
    ? url.searchParams.get("tenant_id") || undefined
    : auth.tenantId!;

  try {
    if (!tenantId) {
      // Super-admin cross-tenant summary.
      const sb = getSupabase();
      const { data: rows, error } = await sb
        .from("tenant_portal_defaults")
        .select("*")
        .order("tenant_id");
      if (error) throw error;
      return NextResponse.json({ items: (rows as any[]) || [] });
    }
    const modules = await getTenantPortalDefaults(tenantId);
    return NextResponse.json({ modules });
  } catch (e: any) {
    console.error("[admin.portal-defaults] GET failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/admin/portal-defaults
//
// Upserts the per-tenant module defaults.
//   body: { tenant_id?, modules: Record<string, boolean> | null }
//
// • super_admin  — any tenant (tenant_id required in body for super admins).
// • tenant admin — only their own tenant (body tenant_id must match).
// • `modules: null` clears the row → every module returns to its default
//   (legacy booleans / open).
//
// Auth: `portal.manage` permission. Audited.
// ─────────────────────────────────────────────────────────────────────────────
async function _put(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  {
    const _d = requirePermission(auth, "portal.manage");
    if (_d) return _d;
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const tenantId = auth.isSuperAdmin ? String(body?.tenant_id || "") : auth.tenantId!;
  if (!tenantId) {
    return NextResponse.json(
      { error: "tenant_id is required for super-admin writes." },
      { status: 400 },
    );
  }
  if (!auth.isSuperAdmin && body?.tenant_id && body.tenant_id !== auth.tenantId) {
    return NextResponse.json(
      { error: "Tenant admins may only change their own tenant's defaults." },
      { status: 403 },
    );
  }

  // Sanitise the modules map: known keys + booleans only.
  let modules: Record<string, boolean> | null = null;
  if (body?.modules !== null && body?.modules !== undefined) {
    if (typeof body.modules !== "object" || Array.isArray(body.modules)) {
      return NextResponse.json({ error: "modules must be an object or null." }, { status: 400 });
    }
    modules = {};
    for (const [k, v] of Object.entries(body.modules as Record<string, unknown>)) {
      if (PORTAL_MODULE_KEYS.has(k) && typeof v === "boolean") modules[k] = v;
    }
  }

  try {
    const sb = getSupabase();
    if (modules === null) {
      const { error } = await sb
        .from("tenant_portal_defaults")
        .delete()
        .eq("tenant_id", tenantId);
      if (error) throw error;
    } else {
      const { error } = await sb
        .from("tenant_portal_defaults")
        .upsert(
          {
            tenant_id: tenantId,
            modules,
            updated_by: auth.user?.username ?? null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "tenant_id" },
        );
      if (error) throw error;
    }
    invalidateTenantPortalDefaults(tenantId);
    try {
      await audit(
        auth.store,
        auth.user,
        req,
        "portal.module_defaults_updated",
        "tenant_portal_defaults",
        tenantId,
        { tenant_id: tenantId, modules, admin: auth.user?.username },
      );
    } catch (e) {
      console.error("[admin.portal-defaults] audit failed:", e);
    }
    const fresh = await getTenantPortalDefaults(tenantId);
    return NextResponse.json({ modules: fresh });
  } catch (e: any) {
    console.error("[admin.portal-defaults] PUT failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/admin/portal-defaults");
export const PUT = withApm(_put, "PUT /api/admin/portal-defaults");
