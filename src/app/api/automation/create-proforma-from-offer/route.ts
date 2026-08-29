import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";
import { nextDocNumber, formatDocNumber } from "@/lib/api/doc-number";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

/**
 * POST /api/automation/create-proforma-from-offer
 *
 * Auto-create a proforma from an offer:
 * - Copy all offer data
 * - Auto-generate proforma number
 * - Auto-fill all partner data
 *
 * Body: { offer_id: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (proformas.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "proformas.create"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance) — proformas are a finance document.
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

    // CRITICAL FIX (audit P1-17): only allow proforma creation from valid
    // offer statuses. A draft or cancelled offer should not be promotable
    // to a proforma — the customer hasn't seen/agreed to it yet.
    // Cast to string because `OfferStatus` doesn't formally include "viewed"
    // (set by the portal when a client first opens the offer — see
    // lib/portal/mark-viewed.ts), but the value exists at runtime and the
    // state machine (status-validator.ts) explicitly allows it.
    const offerStatus: string = offer.status;
    if (offerStatus !== "accepted" && offerStatus !== "sent" && offerStatus !== "viewed") {
      return NextResponse.json(
        { error: `Cannot create proforma from offer in status '${offerStatus}'. Offer must be sent, viewed, or accepted.` },
        { status: 400 },
      );
    }

    // 1b. FIX-P1-LOGIC Fix 2: prevent duplicate proformas for the same offer.
    //     Two clicks on the "create proforma" button must not produce two
    //     proformas — return 409 with the existing proforma's id/number.
    //
    //     Re-Audit-2 N5: exclude cancelled proformas from the duplicate check.
    //     Previously, if you cancelled a proforma and tried to create a new
    //     one from the same offer, you'd get a 409 pointing at the cancelled
    //     record — blocking the workflow.
    //
    //     CRITICAL FIX (audit P1-14): use a targeted SQL query instead of
    //     listProformas(limit:1000) + JS .find(). Avoids the 1000-record cap
    //     and is more efficient.
    {
      const { data: existing } = await getSupabase()
        .from("proformas")
        .select("id, number")
        .eq("tenant_id", tid)
        .eq("offer_id", offer.id)
        .neq("status", "cancelled")
        .limit(1)
        .maybeSingle();
      if (existing) {
        return NextResponse.json(
          {
            error: "A proforma already exists for this offer.",
            existing_proforma_id: (existing as { id: string }).id,
            existing_proforma_number: (existing as { number?: string }).number,
          },
          { status: 409 }
        );
      }
    }

    // 2. Fetch partner data for auto-fill
    const partner = await store.getPartner(offer.partner_id);
    if (!partner) {
      return NextResponse.json(
        { error: "Partner not found for this offer." },
        { status: 404 }
      );
    }

    // 3. Auto-generate proforma number (atomic via Postgres SEQUENCE; falls
    //    back to legacy `listProformas().total + 1` if the RPC is unavailable).
    //    Format: PRO-<year>-<NNNN>  (4-digit sequence)
    //    FIX-PRODUCTS-DOCS / Fix 3 — pass `tid` so nextDocNumber uses the
    //    per-tenant RPC (migration 063). Previously called without a
    //    tenantId → fell through to the GLOBAL sequence → cross-tenant
    //    number leak risk + EU VAT compliance issue.
    const year = new Date().getFullYear();
    const seqNum = await nextDocNumber("proforma", tid);
    let proformaNumber: string;
    if (seqNum) {
      proformaNumber = seqNum;
    } else {
      const existingProformas = await store.listProformas(tid, { limit: 1 });
      const nextSeq = (existingProformas.total || 0) + 1;
      proformaNumber = formatDocNumber("proforma", year, nextSeq);
    }

    // 4. Calculate valid until (typically 30 days from now)
    const issueDate = new Date();
    const validUntil = new Date(issueDate);
    validUntil.setDate(validUntil.getDate() + 30);

    // 5. Build the proforma object
    //
    //    Copy ALL trade-term fields that exist on BOTH the `offers` and
    //    `proformas` tables (supabase-schema-live.sql:766-812 + 1107-1150).
    //    Previously the automation dropped incoterm/pol/pod/vessel/etc.,
    //    silently losing trade data downstream (DEEP-AUDIT-LOGIC §2.1).
    //    `bank_details` is intentionally omitted — it only exists on offers.
    const offerAny = offer as any;
    const proformaData = {
      tenant_id: tid,
      number: proformaNumber,
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
      valid_until: validUntil.toISOString().split("T")[0],
      notes: offer.notes
        ? `Auto-generated from offer: ${offer.number}. ${offer.notes}`
        : `Auto-generated from offer: ${offer.number}`,
      items: offer.items,
      // Trade terms (copied from source offer):
      payment_terms: offerAny.payment_terms ?? null,
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

    // 6. Enforce monthly_documents quota (parity with POST /api/proformas)
    {
      const { enforceQuota } = await import("@/lib/api/plan-limits");
      const denied = await enforceQuota(tid, "monthly_documents", auth.isSuperAdmin);
      if (denied) return denied;
    }

    // 7. Create the proforma
    const created = await store.upsertProforma(proformaData);

    // 8. Audit log
    await audit(
      store,
      auth.user,
      req,
      "automation.create_proforma_from_offer",
      "proforma",
      created.id,
      {
        offer_id: offer.id,
        offer_number: offer.number,
        proforma_number: created.number,
        partner_id: offer.partner_id,
        partner_name: partner.name,
        total: offer.total,
        currency: offer.currency,
      }
    );

    return NextResponse.json(created);
  } catch (e) {
    console.error("[automation/create-proforma-from-offer]", e);
    return NextResponse.json(
      { error: "Failed to create proforma from offer." },
      { status: 500 }
    );
  }
}
