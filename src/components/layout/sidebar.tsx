"use client";

import { useQuery } from "@tanstack/react-query";
import { useAppStore, ViewKey, isAdmin, isSuperAdmin, isAccountant, canUser, useEffectiveTenantId } from "@/lib/store/app-store";
import { useBadgeCounts } from "@/lib/hooks/use-badge-counts";
import { useI18nStore } from "@/lib/i18n/store";
import { t, NAV, SECTIONS as I18N_SECTIONS, type Locale } from "@/lib/i18n/dictionaries";
import { cn } from "@/lib/utils";
import { BrandLogo } from "@/components/common/brand-logo";
import {
  LayoutDashboard, Users, Package, Handshake, FileText, Inbox,
  FolderOpen, ListChecks, ScrollText, Settings, ShieldCheck, Key,
  Webhook, Lock, Mail, Receipt, FileSignature, Boxes,
  ChevronLeft, ChevronRight, Building2, Calculator,
  ToggleRight, LayoutGrid, Plug, DollarSign, BookMarked, Calendar,
  StickyNote, Briefcase, Settings2, TrendingUp, Truck, MapPin,
  Shield, Globe, Gauge, Store, UserPlus, Bell, Bug,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

/* ═══════════════════════════════════════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════════════════════════════════════ */

interface NavItem {
  key: ViewKey;
  i18nKey: string;
  i18nSection: string;
  icon: React.ComponentType<{ className?: string }>;
  /**
   * Required permission to see this nav item. If omitted, the item is
   * visible to any authenticated CRM user.
   * `platform.*` permissions are automatically super-admin-only per `canUser`.
   */
  permission?: string;
  /** Legacy — still respected but new items should use `permission`. */
  adminOnly?: boolean;
  superAdminOnly?: boolean;
  featureFlag?: string;
  /** Key into BadgeCounts (use-badge-counts.ts) — shows a small numeric pill when > 0. */
  badgeKey?: keyof import("@/lib/hooks/use-badge-counts").BadgeCounts;
}

interface NavSection {
  i18nKey: string;
  items: NavItem[];
  /**
   * When true, the entire section (and all its items) is hidden from any
   * user who is not a super_admin. This is a defense-in-depth check on top
   * of the per-item `permission: "platform.*"` gate (which `canUser()`
   * already denies to non-super-admins, including those who hold the
   * `"*"` wildcard permission).
   *
   * Currently set on the "platform" section so regular tenant admins can
   * never see Platform nav items, even if their role somehow grants
   * `platform.*` perms.
   */
  superAdminOnly?: boolean;
}

/* ═══════════════════════════════════════════════════════════════════════════
   NAVIGATION DATA
   ═══════════════════════════════════════════════════════════════════════════ */

const SECTIONS: NavSection[] = [
  {
    i18nKey: "overview",
    items: [
      { key: "dashboard", i18nKey: "dashboard", i18nSection: "overview", icon: LayoutDashboard, permission: "dashboard.read" },
      { key: "custom-dashboard", i18nKey: "custom-dashboard", i18nSection: "overview", icon: LayoutGrid, permission: "dashboard.read" },
      { key: "calendar", i18nKey: "calendar", i18nSection: "overview", icon: Calendar, permission: "calendar.read" },
      { key: "tasks", i18nKey: "tasks", i18nSection: "overview", icon: ListChecks, permission: "tasks.read", badgeKey: "tasks" },
      { key: "quick-notes", i18nKey: "quick-notes", i18nSection: "overview", icon: StickyNote, permission: "notes.read" },
      // Workspace is a "coming soon" placeholder — hide from sidebar until
      // at least one module (Reminders, Time Tracker, Expenses, etc.) ships.
      // { key: "workspace", i18nKey: "workspace", i18nSection: "overview", icon: Briefcase },
    ],
  },
  {
    i18nKey: "trade",
    items: [
      // Product Catalog has been merged into Products — the legacy
      // "product-catalog" view (product-catalog-view.tsx) still exists for
      // old bookmarks but is no longer surfaced in the sidebar.
      { key: "supplier-offers", i18nKey: "supplier-offers", i18nSection: "trade", icon: Inbox, permission: "supplier-offers.read", featureFlag: "module_trade" },
      { key: "trade-calculator", i18nKey: "trade-calculator", i18nSection: "trade", icon: Calculator, permission: "trade-calculator.read", featureFlag: "module_trade" },
    ],
  },
  {
    i18nKey: "crm",
    items: [
      { key: "partners", i18nKey: "partners", i18nSection: "crm", icon: Users, permission: "partners.read" },
      { key: "products", i18nKey: "products", i18nSection: "crm", icon: Package, permission: "products.read" },
      { key: "deals", i18nKey: "deals", i18nSection: "crm", icon: Handshake, permission: "deals.read" },
      { key: "commissions", i18nKey: "commissions", i18nSection: "crm", icon: DollarSign, permission: "commissions.read", featureFlag: "module_finance" },
      { key: "offers", i18nKey: "offers", i18nSection: "crm", icon: FileText, permission: "offers.read" },
      { key: "demands", i18nKey: "demands", i18nSection: "crm", icon: Inbox, permission: "demands.read" },
      { key: "inventory", i18nKey: "inventory", i18nSection: "crm", icon: Boxes, permission: "inventory.read", featureFlag: "module_inventory" },
    ],
  },
  {
    i18nKey: "finance",
    items: [
      { key: "invoices", i18nKey: "invoices", i18nSection: "finance", icon: Receipt, permission: "invoices.read", featureFlag: "module_finance" },
      { key: "proformas", i18nKey: "proformas", i18nSection: "finance", icon: FileSignature, permission: "proformas.read", featureFlag: "module_finance" },
      // BUILD-LOI — admin Letters of Intent surface. Lives in the Finance
      // section alongside Invoices/Proformas/Document Register because LOIs
      // are pre-contract financial documents (a buyer's formal intent to
      // purchase). Uses the ScrollText icon (already imported above) to
      // distinguish it visually from offers (FileText). Permission gate is
      // lois.read — granted implicitly to tenant admins, surfaced explicitly
      // in the permission catalog (LOIS.READ).
      { key: "lois", i18nKey: "lois", i18nSection: "finance", icon: ScrollText, permission: "lois.read", featureFlag: "module_finance" },
      { key: "document-register", i18nKey: "document-register", i18nSection: "finance", icon: FolderOpen, permission: "document-register.read", featureFlag: "module_finance" },
      { key: "erp", i18nKey: "erp", i18nSection: "finance", icon: BookMarked, permission: "erp.read", featureFlag: "module_finance" },
    ],
  },
  {
    i18nKey: "logistics",
    items: [
      { key: "logistics-requests", i18nKey: "logistics-requests", i18nSection: "logistics", icon: Truck, permission: "logistics.read", featureFlag: "module_logistics", badgeKey: "logistics_requests" },
      { key: "trade-globe", i18nKey: "trade-globe", i18nSection: "logistics", icon: Globe, permission: "logistics.read", featureFlag: "module_logistics" },
    ],
  },
  {
    i18nKey: "portal-mgmt",
    items: [
      { key: "kyc-review", i18nKey: "kyc-review", i18nSection: "portal-mgmt", icon: ShieldCheck, permission: "kyc.read", featureFlag: "module_kyc", badgeKey: "kyc_review" },
      { key: "portal-rfqs", i18nKey: "portal-rfqs", i18nSection: "portal-mgmt", icon: Inbox, permission: "portal.rfq_read", featureFlag: "module_portal", badgeKey: "portal_rfqs" },
      { key: "portal-uploads", i18nKey: "portal-uploads", i18nSection: "portal-mgmt", icon: FolderOpen, permission: "portal-uploads.read", featureFlag: "module_portal" },
    ],
  },
  {
    i18nKey: "documents-section",
    items: [
      { key: "documents", i18nKey: "documents", i18nSection: "documents-section", icon: FolderOpen, permission: "documents.read" },
      { key: "document-verification", i18nKey: "document-verification", i18nSection: "documents-section", icon: ShieldCheck, permission: "document-verify.read", featureFlag: "module_document_verification" },
      { key: "document-templates", i18nKey: "document-templates", i18nSection: "documents-section", icon: FileText, permission: "document-templates.read", featureFlag: "module_document_templates" },
    ],
  },
  {
    i18nKey: "communication",
    items: [
      { key: "mail-queue", i18nKey: "mail-queue", i18nSection: "communication", icon: Mail, permission: "mail-queue.read", featureFlag: "module_mail_queue" },
      { key: "email-templates", i18nKey: "email-templates", i18nSection: "communication", icon: Mail, permission: "email-templates.read", featureFlag: "module_mail_queue" },
      { key: "webhooks", i18nKey: "webhooks", i18nSection: "communication", icon: Webhook, permission: "webhooks.read", featureFlag: "module_webhooks" },
      { key: "api-integrations", i18nKey: "api-integrations", i18nSection: "communication", icon: Plug, permission: "integrations.read" },
    ],
  },
  {
    i18nKey: "administration",
    items: [
      { key: "users", i18nKey: "users", i18nSection: "administration", icon: Users, permission: "users.read" },
      { key: "settings", i18nKey: "settings", i18nSection: "administration", icon: Settings, permission: "settings.read" },
      { key: "security", i18nKey: "security", i18nSection: "administration", icon: ShieldCheck, permission: "security.read", featureFlag: "module_security" },
      { key: "vault", i18nKey: "vault", i18nSection: "administration", icon: Lock, permission: "vault.read", featureFlag: "module_vault" },
      { key: "api-keys", i18nKey: "api-keys", i18nSection: "administration", icon: Key, permission: "api-keys.read", featureFlag: "module_api_keys" },
      { key: "audit", i18nKey: "audit", i18nSection: "administration", icon: ScrollText, permission: "audit.read" },
      // AUDIT28 — in-house error audit: client JS errors, unhandled
      // rejections and server 500s land in error_logs and are triaged here.
      { key: "error-audit", i18nKey: "error-audit", i18nSection: "administration", icon: Bug, permission: "audit.read" },
      { key: "portal-locations", i18nKey: "portal-locations", i18nSection: "administration", icon: MapPin, permission: "portal.read", featureFlag: "module_portal" },
      { key: "plans", i18nKey: "plans", i18nSection: "administration", icon: TrendingUp, permission: "platform.plans.read" },
      // NOTIF-UX — full-page notifications surface. Sits at the bottom of
      // the Administration section. `notifications.read` is in the default
      // permission set (PERMISSION_CATALOG.READ.notifications.read) so every
      // admin sees this entry; super_admin bypasses the gate anyway. The
      // Bell icon mirrors the topbar dropdown so the two surfaces read as
      // the same feature at different granularities (quick glance vs. full
      // history).
      { key: "notifications", i18nKey: "notifications", i18nSection: "administration", icon: Bell, permission: "notifications.read" },
    ],
  },
  {
    i18nKey: "platform",
    // SUPER-ADMIN ONLY — defense-in-depth. The per-item permissions
    // (`platform.*`) are already denied to non-super-admins by
    // `canUser()` (including tenant admins who hold the `"*"` wildcard),
    // but marking the entire section here makes the intent explicit and
    // guarantees the section vanishes for any non-super-admin even if a
    // future refactor accidentally relaxes `canUser()`.
    superAdminOnly: true,
    items: [
      { key: "platform-dashboard", i18nKey: "platform-dashboard", i18nSection: "platform", icon: LayoutDashboard, permission: "platform.overview" },
      { key: "tenants", i18nKey: "tenants", i18nSection: "platform", icon: Building2, permission: "platform.tenants.read" },
      { key: "platform-users", i18nKey: "platform-users", i18nSection: "platform", icon: Users, permission: "platform.users.read" },
      { key: "platform-audit", i18nKey: "platform-audit", i18nSection: "platform", icon: ScrollText, permission: "platform.audit.read" },
      { key: "platform-health", i18nKey: "platform-health", i18nSection: "platform", icon: ShieldCheck, permission: "platform.health.read" },
      { key: "performance", i18nKey: "performance", i18nSection: "platform", icon: Gauge, permission: "platform.health.read" },
      { key: "feature-flags", i18nKey: "feature-flags", i18nSection: "platform", icon: ToggleRight, permission: "platform.feature_flags.read" },
      { key: "plan-upgrade-queue", i18nKey: "plan-upgrade-queue", i18nSection: "platform", icon: TrendingUp, permission: "platform.plans.write" },
      { key: "verification-logs", i18nKey: "verification-logs", i18nSection: "platform", icon: Shield, superAdminOnly: true },
      // UI-2 — super-admin marketplace management panel (cross-tenant:
      // posts, verification, reviews, categories, blacklist, stats).
      // Visible to super-admins only; the view itself also re-checks
      // isSuperAdmin before rendering.
      { key: "marketplace-admin", i18nKey: "marketplace-admin", i18nSection: "platform", icon: Store, superAdminOnly: true },
      // P0-4 — unified super-admin settings interface (security, roles,
      // data protection, monitoring, incidents, platform config,
      // system health). Visible to super-admins only; the view itself
      // also re-checks isSuperAdmin before rendering.
      { key: "super-admin-settings", i18nKey: "super-admin-settings", i18nSection: "platform", icon: Settings2, superAdminOnly: true },
      // FEAT-1 (Trial approval) — queue of pending_approval tenants
      // awaiting super-admin review. Mirrors the plan-upgrade-queue
      // pattern: superAdminOnly + the view itself re-checks
      // isSuperAdmin before firing fetches. The icon (UserPlus) and
      // the "platform.users.read" permission keep it grouped with the
      // other platform-level user-management surfaces
      // (platform-users, super-admin-settings).
      { key: "signup-requests", i18nKey: "signup-requests", i18nSection: "platform", icon: UserPlus, superAdminOnly: true, badgeKey: "signup_requests" },
    ],
  },
];

/* ═══════════════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

function getInitials(name: string | null): string {
  if (!name) return "U";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return parts[0][0].toUpperCase();
}

function formatRole(role: string): string {
  if (role === "super_admin") return "Super Admin";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/* ═══════════════════════════════════════════════════════════════════════════
   SIDEBAR COMPONENT
   ═══════════════════════════════════════════════════════════════════════════ */

export function Sidebar({ hideCollapseToggle = false, forceExpanded = false }: { hideCollapseToggle?: boolean; forceExpanded?: boolean } = {}) {
  const { view, setView, sidebarCollapsed: storeSidebarCollapsed, toggleSidebar, user } = useAppStore();
  // The mobile Sheet always renders full-width with labels — the icon-only
  // "collapsed" rail is a desktop concept and would just waste half the
  // Sheet's width if the user had left the desktop sidebar collapsed.
  const sidebarCollapsed = forceExpanded ? false : storeSidebarCollapsed;
  const activeTenantId = useAppStore((s) => s.activeTenantId);
  const locale = useI18nStore((s) => s.locale);
  const admin = isAdmin(user);
  const superAdmin = isSuperAdmin(user);
  const accountant = isAccountant(user);

  // Fetch feature flags for the current tenant to gate sidebar items
  const { data: flagsData } = useQuery({
    queryKey: ["feature-flags-sidebar"],
    queryFn: async () => {
      const r = await fetch("/api/feature-flags");
      if (!r.ok) return null;
      return r.json();
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const flags: Record<string, boolean> | null = flagsData?.flags || null;
  const effectiveTenantId = useEffectiveTenantId();
  const badges = useBadgeCounts(!!user && !!effectiveTenantId);

  return (
    <aside
      className={cn(
        "h-screen sticky top-0 shrink-0 flex flex-col",
        "glass-sidebar border-r border-sidebar-border",
        "transition-[width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]",
        sidebarCollapsed ? "w-[72px]" : "w-[260px]"
      )}
    >
      {/* ─── Brand Section ──────────────────────────────────────────────── */}
      <div className={cn(
        "h-[68px] flex items-center gap-3 px-4 border-b border-sidebar-border shrink-0",
        !sidebarCollapsed && "px-5"
      )}>
        {/* Logo — VELOS Veles symbol */}
        <div className={cn(
          "size-9 rounded-lg flex items-center justify-center shrink-0",
          "shadow-soft overflow-hidden"
        )}>
          <BrandLogo />
        </div>

        {/* Brand Text — animated fade */}
        <div className={cn(
          "min-w-0 overflow-hidden transition-all duration-300",
          sidebarCollapsed
            ? "opacity-0 w-0"
            : "opacity-100 w-auto"
        )}>
          <p className="font-display font-medium text-[15px] tracking-tight text-sidebar-foreground truncate leading-tight">
            VELOS
          </p>
          <p className="text-xs text-sidebar-foreground/55 truncate leading-tight mt-0.5">
            {t(locale, "trade-platform")}
          </p>
        </div>
      </div>

      {/* ─── Navigation ─────────────────────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto custom-scroll px-3 py-4 space-y-1">
        {SECTIONS.map((section) => {
          // Section-level super-admin gate (defense-in-depth). The
          // "platform" section carries `superAdminOnly: true` so the
          // whole section vanishes for non-super-admins regardless of
          // any per-item permission logic. This runs BEFORE per-item
          // filtering so we short-circuit the section entirely.
          if (section.superAdminOnly && !superAdmin) return null;

          const visibleItems = section.items.filter((n) => {
            // ── Super-admin scoping ───────────────────────────────────────
            // A super_admin without an active tenant context does NOT
            // belong to any tenant, so tenant-scoped modules are hidden.
            // The only sections they see by default are Platform items.
            // Selecting a tenant in the topbar switcher (impersonation)
            // re-enables the tenant-scoped items.
            if (superAdmin && !activeTenantId) {
              const isPlatformItem = section.i18nKey === "platform" || (n.permission?.startsWith("platform.") ?? false);
              if (!isPlatformItem) return false;
            }

            // Legacy: superAdminOnly / adminOnly still respected for any item
            // that hasn't been migrated to `permission`.
            if (n.superAdminOnly && !superAdmin) return false;
            if (n.adminOnly && !(admin || accountant)) return false;

            // New model: hide the item unless the user holds the permission.
            // super_admin passes canUser for any key; admin passes for any
            // non-platform key; regular users pass only when explicitly granted.
            // (Note: canUser denies `platform.*` for non-super-admins even
            // if they hold the `"*"` wildcard permission, so platform items
            // are effectively super-admin-only via this check too.)
            if (n.permission && !canUser(user, n.permission)) return false;

            // Feature-flag gating (super-admin bypasses).
            if (n.featureFlag && flags && !superAdmin) {
              return flags[n.featureFlag] === true;
            }
            return true;
          });
          if (visibleItems.length === 0) return null;

          const sectionLabel = I18N_SECTIONS[locale]?.[section.i18nKey] || section.i18nKey;

          return (
            <div key={section.i18nKey} className="mb-4 last:mb-0">
              {/* Section Header */}
              <div className={cn(
                "overflow-hidden transition-all duration-300",
                sidebarCollapsed ? "h-0 opacity-0 mb-0" : "h-auto opacity-100 mb-2"
              )}>
                <p className="px-3 text-xs font-semibold uppercase tracking-[0.12em] text-sidebar-foreground/45 select-none">
                  {sectionLabel}
                </p>
              </div>

              {/* Section Items */}
              <div className="space-y-0.5">
                {visibleItems.map((item) => {
                  const Icon = item.icon;
                  const active = view === item.key;
                  const label = NAV[locale]?.[item.i18nKey] || item.i18nKey;
                  const badgeCount = item.badgeKey ? badges[item.badgeKey] : undefined;

                  return (
                    <NavItemButton
                      key={item.key}
                      icon={Icon}
                      label={label}
                      active={active}
                      collapsed={sidebarCollapsed}
                      onClick={() => setView(item.key)}
                      badgeCount={badgeCount}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      {/* ─── Bottom Section ─────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-sidebar-border">
        {/* User Info */}
        {user && (
          <div className={cn(
            "flex items-center gap-3 px-4 py-3",
            !sidebarCollapsed && "px-5"
          )}>
            <Avatar className="size-8 ring-2 ring-sidebar-border shrink-0">
              <AvatarFallback className={cn(
                "bg-gradient-emerald text-white text-xs font-semibold",
                "transition-transform duration-200 hover:scale-105"
              )}>
                {getInitials(user.full_name)}
              </AvatarFallback>
            </Avatar>
            <div className={cn(
              "min-w-0 overflow-hidden transition-all duration-300",
              sidebarCollapsed ? "opacity-0 w-0" : "opacity-100 w-auto"
            )}>
              <p className="text-[13px] font-medium text-sidebar-foreground truncate leading-tight">
                {user.full_name || user.username}
              </p>
              <p className="text-xs text-sidebar-foreground/55 truncate leading-tight mt-0.5">
                {formatRole(user.role)}
              </p>
            </div>
          </div>
        )}

        {/* Collapse Toggle — desktop only; the mobile Sheet has no
            collapsed-icon-rail mode, so the toggle would do nothing visible
            there while still mutating the shared desktop layout state. */}
        {!hideCollapseToggle && (
        <div className="px-3 pb-3 pt-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={toggleSidebar}
                className={cn(
                  "w-full flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium",
                  "text-sidebar-foreground/55 hover:text-sidebar-foreground hover:bg-sidebar-accent",
                  "transition-all duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
                  sidebarCollapsed ? "justify-center px-0" : ""
                )}
                aria-label={sidebarCollapsed ? t(locale, "expand-sidebar") : t(locale, "collapse-sidebar")}
              >
                <div className={cn(
                  "size-5 flex items-center justify-center shrink-0",
                  "rounded-md transition-colors duration-200",
                  "bg-sidebar-accent group-hover:bg-sidebar-accent"
                )}>
                  {sidebarCollapsed ? (
                    <ChevronRight className="size-3.5" />
                  ) : (
                    <ChevronLeft className="size-3.5" />
                  )}
                </div>
                <span className={cn(
                  "overflow-hidden transition-all duration-300",
                  sidebarCollapsed ? "opacity-0 w-0" : "opacity-100 w-auto"
                )}>
                  {t(locale, "collapse")}
                </span>
              </button>
            </TooltipTrigger>
            {sidebarCollapsed && (
              <TooltipContent side="right" sideOffset={12} className="bg-sidebar-accent text-sidebar-accent-foreground border-sidebar-border">
                {t(locale, "expand-sidebar")}
              </TooltipContent>
            )}
          </Tooltip>
        </div>
        )}
      </div>
    </aside>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   NAV ITEM BUTTON — extracted for clean Tooltip handling
   ═══════════════════════════════════════════════════════════════════════════ */

interface NavItemButtonProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
  badgeCount?: number;
}

function NavItemButton({ icon: Icon, label, active, collapsed, onClick, badgeCount }: NavItemButtonProps) {
  const button = (
    <button
      onClick={onClick}
      // FIX-NOTIF-A11Y: when collapsed, the visible label is hidden
      // (opacity-0 w-0) so screen readers have no text to announce.
      // Pass the label through `aria-label` in that case so the nav
      // item remains accessible. In expanded mode the label is
      // visible text and `aria-label` would override it — so we only
      // set the attribute when collapsed.
      aria-label={collapsed ? label : undefined}
      className={cn(
        "group relative w-full flex items-center gap-3 rounded-lg",
        "text-[13px] font-medium",
        "transition-all duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
        collapsed ? "justify-center px-0 py-2.5" : "px-3 py-2",
        active
          ? // AUDIT28-DESIGN — solid visible active state: the old 8% primary
            // tint was nearly invisible on the off-white sidebar ("washed out"
            // in review). sidebar-accent is a clearly readable beige band +
            // dark copper text, and the label gains semibold weight.
            "bg-sidebar-accent text-sidebar-accent-foreground font-semibold shadow-xs"
          : "text-sidebar-foreground/65 hover:text-sidebar-foreground hover:bg-sidebar-accent/60"
      )}
    >
      {/* Active left indicator */}
      <div className={cn(
        "absolute left-0 top-1/2 -translate-y-1/2 rounded-r-full",
        "bg-gradient-emerald transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]",
        active && !collapsed
          ? "w-[3px] h-5 opacity-100"
          : "w-0 h-5 opacity-0"
      )} />

      {/* Active background tint */}
      {active && (
        <div className={cn(
          "absolute inset-0 rounded-lg -z-10",
          "bg-gradient-to-r from-sidebar-primary/[0.10] to-transparent",
          collapsed && "bg-sidebar-primary/[0.14]"
        )} />
      )}

      {/* Icon */}
      <div className="relative shrink-0">
        <Icon
          className={cn(
            "size-[18px] transition-colors duration-200",
            active
              ? "text-sidebar-primary"
              : "text-sidebar-foreground/50 group-hover:text-sidebar-foreground/85"
          )}
        />
        {/* Collapsed-mode badge dot with count */}
        {collapsed && !!badgeCount && badgeCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[15px] h-[15px] px-[3px] rounded-full bg-primary text-[9px] font-semibold text-primary-foreground flex items-center justify-center leading-none tabular-nums">
            {badgeCount > 99 ? "99+" : badgeCount}
          </span>
        )}
      </div>

      {/* Label */}
      <span className={cn(
        "truncate transition-all duration-300 flex-1 text-left",
        collapsed ? "opacity-0 w-0 overflow-hidden" : "opacity-100 w-auto"
      )}>
        {label}
      </span>

      {/* Expanded-mode badge pill */}
      {!collapsed && !!badgeCount && badgeCount > 0 && (
        <span className="shrink-0 min-w-[18px] h-[18px] px-1.5 rounded-full bg-primary text-xs font-semibold text-primary-foreground flex items-center justify-center leading-none tabular-nums">
          {badgeCount > 99 ? "99+" : badgeCount}
        </span>
      )}

      {/* Active dot indicator for collapsed mode */}
      {active && collapsed && (
        <div className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 size-1 rounded-full bg-sidebar-primary" />
      )}
    </button>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {button}
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={12} className="bg-sidebar-accent text-sidebar-accent-foreground border-sidebar-border">
          {label}
        </TooltipContent>
      </Tooltip>
    );
  }

  return button;
}
