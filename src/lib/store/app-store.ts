"use client";

import { create } from "zustand";
import React from "react";

/**
 * Every SPA view key (admin CRM + portal), as a single const array so the
 * `ViewKey` type below and the runtime list can never drift apart — the
 * URL router (audit 4-d P1-1, `isViewKey` / `applyViewFromUrl`) validates
 * `/app/<view>` path segments against exactly this list.
 */
const VIEW_KEYS = [
  // Core CRM
  "dashboard",
  "partners",
  "partner-360",
  "products",
  "deals",
  "commissions",
  "offers",
  "demands",
  "documents",
  "tasks",
  "audit",
  "error-audit",
  // Trade
  "product-catalog",
  "supplier-offers",
  "trade-calculator",
  // Finance
  "invoices",
  "proformas",
  "lois",
  "document-register",
  // Inventory
  "inventory",
  // Admin
  "users",
  "settings",
  "security",
  "vault",
  "api-keys",
  "webhooks",
  "mail-queue",
  // Platform (super-admin only)
  "tenants",
  "platform-dashboard",
  "platform-audit",
  "platform-users",
  "platform-health",
  "super-admin-overview",
  "super-admin-settings",
  "feature-flags",
  "document-templates",
  "document-verification",
  "kyc-review",
  "portal-rfqs",
  // ERP / Accounting
  "erp",
  // New features
  "custom-dashboard",
  "email-templates",
  "api-integrations",
  "calendar",
  "quick-notes",
  "workspace",
  "plans",
  "portal-uploads",
  "logistics-requests",
  "trade-globe",
  "plan-upgrade-queue",
  "portal-locations",
  // Verification logs (super-admin only — fraud prevention)
  "verification-logs",
  // Performance dashboard (super-admin only — task D-8 APM)
  "performance",
  // Portal (client-facing, separate mode)
  "portal-dashboard",
  "portal-offers",
  "portal-invoices",
  "portal-documents",
  "portal-catalog",
  "portal-profile",
  "portal-kyc",
  "portal-rfq",
  "portal-messages",
  "portal-proformas",
  // BUILD-LOI-PORTAL — Letters of Intent addressed to this partner (the
  // partner is the SELLER / recipient; the tenant is the buyer).
  "portal-lois",
  "portal-logistics",
  "portal-notifications",
  // Marketplace (Phase 1 — Berza roba)
  "portal-marketplace",
  // Marketplace (Phase 2 — negotiation rooms)
  "portal-marketplace-post-detail",
  "portal-marketplace-negotiations",
  "portal-marketplace-negotiation-room",
  // Marketplace (Phase 3 — company profiles)
  "portal-marketplace-company",
  // Marketplace (Phase 9 — market intelligence dashboard)
  "portal-marketplace-intelligence",
  // Marketplace (Phase 10 — community: groups, Q&A, events, blog)
  "portal-marketplace-community",
  // Marketplace (UI-2 — super-admin cross-tenant management panel:
  //   posts, verification, reviews, categories, blacklist, stats)
  "marketplace-admin",
  // FEAT-1 (Trial approval) — super-admin queue of pending_approval
  // tenants awaiting review. Visible in the sidebar's "platform"
  // section (superAdminOnly: true). The view itself re-checks
  // isSuperAdmin before rendering.
  "signup-requests",
  // NOTIF-UX — full-page notifications surface (Administration section).
  // Linked from the sidebar ("Notifications" with a Bell icon) and from
  // the topbar bell's "View all notifications" footer. Paginated list of
  // all notifications with type filter, read/unread filter, search, and
  // per-item mark-read / delete actions. See src/components/views/notifications-view.tsx.
  "notifications",
] as const;

export type ViewKey = (typeof VIEW_KEYS)[number];

/**
 * Type guard over the ViewKey union. Used by the /app/<view> URL router
 * (`applyViewFromUrl`) to validate path segments before applying them to
 * the store — unknown keys fall back to "dashboard".
 */
export function isViewKey(v: string): v is ViewKey {
  return (VIEW_KEYS as readonly string[]).includes(v);
}

export interface SafeUser {
  id: string;
  tenant_id: string | null;
  /** Display name of the user's tenant (from /api/auth/me — audit26). */
  tenant_name?: string;
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

  /**
   * P1-1 (audit 4-d): read the view (+ drill-down `?id=`) from the current
   * `/app/<view>` URL into the store WITHOUT pushing a history entry.
   * Called on AppShell mount (initial boot / deep links) and on popstate
   * (back/forward), where the history entry already exists. Unknown view
   * keys fall back to "dashboard" and the URL is canonicalised with
   * `history.replaceState`.
   */
  applyViewFromUrl: () => void;

  selectedId: string | null;
  setSelectedId: (id: string | null) => void;

  // ── Marketplace negotiations (Phase 2) ──────────────────────────────
  // The marketplace's negotiation rooms view has its own drill-down id so
  // it doesn't collide with the post-detail's `selectedId`. Set by the
  // SPA-side NegotiationsBrowser when a card is clicked or by the
  // initialSelectedNegotiationId prop on PortalShell (deep-link case for
  // /portal/marketplace/negotiations/[id]).
  selectedNegotiationId: string | null;
  setSelectedNegotiationId: (id: string | null) => void;

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

export const useAppStore = create<AppState>((set, get) => ({
  user: null,
  setUser: (u) => set({ user: u }),

  portalAccess: null,
  setPortalAccess: (a) => set({ portalAccess: a }),
  appMode: "crm",
  // BUILD-LOI-PORTAL audit (deep-link bug): switching app-mode used to
  // UNCONDITIONALLY reset the view (portal → "portal-dashboard"). That
  // clobbered PortalShell's initialView on every fresh deep-link load:
  //   mount effect set view="portal-lois" (from /portal/lois page.tsx)
  //   → /api/portal/me hydration called setAppMode("portal")
  //   → view reset to "portal-dashboard" → user landed on the Dashboard.
  // This affected EVERY portal deep link (/portal/offers, /portal/proformas,
  // …). Now the reset only happens when the current view does NOT already
  // belong to the target mode:
  //   → portal: keep any "portal-*" view, otherwise land on portal-dashboard
  //   → crm:    keep any non-portal view, otherwise land on dashboard
  // All existing callers keep their behaviour: topbar "Open portal" /
  // global-search "open-portal" / post-login all arrive with a CRM view
  // (no "portal-" prefix) → still land on the portal dashboard.
  setAppMode: (m) =>
    set((s) => ({
      appMode: m,
      view:
        m === "portal"
          ? s.view.startsWith("portal-")
            ? s.view
            : "portal-dashboard"
          : s.view.startsWith("portal-")
            ? "dashboard"
            : s.view,
    })),

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
      // P1-1 (audit 4-d): make every admin view addressable. On top of the
      // sessionStorage fallback above, push a real history entry
      // (`/app/<view>`, `?id=` when a drill-down id is currently selected)
      // so browser back/forward and shared deep links work. Admin mode
      // only — the portal has its own real /portal/* routes and must not
      // grow /app URLs.
      if (get().appMode === "crm" && !v.startsWith("portal-")) {
        try {
          const id = get().selectedId;
          history.pushState(null, "", `/app/${v}${id ? `?id=${encodeURIComponent(id)}` : ""}`);
        } catch { /* ignore */ }
      }
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

  // P1-1 (audit 4-d): URL → store sync for the /app/* routes. Store-only
  // writes — no history push (the caller's history entry already exists).
  // See the doc comment on the interface for full semantics.
  applyViewFromUrl: () => {
    if (typeof window === "undefined") return;
    const { pathname, search } = window.location;
    if (!pathname.startsWith("/app/")) return;
    const raw = pathname.slice("/app/".length).split("/")[0];
    const key: ViewKey = isViewKey(raw) ? raw : "dashboard";
    const id = new URLSearchParams(search).get("id");
    // Guard redundant writes — popstate fires on every history traversal
    // and boot can race with the other hydration effects.
    if (get().view !== key || get().selectedId !== id) {
      set({ view: key, selectedId: id });
      // Keep the sessionStorage view fallback (bare-"/" boots) in sync.
      // NOTE: "velos_selected_id" is deliberately NOT touched here — the
      // URL ?id param is authoritative when present, and when absent the
      // useHydrateViewState fallback may still restore an id for views
      // reached without one (global-search jumps call setView BEFORE
      // setSelectedId, so their push carries no ?id yet).
      try { sessionStorage.setItem("velos_view", key); } catch { /* ignore */ }
    }
    // Canonicalise: unknown keys (or stray sub-segments) replaceState onto
    // the resolved view's canonical path so the address bar always shows
    // a shareable deep link. Query params are preserved as-is.
    if (pathname !== `/app/${key}`) {
      try { history.replaceState(null, "", `/app/${key}${search}`); } catch { /* ignore */ }
    }
  },

  // Marketplace negotiations drill-down (Phase 2). Same sessionStorage
  // pattern as `selectedId` so a refresh on /portal/marketplace/negotiations/[id]
  // lands back on the same room instead of bouncing to the list.
  selectedNegotiationId: null,
  setSelectedNegotiationId: (id) => {
    set({ selectedNegotiationId: id });
    if (typeof window !== "undefined") {
      try {
        if (id) sessionStorage.setItem("velos_selected_negotiation_id", id);
        else sessionStorage.removeItem("velos_selected_negotiation_id");
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
 * P1-1 (audit 4-d): on /app/* boots the URL wins — the view is NOT hydrated
 * from sessionStorage there (see the effect body for the id-semantics).
 */
export function useHydrateViewState() {
  const setView = useAppStore((s) => s.setView);
  const setSelectedId = useAppStore((s) => s.setSelectedId);
  const setSelectedNegotiationId = useAppStore((s) => s.setSelectedNegotiationId);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      // P1-1 (audit 4-d — URL routing): when the app booted from a real
      // /app/<view> URL, the URL is the source of truth — AppShell's
      // applyViewFromUrl() has already applied it, and re-hydrating the
      // sessionStorage view here would clobber a fresh deep link with a
      // stale tab-local view. The view fallback below therefore only runs
      // on a bare "/" boot. The selected id, however, still hydrates when
      // the URL carries no ?id — that keeps drill-downs reached without
      // an id in the URL (global-search jumps call setView BEFORE
      // setSelectedId) refresh-stable exactly as before.
      const onAppPath = window.location.pathname.startsWith("/app/");
      const urlHasId = new URLSearchParams(window.location.search).has("id");
      if (!onAppPath) {
        const v = sessionStorage.getItem("velos_view");
        if (v && isViewKey(v)) setView(v);
      }
      if (!urlHasId) {
        const sid = sessionStorage.getItem("velos_selected_id");
        if (sid) setSelectedId(sid);
      }
      // Negotiation-room ids are portal-only (no /app URL counterpart).
      const nid = sessionStorage.getItem("velos_selected_negotiation_id");
      if (nid) setSelectedNegotiationId(nid);
    } catch { /* ignore */ }
  }, [setView, setSelectedId, setSelectedNegotiationId]);
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
