"use client";

import { create } from "zustand";
import React from "react";

export type ViewKey =
  // Core CRM
  | "dashboard"
  | "partners"
  | "partner-360"
  | "products"
  | "deals"
  | "commissions"
  | "offers"
  | "demands"
  | "documents"
  | "tasks"
  | "audit"
  // Trade
  | "product-catalog"
  | "supplier-offers"
  | "trade-calculator"
  // Finance
  | "invoices"
  | "proformas"
  | "document-register"
  // Inventory
  | "inventory"
  // Admin
  | "users"
  | "settings"
  | "security"
  | "vault"
  | "api-keys"
  | "webhooks"
  | "mail-queue"
  // Platform (super-admin only)
  | "tenants"
  | "platform-dashboard"
  | "platform-audit"
  | "platform-users"
  | "platform-health"
  | "super-admin-overview"
  | "super-admin-settings"
  | "feature-flags"
  | "document-templates"
  | "document-verification"
  | "kyc-review"
  | "portal-rfqs"
  // ERP / Accounting
  | "erp"
  // New features
  | "custom-dashboard"
  | "email-templates"
  | "api-integrations"
  | "calendar"
  | "quick-notes"
  | "workspace"
  | "plans"
  | "portal-uploads"
  | "logistics-requests"
  | "trade-globe"
  | "plan-upgrade-queue"
  | "portal-locations"
  // Verification logs (super-admin only — fraud prevention)
  | "verification-logs"
  // Performance dashboard (super-admin only — task D-8 APM)
  | "performance"
  // Portal (client-facing, separate mode)
  | "portal-dashboard"
  | "portal-offers"
  | "portal-invoices"
  | "portal-documents"
  | "portal-catalog"
  | "portal-profile"
  | "portal-kyc"
  | "portal-rfq"
  | "portal-messages"
  | "portal-proformas"
  | "portal-logistics"
  | "portal-notifications"
  // Marketplace (Phase 1 — Berza roba)
  | "portal-marketplace"
  // Marketplace (Phase 2 — negotiation rooms)
  | "portal-marketplace-post-detail"
  | "portal-marketplace-negotiations"
  | "portal-marketplace-negotiation-room";

export interface SafeUser {
  id: string;
  tenant_id: string | null;
  username: string;
  email: string;
  full_name: string | null;
  role: string;
  permissions: string[] | null;
  active: boolean;
}

interface AppState {
  user: SafeUser | null;
  setUser: (u: SafeUser | null) => void;

  // Portal mode — separate from CRM admin
  portalAccess: any | null;
  setPortalAccess: (a: any | null) => void;
  appMode: "crm" | "portal";
  setAppMode: (m: "crm" | "portal") => void;

  view: ViewKey;
  setView: (v: ViewKey) => void;

  selectedId: string | null;
  setSelectedId: (id: string | null) => void;

  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  loading: boolean;
  setLoading: (b: boolean) => void;

  // ── Tenant context switching (super-admin only) ──
  // When a super-admin selects a tenant, ALL data is scoped to that tenant.
  // Regular users are always locked to their own tenant_id (this field is ignored).
  activeTenantId: string | null;
  activeTenantName: string | null;
  setActiveTenant: (id: string | null, name: string | null) => void;

  // ── Trade calc → offer preview (cross-view handoff) ────────────────
  // When the user clicks "Create Offer from Calculation" in the Trade
  // Calculator view, we fetch a pre-filled offer payload from
  // /api/trade-calculator/[id]/offer-preview (no offer is created yet),
  // store it here, then switch the view to "offers" — the OffersView reads
  // this state on mount, opens the form dialog pre-filled, and paints the
  // `missingFields` inputs with an orange highlight so the user knows what
  // the trade calc couldn't auto-fill. Cleared immediately after the form
  // consumes it. Kept here (instead of URL params) so the offer payload
  // (line items, totals, metadata) doesn't bloat the URL.
  pendingOfferData: {
    offer: Record<string, any>;
    missingFields: string[];
    tradeCalcId: string;
  } | null;
  setPendingOfferData: (data: {
    offer: Record<string, any>;
    missingFields: string[];
    tradeCalcId: string;
  } | null) => void;
}

function loadActiveTenant(): { id: string | null; name: string | null } {
  if (typeof window === "undefined") return { id: null, name: null };
  try {
    const raw = localStorage.getItem("velos_active_tenant");
    if (!raw) return { id: null, name: null };
    const parsed = JSON.parse(raw);
    return { id: parsed.id || null, name: parsed.name || null };
  } catch {
    return { id: null, name: null };
  }
}

export const useAppStore = create<AppState>((set) => ({
  user: null,
  setUser: (u) => set({ user: u }),

  portalAccess: null,
  setPortalAccess: (a) => set({ portalAccess: a }),
  appMode: "crm",
  setAppMode: (m) => set({ appMode: m, view: m === "portal" ? "portal-dashboard" : "dashboard" }),

  view: "dashboard",
  // Note: do NOT wipe selectedId here. Drill-down flows like
  // Partners → Partner 360 do setSelectedId(id) then setView("partner-360"),
  // and clearing selectedId inside setView made the target view render empty
  // (Partner 360 falls back to "no selection" → user bounces to the list).
  // Views that need a clean state should reset selectedId themselves.
  setView: (v) => {
    set({ view: v });
    if (typeof window !== "undefined") {
      try { sessionStorage.setItem("velos_view", v); } catch { /* ignore */ }
    }
  },

  selectedId: null,
  setSelectedId: (id) => {
    set({ selectedId: id });
    if (typeof window !== "undefined") {
      try {
        if (id) sessionStorage.setItem("velos_selected_id", id);
        else sessionStorage.removeItem("velos_selected_id");
      } catch { /* ignore */ }
    }
  },

  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  loading: false,
  setLoading: (b) => set({ loading: b }),

  // Always initialize as null to avoid SSR hydration mismatch.
  // The TenantContextSwitcher loads from localStorage on mount.
  activeTenantId: null,
  activeTenantName: null,
  setActiveTenant: (id, name) => {
    set({ activeTenantId: id, activeTenantName: name });
    if (typeof window !== "undefined") {
      if (id) {
        localStorage.setItem("velos_active_tenant", JSON.stringify({ id, name }));
      } else {
        localStorage.removeItem("velos_active_tenant");
      }
    }
  },

  // Trade calc → offer preview handoff. Cleared by the OffersView once it
  // consumes the payload (so a refresh on the offers view doesn't re-open
  // a stale draft).
  pendingOfferData: null,
  setPendingOfferData: (data) => set({ pendingOfferData: data }),
}));

/**
 * Call this in a client component's useEffect to hydrate the active tenant
 * from localStorage after mount. This avoids SSR hydration mismatch.
 */
export function useHydrateActiveTenant() {
  const setActiveTenant = useAppStore((s) => s.setActiveTenant);
  React.useEffect(() => {
    const t = loadActiveTenant();
    if (t.id) {
      setActiveTenant(t.id, t.name);
    }
  }, [setActiveTenant]);
}

/**
 * Hydrate the current view + selected entity id from sessionStorage on mount.
 * Without this a page refresh drops the user back to the Dashboard and blanks
 * out any drill-down view (Partner 360, deal detail, etc.).
 */
export function useHydrateViewState() {
  const setView = useAppStore((s) => s.setView);
  const setSelectedId = useAppStore((s) => s.setSelectedId);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const v = sessionStorage.getItem("velos_view");
      const sid = sessionStorage.getItem("velos_selected_id");
      if (v) setView(v as ViewKey);
      if (sid) setSelectedId(sid);
    } catch { /* ignore */ }
  }, [setView, setSelectedId]);
}

/**
 * Returns the effective tenant ID for the current session.
 * - Super-admin: returns activeTenantId (manually selected) or user.tenant_id
 * - Regular user: returns user.tenant_id (always their own)
 */
export function useEffectiveTenantId(): string | null {
  const user = useAppStore((s) => s.user);
  const activeTenantId = useAppStore((s) => s.activeTenantId);
  if (isSuperAdmin(user)) {
    return activeTenantId || user?.tenant_id || null;
  }
  return user?.tenant_id || null;
}

/**
 * Returns a query string param for the active tenant, for use in API fetch calls.
 * e.g. "?tenant_id=xxx" or "" if no tenant context is needed.
 * Super-admins use this to scope data to the selected tenant.
 */
export function useTenantParam(): string {
  const tid = useEffectiveTenantId();
  const user = useAppStore((s) => s.user);
  if (!isSuperAdmin(user)) return "";
  if (!tid) return "";
  return `tenant_id=${encodeURIComponent(tid)}`;
}

/**
 * Client-side mirror of `src/lib/permissions/can.ts`. Kept here so client
 * components don't need to import the server-only permission module.
 *
 * Rules (must stay in sync with the server evaluator):
 *   1. super_admin (role === "super_admin")        -> allow
 *   1b. platform.* permission (non-super-admin)    -> DENY (even if user has "*" wildcard)
 *   2. perms includes "*" (non-super-admin)        -> allow (non-platform only — see 1b)
 *   3. role === "admin"                            -> allow any non-platform perm
 *   4. explicit grant / resource-wildcard match    -> allow
 *   5. otherwise                                   -> deny
 *
 * NOTE: The `platform.*` deny (1b) runs BEFORE the wildcard-"*" allow
 * so that a regular admin whose `permissions` array contains "*" cannot
 * see super-admin-only sidebar items (the "Platform" section) or call
 * super-admin endpoints. Only `role === "super_admin"` may pass
 * `platform.*` checks.
 */
export function canUser(u: SafeUser | null | undefined, key: string): boolean {
  if (!u) return false;
  if (u.role === "super_admin") return true;
  // Platform perms are SUPER-ADMIN ONLY. Must run before the wildcard
  // "*" bypass so tenant admins with permissions=["*"] still cannot
  // reach the Platform section or super-admin endpoints.
  if (key.startsWith("platform.")) return false;
  const perms = u.permissions || [];
  if (perms.includes("*")) return true;
  if (u.role === "admin") return true;
  if (perms.includes(key)) return true;
  const dotIdx = key.indexOf(".");
  if (dotIdx > 0 && perms.includes(`${key.slice(0, dotIdx)}.*`)) return true;
  // Back-compat with legacy colon form ("partners:read", "erp:*")
  const legacy = key.replace(".", ":");
  if (perms.includes(legacy)) return true;
  const colonIdx = legacy.indexOf(":");
  if (colonIdx > 0 && perms.includes(`${legacy.slice(0, colonIdx)}:*`)) return true;
  return false;
}

/**
 * Legacy signature preserved for existing call sites that pass a permissions
 * array directly. Accepts either dot- or colon-form keys.
 */
export function hasPermission(perms: string[] | null | undefined, key: string): boolean {
  if (!perms) return false;
  if (perms.includes("*")) return true;
  if (perms.includes(key)) return true;
  const dotIdx = key.indexOf(".");
  if (dotIdx > 0 && perms.includes(`${key.slice(0, dotIdx)}.*`)) return true;
  const colonIdx = key.indexOf(":");
  if (colonIdx > 0 && perms.includes(`${key.slice(0, colonIdx)}:*`)) return true;
  // Cross-form fallback
  const alt = key.includes(".") ? key.replace(".", ":") : key.replace(":", ".");
  if (perms.includes(alt)) return true;
  const altIdx = alt.search(/[.:]/);
  if (altIdx > 0 && perms.includes(`${alt.slice(0, altIdx)}${alt[altIdx]}*`)) return true;
  return false;
}

export function isAdmin(u: SafeUser | null): boolean {
  return u?.role === "admin" || u?.role === "super_admin" || (u?.permissions?.includes("*") ?? false);
}

export function isSuperAdmin(u: SafeUser | null): boolean {
  return u?.role === "super_admin";
}

export function isAccountant(u: SafeUser | null): boolean {
  if (!u) return false;
  if (isAdmin(u)) return true; // admins always have ERP access
  return canUser(u, "erp.read");
}

/**
 * React hook: does the current user hold `permission`?
 * Use it to hide/show UI. NEVER rely on this for authorization — the server
 * enforces via `requirePermission()`.
 */
export function useCan(permission: string): boolean {
  const user = useAppStore((s) => s.user);
  return canUser(user, permission);
}
