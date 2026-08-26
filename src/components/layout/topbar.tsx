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
  BellOff,
  PanelRight,
  Globe,
  Palette,
  Sun,
  Moon,
  Check,
  CheckCheck,
  Building2,
  BookOpen,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { initials } from "@/lib/utils/format";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { TenantContextSwitcher } from "@/components/layout/tenant-context-switcher";
import { useSearchStore } from "@/components/layout/global-search";
import { useTheme } from "next-themes";
import { fmtRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
// NOTIF-UX — reuse the icon + colour helpers from the full-page view so the
// bell dropdown and the Notifications page render the same icon for a given
// type (one source of truth for the icon + colour map).
import { getNotifIcon, getNotifColor } from "@/components/views/notifications-view";

// View-id → NAV dict key is 1:1 for every entry below; "security-center" is
// the one exception (view id is "security", NAV key is also "security" —
// kept here only for the cases where the view id itself isn't a NAV key).
const VIEW_TITLE_FALLBACK = "CRM";

// ── REALTIME-WS: subtle "ding" on new notifications ─────────────────────────
// Generates a 150ms 880Hz sine-wave "ding" as a WAV file at module load and
// reuses the Audio element for each subsequent notification. The sound is
// only played when the tab is visible (`document.hidden` is false) and when
// browser autoplay policy allows it — failures are silently swallowed so
// the bell UX never breaks because of audio.
//
// Why a generated WAV data URL instead of a static asset?
//   • No additional file in /public (zero bundle impact for users who
//     never receive a notification).
//   • No network request on first play (the data URL is inline).
//   • Volume + envelope are tuned for "subtle office-friendly ping" rather
//     than a loud alert — 8-bit PCM at 8kHz mono, ~1.2KB total.
const NOTIF_LIST_LIMIT = 20; // REALTIME-WS: 10 → 20 — the dropdown scrolls now

let _dingAudio: HTMLAudioElement | null = null;
function makeDingWavDataUrl(): string {
  // 8-bit unsigned PCM, 8kHz mono, 150ms 880Hz sine with exp decay envelope.
  const sampleRate = 8000;
  const duration = 0.15;
  const freq = 880;
  const n = Math.floor(sampleRate * duration);
  const bytes = new Uint8Array(44 + n);
  const writeU32 = (off: number, val: number) => {
    bytes[off] = val & 0xff;
    bytes[off + 1] = (val >> 8) & 0xff;
    bytes[off + 2] = (val >> 16) & 0xff;
    bytes[off + 3] = (val >> 24) & 0xff;
  };
  const writeU16 = (off: number, val: number) => {
    bytes[off] = val & 0xff;
    bytes[off + 1] = (val >> 8) & 0xff;
  };
  // RIFF chunk
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  writeU32(4, 36 + n);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  // fmt sub-chunk
  bytes.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  writeU32(16, 16);
  writeU16(20, 1); // PCM
  writeU16(22, 1); // mono
  writeU32(24, sampleRate);
  writeU32(28, sampleRate); // byte rate = sample rate * channels * bits/8
  writeU16(32, 1); // block align
  writeU16(34, 8); // bits per sample
  // data sub-chunk
  bytes.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  writeU32(40, n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t * 15); // ~150ms decay
    const s = Math.sin(2 * Math.PI * freq * t);
    bytes[44 + i] = 128 + Math.round(s * env * 60);
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${typeof btoa !== "undefined" ? btoa(bin) : ""}`;
}
function getDingAudio(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (_dingAudio) return _dingAudio;
  try {
    const audio = new Audio(makeDingWavDataUrl());
    audio.preload = "auto";
    audio.volume = 0.5; // quiet — subtle ping, not a klaxon
    _dingAudio = audio;
    return audio;
  } catch {
    return null;
  }
}
function playDing(): void {
  // Skip if the tab is hidden — no point pinging a backgrounded tab.
  if (typeof document !== "undefined" && document.hidden) return;
  const audio = getDingAudio();
  if (!audio) return;
  try {
    audio.currentTime = 0;
    // The Promise from play() rejects when the browser blocks autoplay
    // (e.g. the user hasn't interacted with the page yet). We swallow the
    // rejection — the bell still flashes and the toast still shows.
    void audio.play().catch(() => {});
  } catch {
    // AudioContext not available / failed — non-critical.
  }
}

// Mock notifications for real-time demo
interface NotifItem {
  id: string;
  title: string;
  message: string;
  type: string;
  read: boolean;
  created_at: string;
  entity_type?: string | null;
  // NOTIF-UX — `entity_id` carries the related row's PK so a click can deep
  // link to the specific offer / invoice / etc. The full-page view uses the
  // same shape. WS-driven preview rows set it from the payload (`offerId`,
  // `invoiceId`, `rfqId`).
  entity_id?: string | null;
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
        // API returns { items, unread_count } — handle both shapes defensively.
        // REALTIME-WS: 10 → 20 — the dropdown panel now scrolls so we can
        // surface more history without forcing the user to the full page.
        const items = Array.isArray(data) ? data : (data?.items ?? []);
        setNotifications(items.slice(0, NOTIF_LIST_LIMIT));
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
  // REALTIME-WS: flashBell ALSO plays a subtle "ding" — but only when the
  // tab is visible and the browser allows it (see playDing above).
  const flashBell = React.useCallback(() => {
    setBellPulse(true);
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    pulseTimer.current = setTimeout(() => setBellPulse(false), 1_200);
    playDing();
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
        entity_id: data?.offerId ?? null,
      }, ...prev].slice(0, NOTIF_LIST_LIMIT));
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
        entity_id: data?.invoiceId ?? null,
      }, ...prev].slice(0, NOTIF_LIST_LIMIT));
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
        entity_id: data?.rfqId ?? null,
      }, ...prev].slice(0, NOTIF_LIST_LIMIT));
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
      // NOTIF-UX — no body + ?markAllRead=true keeps the original contract
      // (the server route now treats "no body OR no body.id" as mark-all).
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

  // NOTIF-UX — per-item "Mark as read" — marks a single notification as
  // read WITHOUT navigating away (the row click still navigates; this is
  // for the user who wants to clear the unread badge without losing the
  // dropdown). The button is `e.stopPropagation`-guarded so it doesn't
  // double-fire the row's click handler.
  function markOneRead(e: React.MouseEvent, n: NotifItem) {
    e.stopPropagation();
    if (n.read) return;
    setNotifications((prev) => prev.map((item) => item.id === n.id ? { ...item, read: true } : item));
    setUnreadTotal((c) => Math.max(0, c - 1));
    fetch(`/api/notifications/${n.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: true }),
    }).catch(() => {});
  }

  // NOTIF-UX — per-item "Delete". Optimistically removes the row from the
  // dropdown state, then fires the DELETE. On failure we re-fetch to
  // restore the truth (the bell is a glance surface, not a deep edit
  // surface, so the optimistic update is the right tradeoff).
  function deleteOne(e: React.MouseEvent, n: NotifItem) {
    e.stopPropagation();
    const wasUnread = !n.read;
    setNotifications((prev) => prev.filter((item) => item.id !== n.id));
    if (wasUnread) setUnreadTotal((c) => Math.max(0, c - 1));
    fetch(`/api/notifications/${n.id}`, { method: "DELETE" })
      .then((r) => {
        if (!r.ok) throw new Error("delete failed");
      })
      .catch(() => {
        // Restore on failure — re-fetch from the source of truth.
        loadNotifications();
        toast.error("Failed to delete notification.");
      });
  }

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
        marketplace_post: "portal-marketplace",
        marketplace_response: "portal-marketplace",
      };
      const targetView = viewMap[n.entity_type];
      if (targetView) setView(targetView as any);
    }
    setNotifOpen(false);
  }

  async function logout() {
    // CRITICAL: credentials: 'include' ensures the browser processes
    // the Set-Cookie: crm_session=; Max-Age=0 header in the response.
    // Without explicit credentials, some browsers don't process
    // Set-Cookie from fetch() responses (same-origin default varies).
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    // connection under a stale identity. The next login will reconnect with
    // the new user's rooms.
    disconnectRealtime();
    setUser(null);
    setView("dashboard");
    useI18nStore.getState().reset();
    toast.success("Signed out.");
    // CRITICAL FIX: force a full page reload so the browser processes the
    // Set-Cookie: crm_session=; Max-Age=0 header from the logout response.
    // Without this, the Zustand store may clear (user: null) but the browser
    // still has the cookie → on refresh, auth/me finds the stale cookie →
    // user is "re-logged in". A full navigation guarantees the cookie is
    // gone before the next page load.
    window.location.href = "/";
  }

  function openPortal() {
    setAppMode("portal");
  }

  const translatedViewTitle = t(locale, view);
  const viewTitle = translatedViewTitle === view ? VIEW_TITLE_FALLBACK : translatedViewTitle;

  // NOTIF-UX — group the dropdown list by date (Today / Yesterday / Earlier).
  // Mirrors the full-page Notifications view's grouping so the bell dropdown
  // and the page read as the same surface at different granularities. The
  // grouping is computed with useMemo keyed on `notifications` so the WS
  // preview rows (which arrive as `prev → new array`) re-group without a
  // full re-render of unrelated rows.
  const notifGroups = React.useMemo(() => {
    type G = { label: string; items: NotifItem[] };
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const today: NotifItem[] = [];
    const yesterday: NotifItem[] = [];
    const earlier: NotifItem[] = [];
    for (const n of notifications) {
      const d = new Date(n.created_at);
      if (d >= todayStart) today.push(n);
      else if (d >= yesterdayStart) yesterday.push(n);
      else earlier.push(n);
    }
    const groups: G[] = [];
    if (today.length) groups.push({ label: t(locale, "misc-today"), items: today });
    if (yesterday.length) groups.push({ label: t(locale, "notif-yesterday"), items: yesterday });
    if (earlier.length) groups.push({ label: t(locale, "notif-earlier"), items: earlier });
    return groups;
  }, [notifications, locale]);

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
                /* NOTIF-UX — red circle with count, pulses when new arrives.
                   The previous emerald badge blended into the platform's
                   green accent; switching to destructive (red) matches the
                   standard "unread notifications" convention (Gmail, Slack,
                   Linear) and makes the badge visible at a glance even when
                   the bell icon is monochrome. */
                <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-destructive text-destructive-foreground text-[9px] font-semibold leading-none ring-2 ring-background tabular-nums animate-pulse" aria-hidden="true">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={8}
            style={{ maxHeight: "min(70vh, var(--radix-popover-content-available-height, 70vh))" }}
            className="w-[min(92vw,380px)] p-0 rounded-xl border border-border/60 shadow-soft-lg flex flex-col overflow-hidden max-h-[70vh]"
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border/60 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <h3 className="text-sm font-semibold truncate">{t(locale, "notifications")}</h3>
                {unreadCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-destructive/15 text-destructive text-xs font-semibold tabular">
                    {unreadCount > 99 ? "99+" : unreadCount}
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
                header and footer, so the footer always stays visible and
                clickable instead of being pushed off-screen. Plain
                overflow-y-auto instead of the Radix ScrollArea — its
                Viewport doesn't reliably inherit a flex-computed height
                (measured: Viewport grew to full list content height and
                spilled past the popover boundary instead of scrolling).
                NOTIF-UX: now showing 20 items (was 10) and grouping them
                by date (Today / Yesterday / Earlier) so the user can scan
                the recent batch without re-reading yesterday's noise. */}
            <div className="flex-1 min-h-0 overflow-y-auto custom-scroll">
              {notifications.length === 0 ? (
                <div className="py-12 px-4 flex flex-col items-center text-center">
                  {/* NOTIF-UX: empty state uses BellOff to clearly signal
                      "no NEW notifications" — distinct from the bell icon
                      in the header (which always shows). The wording is the
                      more specific "No new notifications" rather than the
                      generic "No notifications" so the user understands
                      they may still have read history on the full page. */}
                  <div className="size-10 rounded-full bg-muted/60 flex items-center justify-center mb-2">
                    <BellOff className="size-5 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium">{t(locale, "notif-no-new")}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t(locale, "all-caught-up")}</p>
                </div>
              ) : (
                <div>
                  {notifGroups.map((g) => (
                    <div key={g.label}>
                      {/* Sticky date header — sits above each bucket. */}
                      <div className="sticky top-0 z-10 bg-muted/40 backdrop-blur-sm px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {g.label}
                      </div>
                      <ul className="divide-y divide-border/50">
                        {g.items.map((n) => {
                          const Icon = getNotifIcon(n.type);
                          const color = getNotifColor(n.type);
                          return (
                          <li key={n.id}>
                            {/* NOTIF-UX: row is a div (not a button) so the
                                per-item "Mark as read" + "Delete" buttons
                                can sit inside without producing
                                nested-button HTML. The div keeps the
                                click-through behavior via role + onClick
                                + keyboard handlers (Enter / Space). */}
                            <div
                              role="button"
                              tabIndex={0}
                              onClick={() => handleNotifClick(n)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  handleNotifClick(n);
                                }
                              }}
                              className={cn(
                                "w-full text-left px-4 py-3 flex items-start gap-3 smooth relative group cursor-pointer",
                                !n.read && "bg-accent/30",
                                "hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none",
                              )}
                            >
                              {!n.read && (
                                <span className="absolute left-1.5 top-1/2 -translate-y-1/2 size-1.5 rounded-full bg-emerald-500" />
                              )}
                              {/* NOTIF-UX — icon + colour come from the
                                  shared helpers in notifications-view so
                                  the bell dropdown and the full page
                                  render identical visuals for a given type.
                                  Each type has a distinct icon + Tailwind
                                  colour pair (e.g. offer_accepted → emerald
                                  check, invoice_overdue → red alert). */}
                              <div className={cn(
                                "size-8 shrink-0 rounded-full flex items-center justify-center",
                                color,
                              )}>
                                <Icon className="size-4" />
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
                              {/* NOTIF-UX — per-item actions, hover-revealed.
                                  Mark-as-read (Check) only on unread rows;
                                  Delete (Trash2) on every row. Both
                                  stopPropagation so they don't double-fire
                                  the row's click handler. */}
                              {!n.read && (
                                <button
                                  type="button"
                                  onClick={(e) => markOneRead(e, n)}
                                  aria-label={t(locale, "notif-mark-read")}
                                  className="size-7 shrink-0 rounded-md flex items-center justify-center text-muted-foreground/70 hover:text-emerald-600 hover:bg-emerald-500/10 smooth opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
                                >
                                  <Check className="size-3.5" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={(e) => deleteOne(e, n)}
                                aria-label={t(locale, "notif-delete")}
                                className="size-7 shrink-0 rounded-md flex items-center justify-center text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10 smooth opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
                              >
                                <Trash2 className="size-3.5" />
                              </button>
                            </div>
                          </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Separator className="shrink-0" />
            {/* NOTIF-UX — footer with "Mark all as read" + "View all
                notifications". The "View all" now routes to the dedicated
                full-page Notifications view (Administration section) rather
                than the audit log — that page is purpose-built for browsing
                the full history with filters + search, whereas the audit log
                shows every platform action (mostly noise for a user who just
                wants to scan their own notifications). */}
            <div className="p-2 shrink-0 flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="flex-1 justify-center text-xs text-muted-foreground hover:text-foreground"
                disabled={unreadCount === 0}
                onClick={markAllRead}
              >
                <CheckCheck className="size-3.5 mr-1" />
                {t(locale, "mark-all-read")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="flex-1 justify-center text-xs text-muted-foreground hover:text-foreground"
                onClick={() => { setView("notifications"); setNotifOpen(false); }}
              >
                {t(locale, "notif-view-all")}
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
