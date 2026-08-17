"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import {
  LayoutDashboard,
  FileText,
  FolderOpen,
  Package,
  ShoppingCart,
  ShieldCheck,
  User,
  LogOut,
  Crown,
  Shield,
  Boxes,
  Briefcase,
  Loader2,
  Menu,
  X,
  MapPin,
  ShieldAlert,
  MessageSquare,
  Bell,
  Truck,
  Globe2,
} from "lucide-react";
import { useAppStore, ViewKey } from "@/lib/store/app-store";
import { useT, useI18nStore } from "@/lib/i18n/store";
import { LOCALE_LABELS, LOCALE_FLAGS, type Locale } from "@/lib/i18n/dictionaries";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { initials, fmtRelative } from "@/lib/utils/format";
import { toast } from "sonner";
import type { PortalAccess, PortalTier, Partner } from "@/lib/supabase/types";
import { getTierMeta } from "@/lib/portal/tiers";
import { usePortalGeolocation } from "@/lib/portal/use-geolocation";

const PortalDashboard = dynamic(
  () => import("@/components/portal/portal-dashboard").then((m) => m.PortalDashboard),
  { ssr: false }
);
const PortalOffers = dynamic(
  () => import("@/components/portal/portal-offers").then((m) => m.PortalOffers),
  { ssr: false }
);
const PortalDocuments = dynamic(
  () => import("@/components/portal/portal-documents").then((m) => m.PortalDocuments),
  { ssr: false }
);
const PortalCatalog = dynamic(
  // P-CATALOG: redesigned grid + drawer + RFQ flow. The previous
  // `portal-catalog.tsx` (piled-up text cards) is superseded by
  // `portal-catalog-redesign.tsx`. Old file is kept for reference but no
  // longer rendered anywhere in the portal.
  () => import("@/components/portal/portal-catalog-redesign").then((m) => m.PortalCatalogRedesign),
  { ssr: false }
);
const PortalProfile = dynamic(
  () => import("@/components/portal/portal-profile").then((m) => m.PortalProfile),
  { ssr: false }
);
const PortalKyc = dynamic(
  () => import("@/components/portal/portal-kyc").then((m) => m.PortalKyc),
  { ssr: false }
);
const PortalRfq = dynamic(
  () => import("@/components/portal/portal-rfq").then((m) => m.PortalRfq),
  { ssr: false }
);
const PortalMessages = dynamic(
  () => import("@/components/portal/portal-messages").then((m) => m.PortalMessages),
  { ssr: false }
);
const PortalInvoices = dynamic(
  () => import("@/components/portal/portal-invoices").then((m) => m.PortalInvoices),
  { ssr: false }
);
const PortalProformas = dynamic(
  () => import("@/components/portal/portal-proformas").then((m) => m.PortalProformas),
  { ssr: false }
);
const PortalNotifications = dynamic(
  () => import("@/components/portal/portal-notifications").then((m) => m.PortalNotifications),
  { ssr: false }
);
const PortalLogistics = dynamic(
  () => import("@/components/portal/portal-logistics").then((m) => m.PortalLogistics),
  { ssr: false }
);

interface NavItem {
  key: ViewKey;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
  gate?: keyof PortalAccess;
  badgeKey?: "messages_unread";
}

const NAV_ITEMS: NavItem[] = [
  { key: "portal-dashboard", labelKey: "portal-nav-dashboard", icon: LayoutDashboard },
  { key: "portal-offers", labelKey: "portal-nav-my-offers", icon: FileText, gate: "can_view_offers" },
  { key: "portal-invoices", labelKey: "portal-nav-my-invoices", icon: FileText, gate: "can_view_invoices" },
  { key: "portal-proformas", labelKey: "portal-nav-my-proformas", icon: FileText, gate: "can_view_invoices" },
  { key: "portal-messages", labelKey: "portal-nav-messages", icon: MessageSquare, badgeKey: "messages_unread" },
  { key: "portal-notifications", labelKey: "portal-nav-notifications", icon: Bell },
  { key: "portal-documents", labelKey: "portal-nav-my-documents", icon: FolderOpen, gate: "can_view_documents" },
  { key: "portal-catalog", labelKey: "portal-nav-product-catalog", icon: Package, gate: "can_view_catalog" },
  { key: "portal-rfq", labelKey: "portal-nav-request-quote", icon: ShoppingCart, gate: "can_submit_rfq" },
  { key: "portal-logistics", labelKey: "portal-nav-logistics", icon: Truck },
  { key: "portal-kyc", labelKey: "portal-nav-kyc", icon: ShieldCheck },
  { key: "portal-profile", labelKey: "portal-nav-my-profile", icon: User, gate: "can_view_profile" },
  // NOTE: "Company Info" removed — no `portal-company` view exists yet, and the
  // duplicate `key: "portal-profile"` opened the same view as "My Profile" (P1-5).
  // Re-add as `{ key: "portal-company", labelKey: "portal-nav-company-info", ... }` once a
  // dedicated company-info view (or a tab inside PortalProfile) is implemented.
];

const TIER_META: Record<
  PortalTier,
  { labelKey: string; className: string; icon: React.ComponentType<{ className?: string }> }
> = {
  premium: {
    labelKey: "portal-tier-premium",
    className: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
    icon: Crown,
  },
  business: {
    labelKey: "portal-tier-business",
    className: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    icon: Briefcase,
  },
  standard: {
    labelKey: "portal-tier-standard",
    className: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400",
    icon: Shield,
  },
  basic: {
    labelKey: "portal-tier-basic",
    className: "border-transparent bg-muted text-muted-foreground",
    icon: Boxes,
  },
  limited: {
    labelKey: "portal-tier-basic",
    className: "border-transparent bg-muted text-muted-foreground",
    icon: Boxes,
  },
};

// View title keys — looked up at render-time so they translate when the locale changes.
const VIEW_TITLE_KEYS: Record<string, string> = {
  "portal-dashboard": "portal-nav-dashboard",
  "portal-offers": "portal-nav-my-offers",
  "portal-invoices": "portal-nav-my-invoices",
  "portal-proformas": "portal-nav-my-proformas",
  "portal-notifications": "portal-nav-notifications",
  "portal-documents": "portal-nav-my-documents",
  "portal-catalog": "portal-nav-product-catalog",
  "portal-rfq": "portal-nav-request-quote",
  "portal-logistics": "portal-nav-logistics",
  "portal-kyc": "portal-nav-kyc",
  "portal-profile": "portal-nav-my-profile",
};

export function PortalShell({ initialView }: { initialView?: ViewKey } = {}) {
  const t = useT();
  const portalAccess = useAppStore((s) => s.portalAccess) as PortalAccess | null;
  const setPortalAccess = useAppStore((s) => s.setPortalAccess);
  const setAppMode = useAppStore((s) => s.setAppMode);
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);

  // Apply the initial view once on mount (when navigating to a deep link like
  // /portal/offers the corresponding page passes initialView so the sidebar
  // highlights the right item).
  useEffect(() => {
    if (initialView) setView(initialView);
  }, [initialView]);

  // Hydrate portalAccess from the server session on first mount. Without
  // this, a page refresh on /portal/dashboard (or a deep-link into the
  // portal) leaves the store empty and PortalShell returns null → user
  // sees a blank white page. If /api/portal/me returns 401 we redirect
  // back to the login screen instead of hanging.
  const [hydrating, setHydrating] = useState<boolean>(!portalAccess);
  useEffect(() => {
    if (portalAccess) { setHydrating(false); return; }
    let mounted = true;
    fetch("/api/portal/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!mounted) return;
        if (data?.access) {
          setPortalAccess(data.access);
          setAppMode("portal");
        } else if (typeof window !== "undefined") {
          window.location.href = "/portal/login";
        }
      })
      .catch(() => {
        if (mounted && typeof window !== "undefined") window.location.href = "/portal/login";
      })
      .finally(() => { if (mounted) setHydrating(false); });
    return () => { mounted = false; };
  }, [portalAccess, setPortalAccess, setAppMode]);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [partner, setPartner] = useState<Partner | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);

  // Geolocation capture (required for non-Premium tiers; the hook handles
  // the audit logging and re-logs every 5 minutes).
  const geo = usePortalGeolocation(portalAccess);

  // KYC gate — non-exempt tiers that require KYC cannot use the portal until
  // their submission is `approved`. Enforced on the CLIENT here so the user
  // is bounced straight to the KYC view; the SERVER-side redaction plus the
  // per-endpoint permission gates are the real safety net.
  const kycRequired = portalAccess ? getTierMeta(portalAccess.tier).requiresKyc && !portalAccess.exempt_kyc : false;
  const kycApproved = partner?.kyc_status === "approved";
  const kycBlocking = kycRequired && !kycApproved && !profileLoading;

  // Unread messages badge for the sidebar
  const unreadQ = useQuery({
    queryKey: ["portal-messages-unread"],
    queryFn: async () => {
      const r = await fetch("/api/portal/messages/unread");
      return r.ok ? (r.json() as Promise<{ count: number }>) : { count: 0 };
    },
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    enabled: !!portalAccess,
  });
  const messagesUnread = unreadQ.data?.count ?? 0;

  // Fetch partner profile once for sidebar/topbar display
  useEffect(() => {
    let mounted = true;
    fetch("/api/portal/profile")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (mounted && data?.partner) setPartner(data.partner);
        if (mounted) setProfileLoading(false);
      })
      .catch(() => mounted && setProfileLoading(false));
    return () => {
      mounted = false;
    };
  }, [portalAccess?.id]);

  // ─── Restore client's saved locale preference ───────────────────────────
  // Each portal client can have their own language. On mount, if the
  // portal_access row has a locale set, apply it to the i18n store — but
  // ONLY if the user hasn't already chosen a language on the login page
  // (stored in localStorage under "velos-locale"). Without this guard,
  // a fresh `portalAccess.locale` (default "en") would overwrite the
  // pre-login choice on first login (P2-6).
  const setLocale = useI18nStore((s) => s.setLocale);
  useEffect(() => {
    if (portalAccess?.locale) {
      const saved = portalAccess.locale as Locale;
      if (["en", "sr", "tr", "de", "ru"].includes(saved)) {
        // Only apply if the user hasn't already chosen a language on the login page.
        const localStorageLocale = typeof window !== "undefined"
          ? (localStorage.getItem("velos-locale") as Locale | null)
          : null;
        if (!localStorageLocale || localStorageLocale === "en") {
          setLocale(saved);
        }
      }
    }
  }, [portalAccess?.locale, setLocale]);

  // Save locale preference when the user changes language in the portal.
  function changeLocale(loc: Locale) {
    setLocale(loc);
    // Persist to portal_access (best-effort — non-blocking).
    fetch("/api/portal/me", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: loc }),
    }).catch(() => {});
    toast.success(LOCALE_LABELS[loc]);
  }

  // If KYC is required but not yet approved, force the KYC view. Other tabs
  // are hidden in the sidebar below (see kycBlocking guard).
  // MUST live above every early return — Rules of Hooks. The body guards
  // itself so it's cheap when `portalAccess` isn't loaded yet.
  useEffect(() => {
    if (kycBlocking && view !== "portal-kyc") {
      setView("portal-kyc");
    }
  }, [kycBlocking, view, setView]);

  async function signOut() {
    try {
      await fetch("/api/portal/me", { method: "POST" });
    } catch {
      // ignore — still clear client state
    }
    setPortalAccess(null);
    setAppMode("crm");
    toast.success(t("portal-toast-signed-out"));
  }

  if (!portalAccess) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-mesh-portal">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{hydrating ? t("portal-loading-portal") : t("portal-redirecting-signin")}</p>
        </div>
      </div>
    );
  }

  // Geolocation gate — required for all non-Premium tiers. Block rendering
  // until the browser has granted (or denied) location permission. Premium
  // clients skip this entirely.
  if (geo.required && !geo.shared && (geo.loading || !geo.error)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-mesh-portal p-6">
        <div className="max-w-md w-full text-center space-y-4">
          <div className="size-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
            <MapPin className="size-8 text-primary animate-pulse" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">{t("portal-geo-sharing-title")}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {t("portal-geo-sharing-desc").replace("{tier}", t(TIER_META[portalAccess.tier].labelKey))}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={signOut}>
            {t("portal-geo-cancel-signout")}
          </Button>
        </div>
      </div>
    );
  }

  if (geo.required && !geo.shared && geo.error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-mesh-portal p-6">
        <div className="max-w-md w-full text-center space-y-4">
          <div className="size-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto">
            <ShieldAlert className="size-8 text-destructive" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">{t("portal-geo-required-title")}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {t("portal-geo-required-desc").replace("{tier}", t(TIER_META[portalAccess.tier].labelKey))}
            </p>
            <p className="text-xs text-muted-foreground mt-2 font-mono">
              {t("portal-geo-error-label").replace("{error}", geo.error)}
            </p>
          </div>
          <div className="flex gap-2 justify-center">
            <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
              {t("portal-geo-reload")}
            </Button>
            <Button variant="ghost" size="sm" onClick={signOut}>
              {t("portal-sign-out")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const tier = portalAccess.tier;
  const TierIcon = TIER_META[tier].icon;
  const partnerName = partner?.name || t("portal-default-client");

  const activeTitle =
    view === "portal-profile" ? t("portal-nav-my-profile") : t(VIEW_TITLE_KEYS[view] || "portal-client-portal");

  return (
    <div className="min-h-screen flex bg-background bg-mesh-portal">
      {/* Sidebar — portal (glass, client-facing) */}
      <aside className="hidden md:flex w-64 shrink-0 flex-col border-r border-border/60 glass text-sidebar-foreground">
        <SidebarContent
          portalAccess={portalAccess}
          partnerName={partnerName}
          partner={partner}
          profileLoading={profileLoading}
          view={view}
          setView={(v) => {
            setView(v);
            setMobileNavOpen(false);
          }}
          signOut={signOut}
          tier={tier}
          TierIcon={TierIcon}
          kycBlocking={kycBlocking}
          messagesUnread={messagesUnread}
        />
      </aside>

      {/* Mobile drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside className="absolute left-0 top-0 h-full w-72 glass-strong border-r border-border/60 flex flex-col smooth">
            <SidebarContent
              portalAccess={portalAccess}
              partnerName={partnerName}
              partner={partner}
              profileLoading={profileLoading}
              view={view}
              setView={(v) => {
                setView(v);
                setMobileNavOpen(false);
              }}
              signOut={signOut}
              tier={tier}
              TierIcon={TierIcon}
              kycBlocking={kycBlocking}
              messagesUnread={messagesUnread}
            />
          </aside>
        </div>
      )}

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Topbar — glass */}
        <header className="h-16 sticky top-0 z-30 border-b border-border/60 glass">
          <div className="h-full px-4 md:px-6 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden -ml-2 size-9"
                onClick={() => setMobileNavOpen(true)}
                aria-label={t("portal-open-navigation")}
              >
                <Menu className="size-5" />
              </Button>
              <h2 className="text-base sm:text-lg font-semibold tracking-tight truncate">
                {activeTitle}
              </h2>
            </div>
            <div className="flex items-center gap-2 sm:gap-3">
              <div className="hidden sm:flex flex-col items-end leading-tight">
                <span className="text-sm font-medium max-w-[180px] truncate">
                  {partnerName}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {t("portal-last-login")} {fmtRelative(portalAccess.last_login_at)}
                </span>
              </div>
              <Badge className={cn("gap-1 capitalize", TIER_META[tier].className)}>
                <TierIcon className="size-3" />
                {t(TIER_META[tier].labelKey)}
              </Badge>
              {/* Theme toggle — light/dark mode */}
              <ThemeToggle />
              {/* Language selector — per-client locale preference */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="gap-1.5 h-9 px-2.5">
                    <Globe2 className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{LOCALE_FLAGS[useI18nStore.getState().locale as Locale]}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[160px]">
                  {(Object.keys(LOCALE_LABELS) as Locale[]).map((loc) => (
                    <DropdownMenuItem
                      key={loc}
                      onClick={() => changeLocale(loc)}
                      className={cn(
                        "gap-2 cursor-pointer",
                        useI18nStore.getState().locale === loc && "bg-accent"
                      )}
                    >
                      <span className="text-base">{LOCALE_FLAGS[loc]}</span>
                      <span className="text-sm">{LOCALE_LABELS[loc]}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Avatar className="size-9 ring-1 ring-border shadow-soft">
                <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                  {initials(partnerName)}
                </AvatarFallback>
              </Avatar>
            </div>
          </div>
        </header>

        {/* View router. When KYC is required and not approved, ONLY the KYC
            page renders; every other view is short-circuited to a banner. */}
        <main className="flex-1 p-4 md:p-6 lg:p-8 overflow-x-hidden">
          {kycBlocking && view !== "portal-kyc" ? (
            <div className="max-w-2xl mx-auto mt-8 rounded-xl border border-amber-500/40 bg-amber-500/5 p-6 text-center">
              <div className="size-12 mx-auto rounded-full bg-amber-500/15 flex items-center justify-center mb-3">
                <ShieldAlert className="size-6 text-amber-600" />
              </div>
              <h3 className="text-lg font-semibold">{t("portal-kyc-block-title")}</h3>
              <p className="text-sm text-muted-foreground mt-1">
                {t("portal-kyc-block-desc").replace("{tier}", t(TIER_META[tier].labelKey))}
              </p>
              <Button className="mt-4" onClick={() => setView("portal-kyc")}>
                {t("portal-kyc-block-cta")}
              </Button>
            </div>
          ) : (
            <>
              {view === "portal-dashboard" && <PortalDashboard />}
              {view === "portal-offers" && <PortalOffers />}
              {view === "portal-invoices" && <PortalInvoices />}
              {view === "portal-proformas" && <PortalProformas />}
              {view === "portal-notifications" && <PortalNotifications />}
              {view === "portal-documents" && <PortalDocuments />}
              {view === "portal-catalog" && <PortalCatalog />}
              {view === "portal-kyc" && <PortalKyc />}
              {view === "portal-rfq" && <PortalRfq />}
              {view === "portal-logistics" && <PortalLogistics />}
              {view === "portal-messages" && <PortalMessages />}
              {view === "portal-profile" && <PortalProfile />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

// ---- Sidebar content (shared between desktop + mobile drawer) ----
function SidebarContent({
  portalAccess,
  partnerName,
  partner,
  profileLoading,
  view,
  setView,
  signOut,
  tier,
  TierIcon,
  kycBlocking,
  messagesUnread,
}: {
  portalAccess: PortalAccess;
  partnerName: string;
  partner: Partner | null;
  profileLoading: boolean;
  view: ViewKey;
  setView: (v: ViewKey) => void;
  signOut: () => void;
  tier: PortalTier;
  TierIcon: React.ComponentType<{ className?: string }>;
  kycBlocking: boolean;
  messagesUnread: number;
}) {
  // While KYC is blocking, only the KYC + Profile items are usable. Everything
  // else is hidden so the sidebar can't tease functionality the user hasn't
  // unlocked yet.
  const t = useT();
  const visibleItems = NAV_ITEMS.filter((n) => {
    if (kycBlocking && n.key !== "portal-kyc" && n.key !== "portal-profile") return false;
    return !n.gate || (portalAccess[n.gate] as boolean);
  });

  // Group items: main workspace vs account (matched by nav key, not label text,
  // so the grouping is locale-independent).
  const ACCOUNT_KEYS = new Set(["portal-profile", "portal-company", "portal-kyc"]);
  const workspaceItems = visibleItems.filter((n) => !ACCOUNT_KEYS.has(n.key));
  const accountItems = visibleItems.filter((n) => ACCOUNT_KEYS.has(n.key));

  function isActive(item: NavItem): boolean {
    return view === item.key;
  }

  return (
    <>
      {/* Brand */}
      <div className="h-16 flex items-center gap-3 px-4 border-b border-border/60 shrink-0">
        <div className="size-9 rounded-lg bg-gradient-emerald text-primary-foreground flex items-center justify-center shrink-0 font-semibold text-sm tracking-tight shadow-soft-md">
          A
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-sm tracking-tight truncate">{t("portal-brand-title")}</p>
          <p className="text-[10px] text-muted-foreground truncate">{t("portal-brand-subtitle")}</p>
        </div>
      </div>

      {/* Partner card — premium feel */}
      <div className="px-3 py-4 border-b border-border/60 shrink-0">
        <div className="rounded-xl bg-card border border-border/60 shadow-soft p-3 relative overflow-hidden">
          {/* Subtle accent for premium */}
          {tier === "premium" && (
            <div className="absolute top-0 right-0 h-12 w-12 bg-amber-500/10 blur-2xl rounded-full" />
          )}
          {profileLoading ? (
            <div className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">{t("portal-loading-dots")}</span>
            </div>
          ) : (
            <div className="relative">
              <div className="flex items-center gap-2 mb-2">
                <Avatar className="size-9 ring-1 ring-border">
                  <AvatarFallback className="bg-primary/10 text-primary text-[11px] font-medium">
                    {initials(partnerName)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold truncate" title={partnerName}>
                    {partnerName}
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {partner?.entity_type === "individual" ? t("portal-individual") : t("portal-company")}
                    {partner?.country ? ` · ${partner.country}` : ""}
                  </p>
                </div>
              </div>
              <Badge
                className={cn("gap-1 capitalize w-full justify-center", TIER_META[tier].className)}
                variant="outline"
              >
                <TierIcon className="size-3" />
                {t("portal-tier-label").replace("{tier}", t(TIER_META[tier].labelKey))}
              </Badge>
            </div>
          )}
        </div>
      </div>

      {/* Nav — workspace */}
      <nav className="flex-1 overflow-y-auto custom-scroll px-3 py-4 space-y-5">
        <div className="space-y-1">
          <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
            {t("portal-section-workspace")}
          </p>
          {workspaceItems.map((item, idx) => {
            const Icon = item.icon;
            const active = isActive(item);
            const badgeCount = item.badgeKey === "messages_unread" ? messagesUnread : 0;
            return (
              <button
                key={`ws-${idx}`}
                onClick={() => setView(item.key)}
                className={cn(
                  "group w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium smooth",
                  active
                    ? "bg-primary/10 text-primary glow-emerald"
                    : "text-foreground/70 hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <Icon
                  className={cn(
                    "size-[18px] shrink-0 smooth",
                    active
                      ? "text-primary"
                      : "text-muted-foreground group-hover:text-foreground"
                  )}
                />
                <span className="truncate flex-1 text-left">{t(item.labelKey)}</span>
                {badgeCount > 0 && (
                  <Badge className="bg-destructive text-destructive-foreground text-[10px] px-1.5 py-0 h-5 min-w-[20px] justify-center rounded-full tabular">
                    {badgeCount > 99 ? "99+" : badgeCount}
                  </Badge>
                )}
              </button>
            );
          })}
        </div>

        {/* Account section */}
        <div className="space-y-1">
          <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
            {t("portal-section-account")}
          </p>
          {accountItems.map((item, idx) => {
            const Icon = item.icon;
            const active = isActive(item);
            return (
              <button
                key={`acc-${idx}`}
                onClick={() => setView(item.key)}
                className={cn(
                  "group w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium smooth",
                  active
                    ? "bg-primary/10 text-primary glow-emerald"
                    : "text-foreground/70 hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <Icon
                  className={cn(
                    "size-[18px] shrink-0 smooth",
                    active
                      ? "text-primary"
                      : "text-muted-foreground group-hover:text-foreground"
                  )}
                />
                <span className="truncate">{t(item.labelKey)}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Sign out */}
      <div className="border-t border-border/60 p-3 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={signOut}
          className="w-full justify-start text-muted-foreground hover:text-foreground smooth"
        >
          <LogOut className="size-4 mr-2" /> {t("portal-sign-out")}
        </Button>
      </div>
    </>
  );
}
