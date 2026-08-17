import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

// GET /api/erp/journal-entries/[id] — Get single journal entry (with lines)
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (erp.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "erp.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */


  const { id } = await params;
  try {
    const entry = await auth.store.getErpJournalEntry(id);
    if (!entry) return NextResponse.json({ error: "Not found." }, { status: 404 });
    // Tenant Ownership check
    if (!auth.isSuperAdmin && entry.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json(entry);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// PUT /api/erp/journal-entries/[id] — Update journal entry
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (erp.update)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "erp.update"); if (_d) return _d; } /* requirePermission wired */
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
      return NextResponse.json({ error: "Only draft entries can be updated." }, { status: 400 });
    }

    const body = await req.json();

    // Recalculate totals if lines provided
    if (body.lines && Array.isArray(body.lines)) {
      // P2-12: Validate each line's debit/credit BEFORE the balance check.
      // `reduce` propagates NaN (NaN + x = NaN, Math.abs(NaN - NaN) > 0.01 === false),
      // so a single malformed line would silently bypass the balance gate. Negative
      // amounts are nonsensical in accounting and must also be rejected up-front.
      // We normalize the values so downstream code sees clean finite numbers.
      for (const l of body.lines) {
        const d = Number(l.debit) || 0;
        const c = Number(l.credit) || 0;
        if (!Number.isFinite(d) || d < 0) {
          return NextResponse.json({ error: "Invalid debit amount." }, { status: 400 });
        }
        if (!Number.isFinite(c) || c < 0) {
          return NextResponse.json({ error: "Invalid credit amount." }, { status: 400 });
        }
        // Normalize to clean numbers
        l.debit = d;
        l.credit = c;
      }
      const totalDebit = body.lines.reduce((sum: number, l: any) => sum + (l.debit || 0), 0);
      const totalCredit = body.lines.reduce((sum: number, l: any) => sum + (l.credit || 0), 0);
      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        return NextResponse.json({ error: "Journal entry must be balanced (debits must equal credits)." }, { status: 400 });
      }
      body.debit_total = totalDebit;
      body.credit_total = totalCredit;
    }

    const updated = await auth.store.upsertErpJournalEntry({ ...body, id, tenant_id: existing.tenant_id });
    await audit(auth.store, auth.user, req, "journal_entry.update", "erp_journal_entry", id, {
      entry_number: updated.entry_number,
    });
    return NextResponse.json(updated);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// DELETE /api/erp/journal-entries/[id] — Delete journal entry (only if draft)
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (erp.delete)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "erp.delete"); if (_d) return _d; } /* requirePermission wired */
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
      return NextResponse.json({ error: "Only draft entries can be deleted." }, { status: 400 });
    }

    await auth.store.deleteErpJournalEntry(id);
    await audit(auth.store, auth.user, req, "journal_entry.delete", "erp_journal_entry", id, {
      entry_number: existing.entry_number,
    });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
