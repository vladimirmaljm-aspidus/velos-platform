import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit, sanitizeError } from "@/lib/api/helpers";
import {
  getMarketplaceTenantSettings,
  upsertMarketplaceTenantSettings,
} from "@/lib/data/marketplace-store";
import { MARKETPLACE_POSTING_POLICIES } from "@/lib/portal/marketplace-gate";
import { withApm } from "@/lib/monitoring/apm";
import { requirePermission } from "@/lib/permissions/can";

export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/marketplace/tenant-settings[?tenant_id=]
//
// Reads one tenant's marketplace policy. Super admins may read ANY tenant
// (?tenant_id=…, default: cross-tenant summary list); tenant admins read
// their OWN tenant (the ?tenant_id override is ignored for them).
//
// Auth: super_admin OR tenant admin holding `marketplace.settings`.
// ─────────────────────────────────────────────────────────────────────────────
async function _get(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  {
    const _d = requirePermission(auth, "marketplace.settings");
    if (_d) return _d;
  }
  const tenantId = auth.isSuperAdmin
    ? resolveTenantId(auth, req) || undefined
    : auth.tenantId!;

  try {
    if (!tenantId) {
      // Super-admin cross-tenant summary: settings for every tenant that
      // has a row (plus tenant names for the grid).
      const { getSupabase } = await import("@/lib/supabase/client");
      const sb = getSupabase();
      const { data: rows, error } = await sb
        .from("marketplace_tenant_settings")
        .select("*")
        .order("tenant_id");
      if (error) throw error;
      const tenantIds = ((rows as any[]) || []).map((r) => r.tenant_id);
      let namesByTenant: Record<string, string> = {};
      if (tenantIds.length > 0) {
        const { data: tenants } = await sb
          .from("tenants")
          .select("id, name")
          .in("id", tenantIds);
        namesByTenant = Object.fromEntries(
          ((tenants as { id: string; name: string }[]) || []).map((t) => [t.id, t.name]),
        );
      }
      return NextResponse.json({
        items: ((rows as any[]) || []).map((r) => ({
          ...r,
          tenant_name: namesByTenant[r.tenant_id] ?? r.tenant_id,
        })),
      });
    }
    const settings = await getMarketplaceTenantSettings(tenantId);
    return NextResponse.json({ settings });
  } catch (e: any) {
    console.error("[admin.marketplace.tenant-settings] GET failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/admin/marketplace/tenant-settings
//
// Upserts one tenant's marketplace policy (migration 099):
//   body: { tenant_id, enabled?, posting_policy?, require_approval?,
//           public_feed_enabled?, default_visibility?, allow_private_posts? }
//
// • super_admin  — any tenant (tenant_id required in body).
// • tenant admin — ONLY their own tenant (a body tenant_id that is not
//                  their own is rejected with 403).
//
// Every change writes an audit_logs row (who changed which knob).
// Auth: `marketplace.settings` permission.
// ─────────────────────────────────────────────────────────────────────────────
async function _put(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  {
    const _d = requirePermission(auth, "marketplace.settings");
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
      { error: "Tenant admins may only change their own tenant's marketplace settings." },
      { status: 403 },
    );
  }

  // Validate the patch (only known knobs, typed).
  const patch: Record<string, unknown> = {};
  const boolKnobs = ["enabled", "require_approval", "public_feed_enabled", "allow_private_posts"];
  for (const knob of boolKnobs) {
    if (body?.[knob] !== undefined) {
      if (typeof body[knob] !== "boolean") {
        return NextResponse.json({ error: `${knob} must be a boolean.` }, { status: 400 });
      }
      patch[knob] = body[knob];
    }
  }
  if (body?.posting_policy !== undefined) {
    if (!(MARKETPLACE_POSTING_POLICIES as readonly string[]).includes(body.posting_policy)) {
      return NextResponse.json(
        { error: `posting_policy must be one of: ${MARKETPLACE_POSTING_POLICIES.join(", ")}.` },
        { status: 400 },
      );
    }
    patch.posting_policy = body.posting_policy;
  }
  if (body?.default_visibility !== undefined) {
    if (!["public", "private"].includes(body.default_visibility)) {
      return NextResponse.json({ error: "default_visibility must be public or private." }, { status: 400 });
    }
    patch.default_visibility = body.default_visibility;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No settings to update." }, { status: 400 });
  }

  try {
    const before = await getMarketplaceTenantSettings(tenantId);
    const settings = await upsertMarketplaceTenantSettings({
      tenant_id: tenantId,
      ...patch,
      updated_by: auth.user?.username ?? null,
    } as never);
    try {
      await audit(
        auth.store,
        auth.user,
        req,
        "marketplace.tenant_settings_updated",
        "marketplace_tenant_settings",
        tenantId,
        {
          tenant_id: tenantId,
          changes: patch,
          before: {
            enabled: before.enabled,
            posting_policy: before.posting_policy,
            require_approval: before.require_approval,
            public_feed_enabled: before.public_feed_enabled,
            default_visibility: before.default_visibility,
            allow_private_posts: before.allow_private_posts,
          },
          admin: auth.user?.username,
        },
      );
    } catch (e) {
      console.error("[admin.marketplace.tenant-settings] audit failed:", e);
    }
    return NextResponse.json({ settings });
  } catch (e: any) {
    console.error("[admin.marketplace.tenant-settings] PUT failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/admin/marketplace/tenant-settings");
export const PUT = withApm(_put, "PUT /api/admin/marketplace/tenant-settings");
