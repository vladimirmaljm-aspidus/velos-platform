import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAuthOrApiKey, requireAuthOrApiKeyPermission, audit, resolveTenantId, sanitizeError } from "@/lib/api/helpers";
// 31-f — shared request-body validation helpers (audit 30-a findings
// 30a-07/30a-08: POST {} → supplier_offers NOT NULL violation → 500, and
// {unit_price: "cheap"} → PostgREST 22P02 numeric cast → 500 "Invalid
// input format."; now clean 400s before the DB write).
import { requireFields, assertNumeric } from "@/lib/api/validate";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuthOrApiKey(req);
  if (auth instanceof NextResponse) return auth;
  // U-FIX (RBAC audit D-1): gate BOTH session AND API-key callers.
  // Supplier-offers expose supplier cost data (cost, currency, lead
  // time) — the upstream side of margin calculations. Previously any
  // API key could list these.
  const denied = requireAuthOrApiKeyPermission(auth, "supplier-offers.read");
  if (denied) return denied;
  // Feature gate (module_trade)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(auth.tenantId, "module_trade", isSA); if (_f) return _f; } /* requireFeature wired */

  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ items: [], total: 0 });
  const url = new URL(req.url);
  const search = url.searchParams.get("search") || undefined;
  const product_id = url.searchParams.get("product_id") || undefined;
  const supplier_id = url.searchParams.get("supplier_id") || undefined;
  const status = url.searchParams.get("status") || undefined;
  // S-FIX / pagination: previously this route ignored `limit` and `offset`
  // entirely — `listSupplierOffers` fell back to its default (limit=50,
  // offset=0), so every "next page" request returned the same 50 rows.
  // Now parse and forward to the store, capping at the standard UI limit
  // (500). This matches the pattern used by /api/products, /api/deals,
  // /api/offers, etc.
  const limit = url.searchParams.get("limit")
    ? Math.min(Number(url.searchParams.get("limit")), 500)
    : undefined;
  const offset = url.searchParams.get("offset")
    ? Number(url.searchParams.get("offset"))
    : undefined;
  const result = await auth.store.listSupplierOffers(tenantId, {
    search,
    limit,
    offset,
    filters: { product_id, supplier_id, status },
  });
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (supplier-offers.create)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "supplier-offers.create"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_trade)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_trade", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ error: "No tenant context." }, { status: 400 });
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  // 31-f — required-field + numeric validation BEFORE the upsert (audit
  // 30a-08: POST {} → 500 "Missing required field."; 30a-07:
  // {unit_price: "cheap"} → 500 "Invalid input format."). product_id /
  // supplier_id / unit_price are NOT NULL with no DB defaults (status,
  // currency, incoterm have defaults). Skipped on the update path
  // (body.id) — the existing row already satisfies NOT NULL.
  if (!body.id) {
    const bad = requireFields(body, ["product_id", "supplier_id", "unit_price"]);
    if (bad) return bad;
  }
  // unit_price / min_order_qty / lead_time_days are numeric columns — a
  // non-numeric string is a PostgREST 22P02, so coerce-or-400 up front.
  {
    const bad = assertNumeric(body, ["unit_price", "min_order_qty", "lead_time_days"]);
    if (bad) return bad;
  }
  body.tenant_id = tenantId;

  // ── Tenant-ownership validation (audit F-6/P1-5 IDOR) ────────────────
  // Without this check, an authenticated user could pass another tenant's
  // `supplier_id` or `product_id` and create a supplier_offer row that
  // cross-references another tenant's data. The DB has no FK constraint
  // enforcing tenant scoping across these tables, so the API MUST
  // validate ownership explicitly. Super-admins bypass (they can mix
  // cross-tenant records for platform-level operations).
  if (!auth.isSuperAdmin) {
    if (body.supplier_id) {
      const supplier = await auth.store.getPartner(body.supplier_id);
      if (!supplier || supplier.tenant_id !== tenantId) {
        return NextResponse.json({ error: "Invalid supplier — does not belong to your tenant." }, { status: 400 });
      }
    }
    if (body.product_id) {
      const product = await auth.store.getProduct(body.product_id);
      if (!product || product.tenant_id !== tenantId) {
        return NextResponse.json({ error: "Invalid product — does not belong to your tenant." }, { status: 400 });
      }
    }
  }

  let created;
  try {
    created = await auth.store.upsertSupplierOffer(body);
  } catch (e) {
    return NextResponse.json(
      { error: sanitizeError(e) },
      { status: 500 },
    );
  }
  await audit(auth.store, auth.user, req, body.id ? "supplier_offer.update" : "supplier_offer.create", "supplier_offer", created.id, {});
  return NextResponse.json(created);
}
