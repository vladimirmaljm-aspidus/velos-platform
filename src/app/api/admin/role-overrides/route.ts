import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { invalidateRoleOverridesCache } from "@/lib/permissions/tenant-roles";

export const runtime = "nodejs";

/**
 * Per-tenant role overrides.
 *
 * A "role override" is a custom set of permissions attached to a
 * (tenant_id, role) pair. The platform ships default permissions per
 * role (`role === "admin"` → tenant-scoped grant via `can()`, `user` →
 * explicit grants in `users.permissions`). A tenant on a stricter
 * compliance regime (e.g. finance, healthcare) may want to ADD or
 * SUBTRACT permissions for a specific role without per-user edits —
 * that's what this table is for.
 *
 * Storage: `settings.key = "role_overrides"`, value is a JSON array of
 * RoleOverride rows. Tenant-scoped (per-tenant rows). For platform-level
 * overrides (applies to ALL tenants), use `tenant_id = NULL`.
 */

export interface RoleOverride {
  id: string;
  tenant_id: string | null; // null = platform-wide override
  role: string; // "admin" | "user" | "manager" | custom
  /** "grant" adds the permissions; "deny" removes them (deny wins). */
  mode: "grant" | "deny";
  permissions: string[];
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * GET /api/admin/role-overrides
 *
 * Returns ALL role overrides across ALL tenants (platform-level +
 * tenant-scoped). Super-admin only — exposing this to tenant admins
 * would leak other tenants' security postures.
 *
 * Optional `?tenant_id=xxx` filters to one tenant (plus the platform
 * rows).
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const sb = getSupabase();
    const { data } = await sb
      .from("settings")
      .select("value, tenant_id, updated_at")
      .eq("key", "role_overrides")
      .maybeSingle();

    const overrides: RoleOverride[] = Array.isArray(data?.value)
      ? (data!.value as RoleOverride[])
      : [];

    const url = new URL(req.url);
    const tenantFilter = url.searchParams.get("tenant_id");
    const filtered = tenantFilter
      ? overrides.filter(
          (o) => o.tenant_id === tenantFilter || o.tenant_id === null,
        )
      : overrides;

    return NextResponse.json({ overrides: filtered });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

/**
 * POST /api/admin/role-overrides
 *
 * Create a new role override. Body: { role, mode, permissions, notes,
 * tenant_id? }. Generates `id` + timestamps server-side.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!body?.role || typeof body.role !== "string") {
    return NextResponse.json({ error: "role is required." }, { status: 400 });
  }
  if (body.mode !== "grant" && body.mode !== "deny") {
    return NextResponse.json({ error: "mode must be 'grant' or 'deny'." }, { status: 400 });
  }
  if (!Array.isArray(body.permissions)) {
    return NextResponse.json({ error: "permissions must be an array." }, { status: 400 });
  }

  try {
    const sb = getSupabase();
    const { data } = await sb
      .from("settings")
      .select("id, value, tenant_id")
      .eq("key", "role_overrides")
      .maybeSingle();

    const list: RoleOverride[] = Array.isArray(data?.value)
      ? (data!.value as RoleOverride[])
      : [];

    const newOverride: RoleOverride = {
      id: crypto.randomUUID(),
      tenant_id: body.tenant_id ?? null,
      role: body.role,
      mode: body.mode,
      permissions: body.permissions,
      notes: body.notes ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    list.push(newOverride);

    if (data?.id) {
      const { error } = await sb
        .from("settings")
        .update({ value: list, updated_at: new Date().toISOString() })
        .eq("id", data.id);
      if (error) return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
    } else {
      const { error } = await sb
        .from("settings")
        .insert({
          key: "role_overrides",
          value: list,
          tenant_id: null,
          updated_at: new Date().toISOString(),
        });
      if (error) return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
    }

    await audit(auth.store, auth.user, req, "settings.role_override.create", "settings", "role_overrides", {
      role: newOverride.role,
      mode: newOverride.mode,
      tenant_id: newOverride.tenant_id,
      permission_count: newOverride.permissions.length,
    });

    // FIX-V1: drop the in-process cache so the next request that calls
    // `can()` for this (tenant_id, role) pair sees the new override
    // (within milliseconds — not up to the 5-min TTL).
    invalidateRoleOverridesCache(newOverride.tenant_id, newOverride.role);

    return NextResponse.json({ override: newOverride }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/role-overrides?id=xxx
 *
 * Removes a single override by id.
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  try {
    const sb = getSupabase();
    const { data } = await sb
      .from("settings")
      .select("id, value")
      .eq("key", "role_overrides")
      .maybeSingle();

    const list: RoleOverride[] = Array.isArray(data?.value)
      ? (data!.value as RoleOverride[])
      : [];
    const next = list.filter((o) => o.id !== id);
    if (next.length === list.length) {
      return NextResponse.json({ error: "Override not found." }, { status: 404 });
    }

    // Snapshot the override being deleted so we can drop the matching
    // cache entry below (FIX-V1 — avoids up to 5-min staleness).
    const deleted = list.find((o) => o.id === id);

    if (data?.id) {
      const { error } = await sb
        .from("settings")
        .update({ value: next, updated_at: new Date().toISOString() })
        .eq("id", data.id);
      if (error) return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
    }

    await audit(auth.store, auth.user, req, "settings.role_override.delete", "settings", "role_overrides", {
      override_id: id,
    });

    // FIX-V1: drop the cache entry for the deleted override's (tenant_id,
    // role) pair so the next `can()` for that pair sees the updated diff.
    // If we couldn't determine the pair (data was missing), drop the
    // whole cache — safer to over-invalidate than leave stale grants.
    if (deleted) {
      invalidateRoleOverridesCache(deleted.tenant_id, deleted.role);
    } else {
      invalidateRoleOverridesCache();
    }

    return NextResponse.json({ deleted: id });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
