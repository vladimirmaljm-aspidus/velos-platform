import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit, sanitizeError } from "@/lib/api/helpers";
// 31-f — shared request-body validation helpers (audit 30-a findings
// 30a-07/30a-08: POST {} → commission_agents NOT NULL violation → 500,
// and {commission_rate: "ten"} → PostgREST 22P02 numeric cast → 500;
// now clean 400s before the DB write).
import { requireFields, assertNumeric } from "@/lib/api/validate";

export const runtime = "nodejs";

// GET /api/commission-agents?tenant_id=xxx&search=xxx
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (commissions.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "commissions.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const tenantId = resolveTenantId(auth, req);
    if (!tenantId) return NextResponse.json({ items: [], total: 0 });

    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const limit = url.searchParams.get("limit") ? Math.min(Number(url.searchParams.get("limit")), 500) : undefined;
    const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined;

    const result = await auth.store.listCommissionAgents(tenantId, { search, limit, offset });
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}

// POST /api/commission-agents
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (commissions.create)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "commissions.create"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const tenantId = resolveTenantId(auth, req);
    if (!tenantId) return NextResponse.json({ error: "Tenant ID is required." }, { status: 400 });

    // 31-f — guard the JSON parse (malformed body previously hit the
    // generic catch → 500; mirrors the pattern used by every other
    // high-traffic route).
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    // 31-f — required-field validation BEFORE the upsert (audit 30a-08:
    // POST {} → 500 "Missing required field."). partner_id is NOT NULL with
    // no DB default (the route reads it back via getPartner below);
    // commission_type / commission_currency are defaulted by the normalize
    // block below. Skipped on the update path (body.id).
    if (!body.id) {
      const bad = requireFields(body, ["partner_id"]);
      if (bad) return bad;
    }
    body.tenant_id = tenantId;

    // Normalize field names — the DB schema uses commission_* prefixed
    // columns (commission_rate, commission_currency, commission_per_unit,
    // commission_custom_formula) but the UI sometimes sends short names
    // (rate, currency). Map both directions so either works.
    if (body.rate !== undefined && body.commission_rate === undefined) {
      body.commission_rate = body.rate;
    }
    if (body.currency !== undefined && body.commission_currency === undefined) {
      body.commission_currency = body.currency;
    }
    if (body.per_unit !== undefined && body.commission_per_unit === undefined) {
      body.commission_per_unit = body.per_unit;
    }
    if (body.custom_formula !== undefined && body.commission_custom_formula === undefined) {
      body.commission_custom_formula = body.custom_formula;
    }
    // Default currency if none provided
    if (!body.commission_currency) body.commission_currency = "USD";
    // Default type
    if (!body.commission_type) body.commission_type = "profit_percent";
    // Default active flag
    if (body.active === undefined && body.is_active !== undefined) {
      body.active = body.is_active;
    }

    // 31-f — numeric-field validation AFTER the short-name → commission_*
    // normalize block above (audit 30a-07: {commission_rate: "ten"} → 500
    // "Invalid input format."; the aliases rate / per_unit map onto the
    // same numeric columns, so check the canonical names post-normalize).
    {
      const bad = assertNumeric(body, ["commission_rate", "commission_per_unit"]);
      if (bad) return bad;
    }

    const created = await auth.store.upsertCommissionAgent(body);
    await audit(auth.store, auth.user, req, "commission_agent.create", "commission_agent", created.id, { partner_id: created.partner_id });

    // CRITICAL FIX (audit P0-2/A-2): validate partner_id belongs to caller's
    // tenant BEFORE reading or writing it. Without this, a tenant-A admin can
    // submit partner_id = <tenant-B's partner UUID> and the route would:
    //   1. fetch tenant-B's partner (cross-tenant READ — name, email, tax_id)
    //   2. write is_commissioner=true onto tenant-B's partner (cross-tenant WRITE)
    const partner = await auth.store.getPartner(created.partner_id);
    if (partner && partner.tenant_id !== tenantId) {
      // Cross-tenant reference — roll back the commission agent we just created.
      await auth.store.deleteCommissionAgent(created.id).catch(() => {});
      return NextResponse.json({ error: "Partner not found." }, { status: 404 });
    }
    if (partner && !partner.is_commissioner) {
      await auth.store.upsertPartner({ ...partner, is_commissioner: true });
    }

    return NextResponse.json(created);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}
