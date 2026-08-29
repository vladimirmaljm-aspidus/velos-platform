import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/api/helpers";
import { redactDetails, SUPER_ADMIN_REDACT_KEYS } from "@/lib/api/redact";

export const runtime = "nodejs";

/**
 * GET /api/super-admin/audit
 * Cross-tenant audit log viewer for platform super_admins.
 * Query params: tenant_id, action, user (username), entity_type,
 *               date_from, date_to, search, limit, offset.
 *
 * FEAT-2 (Issue 2): added `entity_type` filter so the platform-audit view
 * can slice by entity ("show me every KYC event", "show me every login").
 *
 * ADMIN-H12: filters are now pushed down to the store's `listAudit`
 * (PostgREST `.ilike` / `.gte` / `.lte`) instead of fetching 5,000 rows
 * and filtering in memory. The 5k cap silently truncated tenants with
 * more audit history, and the returned `total` was the post-truncate
 * count, not the real DB count. We now return the actual count from
 * the DB and let Postgres do the filtering.
 */
export async function GET(req: NextRequest) {
  try {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenant_id") || "";
  const search = url.searchParams.get("search") || undefined;
  const action = url.searchParams.get("action") || undefined;
  const user = url.searchParams.get("user") || undefined;
  const entityType = url.searchParams.get("entity_type") || undefined;
  const dateFrom = url.searchParams.get("date_from") || undefined;
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

  const result = await auth.store.listAudit(tenantId, {
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
    items: result.items.map((item) => ({ ...item, details: redactDetails(item.details, SUPER_ADMIN_REDACT_KEYS) })),
  });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
