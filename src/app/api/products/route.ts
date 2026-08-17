import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey, resolveTenantId, hasPermission, audit, type AuthContext, type ApiKeyAuthContext, sanitizeError } from "@/lib/api/helpers";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

function getAuthUser(auth: AuthContext | ApiKeyAuthContext) {
  if ("user" in auth) return auth.user;
  return { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
}

async function _get(req: NextRequest) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (products.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "products.read"); if (_d) return _d; } } /* requirePermission wired */

    const tid = resolveTenantId(auth, req);

    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "products:read")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }

    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const category = url.searchParams.get("category") || undefined;
    // F-9-3: cap limit to 500 — see partners/route.ts for rationale.
    const limit = url.searchParams.get("limit") ? Math.min(Number(url.searchParams.get("limit")), 500) : undefined;
    const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined;
    const result = await auth.store.listProducts(tid!, { search, limit, offset, filters: { category } });
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
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

async function _post(req: NextRequest) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (products.create)
  { const { requirePermission } = await import("@/lib/permissions/can");
    if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "products.create"); if (_d) return _d; } } /* requirePermission wired */

    const tid = resolveTenantId(auth, req);

    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "products:write")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }

    const body = await req.json();
    // Super-admins without ?tenant_id= resolve to null — fall back to the
    // product's existing tenant_id (e.g. when toggling show_in_catalog from
    // the Products table). If neither is present, refuse rather than
    // letting Postgres hit the NOT NULL constraint.
    body.tenant_id = tid || body.tenant_id;
    if (!body.tenant_id) {
      return NextResponse.json({ error: "tenant_id is required." }, { status: 400 });
    }
    if (!body.id) {
      const isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
      const { enforceQuota } = await import("@/lib/api/plan-limits");
      const denied = await enforceQuota(tid, "products", isSA);
      if (denied) return denied;

      // Duplicate check: same tenant + same SKU OR same name (case-insensitive).
      // A tenant may legitimately have two products with different SKUs but
      // the same name (variants) — so an SKU collision is a hard error,
      // a name-only collision is a soft warning returned as 409 with an
      // `existing` payload so the client can decide.
      try {
        const { getSupabase } = await import("@/lib/supabase/client");
        const sb = getSupabase();
        if (body.sku && String(body.sku).trim() !== "") {
          const { data: bySku } = await sb.from("products").select("id, sku, name").eq("tenant_id", tid!).eq("sku", body.sku).maybeSingle();
          if (bySku) {
            return NextResponse.json({ error: `Product with SKU "${body.sku}" already exists.`, duplicate: "sku", existing: bySku }, { status: 409 });
          }
        }
        if (body.name && String(body.name).trim() !== "") {
          const { data: byName } = await sb.from("products").select("id, sku, name").eq("tenant_id", tid!).ilike("name", body.name).limit(1);
          if (byName && byName.length > 0 && !body.force) {
            return NextResponse.json({ error: `A product with name "${body.name}" already exists. Send force:true to override.`, duplicate: "name", existing: byName[0] }, { status: 409 });
          }
        }
      } catch (e) { console.warn("[products.upsert] dupe-check failed (allowing):", e); }
    }
    // Strip non-DB fields that are used only for route logic
    delete body.force;
    const created = await auth.store.upsertProduct(body);
    await audit(auth.store, getAuthUser(auth), req, body.id ? "product.update" : "product.create", "product", created.id, { sku: created.sku, name: created.name });
    return NextResponse.json(created);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

// ── APM wrappers (task D-8) ──────────────────────────────────────────────
// Wraps GET/POST with response-time, slow-request, and error-rate metrics.
// See src/lib/monitoring/apm.ts for the buffer + dashboard wiring.
export const GET = withApm(_get, "GET /api/products");
export const POST = withApm(_post, "POST /api/products");
