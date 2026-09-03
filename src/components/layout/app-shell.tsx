"use client";

import * as React from "react";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { GlobalSearch } from "./global-search";
import { ImpersonateBanner } from "./impersonate-banner";
import { SubscriptionBanner } from "./subscription-banner";
import { KeyboardShortcuts } from "./keyboard-shortcuts";
import { useAppStore, useHydrateViewState } from "@/lib/store/app-store";
import { cn } from "@/lib/utils";
import { BrandLogo } from "@/components/common/brand-logo";
import { ViewSkeleton } from "@/components/common/view-skeleton";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import dynamic from "next/dynamic";
import { useT } from "@/lib/i18n/store";
import { toast } from "sonner";
import { useSessionHeartbeat } from "@/hooks/use-session-heartbeat";

/* -------------------------------------------------------------------------- */
/*  Dynamic view imports — every import gets the shared ViewSkeleton so the  */
/*  chunk-download gap shows a structured placeholder instead of a blank     */
/*  flash (audit 4-d P1-5). ssr stays off as before.                         */
/* -------------------------------------------------------------------------- */

const DashboardView = dynamic(() => import("@/components/views/dashboard-view").then((m) => m.DashboardView), { ssr: false, loading: () => <ViewSkeleton /> });
const PartnersView = dynamic(() => import("@/components/views/partners-view").then((m) => m.PartnersView), { ssr: false, loading: () => <ViewSkeleton /> });
const Partner360View = dynamic(() => import("@/components/views/partner-360-view").then((m) => m.Partner360View), { ssr: false, loading: () => <ViewSkeleton /> });
const ProductsView = dynamic(() => import("@/components/views/products-view").then((m) => m.ProductsView), { ssr: false, loading: () => <ViewSkeleton /> });
const DealsView = dynamic(() => import("@/components/views/deals-view").then((m) => m.DealsView), { ssr: false, loading: () => <ViewSkeleton /> });
const OffersView = dynamic(() => import("@/components/views/offers-view").then((m) => m.OffersView), { ssr: false, loading: () => <ViewSkeleton /> });
const DemandsView = dynamic(() => import("@/components/views/demands-view").then((m) => m.DemandsView), { ssr: false, loading: () => <ViewSkeleton /> });
const DocumentsView = dynamic(() => import("@/components/views/documents-view").then((m) => m.DocumentsView), { ssr: false, loading: () => <ViewSkeleton /> });
const TasksView = dynamic(() => import("@/components/views/tasks-view").then((m) => m.TasksView), { ssr: false, loading: () => <ViewSkeleton /> });
const AuditView = dynamic(() => import("@/components/views/audit-view").then((m) => m.AuditView), { ssr: false, loading: () => <ViewSkeleton /> });
// AUDIT28 — in-house error audit surface (client JS errors + server 500s).
const ErrorAuditView = dynamic(() => import("@/components/views/error-audit-view").then((m) => m.ErrorAuditView), { ssr: false, loading: () => <ViewSkeleton /> });
const UsersView = dynamic(() => import("@/components/views/users-view").then((m) => m.UsersView), { ssr: false, loading: () => <ViewSkeleton /> });
const SettingsView = dynamic(() => import("@/components/views/settings-view").then((m) => m.SettingsView), { ssr: false, loading: () => <ViewSkeleton /> });
const InvoicesView = dynamic(() => import("@/components/views/invoices-view").then((m) => m.InvoicesView), { ssr: false, loading: () => <ViewSkeleton /> });
const ProformasView = dynamic(() => import("@/components/views/proformas-view").then((m) => m.ProformasView), { ssr: false, loading: () => <ViewSkeleton /> });
// BUILD-LOI — admin Letters of Intent view (mirrors proformas-view pattern).
// Dynamic + ssr:false so the heavy table + dialog stays out of the initial
// bundle.
const LoisView = dynamic(() => import("@/components/views/lois-view").then((m) => m.LoisView), { ssr: false, loading: () => <ViewSkeleton /> });
const DocumentRegisterView = dynamic(() => import("@/components/views/document-register-view").then((m) => m.DocumentRegisterView), { ssr: false, loading: () => <ViewSkeleton /> });
const InventoryView = dynamic(() => import("@/components/views/inventory-view").then((m) => m.InventoryView), { ssr: false, loading: () => <ViewSkeleton /> });
const SecurityView = dynamic(() => import("@/components/views/security-view").then((m) => m.SecurityView), { ssr: false, loading: () => <ViewSkeleton /> });
const VaultView = dynamic(() => import("@/components/views/vault-view").then((m) => m.VaultView), { ssr: false, loading: () => <ViewSkeleton /> });
const ApiKeysView = dynamic(() => import("@/components/views/api-keys-view").then((m) => m.ApiKeysView), { ssr: false, loading: () => <ViewSkeleton /> });
const WebhooksView = dynamic(() => import("@/components/views/webhooks-view").then((m) => m.WebhooksView), { ssr: false, loading: () => <ViewSkeleton /> });
const MailQueueView = dynamic(() => import("@/components/views/mail-queue-view").then((m) => m.MailQueueView), { ssr: false, loading: () => <ViewSkeleton /> });
const ProductCatalogView = dynamic(() => import("@/components/views/product-catalog-view").then((m) => m.ProductCatalogView), { ssr: false, loading: () => <ViewSkeleton /> });
const SupplierOffersView = dynamic(() => import("@/components/views/supplier-offers-view").then((m) => m.SupplierOffersView), { ssr: false, loading: () => <ViewSkeleton /> });
const TradeCalculatorView = dynamic(() => import("@/components/views/trade-calculator-view").then((m) => m.TradeCalculatorView), { ssr: false, loading: () => <ViewSkeleton /> });
const DocumentTemplatesView = dynamic(() => import("@/components/views/document-templates-view").then((m) => m.DocumentTemplatesView), { ssr: false, loading: () => <ViewSkeleton /> });
const QuickNotesView = dynamic(() => import("@/components/views/quick-notes-view").then((m) => m.QuickNotesView), { ssr: false, loading: () => <ViewSkeleton /> });
const WorkspaceView = dynamic(() => import("@/components/views/workspace-view").then((m) => m.WorkspaceView), { ssr: false, loading: () => <ViewSkeleton /> });
const PlansView = dynamic(() => import("@/components/views/plans-view").then((m) => m.PlansView), { ssr: false, loading: () => <ViewSkeleton /> });
const PlatformDashboardView = dynamic(() => import("@/components/views/platform-dashboard-view").then((m) => m.PlatformDashboardView), { ssr: false, loading: () => <ViewSkeleton /> });
const DocumentVerificationView = dynamic(() => import("@/components/views/document-verification-view").then((m) => m.DocumentVerificationView), { ssr: false, loading: () => <ViewSkeleton /> });
const KycReviewView = dynamic(() => import("@/components/views/kyc-review-view").then((m) => m.KycReviewView), { ssr: false, loading: () => <ViewSkeleton /> });
const PortalRfqsView = dynamic(() => import("@/components/views/portal-rfqs-view").then((m) => m.PortalRfqsView), { ssr: false, loading: () => <ViewSkeleton /> });
const CustomDashboardView = dynamic(() => import("@/components/views/custom-dashboard-view").then((m) => m.CustomDashboardView), { ssr: false, loading: () => <ViewSkeleton /> });
const CalendarView = dynamic(() => import("@/components/views/calendar-view").then((m) => m.CalendarView), { ssr: false, loading: () => <ViewSkeleton /> });
const EmailTemplatesView = dynamic(() => import("@/components/views/email-templates-view").then((m) => m.EmailTemplatesView), { ssr: false, loading: () => <ViewSkeleton /> });
const ApiIntegrationsView = dynamic(() => import("@/components/views/api-integrations-view").then((m) => m.ApiIntegrationsView), { ssr: false, loading: () => <ViewSkeleton /> });
const CommissionsView = dynamic(() => import("@/components/views/commissions-view").then((m) => m.CommissionsView), { ssr: false, loading: () => <ViewSkeleton /> });
const ErpView = dynamic(() => import("@/components/views/erp-view").then((m) => m.ErpView), { ssr: false, loading: () => <ViewSkeleton /> });
const TenantsView = dynamic(() => import("@/components/views/tenants-view").then((m) => m.TenantsView), { ssr: false, loading: () => <ViewSkeleton /> });
const SuperAdminOverviewView = dynamic(() => import("@/components/views/super-admin-overview-view").then((m) => m.SuperAdminOverviewView), { ssr: false, loading: () => <ViewSkeleton /> });
const SuperAdminSettingsView = dynamic(() => import("@/components/views/super-admin-settings-view").then((m) => m.SuperAdminSettingsView), { ssr: false, loading: () => <ViewSkeleton /> });
const FeatureFlagsView = dynamic(() => import("@/components/views/feature-flags-view").then((m) => m.FeatureFlagsView), { ssr: false, loading: () => <ViewSkeleton /> });
const PortalUploadsView = dynamic(() => import("@/components/views/portal-uploads-view").then((m) => m.PortalUploadsView), { ssr: false, loading: () => <ViewSkeleton /> });
const LogisticsRequestsView = dynamic(() => import("@/components/views/logistics-requests-view").then((m) => m.LogisticsRequestsView), { ssr: false, loading: () => <ViewSkeleton /> });
const PlanUpgradeQueueView = dynamic(() => import("@/components/views/plan-upgrade-queue-view").then((m) => m.PlanUpgradeQueueView), { ssr: false, loading: () => <ViewSkeleton /> });
const PortalLocationsView = dynamic(() => import("@/components/views/portal-locations-view").then((m) => m.PortalLocationsView), { ssr: false, loading: () => <ViewSkeleton /> });
const PlatformAuditView = dynamic(() => import("@/components/views/platform-audit-view").then((m) => m.PlatformAuditView), { ssr: false, loading: () => <ViewSkeleton /> });
const PlatformUsersView = dynamic(() => import("@/components/views/platform-users-view").then((m) => m.PlatformUsersView), { ssr: false, loading: () => <ViewSkeleton /> });
const PlatformHealthView = dynamic(() => import("@/components/views/platform-health-view").then((m) => m.PlatformHealthView), { ssr: false, loading: () => <ViewSkeleton /> });
const VerificationLogsView = dynamic(() => import("@/components/views/verification-logs-view").then((m) => m.VerificationLogsView), { ssr: false, loading: () => <ViewSkeleton /> });
const PerformanceView = dynamic(() => import("@/components/views/admin/performance-view").then((m) => m.PerformanceView), { ssr: false, loading: () => <ViewSkeleton /> });
const TradeGlobeView = dynamic(() => import("@/components/views/trade-globe-view").then((m) => m.TradeGlobeView), { ssr: false, loading: () => <ViewSkeleton /> });
const MarketplaceAdminView = dynamic(() => import("@/components/views/admin/marketplace-admin-view").then((m) => m.MarketplaceAdminView), { ssr: false, loading: () => <ViewSkeleton /> });
// FEAT-1 (Trial approval) — super-admin queue of pending_approval
// tenants. Dynamic + ssr:false so the heavy admin surface stays out of
// the initial bundle.
const SignupRequestsView = dynamic(() => import("@/components/views/signup-requests-view").then((m) => m.SignupRequestsView), { ssr: false, loading: () => <ViewSkeleton /> });
// NOTIF-UX — full-page notifications surface (Administration section).
// Dynamic + ssr:false to keep the heavy date-grouping / icon-map logic
// out of the initial bundle.
const NotificationsView = dynamic(() => import("@/components/views/notifications-view").then((m) => m.NotificationsView), { ssr: false, loading: () => <ViewSkeleton /> });

/* -------------------------------------------------------------------------- */
/*  View renderer                                                             */
/* -------------------------------------------------------------------------- */

function ViewContent({ view }: { view: string }) {
  switch (view) {
    case "dashboard":            return <DashboardView />;
    case "partners":             return <PartnersView />;
    case "partner-360":          return <Partner360View />;
    case "products":             return <ProductsView />;
    case "deals":                return <DealsView />;
    case "commissions":           return <CommissionsView />;
    case "offers":               return <OffersView />;
    case "demands":              return <DemandsView />;
    case "documents":            return <DocumentsView />;
    case "tasks":                return <TasksView />;
    case "audit":                return <AuditView />;
    case "error-audit":          return <ErrorAuditView />;
    case "users":                return <UsersView />;
    case "settings":             return <SettingsView />;
    case "invoices":             return <InvoicesView />;
    case "proformas":            return <ProformasView />;
    case "lois":                 return <LoisView />;
    case "document-register":    return <DocumentRegisterView />;
    case "inventory":            return <InventoryView />;
    case "security":             return <SecurityView />;
    case "vault":                return <VaultView />;
    case "api-keys":             return <ApiKeysView />;
    case "webhooks":             return <WebhooksView />;
    case "mail-queue":           return <MailQueueView />;
    case "product-catalog":      return <ProductCatalogView />;
    case "supplier-offers":      return <SupplierOffersView />;
    case "trade-calculator":     return <TradeCalculatorView />;
    case "document-templates":   return <DocumentTemplatesView />;
    case "platform-dashboard": return <PlatformDashboardView />;
    case "document-verification":return <DocumentVerificationView />;
    case "kyc-review":           return <KycReviewView />;
    case "portal-rfqs":          return <PortalRfqsView />;
    case "custom-dashboard":      return <CustomDashboardView />;
    case "calendar":             return <CalendarView />;
    case "email-templates":      return <EmailTemplatesView />;
    case "api-integrations":     return <ApiIntegrationsView />;
    case "erp":                  return <ErpView />;
    case "quick-notes":          return <QuickNotesView />;
    case "workspace":            return <WorkspaceView />;
    case "plans":                return <PlansView />;
    case "tenants":              return <TenantsView />;
    case "super-admin-overview": return <SuperAdminOverviewView />;
    case "super-admin-settings": return <SuperAdminSettingsView />;
    case "feature-flags":        return <FeatureFlagsView />;
    case "portal-uploads":       return <PortalUploadsView />;
    case "logistics-requests":   return <LogisticsRequestsView />;
    case "plan-upgrade-queue":   return <PlanUpgradeQueueView />;
    case "portal-locations":     return <PortalLocationsView />;
    case "platform-audit":       return <PlatformAuditView />;
    case "platform-users":       return <PlatformUsersView />;
    case "platform-health":      return <PlatformHealthView />;
    case "verification-logs":   return <VerificationLogsView />;
    case "performance":         return <PerformanceView />;
    case "trade-globe":         return <TradeGlobeView />;
    case "marketplace-admin":   return <MarketplaceAdminView />;
    case "signup-requests":     return <SignupRequestsView />;
    case "notifications":       return <NotificationsView />;
    default:                     return <DashboardView />;
  }
}

/* -------------------------------------------------------------------------- */
/*  Mobile sidebar sheet                                                      */
/* -------------------------------------------------------------------------- */

function MobileSidebar({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const t = useT();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-[85vw] max-w-[400px] p-0 bg-sidebar text-sidebar-foreground border-sidebar-border h-screen">
        {/* Visually-hidden title for accessibility */}
        <SheetTitle className="sr-only">{t("misc-navigation-sr")}</SheetTitle>
        <div className="h-full overflow-hidden">
          <Sidebar hideCollapseToggle forceExpanded />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* -------------------------------------------------------------------------- */
/*  AppShell                                                                   */
/* -------------------------------------------------------------------------- */

export function AppShell() {
  useHydrateViewState();
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);
  const t = useT();

  // P0 (session idle fix) — same heartbeat as the portal shell. Without
  // it every admin/user session hit the 30-min idle timeout 30 minutes
  // after LOGIN (no code ever called /api/auth/touch), logging people
  // out mid-work. Super-admin sessions are a no-op server-side.
  // audit25: the redirect now carries ?reason=session_expired so the
  // login form explains WHY the user was signed out (idle / absolute
  // TTL / revocation — never again "logged out for no reason"), and
  // onExpiringSoon toasts a "save your work" warning when the absolute
  // TTL is < 15 min away.
  useSessionHeartbeat({
    onExpired: () => {
      // Root renders the login form whenever no valid session exists
      // (src/app/page.tsx) — there is no dedicated /login route.
      if (typeof window !== "undefined") {
        window.location.href = "/?reason=session_expired";
      }
    },
    onExpiringSoon: ({ minutesLeft }) => {
      toast.warning(t("session-expiring-soon").replace("${minutes}", String(minutesLeft)));
    },
  });

  /* Close mobile menu when view changes */
  React.useEffect(() => {
// eslint-disable-next-line react-hooks/set-state-in-effect
    setMobileMenuOpen(false);
  }, [view]);

  /* Track previous view for transition timing */
  const [transitionKey, setTransitionKey] = React.useState(view);
  const [isTransitioning, setIsTransitioning] = React.useState(false);

  React.useEffect(() => {
    if (view !== transitionKey) {
// eslint-disable-next-line react-hooks/set-state-in-effect
      setIsTransitioning(true);
      // Brief fade-out then swap content
      const timer = setTimeout(() => {
        setTransitionKey(view);
        setIsTransitioning(false);
      }, 120);
      return () => clearTimeout(timer);
    }
  }, [view, transitionKey]);

  return (
    <div className="min-h-screen flex bg-background">
      {/* ── Desktop sidebar ── */}
      <div className="hidden lg:flex">
        <Sidebar />
      </div>

      {/* ── Mobile sidebar (sheet overlay) ── */}
      <MobileSidebar open={mobileMenuOpen} onOpenChange={setMobileMenuOpen} />

      {/* ── Main area ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* ── Impersonation banner (visible only while active) ── */}
        <SubscriptionBanner />
        <ImpersonateBanner />
        {/* ── Topbar ── */}
        <header className="h-14 sticky top-0 z-30 border-b border-border/60 glass-strong">
          <div className="h-full px-4 md:px-6 flex items-center justify-between gap-4">
            {/* Mobile hamburger */}
            <button
              type="button"
              className="lg:hidden inline-flex items-center justify-center size-9 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/60 smooth shrink-0"
              onClick={() => setMobileMenuOpen(true)}
              aria-label={t("misc-open-menu-aria")}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M3 6h14M3 10h14M3 14h14" />
              </svg>
            </button>
            <Topbar />
          </div>
        </header>

        {/* ── Main content ── */}
        <main className="flex-1 overflow-x-hidden">
          <div
            key={transitionKey}
            className={cn(
              "mx-auto w-full max-w-[1600px] px-4 sm:px-6 lg:px-8 py-6 lg:py-8",
              isTransitioning
                ? "opacity-0 translate-y-0.5"
                : "opacity-100 translate-y-0",
              "transition-[opacity,transform] duration-200 ease-out",
            )}
          >
            <ViewContent view={transitionKey} />
          </div>
        </main>

        {/* ── Sticky footer ──────────────────────────────────────────────── */}
        {/* `mt-auto` pushes the footer to the bottom of the right column. The
            right column is `flex-1` inside a `min-h-screen` row flex, so it
            stretches to viewport height — on short pages the footer sits at
            the bottom of the viewport, on long pages it scrolls naturally
            below the content. */}
        <footer className="mt-auto border-t border-border/60 bg-background/60 px-4 md:px-6 py-3 text-xs text-muted-foreground">
          <div className="mx-auto w-full max-w-[1600px] flex flex-col sm:flex-row items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <BrandLogo size={20} className="rounded-md" />
              <span className="font-semibold text-foreground tracking-tight">VELOS</span>
              <span className="text-muted-foreground/40" aria-hidden>·</span>
              <span>{t("misc-verify-trade-platform")}</span>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground/80">
              <span>© {new Date().getFullYear()} VELOS</span>
              <span className="text-muted-foreground/40" aria-hidden>·</span>
              <span>Powered by Aspidus</span>
            </div>
          </div>
        </footer>
      </div>

      {/* ── Global overlays ── */}
      <GlobalSearch />
      <KeyboardShortcuts />
    </div>
  );
}
