// src/lib/permissions/sod-matrix.ts
// ----------------------------------------------------------------------------
// Separation of Duties (SoD) matrix (P1-1 / Feature 2).
//
// Prevents the same user from both creating and approving the same
// action — a classic SOX / fraud-prevention control. Without it, a
// single user holding both `offers.create` + `offers.send` could
// manufacture AND commit a binding commercial commitment, with no
// second-person review.
//
// RULES (per entity) — these are the HARDCODED baseline that the
// platform enforces even when no DB-backed rules exist:
//   • Offer          — creator (`offers.create`) cannot send/approve
//                      (`offers.send`) their own offer.
//   • Invoice        — creator (`invoices.create`) cannot send/approve
//                      (`invoices.send`) their own invoice.
//   • Journal entry  — creator (`erp.create`) cannot post (`erp.post`)
//                      their own draft entry.
//   • Commission payout — creator (`commissions.payout`) cannot approve
//                      (`commissions.update`) their own payout.
//
// ── FIX-V1: super-admin-managed matrix (UI subsystem) ──────────────────────
// In addition to the hardcoded baseline, the super-admin Roles tab
// (`role-management.tsx`) writes rules to `settings.sod_matrix` (a JSON
// array blob). The UI format differs from the baseline:
//   • `permissions_a` / `permissions_b` — TWO permission sets; a user
//     holding ANY perm from A AND ANY perm from B is in violation.
//   • `severity: "block" | "warn"` — block returns 403; warn logs
//     and proceeds (for compliance review).
//   • `active: boolean` — toggles whether the rule is enforced.
//
// `assertNoSoDViolation` now CONSULTS the UI matrix (cached 5min) when
// deciding whether to block. The hardcoded `SOD_RULES` constant is the
// FALLBACK when the DB row is missing / Supabase is not configured /
// the row is empty — preserving existing behaviour on fresh deploys
// where the matrix has never been saved.
//
// SUPER-ADMIN RULE
// ----------------
// Super_admin bypasses ALL SoD rules. They can create AND approve the
// same action. This is the explicit contract: super_admin is the
// platform root and is trusted with the keys to the kingdom. The
// bypass fires when EITHER of these is true:
//   1. The user's permissions array includes `"*"` (the platform-root
//      wildcard — same convention `can()` uses).
//   2. The user's permissions array includes the literal string
//      `"super_admin"` (a hint flag — routes that know the user's role
//      is super_admin can pass it in the permissions list to force the
//      bypass even when the user's `*` grant was somehow stripped).
//
// Routes should ALSO short-circuit on `auth.isSuperAdmin` BEFORE
// calling `checkSoD` (defence-in-depth — see `assertNoSoDViolation`
// below which does this automatically).
//
// SEMANTICS
// ---------
// A violation requires BOTH of these conditions:
//   1. `creatorId === approverId` — the same natural person is doing
//      both the create and the approve (we compare user ids, NOT
//      usernames — usernames can be reused after a GDPR erase).
//   2. The user holds BOTH a permission from set A AND a permission
//      from set B for at least one active matrix rule (or, in the
//      legacy baseline path, both the create_perm + approve_perm
//      explicitly).
//
// WHAT THIS MODULE DOES NOT DO
// -----------------------------
//   • It does NOT enforce "the approver must be a different person
//     than the creator" unconditionally — a small tenant with one
//     admin legitimately has the same person doing both. We only
//     block when the user holds both permissions, which means the
//     tenant explicitly set up the role for two-person control.
//   • It does NOT retroactively check past actions — only the action
//     being performed right now.
// ----------------------------------------------------------------------------

import { NextResponse } from "next/server";
import type { AuthContext } from "@/lib/api/helpers";

/**
 * A single SoD rule. Maps a "creator" permission to the matching
 * "approver" permission that, if held by the same user who created
 * the entity, constitutes a violation.
 */
export interface SoDRule {
  /** The permission needed to CREATE the entity. */
  creator_permission: string;
  /** The permission needed to APPROVE / finalise the entity. */
  approver_permission: string;
  /** Human-readable explanation (used in the 403 body + audit log). */
  description: string;
}

/**
 * The baseline SoD rule set. The permission strings are taken from the
 * canonical catalog (`src/lib/permissions/catalog.ts`).
 *
 * Offer approval = `offers.send` (the act of sending an offer to the
 * customer is the binding approval — once sent, the offer is locked).
 *
 * Invoice approval = `invoices.send` (same logic — sending is the
 * external commitment that locks the invoice).
 *
 * Journal entry approval = `erp.post` (posting is the act of moving
 * a draft entry into the ledger — that's the approval step).
 *
 * Commission payout approval = `commissions.update` (transitioning a
 * payout from "pending" to "completed" is the approval step — see the
 * PUT /api/commission-payouts/[id] route).
 */
export const SOD_RULES: SoDRule[] = [
  {
    creator_permission: "offers.create",
    approver_permission: "offers.send",
    description: "Offer creator cannot send/approve their own offer (two-person control).",
  },
  {
    creator_permission: "invoices.create",
    approver_permission: "invoices.send",
    description: "Invoice creator cannot send/approve their own invoice (two-person control).",
  },
  {
    creator_permission: "erp.create",
    approver_permission: "erp.post",
    description: "Journal entry creator cannot post their own entry (two-person control).",
  },
  {
    creator_permission: "commissions.payout",
    approver_permission: "commissions.update",
    description: "Commission payout creator cannot approve their own payout (two-person control).",
  },
];

/**
 * Lookup the SoD rule that matches a given create_perm (or approve_perm).
 *
 * Returns the first matching rule, or `null` if no rule covers the
 * permission (i.e. the action is not subject to SoD). Used by routes
 * to find the rule that applies to the action they're about to take.
 */
export function findSoDRuleByCreatePerm(createPerm: string): SoDRule | null {
  return SOD_RULES.find((r) => r.creator_permission === createPerm) ?? null;
}

export function findSoDRuleByApprovePerm(approvePerm: string): SoDRule | null {
  return SOD_RULES.find((r) => r.approver_permission === approvePerm) ?? null;
}

export interface SoDResult {
  violated: boolean;
  reason?: string;
  /** The rule that was violated (for audit-log context). */
  rule?: SoDRule;
}

/**
 * Check whether the given approver is violating SoD by approving an
 * entity they themselves created.
 *
 * @param userPermissions  The approver's full effective permission list.
 *                         Must already include any per-tenant override
 *                         perms (the caller is responsible for merging).
 *                         Pass `"*"` or `"super_admin"` for super-admin
 *                         callers to bypass the check entirely.
 * @param creatorId        The id of the user who created the entity
 *                         (looked up from the entity's `created_by`
 *                         or `owner_id` column). NULL/undefined on
 *                         legacy rows → fail open (don't block).
 * @param approverId       The id of the user attempting to approve.
 * @param action           The SoD rule (or a { create_perm, approve_perm }
 *                         pair).
 *
 * Returns `{ violated: false }` when:
 *   • The approver is a super_admin (bypass — permissions array
 *     includes `"*"` OR `"super_admin"`).
 *   • The approver is NOT the creator (different natural persons).
 *   • The approver holds the create_perm but not the approve_perm,
 *     OR vice versa (one-sided — no SoD concern).
 *
 * Returns `{ violated: true, reason, rule }` when:
 *   • The approver is the same person as the creator (ids match) AND
 *     the approver holds BOTH the create_perm and the approve_perm.
 */
export function checkSoD(
  userPermissions: string[],
  creatorId: string | null | undefined,
  approverId: string | null | undefined,
  action: { create_perm: string; approve_perm: string },
): SoDResult {
  // ── 1) Super-admin bypass — NEVER blocked ──────────────────────────
  // The platform root is trusted to do both sides of any action.
  // We honour BOTH the "*" wildcard AND the "super_admin" hint flag
  // (routes that know the user's role is super_admin pass it in the
  // permissions array).
  if (userPermissions.includes("*") || userPermissions.includes("super_admin")) {
    return { violated: false };
  }

  // ── 2) Different natural person — no SoD concern ──────────────────
  // We compare user ids (not usernames). When the creator id is
  // missing (e.g. a legacy row, an API-key-created entity), we can't
  // confirm the same-person check — fail OPEN (don't block) rather
  // than fail closed (which would block every legacy-row approval).
  // The audit log entry below still records the attempt.
  if (!creatorId || !approverId || creatorId !== approverId) {
    return { violated: false };
  }

  // ── 3) Same person — check if they hold BOTH permissions ──────────
  // If they only have one side (create OR approve), no violation —
  // they couldn't perform both actions anyway. The "*" check above
  // already handled super-admin; this is for the case where a non-
  // super-admin somehow has both catalog perms explicitly granted.
  const hasCreate =
    userPermissions.includes(action.create_perm) ||
    userPermissions.includes("*");
  const hasApprove =
    userPermissions.includes(action.approve_perm) ||
    userPermissions.includes("*");

  if (hasCreate && hasApprove) {
    const rule = SOD_RULES.find(
      (r) =>
        r.creator_permission === action.create_perm &&
        r.approver_permission === action.approve_perm,
    );
    return {
      violated: true,
      reason:
        rule?.description ||
        "Separation of duties: creator cannot approve own action.",
      rule,
    };
  }

  return { violated: false };
}

// ───────────────────────────────────────────────────────────────────────────
// FIX-V1 — super-admin-managed SoD matrix (UI subsystem).
//
// The UI's rule format (SodMatrixRule below) differs from the legacy
// `SoDRule` baseline above: it has TWO permission sets (A + B), a
// severity (block/warn), and an active flag. assertNoSoDViolation
// now consults BOTH — every active matrix rule is evaluated, and the
// first matching BLOCK rule triggers a 403; WARN rules log + continue.
// ───────────────────────────────────────────────────────────────────────────

/**
 * A super-admin-managed SoD rule (UI format). Stored as a JSON blob in
 * `settings.sod_matrix` (tenant_id IS NULL — platform-wide control).
 *
 * A violation is triggered when the approver holds ANY permission from
 * `permissions_a` AND ANY permission from `permissions_b`.
 *
 * - severity="block" → assertNoSoDViolation returns 403.
 * - severity="warn" → assertNoSoDViolation logs + proceeds (compliance
 *   review surface; the action goes through).
 */
export interface SodMatrixRule {
  id: string;
  name: string;
  description: string | null;
  permissions_a: string[];
  permissions_b: string[];
  severity: "block" | "warn";
  active: boolean;
}

/**
 * The hardcoded baseline, converted to the UI's matrix format. Used as
 * the FALLBACK when `settings.sod_matrix` is missing or empty — so a
 * fresh deploy keeps the four baseline SoD rules even if the operator
 * has never opened the Roles tab.
 *
 * The baseline is always severity=block + active (preserving the
 * pre-FIX-V1 behaviour where the 4 approve routes unconditionally 403
 * on a same-person + both-perms condition).
 */
export const HARDCODED_SOD_AS_MATRIX: SodMatrixRule[] = SOD_RULES.map(
  (r, i) => ({
    id: `sod-hardcoded-${i}`,
    name: r.description.split(" (")[0] || `Baseline Rule ${i + 1}`,
    description: r.description,
    permissions_a: [r.creator_permission],
    permissions_b: [r.approver_permission],
    severity: "block" as const,
    active: true,
  }),
);

let cachedMatrixRules: SodMatrixRule[] | null = null;
let sodCacheExpiry = 0;
const SOD_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Drop the in-process SoD matrix cache. Called by the
 * /api/admin/sod-matrix PUT handler so the next `assertNoSoDViolation`
 * call picks up the new rules immediately (within milliseconds —
 * not up to the 5-min TTL).
 */
export function invalidateSodMatrixCache(): void {
  cachedMatrixRules = null;
  sodCacheExpiry = 0;
}

/**
 * Load the platform-wide SoD matrix from `settings.sod_matrix` (JSON
 * blob, tenant_id IS NULL). Caches for 5min. Falls back to the
 * HARDCODED_SOD_AS_MATRIX (the 4 baseline rules) when:
 *   • Supabase is not configured (dev/test env without env vars).
 *   • The settings row is missing.
 *   • The row's value is not a non-empty array.
 *
 * Rules with malformed fields are dropped (defense-in-depth — a bad
 * manual SQL edit can't break the SoD check entirely; the malformed
 * rule is just skipped).
 */
export async function loadPlatformSodRules(): Promise<SodMatrixRule[]> {
  if (cachedMatrixRules && Date.now() < sodCacheExpiry) {
    return cachedMatrixRules;
  }

  try {
    const { getSupabase, isSupabaseConfigured } = await import("@/lib/supabase/client");
    if (!isSupabaseConfigured()) {
      cachedMatrixRules = HARDCODED_SOD_AS_MATRIX;
      sodCacheExpiry = Date.now() + SOD_CACHE_TTL_MS;
      return cachedMatrixRules;
    }
    const sb = getSupabase();
    const { data } = await sb
      .from("settings")
      .select("value")
      .eq("key", "sod_matrix")
      .is("tenant_id", "null")
      .maybeSingle();

    const raw = Array.isArray(data?.value) ? (data.value as unknown[]) : null;
    if (!raw || raw.length === 0) {
      cachedMatrixRules = HARDCODED_SOD_AS_MATRIX;
      sodCacheExpiry = Date.now() + SOD_CACHE_TTL_MS;
      return cachedMatrixRules;
    }

    // Normalize — drop malformed rows; coerce field types.
    const rules: SodMatrixRule[] = [];
    for (const r of raw) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      const permsA = Array.isArray(o.permissions_a)
        ? (o.permissions_a as unknown[]).filter((p): p is string => typeof p === "string" && p.length > 0)
        : [];
      const permsB = Array.isArray(o.permissions_b)
        ? (o.permissions_b as unknown[]).filter((p): p is string => typeof p === "string" && p.length > 0)
        : [];
      // A rule with empty A or B can never trigger — skip it.
      if (permsA.length === 0 || permsB.length === 0) continue;
      rules.push({
        id: typeof o.id === "string" && o.id ? o.id : `sod-${rules.length + 1}`,
        name: typeof o.name === "string" ? o.name : `Rule ${rules.length + 1}`,
        description: typeof o.description === "string" ? o.description : null,
        permissions_a: permsA,
        permissions_b: permsB,
        severity: o.severity === "warn" ? "warn" : "block",
        active: o.active !== false,
      });
    }

    cachedMatrixRules = rules;
    sodCacheExpiry = Date.now() + SOD_CACHE_TTL_MS;
    return cachedMatrixRules;
  } catch (e) {
    // Don't crash the request — fall back to the hardcoded baseline
    // (which is what pre-FIX-V1 code always enforced).
    console.error("[sod-matrix] loadPlatformSodRules failed:", e);
    return HARDCODED_SOD_AS_MATRIX;
  }
}

/**
 * Does the user's permission set include ANY permission from `perms`?
 * Honors wildcards (`*` and `resource.*`) and the legacy colon format.
 */
function permListIntersectsAny(
  userPerms: string[],
  perms: string[],
): boolean {
  if (userPerms.includes("*")) return true;
  for (const p of perms) {
    if (userPerms.includes(p)) return true;
    const dotIdx = p.indexOf(".");
    if (dotIdx > 0 && userPerms.includes(`${p.slice(0, dotIdx)}.*`)) return true;
    // Back-compat colon format
    const legacy = p.replace(".", ":");
    if (userPerms.includes(legacy)) return true;
    const colonIdx = legacy.indexOf(":");
    if (colonIdx > 0 && userPerms.includes(`${legacy.slice(0, colonIdx)}:*`)) return true;
  }
  return false;
}

/**
 * Convenience helper for routes: takes a Next.js auth context (which
 * has both `isSuperAdmin` and the user object) and returns either
 * `null` (allow) or a 403 NextResponse (block).
 *
 * Super-admin rule: `auth.isSuperAdmin` short-circuits to allow BEFORE
 * any matrix consultation (defence-in-depth — even if the user's
 * permissions array somehow doesn't include `"*"`, the role check
 * fires the bypass).
 *
 * For non-super-admin callers, this helper:
 *   1. Builds the effective permission list (base perms + per-tenant
 *      override grants — both the legacy `tenant_role_overrides` table
 *      subsystem AND the new `settings.role_overrides` UI subsystem
 *      (FIX-V1) — both additive, never revoke).
 *   2. Short-circuits to null when the approver is NOT the same person
 *      as the creator (different natural persons — no SoD concern).
 *   3. Loads the platform SoD matrix (`settings.sod_matrix` JSON blob;
 *      falls back to the hardcoded baseline when the row is missing).
 *   4. Iterates the active rules. For each rule, checks if the
 *      approver's effective perms intersect BOTH `permissions_a` AND
 *      `permissions_b`. The first matching rule applies:
 *        • severity="block" → return 403 with the rule's context.
 *        • severity="warn"  → log + continue (action goes through;
 *          surfaces on the compliance/audit trail).
 *
 * Usage in a route:
 *   const sod = assertNoSoDViolation(auth, existing.created_by, {
 *     create_perm: "invoices.create",
 *     approve_perm: "invoices.send",
 *   });
 *   if (sod) return sod;
 *
 * The `action` parameter is preserved for back-compat (the legacy
 * 4-route callers pass an explicit pair). It's now informational — the
 * matrix is the source of truth. If the matrix is empty/missing, the
 * hardcoded baseline (which mirrors the historical pairs) is used.
 */
export async function assertNoSoDViolation(
  auth: AuthContext,
  creatorId: string | null | undefined,
  action: { create_perm: string; approve_perm: string },
): Promise<NextResponse | null> {
  // ── Super-admin bypass — NEVER blocked ─────────────────────────────
  // Two-layer check: isSuperAdmin (from auth context) OR role string
  // (defence-in-depth — the auth context's isSuperAdmin flag is set
  // by `requireAuth` from `effectiveUser.role === "super_admin"`,
  // which is the source of truth).
  if (auth.isSuperAdmin || auth.user.role === "super_admin") {
    return null;
  }

  // ── Different natural person — no SoD concern, short-circuit ──────
  // Same logic as checkSoD: compare user ids (not usernames). When the
  // creator id is missing (legacy row, API-key-created entity), we
  // can't confirm same-person — fail OPEN (don't block). The matrix
  // consultation below only runs when creatorId === auth.user.id.
  if (!creatorId || !auth.user.id || creatorId !== auth.user.id) {
    return null;
  }

  // ── Build the effective permission list ────────────────────────────
  // We consult BOTH override subsystems (both additive — neither can
  // revoke, so merging is safe):
  //   1. `tenant_role_overrides` table (legacy sub-system 2 — empty
  //      in practice because no UI writes to it, but kept for back-
  //      compat with the `/api/admin/tenant-roles` admin route).
  //   2. `settings.role_overrides` blob (UI sub-system 1, FIX-V1 —
  //      the source of truth for super-admin-managed role overrides).
  const basePerms = auth.user.permissions ?? [];
  const effectiveSet = new Set<string>(basePerms);

  // Sub-system 2 (legacy table).
  try {
    if (auth.tenantId && auth.user.role) {
      const { loadTenantRolePermissions } = await import("./tenant-roles");
      const tenantOverride = await loadTenantRolePermissions(auth.tenantId, auth.user.role);
      if (tenantOverride) {
        for (const p of tenantOverride) effectiveSet.add(p);
      }
    }
  } catch (e) {
    // DB hiccup — proceed without the override. The override is
    // additive so this can only make the check MORE permissive than
    // it should be, which is the safe failure mode for a check that
    // gates user actions (fail open, log).
    console.warn("[sod-matrix] loadTenantRolePermissions failed:", e);
  }

  // Sub-system 1 (UI-driven blob, FIX-V1). Grants only (deny semantics
  // don't apply to the SoD check — a deny can't cause a violation
  // because a violation requires the user to HOLD both perms).
  try {
    if (auth.tenantId && auth.user.role) {
      const { loadRoleOverrides } = await import("./tenant-roles");
      const override = await loadRoleOverrides(auth.user.role, auth.tenantId);
      if (override && override.grants.length > 0) {
        for (const p of override.grants) effectiveSet.add(p);
      }
    }
  } catch (e) {
    console.warn("[sod-matrix] loadRoleOverrides failed:", e);
  }

  const effectivePerms = Array.from(effectiveSet);

  // ── Super-admin hint flag bypass (defence-in-depth) ────────────────
  // If the effective set somehow includes "*" or "super_admin" (e.g.
  // via a wildcard override), treat as super-admin and bypass. Same
  // logic as the legacy checkSoD.
  if (effectivePerms.includes("*") || effectivePerms.includes("super_admin")) {
    return null;
  }

  // ── Load the matrix + iterate the active rules ──────────────────────
  const rules = await loadPlatformSodRules();
  for (const rule of rules) {
    if (!rule.active) continue;
    const hasA = permListIntersectsAny(effectivePerms, rule.permissions_a);
    const hasB = permListIntersectsAny(effectivePerms, rule.permissions_b);
    if (!hasA || !hasB) continue;

    // Violation matched. Apply severity.
    if (rule.severity === "warn") {
      // WARN — log + proceed (don't return 403). Surface on the
      // audit trail for compliance review.
      console.warn(
        `[sod-matrix] WARN rule "${rule.name}" (id=${rule.id}) ` +
        `violated by user ${auth.user.id} (tenant=${auth.tenantId ?? "null"}) ` +
        `on action {create: ${action.create_perm}, approve: ${action.approve_perm}}`,
      );
      continue;
    }

    // BLOCK — return 403.
    return NextResponse.json(
      {
        error: rule.description || rule.name || "Separation of duties violation.",
        sod_rule: {
          id: rule.id,
          name: rule.name,
          description: rule.description,
          permissions_a: rule.permissions_a,
          permissions_b: rule.permissions_b,
          severity: rule.severity,
        },
      },
      { status: 403 },
    );
  }

  // No active rule matched (or only WARN rules matched) → allow.
  return null;
}
