import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

// POST /api/erp/journal-entries/[id]/reverse — Reverse a posted journal entry
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (erp.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "erp.reverse"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */


  const { id } = await params;
  try {
    const existing = await auth.store.getErpJournalEntry(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    // Tenant Ownership check
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (existing.status !== "posted") {
      return NextResponse.json({ error: "Only posted entries can be reversed." }, { status: 400 });
    }

    const body = await req.json();
    const reversedBy = body.reversed_by || auth.user.id;

    const reversed = await auth.store.reverseErpJournalEntry(id, reversedBy);
    await audit(auth.store, auth.user, req, "journal_entry.reverse", "erp_journal_entry", id, {
      entry_number: existing.entry_number,
      reversed_by: reversedBy,
      reversal_entry: reversed.id,
    });
    return NextResponse.json(reversed);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
