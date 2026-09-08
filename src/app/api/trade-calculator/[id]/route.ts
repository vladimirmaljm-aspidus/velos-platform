import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey, requireAuthOrApiKeyPermission, audit, resolveTenantId, sanitizeError } from "@/lib/api/helpers";
import { TradeCostLine } from "@/lib/supabase/types";
import { TRADE_COST_TYPES } from "@/lib/data/reference";
// 46-a — shared trade-calculator math (single source of truth for POST and
// PUT; the inline copies were extracted byte-for-byte — see the lib header).
import { normalizeCommissionType, computeTradeTotals, diffTradeCalculation } from "@/lib/trade/calculator-math";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthOrApiKey(_req);
  if (auth instanceof NextResponse) return auth;
  // U-FIX (RBAC audit D-1): gate BOTH session AND API-key callers.
  const denied = requireAuthOrApiKeyPermission(auth, "trade-calculator.read");
  if (denied) return denied;
  // Feature gate (module_trade)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_trade", _isSA); if (_f) return _f; } /* requireFeature wired */

  const { id } = await params;
  const item = await auth.store.getTradeCalculation(id);
  if (!item) return NextResponse.json({ error: "Not found." }, { status: 404 });
  // CRITICAL FIX (audit T-2): tenant ownership check must cover BOTH auth
  // modes. Previously the `"user" in auth && !auth.isSuperAdmin` guard
  // skipped the check entirely for API key auth (which has no `isSuperAdmin`
  // property) — so an API key from tenant A could read tenant B's calc by id.
  const isSuperAdmin = "user" in auth && auth.isSuperAdmin;
  if (!isSuperAdmin && (item as any).tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return NextResponse.json(item);
}

/**
 * PUT /api/trade-calculator/[id]
 * Update an existing trade calculation.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthOrApiKey(req);
  if (auth instanceof NextResponse) return auth;
  // U-FIX (RBAC audit D-1): gate BOTH session AND API-key callers.
  const denied = requireAuthOrApiKeyPermission(auth, "trade-calculator.update");
  if (denied) return denied;
  // Feature gate (module_trade)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_trade", _isSA); if (_f) return _f; } /* requireFeature wired */

  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ error: "No tenant context." }, { status: 400 });

  const { id } = await params;
  const existing = await auth.store.getTradeCalculation(id);
  if (!existing) return NextResponse.json({ error: "Trade calculation not found." }, { status: 404 });
  // CRITICAL FIX (audit T-2): tenant ownership check must cover BOTH auth
  // modes (see GET handler above for full rationale).
  const isSuperAdmin = "user" in auth && auth.isSuperAdmin;
  if (!isSuperAdmin && (existing as any).tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Trade calculation not found." }, { status: 404 });
  }

  try {
    const body = await req.json();
    body.id = id;
    // Preserve the entity's tenant_id (regular users cannot move it to another tenant)
    body.tenant_id = (existing as any).tenant_id || tenantId;

    // ── Tenant-ownership validation (audit F-6/P1-6 IDOR) ──────────────
    // Same fix as POST /api/trade-calculator: an authenticated user could
    // otherwise change `product_id` / `supplier_offer_id` / `supplier_id`
    // / `buyer_id` on an existing calc to point at another tenant's
    // records. We validate against the calc's OWN tenant_id (not the
    // resolved tenantId, which for a super-admin could be different).
    // Super-admins bypass.
    if (!isSuperAdmin) {
      const calcTenantId = (existing as any).tenant_id;
      if (body.product_id) {
        const product = await auth.store.getProduct(body.product_id);
        if (!product || product.tenant_id !== calcTenantId) {
          return NextResponse.json({ error: "Invalid product — does not belong to your tenant." }, { status: 400 });
        }
      }
      if (body.supplier_offer_id) {
        const offer = await auth.store.getSupplierOffer(body.supplier_offer_id);
        if (!offer || offer.tenant_id !== calcTenantId) {
          return NextResponse.json({ error: "Invalid supplier offer — does not belong to your tenant." }, { status: 400 });
        }
      }
      if (body.supplier_id) {
        const supplier = await auth.store.getPartner(body.supplier_id);
        if (!supplier || supplier.tenant_id !== calcTenantId) {
          return NextResponse.json({ error: "Invalid supplier — does not belong to your tenant." }, { status: 400 });
        }
      }
      if (body.buyer_id) {
        const buyer = await auth.store.getPartner(body.buyer_id);
        if (!buyer || buyer.tenant_id !== calcTenantId) {
          return NextResponse.json({ error: "Invalid buyer — does not belong to your tenant." }, { status: 400 });
        }
      }
    }

    // Validate exchange_rate (Fix 8): must be positive when provided. Reuse
    // the existing value (already validated on POST) when not supplied.
    if (body.exchange_rate !== undefined && body.exchange_rate !== null) {
      const rate = Number(body.exchange_rate);
      if (!Number.isFinite(rate) || rate <= 0) {
        return NextResponse.json({ error: "Exchange rate must be a positive number." }, { status: 400 });
      }
    }

    // Validate commission_rate (Fix 8): non-negative.
    if (body.commission_rate !== undefined && body.commission_rate !== null) {
      const cr = Number(body.commission_rate);
      if (!Number.isFinite(cr) || cr < 0) {
        return NextResponse.json({ error: "Commission rate must be a non-negative number." }, { status: 400 });
      }
      body.commission_rate = cr;
    }

    // Preserve commission tracking fields (Fix 1) — when the body doesn't
    // supply them, fall back to the existing values so partial PUTs don't
    // silently clear the commission chain on a calc that already had it set.
    body.commission_agent_id = body.commission_agent_id ?? (existing as any).commission_agent_id ?? null;
    body.commission_type = normalizeCommissionType(body.commission_type ?? (existing as any).commission_type ?? null);
    body.commission_rate = body.commission_rate ?? (existing as any).commission_rate ?? 0;

    // Compute totals from cost lines
    const qty = body.quantity || (existing as any).quantity || 0;
    const numContainers = body.num_containers || (existing as any).num_containers || 1;
    const buyPrice = body.buy_price_per_unit ?? (existing as any).buy_price_per_unit ?? 0;
    const sellPrice = body.sell_price_per_unit ?? (existing as any).sell_price_per_unit ?? 0;
    const buyCurrency = body.buy_currency || (existing as any).buy_currency;
    const sellCurrency = body.sell_currency || (existing as any).sell_currency;
    const sourceLines = (body.cost_lines || (existing as any).cost_lines || []) as TradeCostLine[];

    // 46-a: the arithmetic lives in src/lib/trade/calculator-math.ts (shared
    // with the POST route — same inputs, byte-identical totals; per-line
    // currency → buy-currency conversion included). When a line's currency
    // differs from the buy currency and no fx_rate is supplied, the lib
    // fetches the LIVE rate and THROWS when the provider is down (P1-16) —
    // this route deliberately lets it propagate to the 500 catch below,
    // exactly like the pre-46-a inline code did.
    const totals = await computeTradeTotals({
      quantity: qty,
      buy_price_per_unit: buyPrice,
      sell_price_per_unit: sellPrice,
      buy_currency: buyCurrency,
      sell_currency: sellCurrency,
      exchange_rate: body.exchange_rate ?? (existing as any).exchange_rate,
      num_containers: numContainers,
      cost_lines: sourceLines,
    });

    body.cost_lines = totals.computedLines;
    body.total_buy_cost = totals.total_buy_cost;
    body.total_landed_cost = totals.total_landed_cost;
    body.total_sell_revenue = totals.total_sell_revenue;
    body.gross_margin = totals.gross_margin;
    body.margin_percent = totals.margin_percent;

    // 46-a: field-level edit history. `existing` (fetched above for the
    // IDOR/ownership check) is the pre-update snapshot; diff it against the
    // row the store returned and record every field that ACTUALLY changed
    // as details.changes (numbers tolerate 0.01; cost_lines diffs by count).
    // Omitted entirely when nothing changed — a no-op save logs {name} only.
    const before = existing as unknown as Record<string, unknown>;
    const updated = await auth.store.upsertTradeCalculation(body);
    const changes = diffTradeCalculation(before, updated as unknown as Record<string, unknown>);
    const auditUser = "user" in auth ? auth.user : { id: auth.apiKeyId, username: auth.apiKeyName, tenant_id: auth.tenantId };
    await audit(auth.store, auditUser, req, "trade_calc.update", "trade_calculation", updated.id, {
      name: updated.name,
      changes: changes.length ? changes : undefined,
    });
    return NextResponse.json(updated);
  } catch (e: any) {
    console.error("[trade-calculator PUT]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthOrApiKey(req);
  if (auth instanceof NextResponse) return auth;
  // U-FIX (RBAC audit D-1): gate BOTH session AND API-key callers.
  const denied = requireAuthOrApiKeyPermission(auth, "trade-calculator.delete");
  if (denied) return denied;
  // Feature gate (module_trade)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_trade", _isSA); if (_f) return _f; } /* requireFeature wired */

  const { id } = await params;
  // Tenant ownership check before delete
  const existing = await auth.store.getTradeCalculation(id);
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
  // CRITICAL FIX (audit T-2): tenant ownership check must cover BOTH auth
  // modes (see GET handler above for full rationale).
  const isSuperAdmin = "user" in auth && auth.isSuperAdmin;
  if (!isSuperAdmin && (existing as any).tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  await auth.store.deleteTradeCalculation(id);
  const auditUser = "user" in auth ? auth.user : { id: auth.apiKeyId, username: auth.apiKeyName, tenant_id: auth.tenantId };
  await audit(auth.store, auditUser, req, "trade_calc.delete", "trade_calculation", id);
  return NextResponse.json({ ok: true });
}
