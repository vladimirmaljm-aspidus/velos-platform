// tests/unit/rbac-enhancements.test.ts
// ----------------------------------------------------------------------------
// P1-1 / RBAC Enhancements — per-tenant role overrides, SoD matrix,
// and configurable retention windows.
//
// Covers:
//   • src/lib/permissions/tenant-roles.ts — canWithOverride,
//     validateTenantRoleOverride, loadTenantRolePermissions cache
//     behaviour (DB is not configured → null).
//   • src/lib/permissions/sod-matrix.ts — checkSoD, findSoDRuleByCreatePerm,
//     findSoDRuleByApprovePerm, SOD_RULES coverage.
//   • src/lib/compliance/retention.ts — validateRetentionConfig,
//     getEnforceableRetentionRules, DEFAULT_RETENTION_CONFIG.
//
// These tests focus on the pure-logic helpers. The async DB-loading
// helpers (loadTenantRolePermissions, getRetentionConfig) are tested
// via their null-fallback branches (no Supabase env in CI), which
// keeps the test suite hermetic.
// ----------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import {
  canWithOverride,
  validateTenantRoleOverride,
  loadTenantRolePermissions,
  invalidateTenantRolePermissionsCache,
} from "@/lib/permissions/tenant-roles";
import { can } from "@/lib/permissions/can";
import {
  PARTNERS,
  OFFERS,
  ERP,
  TENANT_ROLES,
  ALL_PERMISSIONS,
  PLATFORM,
} from "@/lib/permissions/catalog";
import {
  SOD_RULES,
  checkSoD,
  findSoDRuleByCreatePerm,
  findSoDRuleByApprovePerm,
} from "@/lib/permissions/sod-matrix";
import {
  DEFAULT_RETENTION_CONFIG,
  validateRetentionConfig,
  getEnforceableRetentionRules,
  invalidateRetentionConfigCache,
} from "@/lib/compliance/retention";

// ── tenant-roles: canWithOverride ─────────────────────────────────────────

describe("P1-1 / Feature 1 — canWithOverride (per-tenant role customization)", () => {
  it("super_admin NEVER consults the override — bypasses everything", () => {
    // Super-admin with no permissions, no override — still gets everything.
    expect(canWithOverride({ role: "super_admin" }, PARTNERS.READ, null)).toBe(true);
    expect(canWithOverride({ role: "super_admin" }, PLATFORM.TENANTS_DELETE, null)).toBe(true);
    expect(canWithOverride({ role: "super_admin" }, "nonsense.thing", null)).toBe(true);
    // Even with an override present, super-admin ignores it.
    expect(canWithOverride({ role: "super_admin" }, PARTNERS.READ, [PARTNERS.CREATE])).toBe(true);
  });

  it("user with explicit permission passes WITHOUT needing the override", () => {
    const user = { role: "user", permissions: [PARTNERS.READ] };
    expect(canWithOverride(user, PARTNERS.READ, null)).toBe(true);
    expect(canWithOverride(user, PARTNERS.READ, [PARTNERS.CREATE])).toBe(true);
    // Without the override, the user CANNOT do PARTNERS.CREATE.
    expect(canWithOverride(user, PARTNERS.CREATE, null)).toBe(false);
    // WITH the override granting PARTNERS.CREATE, the user CAN.
    expect(canWithOverride(user, PARTNERS.CREATE, [PARTNERS.CREATE])).toBe(true);
  });

  it("override is ADDITIVE — never revokes the user's existing grants", () => {
    // User has offers.create. Override grants offers.send. User keeps both.
    const user = { role: "user", permissions: [OFFERS.CREATE] };
    expect(canWithOverride(user, OFFERS.CREATE, [OFFERS.SEND])).toBe(true);
    expect(canWithOverride(user, OFFERS.SEND, [OFFERS.SEND])).toBe(true);
    // Override does NOT take away offers.create (additive, never revoke).
    expect(canWithOverride(user, OFFERS.CREATE, [])).toBe(true);
    expect(canWithOverride(user, OFFERS.SEND, [])).toBe(false);
  });

  it("override with resource wildcard grants every action on the resource", () => {
    const user = { role: "user", permissions: [] };
    const override = ["offers.*"];
    expect(canWithOverride(user, OFFERS.CREATE, override)).toBe(true);
    expect(canWithOverride(user, OFFERS.SEND, override)).toBe(true);
    expect(canWithOverride(user, OFFERS.DELETE, override)).toBe(true);
    // But NOT actions on a different resource.
    expect(canWithOverride(user, PARTNERS.READ, override)).toBe(false);
  });

  it("override with '*' grants every non-platform permission (platform perms still denied)", () => {
    const user = { role: "user", permissions: [] };
    const override = ["*"];
    expect(canWithOverride(user, OFFERS.CREATE, override)).toBe(true);
    expect(canWithOverride(user, ERP.POST, override)).toBe(true);
    // Platform perms are still gated (super_admin exclusive).
    expect(canWithOverride(user, PLATFORM.TENANTS_READ, override)).toBe(false);
    expect(canWithOverride(user, PLATFORM.IMPERSONATE, override)).toBe(false);
  });

  it("admin role implicitly has every non-platform perm — override is redundant", () => {
    const admin = { role: "admin", permissions: [] };
    expect(canWithOverride(admin, PARTNERS.READ, null)).toBe(true);
    expect(canWithOverride(admin, ERP.POST, null)).toBe(true);
    // Platform perms still denied.
    expect(canWithOverride(admin, PLATFORM.TENANTS_READ, null)).toBe(false);
  });

  it("override in legacy colon format still works (back-compat)", () => {
    const user = { role: "user", permissions: [] };
    const override = ["offers:create", "offers:send"];
    expect(canWithOverride(user, OFFERS.CREATE, override)).toBe(true);
    expect(canWithOverride(user, OFFERS.SEND, override)).toBe(true);
    expect(canWithOverride(user, OFFERS.READ, override)).toBe(false);
  });

  it("can() is unchanged when no override is preloaded (back-compat for legacy routes)", () => {
    // Routes that don't use canWithOverride still call can() — verify
    // the existing behaviour is preserved.
    const mgr = { role: "user", permissions: [PARTNERS.READ, OFFERS.CREATE] };
    expect(can(mgr, PARTNERS.READ)).toBe(true);
    expect(can(mgr, OFFERS.CREATE)).toBe(true);
    expect(can(mgr, PARTNERS.DELETE)).toBe(false);
  });
});

// ── tenant-roles: validateTenantRoleOverride ──────────────────────────────

describe("P1-1 / Feature 1 — validateTenantRoleOverride (override write validation)", () => {
  it("rejects a non-array permissions value", () => {
    const errors = validateTenantRoleOverride("not-an-array");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("array"))).toBe(true);
  });

  it("rejects an empty array (use DELETE to drop the override)", () => {
    const errors = validateTenantRoleOverride([]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("empty"))).toBe(true);
  });

  it("accepts a valid array of catalog permissions", () => {
    const errors = validateTenantRoleOverride([
      PARTNERS.READ,
      PARTNERS.CREATE,
      OFFERS.SEND,
    ]);
    expect(errors).toEqual([]);
  });

  it("accepts the platform wildcard '*' (override grants all non-platform perms)", () => {
    const errors = validateTenantRoleOverride(["*"]);
    expect(errors).toEqual([]);
  });

  it("accepts a resource-level wildcard 'offers.*'", () => {
    const errors = validateTenantRoleOverride(["offers.*"]);
    expect(errors).toEqual([]);
  });

  it("REJECTS any platform.* permission (super_admin exclusive)", () => {
    const errors = validateTenantRoleOverride([
      PARTNERS.READ,
      PLATFORM.TENANTS_READ,
      PLATFORM.IMPERSONATE,
    ]);
    expect(errors.length).toBe(2);
    expect(errors.every((e) => e.includes("platform permission"))).toBe(true);
  });

  it("rejects a typo / unknown permission string", () => {
    const errors = validateTenantRoleOverride([
      PARTNERS.READ,
      "nonexistent.action",
      "offers.nonsense",
    ]);
    expect(errors.length).toBe(2);
    expect(errors.every((e) => e.includes("not in the catalog"))).toBe(true);
  });

  it("rejects a resource-level wildcard whose prefix has no matching catalog perms", () => {
    const errors = validateTenantRoleOverride(["nonsense.*"]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("no catalog permissions match");
  });

  it("rejects non-string entries", () => {
    const errors = validateTenantRoleOverride([
      PARTNERS.READ,
      42 as any,
      null as any,
      "" as any,
    ]);
    expect(errors.length).toBe(3);
    expect(errors.every((e) => e.includes("non-empty string"))).toBe(true);
  });
});

// ── tenant-roles: loadTenantRolePermissions (cache + null-fallback) ──────

describe("P1-1 / Feature 1 — loadTenantRolePermissions (DB cache + null fallback)", () => {
  beforeEach(() => {
    invalidateTenantRolePermissionsCache();
  });

  it("returns null for super_admin (bypass — override is irrelevant)", async () => {
    const result = await loadTenantRolePermissions("tenant-A", "super_admin");
    expect(result).toBeNull();
  });

  it("returns null when tenantId is missing", async () => {
    expect(await loadTenantRolePermissions(null, "user")).toBeNull();
    expect(await loadTenantRolePermissions("", "user")).toBeNull();
    expect(await loadTenantRolePermissions(undefined, "user")).toBeNull();
  });

  it("returns null when role is missing", async () => {
    expect(await loadTenantRolePermissions("tenant-A", null)).toBeNull();
    expect(await loadTenantRolePermissions("tenant-A", "")).toBeNull();
  });

  it("returns null in dev/test env (Supabase not configured)", async () => {
    // CI environment — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are unset.
    const result = await loadTenantRolePermissions("tenant-A", "manager");
    expect(result).toBeNull();
  });

  it("caches the null result for the TTL (no DB hammering on repeat calls)", async () => {
    // Even without Supabase configured, the cache stores null — repeat
    // calls do not re-evaluate the isSupabaseConfigured() check. (We
    // can't directly observe the cache; we assert the call returns
    // null consistently, which is the observable contract.)
    const r1 = await loadTenantRolePermissions("tenant-A", "manager");
    const r2 = await loadTenantRolePermissions("tenant-A", "manager");
    expect(r1).toBeNull();
    expect(r2).toBeNull();
  });

  it("invalidation drops the cache (next load re-evaluates)", async () => {
    await loadTenantRolePermissions("tenant-A", "manager");
    invalidateTenantRolePermissionsCache("tenant-A", "manager");
    // Cache key for tenant-A|manager is gone — next call re-evaluates
    // and (in this env) re-caches null.
    const r = await loadTenantRolePermissions("tenant-A", "manager");
    expect(r).toBeNull();
  });
});

// ── tenant-roles: catalog integration ──────────────────────────────────────

describe("P1-1 / Feature 1 — catalog exposes tenant-roles.* permissions", () => {
  it("TENANT_ROLES has read / update / delete constants", () => {
    expect(TENANT_ROLES.READ).toBe("tenant-roles.read");
    expect(TENANT_ROLES.UPDATE).toBe("tenant-roles.update");
    expect(TENANT_ROLES.DELETE).toBe("tenant-roles.delete");
  });

  it("ALL_PERMISSIONS includes the new tenant-roles.* perms", () => {
    const all = Array.from(ALL_PERMISSIONS as readonly string[]);
    expect(all).toContain(TENANT_ROLES.READ);
    expect(all).toContain(TENANT_ROLES.UPDATE);
    expect(all).toContain(TENANT_ROLES.DELETE);
  });

  it("tenant-roles.* are NOT platform perms (so a tenant admin CAN manage them)", () => {
    // Sanity: the new perms are tenant-scoped, not platform-scoped —
    // otherwise the can() platform-gate would deny tenant admins.
    const all = Array.from(ALL_PERMISSIONS as readonly string[]);
    const tenantRolePerms = all.filter((p) => p.startsWith("tenant-roles."));
    expect(tenantRolePerms.length).toBe(3);
    expect(tenantRolePerms.every((p) => !p.startsWith("platform."))).toBe(true);
  });
});

// ── SoD matrix: rule lookup helpers ─────────────────────────────────────────

describe("P1-1 / Feature 2 — SoD matrix rule lookup", () => {
  it("SOD_RULES covers offer / invoice / JE / commission-payout flows", () => {
    expect(SOD_RULES.length).toBe(4);

    const createPerms = SOD_RULES.map((r) => r.creator_permission);
    expect(createPerms).toContain("offers.create");
    expect(createPerms).toContain("invoices.create");
    expect(createPerms).toContain("erp.create");
    expect(createPerms).toContain("commissions.payout");

    const approvePerms = SOD_RULES.map((r) => r.approver_permission);
    expect(approvePerms).toContain("offers.send");
    expect(approvePerms).toContain("invoices.send");
    expect(approvePerms).toContain("erp.post");
    expect(approvePerms).toContain("commissions.update");
  });

  it("findSoDRuleByCreatePerm returns the matching rule", () => {
    const rule = findSoDRuleByCreatePerm("offers.create");
    expect(rule).not.toBeNull();
    expect(rule?.approver_permission).toBe("offers.send");
    expect(rule?.description).toBeTruthy();
  });

  it("findSoDRuleByApprovePerm returns the matching rule", () => {
    const rule = findSoDRuleByApprovePerm("erp.post");
    expect(rule).not.toBeNull();
    expect(rule?.creator_permission).toBe("erp.create");
  });

  it("lookup helpers return null for an unknown permission", () => {
    expect(findSoDRuleByCreatePerm("nonsense.create")).toBeNull();
    expect(findSoDRuleByApprovePerm("nonsense.approve")).toBeNull();
  });
});

// ── SoD matrix: checkSoD ────────────────────────────────────────────────────

describe("P1-1 / Feature 2 — checkSoD (separation-of-duties evaluator)", () => {
  const action = {
    create_perm: "offers.create",
    approve_perm: "offers.send",
  };

  it("super_admin is NEVER blocked — bypass via permissions includes '*'", () => {
    // Super-admin holds both perms + same id as creator → still no violation.
    const r = checkSoD(
      ["*", "offers.create", "offers.send"],
      "user-1",
      "user-1",
      action,
    );
    expect(r.violated).toBe(false);
  });

  it("super_admin is NEVER blocked — bypass via permissions includes 'super_admin'", () => {
    // The spec's "hint flag" bypass — `permissions.includes("super_admin")`.
    const r = checkSoD(
      ["super_admin", "offers.create", "offers.send"],
      "user-1",
      "user-1",
      action,
    );
    expect(r.violated).toBe(false);
  });

  it("different natural persons → no violation", () => {
    const r = checkSoD(
      ["offers.create", "offers.send"],
      "user-creator",
      "user-approver",
      action,
    );
    expect(r.violated).toBe(false);
  });

  it("same person + BOTH perms → VIOLATION", () => {
    const r = checkSoD(
      ["offers.create", "offers.send"],
      "user-1",
      "user-1",
      action,
    );
    expect(r.violated).toBe(true);
    expect(r.reason).toBeTruthy();
    expect(r.rule?.creator_permission).toBe("offers.create");
    expect(r.rule?.approver_permission).toBe("offers.send");
  });

  it("same person but only ONE perm (create OR approve, not both) → no violation", () => {
    // Has create but not approve — couldn't perform both actions anyway.
    expect(
      checkSoD(["offers.create"], "user-1", "user-1", action).violated,
    ).toBe(false);
    // Has approve but not create — same logic.
    expect(
      checkSoD(["offers.send"], "user-1", "user-1", action).violated,
    ).toBe(false);
  });

  it("missing creatorId → fail open (don't block legacy-row approvals)", () => {
    expect(
      checkSoD(["offers.create", "offers.send"], null, "user-1", action)
        .violated,
    ).toBe(false);
    expect(
      checkSoD(["offers.create", "offers.send"], undefined, "user-1", action)
        .violated,
    ).toBe(false);
    expect(
      checkSoD(["offers.create", "offers.send"], "", "user-1", action).violated,
    ).toBe(false);
  });

  it("missing approverId → fail open (defense — no approver to compare)", () => {
    expect(
      checkSoD(["offers.create", "offers.send"], "user-1", null, action)
        .violated,
    ).toBe(false);
    expect(
      checkSoD(["offers.create", "offers.send"], "user-1", undefined, action)
        .violated,
    ).toBe(false);
  });

  it("all 4 SOD_RULES trigger a violation when same-person + both-perms", () => {
    for (const rule of SOD_RULES) {
      const r = checkSoD(
        [rule.creator_permission, rule.approver_permission],
        "user-x",
        "user-x",
        { create_perm: rule.creator_permission, approve_perm: rule.approver_permission },
      );
      expect(r.violated, `rule ${rule.creator_permission}+${rule.approver_permission}`).toBe(true);
      expect(r.rule?.description).toBe(rule.description);
    }
  });

  it("the platform wildcard '*' in user perms triggers the bypass (not the violation)", () => {
    // Edge case: a non-super-admin user with "*" in their perms bypasses
    // (treated as platform-root grant). Same as super_admin.
    const r = checkSoD(
      ["*"],
      "user-1",
      "user-1",
      action,
    );
    expect(r.violated).toBe(false);
  });
});

// ── retention: DEFAULT_RETENTION_CONFIG + validation ─────────────────────

describe("P1-1 / Feature 3 — DEFAULT_RETENTION_CONFIG mirrors the original hardcoded policy", () => {
  it("has all 8 fields populated", () => {
    expect(DEFAULT_RETENTION_CONFIG.sessions_days).toBe(30);
    expect(DEFAULT_RETENTION_CONFIG.login_history_days).toBe(365);
    expect(DEFAULT_RETENTION_CONFIG.password_resets_hours).toBe(24);
    expect(DEFAULT_RETENTION_CONFIG.rate_limits_hours).toBe(24);
    expect(DEFAULT_RETENTION_CONFIG.mail_queue_days).toBe(90);
    expect(DEFAULT_RETENTION_CONFIG.notifications_days).toBe(90);
    expect(DEFAULT_RETENTION_CONFIG.audit_logs_years).toBe(7);
    expect(DEFAULT_RETENTION_CONFIG.kyc_submissions_years).toBe(5);
  });
});

describe("P1-1 / Feature 3 — validateRetentionConfig (bounds check)", () => {
  it("accepts a valid full config", () => {
    expect(validateRetentionConfig(DEFAULT_RETENTION_CONFIG)).toEqual([]);
  });

  it("accepts a partial config (only the supplied fields are checked)", () => {
    expect(validateRetentionConfig({ sessions_days: 60 })).toEqual([]);
    expect(validateRetentionConfig({ mail_queue_days: 120 })).toEqual([]);
  });

  it("rejects a non-number value", () => {
    const errors = validateRetentionConfig({ sessions_days: "thirty" as any });
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("sessions_days must be a number");
  });

  it("rejects NaN / Infinity", () => {
    expect(
      validateRetentionConfig({ sessions_days: NaN }).length,
    ).toBeGreaterThan(0);
    expect(
      validateRetentionConfig({ sessions_days: Infinity }).length,
    ).toBeGreaterThan(0);
  });

  it("rejects a sub-1 day window (would delete rows mid-insert)", () => {
    const errors = validateRetentionConfig({ sessions_days: 0 });
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("sessions_days must be >= 1");
  });

  it("rejects an absurdly-large window (typo guard)", () => {
    const errors = validateRetentionConfig({ sessions_days: 999999 });
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("sessions_days must be <= 3650");
  });

  it("REJECTS an audit_logs_years below the SOX 7-year regulatory minimum", () => {
    const errors = validateRetentionConfig({ audit_logs_years: 5 });
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("audit_logs_years must be >= 7");
    expect(errors[0]).toContain("regulatory minimum");
  });

  it("REJECTS a kyc_submissions_years below the 5AMLD 5-year regulatory minimum", () => {
    const errors = validateRetentionConfig({ kyc_submissions_years: 3 });
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("kyc_submissions_years must be >= 5");
    expect(errors[0]).toContain("regulatory minimum");
  });

  it("accepts the regulatory maxima (10 years)", () => {
    expect(validateRetentionConfig({
      audit_logs_years: 10,
      kyc_submissions_years: 10,
    })).toEqual([]);
  });

  it("rejects a value above the regulatory maxima (10 years)", () => {
    expect(
      validateRetentionConfig({ audit_logs_years: 11 }).length,
    ).toBeGreaterThan(0);
    expect(
      validateRetentionConfig({ kyc_submissions_years: 11 }).length,
    ).toBeGreaterThan(0);
  });
});

// ── retention: getEnforceableRetentionRules honours the config ─────────────

describe("P1-1 / Feature 3 — getEnforceableRetentionRules honours the config", () => {
  it("returns rules with the default days when the config matches defaults", () => {
    const rules = getEnforceableRetentionRules(DEFAULT_RETENTION_CONFIG);
    // 6 enforceable rules (sessions, login_history, password_resets,
    // rate_limits, mail_queue, notifications — audit_logs + kyc_submissions
    // are regulatory and excluded).
    expect(rules.length).toBe(6);

    const byTable = Object.fromEntries(rules.map((r) => [r.table, r]));
    expect(byTable.sessions.days).toBe(30);
    expect(byTable.login_history.days).toBe(365);
    expect(byTable.mail_queue.days).toBe(90);
    expect(byTable.notifications.days).toBe(90);
  });

  it("returns rules with overridden days when the config is customised", () => {
    const rules = getEnforceableRetentionRules({
      ...DEFAULT_RETENTION_CONFIG,
      sessions_days: 7,           // tighten from 30 → 7
      mail_queue_days: 30,        // tighten from 90 → 30
      notifications_days: 14,     // tighten from 90 → 14
    });
    const byTable = Object.fromEntries(rules.map((r) => [r.table, r]));
    expect(byTable.sessions.days).toBe(7);
    expect(byTable.mail_queue.days).toBe(30);
    expect(byTable.notifications.days).toBe(14);
    // Untouched fields keep their default-derived values.
    expect(byTable.login_history.days).toBe(365);
  });

  it("hours-based fields are converted to days (rounded UP)", () => {
    // password_resets_hours: 24 → 1 day (24/24 = 1)
    // rate_limits_hours: 36 → 2 days (36/24 = 1.5 → ceil → 2)
    const rules = getEnforceableRetentionRules({
      ...DEFAULT_RETENTION_CONFIG,
      password_resets_hours: 24,
      rate_limits_hours: 36,
    });
    const byTable = Object.fromEntries(rules.map((r) => [r.table, r]));
    expect(byTable.password_resets.days).toBe(1);
    expect(byTable.rate_limits.days).toBe(2);
  });

  it("hours-based fields floor at 1 day (a sub-24h config still deletes by ≥1 day)", () => {
    const rules = getEnforceableRetentionRules({
      ...DEFAULT_RETENTION_CONFIG,
      password_resets_hours: 1,  // 1 hour → ceil(1/24) = 1 day
    });
    const byTable = Object.fromEntries(rules.map((r) => [r.table, r]));
    expect(byTable.password_resets.days).toBe(1);
  });

  it("NEVER includes the regulatory-retained tables (audit_logs, kyc_submissions)", () => {
    const rules = getEnforceableRetentionRules(DEFAULT_RETENTION_CONFIG);
    const tables = rules.map((r) => r.table);
    expect(tables).not.toContain("audit_logs");
    expect(tables).not.toContain("kyc_submissions");
    // Sanity: those tables ARE in the source RETENTION_POLICY (regulatory
    // kind) — the filter excludes them.
  });

  it("preserves the status filter on mail_queue (delete_after_status)", () => {
    const rules = getEnforceableRetentionRules(DEFAULT_RETENTION_CONFIG);
    const mailQueue = rules.find((r) => r.table === "mail_queue");
    expect(mailQueue).toBeDefined();
    expect(mailQueue?.kind).toBe("delete_after_status");
    expect(mailQueue?.statusColumn).toBe("status");
    expect(mailQueue?.statusValue).toBe("sent");
  });

  it("preserves the column override on sessions (expires_at, not created_at)", () => {
    const rules = getEnforceableRetentionRules(DEFAULT_RETENTION_CONFIG);
    const sessions = rules.find((r) => r.table === "sessions");
    expect(sessions).toBeDefined();
    expect(sessions?.column).toBe("expires_at");
  });
});

// ── retention: cache invalidation ──────────────────────────────────────────

describe("P1-1 / Feature 3 — invalidateRetentionConfigCache (no-op when unset)", () => {
  it("does not throw when the cache is empty", () => {
    expect(() => invalidateRetentionConfigCache()).not.toThrow();
  });
});
