import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase/client";
import type { PortalAccess } from "@/lib/supabase/types";

/**
 * PORTAL MODULE PERMISSIONS — per-user + per-tenant module access control.
 *
 * Over the last months the portal gained many new modules (marketplace,
 * referrals/commissions, messages, notifications, logistics,
 * intelligence…) that had NO access control beyond authentication: every
 * active portal client could use everything. This module introduces a
 * three-level evaluation for every portal module / submodule:
 *
 *   1. USER override  — portal_access.module_permissions JSONB
 *                      (migration 099): { "marketplace": false, … }
 *   2. TENANT default — tenant_portal_defaults.modules JSONB
 *                      (migration 099), editable by super admins AND the
 *                      tenant's own admins.
 *   3. LEGACY fallback — the 8 portal_access booleans for the modules
 *                      that always had them (offers, invoices, …).
 *                      Modules that never had a boolean default to TRUE
 *                      (open by default — the admin closes what they
 *                      want closed, no silent breakage of existing
 *                      tenants on upgrade).
 *
 * Level 1 (explicit boolean for the exact key) short-circuits. Otherwise
 * the most specific applicable value wins: an explicit `false` on a
 * parent module (e.g. `marketplace`) also closes its submodules — a
 * tenant that disables marketplace disables browse + post + community
 * together, and a per-user override can re-open nothing (deny wins).
 *
 * The evaluator is used:
 *   • server-side — `requirePortalModule(access, "marketplace.post")`
 *     in API routes (403 + machine-readable code),
 *   • client-side — `/api/portal/me` returns the fully resolved
 *     `module_access` map which the portal shell uses to filter the nav.
 */

// ─── Module catalog ────────────────────────────────────────────────────────
// (see module-catalog.ts — the pure, client-safe source of truth)
import {
  PORTAL_MODULES as _PORTAL_MODULES,
  PORTAL_MODULE_KEYS,
  type PortalModuleDef,
} from "@/lib/portal/module-catalog";
export { PORTAL_MODULE_KEYS };
export type { PortalModuleDef };
void _PORTAL_MODULES;

/** Legacy portal_access boolean fallback per module key. */
const LEGACY_FLAG_MAP: Record<string, keyof PortalAccess> = {
  offers: "can_view_offers",
  lois: "can_view_offers", // LOIs intentionally share the offers flag today
  invoices: "can_view_invoices",
  proformas: "can_view_invoices", // proformas share the invoices flag today
  documents: "can_view_documents",
  catalog: "can_view_catalog",
  company: "can_view_company_info",
  profile: "can_view_profile",
  rfq: "can_submit_rfq",
};

// ─── Tenant defaults (cached read) ─────────────────────────────────────────

interface DefaultsCacheEntry {
  modules: Record<string, boolean>;
  fetchedAt: number;
}
const TENANT_DEFAULTS_CACHE = new Map<string, DefaultsCacheEntry>();
const TENANT_DEFAULTS_TTL_MS = 30_000;

/**
 * Per-tenant module defaults from tenant_portal_defaults (migration 099).
 * Empty object when the tenant has no row (everything open). Throws on DB
 * errors — callers decide fail-open vs fail-closed; `requirePortalModule`
 * fails OPEN because module permissions are an availability feature, not
 * a data-isolation boundary (the underlying data routes already enforce
 * tenant scoping + ownership).
 */
export async function getTenantPortalDefaults(
  tenantId: string,
): Promise<Record<string, boolean>> {
  const cached = TENANT_DEFAULTS_CACHE.get(tenantId);
  if (cached && Date.now() - cached.fetchedAt < TENANT_DEFAULTS_TTL_MS) {
    return cached.modules;
  }
  const sb = getSupabase();
  const { data, error } = await sb
    .from("tenant_portal_defaults")
    .select("modules")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw error;
  const modules =
    (data as { modules?: Record<string, boolean> | null } | null)?.modules ?? {};
  TENANT_DEFAULTS_CACHE.set(tenantId, { modules, fetchedAt: Date.now() });
  return modules;
}

/** Invalidate the cache after an admin edits a tenant's defaults. */
export function invalidateTenantPortalDefaults(tenantId: string): void {
  TENANT_DEFAULTS_CACHE.delete(tenantId);
}

// ─── Evaluation ────────────────────────────────────────────────────────────

export interface PortalModuleContext {
  /** portal_access row (carries the per-user module_permissions JSONB). */
  access: PortalAccess;
  /** tenant_portal_defaults.modules (fetched by the caller when needed). */
  tenantDefaults?: Record<string, boolean>;
}

/**
 * Resolve one module key for a portal user. See the module docblock for
 * the precedence chain. Pure function — no DB access (the caller passes
 * tenant defaults; routes that never configured anything skip it).
 */
export function resolvePortalModule(
  ctx: PortalModuleContext,
  moduleKey: string,
): boolean {
  const { access, tenantDefaults } = ctx;
  const userPerms = access.module_permissions ?? {};

  // 1. Exact per-user override.
  if (typeof userPerms[moduleKey] === "boolean") return userPerms[moduleKey];

  // 2. Deny propagation from a parent module (per-user AND tenant-level):
  //    a closed parent module closes every submodule unless the user has
  //    an explicit submodule override (handled above).
  const parentKey = moduleKey.includes(".")
    ? moduleKey.split(".")[0]
    : null;
  if (parentKey && parentKey !== moduleKey) {
    if (typeof userPerms[parentKey] === "boolean") return userPerms[parentKey];
  }
  if (tenantDefaults) {
    if (typeof tenantDefaults[moduleKey] === "boolean") {
      return tenantDefaults[moduleKey];
    }
    if (parentKey && parentKey !== moduleKey && typeof tenantDefaults[parentKey] === "boolean") {
      return tenantDefaults[parentKey];
    }
  }

  // 3. Legacy boolean fallback (only for the modules that always had one).
  const legacyFlag = LEGACY_FLAG_MAP[moduleKey];
  if (legacyFlag) return Boolean(access[legacyFlag]);

  // 4. Open by default.
  return true;
}

/**
 * Resolve EVERY module key at once — the shape `/api/portal/me` returns to
 * the client (`module_access`) and the admin UI renders as toggle grids.
 */
export function resolveAllPortalModules(
  ctx: PortalModuleContext,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key of PORTAL_MODULE_KEYS) {
    out[key] = resolvePortalModule(ctx, key);
  }
  return out;
}

/**
 * Server-side route gate. Returns a 403 NextResponse (machine-readable
 * `code: "module_disabled"`, `module: <key>`) when the module is closed
 * for the caller, `null` when allowed. DB failures fail OPEN — see
 * getTenantPortalDefaults docblock.
 */
export async function requirePortalModule(
  access: PortalAccess,
  moduleKey: string,
): Promise<NextResponse | null> {
  if (!PORTAL_MODULE_KEYS.has(moduleKey)) {
    // Unknown module keys are a programming error — fail closed with a
    // clear message so the route author fixes the typo immediately.
    return NextResponse.json(
      { error: `Unknown portal module key: ${moduleKey}`, code: "module_unknown" },
      { status: 403 },
    );
  }
  let tenantDefaults: Record<string, boolean> = {};
  try {
    tenantDefaults = await getTenantPortalDefaults(access.tenant_id);
  } catch {
    // Fail-open (availability feature; data isolation lives in the routes).
  }
  const allowed = resolvePortalModule({ access, tenantDefaults }, moduleKey);
  if (allowed) return null;
  return NextResponse.json(
    {
      error: "This module is disabled for your account.",
      code: "module_disabled",
      module: moduleKey,
    },
    { status: 403 },
  );
}

/**
 * Sanitise a caller-supplied module_permissions payload before persisting:
 * keeps only known keys with boolean values, caps size. Returns a fresh
 * object (never mutates the input).
 */
export function sanitiseModulePermissions(
  input: unknown,
): Record<string, boolean> | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object" || Array.isArray(input)) return null;
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (PORTAL_MODULE_KEYS.has(k) && typeof v === "boolean") {
      out[k] = v;
    }
    if (Object.keys(out).length >= 64) break; // hard cap
  }
  return Object.keys(out).length > 0 ? out : null;
}
