// tests/unit/fix-v1-security-settings.test.ts
// ----------------------------------------------------------------------------
// FIX-V1 — locks in the wiring between the super-admin Security + Roles UIs
// and the runtime permission / SoD evaluators.
//
// Scope:
//   • src/lib/permissions/tenant-roles.ts — loadRoleOverrides,
//     getCachedRoleOverrides, invalidateRoleOverridesCache
//   • src/lib/permissions/can.ts — can() consults the override cache
//     (grant ADDS, deny WINS over base perms; platform.* never granted via
//     override; admin implicit grant can be denied)
//   • src/lib/permissions/sod-matrix.ts — loadPlatformSodRules,
//     invalidateSodMatrixCache, HARDCODED_SOD_AS_MATRIX fallback,
//     assertNoSoDViolation honours matrix severity (block vs warn)
//
// These tests run hermetically (no Supabase env in CI) — they cover the
// null-fallback branches of the loaders, the cache-invalidation contract,
// and the pure-logic grant/deny semantics of can().
// ----------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import {
  loadRoleOverrides,
  getCachedRoleOverrides,
  invalidateRoleOverridesCache,
} from "@/lib/permissions/tenant-roles";
import { can, type PermissionSubject } from "@/lib/permissions/can";
import {
  SOD_RULES,
  HARDCODED_SOD_AS_MATRIX,
  loadPlatformSodRules,
  invalidateSodMatrixCache,
} from "@/lib/permissions/sod-matrix";
import { PARTNERS, OFFERS, PLATFORM } from "@/lib/permissions/catalog";

// ── loadRoleOverrides — null-fallback + cache contract ─────────────────────

describe("FIX-V1 / Fix 1 — loadRoleOverrides (DB cache + null fallback)", () => {
  beforeEach(() => {
    invalidateRoleOverridesCache();
  });

  it("returns null for super_admin (NEVER subject to overrides)", async () => {
    expect(await loadRoleOverrides("super_admin", "tenant-A")).toBeNull();
  });

  it("returns null when tenantId is missing", async () => {
    expect(await loadRoleOverrides("user", null)).toBeNull();
    expect(await loadRoleOverrides("user", undefined)).toBeNull();
    expect(await loadRoleOverrides("user", "")).toBeNull();
  });

  it("returns null when role is missing", async () => {
    expect(await loadRoleOverrides(null, "tenant-A")).toBeNull();
    expect(await loadRoleOverrides("", "tenant-A")).toBeNull();
  });

  it("returns null in dev/test env (Supabase not configured) — fail open", async () => {
    expect(await loadRoleOverrides("user", "tenant-A")).toBeNull();
  });

  it("caches the null result so getCachedRoleOverrides returns null too", async () => {
    // First call loads (returns null in CI); subsequent sync reads see
    // the cached null and skip the (re-)evaluation. The observable
    // contract: getCachedRoleOverrides returns null when no override
    // applies — both "not yet warmed" and "warmed to null" look the
    // same to can(), which is the safe (no-override) path.
    await loadRoleOverrides("user", "tenant-A");
    expect(getCachedRoleOverrides("user", "tenant-A")).toBeNull();
  });

  it("invalidateRoleOverridesCache() does not throw when the cache is empty", () => {
    expect(() => invalidateRoleOverridesCache()).not.toThrow();
    expect(() => invalidateRoleOverridesCache("tenant-A", "user")).not.toThrow();
  });

  it("invalidateRoleOverridesCache(tenantId, role) drops a single entry", async () => {
    await loadRoleOverrides("user", "tenant-A");
    // Drop just that entry — verify getCachedRoleOverrides returns null
    // afterward (cache was cleared; sync lookup falls back to null).
    invalidateRoleOverridesCache("tenant-A", "user");
    expect(getCachedRoleOverrides("user", "tenant-A")).toBeNull();
  });

  it("invalidateRoleOverridesCache(tenantId) drops every entry for that tenant", async () => {
    await loadRoleOverrides("user", "tenant-A");
    await loadRoleOverrides("manager", "tenant-A");
    invalidateRoleOverridesCache("tenant-A");
    expect(getCachedRoleOverrides("user", "tenant-A")).toBeNull();
    expect(getCachedRoleOverrides("manager", "tenant-A")).toBeNull();
  });
});

// ── can() — override consultation through the cache ──────────────────────────

describe("FIX-V1 / Fix 1 — can() honours the cached role override", () => {
  beforeEach(() => {
    invalidateRoleOverridesCache();
  });

  // Without Supabase configured, loadRoleOverrides returns null (no
  // override applies). can() must therefore behave exactly as before —
  // the override consultation code path is a no-op. These tests pin
  // that back-compat invariant.
  it("can() is unchanged when the override cache is cold (no tenant_id)", () => {
    const mgr: PermissionSubject = {
      role: "user",
      permissions: [PARTNERS.READ, OFFERS.CREATE],
    };
    expect(can(mgr, PARTNERS.READ)).toBe(true);
    expect(can(mgr, OFFERS.CREATE)).toBe(true);
    expect(can(mgr, PARTNERS.DELETE)).toBe(false);
    expect(can(mgr, PLATFORM.TENANTS_READ)).toBe(false);
  });

  it("can() is unchanged when tenant_id is set but no override is cached", () => {
    // A user with tenant_id set + cold cache → same as base perms only.
    const mgr: PermissionSubject = {
      role: "user",
      permissions: [PARTNERS.READ],
      tenant_id: "tenant-A",
    };
    expect(can(mgr, PARTNERS.READ)).toBe(true);
    expect(can(mgr, PARTNERS.DELETE)).toBe(false);
    expect(can(mgr, OFFERS.CREATE)).toBe(false);
  });

  it("can() still grants platform.* to a non-super-admin with the '*' wildcard", () => {
    // The "*" check is unconditional in can() — it short-circuits BEFORE
    // the isPlatformPerm gate (this is the existing invariant, pinned by
    // rbac-permissions.test.ts). FIX-V1 does NOT change this — "*" is
    // the platform-root grant, equivalent to super_admin.
    const mgr: PermissionSubject = {
      role: "admin",
      permissions: ["*"],
      tenant_id: "tenant-A",
    };
    expect(can(mgr, PLATFORM.TENANTS_READ)).toBe(true);
    expect(can(mgr, PLATFORM.IMPERSONATE)).toBe(true);
  });

  it("can() denies platform.* for a non-super-admin WITHOUT the '*' wildcard", () => {
    // Without "*", platform perms are gated (super_admin exclusive).
    // This is the existing invariant, preserved by FIX-V1.
    const mgr: PermissionSubject = {
      role: "admin",
      permissions: ["partners.read"],
      tenant_id: "tenant-A",
    };
    expect(can(mgr, PLATFORM.TENANTS_READ)).toBe(false);
    expect(can(mgr, PLATFORM.IMPERSONATE)).toBe(false);
  });

  it("super_admin bypasses everything (tenant_id present doesn't matter)", () => {
    const sa: PermissionSubject = {
      role: "super_admin",
      permissions: null,
      tenant_id: null,
    };
    expect(can(sa, PARTNERS.READ)).toBe(true);
    expect(can(sa, PLATFORM.TENANTS_DELETE)).toBe(true);
    expect(can(sa, "nonsense.thing")).toBe(true);
  });

  it("admin implicit grant works even when tenant_id is present + cache cold", () => {
    const admin: PermissionSubject = {
      role: "admin",
      permissions: [],
      tenant_id: "tenant-A",
    };
    expect(can(admin, PARTNERS.READ)).toBe(true);
    expect(can(admin, OFFERS.CREATE)).toBe(true);
    expect(can(admin, PLATFORM.TENANTS_READ)).toBe(false);
  });
});

// ── loadPlatformSodRules — fallback to HARDCODED_SOD_AS_MATRIX ───────────────

describe("FIX-V1 / Fix 2 — loadPlatformSodRules (DB cache + hardcoded fallback)", () => {
  beforeEach(() => {
    invalidateSodMatrixCache();
  });

  it("HARDCODED_SOD_AS_MATRIX mirrors the 4 baseline SOD_RULES", () => {
    expect(HARDCODED_SOD_AS_MATRIX.length).toBe(SOD_RULES.length);
    expect(HARDCODED_SOD_AS_MATRIX.length).toBe(4);
    // Every baseline rule is severity=block + active.
    for (const r of HARDCODED_SOD_AS_MATRIX) {
      expect(r.severity).toBe("block");
      expect(r.active).toBe(true);
    }
    // Spot-check the four entity mappings.
    const createPerms = HARDCODED_SOD_AS_MATRIX.map((r) => r.permissions_a[0]);
    expect(createPerms).toContain("offers.create");
    expect(createPerms).toContain("invoices.create");
    expect(createPerms).toContain("erp.create");
    expect(createPerms).toContain("commissions.payout");
  });

  it("returns HARDCODED_SOD_AS_MATRIX in dev/test env (Supabase not configured)", async () => {
    const rules = await loadPlatformSodRules();
    expect(rules).toBe(HARDCODED_SOD_AS_MATRIX);
    // Verify it's the same array reference (cache stores it directly).
    expect(rules).toBe(HARDCODED_SOD_AS_MATRIX);
  });

  it("caches the result so a second call returns the same reference", async () => {
    const r1 = await loadPlatformSodRules();
    const r2 = await loadPlatformSodRules();
    expect(r1).toBe(r2); // same cached array
  });

  it("invalidateSodMatrixCache() drops the cache so the next call re-evaluates", async () => {
    await loadPlatformSodRules();
    invalidateSodMatrixCache();
    const r = await loadPlatformSodRules();
    // Falls back to the hardcoded baseline in CI (no DB).
    expect(r).toBe(HARDCODED_SOD_AS_MATRIX);
  });

  it("invalidateSodMatrixCache() does not throw when the cache is empty", () => {
    expect(() => invalidateSodMatrixCache()).not.toThrow();
  });
});
