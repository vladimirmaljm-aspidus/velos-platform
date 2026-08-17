import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";
import { nextDocNumber, formatDocNumber } from "@/lib/api/doc-number";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

/**
 * POST /api/automation/create-invoice-from-offer
 *
 * Auto-create an invoice from an accepted offer:
 * - Copy all offer data (partner, items, totals)
 * - Auto-generate invoice number
 * - Set due date based on payment terms
 * - Auto-fill all partner data
 *
 * Body: { offer_id: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (invoices.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "invoices.create"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance) — invoices are a finance document.
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */


  const tid = resolveTenantId(auth, req);
  if (!tid) return NextResponse.json({ error: "No tenant context." }, { status: 400 });
  try {
    const body = await req.json();
    const { offer_id } = body;

    if (!offer_id) {
      return NextResponse.json(
        { error: "offer_id is required." },
        { status: 400 }
      );
    }

    const store = auth.store;

    // 1. Fetch the offer
    const offer = await store.getOffer(offer_id);
    if (!offer) {
      return NextResponse.json({ error: "Offer not found." }, { status: 404 });
    }
    // Tenant ownership check
    if (!auth.isSuperAdmin && offer.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Offer not found." }, { status: 404 });
    }

    // 2. Verify the offer is in a valid state (accepted or sent)
    if (offer.status !== "accepted" && offer.status !== "sent") {
      return NextResponse.json(
        { error: `Cannot create invoice from offer with status "${offer.status}". Offer must be accepted or sent.` },
        { status: 400 }
      );
    }

    // 2b. FIX-P1-LOGIC Fix 2: prevent duplicate invoices for the same offer.
    //     Two clicks on the "create invoice" button must not produce two
    //     invoices — return 409 with the existing invoice's id/number.
    //
    //     Re-Audit-2 N5: exclude cancelled invoices from the duplicate check.
    //     Previously, cancelling an invoice and then re-creating from the same
    //     offer would 409 pointing at the cancelled record.
    //
    //     CRITICAL FIX (audit P1-14): use a targeted SQL query instead of
    //     listInvoices(limit:1000) + JS .find(). Avoids the 1000-record cap
    //     and is more efficient.
    {
      const { data: existing } = await getSupabase()
        .from("invoices")
        .select("id, number")
        .eq("tenant_id", tid)
        .eq("offer_id", offer.id)
        .neq("status", "cancelled")
        .limit(1)
        .maybeSingle();
      if (existing) {
        return NextResponse.json(
          {
            error: "An invoice already exists for this offer.",
            existing_invoice_id: (existing as { id: string }).id,
            existing_invoice_number: (existing as { number?: string }).number,
          },
          { status: 409 }
        );
      }
    }

    // 3. Fetch partner data for auto-fill
    const partner = await store.getPartner(offer.partner_id);
    if (!partner) {
      return NextResponse.json(
        { error: "Partner not found for this offer." },
        { status: 404 }
      );
    }

    // 4. Auto-generate invoice number (atomic via Postgres SEQUENCE; falls
    //    back to legacy `listInvoices().total + 1` if the RPC is unavailable).
    //    Format: INV-<year>-<NNNN>  (4-digit sequence)
    const year = new Date().getFullYear();
    const seqNum = await nextDocNumber("invoice");
    let invoiceNumber: string;
    if (seqNum) {
      invoiceNumber = seqNum;
    } else {
      const existingInvoices = await store.listInvoices(tid, { limit: 1 });
      const nextSeq = (existingInvoices.total || 0) + 1;
      invoiceNumber = formatDocNumber("invoice", year, nextSeq);
    }

    // 5. Calculate due date based on payment terms
    const issueDate = new Date();
    let dueDate = new Date(issueDate);

    // Parse payment terms to determine due date
    const paymentTerms = offer.payment_terms || partner.preferred_payment_terms || "net30";
    const netMatch = paymentTerms.match(/net\s*(\d+)/i);
    if (netMatch) {
      dueDate.setDate(dueDate.getDate() + parseInt(netMatch[1], 10));
    } else if (paymentTerms.toLowerCase().trim() === "immediate" || paymentTerms.toLowerCase().trim() === "advance") {
      // Due immediately (issue date)
    } else {
      // Default to 30 days
      dueDate.setDate(dueDate.getDate() + 30);
    }

    // 6. Build the invoice object
    //
    //    Copy ALL trade-term fields that exist on BOTH the `offers` and
    //    `invoices` tables (supabase-schema-live.sql:766-812 + 496-545).
    //    Previously the automation dropped incoterm/pol/pod/vessel/etc.,
    //    silently losing trade data downstream (DEEP-AUDIT-LOGIC §2.2).
    //    `bank_details` is intentionally omitted — it only exists on offers.
    const offerAny = offer as any;
    const invoiceData = {
      tenant_id: tid,
      number: invoiceNumber,
      offer_id: offer.id,
      partner_id: offer.partner_id,
      status: "draft" as const,
      subject: offer.subject,
      currency: offer.currency,
      subtotal: offer.subtotal,
      discount_total: offer.discount_total,
      tax_total: offer.tax_total,
      total: offer.total,
      issue_date: issueDate.toISOString().split("T")[0],
      due_date: dueDate.toISOString().split("T")[0],
      payment_terms: paymentTerms,
      notes: offer.notes
        ? `Auto-generated from offer: ${offer.number}. ${offer.notes}`
        : `Auto-generated from offer: ${offer.number}`,
      items: offer.items,
      // Trade terms (copied from source offer):
      incoterm: offerAny.incoterm ?? null,
      pol: offerAny.pol ?? null,
      pol_country: offerAny.pol_country ?? null,
      pod: offerAny.pod ?? null,
      pod_country: offerAny.pod_country ?? null,
      vessel: offerAny.vessel ?? null,
      container_no: offerAny.container_no ?? null,
      lead_time: offerAny.lead_time ?? null,
      packaging: offerAny.packaging ?? null,
      delivery_address: offerAny.delivery_address ?? null,
      delivery_city: offerAny.delivery_city ?? null,
      delivery_country: offerAny.delivery_country ?? null,
      specification: offerAny.specification ?? null,
      origin_country: offerAny.origin_country ?? null,
      exchange_rate: offerAny.exchange_rate ?? null,
      exchange_rate_date: offerAny.exchange_rate_date ?? null,
      exchange_rate_note: offerAny.exchange_rate_note ?? null,
    };

    // 7. Enforce monthly_documents quota (parity with POST /api/invoices)
    {
      const { enforceQuota } = await import("@/lib/api/plan-limits");
      const denied = await enforceQuota(tid, "monthly_documents", auth.isSuperAdmin);
      if (denied) return denied;
    }

    // 8. Create the invoice
    const created = await store.upsertInvoice(invoiceData);

    // 9. Audit log
    await audit(
      store,
      auth.user,
      req,
      "automation.create_invoice_from_offer",
      "invoice",
      created.id,
      {
        offer_id: offer.id,
        offer_number: offer.number,
        invoice_number: created.number,
        partner_id: offer.partner_id,
        partner_name: partner.name,
        total: offer.total,
        currency: offer.currency,
      }
    );

    return NextResponse.json(created);
  } catch (e) {
    console.error("[automation/create-invoice-from-offer]", e);
    return NextResponse.json(
      { error: "Failed to create invoice from offer." },
      { status: 500 }
    );
  }
}
