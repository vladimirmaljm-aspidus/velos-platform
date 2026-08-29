import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { nextDocNumber } from "@/lib/api/doc-number";
import { CURRENCY_CODES } from "@/lib/data/reference";
import type { LetterOfIntent } from "@/lib/supabase/types";

export const runtime = "nodejs";

/**
 * GET /api/lois — list LOIs for the caller's tenant.
 * Supports ?search=, ?status=, ?partner_id=, ?deal_id= filters.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    const tid = auth.isSuperAdmin
      ? req.nextUrl.searchParams.get("tenant_id") || auth.tenantId || ""
      : auth.tenantId || "";
    if (!tid) return NextResponse.json({ items: [], total: 0 });

    const store = await getStore();
    const search = req.nextUrl.searchParams.get("search") || undefined;
    const status = req.nextUrl.searchParams.get("status") || undefined;
    const partnerId = req.nextUrl.searchParams.get("partner_id") || undefined;
    const dealId = req.nextUrl.searchParams.get("deal_id") || undefined;
    const result = await store.listLois(tid, {
      search: search || undefined,
      filters: {
        ...(status ? { status } : {}),
        ...(partnerId ? { partner_id: partnerId } : {}),
        ...(dealId ? { deal_id: dealId } : {}),
      },
    });
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("[lois.list]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

/**
 * POST /api/lois — create a new LOI.
 * Validates: partner_id (required + tenant ownership), buyer_name, subject,
 * product_name, quantity > 0, unit_price > 0, currency (ISO 4217),
 * validity_until (required, future date), unit. Generates LOI number atomically.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Super-admin can specify tenant_id in the body; regular users use their
    // own tenant. This lets the super-admin create LOIs for any tenant.
    let tid = auth.tenantId || "";
    if (!tid && auth.isSuperAdmin) {
      // Parse body early to read tenant_id (re-read later for the full body).
      // We use a peek approach: clone the request body.
      const cloned = req.clone();
      try {
        const peek = await cloned.json().catch(() => ({}));
        if (peek.tenant_id) tid = peek.tenant_id;
      } catch { /* ignore — full parse below will fail with 400 if invalid */ }
    }
    if (!tid) return NextResponse.json({ error: "No tenant." }, { status: 400 });

    // Permission gate
    {
      const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "documents.create");
      if (_d) return _d;
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    // Required: partner_id (the seller)
    if (!body.partner_id) return NextResponse.json({ error: "Partner is required." }, { status: 400 });
    if (!body.subject?.trim()) return NextResponse.json({ error: "Subject is required." }, { status: 400 });

    const quantity = Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return NextResponse.json({ error: "Quantity must be a positive number." }, { status: 400 });
    }

    // Currency validation (ISO 4217)
    const currency = String(body.currency || "USD");
    if (!CURRENCY_CODES.includes(currency as any)) {
      return NextResponse.json({ error: "Invalid currency code." }, { status: 400 });
    }

    // Validity date validation
    if (!body.validity_until) {
      return NextResponse.json({ error: "Validity until date is required." }, { status: 400 });
    }
    const validityDate = new Date(body.validity_until);
    if (isNaN(validityDate.getTime())) {
      return NextResponse.json({ error: "Invalid validity date." }, { status: 400 });
    }
    if (validityDate.getTime() < Date.now()) {
      return NextResponse.json({ error: "Validity date must be in the future." }, { status: 400 });
    }

    // Partner tenant ownership check (partner = SELLER)
    const store = await getStore();
    const partner = await store.getPartner(body.partner_id);
    if (!partner || partner.tenant_id !== tid) {
      return NextResponse.json({ error: "Partner not found." }, { status: 404 });
    }

    // ── BUYER = TENANT (always) ─────────────────────────────────────────
    // The LOI logic: the tenant (the logged-in company) IS the buyer — they
    // issue the LOI to express intent to purchase goods from one of their
    // partners (the seller). The buyer_name / buyer_address / buyer_contact
    // fields are auto-populated from the tenant record and CANNOT be
    // overridden by the caller (defence in depth — a tenant can't issue an
    // LOI pretending to be a different buyer).
    const tenant = await store.getTenant(tid);
    if (!tenant) {
      return NextResponse.json({ error: "Tenant not found." }, { status: 400 });
    }
    const buyerName = tenant.legal_name || tenant.name;
    const buyerAddressParts = [
      tenant.address_line,
      tenant.postal_code,
      tenant.city,
      tenant.country,
    ].filter(Boolean);
    const buyerAddress = buyerAddressParts.length > 0 ? buyerAddressParts.join(", ") : null;
    const buyerContact = [tenant.email, tenant.phone].filter(Boolean).join(" — ") || null;

    // ── Optional deal_id ownership check ──────────────────────────────
    if (body.deal_id) {
      const deal = await store.getDeal(body.deal_id);
      if (!deal || deal.tenant_id !== tid) {
        return NextResponse.json({ error: "Deal not found." }, { status: 404 });
      }
    }

    // ── Optional product_id: auto-populate product details from DB ───
    // If the caller passes product_id AND we have the product in our
    // catalog, we auto-fill product_name, product_description, hs_code,
    // origin_country, unit, and unit_price from the product record. The
    // caller can override quantity + unit_price + currency + delivery terms
    // (the LOI-specific fields the buyer negotiates). If the caller also
    // passes explicit product_name etc., those take precedence over the
    // DB values (lets the buyer tweak the description without editing the
    // product catalog).
    let productName = body.product_name?.trim() || "";
    let productDescription = body.product_description?.trim() || null;
    let hsCode = body.hs_code?.trim() || null;
    let originCountry = body.origin_country?.trim() || null;
    let unit = body.unit?.trim() || "";
    let unitPrice = Number(body.unit_price);
    if (body.product_id) {
      const product = await store.getProduct(body.product_id);
      if (product && product.tenant_id === tid) {
        if (!productName) productName = product.name;
        // Build a rich description: product.description + detailed_spec + brand +
        // shelf_life + tags. This gives the LOI PDF a full product specification
        // section without adding new columns to the lois table.
        if (!productDescription) {
          const specParts: string[] = [];
          if (product.description) specParts.push(product.description);
          if ((product as any).detailed_spec) specParts.push((product as any).detailed_spec);
          if ((product as any).brand) specParts.push(`Brand: ${(product as any).brand}`);
          if ((product as any).shelf_life) specParts.push(`Shelf life: ${(product as any).shelf_life}`);
          productDescription = specParts.length > 0 ? specParts.join("\n\n") : null;
        }
        if (!hsCode) hsCode = product.hs_code || null;
        if (!originCountry) originCountry = product.origin_country || (product.attributes as any)?.origin_country || null;
        if (!unit) unit = product.unit;
        if (!Number.isFinite(unitPrice) || unitPrice <= 0) unitPrice = product.price;
      }
    }

    // Re-validate after potential product auto-fill
    if (!productName) return NextResponse.json({ error: "Product name is required (select a product or enter manually)." }, { status: 400 });
    if (!unit) return NextResponse.json({ error: "Unit is required." }, { status: 400 });
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      return NextResponse.json({ error: "Unit price must be a positive number." }, { status: 400 });
    }

    // Generate LOI number atomically (per-tenant, migration 063)
    let number = await nextDocNumber("loi", tid);
    if (!number) {
      // Fallback: LOI-{year}-{count+1}
      const year = new Date().getFullYear();
      const existing = await store.listLois(tid, {});
      const count = existing.total + 1;
      number = `LOI-${year}-${String(count).padStart(4, "0")}`;
    }

    // Server-side total_value recompute
    const totalValue = quantity * unitPrice;

    const created = await store.upsertLoi({
      tenant_id: tid,
      number,
      partner_id: body.partner_id,
      // ── BUYER = TENANT (auto-populated, never from body) ───────────
      buyer_name: buyerName,
      buyer_address: buyerAddress,
      buyer_contact: buyerContact,
      // ── Product (auto-filled from product_id or manually entered) ──
      subject: String(body.subject).trim(),
      product_name: productName,
      product_description: productDescription,
      hs_code: hsCode,
      origin_country: originCountry,
      quantity,
      unit: unit,
      unit_price: unitPrice,
      currency,
      total_value: totalValue,
      delivery_terms: body.delivery_terms?.trim() || null,
      delivery_date: body.delivery_date || null,
      payment_terms: body.payment_terms?.trim() || null,
      validity_until: body.validity_until,
      status: "draft",
      notes: body.notes?.trim() || null,
      terms_text: body.terms_text?.trim() || null,
      created_by: auth.user.id,
      deal_id: body.deal_id || null,
      offer_id: body.offer_id || null,
      product_id: body.product_id || null,
    } as Partial<LetterOfIntent> & { id?: string });

    await audit(auth.store, auth.user, req, "loi.create", "loi", created.id, {
      number: created.number,
      partner_id: created.partner_id,
      subject: created.subject,
    });

    return NextResponse.json(created);
  } catch (e: any) {
    console.error("[lois.create]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
