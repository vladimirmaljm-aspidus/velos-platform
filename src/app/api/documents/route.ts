import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (documents.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "documents.read"); if (_d) return _d; } /* requirePermission wired */

    const tid = auth.tenantId!;
    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const partner_id = url.searchParams.get("partner_id") || undefined;
    const limit = url.searchParams.get("limit") ? Math.min(Number(url.searchParams.get("limit")), 500) : undefined;
    const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined;
    const result = await auth.store.listDocuments(tid, { search, limit, offset, filters: { partner_id } });
    // Defense-in-depth: even though SupabaseStore filters by tenant_id,
    // this post-filter provides an extra safety layer. Do NOT remove.
    if (!auth.isSuperAdmin && auth.tenantId) {
      const before = result.items.length;
      result.items = result.items.filter((d) => d.tenant_id === auth.tenantId);
      result.total = result.total - (before - result.items.length);
    }
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("[documents GET]", e);
    return NextResponse.json(
      { error: sanitizeError(e) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (documents.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "documents.create"); if (_d) return _d; } /* requirePermission wired */

    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (!auth.tenantId) {
      return NextResponse.json({ error: "tenant_id is required." }, { status: 400 });
    }
    body.tenant_id = auth.tenantId;
    if (!body.uploaded_by) body.uploaded_by = auth.user.id;
    // Quota gate (monthly_documents) — only on CREATE, never on UPDATE.
    if (!body.id) {
      const { enforceQuota } = await import("@/lib/api/plan-limits");
      const denied = await enforceQuota(auth.tenantId, "monthly_documents", auth.isSuperAdmin);
      if (denied) return denied;
    }
    const created = await auth.store.upsertDocument(body);
    await audit(auth.store, auth.user, req, body.id ? "document.update" : "document.upload", "document", created.id, { filename: created.filename });
    return NextResponse.json(created);
  } catch (e: any) {
    console.error("[documents POST]", e);
    return NextResponse.json(
      { error: sanitizeError(e) },
      { status: 500 },
    );
  }
}
