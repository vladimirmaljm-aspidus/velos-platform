import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthOrApiKey,
  requireAuthOrApiKeyPermission,
  resolveTenantId,
  getIp,
  sanitizeError,
} from "@/lib/api/helpers";
import { withApm } from "@/lib/monitoring/apm";
// 9b-N13 — dashboard routes family rate limit. Same DB-backed per-IP cap as
// the sibling /api/dashboard and /api/dashboard/charts routes (60/min/IP,
// shared across instances via migration 024) so a caller with a valid session
// OR API key cannot hammer the audit-log listing query.
import { checkRateLimit } from "@/lib/security/rate-limiter";

export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/dashboard/activity
//
// "Recent activity" summary feed for the admin dashboard (task 35-6).
//
// The platform's audit_logs table is written by 239 of 377 routes — every
// meaningful action is recorded — but until now the dashboard had no feed:
// users had to open the full Audit module to see "what happened recently".
//
// This is a LIGHT projection, not an audit viewer:
//   { items: [{ id, action, user_name, created_at }] }
//
// It reuses the EXACT listing path as GET /api/audit (same store method —
// `store.listAudit(tenantId, { limit, offset })` — same tenant scoping and
// same ordering: created_at DESC). The full audit module remains the source
// of truth for details; this endpoint strictly EXCLUDES ip addresses,
// metadata/details blobs, before/after values, entity ids and tenant ids —
// only the 4 fields a summary feed needs.
//
// Auth: session cookie OR API key (matches the dashboard route family).
// Permission gate is `dashboard.read` for session-auth callers; API-key
// callers must hold `dashboard:read` (or `*`). Cross-tenant (super-admin
// without a tenant context) requests are refused exactly like /api/audit.
// ─────────────────────────────────────────────────────────────────────────────

interface ActivityFeedItem {
  id: string;
  action: string;
  user_name: string | null;
  created_at: string;
}

async function _get(req: NextRequest) {
  try {
    // 9b-N13 — per-IP rate limit, runs BEFORE auth so unauthenticated
    // probes are also capped. 429 + Retry-After on limit exceeded.
    const rl = await checkRateLimit(`dashboard:ip:${getIp(req)}`, 60, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many dashboard requests. Try again later." },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil((rl.retryAfter ?? 60_000) / 1000)),
            "Cache-Control": "no-store",
          },
        },
      );
    }

    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;

    // U-FIX (RBAC audit D-1) family pattern: check permissions for BOTH
    // session AND API-key callers — same gate as the sibling dashboard
    // routes (`dashboard.read`).
    const denied = requireAuthOrApiKeyPermission(auth, "dashboard.read");
    if (denied) return denied;

    const tid = resolveTenantId(auth, req);
    // Tenant-scoped by design (mirrors /api/audit): a super-admin without an
    // active tenant context gets pointed at the cross-tenant audit viewer
    // instead of silently leaking one tenant's (or the platform's) log.
    if (!tid) {
      return NextResponse.json(
        { error: "Use /api/super-admin/audit for cross-tenant audit." },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }

    // Same store method + scoping as GET /api/audit: limit 20, offset 0,
    // ordered created_at DESC by the store itself.
    const result = await auth.store.listAudit(tid, { limit: 20, offset: 0 });

    // LIGHT projection — pick EXACTLY the 4 summary fields. `username` is
    // resolved the same way /api/audit does it: it is stored on the
    // audit_logs row itself by the audit() helper (no join needed).
    // Deliberately dropped: ip, user_agent, details (before/after values,
    // metadata blobs), entity_type/entity_id, user_id, tenant_id.
    const items: ActivityFeedItem[] = result.items.map((item) => ({
      id: item.id,
      action: item.action,
      user_name: item.username,
      created_at: item.created_at,
    }));

    return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (e: unknown) {
    console.error("[dashboard/activity GET]", e);
    return NextResponse.json(
      { error: sanitizeError(e) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

// ── APM wrapper (task D-8) — same as /api/dashboard/charts ────────────────
export const GET = withApm(_get, "GET /api/dashboard/activity");
