import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

/**
 * GET /api/document-revisions/[documentId]
 *
 * Returns the auto-saved revision history for a single document
 * (offer / invoice / proforma). Each row is written by `recordRevision`
 * whenever a PUT mutates the parent row, and contains:
 *   - version (1, 2, 3 ...)
 *   - changed_fields [{ field, before, after }, ...]
 *   - snapshot_before (jsonb — full pre-change row)
 *   - changed_by_username / created_by
 *   - change_note (optional, supplied via body._changeNote)
 *
 * Tenant scoping:
 *   - super_admin: no filter (can read any tenant's revisions)
 *   - everyone else: filtered to their own tenant_id
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ documentId: string }> }) {
  try {
    const auth = await requireAuth(_req);
    if (auth instanceof NextResponse) return auth;
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "document-register.read"); if (_d) return _d; }

    const { documentId } = await params;
    if (!documentId) {
      return NextResponse.json({ error: "documentId is required." }, { status: 400 });
    }

    const sb = getSupabase();
    let q = sb
      .from("document_revisions")
      .select("*")
      .eq("document_id", documentId);

    // Strict tenant scoping for non-super-admins.
    if (!auth.isSuperAdmin && auth.tenantId) {
      q = q.eq("tenant_id", auth.tenantId);
    }

    const { data, error } = await q.order("version", { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ items: data || [] });
  } catch (e: any) {
    console.error("[document-revisions/[documentId]]", e);
    return NextResponse.json(
      { error: e?.message || "Internal server error" },
      { status: 500 },
    );
  }
}
