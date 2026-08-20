// Marketplace API key auth helper — Phase 12.
//
// The existing `/api/api-keys` route lets a TENANT ADMIN create API keys
// scoped to the tenant (e.g. `partners:read`, `offers:*`). Those keys
// authenticate via `requireApiKeyAuth` in @/lib/api/helpers.ts, which
// returns an `ApiKeyAuthContext` carrying the tenant_id + permissions
// of the key — but NOT the partner_id (tenant-level keys have no
// partner binding).
//
// Phase 12 introduces PARTNER-level marketplace API keys: a partner in
// the portal generates a key (via POST /api/marketplace/api-keys) so
// an external system (their ERP, a 3rd-party logistics tool, etc.) can
// pull their marketplace feed, automate responses, or sync shipment
// tracking. These keys are stamped with the partner_id at creation
// (stored in the new `partner_id` column on `api_keys` — migration 053)
// and carry the `marketplace:read` permission.
//
// `requireMarketplaceApiKey(req)`:
//   1. Pulls the bearer token from the Authorization header.
//   2. Validates the key via `store.authenticateApiKey` (which checks
//      key_prefix + key_hash + active + expires_at).
//   3. Confirms the key has `marketplace:read` (or `*` / `marketplace:*`)
//      in its permissions array.
//   4. Returns a `MarketplaceApiKeyContext` carrying: store, ip,
//      tenantId, apiKeyId, apiKeyName, partnerId, permissions.
//
// On any failure (missing header, malformed key, unknown key, expired
// key, insufficient permissions, suspended tenant) the helper returns
// a 401/403 NextResponse — callers MUST short-circuit on
// `instanceof NextResponse`.

import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/data/store";
import { getIp, hasPermission } from "@/lib/api/helpers";

export interface MarketplaceApiKeyContext {
  store: Awaited<ReturnType<typeof getStore>>;
  ip: string;
  tenantId: string;
  apiKeyId: string;
  apiKeyName: string;
  /** Partner the key belongs to (NULL when the key was created before
   * Phase 12 and has no partner binding — treated as a tenant-level key
   * with no partner scope, in which case `partnerId` is `null`). */
  partnerId: string | null;
  permissions: string[];
}

const MARKETPLACE_PERMISSION = "marketplace:read";

/**
 * Authenticate a request via a marketplace API key.
 *
 * The header format is `Authorization: Bearer asp_<...>` — same as the
 * tenant-level API key path, so existing API-key tooling (Postman
 * collections, the API Keys page's "Test" button) works unchanged.
 *
 * Returns the resolved `MarketplaceApiKeyContext` on success, or a
 * 401/402/403 `NextResponse` on failure. Callers MUST return the
 * error response verbatim:
 *
 *   const auth = await requireMarketplaceApiKey(req);
 *   if (auth instanceof NextResponse) return auth;
 */
export async function requireMarketplaceApiKey(
  req: NextRequest,
): Promise<MarketplaceApiKeyContext | NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "Marketplace API key required. Use Authorization: Bearer asp_xxx" },
      { status: 401 },
    );
  }
  const rawKey = authHeader.slice(7).trim();
  if (!rawKey.startsWith("asp_")) {
    return NextResponse.json(
      { error: "Invalid API key format. Marketplace keys start with 'asp_'.",
        documentation_url: "/api/marketplace/public/docs" },
      { status: 401 },
    );
  }

  const store = await getStore();
  const result = await store.authenticateApiKey(rawKey);
  if (!result) {
    return NextResponse.json(
      { error: "Invalid or expired marketplace API key." },
      { status: 401 },
    );
  }

  // Permission gate — the key MUST have `marketplace:read`. The existing
  // `hasPermission` helper understands `*`, `resource:*`, and exact
  // matches, so a key with `marketplace:*` or `*` also satisfies this.
  const perms = result.apiKey.permissions || [];
  if (!hasPermission(perms, MARKETPLACE_PERMISSION)) {
    return NextResponse.json(
      {
        error: "This API key does not have marketplace access.",
        required_permission: MARKETPLACE_PERMISSION,
        documentation_url: "/api/marketplace/public/docs",
      },
      { status: 403 },
    );
  }

  // Tenant suspension / subscription-expiry check — mirror the
  // `requireApiKeyAuth` path so a suspended tenant's marketplace key
  // stops working immediately (otherwise the key would keep reading
  // the public feed even after the tenant was suspended).
  try {
    const tenant = await store.getTenant(result.tenantId);
    if (tenant) {
      if (tenant.status === "suspended" || tenant.status === "cancelled") {
        return NextResponse.json(
          { error: "Account suspended. Contact your platform administrator.", subscription_expired: true },
          { status: 402 },
        );
      }
      const now = new Date();
      const subEnd = (tenant as any).subscription_end ? new Date((tenant as any).subscription_end) : null;
      const trialEnd = (tenant as any).trial_ends_at ? new Date((tenant as any).trial_ends_at) : null;
      if (subEnd && subEnd < now) {
        return NextResponse.json(
          { error: "Subscription expired. Contact your platform administrator to renew.", subscription_expired: true },
          { status: 402 },
        );
      }
      if (String(tenant.status) === "trial" && trialEnd && trialEnd < now) {
        return NextResponse.json(
          { error: "Trial period expired. Subscribe to continue.", subscription_expired: true },
          { status: 402 },
        );
      }
    }
  } catch (e) {
    console.error("[requireMarketplaceApiKey] Subscription check failed:", e);
  }

  const ip = getIp(req);

  // Update last_used_at + last_used_ip (fire-and-forget — never blocks
  // the response). Mirrors `requireApiKeyAuth`.
  store.updateApiKeyLastUsed(result.apiKey.id, ip).catch(() => {});

  // The new `partner_id` column on api_keys (migration 053) is OPTIONAL
  // — keys created before Phase 12 have no partner binding. We read it
  // defensively via a cast; if absent, partnerId is null and the caller
  // treats the key as tenant-scoped (no partner binding).
  const partnerId = (result.apiKey as any).partner_id as string | null;

  return {
    store,
    ip,
    tenantId: result.tenantId,
    apiKeyId: result.apiKey.id,
    apiKeyName: result.apiKey.name,
    partnerId,
    permissions: perms,
  };
}
