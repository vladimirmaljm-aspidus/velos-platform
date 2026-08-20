import { NextRequest, NextResponse } from "next/server";
// FIX-ALL-2 / Fix 3 — accept API-key auth on [id] routes so an API-key
// caller fetching /api/invoices/<non-existent-id> gets 404 (not 401).
import { requireAuthOrApiKey, hasPermission, audit, sanitizeError } from "@/lib/api/helpers";
import { validateStatusTransition } from "@/lib/api/status-validator";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthOrApiKey(_req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (invoices.read) — session callers use requirePermission,
    // API-key callers use hasPermission (colon format).
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "invoices.read"); if (_d) return _d; } }
    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "invoices:read")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_finance", _isSA); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const item = await auth.store.getInvoice(id);
    // FIX-ALL-2 / Fix 3 — not-found returns 404, not 401.
    if (!item) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!isSuperAdmin && item.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json(item);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (invoices.update) — session callers use requirePermission,
  // API-key callers use hasPermission (colon format).
  { const { requirePermission } = await import("@/lib/permissions/can");
    if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "invoices.update"); if (_d) return _d; } }
  if ("apiKeyId" in auth && !hasPermission(auth.permissions, "invoices:write")) {
    return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
  }
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_finance", _isSA); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const existing = await auth.store.getInvoice(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const body = await req.json();
    // CRITICAL FIX (audit F-2): lock financial fields on paid/partial invoices.
    // A user with invoices.update permission should NOT be able to change total,
    // items, partner_id, or currency on a document that's already been paid.
    // `InvoiceStatus` doesn't formally include "partial" (the union is
    // draft|sent|paid|overdue|cancelled) but record-payment.ts writes "partial"
    // at runtime — so we widen the comparison to `string` to avoid TS narrowing
    // away a status the database can actually hold.
    const existingStatus: string = existing.status;
    if (existingStatus === "paid" || existingStatus === "partial") {
      if (!isSuperAdmin) {
        const lockedFields = ["total", "subtotal", "items", "tax_total", "discount_total", "partner_id", "currency", "offer_id"];
        for (const k of lockedFields) {
          if (k in body) {
            return NextResponse.json(
              { error: `Cannot modify ${k} on a ${existingStatus} invoice. Super-admin override required.` },
              { status: 409 },
            );
          }
        }
      }
    }
    // FIX-P1-LOGIC Fix 1: enforce valid status transitions. Super-admins
    // bypass so they can correct bad data.
    if (body.status && body.status !== existing.status && !isSuperAdmin) {
      const transition = validateStatusTransition("invoice", existing.status, body.status);
      if (!transition.valid) {
        return NextResponse.json({ error: transition.error }, { status: 400 });
      }
    }
    // FIX-P1-LOGIC Fix 5: recompute totals from line items — never trust
    // client-supplied totals (parity with offers PUT). Always overwrite.
    if (Array.isArray(body.items) && body.items.length > 0) {
      let subtotal = 0, discountTotal = 0, taxTotal = 0;
      for (const it of body.items) {
        const line = (Number(it.quantity) || 0) * (Number(it.unit_price) || 0);
        const disc = line * (Number(it.discount) || 0) / 100;
        const net = line - disc;
        const tax = net * (Number(it.tax_rate) || 0) / 100;
        subtotal += line;
        discountTotal += disc;
        taxTotal += tax;
        it.total = Math.round((net + tax) * 100) / 100;
      }
      body.subtotal = Math.round(subtotal * 100) / 100;
      body.discount_total = Math.round(discountTotal * 100) / 100;
      body.tax_total = Math.round(taxTotal * 100) / 100;
      body.total = Math.round((subtotal - discountTotal + taxTotal) * 100) / 100;
    }
    const updated = await auth.store.upsertInvoice({ ...body, id, tenant_id: existing.tenant_id });

    // CRITICAL FIX (audit I-1/I-2): when an invoice is cancelled, reverse
    // the financial side effects that were created when it was paid:
    // 1. Reverse the auto-journal entry (if one exists)
    // 2. Reverse the bank transaction (insert a debit row)
    // 3. Un-mark the linked proforma (set back to 'accepted')
    // 4. Void commissions that were marked 'approved' by the payment
    if (body.status === "cancelled" && (existingStatus === "paid" || existingStatus === "partial")) {
      try {
        const { getSupabase } = await import("@/lib/supabase/client");
        const sb = getSupabase();
        const tid = existing.tenant_id;

        // 1. Find and reverse the auto-journal entry for this invoice
        const { data: je } = await sb
          .from("erp_journal_entries")
          .select("id, status")
          .eq("tenant_id", tid)
          .eq("reference_type", "invoice")
          .eq("reference_id", id)
          .in("status", ["posted", "draft"])
          .maybeSingle();
        if (je) {
          try {
            // FIX-ALL-2 / Fix 3 — the JE reversal API takes a user_id
            // for the audit trail. For API-key callers we don't have a
            // real user_id; pass the synthetic api:<id> so the audit
            // column stays populated and the JE reversal still works.
            const reversalUserId = "user" in auth
              ? auth.user.id
              : `api:${auth.apiKeyId}`;
            await auth.store.reverseErpJournalEntry(je.id, reversalUserId);
          } catch (e) {
            console.warn("[invoice.cancel] JE reversal failed:", e);
          }
        }

        // 2. Insert a reversal bank transaction (debit = negative adjustment)
        const { data: bankTxns } = await sb
          .from("erp_bank_transactions")
          .select("id, amount, bank_account_id, invoice_number")
          .eq("tenant_id", tid)
          .eq("invoice_number", existing.number)
          .eq("transaction_type", "credit")
          .eq("category", "invoice_payment");
        if (bankTxns && bankTxns.length > 0) {
          for (const bt of bankTxns) {
            await sb.from("erp_bank_transactions").insert({
              tenant_id: tid,
              bank_account_id: bt.bank_account_id,
              transaction_type: "debit",
              category: "invoice_reversal",
              amount: bt.amount,
              description: `Reversal: cancelled invoice ${existing.number}`,
              invoice_number: existing.number,
              reference: `reversal-inv-${id}`,
              transaction_date: new Date().toISOString().split("T")[0],
            });
          }
        }

        // 3. Un-mark the linked proforma (set back to 'accepted' if it was auto-paid)
        if (existing.offer_id) {
          const { data: proforma } = await sb
            .from("proformas")
            .select("id, status")
            .eq("tenant_id", tid)
            .eq("offer_id", existing.offer_id)
            .eq("status", "paid")
            .maybeSingle();
          if (proforma) {
            await sb.from("proformas")
              .update({ status: "accepted", paid_at: null })
              .eq("id", proforma.id);
          }
        }

        // 4. Void commissions that were marked 'approved' by the invoice payment
        try {
          const { data: commissions } = await sb
            .from("deal_commissions")
            .select("id, status")
            .eq("tenant_id", tid)
            .eq("deal_id", existing.offer_id) // commissions are linked via deal
            .eq("status", "approved");
          if (commissions) {
            for (const c of commissions) {
              await sb.from("deal_commissions")
                .update({ status: "cancelled", notes: `Voided: invoice ${existing.number} cancelled` })
                .eq("id", c.id);
            }
          }
        } catch (e) {
          console.warn("[invoice.cancel] commission void failed:", e);
        }
      } catch (e) {
        console.error("[invoice.cancel] reversal cascade failed:", e);
      }
    }

    const auditUser = "user" in auth ? auth.user : { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
    try {
      const { recordRevision } = await import("@/lib/api/doc-revisions");
      await recordRevision({
        docType: "invoice", documentId: id, tenantId: existing.tenant_id,
        before: existing as any, after: updated as any,
        userId: auditUser.id, username: auditUser.username,
        changeNote: (body as any)?._changeNote || null,
      });
    } catch (e) { console.warn("[invoice.update] revision failed:", e); }
    await audit(auth.store, auditUser, req, "invoice.update", "invoice", id, { status: updated.status });
    return NextResponse.json(updated);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (invoices.delete) — session callers use requirePermission,
  // API-key callers use hasPermission (colon format).
  { const { requirePermission } = await import("@/lib/permissions/can");
    if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "invoices.delete"); if (_d) return _d; } }
  if ("apiKeyId" in auth && !hasPermission(auth.permissions, "invoices:write")) {
    return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
  }
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_finance", _isSA); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const existing = await auth.store.getInvoice(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    // Status guard (H-6) — only draft or cancelled invoices can be
    // hard-deleted. Paid/sent/overdue/partial invoices carry an audit
    // trail and must be voided (status=cancelled) instead.
    if (existing.status && !["draft", "cancelled"].includes(existing.status)) {
      return NextResponse.json(
        { error: `Cannot delete a record in status '${existing.status}'.` },
        { status: 409 },
      );
    }
    await auth.store.deleteInvoice(id);
    const auditUser = "user" in auth ? auth.user : { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
    await audit(auth.store, auditUser, req, "invoice.delete", "invoice", id);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
