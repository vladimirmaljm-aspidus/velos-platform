import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * GET /api/tasks
 * Query params:
 *   mine=1        — only tasks assigned to or created by the current user
 *   assigned=1    — only tasks assigned to the current user
 *   status=xxx    — filter by status (todo, in_progress, done, blocked, cancelled)
 *   priority=xxx  — filter by priority (low, medium, high, urgent)
 *   partner_id=xx — filter by linked partner
 *   product_id=xx — filter by linked product
 *   deal_id=xx    — filter by linked deal
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (tasks.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "tasks.read"); if (_d) return _d; } /* requirePermission wired */

  const tid = resolveTenantId(auth, req);
  if (!tid) return NextResponse.json({ items: [] });

  const url = new URL(req.url);
  const mine = url.searchParams.get("mine");
  const assigned = url.searchParams.get("assigned");
  const status = url.searchParams.get("status");
  const priority = url.searchParams.get("priority");
  const partnerId = url.searchParams.get("partner_id");
  const productId = url.searchParams.get("product_id");
  const dealId = url.searchParams.get("deal_id");

  // Fetch all tenant tasks (the store doesn't support complex filtering)
  let tasks = await auth.store.listTasks(tid);

  // Defense-in-depth: even though SupabaseStore filters by tenant_id,
  // this post-filter provides an extra safety layer. Do NOT remove.
  if (!auth.isSuperAdmin && auth.tenantId) {
    tasks = tasks.filter((t) => t.tenant_id === auth.tenantId);
  }

  // Apply filters
  if (mine) {
    tasks = tasks.filter(
      (t) => t.user_id === auth.user.id
    );
  }
  if (assigned) {
    tasks = tasks.filter((t) => t.user_id === auth.user.id);
  }
  if (status) {
    tasks = tasks.filter((t) => (t as any).status === status || (t.done && status === "done"));
  }
  if (priority) {
    tasks = tasks.filter((t) => t.priority === priority);
  }
  if (partnerId) {
    tasks = tasks.filter(
      (t) => t.entity_type === "partner" && t.entity_id === partnerId
    );
  }
  if (productId) {
    tasks = tasks.filter(
      (t) => t.entity_type === "product" && t.entity_id === productId
    );
  }
  if (dealId) {
    tasks = tasks.filter(
      (t) => t.entity_type === "deal" && t.entity_id === dealId
    );
  }

  return NextResponse.json({ items: tasks });
}

/**
 * POST /api/tasks
 * Body:
 *   title (required), description, priority, due_date,
 *   assigned_to (user id — null = unassigned),
 *   partner_id, product_id, deal_id (optional links),
 *   instructions, estimated_hours, tags
 *
 * Admins can assign tasks to any tenant user; regular users only to themselves.
 * Regular users can only create tasks for themselves.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (tasks.create)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "tasks.create"); if (_d) return _d; } /* requirePermission wired */

  const tid = resolveTenantId(auth, req);
  if (!tid) return NextResponse.json({ error: "Tenant required." }, { status: 400 });

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  body.tenant_id = tid;
  body.user_id = body.user_id || auth.user.id; // creator

  // Permission check: only admin can assign tasks to others
  const canAssign = auth.isSuperAdmin || auth.user.role === "admin";
  if (body.assigned_to && body.assigned_to !== auth.user.id && !canAssign) {
    return NextResponse.json(
      { error: "You can only create tasks for yourself. Ask an admin to assign tasks to others." },
      { status: 403 }
    );
  }

  // Coerce done to boolean so uncheck (false) actually persists.
  if (body.done !== undefined) body.done = !!body.done;

  const created = await auth.store.upsertTask(body);
  await audit(auth.store, auth.user, req, body.id ? "task.update" : "task.create", "task", created.id, {
    title: created.title,
  });
  return NextResponse.json(created);
}
