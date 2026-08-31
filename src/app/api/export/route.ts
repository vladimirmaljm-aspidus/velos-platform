import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthOrApiKey,
  resolveTenantId,
  hasPermission,
  sanitizeError,
} from "@/lib/api/helpers";
import { toCSV, csvResponse, parseExportParams } from "@/lib/export/csv";

export const runtime = "nodejs";

/**
 * GET /api/export?type=products&format=csv&ids=id1,id2,id3
 *
 * Unified export endpoint. Supports four entity types and an optional
 * `ids` query param to export a specific subset (e.g. the rows currently
 * selected in a list view's bulk action bar). When `ids` is omitted, the
 * whole tenant-scoped list is exported (capped at 10,000 rows for safety).
 *
 * This complements the existing per-entity export routes
 * (`/api/offers/export`, `/api/products/export`, etc.) which always export
 * the full list. Those routes remain the primary export entry points for
 * "Export all" buttons; this route is the entry point for "Export
 * selected" buttons in the bulk action bar.
 *
 * Supported types: products | partners | offers | invoices
 */
const COLUMNS: Record<string, string[]> = {
  products: [
    "sku", "name", "category", "unit", "price", "currency",
    "cost", "stock", "reorder_level", "active", "show_in_catalog", "hs_code",
    "brand", "description", "created_at",
  ],
  partners: [
    "name", "type", "entity_type", "email", "phone", "country", "city",
    "state", "postal_code", "address_line", "tax_id", "vat_number",
    "contact_name", "contact_email", "contact_phone", "status", "risk_score",
    "kyc_status", "portal_enabled", "portal_level", "preferred_currency",
    "preferred_incoterm", "preferred_payment_terms", "industry", "website",
    "bank_name", "bank_account", "bank_swift", "bank_iban",
    "created_at",
  ],
  offers: [
    "number", "partner_id", "status", "subject", "currency",
    "subtotal", "discount_total", "tax_total", "total",
    "valid_until", "sent_at", "accepted_at", "created_at",
  ],
  invoices: [
    "number", "partner_id", "status", "subject", "currency",
    "subtotal", "discount_total", "tax_total", "total",
    "issue_date", "due_date", "sent_at", "paid_at", "created_at",
  ],
};

const PERMISSION_KEY: Record<string, string> = {
  products: "products:read",
  partners: "partners:read",
  offers: "offers:read",
  invoices: "invoices:read",
};

const ROLE_PERMISSION_KEY: Record<string, string> = {
  products: "products.read",
  partners: "partners.read",
  offers: "offers.read",
  invoices: "invoices.read",
};

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;

    const url = new URL(req.url);
    const type = (url.searchParams.get("type") || "products").toLowerCase();
    const format = (url.searchParams.get("format") || "csv").toLowerCase();
    const idsParam = url.searchParams.get("ids");
    const ids = idsParam
      ? idsParam.split(",").map((s) => s.trim()).filter(Boolean)
      : null;

    if (!COLUMNS[type]) {
      return NextResponse.json(
        { error: `Unsupported export type: ${type}. Supported: ${Object.keys(COLUMNS).join(", ")}.` },
        { status: 400 },
      );
    }

    // Permission gates (mirror the per-entity export routes).
    if ("apiKeyId" in auth) {
      if (!hasPermission(auth.permissions, PERMISSION_KEY[type])) {
        return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
      }
    } else {
      const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, ROLE_PERMISSION_KEY[type]);
      if (_d) return _d;
    }

    // Feature gates — offers/invoices belong to trade/finance modules.
    if (type === "offers" || type === "invoices") {
      const { requireFeature } = await import("@/lib/api/feature-guard");
      const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
      const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
      const moduleFlag = type === "offers" ? "module_trade" : "module_finance";
      const _f = await requireFeature(_tid, moduleFlag, _isSA);
      if (_f) return _f;
    }

    const tid = resolveTenantId(auth, req);
    if (!tid) {
      // Super-admin without a tenant scope — return empty CSV rather than 500.
      return csvResponse(`${type}-empty.csv`, "");
    }

    // Fetch tenant-scoped list. Cap at 10k rows (matches per-entity export routes).
    let items: Record<string, unknown>[] = [];
    switch (type) {
      case "products": {
        const r = await auth.store.listProducts(tid, { limit: 10000 });
        items = r.items as unknown as Record<string, unknown>[];
        break;
      }
      case "partners": {
        const r = await auth.store.listPartners(tid, { limit: 10000 });
        items = r.items as unknown as Record<string, unknown>[];
        break;
      }
      case "offers": {
        const r = await auth.store.listOffers(tid, { limit: 10000 });
        items = r.items as unknown as Record<string, unknown>[];
        break;
      }
      case "invoices": {
        const r = await auth.store.listInvoices(tid, { limit: 10000 });
        items = r.items as unknown as Record<string, unknown>[];
        break;
      }
    }

    // Defense-in-depth: strip rows whose tenant_id doesn't match the caller's
    // (mirrors the post-filter pattern in the GET list routes).
    const shouldFilter = "apiKeyId" in auth || !auth.isSuperAdmin;
    if (shouldFilter && auth.tenantId) {
      items = items.filter((it) => (it as { tenant_id?: string }).tenant_id === auth.tenantId);
    }

    // Filter to the requested subset.
    if (ids && ids.length > 0) {
      const idSet = new Set(ids);
      items = items.filter((it) => {
        const itemId = (it as { id?: string }).id;
        return !!itemId && idSet.has(itemId);
      });
    }

    if (format === "csv") {
      // 9b-N1: strip secret columns from `partners` export. The sibling route
      // /api/partners/export explicitly drops `portal_token`, `tax_id_hmac`,
      // and `vat_number_hmac` — but this unified /api/export?type=partners
      // route passed raw `listPartners(*)` rows into `toCSV(items, cols)`.
      // An admin / API key could request `?columns=portal_token,...` and
      // exfiltrate the partner's portal token + HMAC-of-tax-id + HMAC-of-vat
      // (the HMACs are equality-search tokens, not public IDs). The strip
      // mirrors the sibling route's defence and removes both the columns
      // from the row objects AND from the requested cols list.
      const SECRET_PARTNER_COLS = new Set([
        "portal_token",
        "tax_id_hmac",
        "vat_number_hmac",
        "portal_token_hash",
      ]);
      const { columns } = parseExportParams(req);
      let finalCols = columns && columns.length > 0 ? columns : COLUMNS[type];
      if (type === "partners") {
        // AUDIT16/18 — decrypt the encrypted-at-rest PII columns via the
        // canonical shapePartnerRow (also strips the HMAC twins).
        const { shapePartnerRow } = await import("@/lib/api/redact");
        items = items.map((it) => {
          const r = it as Record<string, unknown>;
          const { portal_token, tax_id_hmac, vat_number_hmac, portal_token_hash, ...rest } = r;
          // AUDIT18 — canonical partner shaping (shapePartnerRow) replaces the
          // inline decrypt loop (was one of 5 drifted copies of the same logic).
          return shapePartnerRow(rest as any);
        });
        finalCols = finalCols.filter((c) => !SECRET_PARTNER_COLS.has(c));
      }
      const csv = toCSV(items, finalCols);
      const filename = `${type}-${new Date().toISOString().split("T")[0]}.csv`;
      return csvResponse(filename, csv);
    }

    return NextResponse.json(
      { error: `Unsupported format: ${format}. Only "csv" is supported.` },
      { status: 400 },
    );
  } catch (e) {
    console.error("[export]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
