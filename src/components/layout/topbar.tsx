"use client";

import * as React from "react";
import { useAppStore, isAdmin, isSuperAdmin } from "@/lib/store/app-store";
import { useRealtime, disconnectRealtime } from "@/hooks/use-realtime";
import { useI18nStore } from "@/lib/i18n/store";
import { t, LOCALE_LABELS, LOCALE_FLAGS, type Locale } from "@/lib/i18n/dictionaries";
import { useThemeCustomStore, type ThemeAccent, ACCENT_MAP, ACCENT_LABELS } from "@/lib/store/theme-store";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import {
  LogOut,
  ChevronDown,
  Settings,
  ShieldCheck,
  ExternalLink,
  Search,
  Bell,
  PanelRight,
  Globe,
  Palette,
  Sun,
  Moon,
  Check,
  CheckCheck,
  Clock,
  Package,
  FileText,
  AlertTriangle,
  Info,
  Building2,
  Repeat,
  BookOpen,
} from "lucide-react";
import { toast } from "sonner";
import { initials } from "@/lib/utils/format";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { TenantContextSwitcher } from "@/components/layout/tenant-context-switcher";
import { useSearchStore } from "@/components/layout/global-search";
import { useTheme } from "next-themes";
import { fmtRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

// View-id → NAV dict key is 1:1 for every entry below; "security-center" is
// the one exception (view id is "security", NAV key is also "security" —
// kept here only for the cases where the view id itself isn't a NAV key).
const VIEW_TITLE_FALLBACK = "CRM";

// Mock notifications for real-time demo
interface NotifItem {
  id: string;
  title: string;
  message: string;
  type: string;
  read: boolean;
  created_at: string;
  entity_type?: string | null;
}

export function Topbar() {
  const { user, setUser, view, setView, setAppMode } = useAppStore();
  const locale = useI18nStore((s) => s.locale);
  const setLocale = useI18nStore((s) => s.setLocale);
  const themeConfig = useThemeCustomStore((s) => s.config);
  const setThemeConfig = useThemeCustomStore((s) => s.setConfig);
  const { resolvedTheme, setTheme } = useTheme();
  const searchOpen = useSearchStore((s) => s.open);
  const admin = isAdmin(user);
  const superAdmin = isSuperAdmin(user);

  // Real-time notifications state
  const [notifications, setNotifications] = React.useState<NotifItem[]>([]);
  const [unreadTotal, setUnreadTotal] = React.useState(0);
  const [notifOpen, setNotifOpen] = React.useState(false);
  // D-4: brief pulse on the bell when a new notification arrives via WS.
  // Cleared after ~1.2s by the timeout in `flashBell`.
  const [bellPulse, setBellPulse] = React.useState(false);
  const pulseTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadNotifications = React.useCallback(() => {
    if (!user) return;
    fetch("/api/notifications?unreadOnly=true")
      .then((r) => r.json())
      .then((data) => {
        // API returns { items, unread_count } — handle both shapes defensively
        const items = Array.isArray(data) ? data : (data?.items ?? []);
        setNotifications(items.slice(0, 10));
        setUnreadTotal(typeof data?.unread_count === "number" ? data.unread_count : items.length);
      })
      .catch(() => {});
  }, [user]);

  // Load once on mount / user change. The 30-second polling that previously
  // lived here has been replaced by the WebSocket subscription below — the
  // initial fetch is kept so a freshly-loaded tab shows the user's existing
  // unread notifications without waiting for the next WS event.
  React.useEffect(() => {
    loadNotifications();
  }, [loadNotifications]);

  // ── D-4: WebSocket real-time subscription ────────────────────────────────
  // Replaces the 30s polling. Handlers are recreated on every render (cheap)
  // but the hook internally keeps the socket subscription stable across
  // renders via a ref (see `src/hooks/use-realtime.ts`).
  const flashBell = React.useCallback(() => {
    setBellPulse(true);
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    pulseTimer.current = setTimeout(() => setBellPulse(false), 1_200);
  }, []);

  useRealtime({
    "message:new": React.useCallback((data: any) => {
      // Admin-sent message to portal — admin bell doesn't show portal
      // notifications, but we flash the bell anyway so the admin gets
      // visual confirmation that the send landed.
      flashBell();
      toast.message("Message sent", {
        description: data?.preview ? String(data.preview).slice(0, 80) : undefined,
      });
    }, [flashBell]),

    "offer:updated": React.useCallback((data: any) => {
      // A status change on any offer in this tenant — flash + toast.
      setUnreadTotal((c) => c + 1);
      setNotifications((prev) => [{
        id: `rt:offer:${data?.offerId ?? ""}:${Date.now()}`,
        title: `Offer ${data?.offerNumber || ""} → ${data?.newStatus || "updated"}`,
        message: data?.offerNumber
          ? `Status changed from ${data?.oldStatus || "—"} to ${data?.newStatus || "—"}.`
          : "Offer status updated.",
        type: `offer_${data?.newStatus || "updated"}`,
        read: false,
        created_at: new Date().toISOString(),
        entity_type: "offer",
      }, ...prev].slice(0, 10));
      flashBell();
      const isNewAccepted = String(data?.newStatus || "").toLowerCase() === "accepted";
      const isNewRejected = String(data?.newStatus || "").toLowerCase() === "rejected";
      if (isNewAccepted) {
        toast.success(`Offer ${data?.offerNumber || ""} accepted`);
      } else if (isNewRejected) {
        toast.error(`Offer ${data?.offerNumber || ""} ${data?.newStatus}`);
      } else {
        toast.message(`Offer ${data?.offerNumber || ""} → ${data?.newStatus || "updated"}`);
      }
    }, [flashBell]),

    "invoice:paid": React.useCallback((data: any) => {
      // A payment was recorded against an invoice in this tenant.
      setUnreadTotal((c) => c + 1);
      setNotifications((prev) => [{
        id: `rt:invoice:${data?.invoiceId ?? ""}:${Date.now()}`,
        title: data?.isFullPayment
          ? `Invoice ${data?.invoiceNumber || ""} paid`
          : `Partial payment on ${data?.invoiceNumber || ""}`,
        message: data?.invoiceNumber
          ? `${data?.isFullPayment ? "Paid in full" : "Partial payment"} — ${data?.method || ""}${data?.reference ? ` (ref: ${data.reference})` : ""}.`
          : "Payment recorded.",
        type: data?.isFullPayment ? "invoice_paid" : "invoice_partial",
        read: false,
        created_at: new Date().toISOString(),
        entity_type: "invoice",
      }, ...prev].slice(0, 10));
      flashBell();
      toast.success(
        data?.isFullPayment
          ? `Invoice ${data?.invoiceNumber || ""} paid`
          : `Partial payment recorded`,
        { description: data?.method ? `via ${data.method}` : undefined }
      );
    }, [flashBell]),

    "portal:activity": React.useCallback((data: any) => {
      // Something happened on the portal side (RFQ submitted, etc.).
      setUnreadTotal((c) => c + 1);
      const label =
        data?.type === "rfq" ? `New RFQ: ${data?.productName || "product"}` :
        data?.type === "portal_message" ? "Portal message" :
        "Portal activity";
      setNotifications((prev) => [{
        id: `rt:portal:${data?.type ?? ""}:${data?.rfqId ?? ""}:${Date.now()}`,
        title: label,
        message: data?.partnerName ? `From ${data.partnerName}.` : "",
        type: `portal_${data?.type || "activity"}`,
        read: false,
        created_at: new Date().toISOString(),
        entity_type: data?.type === "rfq" ? "portal_rfq" : "portal_access",
      }, ...prev].slice(0, 10));
      flashBell();
      toast.message(label, {
        description: data?.partnerName ? `From ${data.partnerName}` : undefined,
      });
    }, [flashBell]),
  },
  // P0 / task D-FIX: when the WebSocket gateway (mini-services/notifications-service)
  // is not deployed, the useRealtime hook falls back to 30s polling. Passing
  // `loadNotifications` here means the polling tick re-fetches /api/notifications
  // (same path the initial-mount load uses), so the bell stays fresh even
  // without the live WS push. When the mini-service IS deployed, the socket
  // connects, polling clears, and the live WS handlers take over.
  loadNotifications,
);

  // Cleanup the pulse timer on unmount.
  React.useEffect(() => () => {
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
  }, []);

  const unreadCount = unreadTotal;

  const markAllRead = async () => {
    try {
      const res = await fetch("/api/notifications?markAllRead=true", { method: "PUT" });
      if (res.ok) {
        setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
        setUnreadTotal(0);
        toast.success("All notifications marked as read");
      }
    } catch {
      // silently fail
    }
  };

  function handleNotifClick(n: NotifItem) {
    setNotifications((prev) => prev.map((item) => item.id === n.id ? { ...item, read: true } : item));
    if (!n.read) setUnreadTotal((c) => Math.max(0, c - 1));
    fetch(`/api/notifications/${n.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: true }),
    }).catch(() => {});
    if (n.entity_type) {
      const viewMap: Record<string, string> = {
        offer: "offers", invoice: "invoices", proforma: "proformas",
        kyc_submission: "kyc-review", deal: "deals", task: "tasks",
        portal_rfq: "portal-rfqs", document: "documents",
        portal_access: "portal-rfqs", partner: "partners", product: "products",
      };
      const targetView = viewMap[n.entity_type];
      if (targetView) setView(targetView as any);
    }
    setNotifOpen(false);
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    // D-4: tear down the WebSocket so a logged-out tab doesn't keep an open
    // connection under a stale identity. The next login will reconnect with
    // the new user's rooms.
    disconnectRealtime();
    setUser(null);
    setView("dashboard");
    useI18nStore.getState().reset();
    toast.success("Signed out.");
  }

  function openPortal() {
    setAppMode("portal");
  }

  const translatedViewTitle = t(locale, view);
  const viewTitle = translatedViewTitle === view ? VIEW_TITLE_FALLBACK : translatedViewTitle;

  return (
    <>
      {/* ── Left: Breadcrumb-style view title ── */}
      <div className="min-w-0 flex-1 flex items-center gap-2.5">
        {/* Breadcrumb prefix — desktop only; on mobile the view title alone
            is enough context and every pixel of width matters. */}
        <div className="hidden sm:flex items-center gap-1.5 text-muted-foreground/60 text-xs font-medium tracking-wide uppercase shrink-0">
          <PanelRight className="size-3.5" />
          <span>VELOS</span>
          <span className="text-muted-foreground/30">/</span>
        </div>
        <h2 className="text-[15px] font-semibold tracking-tight text-foreground truncate smooth min-w-0 shrink">
          {viewTitle}
        </h2>

        {/* Tenant Context Switcher — shrinks to icon-only on mobile */}
        <div className="min-w-0 shrink-0">
          <TenantContextSwitcher />
        </div>
      </div>

      {/* ── Right: Action cluster ── */}
      <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
        {/* Search — opens command palette */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => searchOpen()}
              aria-label={t(locale, "search")}
              className="size-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 smooth"
            >
              <Search className="size-4" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {t(locale, "search")} <kbd className="ml-1 text-xs bg-muted px-1 py-0.5 rounded">⌘K</kbd>
          </TooltipContent>
        </Tooltip>

        {/* Real-time Notifications */}
        <Popover open={notifOpen} onOpenChange={setNotifOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={
                unreadCount > 0
                  ? `${t(locale, "notifications")} — ${unreadCount} unread`
                  : t(locale, "notifications")
              }
              className={cn(
                "relative size-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 smooth",
                bellPulse && "animate-pulse",
              )}
            >
              <Bell className="size-4" aria-hidden="true" />
              {/* D-4: brief ping ring when a new WS notification arrives.
                  Renders ABOVE the unread-count badge so the two don't
                  collide visually. */}
              {bellPulse && (
                <span className="absolute inset-0 rounded-lg ring-2 ring-emerald-500/70 animate-ping" aria-hidden />
              )}
              {unreadCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-emerald-500 text-white text-[9px] font-semibold leading-none ring-2 ring-background" aria-hidden="true">
                  {unreadCount}
                </span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={8}
            style={{ maxHeight: "min(80vh, var(--radix-popover-content-available-height, 80vh))" }}
            className="w-[min(92vw,380px)] p-0 rounded-xl border border-border/60 shadow-soft-lg flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border/60 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <h3 className="text-sm font-semibold truncate">{t(locale, "notifications")}</h3>
                {unreadCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-xs font-semibold tabular">
                    {unreadCount}
                  </span>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                disabled={unreadCount === 0}
                onClick={markAllRead}
              >
                <CheckCheck className="size-3.5 mr-1" />
                {t(locale, "mark-all-read")}
              </Button>
            </div>

            {/* Body — flexes to fill whatever space remains between the
                header and footer, so the footer ("View all") always stays
                visible and clickable instead of being pushed off-screen.
                Plain overflow-y-auto instead of the Radix ScrollArea — its
                Viewport doesn't reliably inherit a flex-computed height
                (measured: Viewport grew to full list content height and
                spilled past the popover boundary instead of scrolling). */}
            <div className="flex-1 min-h-0 overflow-y-auto custom-scroll">
              {notifications.length === 0 ? (
                <div className="py-12 px-4 flex flex-col items-center text-center">
                  <div className="size-10 rounded-full bg-muted/60 flex items-center justify-center mb-2">
                    <Bell className="size-5 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium">{t(locale, "no-notifications")}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t(locale, "all-caught-up")}</p>
                </div>
              ) : (
                <ul className="divide-y divide-border/50">
                  {notifications.map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => handleNotifClick(n)}
                        className={cn(
                          "w-full text-left px-4 py-3 flex items-start gap-3 smooth relative group",
                          !n.read && "bg-accent/30",
                          "hover:bg-accent/50 focus-visible:bg-accent/50",
                        )}
                      >
                        {!n.read && (
                          <span className="absolute left-1.5 top-1/2 -translate-y-1/2 size-1.5 rounded-full bg-emerald-500" />
                        )}
                        <div className={cn(
                          "size-8 shrink-0 rounded-full bg-muted/60 flex items-center justify-center",
                          n.type.includes("overdue") || n.type.includes("rejected") ? "text-destructive" :
                          n.type.includes("accepted") || n.type.includes("won") || n.type.includes("paid") ? "text-emerald-600 dark:text-emerald-400" :
                          "text-muted-foreground"
                        )}>
                          {n.type.includes("overdue") || n.type.includes("rejected") ? <AlertTriangle className="size-4" /> :
                           n.type.includes("accepted") || n.type.includes("won") || n.type.includes("paid") ? <Check className="size-4" /> :
                           n.type.includes("kyc") ? <ShieldCheck className="size-4" /> :
                           n.type.includes("offer") ? <FileText className="size-4" /> :
                           n.type.includes("task") ? <Clock className="size-4" /> :
                           n.type.includes("stock") ? <Package className="size-4" /> :
                           <Info className="size-4" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2">
                            <p className={cn("text-sm truncate", n.read ? "font-medium" : "font-semibold")}>
                              {n.title}
                            </p>
                            <span className="text-xs text-muted-foreground ml-auto shrink-0 tabular">
                              {fmtRelative(n.created_at)}
                            </span>
                          </div>
                          {n.message && (
                            <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{n.message}</p>
                          )}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <Separator className="shrink-0" />
            <div className="p-2 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-center text-xs text-muted-foreground hover:text-foreground"
                // FEAT-2 / Issue 1: "View all" used to route to the
                // SECURITY center — there's nothing there that shows a
                // notifications history. Route to the audit log instead,
                // which IS the historical view of everything that ever
                // fired a notification (and more). Super_admins get the
                // cross-tenant platform audit; tenant admins get their
                // own tenant's audit log.
                onClick={() => { setView(superAdmin ? "platform-audit" : "audit"); setNotifOpen(false); }}
              >
                {t(locale, "view-all")}
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        {/* Language Switcher */}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t(locale, "switch-language")}
                  className="size-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 smooth"
                >
                  <Globe className="size-4" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {t(locale, "switch-language")}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-44 rounded-xl p-1.5 shadow-soft-lg border-border/50">
            {(Object.keys(LOCALE_LABELS) as Locale[]).map((loc) => (
              <DropdownMenuItem
                key={loc}
                onClick={() => setLocale(loc)}
                className={cn("cursor-pointer rounded-lg px-3 py-2 text-sm smooth", locale === loc && "bg-accent/50")}
              >
                <span className="mr-2">{LOCALE_FLAGS[loc]}</span>
                {LOCALE_LABELS[loc]}
                {locale === loc && <Check className="size-3.5 ml-auto text-primary" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Theme Customization */}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t(locale, "theme-customize")}
                  className="size-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 smooth"
                >
                  <Palette className="size-4" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {t(locale, "theme-customize")}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-52 rounded-xl p-1.5 shadow-soft-lg border-border/50">
            <DropdownMenuLabel className="text-xs font-medium text-muted-foreground px-3 py-2">
              {t(locale, "theme-mode")}
            </DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => setTheme("light")}
              className={cn("cursor-pointer rounded-lg px-3 py-2 text-sm smooth", resolvedTheme === "light" && "bg-accent/50")}
            >
              <Sun className="size-4 mr-2" />
              {t(locale, "theme-light")}
              {resolvedTheme === "light" && <Check className="size-3.5 ml-auto text-primary" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setTheme("dark")}
              className={cn("cursor-pointer rounded-lg px-3 py-2 text-sm smooth", resolvedTheme === "dark" && "bg-accent/50")}
            >
              <Moon className="size-4 mr-2" />
              {t(locale, "theme-dark")}
              {resolvedTheme === "dark" && <Check className="size-3.5 ml-auto text-primary" />}
            </DropdownMenuItem>

            <DropdownMenuSeparator className="my-1 bg-border/50" />

            <DropdownMenuLabel className="text-xs font-medium text-muted-foreground px-3 py-2">
              {t(locale, "theme-accent-color")}
            </DropdownMenuLabel>
            {(Object.keys(ACCENT_MAP) as ThemeAccent[]).map((accent) => {
              const colors = ACCENT_MAP[accent];
              return (
                <DropdownMenuItem
                  key={accent}
                  onClick={() => setThemeConfig({ accent })}
                  className={cn("cursor-pointer rounded-lg px-3 py-2 text-sm smooth", themeConfig.accent === accent && "bg-accent/50")}
                >
                  <div
                    className="size-4 rounded-full mr-2 ring-1 ring-border/50"
                    style={{ background: colors.light }}
                  />
                  {ACCENT_LABELS[accent]}
                  {themeConfig.accent === accent && <Check className="size-3.5 ml-auto text-primary" />}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Divider */}
        <div className="mx-1 h-5 w-px bg-border/50 hidden sm:block" />

        {/* Portal switch */}
        <Button
          variant="ghost"
          size="sm"
          onClick={openPortal}
          className="hidden sm:flex h-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 smooth gap-1.5 px-2.5"
        >
          <ExternalLink className="size-3.5" />
          <span className="text-xs font-medium">{t(locale, "portal")}</span>
        </Button>

        {/* Role badge */}
        {user && (
          <Badge
            variant="outline"
            className="hidden md:inline-flex capitalize gap-1 h-7 px-2 rounded-md border-border/50 text-xs font-medium text-muted-foreground smooth"
          >
            {admin ? <ShieldCheck className="size-3 text-primary" /> : null}
            <span>{admin ? "Admin" : user.role}</span>
          </Badge>
        )}

        {/* Divider */}
        <div className="mx-1 h-5 w-px bg-border/50 hidden md:block" />

        {/* User dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-muted/50 smooth outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-1"
            >
              <Avatar className="size-7 ring-1 ring-border/60 smooth">
                <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold smooth">
                  {initials(user?.full_name || user?.username)}
                </AvatarFallback>
              </Avatar>
              <div className="hidden lg:flex flex-col items-start leading-none">
                <span className="text-[13px] font-medium text-foreground truncate max-w-[110px]">
                  {user?.full_name || user?.username}
                </span>
                <span className="text-xs text-muted-foreground truncate max-w-[110px]">
                  {user?.email}
                </span>
              </div>
              <ChevronDown className="size-3 text-muted-foreground/60 hidden lg:block smooth" />
            </button>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            align="end"
            className="w-60 rounded-xl p-1.5 shadow-soft border-border/50 glass-strong"
            sideOffset={8}
          >
            {/* User info header */}
            <DropdownMenuLabel className="font-normal p-3 rounded-lg">
              <div className="flex items-center gap-3">
                <Avatar className="size-9 ring-1 ring-border/60">
                  <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
                    {initials(user?.full_name || user?.username)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex flex-col space-y-0.5 min-w-0">
                  <p className="text-sm font-semibold truncate">
                    {user?.full_name || user?.username}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {user?.email}
                  </p>
                  <Badge
                    variant="secondary"
                    className="w-fit mt-1 capitalize text-xs h-5 px-1.5 rounded-md font-medium"
                  >
                    {admin ? (
                      <ShieldCheck className="size-2.5 mr-0.5 text-primary" />
                    ) : null}
                    {user?.role}
                  </Badge>
                </div>
              </div>
            </DropdownMenuLabel>

            <DropdownMenuSeparator className="my-1 bg-border/50" />

            <DropdownMenuItem
              onClick={() => setView("settings")}
              className="cursor-pointer rounded-lg mx-0.5 px-3 py-2 text-sm smooth"
            >
              <Settings className="size-4 mr-2.5 text-muted-foreground" />
              {t(locale, "settings")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setView("security")}
              className="cursor-pointer rounded-lg mx-0.5 px-3 py-2 text-sm smooth"
            >
              <ShieldCheck className="size-4 mr-2.5 text-muted-foreground" />
              {t(locale, "security")}
            </DropdownMenuItem>

            {/* API Docs — SUPER-ADMIN only.
                This is the only entry point in the SPA to the /api-docs
                route (a separate Next.js page that renders Swagger UI). The
                link opens in a new tab because the docs page replaces the
                SPA — closing the tab returns the user to where they were.
                The /api-docs page itself re-checks the session and refuses
                non-super-admins, AND the /api/openapi-json endpoint is
                server-side auth-gated to super_admin — so the visibility
                here is just UX, but we restrict it to super_admin so
                tenant admins (including trial tenants whose `isAdmin()`
                returns true) don't get a dangling link to a page they'll
                be denied on. */}
            {superAdmin && (
              <DropdownMenuItem
                asChild
                className="cursor-pointer rounded-lg mx-0.5 px-3 py-2 text-sm smooth"
              >
                <a href="/api-docs" target="_blank" rel="noopener noreferrer">
                  <BookOpen className="size-4 mr-2.5 text-muted-foreground" />
                  API Documentation
                  <ExternalLink className="size-3 ml-auto text-muted-foreground/60" />
                </a>
              </DropdownMenuItem>
            )}

            <DropdownMenuSeparator className="my-1 bg-border/50" />

            <DropdownMenuItem
              onClick={logout}
              className="cursor-pointer rounded-lg mx-0.5 px-3 py-2 text-sm text-destructive focus:text-destructive focus:bg-destructive/10 smooth"
            >
              <LogOut className="size-4 mr-2.5" />
              {t(locale, "sign-out")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}
