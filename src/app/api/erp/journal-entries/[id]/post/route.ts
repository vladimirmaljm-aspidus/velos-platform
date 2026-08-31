import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
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

    // ── LOGIC-DEEP §7 (HIGH): re-validate balance BEFORE flipping status ──
    // The POST and PUT routes enforce balance at insert/update time, but a
    // draft could still be unbalanced if:
    //   • it was created via PUT with the (now-fixed) `|| 0` NaN-coercion bug,
    //   • its lines were edited through another path (direct SQL, an older
    //     app version, or a future migration that skips validation).
    // Posting an unbalanced entry into the ledger corrupts the trial
    // balance + P&L + balance sheet reports. We re-sum the lines stored on
    // the DB row and refuse to post if they don't match `debit_total` /
    // `credit_total` (within 0.01 tolerance, matching the POST/PUT gate).
    try {
      const fresh = await auth.store.getErpJournalEntry(id);
      const lines = Array.isArray((fresh as any)?.lines) ? (fresh as any).lines : [];
      // AUDIT17 / F3 — FX-revaluation entries (create_fx_revaluation, 038)
      // carry amounts ONLY in debit_base/credit_base (debit/credit are 0 —
      // a "foreign amount" is meaningless for a revaluation adjustment).
      // When every line is base-only, validate + compare in base amounts
      // instead, otherwise the documented "draft → review → post" workflow
      // for revaluations is dead-ended by the 0 == 0 vs stored totals check.
      const sumLine = (field: "debit" | "credit") =>
        lines.reduce((sum: number, l: any) => sum + (Number(l?.[field]) || 0), 0);
      const sumBase = (field: "debit_base" | "credit_base") =>
        lines.reduce((sum: number, l: any) => sum + (Number(l?.[field]) || 0), 0);
      const foreignTotal = sumLine("debit") + sumLine("credit");
      const baseOnlyEntry = foreignTotal === 0 && (sumBase("debit_base") > 0 || sumBase("credit_base") > 0);
      const totalDebit = baseOnlyEntry ? sumBase("debit_base") : sumLine("debit");
      const totalCredit = baseOnlyEntry ? sumBase("credit_base") : sumLine("credit");
      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        return NextResponse.json(
          {
            error: `Cannot post an unbalanced journal entry. Debits (${totalDebit.toFixed(2)}) must equal credits (${totalCredit.toFixed(2)}).`,
            debit_total: totalDebit,
            credit_total: totalCredit,
          },
          { status: 400 },
        );
      }
      // Defense-in-depth: also compare the recomputed sums against the
      // stored totals — a drift here means the header was updated without
      // the lines (or vice versa) and the row is internally inconsistent.
      const storedDebit = Number((fresh as any)?.debit_total ?? 0);
      const storedCredit = Number((fresh as any)?.credit_total ?? 0);
      if (
        Math.abs(storedDebit - totalDebit) > 0.01 ||
        Math.abs(storedCredit - totalCredit) > 0.01
      ) {
        return NextResponse.json(
          {
            error: "Journal entry header totals are out of sync with the line sums. Refusing to post an inconsistent entry.",
            stored_debit_total: storedDebit,
            stored_credit_total: storedCredit,
            actual_debit_total: totalDebit,
            actual_credit_total: totalCredit,
          },
          { status: 400 },
        );
      }
    } catch (e: any) {
      // If we can't re-fetch the entry to validate, fail closed — never
      // post an entry we couldn't verify.
      return NextResponse.json(
        { error: `Failed to re-validate entry balance before posting: ${sanitizeError(e)}` },
        { status: 500 },
      );
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
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
