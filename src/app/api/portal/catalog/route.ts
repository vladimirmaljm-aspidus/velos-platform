import { NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { requireGpsVerified } from "@/lib/portal/require-gps";
import { getStore } from "@/lib/data/store";
import { redactListForPortal } from "@/lib/portal/redact";
import type { Product, ProductCatalogEntry } from "@/lib/supabase/types";
import { sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * Portal catalog = admin-curated view of what the tenant offers to clients.
 *
 * Single source of truth: the `products` table where `show_in_catalog=true`
 * AND `active=true`. Each product carries its full trade metadata (HS code,
 * brand, coa_params, detailed_spec, logistics, shelf_life, …) so a separate
 * product_catalog table is no longer needed.
 *
 * FIX-PRODUCTS-DOCS / Fix 9 — the legacy `product_catalog` table + the
 * /api/product-catalog routes + the product-catalog-view.tsx admin UI are
 * deprecated. They are kept for backward compatibility with existing
 * catalog entries that have not yet been migrated to Products, but they
 * have NO effect on what the portal catalog returns. Admins curate
 * portal visibility via the per-row `show_in_catalog` toggle on the
 * Products view (PUT /api/products/[id] with { show_in_catalog: bool }).
 *
 * No cost / price / margin is exposed — redactListForPortal strips it.
 */
function productToCatalogShape(p: Product): ProductCatalogEntry {
  return {
    id: p.id,
    tenant_id: (p.tenant_id ?? "") as string,
    name: p.name,
    category: p.category || "other",
    hs_code: p.hs_code ?? null,
    description: p.description,
    base_unit: p.unit || "pc",
    // coa_params on the Product replaces the old `specifications` field on
    // ProductCatalogEntry — they represent the same key/value spec data.
    // FIX-P1-1: previously this was always `null`, hiding the trade metadata
    // from portal clients. We now expose the four structured spec fields.
    // Cast via `unknown` because the catalog-entry type models specs as
    // `Record<string, string>` (legacy shape) — the UI normalizer
    // (portal-catalog.tsx) already String()-coerces each value, so richer
    // JSON values are safe to pass through here.
    specifications: {
      coa_params: p.coa_params || null,
      detailed_spec: p.detailed_spec || null,
      logistics: p.logistics || null,
      shelf_life: p.shelf_life || null,
    } as unknown as ProductCatalogEntry["specifications"],
    // The `products` table doesn't have an `origin_country` column yet —
    // fall back to the workaround where origin is stored inside the JSONB
    // `attributes` field. Treated as best-effort.
    origin_country:
      (p.origin_country as string | null | undefined) ??
      (p.attributes && "origin_country" in p.attributes
        ? (p.attributes.origin_country as string | null)
        : null) ??
      null,
    images: p.image_url ? [p.image_url] : null,
    active: p.active,
    brand: p.brand ?? null,
    coa_params: p.coa_params ?? null,
    detailed_spec: p.detailed_spec ?? null,
    image_url: p.image_url ?? null,
    inventory: p.inventory ?? null,
    logistics: p.logistics ?? null,
    old_id: p.old_id ?? null,
    shelf_life: p.shelf_life ?? null,
    sku: p.sku ?? null,
    tags: p.tags ?? null,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

export async function GET() {
  try {
    const access = await getPortalSessionAccess();
    if (!access) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    if (!access.can_view_catalog) return NextResponse.json({ error: "Not permitted." }, { status: 403 });
    const kycBlock = await requireKycApproved(access);
    if (kycBlock) return kycBlock;
    const _gpsBlock = await requireGpsVerified(access);
    if (_gpsBlock) return _gpsBlock;

    const store = await getStore();
    // Pull a generous slice of products for this tenant, then filter to the
    // admin-curated subset. (Portal clients only see products the tenant has
    // explicitly opted in via `show_in_catalog=true` AND `active=true`.)
    const productsRes = await store.listProducts(access.tenant_id, { limit: 1000 });
    const catalogItems: ProductCatalogEntry[] = productsRes.items
      .filter((p) => p.show_in_catalog && p.active)
      .map((p) => productToCatalogShape(p));

    return NextResponse.json(redactListForPortal({ items: catalogItems, total: catalogItems.length }));
  } catch (e: any) {
    console.error("[portal/catalog]", e);
    return NextResponse.json(
      { error: sanitizeError(e)},
      { status: 500 },
    );
  }
}
