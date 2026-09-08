import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit, sanitizeError } from "@/lib/api/helpers";
import { listPostReports, updatePostReportStatus } from "@/lib/data/marketplace-store";
import { withApm } from "@/lib/monitoring/apm";
import { requirePermission } from "@/lib/permissions/can";

export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/marketplace/reports[?status=&limit=&offset=&tenant_id=]
//
// The moderation queue for marketplace_post_reports (migration 098) —
// previously the table was insert-only with NO consumer: reports piled up
// as 'open' forever and moderators had to infer them from the audit log.
//
// • super_admin  — cross-tenant queue (optional ?tenant_id filter).
// • tenant admin — ONLY their own tenant's reports (the tenant_id param
//                  is ignored for them).
//
// Query params: status=open|reviewed|dismissed (default: all), limit ≤ 200,
// offset. Items are hydrated with reporter_name + product_name.
//
// Auth: `marketplace.moderate` permission.
// ─────────────────────────────────────────────────────────────────────────────
async function _get(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  {
    const _d = requirePermission(auth, "marketplace.moderate");
    if (_d) return _d;
  }
  const url = new URL(req.url);
  const scopeTenant = auth.isSuperAdmin
    ? resolveTenantId(auth, req) || null
    : auth.tenantId!;
  const status = url.searchParams.get("status") || undefined;
  const limit = Math.min(Number(url.searchParams.get("limit") || 100), 200);
  const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);

  try {
    const result = await listPostReports(scopeTenant, status, limit, offset);
    return NextResponse.json({ ...result, limit, offset });
  } catch (e: any) {
    console.error("[admin.marketplace.reports] GET failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/admin/marketplace/reports
//
// Triage one report: body { report_id, status: "reviewed" | "dismissed" }.
// 'reviewed' = action taken (the admin separately flagged/removed the post
// via the posts route); 'dismissed' = no violation found.
//
// • super_admin — any report; tenant admin — only reports on their own
//   tenant's posts (verified via the report row before the update).
//
// Auth: `marketplace.moderate` permission. Audited.
// ─────────────────────────────────────────────────────────────────────────────
async function _put(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  {
    const _d = requirePermission(auth, "marketplace.moderate");
    if (_d) return _d;
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const reportId = String(body?.report_id || "");
  const status = String(body?.status || "");
  if (!reportId) {
    return NextResponse.json({ error: "report_id is required." }, { status: 400 });
  }
  if (!["reviewed", "dismissed"].includes(status)) {
    return NextResponse.json({ error: "status must be reviewed or dismissed." }, { status: 400 });
  }

  try {
    // Tenant-admin scope check BEFORE the write.
    if (!auth.isSuperAdmin) {
      const { getSupabase } = await import("@/lib/supabase/client");
      const { data: report } = await getSupabase()
        .from("marketplace_post_reports")
        .select("id, tenant_id")
        .eq("id", reportId)
        .maybeSingle();
      if (!report) {
        return NextResponse.json({ error: "Report not found." }, { status: 404 });
      }
      if ((report as any).tenant_id !== auth.tenantId) {
        return NextResponse.json(
          { error: "Tenant admins may only triage their own tenant's reports." },
          { status: 403 },
        );
      }
    }

    const updated = await updatePostReportStatus(
      reportId,
      status as "reviewed" | "dismissed",
      auth.user?.username ?? "admin",
    );
    if (!updated) {
      return NextResponse.json({ error: "Report not found." }, { status: 404 });
    }
    try {
      await audit(
        auth.store,
        auth.user,
        req,
        "marketplace.report_triaged",
        "marketplace_post_report",
        reportId,
        { report_id: reportId, status, admin: auth.user?.username },
      );
    } catch (e) {
      console.error("[admin.marketplace.reports] audit failed:", e);
    }
    return NextResponse.json({ report: updated });
  } catch (e: any) {
    console.error("[admin.marketplace.reports] PUT failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/admin/marketplace/reports");
export const PUT = withApm(_put, "PUT /api/admin/marketplace/reports");
