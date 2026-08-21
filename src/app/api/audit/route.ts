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
 * The store only exposes `search` server-side; the rest are applied in
 * memory (same pattern the super-admin route uses).
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
  const dateTo = url.searchParams.get("date_to") || undefined;
  // Same cap pattern as /api/super-admin/audit: the store fetches up to
  // 5,000 rows (so the in-memory filters have enough headroom to actually
  // slice them) and we page the filtered result.
  const internalLimit = 5000;
  const result = await auth.store.listAudit(tid, { search, limit: internalLimit, offset: 0 });

  let items = result.items;
  if (action) items = items.filter((i) => i.action?.includes(action));
  if (user) items = items.filter((i) => (i.username || "").toLowerCase().includes(user.toLowerCase()));
  if (entityType) items = items.filter((i) => (i.entity_type || "").toLowerCase().includes(entityType.toLowerCase()));
  if (dateFrom) {
    const t = new Date(dateFrom).getTime();
    if (!isNaN(t)) items = items.filter((i) => new Date(i.created_at).getTime() >= t);
  }
  if (dateTo) {
    // date_to is inclusive of the entire day — push to end-of-day so a
    // user filtering by "today" actually sees today's events.
    const endOfDay = new Date(dateTo);
    if (!isNaN(endOfDay.getTime())) {
      endOfDay.setHours(23, 59, 59, 999);
      const t = endOfDay.getTime();
      items = items.filter((i) => new Date(i.created_at).getTime() <= t);
    }
  }

  const limit = url.searchParams.get("limit") ? Math.min(Number(url.searchParams.get("limit")), 500) : 100;
  const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : 0;
  const total = items.length;
  const paged = items.slice(offset, offset + limit);

  return NextResponse.json({
    total,
    limit,
    offset,
    items: paged.map((item) => ({ ...item, details: redactDetails(item.details, TENANT_REDACT_KEYS) })),
  });
  } catch (error: any) {
    console.error("[audit GET]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
