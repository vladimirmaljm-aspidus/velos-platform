import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey, resolveTenantId, hasPermission, audit, sanitizeError, type AuthContext, type ApiKeyAuthContext, getAuthUser } from "@/lib/api/helpers";
// 31-f — shared request-body validation helpers (audit 30-a findings
// 30a-07/30a-08: POST {} → deals NOT NULL violation → 500, and
// {value: "lots"} → PostgREST 22P02 numeric cast → 500 "Invalid input
// format."; now clean 400s before the DB write).
import { requireFields, assertNumeric } from "@/lib/api/validate";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (deals.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "deals.read"); if (_d) return _d; } } /* requirePermission wired */

    const tid = resolveTenantId(auth, req);
    if (!tid) return NextResponse.json({ error: "No tenant context." }, { status: 400 });

    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "deals:read")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }

    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const partner_id = url.searchParams.get("partner_id") || undefined;
    const stage = url.searchParams.get("stage") || undefined;
    const limit = url.searchParams.get("limit") ? Math.min(Number(url.searchParams.get("limit")), 500) : undefined;
    const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined;
    const result = await auth.store.listDeals(tid, { search, limit, offset, filters: { partner_id, stage } });
    // Defense-in-depth: even though SupabaseStore filters by tenant_id,
    // this post-filter provides an extra safety layer. Do NOT remove.
    const shouldFilter = "apiKeyId" in auth || !auth.isSuperAdmin;
    if (shouldFilter && auth.tenantId) {
      const before = result.items.length;
      result.items = result.items.filter((d) => d.tenant_id === auth.tenantId);
      result.total = result.total - (before - result.items.length);
    }
    return NextResponse.json(result);
  } catch (error: any) {
    console.error("[deals GET]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (deals.create)
  { const { requirePermission } = await import("@/lib/permissions/can");
    if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "deals.create"); if (_d) return _d; } } /* requirePermission wired */
  // Feature gate (module_crm)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_crm", _isSA); if (_f) return _f; } /* requireFeature wired */

    const tid = resolveTenantId(auth, req);
    if (!tid) return NextResponse.json({ error: "No tenant context." }, { status: 400 });

    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "deals:write")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    // 31-f — required-field + numeric validation BEFORE the DB write
    // (audit 30a-08: POST {} → 500 "Missing required field."; 30a-07:
    // {value: "lots"} → 500). `title` is the client-supplied NOT NULL
    // column without a DB default; the IDOR guard below validates
    // partner_id / buyer_id / supplier_id / product_id / contract_id
    // whenever present, and the F-FINAL block below defaults probability /
    // buy_cost / quantity / unit (stage / value / currency have DB
    // defaults). Skipped on the update path (body.id).
    if (!body.id) {
      const bad = requireFields(body, ["title"]);
      if (bad) return bad;
    }
    // value / probability / buy_cost / quantity are the four numeric NOT
    // NULL columns the F-FINAL block below defaults — a junk string that
    // survives `?? default` is a PostgREST 22P02 (500). Coerce-or-400.
    {
      const bad = assertNumeric(body, ["value", "probability", "buy_cost", "quantity"]);
      if (bad) return bad;
    }
    body.tenant_id = tid;
    if (!body.owner_id && "user" in auth) body.owner_id = auth.user.id;
    // CRITICAL FIX (audit F-1): validate commission_agent_id points to a real
    // commission_agents row in the caller's tenant. Previously, partner_id values
    // were stored here, causing all commissions to silently compute as $0.
    if (body.commission_agent_id) {
      const agent = await auth.store.getCommissionAgent(body.commission_agent_id);
      if (!agent || agent.tenant_id !== tid) {
        return NextResponse.json({ error: "Commission agent not found." }, { status: 400 });
      }
    }
    // S-FIX / IDOR prevention: validate every cross-referenced entity belongs
    // to the caller's tenant. Without these checks, an authenticated user
    // could pass another tenant's partner_id / buyer_id / supplier_id /
    // product_id / contract_id and silently create a deal that links to
    // cross-tenant data (the DB has no FK enforcing tenant scoping across
    // these tables). Super-admins bypass so they can remediate bad data.
    // Defense-in-depth: each lookup is best-effort — a missing entity is a
    // 404, a cross-tenant entity is a 404 (same shape, no enumeration leak).
    const _isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!_isSuperAdmin) {
      if (body.partner_id) {
        const partner = await auth.store.getPartner(body.partner_id);
        if (!partner || partner.tenant_id !== tid) {
          return NextResponse.json({ error: "Partner not found." }, { status: 404 });
        }
      }
      if (body.buyer_id) {
        const buyer = await auth.store.getPartner(body.buyer_id);
        if (!buyer || buyer.tenant_id !== tid) {
          return NextResponse.json({ error: "Buyer not found." }, { status: 404 });
        }
      }
      if (body.supplier_id) {
        const supplier = await auth.store.getPartner(body.supplier_id);
        if (!supplier || supplier.tenant_id !== tid) {
          return NextResponse.json({ error: "Supplier not found." }, { status: 404 });
        }
      }
      if (body.product_id) {
        const product = await auth.store.getProduct(body.product_id);
        if (!product || product.tenant_id !== tid) {
          return NextResponse.json({ error: "Product not found." }, { status: 404 });
        }
      }
      if (body.contract_id) {
        // Contract field references a Deal (parent deal) — re-use getDeal
        // for ownership verification.
        const contract = await auth.store.getDeal(body.contract_id);
        if (!contract || contract.tenant_id !== tid) {
          return NextResponse.json({ error: "Contract not found." }, { status: 404 });
        }
      }
    }
    // F-FINAL / P1: the deals table has 4 NOT NULL columns with no DB-side
    // defaults (probability, buy_cost, quantity, unit). Without these
    // defaults, the typical CRM "create deal" payload (title / partner_id /
    // stage / value / currency) hit HTTP 500 with a sanitized
    // "Required field missing." message — counterintuitive for a CRM entity
    // that conceptually doesn't need a buy_cost at creation time. Supply
    // sane defaults so the typical payload works; callers who care about
    // cost-tracking can override.
    const deal = {
      ...body,
      probability: body.probability ?? 0,
      buy_cost: body.buy_cost ?? 0,
      quantity: body.quantity ?? 1,
      unit: body.unit ?? "MT",
    };
    const created = await auth.store.upsertDeal(deal);
    await audit(auth.store, getAuthUser(auth), req, body.id ? "deal.update" : "deal.create", "deal", created.id, { title: created.title });
    return NextResponse.json(created);
  } catch (error: any) {
    console.error("[deals POST]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
