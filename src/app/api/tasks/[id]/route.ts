import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import type { UserTask } from "@/lib/supabase/types";

export const runtime = "nodejs";

/**
 * Fetch a single task by id, scoped to the caller's tenant.
 *
 * Replaces the old pattern of `listTasks(tenantId)` + `.find(t => t.id === id)`
 * which loaded every task in the tenant on every PUT/DELETE (API P1 #15).
 * Returns `null` when the task doesn't exist or belongs to another tenant.
 * Super-admins without a tenant_id get `null` (they have no tenant scope).
 */
async function fetchTaskForTenant(id: string, tenantId: string | null): Promise<UserTask | null> {
  if (!tenantId) return null;
  const sb = getSupabase();
  const { data, error } = await sb
    .from("user_tasks")
    .select("*")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw error;
  return (data as UserTask) || null;
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (tasks.update)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "tasks.update"); if (_d) return _d; } /* requirePermission wired */

  const { id } = await params;
  // Tenant ownership check — fetch the single row by id (tenant-scoped)
  // instead of loading the entire tenant's task list.
  let existing: UserTask | null;
  try {
    existing = await fetchTaskForTenant(id, auth.tenantId);
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) || "Internal server error" }, { status: 500 });
  }
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  // Preserve the entity's tenant_id
  const updated = await auth.store.upsertTask({ ...body, id, tenant_id: existing.tenant_id });
  await audit(auth.store, auth.user, req, "task.update", "task", id, { done: (updated as any).done });
  return NextResponse.json(updated);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (tasks.delete)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "tasks.delete"); if (_d) return _d; } /* requirePermission wired */

  const { id } = await params;
  let existing: UserTask | null;
  try {
    existing = await fetchTaskForTenant(id, auth.tenantId);
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) || "Internal server error" }, { status: 500 });
  }
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await auth.store.deleteTask(id);
  await audit(auth.store, auth.user, req, "task.delete", "task", id);
  return NextResponse.json({ ok: true });
}
