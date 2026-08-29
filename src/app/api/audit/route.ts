import { NextRequest, NextResponse } from "next/server";
import { requireAuth, sanitizeError } from "@/lib/api/helpers";
import { redactDetails, TENANT_REDACT_KEYS } from "@/lib/api/redact";

export const runtime = "nodejs";

// Redact secret-bearing fields (e.g. portal password-reset tokens) that get
// written into audit `details` — the audit log is for tracing who did what,
// not for exposing live credentials to anyone who can read it.

/**
 * GET /api/audit
 * Tenant-scoped audit log viewer for tenant admins (NOT super-admin —
 * super_admins use /api/super-admin/audit for cross-tenant access).
 *
 * FEAT-2 (Issue 2): the tenant-scoped audit endpoint used to only accept
 * `search`, `limit`, and `offset` — no way to slice by action, user,
 * entity_type, or date range. That made the audit-view page effectively
 * "search or scroll" with no real filtering, which is what the user meant
 * by "no log page shows everything needed". The endpoint now supports the
 * same query params as /api/super-admin/audit:
 *   search, action, user, entity_type, date_from, date_to, limit, offset.
 *
 * ADMIN-H12: the filters are now pushed down to the store's `listAudit`
 * (PostgREST `.ilike` / `.gte` / `.lte`) instead of fetching 5,000 rows
 * and filtering in memory. The 5k cap silently truncated tenants with
 * more audit history, and the returned `total` was the post-truncate
 * count, not the real DB count. We now return the actual count from
 * the DB and let Postgres do the filtering.
 */
export async function GET(req: NextRequest) {
  try {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (audit.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "audit.read"); if (_d) return _d; } /* requirePermission wired */

  if (!auth.tenantId) {
    return NextResponse.json({ error: "Use /api/super-admin/audit for cross-tenant audit." }, { status: 403 });
  }
  const tid = auth.tenantId;
  const url = new URL(req.url);
  const search = url.searchParams.get("search") || undefined;
  const action = url.searchParams.get("action") || undefined;
  const user = url.searchParams.get("user") || undefined;
  const entityType = url.searchParams.get("entity_type") || undefined;
  const dateFrom = url.searchParams.get("date_from") || undefined;
  // date_to is inclusive of the entire day — push to end-of-day so a
  // user filtering by "today" actually sees today's events. The store
  // applies `.lte` directly to this final value, so the boundary work
  // must happen here (and in the super-admin route) before calling it.
  let dateTo = url.searchParams.get("date_to") || undefined;
  if (dateTo) {
    const endOfDay = new Date(dateTo);
    if (!isNaN(endOfDay.getTime())) {
      endOfDay.setHours(23, 59, 59, 999);
      dateTo = endOfDay.toISOString();
    }
  }

  const limit = url.searchParams.get("limit") ? Math.min(Number(url.searchParams.get("limit")), 500) : 100;
  const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : 0;

  const result = await auth.store.listAudit(tid, {
    search,
    action,
    username: user,
    entity_type: entityType,
    date_from: dateFrom,
    date_to: dateTo,
    limit,
    offset,
  });

  return NextResponse.json({
    total: result.total,
    limit,
    offset,
    items: result.items.map((item) => ({ ...item, details: redactDetails(item.details, TENANT_REDACT_KEYS) })),
  });
  } catch (error: any) {
    console.error("[audit GET]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
