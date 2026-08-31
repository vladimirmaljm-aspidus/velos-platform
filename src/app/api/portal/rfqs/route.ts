import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { getStore } from "@/lib/data/store";
import { notifyRfqReceived } from "@/lib/notif/helper";
import { notifyPortalActivity } from "@/lib/realtime/notify";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { nextDocNumber } from "@/lib/api/doc-number";

export const runtime = "nodejs";

// Portal: list partner's RFQs
// AUDIT2-LOGIC-UX H9 — the GET handler no longer requires can_submit_rfq.
// A portal client whose tier was downgraded (can_submit_rfq=false) must
// still be able to view their past RFQs. The can_submit_rfq gate stays
// on POST only. KYC remains gated on both (unapproved-KYC callers can
// neither list nor submit).
export async function GET() {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const _kycBlock = await requireKycApproved(access);
  if (_kycBlock) return _kycBlock;
  const store = await getStore();
  const rfqs = await store.listPortalRfqsByPartner(access.partner_id);
  return NextResponse.json({ items: rfqs });
}

// Portal: create RFQ
export async function POST(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  if (!access.can_submit_rfq) {
    return NextResponse.json({ error: "RFQ submission not permitted." }, { status: 403 });
  }
  // CRITICAL FIX (audit P1-3): POST was missing the KYC gate that GET has.
  // A partner with can_submit_rfq=true but unapproved KYC could submit RFQs.
  const _kycBlock = await requireKycApproved(access);
  if (_kycBlock) return _kycBlock;
  const store = await getStore();

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  body.partner_id = access.partner_id;
  body.tenant_id = access.tenant_id;
  body.portal_access_id = access.id;
  // CRITICAL FIX (audit T-portal): portal clients must only CREATE, never
  // UPDATE. `upsertPortalRfq` is a smart-upsert keyed on `id`, so a client
  // passing another partner's `id` could silently overwrite their RFQ.
  // Strip any caller-supplied id so a fresh row is always inserted.
  delete body.id;

  // Validate required fields
  if (!body.product_name || typeof body.product_name !== "string" || body.product_name.trim().length === 0) {
    return NextResponse.json({ error: "Product name is required." }, { status: 400 });
  }
  if (body.product_name.length > 500) {
    return NextResponse.json({ error: "Product name is too long." }, { status: 400 });
  }

  // Validate quantity
  const qty = Number(body.quantity);
  if (!Number.isFinite(qty) || qty <= 0 || qty > 1000000000) {
    return NextResponse.json({ error: "Quantity must be a positive number." }, { status: 400 });
  }
  body.quantity = qty;

  // Validate target_price (optional, but if present must be positive)
  if (body.target_price !== undefined && body.target_price !== null && body.target_price !== "") {
    const price = Number(body.target_price);
    if (!Number.isFinite(price) || price < 0 || price > 1000000000) {
      return NextResponse.json({ error: "Target price must be a non-negative number." }, { status: 400 });
    }
    body.target_price = price;
  }

  // Validate delivery_date format if provided (YYYY-MM-DD)
  if (body.delivery_date && typeof body.delivery_date === "string") {
    const d = new Date(body.delivery_date);
    if (isNaN(d.getTime())) {
      return NextResponse.json({ error: "Invalid delivery date." }, { status: 400 });
    }
  }

  // Validate notes length
  if (body.notes && typeof body.notes === "string" && body.notes.length > 5000) {
    return NextResponse.json({ error: "Notes are too long (max 5000 characters)." }, { status: 400 });
  }

  // Auto-generate RFQ number — atomic via Postgres SEQUENCE (C-2).
  // Falls back to the legacy `listRfqsByPartner(year).length + 1` if the
  // `get_next_doc_number('rfq')` RPC isn't available (e.g. before the
  // SQL migration adding the `rfq_number_seq` sequence has been applied).
  //   Format: RFQ-YYYY-NNNN (4-digit zero-padded sequence)
  //   Note: the previous 3-digit format (RFQ-YYYY-NNN) is preserved for
  //   legacy rows; new RFQs minted through the RPC will be 4-digit padded.
  const year = new Date().getFullYear();
  // FIX-PRODUCTS-DOCS / Fix 3 — pass `access.tenant_id` so nextDocNumber
  // uses the per-tenant RPC (migration 063). Previously called without a
  // tenantId → fell through to the GLOBAL sequence → cross-tenant
  // number leak risk + EU VAT compliance issue.
  const seqNum = await nextDocNumber("rfq", access.tenant_id);
  if (seqNum) {
    body.number = seqNum;
  } else {
    const existingRfqs = await store.listPortalRfqsByPartner(access.partner_id);
    const yearRfqs = existingRfqs.filter((r: any) => r.number?.includes(`RFQ-${year}`));
    const nextNum = yearRfqs.length + 1;
    body.number = `RFQ-${year}-${String(nextNum).padStart(3, "0")}`;
  }

  // Set default status
  if (!body.status) body.status = "pending";

  try {
    const created = await store.upsertPortalRfq(body);

    // Audit the RFQ creation
    try {
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "portal.rfq_created",
        "portal_rfq",
        (created as any)?.id,
        { product_name: body.product_name, quantity: body.quantity, number: body.number },
      );
    } catch (e) { console.error("[audit]", e); }

    // Notify tenant admins
    const partner = await store.getPartner(access.partner_id);
    await notifyRfqReceived(access.tenant_id, partner?.name || "A client", body.product_name || "a product", created.id);

    // ── D-4: real-time push to tenant admins ───────────────────────────────
    // Fire-and-forget. The persisted notification above is the source of
    // truth; this push just makes the bell badge increment instantly so an
    // admin watching the SPA sees the new RFQ without waiting for the next
    // 30s poll (now disabled — see topbar.tsx).
    void notifyPortalActivity(access.tenant_id, {
      type: "rfq",
      rfqId: created.id,
      rfqNumber: body.number,
      partnerId: access.partner_id,
      partnerName: partner?.name || null,
      productName: body.product_name || null,
      quantity: body.quantity,
    });

    return NextResponse.json(created);
  } catch (e: any) {
    console.error("[portal.rfqs.create]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}
