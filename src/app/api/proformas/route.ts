import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey, resolveTenantId, hasPermission, audit, sanitizeError, type AuthContext, type ApiKeyAuthContext } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
// FIX-PRODUCTS-DOCS / Fix 4 — XSS prevention on free-text fields (parity
// with offers POST). Proforma PDFs render subject/notes/payment_terms via
// dangerouslySetInnerHTML, so escape <, >, ", ' here.
import { sanitizeFields } from "@/lib/security/sanitize-input";

export const runtime = "nodejs";

function getAuthUser(auth: AuthContext | ApiKeyAuthContext) {
  if ("user" in auth) return auth.user;
  return { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (proformas.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "proformas.read"); if (_d) return _d; } } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_finance", _isSA); if (_f) return _f; } /* requireFeature wired */

    const tid = resolveTenantId(auth, req);

    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "proformas:read")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }

    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const partner_id = url.searchParams.get("partner_id") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const limit = url.searchParams.get("limit") ? Math.min(Number(url.searchParams.get("limit")), 500) : undefined;
    const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined;
    const result = await auth.store.listProformas(tid!, { search, filters: { partner_id, status }, limit, offset });
    // Defense-in-depth: even though SupabaseStore filters by tenant_id,
    // this post-filter provides an extra safety layer. Do NOT remove.
    const shouldFilter = "apiKeyId" in auth || !auth.isSuperAdmin;
    if (shouldFilter && auth.tenantId) {
      const before = result.items.length;
      result.items = result.items.filter((p) => p.tenant_id === auth.tenantId);
      result.total = result.total - (before - result.items.length);
    }
    return NextResponse.json(result);
  } catch (error: any) {
    console.error("[proformas GET]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (proformas.create)
  { const { requirePermission } = await import("@/lib/permissions/can");
    if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "proformas.create"); if (_d) return _d; } } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_finance", _isSA); if (_f) return _f; } /* requireFeature wired */

    const tid = resolveTenantId(auth, req);

    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "proformas:write")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }

    // FIX-PRODUCTS-DOCS / Fix 4 (a) — JSON body try/catch. `await req.json()`
    // throws on malformed JSON → previously surfaced as a 500. Wrap it so
    // a syntactically-invalid body surfaces as a clean 400 (parity with
    // offers POST lines 84-89).
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    // FIX-PRODUCTS-DOCS / Fix 4 (b) — required-fields check. partner_id
    // and items[] are NOT NULL on the proformas table; surface a clean
    // 400 listing the missing fields BEFORE we hit the DB. Skip when
    // body.id is present (this is an UPDATE-style upsert, not a create).
    if (!body.id) {
      const missing: string[] = [];
      if (!body.partner_id) missing.push("partner_id");
      if (!Array.isArray(body.items) || body.items.length === 0) missing.push("items");
      if (missing.length > 0) {
        return NextResponse.json(
          { error: `Missing required field(s): ${missing.join(", ")}.` },
          { status: 400 },
        );
      }
      // FIX-PRODUCTS-DOCS / Fix 4 (c) — per-line validation. Each item
      // must have non-negative quantity + unit_price; a negative price
      // would pass the NOT NULL check but distort the totals.
      for (let i = 0; i < body.items.length; i++) {
        const it = body.items[i];
        const qty = Number(it.quantity);
        const price = Number(it.unit_price);
        if (!Number.isFinite(qty) || qty < 0) {
          return NextResponse.json(
            { error: `items[${i}].quantity must be a non-negative number.` },
            { status: 400 },
          );
        }
        if (!Number.isFinite(price) || price < 0) {
          return NextResponse.json(
            { error: `items[${i}].unit_price must be a non-negative number.` },
            { status: 400 },
          );
        }
      }
    }

    // FIX-PRODUCTS-DOCS / Fix 4 (d) / Fix 6 — ISO 4217 currency validation.
    // Reject unknown codes BEFORE the upsert. Skip when currency is
    // absent (the caller is updating a row that already has a currency,
    // or the DB default surface handles the NOT NULL constraint).
    if (body.currency !== undefined && body.currency !== null && body.currency !== "") {
      const { CURRENCY_CODES } = await import("@/lib/data/reference");
      if (!CURRENCY_CODES.includes(body.currency)) {
        return NextResponse.json(
          { error: `Invalid currency code: ${body.currency}. Must be one of: ${CURRENCY_CODES.join(", ")}.` },
          { status: 400 },
        );
      }
    }

    // FIX-PRODUCTS-DOCS / Fix 4 (e) — XSS prevention on free-text fields.
    // Proforma PDFs render subject/notes/terms/payment_terms/bank_details
    // via dangerouslySetInnerHTML, so escape <, >, ", ' here.
    body = sanitizeFields(body, [
      "subject",
      "notes",
      "terms",
      "payment_terms",
      "bank_details",
    ]);
    if (Array.isArray(body.items)) {
      body.items = body.items.map((it: any) => sanitizeFields(it, [
        "description", "detailed_spec", "brand", "sku", "hs_code",
        "origin_country", "notes", "subject", "unit",
      ]));
    }

    body.tenant_id = tid!;
    if (!body.id) {
      const isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
      const { enforceQuota } = await import("@/lib/api/plan-limits");
      const denied = await enforceQuota(tid, "monthly_documents", isSA);
      if (denied) return denied;
    }

    // CRITICAL FIX (audit P1-12): partner_id must belong to the caller's
    // tenant. Without this a super-admin (tid resolves to their own tenant)
    // or an API key could attach a proforma to a partner owned by another
    // tenant by passing that partner's UUID.
    if (body.partner_id) {
      const partner = await auth.store.getPartner(body.partner_id);
      if (partner && partner.tenant_id !== tid) {
        return NextResponse.json({ error: "Partner not found." }, { status: 404 });
      }
    }

    // FIX-PRODUCTS-DOCS / Fix 7 — when body.offer_id is provided, verify
    // it belongs to the caller's tenant. The /api/automation route DOES
    // check (create-proforma-from-offer:49-52), but the direct POST route
    // did NOT — an admin could attach a proforma to another tenant's offer
    // via the API. Allow null/empty (proforma not linked to an offer)
    // without a lookup.
    if (body.offer_id) {
      const offer = await auth.store.getOffer(body.offer_id);
      if (!offer || offer.tenant_id !== tid) {
        return NextResponse.json({ error: "Offer not found." }, { status: 404 });
      }
    }

    // CRITICAL FIX (audit P1-11): recompute totals from line items — never trust
    // client-supplied totals (parity with PUT routes and offers POST).
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

    // Auto-generate document number if not provided (e.g. manual "Create" click).
    // P1 (VAT compliance) / task C-4 Fix 1: use the atomic
    // `createDocWithNumber` path which calls `nextval()` and INSERTs the
    // row in a single Postgres function call (migration 032 RPC), so the
    // sequence value is allocated only when the INSERT is actually
    // attempted — minimising VAT-sequence gaps that the legacy two-step
    // pattern (nextDocNumber() → upsertProforma()) produced whenever the
    // upsert failed after nextval().
    //   Format: PRO-<year>-<NNNN>  (4-digit sequence)
    // When the client supplied an explicit `number` (rare, e.g. an admin
    // overriding the auto-gen), or when updating an existing record
    // (body.id present), we skip the atomic path and use the regular
    // upsertProforma so the client's number is respected.
    const useAtomicCreate = !body.id && !body.number;

    let created;
    if (useAtomicCreate) {
      // Atomic path: nextval() + INSERT in a single RPC. Removes the
      // unique-collision retry loop (the legacy loop bumped `body.number`
      // by +1 on collision, which could collide with the next legitimate
      // nextval() and burn another sequence value — cascading gaps).
      try {
        created = await auth.store.createDocWithNumber("proforma", body as Record<string, unknown>) as any;
      } catch (e: any) {
        console.error("[proformas.post] atomic create failed:", e);
        return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
      }
    } else {
      try {
        created = await auth.store.upsertProforma(body);
      } catch (e: any) {
        // Legacy retry-on-collision removed: the atomic path above handles
        // the auto-number case; this branch only runs when the client
        // supplied an explicit `number` or `id`, in which case a unique
        // collision is a genuine conflict that should surface as a 500
        // (not be silently retried with a bumped number).
        console.error("[proformas.post] upsert failed:", e);
        return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
      }
    }
    await audit(auth.store, getAuthUser(auth), req, body.id ? "proforma.update" : "proforma.create", "proforma", created.id, { number: created.number });
    return NextResponse.json(created);
  } catch (error: any) {
    console.error("[proformas POST]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
