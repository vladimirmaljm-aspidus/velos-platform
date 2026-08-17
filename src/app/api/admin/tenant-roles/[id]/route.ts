// src/app/api/admin/tenant-roles/[id]/route.ts
// ----------------------------------------------------------------------------
// Per-tenant role override CRUD (P1-1 / Feature 1) — single-row endpoints.
//
//   GET    /api/admin/tenant-roles/[id]  → fetch a single override row.
//   PUT    /api/admin/tenant-roles/[id]  → update an override's
//                                          permissions / is_active.
//   DELETE /api/admin/tenant-roles/[id]  → drop the override row.
//
// Auth rules:
//   • Super_admin: never blocked — can read/edit/delete ANY tenant's
//     override.
//   • Tenant admin (role === "admin"): may manage overrides whose
//     `tenant_id === auth.tenantId`. Other tenants → 403 (returned as
//     404 to avoid leaking the row's existence).
//   • Regular `user`/`viewer`: denied by the catalog permission gate
//     (`tenant-roles.read` / `tenant-roles.update` / `tenant-roles.delete`).
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
 * Load a single override row, enforce tenant ownership for non-super-admin
 * callers, and return it as a TenantRoleOverride. Returns either a
 * NextResponse (for 404 / 403) or the row.
 *
 * The 403-on-cross-tenant case is rewritten as a 404 to avoid disclosing
 * that a row exists in another tenant (defence-in-depth — the audit log
 * still records the attempt).
 */
async function loadOwnedReader(
  auth: Awaited<ReturnType<typeof requireAuth>>,
  id: string,
): Promise<TenantRoleOverride | NextResponse> {
  if (auth instanceof NextResponse) return auth;
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: "Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." },
      { status: 503 },
    );
  }
  const sb = getSupabase();
  const { data, error } = await sb
    .from("tenant_role_overrides")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  // Tenant ownership: super_admin bypasses (never blocked). For everyone
  // else, the row must belong to their own tenant.
  if (!auth.isSuperAdmin && data.tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return {
    id: data.id,
    tenant_id: data.tenant_id,
    role: data.role,
    permissions: Array.isArray(data.permissions) ? data.permissions : [],
    is_active: data.is_active,
    created_at: data.created_at,
    updated_at: data.updated_at,
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  // Permission gate.
  {
    const { requirePermission } = await import("@/lib/permissions/can");
    const denied = requirePermission(auth, "tenant-roles.read");
    if (denied) return denied;
  }

  const { id } = await params;
  const row = await loadOwnedReader(auth, id);
  if (row instanceof NextResponse) return row;
  return NextResponse.json(row);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  // Permission gate.
  {
    const { requirePermission } = await import("@/lib/permissions/can");
    const denied = requirePermission(auth, "tenant-roles.update");
    if (denied) return denied;
  }

  const { id } = await params;
  const row = await loadOwnedReader(auth, id);
  if (row instanceof NextResponse) return row;

  // `row` is now a TenantRoleOverride (TypeScript narrows it).
  const existing: TenantRoleOverride = row;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  // The role/tenant_id are immutable from this route — to change them,
  // DELETE + POST a new row. We only allow editing permissions/is_active.
  const permissions =
    body.permissions !== undefined ? body.permissions : existing.permissions;
  const isActive =
    body.is_active === undefined ? existing.is_active : Boolean(body.is_active);

  // Role guard: tenant admins cannot edit the admin role override.
  if (!auth.isSuperAdmin && existing.role === "admin") {
    return NextResponse.json(
      { error: "Tenant admins cannot customize the admin role override (super-admin only)." },
      { status: 403 },
    );
  }

  // Permission array validation (catalog + platform filter).
  const errors = validateTenantRoleOverride(permissions);
  if (errors.length > 0) {
    return NextResponse.json({ errors }, { status: 400 });
  }

  const sb = getSupabase();
  const { data: updated, error: updErr } = await sb
    .from("tenant_role_overrides")
    .update({
      permissions,
      is_active: isActive,
    })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (updErr) {
    return NextResponse.json({ error: sanitizeError(updErr) }, { status: 500 });
  }

  // Invalidate the cache so the next read sees the new permissions.
  invalidateTenantRolePermissionsCache(existing.tenant_id, existing.role);

  await audit(
    auth.store,
    auth.user,
    req,
    "tenant_role_override.update",
    "tenant_role_override",
    id,
    {
      tenant_id: existing.tenant_id,
      role: existing.role,
      is_active: isActive,
      permissions,
    },
  );

  return NextResponse.json({
    id: updated?.id,
    tenant_id: updated?.tenant_id,
    role: updated?.role,
    permissions: Array.isArray(updated?.permissions) ? updated.permissions : [],
    is_active: updated?.is_active,
    created_at: updated?.created_at,
    updated_at: updated?.updated_at,
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  // Permission gate.
  {
    const { requirePermission } = await import("@/lib/permissions/can");
    const denied = requirePermission(auth, "tenant-roles.delete");
    if (denied) return denied;
  }

  const { id } = await params;
  const row = await loadOwnedReader(auth, id);
  if (row instanceof NextResponse) return row;
  const existing: TenantRoleOverride = row;

  // Role guard: tenant admins cannot delete the admin role override.
  if (!auth.isSuperAdmin && existing.role === "admin") {
    return NextResponse.json(
      { error: "Tenant admins cannot delete the admin role override (super-admin only)." },
      { status: 403 },
    );
  }

  const sb = getSupabase();
  const { error: delErr } = await sb
    .from("tenant_role_overrides")
    .delete()
    .eq("id", id);
  if (delErr) {
    return NextResponse.json({ error: sanitizeError(delErr) }, { status: 500 });
  }

  invalidateTenantRolePermissionsCache(existing.tenant_id, existing.role);

  await audit(
    auth.store,
    auth.user,
    req,
    "tenant_role_override.delete",
    "tenant_role_override",
    id,
    { tenant_id: existing.tenant_id, role: existing.role },
  );

  return NextResponse.json({ ok: true });
}
