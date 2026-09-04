"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import {
  LayoutDashboard,
  FileText,
  FileCheck2,
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
  BellRing,
  CheckCheck,
  Truck,
  Globe2,
  Store,
  LineChart,
  Users,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ArrowRight,
  WifiOff,
  RefreshCw,
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
import type { PortalAccess, PortalTier, Partner, Notification } from "@/lib/supabase/types";
import { getTierMeta } from "@/lib/portal/tiers";
import { usePortalGeolocation } from "@/lib/portal/use-geolocation";
import { ViewSkeleton } from "@/components/common/view-skeleton";
import { disconnectRealtime } from "@/hooks/use-realtime";
import { useSessionHeartbeat } from "@/hooks/use-session-heartbeat";

// UI-3 step 5 — the redesigned dashboard is a marketplace-focused welcome
// page with quick stats, quick actions, and recent activity. The legacy
// `portal-dashboard.tsx` (offers/invoices/proformas KPIs) stays in the
// codebase as a fallback but is no longer rendered.
const PortalDashboard = dynamic(
  () => import("@/components/portal/portal-dashboard-redesign").then((m) => m.PortalDashboardRedesign),
  { ssr: false, loading: () => <ViewSkeleton /> }
);
const PortalOffers = dynamic(
  () => import("@/components/portal/portal-offers").then((m) => m.PortalOffers),
  { ssr: false, loading: () => <ViewSkeleton /> }
);
const PortalDocuments = dynamic(
  () => import("@/components/portal/portal-documents").then((m) => m.PortalDocuments),
  { ssr: false, loading: () => <ViewSkeleton /> }
);
const PortalCatalog = dynamic(
  // P-CATALOG: redesigned grid + drawer + RFQ flow. The previous
  // `portal-catalog.tsx` (piled-up text cards) is superseded by
  // `portal-catalog-redesign.tsx`. Old file is kept for reference but no
  // longer rendered anywhere in the portal.
  () => import("@/components/portal/portal-catalog-redesign").then((m) => m.PortalCatalogRedesign),
  { ssr: false, loading: () => <ViewSkeleton /> }
);
const PortalProfile = dynamic(
  () => import("@/components/portal/portal-profile").then((m) => m.PortalProfile),
  { ssr: false, loading: () => <ViewSkeleton /> }
);
const PortalKyc = dynamic(
  () => import("@/components/portal/portal-kyc").then((m) => m.PortalKyc),
  { ssr: false, loading: () => <ViewSkeleton /> }
);
const PortalRfq = dynamic(
  () => import("@/components/portal/portal-rfq").then((m) => m.PortalRfq),
  { ssr: false, loading: () => <ViewSkeleton /> }
);
const PortalMessages = dynamic(
  () => import("@/components/portal/portal-messages").then((m) => m.PortalMessages),
  { ssr: false, loading: () => <ViewSkeleton /> }
);
const PortalInvoices = dynamic(
  () => import("@/components/portal/portal-invoices").then((m) => m.PortalInvoices),
  { ssr: false, loading: () => <ViewSkeleton /> }
);
const PortalProformas = dynamic(
  () => import("@/components/portal/portal-proformas").then((m) => m.PortalProformas),
  { ssr: false, loading: () => <ViewSkeleton /> }
);
// BUILD-LOI-PORTAL — Letters of Intent addressed to this partner (the
// partner is the SELLER / recipient; the tenant is the buyer). Same lazy
// dynamic-import pattern as every other portal view.
const PortalLois = dynamic(
  () => import("@/components/portal/portal-lois").then((m) => m.PortalLois),
  { ssr: false, loading: () => <ViewSkeleton /> }
);
const PortalNotifications = dynamic(
  () => import("@/components/portal/portal-notifications").then((m) => m.PortalNotifications),
  { ssr: false, loading: () => <ViewSkeleton /> }
);
const PortalLogistics = dynamic(
  () => import("@/components/portal/portal-logistics").then((m) => m.PortalLogistics),
  { ssr: false, loading: () => <ViewSkeleton /> }
);
// Marketplace (Phase 1 — Berza roba): the SPA view router renders the
// MarketplaceBrowser inside the PortalShell chrome. The standalone routes
// /portal/marketplace and /portal/marketplace/[id] both set
// `initialView="portal-marketplace"` (+ `initialSelectedId` for the detail
// page) so deep links land on the right screen.
const PortalMarketplace = dynamic(
  () => import("@/components/portal/marketplace/marketplace-browser").then((m) => m.MarketplaceBrowser),
  { ssr: false, loading: () => <ViewSkeleton /> }
);

// Marketplace (Phase 3 — company profiles): the standalone route
// /portal/marketplace/company/[partnerId] sets
// `initialView="portal-marketplace-company"` + `initialSelectedId={partnerId}`
// so the deep-link lands on the right company page. The browser stays on
// the same view key when the user clicks a company name from the post
// detail or marketplace list.
const PortalMarketplaceCompany = dynamic(
  () => import("@/components/portal/marketplace/company-profile").then((m) => m.CompanyProfile),
  { ssr: false, loading: () => <ViewSkeleton /> }
);

// Marketplace (Phase 2 — negotiation rooms): the standalone route
// /portal/marketplace/negotiations sets `initialView="portal-marketplace-negotiations"`
// and /portal/marketplace/negotiations/[id] adds
// `initialSelectedNegotiationId={id}` so the deep-link opens the room
// directly. The NegotiationsBrowser is exported from negotiation-room.tsx
// (the same file also exports the NegotiationRoom chat component so the
// SPA-side drill-down from list → room doesn't need a separate file).
const PortalNegotiations = dynamic(
  () => import("@/components/portal/marketplace/negotiation-room").then((m) => m.NegotiationsBrowser),
  { ssr: false, loading: () => <ViewSkeleton /> }
);

// Marketplace (Phase 9 — market intelligence): the standalone route
// /portal/marketplace/intelligence sets
// `initialView="portal-marketplace-intelligence"` so the deep-link opens
// the dashboard directly. The dashboard ties together the seven
// intelligence panels (price trends, supply/demand, top countries,
// heatmap, news, benchmark, seasonal) — see
// src/components/portal/marketplace/marketplace-intelligence-dashboard.tsx.
const PortalMarketplaceIntelligence = dynamic(
  () => import("@/components/portal/marketplace/marketplace-intelligence-dashboard").then((m) => m.MarketplaceIntelligenceDashboard),
  { ssr: false, loading: () => <ViewSkeleton /> }
);

// Marketplace (Phase 10 — community): the standalone route
// /portal/marketplace/community sets
// `initialView="portal-marketplace-community"` so the deep-link opens the
// community hub directly. The hub itself renders four tabs (Groups /
// Q&A / Events / Blog), each backed by its own data-fetching child
// component — see src/components/portal/marketplace/community-hub.tsx.
const PortalMarketplaceCommunity = dynamic(
  () => import("@/components/portal/marketplace/community-hub").then((m) => m.CommunityHub),
  { ssr: false, loading: () => <ViewSkeleton /> }
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
  { key: "portal-marketplace", labelKey: "portal-nav-marketplace", icon: Store },
  { key: "portal-marketplace-intelligence", labelKey: "portal-nav-marketplace-intelligence", icon: LineChart },
  { key: "portal-marketplace-community", labelKey: "portal-nav-marketplace-community", icon: Users },
  { key: "portal-offers", labelKey: "portal-nav-my-offers", icon: FileText, gate: "can_view_offers" },
  { key: "portal-invoices", labelKey: "portal-nav-my-invoices", icon: FileText, gate: "can_view_invoices" },
  { key: "portal-proformas", labelKey: "portal-nav-my-proformas", icon: FileText, gate: "can_view_invoices" },
  // BUILD-LOI-PORTAL — gated on can_view_offers (trade documents the
  // partner can see; portal_access has no dedicated can_view_lois flag).
  { key: "portal-lois", labelKey: "portal-nav-my-lois", icon: FileCheck2, gate: "can_view_offers" },
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
    labelKey: "portal-tier-limited",
    className: "border-transparent bg-muted text-muted-foreground",
    icon: Boxes,
  },
};

// View title keys — looked up at render-time so they translate when the locale changes.
const VIEW_TITLE_KEYS: Record<string, string> = {
  "portal-dashboard": "portal-nav-dashboard",
  "portal-marketplace": "portal-nav-marketplace",
  "portal-marketplace-company": "portal-nav-marketplace",
  "portal-marketplace-negotiations": "portal-nav-marketplace",
  "portal-marketplace-intelligence": "portal-nav-marketplace-intelligence",
  "portal-marketplace-community": "portal-nav-marketplace-community",
  "portal-offers": "portal-nav-my-offers",
  "portal-invoices": "portal-nav-my-invoices",
  "portal-proformas": "portal-nav-my-proformas",
  "portal-lois": "portal-nav-my-lois",
  "portal-notifications": "portal-nav-notifications",
  "portal-documents": "portal-nav-my-documents",
  "portal-catalog": "portal-nav-product-catalog",
  "portal-rfq": "portal-nav-request-quote",
  "portal-logistics": "portal-nav-logistics",
  "portal-kyc": "portal-nav-kyc",
  "portal-profile": "portal-nav-my-profile",
};

export function PortalShell({
  initialView,
  initialSelectedId,
  initialSelectedNegotiationId,
}: {
  initialView?: ViewKey;
  /** Pre-set the selected entity id (e.g. negotiation id from the URL)
   *  when deep-linking into a detail page. */
  initialSelectedId?: string;
  /** Phase 2 — pre-set the selected marketplace negotiation id when
   *  deep-linking into /portal/marketplace/negotiations/[id]. */
  initialSelectedNegotiationId?: string;
} = {}) {
  const t = useT();
  const portalAccess = useAppStore((s) => s.portalAccess) as PortalAccess | null;
  const setPortalAccess = useAppStore((s) => s.setPortalAccess);
  const setAppMode = useAppStore((s) => s.setAppMode);
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const selectedId = useAppStore((s) => s.selectedId);
  const setSelectedId = useAppStore((s) => s.setSelectedId);
  const setSelectedNegotiationId = useAppStore((s) => s.setSelectedNegotiationId);

  // P0 (session idle fix) — heartbeat POST /api/auth/touch every 5 min
  // while the tab is visible so an ACTIVELY USED portal session never
  // hits the idle timeout (previously every portal client was silently
  // logged out 30 min after login — no code ever bumped
  // last_activity_at). On 401 the session is truly expired: clear local
  // state and redirect. audit25: the redirect now carries
  // ?reason=session_expired so the login page shows WHY (no more
  // "app logs me out for no reason" reports), and onExpiringSoon toasts
  // a warning when the absolute TTL is minutes away.
  useSessionHeartbeat({
    onExpired: () => {
      setPortalAccess(null);
      if (typeof window !== "undefined") {
        window.location.href = "/portal/login?reason=session_expired";
      }
    },
    onExpiringSoon: ({ minutesLeft }) => {
      toast.warning(t("session-expiring-soon").replace("${minutes}", String(minutesLeft)));
    },
  });

  // Apply the initial view once on mount (when navigating to a deep link like
  // /portal/offers the corresponding page passes initialView so the sidebar
  // highlights the right item).
  useEffect(() => {
    if (initialView) setView(initialView);
    if (initialSelectedId) setSelectedId(initialSelectedId);
    if (initialSelectedNegotiationId) setSelectedNegotiationId(initialSelectedNegotiationId);
  }, [initialView, initialSelectedId, initialSelectedNegotiationId, setView, setSelectedId, setSelectedNegotiationId]);

  // Hydrate portalAccess from the server session on first mount. Without
  // this, a page refresh on /portal/dashboard (or a deep-link into the
  // portal) leaves the store empty and PortalShell returns null → user
  // sees a blank white page. If /api/portal/me returns 401 we redirect
  // back to the login screen instead of hanging.
  // audit25: a 401 here means the session EXPIRED (idle / absolute TTL /
  // revoked) while the user was on the page — the redirect carries
  // ?reason=session_expired so the login page explains WHY instead of
  // the "app logged me out for no reason" mystery.
  // audit26 P0: NON-401 failures (429 rate-limit, 5xx DB blip, network
  // hiccup) must NEVER log the user out. The previous code redirected to
  // /portal/login on ANY failure — a single 429 on /me kicked a paying
  // client to the login screen mid-work ("app logs me out by itself").
  // Now: 401 → login (with reason); anything else → retry with backoff,
  // and after the retries run out show a connection-problem card (the
  // session cookie is still intact — a reload recovers instantly).
  const [hydrating, setHydrating] = useState<boolean>(!portalAccess);
  const [connProblem, setConnProblem] = useState<boolean>(false);
  useEffect(() => {
// eslint-disable-next-line react-hooks/set-state-in-effect
    if (portalAccess) { setHydrating(false); return; }
    let mounted = true;
    let attempt = 0;
    const tryHydrate = () => {
      fetch("/api/portal/me", { cache: "no-store" })
        .then(async (r) => {
          if (r.status === 401) throw new Error("session_expired");
          if (!r.ok) throw new Error("transient");
          return r.json().catch(() => null);
        })
        .then((data) => {
          if (!mounted) return;
          if (data?.access) {
            setPortalAccess(data.access);
            setAppMode("portal");
            setConnProblem(false);
          } else {
            // 200 with no access — genuinely not signed in.
            window.location.href = "/portal/login";
          }
        })
        .catch((e: unknown) => {
          if (!mounted) return;
          if (e instanceof Error && e.message === "session_expired") {
            window.location.href = "/portal/login?reason=session_expired";
            return;
          }
          // Transient failure (429 / 5xx / network). Retry up to 3 times
          // with backoff, then surface a connection card — NOT a logout.
          attempt += 1;
          if (attempt < 3) {
            setTimeout(tryHydrate, 1000 * attempt);
          } else {
            setConnProblem(true);
          }
        })
        .finally(() => { if (mounted) setHydrating(false); });
    };
    tryHydrate();
    return () => { mounted = false; };
  }, [portalAccess, setPortalAccess, setAppMode]);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [partner, setPartner] = useState<Partner | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);

  // UI-3 step 1 — collapsible sidebar. The store field is shared with the
  // admin shell, but since portal mode never renders the admin sidebar the
  // state is effectively portal-local. Persisted across reloads via the
  // store-level toggle so a refresh keeps the user's chosen width.
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);

  // UI-3 step 1 — notification bell with badge. Lightweight fetch of the
  // unread count + the latest 5 notifications for the header dropdown.
  // PORTAL-L1 — backend now returns { items, count, unread_count } (was
  // { items, total }). PORTAL-L7 — append ?limit=20 so the bell doesn't
  // pull every notification ever issued for the tenant on every 60s poll;
  // the bell dropdown only renders the latest 5 anyway (recentNotifs slice
  // below), and the unread_count comes from the server so it's correct
  // even with the limit (the store filters by partner_id, and the 20 most
  // recent notifications are the only ones that could plausibly be unread
  // at any given moment — older notifications are de-facto already read).
  const notifsQ = useQuery<{ items: Notification[]; count: number; unread_count: number }>({
    queryKey: ["portal-notifications-badge"],
    queryFn: async () => {
      // 2b2-F3 — pass ?limit=20 so the store caps the DB query (was:
      // fetch all partner notifications + slice in JS). The bell
      // dropdown only renders `recentNotifs.slice(0, 5)` and the
      // unread_count comes from a separate COUNT query, so 20 is more
      // than enough for the dropdown.
      const r = await fetch("/api/portal/notifications?limit=20");
      if (!r.ok) return { items: [], count: 0, unread_count: 0 } as { items: Notification[]; count: number; unread_count: number };
      return r.json() as Promise<{ items: Notification[]; count: number; unread_count: number }>;
    },
    // REALTIME-WS: 30s → 60s. The badge bell + dropdown re-render on every
    // poll tick; 60s halves the load while still surfacing new notifications
    // within a reasonable window. The useRealtime hook (mounted in this
    // shell) pushes notification:new events that invalidate this query
    // immediately, so 60s is just the safety-net refetch, not the latency.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    enabled: !!portalAccess,
  });
  const notifItems = notifsQ.data?.items ?? [];
  const unreadNotifCount = notifItems.filter((n) => !n.read).length;
  const recentNotifs = notifItems.slice(0, 5);

  async function markAllNotifsRead() {
    // 2b2-F2 — replace N parallel PUTs (each scanning the full partner
    // notification list) with a single POST to the new bulk endpoint.
    // The backend runs one UPDATE scoped by (tenant_id, partner_id,
    // type IN PORTAL_SAFE_TYPES, read=false). One statement, one
    // round-trip — regardless of how many unread notifications the
    // partner has. The previous N×PUT pattern was O(N²) on the
    // notifications table.
    try {
      await fetch("/api/portal/notifications/read-all", { method: "POST" });
    } catch {
      // silent fail — the refetch below will reconcile whatever the
      // server actually updated.
    }
    notifsQ.refetch();
  }

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
    // REALTIME-WS: 20s → 30s. The unread-messages badge doesn't need
    // 20s freshness; portal:activity + message:new events from useRealtime
    // invalidate this query on real updates, so 30s is just the safety net.
    refetchInterval: 30_000,
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

  function signOut() {
    // PORTAL-M9 — Drop wasted setAppMode("crm") (the full-page reload drops
    // store state anyway, and flipping appMode briefly flashed the CRM UI
    // before the redirect). Keep setPortalAccess(null) — harmless. Tear
    // down the realtime WS connection so the logged-out tab doesn't keep
    // an open socket under a stale identity, then full-page navigate.
    setPortalAccess(null);
    try {
      disconnectRealtime();
    } catch {
      // socket may not be initialised — ignore.
    }
    // Full-page navigation to /logout — the most reliable way to clear
    // the session cookie. The /logout page calls the API and redirects.
    window.location.href = "/logout";
  }

  if (!portalAccess) {
    // audit26 — transient backend failure (429/5xx) after retries: keep the
    // user IN the app with a retry card. Their session cookie is intact —
    // this must never look or behave like a logout.
    if (connProblem) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-mesh-portal p-6">
          <div className="max-w-md w-full text-center space-y-4 bg-card border border-border rounded-xl p-8 shadow-soft">
            <div className="size-14 rounded-full bg-amber-500/10 flex items-center justify-center mx-auto">
              <WifiOff className="size-7 text-amber-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">{t("portal-conn-problem-title")}</h2>
              <p className="text-sm text-muted-foreground mt-1">{t("portal-conn-problem-desc")}</p>
            </div>
            <Button onClick={() => window.location.reload()} className="w-full">
              <RefreshCw className="size-4 mr-2" /> {t("portal-conn-problem-retry")}
            </Button>
          </div>
        </div>
      );
    }
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
      {/* Sidebar — portal (glass, client-facing). Collapsible on desktop to
          // a 72px icon rail; the mobile drawer below renders the expanded
          // 288px variant regardless so labels stay readable on small screens. */}
      <aside
        className={cn(
          "hidden md:flex shrink-0 flex-col border-r border-border/60 glass text-sidebar-foreground smooth",
          sidebarCollapsed ? "w-[72px]" : "w-64",
        )}
      >
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
          collapsed={sidebarCollapsed}
          onToggleCollapse={toggleSidebar}
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
              collapsed={false}
              onToggleCollapse={() => setMobileNavOpen(false)}
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
              {/* UI-3 step 1 — notification bell with unread badge + dropdown.
                  Pulls from the same /api/portal/notifications endpoint as the
                  full Notifications view; the dropdown just shows the latest 5
                  + a "view all" + "mark all read" shortcut. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="relative size-9 rounded-full"
                    aria-label={t("portal-shell-notifications")}
                  >
                    {unreadNotifCount > 0 ? (
                      <BellRing className="size-[18px] text-foreground/80" />
                    ) : (
                      <Bell className="size-[18px] text-muted-foreground" />
                    )}
                    {unreadNotifCount > 0 && (
                      <span className="absolute top-1.5 right-1.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-xs font-semibold tabular leading-none ring-2 ring-background">
                        {unreadNotifCount > 99 ? "99+" : unreadNotifCount}
                      </span>
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-80 p-0">
                  <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/60">
                    <div>
                      <p className="text-sm font-semibold">{t("portal-shell-notifications")}</p>
                      <p className="text-xs text-muted-foreground">
                        {unreadNotifCount > 0
                          ? t("portal-unread").replace("{n}", String(unreadNotifCount))
                          : t("portal-shell-notifications-empty")}
                      </p>
                    </div>
                    {unreadNotifCount > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs gap-1"
                        onClick={markAllNotifsRead}
                      >
                        <CheckCheck className="size-3.5" />
                        {t("portal-shell-mark-all-read")}
                      </Button>
                    )}
                  </div>
                  <div className="max-h-80 overflow-y-auto custom-scroll">
                    {recentNotifs.length === 0 ? (
                      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                        {t("portal-shell-notifications-empty")}
                      </div>
                    ) : (
                      recentNotifs.map((n) => (
                        <DropdownMenuItem
                          key={n.id}
                          className="flex items-start gap-2.5 px-3 py-2.5 cursor-pointer focus:bg-accent"
                          onClick={() => setView("portal-notifications")}
                        >
                          {!n.read && (
                            <span className="mt-1.5 size-1.5 rounded-full bg-primary shrink-0" />
                          )}
                          <div className={cn("min-w-0 flex-1", n.read && "pl-4")}>
                            <p className="text-xs font-medium line-clamp-2">{n.title}</p>
                            {n.message && (
                              <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{n.message}</p>
                            )}
                            <p className="text-xs text-muted-foreground mt-0.5 tabular">
                              {fmtRelative(n.created_at)}
                            </p>
                          </div>
                        </DropdownMenuItem>
                      ))
                    )}
                  </div>
                  <div className="border-t border-border/60 p-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-center text-xs gap-1.5"
                      onClick={() => setView("portal-notifications")}
                    >
                      {t("portal-shell-view-all-notifications")}
                      <ArrowRight className="size-3" />
                    </Button>
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
              {/* AUDIT28-DESIGN — decluttered header: partner name + avatar
                  dropdown only. The tier badge and "last login" line used to
                  sit here as well (VLM review: "fighting for space") — both
                  are already shown inside the profile dropdown below, so the
                  prime header real estate now carries just identity + tools. */}
              <div className="hidden sm:flex flex-col items-end leading-tight">
                <span className="text-sm font-medium max-w-[180px] truncate">
                  {partnerName}
                </span>
              </div>
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
              {/* UI-3 step 1 — user profile dropdown. Replaces the previous
                  plain avatar button with a dropdown offering shortcuts to
                  profile, KYC, and sign-out. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="flex items-center gap-1 rounded-full hover:ring-2 hover:ring-primary/20 smooth focus:outline-none focus:ring-2 focus:ring-primary/30"
                    aria-label={t("portal-shell-account")}
                  >
                    <Avatar className="size-9 ring-1 ring-border shadow-soft">
                      <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                        {initials(partnerName)}
                      </AvatarFallback>
                    </Avatar>
                    <ChevronDown className="size-3.5 text-muted-foreground -ml-1 hidden sm:block" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56 p-0">
                  <div className="px-3 py-3 border-b border-border/60">
                    <p className="text-sm font-semibold truncate">{partnerName}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {t("portal-shell-welcome-short").replace("{name}", partnerName.split(" ")[0])}
                    </p>
                    {portalAccess.last_login_at && (
                      <p className="text-xs text-muted-foreground/80 mt-1 tabular">
                        {t("portal-last-login")} {fmtRelative(portalAccess.last_login_at)}
                      </p>
                    )}
                    <div className="mt-2">
                      <Badge className={cn("gap-1 capitalize", TIER_META[tier].className)}>
                        <TierIcon className="size-3" />
                        {t(TIER_META[tier].labelKey)}
                      </Badge>
                    </div>
                  </div>
                  <div className="p-1.5">
                    <DropdownMenuItem
                      className="gap-2 cursor-pointer rounded-md px-2 py-1.5 text-sm"
                      onClick={() => setView("portal-profile")}
                    >
                      <User className="size-4 text-muted-foreground" />
                      {t("portal-shell-view-profile")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="gap-2 cursor-pointer rounded-md px-2 py-1.5 text-sm"
                      onClick={() => setView("portal-kyc")}
                    >
                      <ShieldCheck className="size-4 text-muted-foreground" />
                      {t("portal-shell-manage-kyc")}
                    </DropdownMenuItem>
                  </div>
                  <div className="border-t border-border/60 p-1.5">
                    <DropdownMenuItem
                      className="gap-2 cursor-pointer rounded-md px-2 py-1.5 text-sm text-destructive focus:text-destructive"
                      onClick={signOut}
                    >
                      <LogOut className="size-4" />
                      {t("portal-shell-sign-out-confirm")}
                    </DropdownMenuItem>
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
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
              {view === "portal-lois" && <PortalLois />}
              {view === "portal-notifications" && <PortalNotifications />}
              {view === "portal-documents" && <PortalDocuments />}
              {view === "portal-catalog" && <PortalCatalog />}
              {view === "portal-kyc" && <PortalKyc />}
              {view === "portal-rfq" && <PortalRfq />}
              {view === "portal-logistics" && <PortalLogistics />}
              {view === "portal-messages" && <PortalMessages />}
              {view === "portal-profile" && <PortalProfile />}
              {view === "portal-marketplace" && <PortalMarketplace />}
              {view === "portal-marketplace-company" && selectedId && (
                <PortalMarketplaceCompany partnerId={selectedId} />
              )}
              {view === "portal-marketplace-negotiations" && <PortalNegotiations />}
              {view === "portal-marketplace-intelligence" && <PortalMarketplaceIntelligence />}
              {view === "portal-marketplace-community" && <PortalMarketplaceCommunity />}
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
  collapsed,
  onToggleCollapse,
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
  /** UI-3 step 1 — when true, sidebar collapses to an icon rail (labels
   *  hidden, section headers hidden, partner card shows avatar only). */
  collapsed: boolean;
  onToggleCollapse: () => void;
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
      <div className={cn("h-16 flex items-center border-b border-border/60 shrink-0", collapsed ? "justify-center px-2" : "gap-3 px-4")}>
        <div className="size-9 rounded-lg bg-gradient-emerald text-primary-foreground flex items-center justify-center shrink-0 font-semibold text-sm tracking-tight shadow-soft-md">
          A
        </div>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-sm tracking-tight truncate">{t("portal-brand-title")}</p>
            <p className="text-xs text-muted-foreground truncate">{t("portal-brand-subtitle")}</p>
          </div>
        )}
      </div>

      {/* Partner card — premium feel. Collapsed mode shows avatar only. */}
      <div className={cn("border-b border-border/60 shrink-0", collapsed ? "px-2 py-3" : "px-3 py-4")}>
        <div className={cn("rounded-xl bg-card border border-border/60 shadow-soft relative overflow-hidden", collapsed ? "p-1.5 flex justify-center" : "p-3")}>
          {profileLoading ? (
            <div className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
              {!collapsed && <span className="text-xs text-muted-foreground">{t("portal-loading-dots")}</span>}
            </div>
          ) : collapsed ? (
            <Avatar className="size-9 ring-1 ring-border" title={partnerName}>
              <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                {initials(partnerName)}
              </AvatarFallback>
            </Avatar>
          ) : (
            <div className="relative">
              <div className="flex items-center gap-2 mb-2">
                <Avatar className="size-9 ring-1 ring-border">
                  <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                    {initials(partnerName)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold truncate" title={partnerName}>
                    {partnerName}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
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
          {!collapsed && (
            <p className="px-3 pb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
              {t("portal-section-workspace")}
            </p>
          )}
          {workspaceItems.map((item, idx) => {
            const Icon = item.icon;
            const active = isActive(item);
            const badgeCount = item.badgeKey === "messages_unread" ? messagesUnread : 0;
            return (
              <button
                key={`ws-${idx}`}
                onClick={() => setView(item.key)}
                title={collapsed ? t(item.labelKey) : undefined}
                aria-label={t(item.labelKey)}
                className={cn(
                  "group relative w-full flex items-center rounded-lg text-sm font-medium smooth",
                  collapsed ? "justify-center px-2 py-2" : "gap-3 px-3 py-2",
                  active
                    ? "bg-primary/10 text-primary glow-emerald"
                    : "text-foreground/70 hover:bg-accent hover:text-accent-foreground"
                )}
              >
                {/* UI-3 step 1 — active state accent: a copper left bar that
                    // doubles as a visual selection cue in both expanded and
                    // collapsed modes. */}
                {active && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-1 rounded-full bg-primary smooth" />
                )}
                <Icon
                  className={cn(
                    "size-[18px] shrink-0 smooth",
                    active
                      ? "text-primary"
                      : "text-muted-foreground group-hover:text-foreground"
                  )}
                />
                {!collapsed && <span className="truncate flex-1 text-left">{t(item.labelKey)}</span>}
                {badgeCount > 0 && (
                  <Badge className="bg-destructive text-destructive-foreground text-xs px-1.5 py-0 h-5 min-w-[20px] justify-center rounded-full tabular">
                    {badgeCount > 99 ? "99+" : badgeCount}
                  </Badge>
                )}
              </button>
            );
          })}
        </div>

        {/* Account section */}
        {!collapsed ? (
          <div className="space-y-1">
            <p className="px-3 pb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
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
                    "group relative w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium smooth",
                    active
                      ? "bg-primary/10 text-primary glow-emerald"
                      : "text-foreground/70 hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  {active && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-1 rounded-full bg-primary smooth" />
                  )}
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
        ) : (
          /* Collapsed mode — render account items inline (icons only). */
          <div className="space-y-1 pt-4 border-t border-border/40">
            {accountItems.map((item, idx) => {
              const Icon = item.icon;
              const active = isActive(item);
              return (
                <button
                  key={`acc-${idx}`}
                  onClick={() => setView(item.key)}
                  title={t(item.labelKey)}
                  aria-label={t(item.labelKey)}
                  className={cn(
                    "group relative w-full flex items-center justify-center rounded-lg px-2 py-2 text-sm font-medium smooth",
                    active
                      ? "bg-primary/10 text-primary glow-emerald"
                      : "text-foreground/70 hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  {active && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-1 rounded-full bg-primary smooth" />
                  )}
                  <Icon
                    className={cn(
                      "size-[18px] shrink-0 smooth",
                      active ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                    )}
                  />
                </button>
              );
            })}
          </div>
        )}
      </nav>

      {/* Collapse toggle + sign out */}
      <div className="border-t border-border/60 p-3 shrink-0 space-y-1.5">
        {/* UI-3 step 1 — collapse/expand toggle (desktop only; the mobile
            // drawer passes onToggleCollapse = close drawer so tapping the
            // button just dismisses the drawer). */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleCollapse}
          className={cn(
            "w-full justify-center text-muted-foreground hover:text-foreground smooth h-9",
            collapsed ? "px-0" : "px-2"
          )}
          aria-label={collapsed ? t("portal-shell-expand") : t("portal-shell-collapse")}
          title={collapsed ? t("portal-shell-expand") : t("portal-shell-collapse")}
        >
          {collapsed ? (
            <ChevronRight className="size-4" />
          ) : (
            <>
              <ChevronLeft className="size-4 mr-2" />
              {t("portal-shell-collapse")}
            </>
          )}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={signOut}
          className={cn(
            "w-full justify-center text-muted-foreground hover:text-foreground smooth h-9",
            collapsed ? "px-0" : "justify-start"
          )}
          title={collapsed ? t("portal-sign-out") : undefined}
          aria-label={t("portal-sign-out")}
        >
          <LogOut className="size-4" />
          {!collapsed && <span className="ml-2">{t("portal-sign-out")}</span>}
        </Button>
      </div>
    </>
  );
}
