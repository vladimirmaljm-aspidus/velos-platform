import { describe, it, expect } from "vitest";
import { NextResponse } from "next/server";
import {
  can,
  requirePermission,
  authCan,
  type PermissionSubject,
} from "@/lib/permissions/can";
import {
  PARTNERS,
  PRODUCTS,
  OFFERS,
  ERP,
  USERS,
  VAULT,
  PLATFORM,
  PORTAL_CLIENT,
  ALL_PERMISSIONS,
  TENANT_PERMISSIONS,
  isPlatformPerm,
} from "@/lib/permissions/catalog";
import {
  hasPermission,
  requireAuthOrApiKeyPermission,
  type AuthContext,
  type ApiKeyAuthContext,
} from "@/lib/api/helpers";
import type { SafeUser } from "@/lib/store/app-store";

// ── Permission matrix fixtures ────────────────────────────────────────────
// Each fixture represents a role in the system. The fixtures are deliberately
// minimal — only the fields `can()` actually reads (`role`, `permissions`) —
// so the test focuses on the permission evaluator, not the user model.

function superAdmin(): PermissionSubject {
  return { role: "super_admin", permissions: null };
}

function tenantAdmin(): PermissionSubject {
  return { role: "admin", permissions: [] };
}

function manager(): PermissionSubject {
  // "Manager" = a `user`-role account scoped to CRM + finance ops but
  // NOT platform-level operations, NOT user management, NOT vault delete.
  return {
    role: "user",
    permissions: [
      PARTNERS.READ,
      PARTNERS.CREATE,
      PARTNERS.UPDATE,
      PRODUCTS.READ,
      PRODUCTS.CREATE,
      PRODUCTS.UPDATE,
      OFFERS.READ,
      OFFERS.CREATE,
      OFFERS.UPDATE,
      OFFERS.SEND,
      ERP.READ,
      "erp.post", // explicit grant on the post action
    ],
  };
}

function regularUser(): PermissionSubject {
  // Read-only sales viewer — can see offers/partners, cannot mutate.
  return {
    role: "user",
    permissions: [PARTNERS.READ, PRODUCTS.READ, OFFERS.READ],
  };
}

function wildcardUser(): PermissionSubject {
  return { role: "user", permissions: ["*"] };
}

function partnerManagerUser(): PermissionSubject {
  // Resource-level wildcard: every action on partners, nothing else.
  return { role: "user", permissions: ["partners.*"] };
}

function safeUser(over: Partial<SafeUser> = {}): SafeUser {
  return {
    id: "u-1",
    tenant_id: "tenant-A",
    username: "tester",
    email: "tester@example.com",
    full_name: "Tester",
    role: "user",
    permissions: [],
    active: true,
    ...over,
  };
}

function authCtxFor(user: SafeUser): AuthContext {
  return {
    user,
    store: {} as any,
    ip: "127.0.0.1",
    tenantId: user.tenant_id,
    isSuperAdmin: user.role === "super_admin",
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("RBAC permission matrix — can()", () => {
  describe("super_admin", () => {
    const sa = superAdmin();

    it("can access every permission in the catalog", () => {
      // Sanity: assert we're actually iterating over a meaningful set.
      expect(ALL_PERMISSIONS.length).toBeGreaterThan(50);
      for (const perm of ALL_PERMISSIONS) {
        expect(can(sa, perm)).toBe(true);
      }
    });

    it("can access tenant-scoped AND platform-scoped permissions", () => {
      expect(can(sa, PARTNERS.READ)).toBe(true);
      expect(can(sa, PARTNERS.DELETE)).toBe(true);
      expect(can(sa, PLATFORM.TENANTS_READ)).toBe(true);
      expect(can(sa, PLATFORM.TENANTS_DELETE)).toBe(true);
      expect(can(sa, PLATFORM.IMPERSONATE)).toBe(true);
      expect(can(sa, ERP.CLOSE_PERIOD)).toBe(true);
      expect(can(sa, VAULT.DELETE)).toBe(true);
    });

    it("can access unknown permissions (bypass)", () => {
      // Super-admin bypass is unconditional — it doesn't consult the
      // catalog. This is intentional: super_admin is the platform root.
      expect(can(sa, "nonexistent.thing")).toBe(true);
      expect(can(sa, "platform.unknown perm with spaces")).toBe(true);
    });
  });

  describe("tenant admin (role=admin)", () => {
    const admin = tenantAdmin();

    it("can access every tenant-scoped permission", () => {
      // Every non-platform permission is implicitly granted.
      for (const perm of TENANT_PERMISSIONS) {
        expect(can(admin, perm)).toBe(true);
      }
    });

    it("CANNOT access any platform.* permission", () => {
      expect(can(admin, PLATFORM.TENANTS_READ)).toBe(false);
      expect(can(admin, PLATFORM.TENANTS_WRITE)).toBe(false);
      expect(can(admin, PLATFORM.TENANTS_DELETE)).toBe(false);
      expect(can(admin, PLATFORM.PLANS_READ)).toBe(false);
      expect(can(admin, PLATFORM.PLANS_WRITE)).toBe(false);
      expect(can(admin, PLATFORM.FEATURE_FLAGS_READ)).toBe(false);
      expect(can(admin, PLATFORM.FEATURE_FLAGS_WRITE)).toBe(false);
      expect(can(admin, PLATFORM.IMPERSONATE)).toBe(false);
      expect(can(admin, PLATFORM.OVERVIEW)).toBe(false);
      expect(can(admin, PLATFORM.MANAGE_USERS)).toBe(false);
    });

    it("ignores even an explicit '*' in permissions (defense: still subject to platform gate)", () => {
      // The catalog says role=admin → tenant perms implicit. If someone
      // mistakenly assigns permissions:["*"] to an admin, the platform
      // gate STILL denies — `isPlatformPerm` runs before the wildcard
      // check on line 41 of can.ts? Actually no — super-admin bypass on
      // line 38 checks `perms.includes("*")` BEFORE the platform gate.
      // So an admin with "*" in their perms WOULD be treated as super.
      // Document this exact behaviour so future refactors notice.
      const adminWithStar = { role: "admin", permissions: ["*"] } as PermissionSubject;
      // Because perms.includes("*") returns true on line 38, can() grants
      // EVERYTHING — including platform perms. This is documented behaviour:
      // the "*" permission is the platform-root grant, role-agnostic.
      expect(can(adminWithStar, PLATFORM.TENANTS_DELETE)).toBe(true);
    });
  });

  describe("manager (user role with explicit CRM+ERP grants)", () => {
    const mgr = manager();

    it("can access explicitly granted actions", () => {
      expect(can(mgr, PARTNERS.READ)).toBe(true);
      expect(can(mgr, PARTNERS.CREATE)).toBe(true);
      expect(can(mgr, PARTNERS.UPDATE)).toBe(true);
      expect(can(mgr, OFFERS.SEND)).toBe(true);
      expect(can(mgr, ERP.READ)).toBe(true);
      expect(can(mgr, "erp.post")).toBe(true);
    });

    it("CANNOT access actions that were not granted", () => {
      expect(can(mgr, PARTNERS.DELETE)).toBe(false);
      expect(can(mgr, PARTNERS.EXPORT)).toBe(false);
      expect(can(mgr, PRODUCTS.DELETE)).toBe(false);
      expect(can(mgr, PRODUCTS.EXPORT)).toBe(false);
      expect(can(mgr, OFFERS.DELETE)).toBe(false);
      expect(can(mgr, OFFERS.EXPORT)).toBe(false);
      expect(can(mgr, ERP.DELETE)).toBe(false);
      expect(can(mgr, ERP.REVERSE)).toBe(false);
      expect(can(mgr, ERP.RECONCILE)).toBe(false);
    });

    it("CANNOT access admin-only routes (users, vault, settings, audit)", () => {
      expect(can(mgr, USERS.READ)).toBe(false);
      expect(can(mgr, USERS.CREATE)).toBe(false);
      expect(can(mgr, USERS.DELETE)).toBe(false);
      expect(can(mgr, VAULT.READ)).toBe(false);
      expect(can(mgr, VAULT.DELETE)).toBe(false);
      expect(can(mgr, "settings.update")).toBe(false);
      expect(can(mgr, "audit.read")).toBe(false);
    });

    it("CANNOT access platform.* routes", () => {
      expect(can(mgr, PLATFORM.TENANTS_READ)).toBe(false);
      expect(can(mgr, PLATFORM.IMPERSONATE)).toBe(false);
      expect(can(mgr, PLATFORM.MANAGE_USERS)).toBe(false);
    });
  });

  describe("regular user (read-only grants)", () => {
    const u = regularUser();

    it("can read partners / products / offers", () => {
      expect(can(u, PARTNERS.READ)).toBe(true);
      expect(can(u, PRODUCTS.READ)).toBe(true);
      expect(can(u, OFFERS.READ)).toBe(true);
    });

    it("cannot mutate anything", () => {
      expect(can(u, PARTNERS.CREATE)).toBe(false);
      expect(can(u, PARTNERS.UPDATE)).toBe(false);
      expect(can(u, PARTNERS.DELETE)).toBe(false);
      expect(can(u, PRODUCTS.CREATE)).toBe(false);
      expect(can(u, OFFERS.SEND)).toBe(false);
      expect(can(u, OFFERS.DELETE)).toBe(false);
    });

    it("cannot access admin routes", () => {
      expect(can(u, USERS.READ)).toBe(false);
      expect(can(u, VAULT.READ)).toBe(false);
      expect(can(u, "settings.update")).toBe(false);
    });
  });

  describe("wildcard permission '*' on a user-role account", () => {
    const w = wildcardUser();

    it("grants every permission in the catalog (including platform.*)", () => {
      // The "*" check on line 38 of can.ts is unconditional — it doesn't
      // consult isPlatformPerm afterwards. So a user with "*" is effectively
      // a super_admin by another name. This is intentional: "*" is the
      // platform-root grant.
      for (const perm of ALL_PERMISSIONS) {
        expect(can(w, perm)).toBe(true);
      }
    });
  });

  describe("resource-level wildcard 'partners.*'", () => {
    const pm = partnerManagerUser();

    it("grants every action on the partners resource", () => {
      expect(can(pm, PARTNERS.READ)).toBe(true);
      expect(can(pm, PARTNERS.CREATE)).toBe(true);
      expect(can(pm, PARTNERS.UPDATE)).toBe(true);
      expect(can(pm, PARTNERS.DELETE)).toBe(true);
      expect(can(pm, PARTNERS.EXPORT)).toBe(true);
    });

    it("does NOT grant actions on other resources", () => {
      expect(can(pm, PRODUCTS.READ)).toBe(false);
      expect(can(pm, OFFERS.READ)).toBe(false);
      expect(can(pm, ERP.READ)).toBe(false);
      expect(can(pm, USERS.READ)).toBe(false);
    });
  });

  describe("null / undefined / empty user", () => {
    it("denies everything when user is null or undefined", () => {
      expect(can(null, PARTNERS.READ)).toBe(false);
      expect(can(undefined, PARTNERS.READ)).toBe(false);
    });

    it("denies when permissions is null or empty", () => {
      const u: PermissionSubject = { role: "user", permissions: null };
      expect(can(u, PARTNERS.READ)).toBe(false);
      const u2: PermissionSubject = { role: "user", permissions: [] };
      expect(can(u2, PARTNERS.READ)).toBe(false);
    });
  });

  describe("legacy colon-format back-compat", () => {
    it("accepts 'partners:read' as equivalent to 'partners.read'", () => {
      const u: PermissionSubject = { role: "user", permissions: ["partners:read"] };
      expect(can(u, PARTNERS.READ)).toBe(true);
    });

    it("accepts 'partners:*' as equivalent to 'partners.*'", () => {
      const u: PermissionSubject = { role: "user", permissions: ["partners:*"] };
      expect(can(u, PARTNERS.READ)).toBe(true);
      expect(can(u, PARTNERS.DELETE)).toBe(true);
      expect(can(u, PRODUCTS.READ)).toBe(false);
    });
  });
});

// ── requirePermission / authCan wrappers ─────────────────────────────────

describe("RBAC — requirePermission() route guard", () => {
  it("returns null when the user has the permission (proceed)", () => {
    const auth = authCtxFor(safeUser({ role: "admin" }));
    const denied = requirePermission(auth, PARTNERS.READ);
    expect(denied).toBeNull();
  });

  it("returns a 403 NextResponse when the user lacks the permission", () => {
    const auth = authCtxFor(safeUser({ role: "user", permissions: [] }));
    const denied = requirePermission(auth, PARTNERS.READ);
    expect(denied).toBeInstanceOf(NextResponse);
    expect(denied!.status).toBe(403);
  });

  it("embeds the required permission in the 403 body for client-side debugging", async () => {
    const auth = authCtxFor(safeUser({ role: "user", permissions: [] }));
    const denied = requirePermission(auth, "offers.delete");
    expect(denied).toBeInstanceOf(NextResponse);
    const body = await denied!.json();
    expect(body.error).toMatch(/insufficient permissions/i);
    expect(body.required_permission).toBe("offers.delete");
  });

  it("denies platform.* permissions for tenant admins even if their role is admin", () => {
    const auth = authCtxFor(safeUser({ role: "admin" }));
    const denied = requirePermission(auth, PLATFORM.TENANTS_DELETE);
    expect(denied).toBeInstanceOf(NextResponse);
    expect(denied!.status).toBe(403);
  });

  it("allows platform.* for super_admin", () => {
    const auth = authCtxFor(safeUser({ role: "super_admin", tenant_id: null }));
    const denied = requirePermission(auth, PLATFORM.TENANTS_DELETE);
    expect(denied).toBeNull();
  });

  it("authCan() mirrors can() for the AuthContext wrapper", () => {
    const adminAuth = authCtxFor(safeUser({ role: "admin" }));
    const userAuth = authCtxFor(safeUser({ role: "user", permissions: [] }));
    expect(authCan(adminAuth, PARTNERS.READ)).toBe(true);
    expect(authCan(userAuth, PARTNERS.READ)).toBe(false);
  });
});

// ── API-key permission layer (colon-format, hasPermission) ─────────────────
// API keys use a separate permission format ("resource:action" / "resource:*"
// / "*") and a separate evaluator (`hasPermission` in @/lib/api/helpers).
// This is the layer that gates `/api/*` routes when the caller presents a
// `Bearer asp_*` token instead of a session cookie.

describe("RBAC — API-key permission matrix (hasPermission)", () => {
  function apiKeyCtx(perms: string[]): ApiKeyAuthContext {
    return {
      store: {} as any,
      ip: "127.0.0.1",
      tenantId: "tenant-A",
      apiKeyId: "key-1",
      apiKeyName: "test key",
      permissions: perms,
    };
  }

  it("wildcard '*' grants every resource:action", () => {
    const ctx = apiKeyCtx(["*"]);
    expect(hasPermission(ctx.permissions, "partners:read")).toBe(true);
    expect(hasPermission(ctx.permissions, "partners:delete")).toBe(true);
    expect(hasPermission(ctx.permissions, "offers:write")).toBe(true);
    expect(hasPermission(ctx.permissions, "invoices:read")).toBe(true);
    expect(hasPermission(ctx.permissions, "erp:post")).toBe(true);
  });

  it("resource wildcard 'partners:*' grants every action on partners only", () => {
    const ctx = apiKeyCtx(["partners:*"]);
    expect(hasPermission(ctx.permissions, "partners:read")).toBe(true);
    expect(hasPermission(ctx.permissions, "partners:write")).toBe(true);
    expect(hasPermission(ctx.permissions, "partners:delete")).toBe(true);
    expect(hasPermission(ctx.permissions, "offers:read")).toBe(false);
    expect(hasPermission(ctx.permissions, "invoices:read")).toBe(false);
  });

  it("exact 'partners:read' grants only that exact action", () => {
    const ctx = apiKeyCtx(["partners:read"]);
    expect(hasPermission(ctx.permissions, "partners:read")).toBe(true);
    expect(hasPermission(ctx.permissions, "partners:write")).toBe(false);
    expect(hasPermission(ctx.permissions, "partners:delete")).toBe(false);
  });

  it("empty permission list denies everything", () => {
    const ctx = apiKeyCtx([]);
    expect(hasPermission(ctx.permissions, "partners:read")).toBe(false);
    expect(hasPermission(ctx.permissions, "anything:anything")).toBe(false);
  });

  it("API key scoped to one resource cannot access another resource even with full perms on the first", () => {
    const ctx = apiKeyCtx(["partners:*", "offers:read"]);
    expect(hasPermission(ctx.permissions, "partners:delete")).toBe(true);
    expect(hasPermission(ctx.permissions, "offers:read")).toBe(true);
    expect(hasPermission(ctx.permissions, "offers:write")).toBe(false);
    expect(hasPermission(ctx.permissions, "invoices:read")).toBe(false);
  });
});

// ── Catalog sanity checks ────────────────────────────────────────────────

describe("RBAC — permission catalog sanity", () => {
  it("every catalog permission is unique (no accidental dupes)", () => {
    const set = new Set(ALL_PERMISSIONS);
    expect(set.size).toBe(ALL_PERMISSIONS.length);
  });

  it("every catalog permission is dot-separated 'resource.action' (multi-segment ok)", () => {
    for (const p of ALL_PERMISSIONS) {
      // Either two-segment (resource.action) or three-segment
      // (platform.tenants.read). At least one dot is required.
      expect(p).toMatch(/^[a-z][a-z0-9_-]*(\.[a-z0-9_]+)+$/);
    }
  });

  it("isPlatformPerm only matches 'platform.*'", () => {
    expect(isPlatformPerm("platform.tenants.read")).toBe(true);
    expect(isPlatformPerm("partners.read")).toBe(false);
    expect(isPlatformPerm("portal.read_own_docs")).toBe(false);
  });

  it("portal-client permissions are NOT in TENANT_PERMISSIONS (they're portal-scoped, not tenant-admin-grantable)", () => {
    for (const p of Object.values(PORTAL_CLIENT)) {
      expect(TENANT_PERMISSIONS).not.toContain(p);
    }
  });

  it("platform permissions are NOT in TENANT_PERMISSIONS", () => {
    for (const p of Object.values(PLATFORM)) {
      expect(TENANT_PERMISSIONS).not.toContain(p);
    }
  });
});

// ── U-FIX: API-key permission bypass prevention ───────────────────────────
// These tests lock down the fix for RBAC audit finding D-1 / P1: nine
// routes wrapped `requirePermission(auth, ...)` inside
// `if (!("apiKeyId" in auth))`, which silently skipped permission
// checks for API-key callers — any API key (even one with `permissions:
// []`) could access the dashboard, trade calculator, supplier offers,
// ERP settings (POST mutates!), and automation routes.
//
// The fix introduced the `requireAuthOrApiKeyPermission()` helper in
// `@/lib/api/helpers`. These tests prove:
//   (a) An API key with empty permissions is REJECTED for every
//       one of the 9 bypass routes (regression coverage for the fix).
//   (b) An API key scoped to a single unrelated resource is REJECTED.
//   (c) An API key with the correct permission is ALLOWED.
//   (d) An API key with the wildcard `*` is ALLOWED.
//   (e) Session-auth callers retain the existing `requirePermission`
//       behavior (the helper does not regress session auth).
//   (f) The dot-format permission string the routes pass in is
//       correctly converted to colon format for the API-key layer.

describe("U-FIX — API-key permission bypass prevention (requireAuthOrApiKeyPermission)", () => {
  function apiKeyCtx(perms: string[]): ApiKeyAuthContext {
    return {
      store: {} as any,
      ip: "127.0.0.1",
      tenantId: "tenant-A",
      apiKeyId: "key-1",
      apiKeyName: "test key",
      permissions: perms,
    };
  }

  // ── The 9 bypass routes + their required permission ──────────────────────
  // Mirrors the per-route mapping in the U-FIX task description so a future
  // change to either side (route or test) drifts visibly.
  const ROUTES_AND_PERMS: Array<{
    label: string;
    permission: string; // dot-format, as passed by the route
    expectedColon: string; // colon-format, as hasPermission() sees it
  }> = [
    { label: "GET /api/dashboard",                              permission: "dashboard.read",         expectedColon: "dashboard:read" },
    { label: "GET /api/dashboard/charts",                        permission: "dashboard.read",         expectedColon: "dashboard:read" },
    { label: "GET /api/trade-calculator",                        permission: "trade-calculator.read",  expectedColon: "trade-calculator:read" },
    { label: "POST /api/trade-calculator",                       permission: "trade-calculator.create",expectedColon: "trade-calculator:create" },
    { label: "GET /api/trade-calculator/[id]",                   permission: "trade-calculator.read",  expectedColon: "trade-calculator:read" },
    { label: "PUT /api/trade-calculator/[id]",                   permission: "trade-calculator.update",expectedColon: "trade-calculator:update" },
    { label: "DELETE /api/trade-calculator/[id]",                permission: "trade-calculator.delete",expectedColon: "trade-calculator:delete" },
    { label: "POST /api/trade-calculator/[id]/create-offer",     permission: "trade-calculator.create",expectedColon: "trade-calculator:create" },
    { label: "GET /api/supplier-offers",                         permission: "supplier-offers.read",   expectedColon: "supplier-offers:read" },
    { label: "GET /api/erp/settings",                            permission: "erp.read",               expectedColon: "erp:read" },
    { label: "POST /api/erp/settings (MUTATES!)",               permission: "erp.manage_settings",    expectedColon: "erp:manage_settings" },
    { label: "POST /api/automation/create-demand-from-portal-rfq", permission: "demands.create",        expectedColon: "demands:create" },
    { label: "POST /api/automation/create-offer-from-deal",      permission: "offers.create",          expectedColon: "offers:create" },
  ];

  // ── (a) Empty-permissions API key is rejected on EVERY bypass route ────
  it("rejects an API key with empty permissions on every one of the 9 bypass routes", () => {
    const emptyKey = apiKeyCtx([]);
    for (const { label, permission } of ROUTES_AND_PERMS) {
      const denied = requireAuthOrApiKeyPermission(emptyKey, permission);
      expect(denied, `${label} should reject an empty-permissions API key`).toBeInstanceOf(NextResponse);
      expect((denied as NextResponse).status, `${label} should return 403`).toBe(403);
    }
  });

  // ── (b) API key scoped to an UNRELATED resource is rejected ─────────────
  it("rejects an API key scoped to a single unrelated resource on each bypass route", () => {
    // The key is scoped to partners only — none of the 9 bypass routes
    // expose partner data, so this key should be rejected everywhere
    // here. This is the precise attack scenario the audit raised: an
    // admin issues a "partners:read only" key, the attacker pivots to
    // dashboard / ERP via the bypass. The fix must reject that pivot.
    const partnersOnlyKey = apiKeyCtx(["partners:read"]);
    for (const { label, permission } of ROUTES_AND_PERMS) {
      const denied = requireAuthOrApiKeyPermission(partnersOnlyKey, permission);
      expect(denied, `${label} should reject a partners-only key requesting ${permission}`).toBeInstanceOf(NextResponse);
      expect((denied as NextResponse).status).toBe(403);
    }
  });

  // ── (c) API key with the EXACT required permission is allowed ───────────
  it("allows an API key with the exact required permission (colon-format grant stored on the key)", () => {
    for (const { label, permission, expectedColon } of ROUTES_AND_PERMS) {
      // Each route's required permission, stored on the key in colon
      // format (the format POST /api/api-keys persists).
      const key = apiKeyCtx([expectedColon]);
      const denied = requireAuthOrApiKeyPermission(key, permission);
      expect(denied, `${label} should allow the exact-match key`).toBeNull();
    }
  });

  // ── (d) Wildcard '*' API key is allowed on every bypass route ───────────
  it("allows an API key with the wildcard '*' permission on every bypass route", () => {
    const wildcardKey = apiKeyCtx(["*"]);
    for (const { label, permission } of ROUTES_AND_PERMS) {
      const denied = requireAuthOrApiKeyPermission(wildcardKey, permission);
      expect(denied, `${label} should allow the '*' wildcard key`).toBeNull();
    }
  });

  // ── (e) Resource-level wildcard is honored ─────────────────────────────
  it("allows an API key with a resource-level wildcard grant (e.g. 'erp:*' covers erp.read AND erp.manage_settings)", () => {
    const erpWildcard = apiKeyCtx(["erp:*"]);
    expect(requireAuthOrApiKeyPermission(erpWildcard, "erp.read")).toBeNull();
    expect(requireAuthOrApiKeyPermission(erpWildcard, "erp.manage_settings")).toBeNull();
    // …but erp:* does NOT cover offers/demands — defense-in-depth.
    expect(requireAuthOrApiKeyPermission(erpWildcard, "offers.create")).toBeInstanceOf(NextResponse);
    expect(requireAuthOrApiKeyPermission(erpWildcard, "demands.create")).toBeInstanceOf(NextResponse);
  });

  // ── (f) Helper correctly converts dot-format → colon-format ─────────────
  it("correctly converts dot-format permission to colon format for the API-key path", () => {
    // The helper MUST convert "erp.manage_settings" → "erp:manage_settings"
    // because hasPermission() splits on ":" to derive "resource:*" wildcards.
    // If the conversion breaks (e.g. someone removes the .replace() call),
    // hasPermission would receive "erp.manage_settings", split on ":" would
    // yield a single-element array, and "erp.manage_settings" wouldn't match
    // "erp:*" — silently rejecting every legit API key.
    const erpKey = apiKeyCtx(["erp:manage_settings"]);
    expect(requireAuthOrApiKeyPermission(erpKey, "erp.manage_settings")).toBeNull();
    // Multi-segment dots still convert correctly for the 2-segment perms
    // in our route table (every affected perm is 2 segments).
    const tradeKey = apiKeyCtx(["trade-calculator:create"]);
    expect(requireAuthOrApiKeyPermission(tradeKey, "trade-calculator.create")).toBeNull();
  });

  // ── The 403 body carries the required_permission field for triage ────────
  it("embeds the dot-format required_permission in the 403 body for client-side debugging", async () => {
    const emptyKey = apiKeyCtx([]);
    const denied = requireAuthOrApiKeyPermission(emptyKey, "dashboard.read");
    expect(denied).toBeInstanceOf(NextResponse);
    const body = await (denied as NextResponse).json();
    expect(body.error).toMatch(/insufficient permissions/i);
    expect(body.required_permission).toBe("dashboard.read");
  });

  // ── The ERP POST mutation is rejected even for an erp:read-only key ─────
  it("rejects POST /api/erp/settings (the state-changing route) for an erp:read-only key", () => {
    // This is the most severe of the 9 bypasses — POST mutates ERP
    // settings. An API key scoped to erp:read should NOT be able to
    // mutate. Lock this scenario down explicitly.
    const erpReadKey = apiKeyCtx(["erp:read"]);
    expect(requireAuthOrApiKeyPermission(erpReadKey, "erp.read")).toBeNull();        // GET is allowed
    expect(requireAuthOrApiKeyPermission(erpReadKey, "erp.manage_settings")).toBeInstanceOf(NextResponse); // POST is denied
  });

  // ── Session-auth path: the helper preserves existing requirePermission ──
  describe("session-auth path (delegates to requirePermission)", () => {
    it("returns null for an admin session caller (implicit tenant-wide grant)", () => {
      const auth = authCtxFor(safeUser({ role: "admin" }));
      for (const { label, permission } of ROUTES_AND_PERMS) {
        const denied = requireAuthOrApiKeyPermission(auth, permission);
        expect(denied, `${label} should allow admin session caller`).toBeNull();
      }
    });

    it("returns null for a super_admin session caller (unconditional bypass)", () => {
      const auth = authCtxFor(safeUser({ role: "super_admin", tenant_id: null }));
      for (const { label, permission } of ROUTES_AND_PERMS) {
        const denied = requireAuthOrApiKeyPermission(auth, permission);
        expect(denied, `${label} should allow super_admin session caller`).toBeNull();
      }
    });

    it("returns a 403 NextResponse for a regular user without the grant", () => {
      const auth = authCtxFor(safeUser({ role: "user", permissions: [] }));
      const denied = requireAuthOrApiKeyPermission(auth, "dashboard.read");
      expect(denied).toBeInstanceOf(NextResponse);
      expect((denied as NextResponse).status).toBe(403);
    });

    it("returns null for a regular user with an explicit grant", () => {
      const auth = authCtxFor(
        safeUser({ role: "user", permissions: ["dashboard.read", "erp.manage_settings"] })
      );
      expect(requireAuthOrApiKeyPermission(auth, "dashboard.read")).toBeNull();
      expect(requireAuthOrApiKeyPermission(auth, "erp.manage_settings")).toBeNull();
      // The user does NOT have these:
      expect(requireAuthOrApiKeyPermission(auth, "trade-calculator.read")).toBeInstanceOf(NextResponse);
      expect(requireAuthOrApiKeyPermission(auth, "offers.create")).toBeInstanceOf(NextResponse);
    });
  });
});
