/**
 * Server-side permission evaluator.
 *
 * The single source of truth for "can this user do X?".
 *
 * Rules (evaluated top-down; first match wins):
 *   1. Super-admin (role === "super_admin")                              → allow
 *   1b. Platform permission (`platform.*`) for non-super-admin           → DENY (even if user has "*" wildcard)
 *   2. Wildcard permission ("*") for non-super-admin                     → allow (non-platform only — see 1b)
 *   3. Role === "admin"                                                  → allow ANY non-platform permission (implicit tenant-wide grant)
 *   4. Explicit grant in user.permissions                                → allow (supports wildcards: `partners.*`, `erp.*`)
 *   5. Otherwise                                                         → deny
 *
 * NOTE: The `platform.*` deny (1b) runs BEFORE the wildcard-"*" allow
 * so that a regular admin whose `permissions` array contains "*" cannot
 * reach super-admin-only surfaces. Only `role === "super_admin"` may
 * pass `platform.*` checks. This invariant must hold on both the server
 * (this file) and the client mirror (`canUser()` in app-store.ts).
 *
 * Wildcards recognised in the user's permissions array:
 *   - "*"                      → grants everything
 *   - "resource.*"             → grants every action on the resource
 *   - "resource.action"        → grants exactly that action
 *
 * Note about the legacy `foo:bar` (colon) format that the API-key layer uses:
 * this evaluator is for HUMAN users only. API-key permissions still use the
 * colon format and are checked by `hasPermission()` in `@/lib/api/helpers`.
 */

import { NextResponse } from "next/server";
import type { AuthContext, ApiKeyAuthContext } from "@/lib/api/helpers";
import { isPlatformPerm } from "./catalog";
import {
  canWithOverride,
  loadTenantRolePermissions,
  getCachedRoleOverrides,
  type RoleOverrideDiff,
} from "./tenant-roles";

export interface PermissionSubject {
  role: string;
  permissions?: string[] | null;
  /**
   * Optional tenant_id. When present (and the role is non-super-admin),
   * `can()` consults the cached UI-driven role override diff for this
   * (tenant_id, role) pair — applying ADDITIVE grants and DENY
   * subtractions (deny wins). The cache is warmed by `requireAuth` so
   * by the time `can()` runs the cache is hot.
   *
   * Tests + legacy callers that omit this field simply skip the override
   * consultation (back-compat preserved).
   */
  tenant_id?: string | null;
}

/**
 * Internal: does `set` contain `permission`, the resource wildcard
 * (`resource.*`), or the platform wildcard `*`? Used for both grant +
 * deny override matching. Honors the legacy colon-format back-compat.
 */
function permSetContains(set: string[], permission: string): boolean {
  if (set.includes(permission)) return true;
  const dotIdx = permission.indexOf(".");
  if (dotIdx > 0) {
    const resourceWildcard = `${permission.slice(0, dotIdx)}.*`;
    if (set.includes(resourceWildcard)) return true;
  }
  if (set.includes("*")) return true;
  // Back-compat: legacy colon format
  const legacy = permission.replace(".", ":");
  if (set.includes(legacy)) return true;
  const colonIdx = legacy.indexOf(":");
  if (colonIdx > 0 && set.includes(`${legacy.slice(0, colonIdx)}:*`)) return true;
  return false;
}

/**
 * Internal: does the override's `denies` set cover `permission`?
 * (deny wins over grants + base perms.)
 */
function isDeniedByOverride(diff: RoleOverrideDiff | null, permission: string): boolean {
  if (!diff || diff.denies.length === 0) return false;
  return permSetContains(diff.denies, permission);
}

export function can(user: PermissionSubject | null | undefined, permission: string): boolean {
  if (!user) return false;

  // 1) Super-admin bypass — only `role === "super_admin"` short-circuits.
  //    A regular admin with `permissions: ["*"]` is NOT a super-admin and
  //    must NOT pass `platform.*` checks (handled by 1b below).
  if (user.role === "super_admin") return true;

  // 1b) Platform permissions are SUPER-ADMIN ONLY. This deny runs BEFORE
  //     the wildcard-"*" check below so an admin whose permissions array
  //     contains "*" still cannot reach super-admin-only surfaces (e.g.
  //     the Platform sidebar section, /api/super-admin/*, /api/admin/*).
  //     Without this ordering, the "*" wildcard would let tenant admins
  //     see the Platform section and call super-admin endpoints.
  if (isPlatformPerm(permission)) return false;

  const perms = user.permissions || [];
  // 2) Wildcard permission "*" grants everything EXCEPT platform perms
  //    (already returned false in 1b above).
  if (perms.includes("*")) return true;

  // ── Consult UI-driven role override (FIX-V1) ─────────────────────────
  // The cache is warmed by requireAuth; in tests / scripts where
  // requireAuth is bypassed, the cache is cold and this returns null
  // (graceful — falls through to base perms only).
  const override = getCachedRoleOverrides(user.role, user.tenant_id);

  // 3) Tenant admin has implicit access to every non-platform permission.
  //    BUT a "deny" override for this permission wins even over the
  //    admin implicit grant (deny semantics — the whole point of the
  //    "deny" mode in the UI).
  if (user.role === "admin") {
    if (isDeniedByOverride(override, permission)) return false;
    return true;
  }

  // 4) Explicit grants (with wildcard support) — base perms
  let granted = perms.includes(permission);
  if (!granted) {
    const dotIdx = permission.indexOf(".");
    if (dotIdx > 0 && perms.includes(`${permission.slice(0, dotIdx)}.*`)) {
      granted = true;
    }
  }
  if (!granted) {
    // Back-compat: also accept legacy "resource:*" and "resource:action" that
    // may still live in some seed data.
    const legacy = permission.replace(".", ":");
    if (perms.includes(legacy)) granted = true;
    else {
      const colonIdx = legacy.indexOf(":");
      if (colonIdx > 0 && perms.includes(`${legacy.slice(0, colonIdx)}:*`)) {
        granted = true;
      }
    }
  }

  // 5) Override GRANT (ADDITIVE) — only if not already granted by base
  if (!granted && override && override.grants.length > 0) {
    if (permSetContains(override.grants, permission)) {
      granted = true;
    }
  }

  // 6) Override DENY (wins over grants + base perms)
  if (granted && isDeniedByOverride(override, permission)) {
    return false;
  }

  return granted;
}

/**
 * Route guard. Returns a NextResponse (403) when the auth context lacks the
 * permission, or `null` when the caller may proceed.
 *
 * Usage:
 *   const auth = await requireAuth();
 *   if (auth instanceof NextResponse) return auth;
 *   const denied = requirePermission(auth, "partners.read");
 *   if (denied) return denied;
 */
export function requirePermission(
  auth: AuthContext,
  permission: string
): NextResponse | null {
  if (can(auth.user, permission)) return null;
  return NextResponse.json(
    {
      error: "Insufficient permissions.",
      required_permission: permission,
    },
    { status: 403 }
  );
}

/** Convenience: returns true iff the auth context can do `permission`. */
export function authCan(auth: AuthContext, permission: string): boolean {
  return can(auth.user, permission);
}

// ─── Per-tenant override-aware variants (P1-1 / Feature 1) ──────────────────
//
// These are the per-tenant-aware analogues of `can()` and `requirePermission()`.
// They consult the `tenant_role_overrides` table (migration 039) for an
// ADDITIONAL permission grant attached to the user's (tenant_id, role) pair.
//
// RULE: super_admin is NEVER subject to overrides. `canWithOverride()`
// returns `true` for super_admin before consulting the override; the async
// `loadTenantRolePermissions()` returns `null` for super_admin callers
// (so even an eager load does not attach super-admin-restricted perms to
// a super-admin caller's effective set).
//
// Routes that want to honour overrides should use:
//   const denied = await requirePermissionWithOverrides(auth, "offers.create");
//   if (denied) return denied;
//
// Routes that don't (the historical default — every existing route) can
// keep calling `requirePermission(auth, ...)` and behaviour is unchanged.
// The override system is opt-in per route to avoid a surprise permission
// expansion on legacy paths.

/**
 * Synchronous override-aware evaluator. Accepts a preloaded override
 * permission list. Routes that have already loaded the override can
 * call this directly; the convenience helper `requirePermissionWithOverrides`
 * below does the load + check in one async call.
 *
 * Mirrors the rule order of `can()` (super-admin first, platform-perm
 * gate, admin implicit grant, explicit user grant) and adds a final
 * step that consults the override (additive — override can only GRANT
 * additional perms, never revoke).
 *
 * Re-exports `canWithOverride` from `tenant-roles.ts` so callers can
 * import everything from one place.
 */
export { canWithOverride };

/**
 * Async route guard that loads the per-tenant override for the authed
 * user's (tenant_id, role) pair, then runs `canWithOverride()`.
 *
 * Returns `null` when the caller may proceed, or a 403 NextResponse
 * when the caller lacks the permission (after considering the override).
 *
 * Super-admin: returns `null` immediately (never blocked).
 *
 * API-key auth callers: this helper does NOT consult overrides (API
 * keys don't have a role and use the colon-format `hasPermission()`
 * evaluator instead). For mixed-auth routes, prefer the existing
 * `requireAuthOrApiKeyPermission()` helper — it already 403s API-key
 * callers without a DB lookup.
 */
export async function requirePermissionWithOverrides(
  auth: AuthContext,
  permission: string,
): Promise<NextResponse | null> {
  // Super-admin bypass — never blocked, never subject to overrides.
  if (auth.isSuperAdmin || auth.user.role === "super_admin") return null;

  const tenantOverride =
    auth.tenantId && auth.user.role
      ? await loadTenantRolePermissions(auth.tenantId, auth.user.role)
      : null;

  if (canWithOverride(auth.user, permission, tenantOverride)) {
    return null;
  }
  return NextResponse.json(
    {
      error: "Insufficient permissions.",
      required_permission: permission,
    },
    { status: 403 },
  );
}
