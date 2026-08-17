import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/api/helpers";
import { redactDetails, SUPER_ADMIN_REDACT_KEYS } from "@/lib/api/redact";

export const runtime = "nodejs";

/**
 * GET /api/super-admin/audit
 * Cross-tenant audit log viewer for platform super_admins.
 * Query params: tenant_id, action, user (username), date_from, date_to,
 *               search, limit, offset.
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
  const dateFrom = url.searchParams.get("date_from") || undefined;
  const dateTo = url.searchParams.get("date_to") || undefined;
  const limit = url.searchParams.get("limit") ? Math.min(Number(url.searchParams.get("limit")), 500) : 100;
  const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : 0;

  // F-9-3: cap the internal fetch to 5,000 rows (was 100,000). The store
  // fetches all matching rows then filters in-memory for action/user/date
  // dimensions it doesn't expose — loading 100k audit rows per request was
  // both slow and memory-heavy. 5k is plenty for any reasonable audit-browse
  // session; deeper history should use date_from / date_to filters.
  const result = await auth.store.listAudit(tenantId, { search, limit: 5000, offset: 0 });

  // Filter in memory for the extra dimensions the store doesn't expose.
  let items = result.items;
  if (action) items = items.filter((i) => i.action?.includes(action));
  if (user) items = items.filter((i) => (i.username || "").toLowerCase().includes(user.toLowerCase()));
  if (dateFrom) {
    const t = new Date(dateFrom).getTime();
    items = items.filter((i) => new Date((i as any).created_at).getTime() >= t);
  }
  if (dateTo) {
    const t = new Date(dateTo).getTime();
    items = items.filter((i) => new Date((i as any).created_at).getTime() <= t);
  }

  const total = items.length;
  const paged = items.slice(offset, offset + limit);

  return NextResponse.json({
    total,
    limit,
    offset,
    items: paged.map((item) => ({ ...item, details: redactDetails(item.details, SUPER_ADMIN_REDACT_KEYS) })),
  });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
