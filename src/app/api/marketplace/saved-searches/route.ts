import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requirePortalModule } from "@/lib/portal/module-permissions";
import { requireMarketplaceEnabled } from "@/lib/portal/marketplace-gate";
import {
  createSavedSearch,
  listSavedSearches,
  validateSavedSearchInput,
  MarketplaceRuleError,
} from "@/lib/data/marketplace-store";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/saved-searches — the caller's saved searches
// (tenant + portal_access scoped), newest first. Response: { items }.
async function _get(_req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // 100 — module permission gate (marketplace).
  const _moduleBlock = await requirePortalModule(access, "marketplace");
  if (_moduleBlock) return _moduleBlock;
  // 100 — tenant marketplace switch (Layer 0).
  const _enabledBlock = await requireMarketplaceEnabled(access);
  if (_enabledBlock) return _enabledBlock;
  try {
    const items = await listSavedSearches(access.tenant_id, access.id);
    return NextResponse.json({ items });
  } catch (e: unknown) {
    console.error("[marketplace.saved-searches.list]", e);
    return NextResponse.json({ error: "Failed to load saved searches." }, { status: 500 });
  }
}

// POST /api/marketplace/saved-searches — save the current filter set.
// Body: { name: string (1-80), filters: { search?, post_type?,
// product_category?, country? } (string values, search ≤ 100),
// alert_enabled?: boolean }. tenant_id / portal_access_id / partner_id
// are stamped from the auth context — body-supplied values are ignored.
// Response: the created saved-search row.
async function _post(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // 100 — module permission gate (marketplace).
  const _moduleBlock = await requirePortalModule(access, "marketplace");
  if (_moduleBlock) return _moduleBlock;
  // 100 — tenant marketplace switch (Layer 0).
  const _enabledBlock = await requireMarketplaceEnabled(access);
  if (_enabledBlock) return _enabledBlock;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Route-level validation with the same messages the store enforces.
  try {
    validateSavedSearchInput({
      name: body.name,
      filters: body.filters,
      alert_enabled: body.alert_enabled,
    });
  } catch (e) {
    if (e instanceof MarketplaceRuleError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  try {
    const created = await createSavedSearch({
      tenant_id: access.tenant_id,
      portal_access_id: access.id,
      partner_id: access.partner_id,
      name: String(body.name),
      filters: (body.filters ?? {}) as Record<string, string>,
      alert_enabled: body.alert_enabled === true,
    });
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.saved_search_created",
        "marketplace_saved_search",
        created.id,
        { name: created.name, alert_enabled: created.alert_enabled },
      );
    } catch (e) {
      console.error("[marketplace.saved-searches.create] audit failed:", e);
    }
    return NextResponse.json(created);
  } catch (e: unknown) {
    if (e instanceof MarketplaceRuleError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("[marketplace.saved-searches.create]", e);
    return NextResponse.json({ error: sanitizeError(e) || "Failed to save search." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/saved-searches");
export const POST = withApm(_post, "POST /api/marketplace/saved-searches");
