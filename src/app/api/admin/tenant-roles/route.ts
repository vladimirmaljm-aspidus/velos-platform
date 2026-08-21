// src/app/api/admin/tenant-roles/route.ts
// ----------------------------------------------------------------------------
// Per-tenant role customization API (P1-1 / Feature 1).
//
//   GET    /api/admin/tenant-roles?tenant_id=<uuid>
//          → list all overrides for the given tenant.
//            Super_admin: required ?tenant_id=... query.
//            Tenant admin: optional ?tenant_id=... — defaults to own.
//
//   POST   /api/admin/tenant-roles
//          Body: { tenant_id, role, permissions, is_active? }
//          → upsert the (tenant_id, role) override.
//            Super_admin: may upsert ANY tenant's override.
//            Tenant admin: may upsert ONLY own tenant's override.
//
// Rules
//   • Super_admin is NEVER blocked — they can read / edit / delete any
//     tenant's overrides.
//   • Tenant admins (role === "admin") can manage their OWN tenant's
//     overrides only (the route returns 403 if the body's `tenant_id`
//     does not match `auth.tenantId`).
//   • Regular `user`/`viewer` roles are denied via the `tenant-roles.*`
//     catalog permissions (which only `super_admin` and tenant `admin`
//     roles effectively have).
//   • Platform perms (`platform.*`) are forbidden inside any override's
//     `permissions` array — `validateTenantRoleOverride()` rejects them.
// ----------------------------------------------------------------------------

import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";
import {
  validateTenantRoleOverride,
  invalidateTenantRolePermissionsCache,
  type TenantRoleOverride,
} from "@/lib/permissions/tenant-roles";

export const runtime = "nodejs";

/**
 * GET /api/admin/tenant-roles?tenant_id=<uuid>
 *
 * Returns `{ items: TenantRoleOverride[] }` for the resolved tenant.
 * Super_admin must pass `?tenant_id=...` explicitly (their own
 * tenant_id is null). Tenant admins omit it (defaults to their own).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  // Permission gate (catalog).
  {
    const { requirePermission } = await import("@/lib/permissions/can");
    const denied = requirePermission(auth, "tenant-roles.read");
    if (denied) return denied;
  }

  // Resolve tenant: super_admin passes ?tenant_id=... explicitly;
  // tenant admins are locked to their own tenant.
  const url = new URL(req.url);
  const queryTenantId = url.searchParams.get("tenant_id");
  let tenantId: string | null;
  if (auth.isSuperAdmin) {
    tenantId = queryTenantId;
    if (!tenantId) {
      return NextResponse.json(
        { error: "Super-admin must pass ?tenant_id=<uuid>." },
        { status: 400 },
      );
    }
  } else {
    // Tenant admin can only read their own tenant.
    tenantId = queryTenantId || auth.tenantId;
    if (!tenantId || tenantId !== auth.tenantId) {
      return NextResponse.json(
        { error: "Not allowed to read overrides for another tenant." },
        { status: 403 },
      );
    }
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ items: [] });
  }

  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("tenant_role_overrides")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("role", { ascending: true });
    if (error) {
      return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
    }
    const items: TenantRoleOverride[] = (data || []).map((r: any) => ({
      id: r.id,
      tenant_id: r.tenant_id,
      role: r.role,
      permissions: Array.isArray(r.permissions) ? r.permissions : [],
      is_active: r.is_active,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

/**
 * POST /api/admin/tenant-roles
 *
 * Body: { tenant_id: string, role: string, permissions: string[], is_active?: boolean }
 *
 * Upserts the (tenant_id, role) override. Returns the persisted row.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  // Permission gate (catalog).
  {
    const { requirePermission } = await import("@/lib/permissions/can");
    const denied = requirePermission(auth, "tenant-roles.update");
    if (denied) return denied;
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const tenantId = typeof body.tenant_id === "string" ? body.tenant_id : null;
  const role = typeof body.role === "string" ? body.role.trim() : "";
  const permissions = body.permissions;
  const isActive = body.is_active === undefined ? true : Boolean(body.is_active);

  // ── Basic shape validation ──────────────────────────────────────────
  if (!tenantId) {
    return NextResponse.json({ error: "tenant_id is required." }, { status: 400 });
  }
  if (!role) {
    return NextResponse.json({ error: "role is required." }, { status: 400 });
  }

  // ── Role guard: super_admin overrides are forbidden ─────────────────
  // The override system is per-tenant — super_admin is platform-level
  // and bypasses all checks anyway. Storing an override for super_admin
  // would be misleading (it would never take effect).
  if (role === "super_admin") {
    return NextResponse.json(
      { error: "Cannot create a per-tenant override for the super_admin role (super_admin bypasses all checks)." },
      { status: 400 },
    );
  }

  // ── Tenant ownership: tenant admins may only manage their own ──────
  if (!auth.isSuperAdmin) {
    if (tenantId !== auth.tenantId) {
      return NextResponse.json(
        { error: "Not allowed to manage overrides for another tenant." },
        { status: 403 },
      );
    }
    // Tenant admins also cannot create overrides for the "admin" role
    // (that would let an admin escalate themselves by adding platform
    // perms via the override). They may only customize non-admin roles.
    if (role === "admin") {
      return NextResponse.json(
        { error: "Tenant admins cannot customize the admin role override (super-admin only)." },
        { status: 403 },
      );
    }
  }

  // ── Permission array validation (catalog + platform filter) ──────────
  const errors = validateTenantRoleOverride(permissions);
  if (errors.length > 0) {
    return NextResponse.json({ errors }, { status: 400 });
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: "Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." },
      { status: 503 },
    );
  }

  try {
    const sb = getSupabase();
    // Upsert by (tenant_id, role) — the UNIQUE constraint on those two
    // columns means an existing row will collide on insert. We first try
    // a SELECT; if found, UPDATE; else INSERT. This is the same pattern
    // the rate-limits settings route uses.
    const { data: existing, error: selErr } = await sb
      .from("tenant_role_overrides")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("role", role)
      .maybeSingle();
    if (selErr) {
      return NextResponse.json({ error: sanitizeError(selErr) }, { status: 500 });
    }

    let row: any;
    if (existing) {
      const { data: updated, error: updErr } = await sb
        .from("tenant_role_overrides")
        .update({
          permissions,
          is_active: isActive,
        })
        .eq("id", existing.id)
        .select("*")
        .maybeSingle();
      if (updErr) {
        return NextResponse.json({ error: sanitizeError(updErr) }, { status: 500 });
      }
      row = updated;
    } else {
      const { data: inserted, error: insErr } = await sb
        .from("tenant_role_overrides")
        .insert({
          tenant_id: tenantId,
          role,
          permissions,
          is_active: isActive,
        })
        .select("*")
        .maybeSingle();
      if (insErr) {
        return NextResponse.json({ error: sanitizeError(insErr) }, { status: 500 });
      }
      row = inserted;
    }

    // Drop the cache for this (tenant_id, role) so the next read sees
    // the new permissions.
    invalidateTenantRolePermissionsCache(tenantId, role);

    await audit(
      auth.store,
      auth.user,
      req,
      "tenant_role_override.upsert",
      "tenant_role_override",
      row?.id,
      { tenant_id: tenantId, role, is_active: isActive, permissions },
    );

    return NextResponse.json({
      id: row?.id,
      tenant_id: row?.tenant_id,
      role: row?.role,
      permissions: Array.isArray(row?.permissions) ? row.permissions : [],
      is_active: row?.is_active,
      created_at: row?.created_at,
      updated_at: row?.updated_at,
    });
  } catch (e) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
