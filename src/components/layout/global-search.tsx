"use client";

import * as React from "react";
import { create } from "zustand";
import { useQuery } from "@tanstack/react-query";
import {
  Search, LayoutDashboard, Users, Package, Handshake, FileText, Inbox,
  FolderOpen, ListChecks, ScrollText, Settings, ShieldCheck, Key,
  Webhook, Lock, Mail, Receipt, FileSignature, Boxes, Building2,
  BookOpen, Calculator, ToggleRight, Plus, FileDown, ExternalLink,
  Clock, CornerDownLeft, ArrowRight,
} from "lucide-react";
import {
  Command, CommandInput, CommandList, CommandEmpty,
  CommandGroup, CommandItem, CommandSeparator,
} from "@/components/ui/command";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useAppStore, ViewKey, isAdmin, isSuperAdmin } from "@/lib/store/app-store";
import { cn } from "@/lib/utils";
import { fmtMoney } from "@/lib/utils/format";
import { toast } from "sonner";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { useT } from "@/lib/i18n/store";

/* -------------------------------------------------------------------------- */
/*  Open-state store — so the topbar button can open the palette             */
/* -------------------------------------------------------------------------- */

interface SearchState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
}));

/* -------------------------------------------------------------------------- */
/*  Quick navigation list (mirrors sidebar)                                  */
/* -------------------------------------------------------------------------- */

interface NavItem {
  key: ViewKey;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
  superAdminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  // Overview
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "tasks", label: "Tasks", icon: ListChecks },
  // Trade
  { key: "product-catalog", label: "Product Catalog", icon: BookOpen },
  { key: "supplier-offers", label: "Supplier Offers", icon: Inbox },
  { key: "trade-calculator", label: "Trade Calculator", icon: Calculator },
  // CRM
  { key: "partners", label: "Partners", icon: Users },
  { key: "products", label: "Products", icon: Package },
  { key: "deals", label: "Deals", icon: Handshake },
  { key: "offers", label: "Offers", icon: FileText },
  { key: "demands", label: "Demands", icon: Inbox },
  { key: "inventory", label: "Inventory", icon: Boxes },
  // Finance
  { key: "invoices", label: "Invoices", icon: Receipt },
  { key: "proformas", label: "Proformas", icon: FileSignature },
  { key: "document-register", label: "Document Register", icon: FolderOpen },
  // Admin
  { key: "audit", label: "Audit Log", icon: ScrollText },
  { key: "documents", label: "Documents", icon: FolderOpen },
  { key: "kyc-review", label: "KYC Review", icon: ShieldCheck, adminOnly: true },
  { key: "portal-rfqs", label: "Client Requests", icon: Inbox, adminOnly: true },
  { key: "document-templates", label: "Doc Templates", icon: FileText, adminOnly: true },
  { key: "security", label: "Security", icon: ShieldCheck, adminOnly: true },
  { key: "users", label: "Users", icon: Users, adminOnly: true },
  { key: "vault", label: "Vault", icon: Lock, adminOnly: true },
  { key: "api-keys", label: "API Keys", icon: Key, adminOnly: true },
  { key: "webhooks", label: "Webhooks", icon: Webhook, adminOnly: true },
  { key: "mail-queue", label: "Mail Queue", icon: Mail, superAdminOnly: true },
  { key: "settings", label: "Settings", icon: Settings, adminOnly: true },
  // Platform
  { key: "platform-dashboard", label: "Platform Dashboard", icon: LayoutDashboard, superAdminOnly: true },
];

/* -------------------------------------------------------------------------- */
/*  Type badge palette (NO indigo/blue)                                      */
/* -------------------------------------------------------------------------- */

type EntityKind = "partner" | "product" | "deal" | "offer" | "invoice";

const KIND_META: Record<
  EntityKind,
  { label: string; badgeCls: string; icon: React.ComponentType<{ className?: string }> }
> = {
  partner: {
    label: "Partner",
    badgeCls:
      "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
    icon: Users,
  },
  product: {
    label: "Product",
    badgeCls:
      "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
    icon: Package,
  },
  deal: {
    label: "Deal",
    badgeCls:
      "bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-400 border-fuchsia-500/20",
    icon: Handshake,
  },
  offer: {
    label: "Offer",
    badgeCls:
      "bg-teal-500/10 text-teal-700 dark:text-teal-400 border-teal-500/20",
    icon: FileText,
  },
  invoice: {
    label: "Invoice",
    badgeCls:
      "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20",
    icon: Receipt,
  },
};

interface SearchHit {
  id: string;
  kind: EntityKind;
  primary: string;
  secondary?: string;
  tertiary?: string;
  badge?: string;
  view: ViewKey;
}

/* -------------------------------------------------------------------------- */
/*  Recent searches (localStorage)                                          */
/* -------------------------------------------------------------------------- */

const RECENT_KEY = "velos:global-search:recent";
const RECENT_MAX = 5;

function loadRecent(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function saveRecent(term: string) {
  if (typeof window === "undefined") return;
  try {
    const cur = loadRecent();
    const next = [term, ...cur.filter((x) => x !== term)].slice(0, RECENT_MAX);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* no-op */
  }
}

/* -------------------------------------------------------------------------- */
/*  Hook: detect Mac vs other for shortcut hint                              */
/* -------------------------------------------------------------------------- */

function useIsMac(): boolean {
  const [isMac, setIsMac] = React.useState(false);
  React.useEffect(() => {
    setIsMac(
      typeof navigator !== "undefined" &&
        /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)
    );
  }, []);
  return isMac;
}

/* -------------------------------------------------------------------------- */
/*  Hook: debounce                                                            */
/* -------------------------------------------------------------------------- */
// `useDebounced` has been extracted to `@/lib/hooks/use-debounced` so all
// search-bearing views can share it. Kept here as a re-export for backwards
// compatibility in case other modules imported it from this file.
export { useDebounced };

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function GlobalSearch() {
  const { isOpen, open, close } = useSearchStore();
  const isMac = useIsMac();
  const t = useT();

  const { setView, setSelectedId, setAppMode, user } = useAppStore();
  const admin = isAdmin(user);
  const superAdmin = isSuperAdmin(user);

  const [query, setQuery] = React.useState("");
  const [recent, setRecent] = React.useState<string[]>([]);
  const debounced = useDebounced(query.trim(), 300);

  /* ---- hydrate recent on mount ---- */
  React.useEffect(() => {
    setRecent(loadRecent());
  }, []);

  /* ---- reset query when palette closes ---- */
  React.useEffect(() => {
    if (!isOpen) {
      const t = setTimeout(() => setQuery(""), 150);
      return () => clearTimeout(t);
    }
  }, [isOpen]);

  /* ---- Cmd+K / Ctrl+K global listener ---- */
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        e.stopPropagation();
        useSearchStore.getState().toggle();
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true } as any);
  }, []);

  /* ---- parallel search across 5 endpoints ---- */
  const searchQ = useQuery({
    queryKey: ["global-search", debounced],
    queryFn: async (): Promise<SearchHit[]> => {
      const q = encodeURIComponent(debounced);
      const [p, pr, d, o, i] = await Promise.all([
        fetch(`/api/partners?search=${q}&limit=5`).then((r) => r.json()).catch(() => ({ items: [] })),
        fetch(`/api/products?search=${q}&limit=5`).then((r) => r.json()).catch(() => ({ items: [] })),
        fetch(`/api/deals?search=${q}&limit=5`).then((r) => r.json()).catch(() => ({ items: [] })),
        fetch(`/api/offers?search=${q}&limit=5`).then((r) => r.json()).catch(() => ({ items: [] })),
        fetch(`/api/invoices?search=${q}&limit=5`).then((r) => r.json()).catch(() => ({ items: [] })),
      ]);

      const hits: SearchHit[] = [];
      for (const x of p.items || []) {
        hits.push({
          id: x.id,
          kind: "partner",
          primary: x.name || "Untitled",
          secondary: x.email || undefined,
          badge: x.type ? String(x.type) : undefined,
          view: "partners",
        });
      }
      for (const x of pr.items || []) {
        hits.push({
          id: x.id,
          kind: "product",
          primary: x.name || "Untitled",
          secondary: x.sku || undefined,
          badge: x.category || undefined,
          view: "products",
        });
      }
      for (const x of d.items || []) {
        hits.push({
          id: x.id,
          kind: "deal",
          primary: x.title || "Untitled",
          secondary: x.stage ? String(x.stage) : undefined,
          tertiary: fmtMoney(x.value, x.currency || "USD"),
          badge: x.stage ? String(x.stage) : undefined,
          view: "deals",
        });
      }
      for (const x of o.items || []) {
        hits.push({
          id: x.id,
          kind: "offer",
          primary: x.number || x.subject || "Untitled",
          secondary: x.subject || undefined,
          tertiary: fmtMoney(x.total, x.currency || "USD"),
          badge: x.status ? String(x.status) : undefined,
          view: "offers",
        });
      }
      for (const x of i.items || []) {
        hits.push({
          id: x.id,
          kind: "invoice",
          primary: x.number || x.subject || "Untitled",
          secondary: x.subject || undefined,
          tertiary: fmtMoney(x.total, x.currency || "USD"),
          badge: x.status ? String(x.status) : undefined,
          view: "invoices",
        });
      }
      return hits;
    },
    enabled: isOpen && debounced.length > 0,
    staleTime: 30_000,
  });

  /* ---- grouped results ---- */
  const grouped = React.useMemo(() => {
    const map: Record<EntityKind, SearchHit[]> = {
      partner: [], product: [], deal: [], offer: [], invoice: [],
    };
    for (const h of searchQ.data || []) map[h.kind].push(h);
    return map;
  }, [searchQ.data]);

  const hasResults = (searchQ.data?.length || 0) > 0;
  const isLoading = searchQ.isFetching && debounced.length > 0;

  /* ---- handlers ---- */
  function go(view: ViewKey, id?: string) {
    setView(view);
    if (id) setSelectedId(id);
    close();
  }

  function handleHit(hit: SearchHit) {
    if (debounced) saveRecent(debounced);
    setRecent(loadRecent());
    go(hit.view, hit.id);
  }

  function runQuickAction(action: string) {
    switch (action) {
      case "new-partner":
        setView("partners");
        toast.info("Use the New button on the Partners page.");
        break;
      case "new-offer":
        setView("offers");
        toast.info("Use the New button on the Offers page.");
        break;
      case "new-deal":
        setView("deals");
        toast.info("Use the New button on the Deals page.");
        break;
      case "new-invoice":
        setView("invoices");
        toast.info("Use the New button on the Invoices page.");
        break;
      case "download-offer-pdf":
        setView("offers");
        toast.info("Open an offer and click Download PDF.");
        break;
      case "open-portal":
        setAppMode("portal");
        break;
    }
    close();
  }

  function applyRecent(term: string) {
    setQuery(term);
  }

  const visibleNav = NAV_ITEMS.filter((n) => {
    if (n.superAdminOnly) return superAdmin;
    if (n.adminOnly) return admin;
    return true;
  });

  /* ---- render helpers ---- */
  const shortcutHint = isMac ? "⌘K" : "Ctrl K";

  return (
    <Dialog open={isOpen} onOpenChange={(o) => (o ? open() : close())}>
      <DialogContent
        showCloseButton={false}
        className="p-0 overflow-hidden max-w-2xl glass-strong bg-mesh border border-border/60 rounded-2xl shadow-soft-xl gap-0"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t("misc-gs-title")}</DialogTitle>
          <DialogDescription>
            {t("misc-gs-search-placeholder")}
          </DialogDescription>
        </DialogHeader>

        <Command
          shouldFilter={false}
          loop
          className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:size-4 [&_[cmdk-input]]:h-12 [&_[cmdk-input]]:text-sm"
        >
          <CommandInput
            placeholder={t("misc-gs-search-placeholder")}
            value={query}
            onValueChange={setQuery}
            autoFocus
          />

          <CommandList className="max-h-[60vh] min-h-[280px] custom-scroll">
            {/* Empty query — quick nav + actions + recent */}
            {!debounced && (
              <>
                {/* Recent searches */}
                {recent.length > 0 && (
                  <CommandGroup heading={t("misc-gs-recent")}>
                    {recent.map((r) => (
                      <CommandItem
                        key={`recent-${r}`}
                        value={`recent-${r}`}
                        onSelect={() => applyRecent(r)}
                        className="gap-3 px-3 py-2 rounded-md"
                      >
                        <Clock className="size-4 text-muted-foreground" />
                        <span className="text-sm truncate flex-1">{r}</span>
                        <kbd className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                          {shortcutHint}
                        </kbd>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}

                <CommandGroup heading={t("misc-gs-quick-nav")}>
                  {visibleNav.map((n) => {
                    const Icon = n.icon;
                    return (
                      <CommandItem
                        key={n.key}
                        value={`nav-${n.label}`}
                        onSelect={() => go(n.key)}
                        className="gap-3 px-3 py-2 rounded-md group"
                      >
                        <span className="size-7 rounded-md bg-muted/70 text-muted-foreground flex items-center justify-center group-data-[selected=true]:bg-primary/15 group-data-[selected=true]:text-primary smooth">
                          <Icon className="size-4" />
                        </span>
                        <span className="text-sm font-medium">{t(n.key)}</span>
                        <ArrowRight className="ml-auto size-3.5 text-muted-foreground/50 group-data-[selected=true]:text-primary smooth" />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>

                <CommandSeparator className="my-1" />
                <CommandGroup heading={t("misc-gs-quick-actions")}>
                  <CommandItem
                    value="action-new-partner"
                    onSelect={() => runQuickAction("new-partner")}
                    className="gap-3 px-3 py-2 rounded-md"
                  >
                    <span className="size-7 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
                      <Plus className="size-4" />
                    </span>
                    <span className="text-sm font-medium">{t("misc-gs-new-partner")}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{t("misc-gs-action-hint-partner")}</span>
                  </CommandItem>
                  <CommandItem
                    value="action-new-offer"
                    onSelect={() => runQuickAction("new-offer")}
                    className="gap-3 px-3 py-2 rounded-md"
                  >
                    <span className="size-7 rounded-md bg-teal-500/10 text-teal-600 dark:text-teal-400 flex items-center justify-center">
                      <Plus className="size-4" />
                    </span>
                    <span className="text-sm font-medium">{t("misc-gs-new-offer")}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{t("misc-gs-action-hint-offer")}</span>
                  </CommandItem>
                  <CommandItem
                    value="action-new-deal"
                    onSelect={() => runQuickAction("new-deal")}
                    className="gap-3 px-3 py-2 rounded-md"
                  >
                    <span className="size-7 rounded-md bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400 flex items-center justify-center">
                      <Plus className="size-4" />
                    </span>
                    <span className="text-sm font-medium">{t("misc-gs-new-deal")}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{t("misc-gs-action-hint-deal")}</span>
                  </CommandItem>
                  <CommandItem
                    value="action-new-invoice"
                    onSelect={() => runQuickAction("new-invoice")}
                    className="gap-3 px-3 py-2 rounded-md"
                  >
                    <span className="size-7 rounded-md bg-rose-500/10 text-rose-600 dark:text-rose-400 flex items-center justify-center">
                      <Plus className="size-4" />
                    </span>
                    <span className="text-sm font-medium">{t("misc-gs-new-invoice")}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{t("misc-gs-action-hint-invoice")}</span>
                  </CommandItem>
                  <CommandItem
                    value="action-download-offer-pdf"
                    onSelect={() => runQuickAction("download-offer-pdf")}
                    className="gap-3 px-3 py-2 rounded-md"
                  >
                    <span className="size-7 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center">
                      <FileDown className="size-4" />
                    </span>
                    <span className="text-sm font-medium">{t("misc-gs-download-offer-pdf")}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{t("offers")}</span>
                  </CommandItem>
                  <CommandItem
                    value="action-open-portal"
                    onSelect={() => runQuickAction("open-portal")}
                    className="gap-3 px-3 py-2 rounded-md"
                  >
                    <span className="size-7 rounded-md bg-primary/10 text-primary flex items-center justify-center">
                      <ExternalLink className="size-4" />
                    </span>
                    <span className="text-sm font-medium">{t("misc-gs-open-portal")}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{t("misc-gs-portal-mode")}</span>
                  </CommandItem>
                </CommandGroup>
              </>
            )}

            {/* Searching — loading skeleton */}
            {debounced && isLoading && !hasResults && (
              <div className="p-6 space-y-3">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="size-7 rounded-md bg-muted shimmer" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3 w-1/3 rounded bg-muted shimmer" />
                      <div className="h-2.5 w-1/4 rounded bg-muted/70 shimmer" />
                    </div>
                    <div className="h-4 w-12 rounded bg-muted/70 shimmer" />
                  </div>
                ))}
                <p className="text-center text-xs text-muted-foreground pt-2">
                  {t("misc-gs-searching")}
                </p>
              </div>
            )}

            {/* Search results — grouped */}
            {debounced && !isLoading && hasResults && (
              <>
                {(Object.keys(grouped) as EntityKind[]).map((kind) => {
                  const list = grouped[kind];
                  if (list.length === 0) return null;
                  const meta = KIND_META[kind];
                  return (
                    <CommandGroup key={kind} heading={`${meta.label}s`}>
                      {list.map((hit) => {
                        const Icon = meta.icon;
                        return (
                          <CommandItem
                            key={`${hit.kind}-${hit.id}`}
                            value={`${hit.kind}-${hit.id}-${hit.primary}`}
                            onSelect={() => handleHit(hit)}
                            className="gap-3 px-3 py-2 rounded-md group"
                          >
                            <span className="size-7 rounded-md bg-muted/70 text-muted-foreground flex items-center justify-center group-data-[selected=true]:bg-primary/15 group-data-[selected=true]:text-primary smooth shrink-0">
                              <Icon className="size-4" />
                            </span>
                            <div className="min-w-0 flex-1 flex flex-col">
                              <span className="text-sm font-medium truncate">
                                {hit.primary}
                              </span>
                              {hit.secondary && (
                                <span className="text-xs text-muted-foreground truncate">
                                  {hit.secondary}
                                </span>
                              )}
                            </div>
                            {hit.tertiary && (
                              <span className="text-xs text-muted-foreground tabular shrink-0 hidden sm:inline">
                                {hit.tertiary}
                              </span>
                            )}
                            {hit.badge && (
                              <Badge
                                variant="outline"
                                className={cn(
                                  "text-xs px-1.5 py-0 h-5 font-medium capitalize shrink-0",
                                  meta.badgeCls
                                )}
                              >
                                {hit.badge}
                              </Badge>
                            )}
                            <CornerDownLeft className="size-3 text-muted-foreground/40 group-data-[selected=true]:text-primary shrink-0 hidden sm:block" />
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  );
                })}
                <CommandSeparator className="my-1" />
                <div className="px-3 py-2 text-xs text-muted-foreground flex items-center justify-between">
                  <span>
                    {t("misc-gs-result-count").replace("{n}", String(searchQ.data?.length || 0))}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <kbd className="bg-muted px-1.5 py-0.5 rounded text-xs">↑↓</kbd>
                    {t("misc-gs-navigate")}
                    <kbd className="bg-muted px-1.5 py-0.5 rounded text-xs ml-1">↵</kbd>
                    {t("misc-gs-open")}
                  </span>
                </div>
              </>
            )}

            {/* Search — no results */}
            {debounced && !isLoading && !hasResults && (
              <CommandEmpty>
                <div className="flex flex-col items-center gap-2 py-8">
                  <Search className="size-6 text-muted-foreground/50" />
                  <p className="text-sm font-medium">{t("no_results")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("misc-gs-try-different")}
                  </p>
                </div>
              </CommandEmpty>
            )}
          </CommandList>

          {/* Footer */}
          <div className="border-t bg-background/40 px-3 py-2 flex items-center justify-between text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <kbd className="bg-muted px-1.5 py-0.5 rounded font-mono">{shortcutHint}</kbd>
              <span>{t("misc-gs-to-toggle")}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <kbd className="bg-muted px-1.5 py-0.5 rounded text-xs">esc</kbd>
                {t("misc-gs-close")}
              </span>
            </div>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

export default GlobalSearch;
