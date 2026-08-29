import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";
import { nextDocNumber, formatDocNumber } from "@/lib/api/doc-number";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

/**
 * POST /api/automation/create-invoice-from-proforma
 *
 * Auto-create an invoice from an accepted proforma (linear flow:
 * Offer → Proforma → Invoice):
 *   - Copies all proforma data (partner, items, totals, trade fields)
 *   - Auto-generates invoice number (INV-YYYY-NNNN)
 *   - Sets due date based on payment terms (default: net 30)
 *   - Sets status to "draft"
 *   - Chains offer_id back to the original offer (when the proforma has one)
 *
 * Body: { proforma_id: string }
 *
 * NOTE: the live `invoices` table has no `proforma_id` column, so we link
 * back to the original `offer_id` instead (which the proforma already
 * carries). The downstream "invoice paid → proforma paid" cascade resolves
 * the proforma via that offer_id chain.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  // Permission gate (invoices.create)
  {
    const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "invoices.create");
    if (_d) return _d;
  }

  // Feature gate (module_finance)
  {
    const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin);
    if (_f) return _f;
  }

  const tid = resolveTenantId(auth, req);
  if (!tid) {
    return NextResponse.json({ error: "No tenant context." }, { status: 400 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { proforma_id } = body;
  if (!proforma_id) {
    return NextResponse.json({ error: "proforma_id is required." }, { status: 400 });
  }

  try {
    const store = auth.store;

    // 1. Fetch the proforma (with tenant ownership check)
    const proforma = await store.getProforma(proforma_id);
    if (!proforma) {
      return NextResponse.json({ error: "Proforma not found." }, { status: 404 });
    }
    if (!auth.isSuperAdmin && proforma.tenant_id !== tid) {
      return NextResponse.json({ error: "Proforma not found." }, { status: 404 });
    }

    // 2. Verify proforma is in a valid state. Proformas can be invoiced once
    //    they have been accepted by the client. We also allow invoicing from a
    //    "sent" or "viewed" proforma (without an explicit accept step) as a
    //    fallback for workflows where the verbal agreement is enough.
    //    CRITICAL FIX (audit P2-16): removed "paid" from the allowed list — a
    //    paid proforma has already been invoiced, so allowing a re-invoice
    //    here would silently create a duplicate receivable.
    //    Cast to string because `ProformaStatus` doesn't formally include
    //    "viewed" (set by the portal when a client first opens the proforma —
    //    see lib/portal/mark-viewed.ts), but the value exists at runtime and
    //    the state machine (status-validator.ts) explicitly allows it.
    const proformaStatus: string = proforma.status;
    if (
      proformaStatus !== "accepted" &&
      proformaStatus !== "sent" &&
      proformaStatus !== "viewed"
    ) {
      return NextResponse.json(
        {
          error: `Cannot create invoice from proforma with status "${proformaStatus}". Proforma must be sent, viewed, or accepted first.`,
        },
        { status: 400 },
      );
    }

    // 3. Check if an invoice already exists for this proforma.
    //    The `invoices` table has no `proforma_id` column, so we link via the
    //    shared `offer_id` (when present). When the proforma has no offer
    //    link, we fall back to checking by partner+subject to avoid dupes.
    //
    //    CRITICAL FIX (audit P1-14): use a targeted SQL query instead of
    //    listInvoices(limit:1000) + JS .find(). Avoids the 1000-record cap
    //    and is more efficient. We use one of two queries depending on
    //    whether the proforma carries an offer_id.
    const pAny = proforma as any;
    let dupQuery = getSupabase()
      .from("invoices")
      .select("id, number")
      .eq("tenant_id", tid)
      .neq("status", "cancelled")
      .limit(1);
    if (pAny.offer_id) {
      dupQuery = dupQuery.eq("offer_id", pAny.offer_id);
    } else {
      dupQuery = dupQuery
        .eq("partner_id", proforma.partner_id)
        .eq("subject", proforma.subject ?? "");
    }
    const { data: alreadyInvoiced } = await dupQuery.maybeSingle();
    if (alreadyInvoiced) {
      const existing = alreadyInvoiced as { id: string; number?: string };
      return NextResponse.json(
        {
          error: "Invoice already exists for this proforma.",
          existing_invoice_id: existing.id,
          existing_invoice_number: existing.number,
        },
        { status: 409 },
      );
    }

    // 4. Auto-generate invoice number (atomic via Postgres SEQUENCE; falls
    //    back to a targeted COUNT query if the RPC is unavailable).
    //    Format: INV-<year>-<NNNN>  (4-digit sequence).
    //    CRITICAL FIX (audit P1-13): use targeted COUNT instead of
    //    listInvoices(limit:1).total — the year-aware count also keeps the
    //    reset-at-year-boundary behaviour from audit P2-20.
    const year = new Date().getFullYear();
    // FIX-PRODUCTS-DOCS / Fix 3 — pass `tid` so nextDocNumber uses the
    // per-tenant RPC (migration 063). Previously called without a
    // tenantId → fell through to the GLOBAL sequence → cross-tenant
    // number leak risk + EU VAT compliance issue.
    const seqNum = await nextDocNumber("invoice", tid);
    let invoiceNumber: string;
    if (seqNum) {
      invoiceNumber = seqNum;
    } else {
      const { count } = await getSupabase()
        .from("invoices")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tid)
        .like("number", `INV-${year}-%`);
      const nextSeq = (count || 0) + 1;
      invoiceNumber = formatDocNumber("invoice", year, nextSeq);
    }

    // 5. Calculate due date based on payment terms (default: net 30)
    const issueDate = new Date();
    let dueDate = new Date(issueDate);
    const paymentTerms = (proforma as any).payment_terms || "net30";
    const netMatch = String(paymentTerms).match(/net\s*(\d+)/i);
    if (netMatch) {
      dueDate.setDate(dueDate.getDate() + parseInt(netMatch[1], 10));
    } else if (
      String(paymentTerms).toLowerCase().trim() === "immediate" ||
      String(paymentTerms).toLowerCase().trim() === "advance"
    ) {
      // Due immediately
    } else {
      dueDate.setDate(dueDate.getDate() + 30);
    }

    // 6. Enforce monthly_documents quota (parity with POST /api/invoices)
    {
      const { enforceQuota } = await import("@/lib/api/plan-limits");
      const denied = await enforceQuota(tid, "monthly_documents", auth.isSuperAdmin);
      if (denied) return denied;
    }

    // 7. Build the invoice object. Copy partner/items/totals + the trade
    //    fields that exist on both `proformas` and `invoices` tables
    //    (supabase-schema-live.sql:496-545 + 1107-1150). Previously this
    //    block copied only the core 8 trade fields and dropped the
    //    country/delivery/spec/exchange-rate fields (DEEP-AUDIT-LOGIC §2.3).
    //    Skip `bank_details`/`terms` (offers-only columns) and
    //    `proforma_id` (no such column on invoices).
    const invoiceData: Record<string, unknown> = {
      tenant_id: tid,
      number: invoiceNumber,
      partner_id: proforma.partner_id,
      offer_id: proforma.offer_id, // chain back to the original offer
      subject: proforma.subject,
      currency: proforma.currency,
      items: proforma.items,
      subtotal: proforma.subtotal,
      discount_total: proforma.discount_total,
      tax_total: proforma.tax_total,
      total: proforma.total,
      status: "draft",
      issue_date: issueDate.toISOString().split("T")[0],
      due_date: dueDate.toISOString().split("T")[0],
      payment_terms: pAny.payment_terms ?? null,
      incoterm: pAny.incoterm ?? null,
      pol: pAny.pol ?? null,
      pol_country: pAny.pol_country ?? null,
      pod: pAny.pod ?? null,
      pod_country: pAny.pod_country ?? null,
      vessel: pAny.vessel ?? null,
      container_no: pAny.container_no ?? null,
      lead_time: pAny.lead_time ?? null,
      packaging: pAny.packaging ?? null,
      delivery_address: pAny.delivery_address ?? null,
      delivery_city: pAny.delivery_city ?? null,
      delivery_country: pAny.delivery_country ?? null,
      specification: pAny.specification ?? null,
      origin_country: pAny.origin_country ?? null,
      exchange_rate: pAny.exchange_rate ?? null,
      exchange_rate_date: pAny.exchange_rate_date ?? null,
      exchange_rate_note: pAny.exchange_rate_note ?? null,
      notes: `Auto-generated from proforma: ${proforma.number}${
        proforma.notes ? `. ${proforma.notes}` : ""
      }`,
    };

    // 8. Create the invoice
    const created = await store.upsertInvoice(invoiceData as any);

    // 9. Audit log
    await audit(
      store,
      auth.user,
      req,
      "automation.create_invoice_from_proforma",
      "invoice",
      created.id,
      {
        proforma_id: proforma.id,
        proforma_number: proforma.number,
        invoice_number: created.number,
        partner_id: proforma.partner_id,
        offer_id: proforma.offer_id,
        total: proforma.total,
        currency: proforma.currency,
      },
    );

    return NextResponse.json(created);
  } catch (e: any) {
    console.error("[automation/create-invoice-from-proforma]", e);
    return NextResponse.json(
      { error: e?.message || "Failed to create invoice from proforma." },
      { status: 500 },
    );
  }
}
