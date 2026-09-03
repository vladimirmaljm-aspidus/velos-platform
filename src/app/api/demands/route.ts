import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId, sanitizeError } from "@/lib/api/helpers";
import { generateDemandNumber } from "@/lib/api/doc-number";
// 31-f — shared request-body validation helper (audit 30-a finding 30a-04:
// demands accepted malformed items[] — string quantity "lots" and negative
// unit_price stored verbatim into the items JSONB — while offers / invoices
// / proformas reject the exact same payloads with 400).
import { requireFields } from "@/lib/api/validate";

/**
 * 31-f — per-line items[] validation (ported from the offers route's
 * FIX-ALL-2 / Fix 7 block). Audit 30a-04: POST /api/demands stored
 * {quantity: "lots", unit_price: 5} verbatim with a 200 — the exact
 * payload offers rejects with "items[0].quantity must be a non-negative
 * number.". A string quantity poisons every downstream total computation
 * (NaN propagation into the deal/offer generators that consume demands),
 * so demands must reject it at the door. Per the task-31f brief: quantity
 * must be a POSITIVE number, unit_price a NON-NEGATIVE number.
 * Exported for demands/[id]/route.ts (the PUT path feeds the same
 * upsertDemand call — same pattern as whitelistPartnerFields exported
 * from partners/route.ts).
 * @returns a ready-to-return 400 NextResponse, or null when valid.
 */
export function validateDemandItems(items: unknown): NextResponse | null {
  if (items === undefined || items === null) return null; // absent = not changing items
  if (!Array.isArray(items)) {
    return NextResponse.json({ error: "Field 'items' must be an array." }, { status: 400 });
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as Record<string, unknown>;
    const qty = Number(it?.quantity);
    const price = Number(it?.unit_price);
    if (!Number.isFinite(qty) || qty <= 0) {
      return NextResponse.json(
        { error: `items[${i}].quantity must be a positive number.` },
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
  return null;
}

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (demands.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "demands.read"); if (_d) return _d; } /* requirePermission wired */

  const tid = resolveTenantId(auth, req);
  if (!tid) return NextResponse.json({ error: "No tenant context." }, { status: 400 });
    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const partner_id = url.searchParams.get("partner_id") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const limit = url.searchParams.get("limit") ? Math.min(Number(url.searchParams.get("limit")), 500) : undefined;
    const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined;
    const result = await auth.store.listDemands(tid, { search, limit, offset, filters: { partner_id, status } });
    // Defense-in-depth: even though SupabaseStore filters by tenant_id,
    // this post-filter provides an extra safety layer. Do NOT remove.
    if (!auth.isSuperAdmin && auth.tenantId) {
      const before = result.items.length;
      result.items = result.items.filter((d) => d.tenant_id === auth.tenantId);
      result.total = result.total - (before - result.items.length);
    }
    return NextResponse.json(result);
  } catch (error: any) {
    console.error("[demands GET]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (demands.create)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "demands.create"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_crm)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_crm", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const tid = resolveTenantId(auth, req);
    if (!tid) return NextResponse.json({ error: "No tenant context." }, { status: 400 });
    // 31-f — guard the JSON parse (malformed body previously hit the
    // generic catch → 500; mirrors the pattern used by every other
    // high-traffic route).
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    body.tenant_id = tid;
    // FIX-FUNC-4: `demands.partner_id` is NOT NULL (FK to partners, no
    // SET NULL option). Without it the INSERT fails with a NOT NULL
    // violation that surfaces as a 500 to the caller; reject early with
    // a helpful message so the client can correct the request.
    if (!body.partner_id) {
      return NextResponse.json(
        { error: "Partner is required." },
        { status: 400 },
      );
    }
    // 31-f — `demands.subject` is also NOT NULL with no DB default; the
    // audit's empty-body class (30a-08) only stayed a 400 here because the
    // partner_id guard above fired first. Require it on CREATE (the update
    // path re-uses the existing row's subject).
    if (!body.id) {
      const bad = requireFields(body, ["subject"]);
      if (bad) return bad;
    }
    // 31-f — items[] per-line validation (audit 30a-04). demands previously
    // accepted string quantities / negative prices and stored them verbatim
    // (see validateDemandItems docblock). Runs on create AND update — the
    // PUT route below shares the same upsert path.
    {
      const bad = validateDemandItems(body.items);
      if (bad) return bad;
    }
    // ADMIN-H5: validate that the supplied partner_id actually belongs
    // to the caller's tenant. Without this check, a tenant admin could
    // create a demand tied to another tenant's partner (the FK to
    // partners(id) passes, but the row-level visibility is broken and
    // the demand would show up under the WRONG tenant's pipeline).
    // Super-admin with no tenant context (tid null) bypasses — they
    // can legitimately cross-link (already gated by the permission
    // matrix + audit log).
    if (tid) {
      const partner = await auth.store.getPartner(body.partner_id);
      if (!partner || partner.tenant_id !== tid) {
        return NextResponse.json({ error: "Not found." }, { status: 404 });
      }
    }
    // FIX-FUNC-4: `demands.number` is NOT NULL with no DB-level default.
    // If the caller didn't supply one, mint a per-tenant sequence in
    // the format `DEM-<YEAR>-<NNN>` (e.g. `DEM-2026-001`). See
    // `generateDemandNumber` in src/lib/api/doc-number.ts for details.
    if (!body.number) {
      const autoNum = await generateDemandNumber(auth.store, tid);
      if (!autoNum) {
        return NextResponse.json(
          { error: "Could not generate demand number." },
          { status: 500 },
        );
      }
      body.number = autoNum;
    }
    const created = await auth.store.upsertDemand(body);
    await audit(auth.store, auth.user, req, body.id ? "demand.update" : "demand.create", "demand", created.id, { number: created.number });
    return NextResponse.json(created);
  } catch (error: any) {
    console.error("[demands POST]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
