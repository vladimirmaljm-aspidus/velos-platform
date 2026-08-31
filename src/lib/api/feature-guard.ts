import { NextResponse } from "next/server";
import { getStore } from "@/lib/data/store";

/**
 * Server-side feature-flag enforcement.
 *
 * A tenant's plan determines which modules are enabled via `feature_flags`
 * (e.g. `module_trade`, `module_finance`, `module_portal`). If a tenant is on
 * a plan that doesn't include a module (e.g. Trial without `module_trade`),
 * the corresponding API routes should refuse — even if the client somehow
 * reaches them past the sidebar's UI hide.
 *
 * Super-admins bypass. Portal endpoints are gated separately (see
 * requirePortalFeature).
 *
 * Usage:
 *   const denied = await requireFeature(tenantId, "module_trade", isSA);
 *   if (denied) return denied;
 */

type ModuleFlag =
  | "module_crm"
  | "module_trade"
  | "module_finance"
  | "module_inventory"
  | "module_portal"
  | "module_logistics"
  | "module_kyc"
  | "module_document_templates"
  | "module_document_verification"
  | "module_vault"
  | "module_api_keys"
  | "module_webhooks"
  | "module_mail_queue"
  | "module_security";

const cache = new Map<string, { flags: Record<string, boolean>; ts: number }>();
const TTL_MS = 30_000;

async function loadFlags(tenantId: string): Promise<Record<string, boolean>> {
  const now = Date.now();
  const cached = cache.get(tenantId);
  if (cached && now - cached.ts < TTL_MS) return cached.flags;

  // AUDIT18 (live E2E finding): route through the store abstraction instead
  // of calling getSupabase() directly. The direct call hard-throws when
  // SUPABASE_URL/SERVICE_ROLE_KEY are unset (self-hosted / DB_BACKEND=prisma
  // deployments), turning every feature-gated route into a 500 — e.g.
  // POST /api/partners failed at enforceQuota and GET /api/supplier-offers
  // failed at requireFeature during local E2E. SupabaseStore.getFeatureFlags
  // reads the same feature_flags table, so production behavior (and the
  // fail-closed semantics below) is unchanged; Prisma/Mock stores now serve
  // their own tenant_feature_flags rows.
  const store = await getStore();
  const row = await store.getFeatureFlags(tenantId);
  const flags = (row ?? {}) as unknown as Record<string, boolean>;
  cache.set(tenantId, { flags, ts: now });
  return flags;
}

export async function requireFeature(
  tenantId: string | null,
  featureFlag: ModuleFlag,
  isSuperAdmin: boolean = false,
): Promise<NextResponse | null> {
  if (isSuperAdmin) return null;
  if (!tenantId) {
    return NextResponse.json({ error: "Tenant context required." }, { status: 400 });
  }
  const flags = await loadFlags(tenantId);
  // SEC-AUDIT (Data leakage + permission audit): FAIL-CLOSED.
  // Previously this check was `flags[featureFlag] === false`, which only
  // blocked when the flag was explicitly `false`. A tenant with NO
  // `feature_flags` row (e.g. one created via /api/auth/register, which
  // historically did not seed the row) returned `data === null` →
  // `flags = {}` → `flags[featureFlag] === undefined` → check PASSED,
  // silently granting the trial tenant access to vault_secrets,
  // api_keys, webhooks, mail_queue, and the security center.
  //
  // Combined with `can()`'s rule 3 (`role === "admin"` → implicit grant
  // of every non-platform permission), this meant a trial tenant admin
  // could mint API keys, register outbound webhooks, reveal vault
  // secrets, and read the cross-tenant mail queue despite the
  // TRIAL_ADMIN_PERMISSIONS array explicitly excluding those scopes.
  //
  // The fix is two-pronged:
  //   1. FAIL-CLOSED here: any flag that is not strictly `true` is denied.
  //      This covers `undefined` (no row), `null`, and explicit `false`.
  //   2. /api/auth/register now seeds a `feature_flags` row with the
  //      schema defaults (CRM/finance/logistics ON; vault/api_keys/
  //      webhooks/mail_queue/security OFF) so new trial tenants get a
  //      clean "module disabled" 402 instead of a silent bypass.
  if (flags[featureFlag] !== true) {
    return NextResponse.json(
      {
        error: `This module is not included in your plan. Upgrade your subscription to enable ${featureFlag.replace("module_", "").replace("_", " ")}.`,
        feature_disabled: true,
        module: featureFlag,
      },
      { status: 402 },
    );
  }
  return null;
}

/** Force a re-fetch on next call (use after admin toggles a flag). */
export function invalidateFeatureCache(tenantId?: string) {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}
