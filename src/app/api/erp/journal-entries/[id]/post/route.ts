import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";
import { assertNoSoDViolation } from "@/lib/permissions/sod-matrix";

export const runtime = "nodejs";

// POST /api/erp/journal-entries/[id]/post — Post a journal entry (change status from draft to posted)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (erp.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "erp.post"); if (_d) return _d; } /* requirePermission wired */
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
    if (existing.status !== "draft") {
      return NextResponse.json({ error: "Only draft entries can be posted." }, { status: 400 });
    }

    // ── P1-1 / Feature 2: Separation-of-Duties check ─────────────────
    // The "post" action IS the approval step for a journal entry
    // (posting moves a draft entry into the ledger — that's the
    // binding financial commitment). The creator (`existing.created_by`)
    // cannot post their own entry unless they are a super_admin.
    // `assertNoSoDViolation` short-circuits for super_admin before
    // consulting the SoD rules.
    {
      const sod = await assertNoSoDViolation(auth, existing.created_by, {
        create_perm: "erp.create",
        approve_perm: "erp.post",
      });
      if (sod) return sod;
    }

    const body = await req.json();
    const postedBy = auth.user.id;

    const posted = await auth.store.postErpJournalEntry(id, postedBy);
    await audit(auth.store, auth.user, req, "journal_entry.post", "erp_journal_entry", id, {
      entry_number: posted.entry_number,
      posted_by: postedBy,
    });
    return NextResponse.json(posted);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
