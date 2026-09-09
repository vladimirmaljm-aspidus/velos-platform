import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { withApm } from "@/lib/monitoring/apm";
import { requirePermission } from "@/lib/permissions/can";

export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/marketplace/documents                                     (101)
//
// Admin registry of marketplace trade documents (invoices, packing lists,
// certificates of origin, eBLs…) — the admin-control counterpart to the
// portal issuer/participant surface. Lets an admin spot a bad or stale
// generated document and fix it (PUT) or remove it (DELETE).
//
// • super_admin  — every tenant, optional ?tenant_id= filter.
// • tenant admin — ONLY their own tenant (the tenant_id param is ignored).
//
// Query params: status, document_type, post_id, search (matches
// reference_number ilike), limit ≤ 200, offset. Items are hydrated with
// partner_name (and tenant display name for super admin).
//
// Auth: `marketplace.documents` permission.
// ─────────────────────────────────────────────────────────────────────────────
async function _get(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  {
    const _d = requirePermission(auth, "marketplace.documents");
    if (_d) return _d;
  }
  const url = new URL(req.url);
  const scopeTenant = auth.isSuperAdmin
    ? resolveTenantId(auth, req) || null
    : auth.tenantId!;
  const status = url.searchParams.get("status") || undefined;
  const documentType = url.searchParams.get("document_type") || undefined;
  const postId = url.searchParams.get("post_id") || undefined;
  const search = (url.searchParams.get("search") || "").trim() || undefined;
  const limit = Math.min(Number(url.searchParams.get("limit") || 100), 200);
  const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);

  try {
    const sb = getSupabase();
    let q = sb
      .from("marketplace_trade_documents")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (scopeTenant) q = q.eq("tenant_id", scopeTenant);
    if (status) q = q.eq("status", status);
    if (documentType) q = q.eq("document_type", documentType);
    if (postId) q = q.eq("post_id", postId);
    if (search) q = q.ilike("reference_number", `%${search}%`);

    const { data, count, error } = await q;
    if (error) throw error;
    const items = (data as any[]) || [];

    // Hydrate partner names + tenant names in one pass.
    const partnerIds = [...new Set(items.map((d) => d.partner_id).filter(Boolean))];
    const tenantIds = auth.isSuperAdmin
      ? [...new Set(items.map((d) => d.tenant_id).filter(Boolean))]
      : [];
    const partnerNames = new Map<string, string>();
    if (partnerIds.length) {
      const { data: partners } = await sb.from("partners").select("id, name").in("id", partnerIds);
      for (const p of (partners as any[]) || []) partnerNames.set(p.id, p.name);
    }
    const tenantNames = new Map<string, string>();
    if (tenantIds.length) {
      const { data: tenants } = await sb.from("tenants").select("id, name").in("id", tenantIds);
      for (const t of (tenants as any[]) || []) tenantNames.set(t.id, t.name);
    }

    return NextResponse.json({
      items: items.map((d) => ({
        ...d,
        partner_name: partnerNames.get(d.partner_id) || null,
        tenant_name: tenantNames.get(d.tenant_id) || null,
      })),
      total: count ?? 0,
      limit,
      offset,
    });
  } catch (e: any) {
    console.error("[admin.marketplace.documents] GET failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/admin/marketplace/documents");
