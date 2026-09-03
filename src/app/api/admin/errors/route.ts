import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError, getAuthUser } from "@/lib/api/helpers";
import {
  listErrors,
  errorStats,
  resolveError,
  unresolveError,
  recordError,
} from "@/lib/monitoring/error-audit";

export const runtime = "nodejs";

/**
 * GET /api/admin/errors — list + stats for the admin "Error Audit" view.
 *
 * Auth: session (requireAuth) + `audit.read` permission — the exact gate
 * /api/audit uses (tenant admins hold audit.read implicitly via the admin
 * role; super_admins bypass).
 *
 * Tenant scoping (mirrors the /api/audit vs /api/super-admin/audit split,
 * collapsed into one route):
 *   • super_admin — cross-tenant view (all rows, incl. pre-login/anonymous).
 *   • tenant admin — ONLY rows whose tenant_id equals their tenant. Error
 *     messages and user emails can contain tenant data, so cross-tenant
 *     visibility stays super-admin-only.
 *
 * searchParams: source (client|server), level (error|warning),
 * resolved (all|open|resolved — default all), q (message/email ilike),
 * limit (default 50, ceiling 500), offset.
 *
 * Returns { items, total, stats: { total, open, client, server, last24h } }
 * — stats are computed under the SAME tenant scoping as the list.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (audit.read) — same pattern as /api/audit.
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "audit.read"); if (_d) return _d; } /* requirePermission wired */

    // Tenant scoping: undefined = no filter (super-admin, cross-tenant).
    const tenantId = auth.isSuperAdmin ? undefined : (auth.tenantId ?? undefined);

    const url = new URL(req.url);
    const limit = url.searchParams.get("limit")
      ? Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 500)
      : 50;
    const offset = url.searchParams.get("offset")
      ? Math.max(Number(url.searchParams.get("offset")) || 0, 0)
      : 0;
    const result = await listErrors({
      tenantId,
      source: url.searchParams.get("source") || undefined,
      level: url.searchParams.get("level") || undefined,
      resolved: url.searchParams.get("resolved") || undefined,
      q: url.searchParams.get("q") || undefined,
      limit,
      offset,
    });
    const stats = await errorStats(tenantId);

    return NextResponse.json(
      { items: result.items, total: result.total, limit, offset, stats },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error: any) {
    console.error("[admin.errors GET]", error);
    // Dogfooding: an error INSIDE the error-audit route is itself recorded
    // (source 'server'). recordError never throws, so this cannot loop.
    await recordError({
      source: "server",
      level: "error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
      url: "/api/admin/errors",
      context: { method: "GET", capturedBy: "admin-errors-route-catch" },
    });
    return NextResponse.json(
      { error: sanitizeError(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

/**
 * PUT /api/admin/errors — resolve / re-open an error row.
 * Body: { id: string, resolved: boolean }.
 *
 * requireAuth(req) runs the CSRF Origin check (PUT is state-changing —
 * callers MUST pass the request through, which this route does).
 * The action is written to audit_logs (event "error_audit.resolve" /
 * "error_audit.unresolve") via the repo's audit() helper so triage actions
 * are traceable alongside the normal audit trail.
 */
export async function PUT(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "audit.read"); if (_d) return _d; } /* requirePermission wired */

    let body: { id?: unknown; resolved?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (
      !body ||
      typeof body.id !== "string" ||
      !body.id.trim() ||
      typeof body.resolved !== "boolean"
    ) {
      return NextResponse.json(
        { error: "Expected { id: string, resolved: boolean }." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const user = getAuthUser(auth);
    const tenantId = auth.isSuperAdmin ? undefined : (auth.tenantId ?? undefined);
    const id = body.id.trim();
    const resolvedBy = (user as { email?: string }).email || user.username || "unknown";

    const ok = body.resolved
      ? await resolveError(id, resolvedBy, tenantId)
      : await unresolveError(id, tenantId);
    if (!ok) {
      // Either the row doesn't exist, is already in the requested state, or
      // (tenant admin) the row belongs to another tenant — indistinguishable
      // by design.
      return NextResponse.json(
        { error: "Error not found." },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }

    await audit(
      auth.store,
      user,
      req,
      body.resolved ? "error_audit.resolve" : "error_audit.unresolve",
      "error_log",
      id,
      { resolved: body.resolved, by: resolvedBy },
    );

    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error: any) {
    console.error("[admin.errors PUT]", error);
    await recordError({
      source: "server",
      level: "error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
      url: "/api/admin/errors",
      context: { method: "PUT", capturedBy: "admin-errors-route-catch" },
    });
    return NextResponse.json(
      { error: sanitizeError(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
