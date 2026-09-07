import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

/**
 * GET /api/document-templates/numbering?tenant_id=xxx
 *
 * Document Studio "Automations" — inspect the live numbering allocations
 * (doc_number_allocations: prefix allocations per doc type + year, the
 * system behind OFF-2026-000001). Read-only, admin-gated.
 *
 * DELETE /api/document-templates/numbering?tenant_id=xxx&doc_type=offer&year=2026
 *
 * Reset ONE allocation row — the next document of that (type, year) starts
 * from 1 again. Destructive, audit-logged, super-admin/tenant-admin only.
 */

const DOC_NUMBER_PREFIXES: Record<string, string> = {
  offer: "OFF",
  invoice: "INV",
  proforma: "PRO",
  demand: "DEM",
  rfq: "RFQ",
  logistics: "LOG",
  loi: "LOI",
  journal: "JRN",
};

function previewNext(docType: string, year: number, lastSeq: number): string {
  const prefix = DOC_NUMBER_PREFIXES[docType] || docType.slice(0, 3).toUpperCase();
  return `${prefix}-${year}-${String(lastSeq + 1).padStart(6, "0")}`;
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  {
    const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "document-templates.read"); if (_d) return _d;
  }
  {
    const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_document_templates", auth.isSuperAdmin); if (_f) return _f;
  }
  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) {
    if (auth.isSuperAdmin) return NextResponse.json({ items: [], total: 0 });
    return NextResponse.json({ error: "No tenant context." }, { status: 400 });
  }

  const sb = getSupabase();
  const { data, error } = await sb
    .from("doc_number_allocations")
    .select("doc_type, year, last_seq")
    .eq("tenant_id", tenantId)
    .order("doc_type", { ascending: true })
    .order("year", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const items = (data || []).map((r: { doc_type: string; year: number; last_seq: number }) => ({
    doc_type: r.doc_type,
    year: r.year,
    last_seq: r.last_seq,
    next: previewNext(r.doc_type, r.year, r.last_seq),
  }));
  return NextResponse.json({ items, total: items.length });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  {
    const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "document-templates.update"); if (_d) return _d;
  }
  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ error: "No tenant." }, { status: 400 });

  const docType = req.nextUrl.searchParams.get("doc_type")?.trim();
  const year = Number(req.nextUrl.searchParams.get("year"));
  if (!docType || !/^[a-z_]{2,20}$/.test(docType) || !Number.isInteger(year) || year < 2020 || year > 2100) {
    return NextResponse.json({ error: "Valid doc_type and year (2020-2100) are required." }, { status: 400 });
  }

  const sb = getSupabase();
  const { error } = await sb
    .from("doc_number_allocations")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("doc_type", docType)
    .eq("year", year);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  try {
    await audit(auth.store, auth.user, req, "doc_numbering.reset", "doc_number_allocation", `${tenantId}:${docType}:${year}`, {
      doc_type: docType,
      year,
    });
  } catch (e) {
    console.error("[audit]", e);
  }
  return NextResponse.json({ ok: true, doc_type: docType, year });
}
