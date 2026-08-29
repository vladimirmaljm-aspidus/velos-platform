import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId, sanitizeError } from "@/lib/api/helpers";
import { generateDemandNumber } from "@/lib/api/doc-number";

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
    const body = await req.json();
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
