"use client";

// ─────────────────────────────────────────────────────────────────────────────
// MarketplaceAdminView — super-admin marketplace management panel (task UI-2).
//
// One view, seven tabs:
//
//   1. Overview              — KPI tiles + recent activity feed
//   2. Posts Management      — cross-tenant post list, flag/remove/feature
//   3. Company Verification  — verification queue + tier changes
//   4. Reviews Moderation    — hide/show/flag/delete reviews
//   5. Categories Management — CRUD on marketplace_categories
//   6. Blacklist              — block / unblock companies
//   7. Statistics             — recharts visualisations over time
//
// Auth gate: the sidebar item is `superAdminOnly: true` AND the API routes
// all use `requireSuperAdmin(req)`. The view ALSO re-checks `isSuperAdmin`
// client-side so a non-super-admin who reaches it via state manipulation
// sees a clear denial card instead of a steady stream of 403 fetches.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  LayoutDashboard, Package, Building2, Star, FolderTree, Ban,
  BarChart3, RefreshCw, Eye, Flag, Trash2, Sparkles, CheckCircle2,
  XCircle, ShieldCheck, ShieldAlert, Loader2, Search, Plus,
  MessageSquare, Users, TrendingUp, Activity,
} from "lucide-react";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  type TooltipProps,
} from "recharts";
import { useT } from "@/lib/i18n/store";
import { useAppStore, isSuperAdmin } from "@/lib/store/app-store";
import { PageHeader } from "@/components/common/page-header";
import { fmtDateTime, fmtMoney } from "@/lib/utils/format";
import { toast } from "sonner";

// ── VELOS copper palette (matches dashboard/charts.tsx) ─────────────────────
const COPPER = {
  primary: "#B45309",
  secondary: "#D97706",
  tertiary: "#F59E0B",
  quaternary: "#92400E",
  light: "#FEF3C7",
} as const;

const TOOLTIP_STYLE = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--popover-foreground)",
} as const;
const AXIS_TICK_STYLE = { fontSize: 11, fill: "var(--muted-foreground)" } as const;
const GRID_STROKE = "var(--border)";

// ── Status badge tones ──────────────────────────────────────────────────────
const POST_STATUS_TONE: Record<string, string> = {
  draft:    "border-slate-400/30 bg-slate-400/10 text-slate-600 dark:text-slate-300",
  active:   "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  closed:   "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  expired: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  flagged: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
};

const VERIFICATION_TONE: Record<string, string> = {
  none:     "border-slate-400/30 bg-slate-400/10 text-slate-600 dark:text-slate-300",
  bronze:   "border-amber-700/30 bg-amber-700/10 text-amber-800 dark:text-amber-400",
  silver:   "border-slate-400/30 bg-slate-300/20 text-slate-700 dark:text-slate-200",
  gold:     "border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
  platinum: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-400",
};

const RESPONSE_STATUS_TONE: Record<string, string> = {
  sent:     "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  viewed:   "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  accepted: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  rejected: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  countered:"border-primary/30 bg-primary/10 text-primary",
  expired:  "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

// ── Helpers ─────────────────────────────────────────────────────────────────
function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try { return fmtDateTime(iso); } catch { return String(iso); }
}
function formatPrice(price: number | null | undefined, currency: string | null | undefined): string {
  if (price === null || price === undefined) return "—";
  return fmtMoney(Number(price), currency || "USD");
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN VIEW
// ═══════════════════════════════════════════════════════════════════════════
export function MarketplaceAdminView() {
  const t = useT();
  const userObj = useAppStore((s) => s.user);
  const isSuper = isSuperAdmin(userObj);

  // Defense-in-depth: super-admin-only surface.
  if (!isSuper) {
    return (
      <div>
        <PageHeader title={t("pf-ma-title")} description={t("pf-ma-desc")} />
        <Card className="border-amber-500/30 bg-amber-50/40 dark:bg-amber-500/5">
          <CardContent className="p-6 flex items-start gap-3">
            <div className="size-10 rounded-xl bg-amber-500/15 text-amber-600 flex items-center justify-center shrink-0">
              <ShieldAlert className="size-5" />
            </div>
            <div>
              <p className="font-medium">{t("pf-superadmin-required")}</p>
              <p className="text-sm text-muted-foreground mt-1">{t("pf-superadmin-required-desc")}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={t("pf-ma-title")} description={t("pf-ma-desc")} />
      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="flex flex-wrap h-auto bg-muted/40 p-1 rounded-xl gap-1 mb-6">
          <TabTrigger value="overview"     icon={LayoutDashboard} label={t("pf-ma-tab-overview")} />
          <TabTrigger value="posts"        icon={Package}          label={t("pf-ma-tab-posts")} />
          <TabTrigger value="verification" icon={Building2}        label={t("pf-ma-tab-verification")} />
          <TabTrigger value="reviews"      icon={Star}             label={t("pf-ma-tab-reviews")} />
          <TabTrigger value="categories"  icon={FolderTree}        label={t("pf-ma-tab-categories")} />
          <TabTrigger value="blacklist"   icon={Ban}               label={t("pf-ma-tab-blacklist")} />
          <TabTrigger value="stats"       icon={BarChart3}        label={t("pf-ma-tab-stats")} />
        </TabsList>

        <TabsContent value="overview"     className="mt-0"><OverviewTab /></TabsContent>
        <TabsContent value="posts"        className="mt-0"><PostsTab /></TabsContent>
        <TabsContent value="verification" className="mt-0"><VerificationTab /></TabsContent>
        <TabsContent value="reviews"      className="mt-0"><ReviewsTab /></TabsContent>
        <TabsContent value="categories"  className="mt-0"><CategoriesTab /></TabsContent>
        <TabsContent value="blacklist"   className="mt-0"><BlacklistTab /></TabsContent>
        <TabsContent value="stats"       className="mt-0"><StatsTab /></TabsContent>
      </Tabs>
    </div>
  );
}

function TabTrigger({
  value, icon: Icon, label,
}: {
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <TabsTrigger
      value={value}
      className="data-[state=active]:bg-gradient-emerald data-[state=active]:text-white data-[state=active]:shadow-soft rounded-lg px-3 py-1.5 text-xs font-medium flex items-center gap-1.5 transition-all"
    >
      <Icon className="size-3.5" />
      {label}
    </TabsTrigger>
  );
}

export default MarketplaceAdminView;

// ═══════════════════════════════════════════════════════════════════════════
// 1. OVERVIEW TAB — KPI tiles + recent activity feed
// ═══════════════════════════════════════════════════════════════════════════
interface StatsResponse {
  totals: {
    posts: number; responses: number; negotiations: number;
    companies: number; reviews: number; blacklist: number;
    flagged_posts: number; flagged_reviews: number;
  };
  posts_by_status: Record<string, number>;
  posts_by_type: Record<string, number>;
  responses_by_status: Record<string, number>;
  recent_activity: any[];
  posts_over_time: { date: string; count: number }[];
  responses_over_time: { date: string; count: number }[];
  top_categories: { name: string; count: number }[];
  top_countries: { country: string; count: number }[];
  top_companies: { partner_id: string; name: string; posts: number }[];
}

function OverviewTab() {
  const t = useT();
  const qc = useQueryClient();
  const statsQ = useQuery<StatsResponse>({
    queryKey: ["admin-marketplace-stats"],
    queryFn: async () => {
      const r = await fetch("/api/admin/marketplace/stats");
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(err.error || "Failed to load stats.");
      }
      return r.json();
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const totals = statsQ.data?.totals;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => statsQ.refetch()}
          disabled={statsQ.isFetching}
        >
          <RefreshCw className={`size-3.5 mr-1 ${statsQ.isFetching ? "animate-spin" : ""}`} />
          {t("refresh")}
        </Button>
      </div>

      {statsQ.isLoading && (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" />
            {t("pf-ma-loading")}
          </CardContent>
        </Card>
      )}
      {statsQ.error && (
        <Card>
          <CardContent className="p-6 text-sm text-destructive">
            {t("pf-ma-load-failed")}: {(statsQ.error as Error).message}
          </CardContent>
        </Card>
      )}

      {totals && (
        <>
          {/* KPI tiles */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
            <KpiTile icon={Package}        label={t("pf-ma-kpi-posts")}        value={totals.posts} tone="info" />
            <KpiTile icon={MessageSquare}  label={t("pf-ma-kpi-responses")}    value={totals.responses} tone="info" />
            <KpiTile icon={Users}          label={t("pf-ma-kpi-negotiations")} value={totals.negotiations} tone="info" />
            <KpiTile icon={Building2}     label={t("pf-ma-kpi-companies")}   value={totals.companies} tone="info" />
            <KpiTile icon={Star}           label={t("pf-ma-kpi-reviews")}     value={totals.reviews} tone="info" />
            <KpiTile icon={ShieldCheck}    label={t("pf-ma-kpi-active")}      value={statsQ.data!.posts_by_status.active ?? 0} tone="ok" />
            <KpiTile icon={Flag}           label={t("pf-ma-kpi-flagged-posts")} value={totals.flagged_posts} tone={totals.flagged_posts > 0 ? "warn" : "ok"} />
            <KpiTile icon={Flag}           label={t("pf-ma-kpi-flagged-reviews")} value={totals.flagged_reviews} tone={totals.flagged_reviews > 0 ? "warn" : "ok"} />
            <KpiTile icon={Ban}            label={t("pf-ma-kpi-blacklist")}   value={totals.blacklist} tone={totals.blacklist > 0 ? "critical" : "info"} />
            <KpiTile icon={TrendingUp}    label={t("pf-ma-kpi-expired")}     value={statsQ.data!.posts_by_status.expired ?? 0} tone="info" />
          </div>

          {/* Two-column layout: posts by status + by type */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <DistributionCard
              title={t("pf-ma-card-posts-by-status")}
              data={statsQ.data!.posts_by_status}
              tones={POST_STATUS_TONE}
            />
            <DistributionCard
              title={t("pf-ma-card-posts-by-type")}
              data={statsQ.data!.posts_by_type}
            />
          </div>

          {/* Recent activity */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Activity className="size-4 text-primary" />
                {t("pf-ma-card-recent-activity")}
              </CardTitle>
              <CardDescription className="text-xs">
                {t("pf-ma-card-recent-activity-desc")}
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              {(statsQ.data!.recent_activity ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">{t("no_data")}</p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {statsQ.data!.recent_activity.map((a: any) => (
                    <li key={a.id} className="py-2 flex items-center gap-3 text-xs">
                      <Badge variant="outline" className="font-mono">{a.action}</Badge>
                      <span className="text-muted-foreground truncate flex-1 min-w-0">
                        {a.username || a.user_id || "—"}
                      </span>
                      <span className="text-muted-foreground tabular-nums shrink-0">
                        {formatDate(a.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function KpiTile({
  icon: Icon, label, value, tone, hint,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  tone: "ok" | "info" | "warn" | "critical";
  hint?: string;
}) {
  const TONE: Record<string, string> = {
    ok: "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400",
    info: "border-primary/30 bg-primary/5",
    warn: "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400",
    critical: "border-destructive/30 bg-destructive/5 text-destructive",
  };
  return (
    <Card className={`rounded-xl ${TONE[tone]}`}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs uppercase tracking-wider">{label}</p>
            <p className="text-2xl font-bold tabular mt-1">{value}</p>
          </div>
          <Icon className="size-4 opacity-60" />
        </div>
        {hint && <p className="text-xs opacity-70 mt-1">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function DistributionCard({
  title, data, tones,
}: {
  title: string;
  data: Record<string, number>;
  tones?: Record<string, string>;
}) {
  const t = useT();
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = entries.length > 0 ? entries[0][1] : 1;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-1.5">
        {entries.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">{t("no_data")}</p>
        ) : (
          entries.map(([key, value]) => (
            <div key={key} className="flex items-center gap-3 text-xs">
              <div className="w-24 shrink-0 text-muted-foreground truncate" title={key}>{key}</div>
              <div className="flex-1 h-5 bg-muted/40 rounded relative overflow-hidden">
                <div
                  className={`absolute inset-y-0 left-0 rounded ${(tones?.[key] ?? "bg-primary/40")}`}
                  style={{ width: `${Math.max(2, (value / max) * 100)}%` }}
                />
              </div>
              <div className="w-10 text-right tabular font-mono">{value}</div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. POSTS MANAGEMENT TAB
// ═══════════════════════════════════════════════════════════════════════════
interface AdminPost {
  id: string;
  tenant_id: string;
  partner_id: string;
  post_type: string;
  product_name: string;
  product_category: string | null;
  quantity: number;
  unit: string;
  target_price: number | null;
  currency: string | null;
  delivery_country: string | null;
  status: string;
  visibility: string;
  is_featured: boolean;
  is_verified: boolean;
  verification_level: string;
  views_count: number;
  responses_count: number;
  expires_at: string | null;
  created_at: string;
  company_name: string | null;
  company_country: string | null;
  tenant_name: string | null;
}

function PostsTab() {
  const t = useT();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = React.useState<string>("all");
  const [typeFilter, setTypeFilter] = React.useState<string>("all");
  const [featuredFilter, setFeaturedFilter] = React.useState<string>("all");
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [detailPost, setDetailPost] = React.useState<AdminPost | null>(null);

  React.useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  const postsQ = useQuery<{ items: AdminPost[]; total: number }>({
    queryKey: ["admin-marketplace-posts", statusFilter, typeFilter, featuredFilter, debouncedSearch],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "100" });
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (typeFilter !== "all") params.set("post_type", typeFilter);
      if (featuredFilter !== "all") params.set("featured", featuredFilter);
      if (debouncedSearch) params.set("search", debouncedSearch);
      const r = await fetch(`/api/admin/marketplace/posts?${params}`);
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(e.error || "Failed to load posts.");
      }
      return r.json();
    },
  });

  const actionMut = useMutation({
    mutationFn: async ({ postId, action }: { postId: string; action: string }) => {
      const r = await fetch("/api/admin/marketplace/posts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ post_id: postId, action }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(e.error || "Action failed.");
      }
      return r.json();
    },
    onSuccess: (_data, vars) => {
      const labels: Record<string, string> = {
        flag: t("pf-ma-toast-post-flagged"),
        unflag: t("pf-ma-toast-post-unflagged"),
        remove: t("pf-ma-toast-post-removed"),
        feature: t("pf-ma-toast-post-featured"),
        unfeature: t("pf-ma-toast-post-unfeatured"),
      };
      toast.success(labels[vars.action] || t("pf-ma-toast-done"));
      qc.invalidateQueries({ queryKey: ["admin-marketplace-posts"] });
      qc.invalidateQueries({ queryKey: ["admin-marketplace-stats"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const posts = postsQ.data?.items ?? [];

  return (
    <div className="space-y-3">
      {/* Filters */}
      <Card>
        <CardContent className="p-3 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              placeholder={t("pf-ma-search-posts")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[150px]"><SelectValue placeholder={t("pf-ma-filter-status")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("all")}</SelectItem>
              <SelectItem value="active">{t("active")}</SelectItem>
              <SelectItem value="flagged">{t("pf-ma-status-flagged")}</SelectItem>
              <SelectItem value="expired">{t("pf-ma-status-expired")}</SelectItem>
              <SelectItem value="draft">{t("pf-ma-status-draft")}</SelectItem>
              <SelectItem value="closed">{t("pf-ma-status-closed")}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[140px]"><SelectValue placeholder={t("type")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("all")}</SelectItem>
              <SelectItem value="buy">{t("pf-ma-type-buy")}</SelectItem>
              <SelectItem value="sell">{t("pf-ma-type-sell")}</SelectItem>
              <SelectItem value="auction">{t("pf-ma-type-auction")}</SelectItem>
              <SelectItem value="contract">{t("pf-ma-type-contract")}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={featuredFilter} onValueChange={setFeaturedFilter}>
            <SelectTrigger className="w-[140px]"><SelectValue placeholder={t("pf-ma-filter-featured")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("all")}</SelectItem>
              <SelectItem value="true">{t("pf-ma-featured-only")}</SelectItem>
              <SelectItem value="false">{t("pf-ma-not-featured")}</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={() => postsQ.refetch()} disabled={postsQ.isFetching}>
            <RefreshCw className={`size-3.5 mr-1 ${postsQ.isFetching ? "animate-spin" : ""}`} />
            {t("refresh")}
          </Button>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">{t("pf-ma-col-type")}</TableHead>
                  <TableHead className="text-xs">{t("pf-ma-col-product")}</TableHead>
                  <TableHead className="text-xs">{t("pf-ma-col-company")}</TableHead>
                  <TableHead className="text-xs">{t("pf-ma-col-country")}</TableHead>
                  <TableHead className="text-xs text-right">{t("pf-ma-col-price")}</TableHead>
                  <TableHead className="text-xs text-right">{t("pf-ma-col-quantity")}</TableHead>
                  <TableHead className="text-xs">{t("status")}</TableHead>
                  <TableHead className="text-xs text-right">{t("pf-ma-col-views")}</TableHead>
                  <TableHead className="text-xs text-right">{t("pf-ma-col-responses")}</TableHead>
                  <TableHead className="text-xs">{t("date")}</TableHead>
                  <TableHead className="text-xs text-right">{t("actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {postsQ.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={11} className="text-center text-xs text-muted-foreground py-8">
                      <Loader2 className="size-4 animate-spin inline mr-2" />
                      {t("pf-ma-loading")}
                    </TableCell>
                  </TableRow>
                ) : posts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={11} className="text-center text-xs text-muted-foreground py-8">
                      {t("no_results")}
                    </TableCell>
                  </TableRow>
                ) : (
                  posts.map((p) => (
                    <TableRow key={p.id} className="hover:bg-muted/40">
                      <TableCell>
                        <Badge variant="outline" className="text-xs capitalize">{p.post_type}</Badge>
                      </TableCell>
                      <TableCell className="text-xs font-medium max-w-[200px] truncate" title={p.product_name}>
                        <div className="flex items-center gap-1.5">
                          {p.is_featured && <Sparkles className="size-3 text-primary shrink-0" />}
                          <span className="truncate">{p.product_name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs max-w-[160px] truncate" title={p.company_name ?? ""}>
                        {p.company_name ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs">{p.delivery_country ?? "—"}</TableCell>
                      <TableCell className="text-xs text-right tabular">
                        {p.target_price != null ? formatPrice(p.target_price, p.currency) : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular">
                        {p.quantity} {p.unit}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-xs ${POST_STATUS_TONE[p.status] ?? ""}`}>
                          {p.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-right tabular">{p.views_count}</TableCell>
                      <TableCell className="text-xs text-right tabular">{p.responses_count}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{formatDate(p.created_at)}</TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button size="icon" variant="ghost" className="size-7" title={t("view")} onClick={() => setDetailPost(p)}>
                            <Eye className="size-3.5" />
                          </Button>
                          {p.status === "flagged" ? (
                            <Button size="icon" variant="ghost" className="size-7" title={t("pf-ma-action-unflag")}
                              onClick={() => actionMut.mutate({ postId: p.id, action: "unflag" })}
                              disabled={actionMut.isPending}>
                              <CheckCircle2 className="size-3.5 text-emerald-600" />
                            </Button>
                          ) : (
                            <Button size="icon" variant="ghost" className="size-7" title={t("pf-ma-action-flag")}
                              onClick={() => actionMut.mutate({ postId: p.id, action: "flag" })}
                              disabled={actionMut.isPending}>
                              <Flag className="size-3.5 text-amber-600" />
                            </Button>
                          )}
                          <Button size="icon" variant="ghost" className="size-7" title={t("pf-ma-action-remove")}
                            onClick={() => {
                              if (typeof window !== "undefined" && window.confirm(t("pf-ma-confirm-remove"))) {
                                actionMut.mutate({ postId: p.id, action: "remove" });
                              }
                            }}
                            disabled={actionMut.isPending}>
                            <Trash2 className="size-3.5 text-red-600" />
                          </Button>
                          {p.is_featured ? (
                            <Button size="icon" variant="ghost" className="size-7" title={t("pf-ma-action-unfeature")}
                              onClick={() => actionMut.mutate({ postId: p.id, action: "unfeature" })}
                              disabled={actionMut.isPending}>
                              <Sparkles className="size-3.5 text-primary" />
                            </Button>
                          ) : (
                            <Button size="icon" variant="ghost" className="size-7" title={t("pf-ma-action-feature")}
                              onClick={() => actionMut.mutate({ postId: p.id, action: "feature" })}
                              disabled={actionMut.isPending}>
                              <Sparkles className="size-3.5 opacity-50" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Detail Sheet */}
      <Sheet open={!!detailPost} onOpenChange={(o) => !o && setDetailPost(null)}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle className="text-base">{detailPost?.product_name}</SheetTitle>
            <SheetDescription>{t("pf-ma-sheet-post-detail")}</SheetDescription>
          </SheetHeader>
          {detailPost && (
            <div className="px-4 pb-4 space-y-3 text-xs">
              <DetailRow label={t("pf-ma-col-type")}       value={<Badge variant="outline" className="capitalize">{detailPost.post_type}</Badge>} />
              <DetailRow label={t("pf-ma-col-company")}   value={detailPost.company_name ?? "—"} />
              <DetailRow label={t("pf-ma-col-country")}   value={detailPost.delivery_country ?? "—"} />
              <DetailRow label={t("pf-ma-col-price")}      value={detailPost.target_price != null ? formatPrice(detailPost.target_price, detailPost.currency) : "—"} />
              <DetailRow label={t("pf-ma-col-quantity")}   value={`${detailPost.quantity} ${detailPost.unit}`} />
              <DetailRow label="Status"                    value={<Badge variant="outline" className={POST_STATUS_TONE[detailPost.status] ?? ""}>{detailPost.status}</Badge>} />
              <DetailRow label={t("pf-ma-col-views")}      value={detailPost.views_count} />
              <DetailRow label={t("pf-ma-col-responses")}  value={detailPost.responses_count} />
              <DetailRow label={t("pf-ma-col-created")}    value={formatDate(detailPost.created_at)} />
              <DetailRow label={t("pf-ma-col-expires")}    value={formatDate(detailPost.expires_at)} />
              <DetailRow label={t("pf-ma-col-tenant")}     value={detailPost.tenant_name ?? detailPost.tenant_id} />
              <DetailRow label={t("pf-ma-col-featured")}   value={detailPost.is_featured ? t("yes") : t("no")} />
              <DetailRow label={t("pf-ma-col-verification")} value={
                <Badge variant="outline" className={`capitalize ${VERIFICATION_TONE[detailPost.verification_level] ?? ""}`}>
                  {detailPost.verification_level}
                </Badge>
              } />
              <Separator />
              <div className="flex flex-wrap gap-2 pt-2">
                {detailPost.status === "flagged" ? (
                  <Button size="sm" variant="outline" onClick={() => { actionMut.mutate({ postId: detailPost.id, action: "unflag" }); setDetailPost(null); }}>
                    <CheckCircle2 className="size-3.5 mr-1 text-emerald-600" />
                    {t("pf-ma-action-unflag")}
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => { actionMut.mutate({ postId: detailPost.id, action: "flag" }); setDetailPost(null); }}>
                    <Flag className="size-3.5 mr-1 text-amber-600" />
                    {t("pf-ma-action-flag")}
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => { actionMut.mutate({ postId: detailPost.id, action: "remove" }); setDetailPost(null); }}>
                  <Trash2 className="size-3.5 mr-1 text-red-600" />
                  {t("pf-ma-action-remove")}
                </Button>
                {detailPost.is_featured ? (
                  <Button size="sm" variant="outline" onClick={() => { actionMut.mutate({ postId: detailPost.id, action: "unfeature" }); setDetailPost(null); }}>
                    <Sparkles className="size-3.5 mr-1 text-primary" />
                    {t("pf-ma-action-unfeature")}
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => { actionMut.mutate({ postId: detailPost.id, action: "feature" }); setDetailPost(null); }}>
                    <Sparkles className="size-3.5 mr-1" />
                    {t("pf-ma-action-feature")}
                  </Button>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right font-medium break-words min-w-0">{value}</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. COMPANY VERIFICATION TAB
// ═══════════════════════════════════════════════════════════════════════════
interface VerificationRow {
  id: string;
  partner_id: string;
  tenant_id: string;
  company_name: string | null;
  company_country: string | null;
  company_email: string | null;
  verification_level: string;
  verified_at: string | null;
  verified_by: string | null;
  rating_average: number;
  rating_count: number;
  total_posts: number;
  successful_deals: number;
  company_description: string | null;
  website: string | null;
  year_established: number | null;
  created_at: string;
}

function VerificationTab() {
  const t = useT();
  const qc = useQueryClient();
  const [levelFilter, setLevelFilter] = React.useState<string>("all");
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [dialogRow, setDialogRow] = React.useState<VerificationRow | null>(null);
  const [dialogLevel, setDialogLevel] = React.useState<string>("bronze");
  const [dialogReason, setDialogReason] = React.useState("");

  React.useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  const listQ = useQuery<{ items: VerificationRow[]; total: number }>({
    queryKey: ["admin-marketplace-verification", levelFilter, debouncedSearch],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (levelFilter !== "all") params.set("level", levelFilter);
      if (debouncedSearch) params.set("search", debouncedSearch);
      const r = await fetch(`/api/admin/marketplace/verification?${params}`);
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(e.error || "Failed to load companies.");
      }
      return r.json();
    },
  });

  const verifyMut = useMutation({
    mutationFn: async ({ partnerId, action, level, reason }: {
      partnerId: string; action: string; level?: string; reason?: string;
    }) => {
      const r = await fetch("/api/admin/marketplace/verification", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partner_id: partnerId, action, level, reason }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(e.error || "Action failed.");
      }
      return r.json();
    },
    onSuccess: (_d, vars) => {
      const labels: Record<string, string> = {
        approve: t("pf-ma-toast-verified"),
        reject: t("pf-ma-toast-verification-rejected"),
        set_level: t("pf-ma-toast-level-set"),
      };
      toast.success(labels[vars.action] || t("pf-ma-toast-done"));
      qc.invalidateQueries({ queryKey: ["admin-marketplace-verification"] });
      qc.invalidateQueries({ queryKey: ["admin-marketplace-stats"] });
      setDialogRow(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = listQ.data?.items ?? [];

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="p-3 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              placeholder={t("pf-ma-search-companies")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-9"
            />
          </div>
          <Select value={levelFilter} onValueChange={setLevelFilter}>
            <SelectTrigger className="w-[170px]"><SelectValue placeholder={t("pf-ma-filter-level")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("all")}</SelectItem>
              <SelectItem value="none">{t("pf-ma-level-none")}</SelectItem>
              <SelectItem value="bronze">{t("pf-ma-level-bronze")}</SelectItem>
              <SelectItem value="silver">{t("pf-ma-level-silver")}</SelectItem>
              <SelectItem value="gold">{t("pf-ma-level-gold")}</SelectItem>
              <SelectItem value="platinum">{t("pf-ma-level-platinum")}</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={() => listQ.refetch()} disabled={listQ.isFetching}>
            <RefreshCw className={`size-3.5 mr-1 ${listQ.isFetching ? "animate-spin" : ""}`} />
            {t("refresh")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">{t("pf-ma-col-company")}</TableHead>
                  <TableHead className="text-xs">{t("pf-ma-col-country")}</TableHead>
                  <TableHead className="text-xs">{t("email")}</TableHead>
                  <TableHead className="text-xs">{t("pf-ma-col-verification")}</TableHead>
                  <TableHead className="text-xs text-right">{t("pf-ma-col-rating")}</TableHead>
                  <TableHead className="text-xs text-right">{t("pf-ma-col-total-posts")}</TableHead>
                  <TableHead className="text-xs text-right">{t("pf-ma-col-deals")}</TableHead>
                  <TableHead className="text-xs">{t("pf-ma-col-verified-at")}</TableHead>
                  <TableHead className="text-xs text-right">{t("actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listQ.isLoading ? (
                  <TableRow><TableCell colSpan={9} className="text-center text-xs text-muted-foreground py-8">
                    <Loader2 className="size-4 animate-spin inline mr-2" />
                    {t("pf-ma-loading")}
                  </TableCell></TableRow>
                ) : rows.length === 0 ? (
                  <TableRow><TableCell colSpan={9} className="text-center text-xs text-muted-foreground py-8">{t("no_results")}</TableCell></TableRow>
                ) : (
                  rows.map((r) => (
                    <TableRow key={r.id} className="hover:bg-muted/40">
                      <TableCell className="text-xs font-medium max-w-[200px] truncate" title={r.company_name ?? ""}>
                        {r.company_name ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs">{r.company_country ?? "—"}</TableCell>
                      <TableCell className="text-xs max-w-[200px] truncate" title={r.company_email ?? ""}>{r.company_email ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-xs capitalize ${VERIFICATION_TONE[r.verification_level] ?? ""}`}>
                          {r.verification_level}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-right tabular">
                        {r.rating_average.toFixed(1)} ({r.rating_count})
                      </TableCell>
                      <TableCell className="text-xs text-right tabular">{r.total_posts}</TableCell>
                      <TableCell className="text-xs text-right tabular">{r.successful_deals}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{formatDate(r.verified_at)}</TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button size="sm" variant="outline" onClick={() => {
                            setDialogRow(r);
                            setDialogLevel(r.verification_level === "none" ? "bronze" : r.verification_level);
                            setDialogReason("");
                          }}>
                            <ShieldCheck className="size-3.5 mr-1" />
                            {t("pf-ma-action-verify")}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!dialogRow} onOpenChange={(o) => !o && setDialogRow(null)}>
        <DialogContent className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
            <DialogTitle>{t("pf-ma-dialog-verify-title")}</DialogTitle>
            <DialogDescription>
              {t("pf-ma-dialog-verify-desc")} — <span className="font-medium">{dialogRow?.company_name}</span>
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("pf-ma-label-set-level")}</Label>
              <Select value={dialogLevel} onValueChange={setDialogLevel}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("pf-ma-level-none")}</SelectItem>
                  <SelectItem value="bronze">{t("pf-ma-level-bronze")}</SelectItem>
                  <SelectItem value="silver">{t("pf-ma-level-silver")}</SelectItem>
                  <SelectItem value="gold">{t("pf-ma-level-gold")}</SelectItem>
                  <SelectItem value="platinum">{t("pf-ma-level-platinum")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("pf-ma-label-reason")}</Label>
              <Input value={dialogReason} onChange={(e) => setDialogReason(e.target.value)}
                placeholder={t("pf-ma-reason-placeholder")} />
            </div>
            {dialogRow && (
              <div className="text-xs text-muted-foreground space-y-0.5 pt-2 border-t">
                <div>{t("pf-ma-col-country")}: {dialogRow.company_country ?? "—"}</div>
                <div>{t("email")}: {dialogRow.company_email ?? "—"}</div>
                <div>{t("pf-ma-col-rating")}: {dialogRow.rating_average.toFixed(1)} ({dialogRow.rating_count})</div>
                <div>{t("pf-ma-col-total-posts")}: {dialogRow.total_posts}</div>
                <div>{t("pf-ma-col-deals")}: {dialogRow.successful_deals}</div>
                {dialogRow.website && <div>Web: <a href={dialogRow.website} target="_blank" rel="noopener noreferrer" className="text-primary underline">{dialogRow.website}</a></div>}
              </div>
            )}
          </div>
          <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4 gap-2">
            <Button variant="outline" onClick={() => dialogRow && verifyMut.mutate({ partnerId: dialogRow.partner_id, action: "reject", reason: dialogReason })}
              disabled={verifyMut.isPending}>
              <XCircle className="size-3.5 mr-1 text-red-600" />
              {t("reject")}
            </Button>
            <Button onClick={() => dialogRow && verifyMut.mutate({ partnerId: dialogRow.partner_id, action: "approve", level: dialogLevel, reason: dialogReason })}
              disabled={verifyMut.isPending}>
              <CheckCircle2 className="size-3.5 mr-1" />
              {t("approve")}
            </Button>
            <Button variant="secondary" onClick={() => dialogRow && verifyMut.mutate({ partnerId: dialogRow.partner_id, action: "set_level", level: dialogLevel, reason: dialogReason })}
              disabled={verifyMut.isPending}>
              {t("pf-ma-action-set-level")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. REVIEWS MODERATION TAB
// ═══════════════════════════════════════════════════════════════════════════
interface AdminReview {
  id: string;
  reviewer_partner_id: string;
  reviewed_partner_id: string;
  post_id: string | null;
  rating: number;
  review_text: string | null;
  response_text: string | null;
  response_at: string | null;
  is_public: boolean;
  is_flagged: boolean;
  flagged_by: string | null;
  flagged_reason: string | null;
  flagged_at: string | null;
  created_at: string;
  reviewer_name: string | null;
  reviewed_name: string | null;
  reviewed_country: string | null;
}

function ReviewsTab() {
  const t = useT();
  const qc = useQueryClient();
  const [flaggedFilter, setFlaggedFilter] = React.useState<string>("true");

  const listQ = useQuery<{ items: AdminReview[]; total: number }>({
    queryKey: ["admin-marketplace-reviews", flaggedFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "100" });
      if (flaggedFilter !== "all") params.set("flagged", flaggedFilter);
      const r = await fetch(`/api/admin/marketplace/reviews?${params}`);
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(e.error || "Failed to load reviews.");
      }
      return r.json();
    },
  });

  const actionMut = useMutation({
    mutationFn: async ({ reviewId, action }: { reviewId: string; action: string }) => {
      const r = await fetch("/api/admin/marketplace/reviews", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ review_id: reviewId, action }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(e.error || "Action failed.");
      }
      return r.json();
    },
    onSuccess: (_d, vars) => {
      const labels: Record<string, string> = {
        hide: t("pf-ma-toast-review-hidden"),
        show: t("pf-ma-toast-review-shown"),
        flag: t("pf-ma-toast-review-flagged"),
        unflag: t("pf-ma-toast-review-unflagged"),
      };
      toast.success(labels[vars.action] || t("pf-ma-toast-done"));
      qc.invalidateQueries({ queryKey: ["admin-marketplace-reviews"] });
      qc.invalidateQueries({ queryKey: ["admin-marketplace-stats"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: async (reviewId: string) => {
      const r = await fetch(`/api/admin/marketplace/reviews?id=${encodeURIComponent(reviewId)}`, { method: "DELETE" });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(e.error || "Delete failed.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("pf-ma-toast-review-deleted"));
      qc.invalidateQueries({ queryKey: ["admin-marketplace-reviews"] });
      qc.invalidateQueries({ queryKey: ["admin-marketplace-stats"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reviews = listQ.data?.items ?? [];

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="p-3 flex flex-wrap items-center gap-2">
          <Select value={flaggedFilter} onValueChange={setFlaggedFilter}>
            <SelectTrigger className="w-[180px]"><SelectValue placeholder={t("pf-ma-filter-flagged")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="true">{t("pf-ma-flagged-only")}</SelectItem>
              <SelectItem value="false">{t("pf-ma-unflagged-only")}</SelectItem>
              <SelectItem value="all">{t("all")}</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={() => listQ.refetch()} disabled={listQ.isFetching}>
            <RefreshCw className={`size-3.5 mr-1 ${listQ.isFetching ? "animate-spin" : ""}`} />
            {t("refresh")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">{t("pf-ma-col-rating")}</TableHead>
                  <TableHead className="text-xs">{t("pf-ma-col-reviewer")}</TableHead>
                  <TableHead className="text-xs">{t("pf-ma-col-reviewed")}</TableHead>
                  <TableHead className="text-xs">{t("pf-ma-col-review-text")}</TableHead>
                  <TableHead className="text-xs">{t("pf-ma-col-flags")}</TableHead>
                  <TableHead className="text-xs">{t("pf-ma-col-visibility")}</TableHead>
                  <TableHead className="text-xs">{t("date")}</TableHead>
                  <TableHead className="text-xs text-right">{t("actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listQ.isLoading ? (
                  <TableRow><TableCell colSpan={8} className="text-center text-xs text-muted-foreground py-8">
                    <Loader2 className="size-4 animate-spin inline mr-2" />
                    {t("pf-ma-loading")}
                  </TableCell></TableRow>
                ) : reviews.length === 0 ? (
                  <TableRow><TableCell colSpan={8} className="text-center text-xs text-muted-foreground py-8">{t("no_results")}</TableCell></TableRow>
                ) : (
                  reviews.map((r) => (
                    <TableRow key={r.id} className="hover:bg-muted/40">
                      <TableCell>
                        <Badge variant="outline" className="text-xs tabular">
                          ★ {r.rating}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs max-w-[140px] truncate" title={r.reviewer_name ?? ""}>
                        {r.reviewer_name ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs max-w-[140px] truncate" title={r.reviewed_name ?? ""}>
                        {r.reviewed_name ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs max-w-[280px] truncate" title={r.review_text ?? ""}>
                        {r.review_text ?? "—"}
                      </TableCell>
                      <TableCell>
                        {r.is_flagged ? (
                          <div className="text-xs">
                            <Badge variant="outline" className="text-red-700 dark:text-red-400">
                              <Flag className="size-3 mr-1" />
                              {t("pf-ma-flagged")}
                            </Badge>
                            {r.flagged_by && (
                              <div className="text-muted-foreground mt-0.5">by {r.flagged_by}</div>
                            )}
                            {r.flagged_reason && (
                              <div className="text-muted-foreground truncate max-w-[180px]" title={r.flagged_reason}>
                                {r.flagged_reason}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-xs ${r.is_public ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300"}`}>
                          {r.is_public ? t("pf-ma-visible") : t("pf-ma-hidden")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{formatDate(r.created_at)}</TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          {r.is_flagged ? (
                            <Button size="icon" variant="ghost" className="size-7" title={t("pf-ma-action-unflag")}
                              onClick={() => actionMut.mutate({ reviewId: r.id, action: "unflag" })}
                              disabled={actionMut.isPending}>
                              <CheckCircle2 className="size-3.5 text-emerald-600" />
                            </Button>
                          ) : (
                            <Button size="icon" variant="ghost" className="size-7" title={t("pf-ma-action-flag")}
                              onClick={() => actionMut.mutate({ reviewId: r.id, action: "flag" })}
                              disabled={actionMut.isPending}>
                              <Flag className="size-3.5 text-amber-600" />
                            </Button>
                          )}
                          {r.is_public ? (
                            <Button size="icon" variant="ghost" className="size-7" title={t("pf-ma-action-hide")}
                              onClick={() => actionMut.mutate({ reviewId: r.id, action: "hide" })}
                              disabled={actionMut.isPending}>
                              <XCircle className="size-3.5 text-amber-600" />
                            </Button>
                          ) : (
                            <Button size="icon" variant="ghost" className="size-7" title={t("pf-ma-action-show")}
                              onClick={() => actionMut.mutate({ reviewId: r.id, action: "show" })}
                              disabled={actionMut.isPending}>
                              <CheckCircle2 className="size-3.5 text-emerald-600" />
                            </Button>
                          )}
                          <Button size="icon" variant="ghost" className="size-7" title={t("delete")}
                            onClick={() => {
                              if (typeof window !== "undefined" && window.confirm(t("confirm_delete"))) {
                                deleteMut.mutate(r.id);
                              }
                            }}
                            disabled={deleteMut.isPending}>
                            <Trash2 className="size-3.5 text-red-600" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. CATEGORIES MANAGEMENT TAB
// ═══════════════════════════════════════════════════════════════════════════
interface CategoryRow {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  icon: string | null;
  sort_order: number;
  is_featured: boolean;
  is_active: boolean;
  created_at: string;
}

function CategoriesTab() {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = React.useState<CategoryRow | null>(null);
  const [creating, setCreating] = React.useState(false);

  const listQ = useQuery<{ items: CategoryRow[] }>({
    queryKey: ["admin-marketplace-categories"],
    queryFn: async () => {
      const r = await fetch("/api/admin/marketplace/categories");
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(e.error || "Failed to load categories.");
      }
      return r.json();
    },
  });

  const upsertMut = useMutation({
    mutationFn: async (vars: { id?: string; body: Record<string, unknown> }) => {
      const url = vars.id
        ? `/api/admin/marketplace/categories?id=${encodeURIComponent(vars.id)}`
        : "/api/admin/marketplace/categories";
      const method = vars.id ? "PUT" : "POST";
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars.body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(e.error || "Save failed.");
      }
      return r.json();
    },
    onSuccess: (_d, vars) => {
      toast.success(vars.id ? t("pf-ma-toast-category-updated") : t("pf-ma-toast-category-created"));
      qc.invalidateQueries({ queryKey: ["admin-marketplace-categories"] });
      setEditing(null);
      setCreating(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/admin/marketplace/categories?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(e.error || "Delete failed.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("pf-ma-toast-category-deleted"));
      qc.invalidateQueries({ queryKey: ["admin-marketplace-categories"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleFeaturedMut = useMutation({
    mutationFn: async ({ id, current }: { id: string; current: boolean }) => {
      const r = await fetch(`/api/admin/marketplace/categories?id=${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_featured: !current }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(e.error || "Toggle failed.");
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-marketplace-categories"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const items = listQ.data?.items ?? [];

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="p-3 flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">{t("pf-ma-categories-desc")}</p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => listQ.refetch()} disabled={listQ.isFetching}>
              <RefreshCw className={`size-3.5 mr-1 ${listQ.isFetching ? "animate-spin" : ""}`} />
              {t("refresh")}
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-3.5 mr-1" />
              {t("pf-ma-action-new-category")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">{t("name")}</TableHead>
                  <TableHead className="text-xs">Slug</TableHead>
                  <TableHead className="text-xs">Icon</TableHead>
                  <TableHead className="text-xs text-right">{t("pf-ma-col-sort")}</TableHead>
                  <TableHead className="text-xs">{t("pf-ma-col-featured")}</TableHead>
                  <TableHead className="text-xs">{t("status")}</TableHead>
                  <TableHead className="text-xs">{t("pf-ma-col-created")}</TableHead>
                  <TableHead className="text-xs text-right">{t("actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listQ.isLoading ? (
                  <TableRow><TableCell colSpan={8} className="text-center text-xs text-muted-foreground py-8">
                    <Loader2 className="size-4 animate-spin inline mr-2" />
                    {t("pf-ma-loading")}
                  </TableCell></TableRow>
                ) : items.length === 0 ? (
                  <TableRow><TableCell colSpan={8} className="text-center text-xs text-muted-foreground py-8">{t("no_results")}</TableCell></TableRow>
                ) : (
                  items.map((c) => (
                    <TableRow key={c.id} className="hover:bg-muted/40">
                      <TableCell className="text-xs font-medium">{c.name}</TableCell>
                      <TableCell className="text-xs font-mono text-muted-foreground">{c.slug}</TableCell>
                      <TableCell className="text-xs">{c.icon ?? "—"}</TableCell>
                      <TableCell className="text-xs text-right tabular">{c.sort_order}</TableCell>
                      <TableCell>
                        <button
                          type="button"
                          className="inline-flex"
                          title={c.is_featured ? t("pf-ma-action-unfeature") : t("pf-ma-action-feature")}
                          onClick={() => toggleFeaturedMut.mutate({ id: c.id, current: c.is_featured })}
                        >
                          <Badge variant="outline" className={`text-xs cursor-pointer ${c.is_featured ? "border-primary/30 bg-primary/10 text-primary" : "border-slate-400/30 bg-slate-400/10 text-slate-700 dark:text-slate-300"}`}>
                            {c.is_featured ? <Sparkles className="size-3 mr-1" /> : null}
                            {c.is_featured ? t("yes") : t("no")}
                          </Badge>
                        </button>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-xs ${c.is_active ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300"}`}>
                          {c.is_active ? t("active") : t("inactive")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{formatDate(c.created_at)}</TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setEditing(c)} title={t("edit")}>
                            {t("edit")}
                          </Button>
                          <Button size="icon" variant="ghost" className="size-7" title={t("delete")}
                            onClick={() => {
                              if (typeof window !== "undefined" && window.confirm(`${t("pf-ma-confirm-delete-category")} ${c.name}?`)) {
                                deleteMut.mutate(c.id);
                              }
                            }}
                            disabled={deleteMut.isPending}>
                            <Trash2 className="size-3.5 text-red-600" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <CategoryDialog
        open={creating || !!editing}
        category={editing}
        onClose={() => { setEditing(null); setCreating(false); }}
        onSubmit={(body) => {
          if (editing) upsertMut.mutate({ id: editing.id, body });
          else upsertMut.mutate({ body });
        }}
        pending={upsertMut.isPending}
      />
    </div>
  );
}

function CategoryDialog({
  open, category, onClose, onSubmit, pending,
}: {
  open: boolean;
  category: CategoryRow | null;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const t = useT();
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [icon, setIcon] = React.useState("");
  const [sortOrder, setSortOrder] = React.useState(0);
  const [featured, setFeatured] = React.useState(false);
  const [active, setActive] = React.useState(true);

  React.useEffect(() => {
    if (category) {
      setName(category.name);
      setSlug(category.slug);
      setIcon(category.icon ?? "");
      setSortOrder(category.sort_order);
      setFeatured(category.is_featured);
      setActive(category.is_active);
    } else if (open) {
      setName(""); setSlug(""); setIcon(""); setSortOrder(0); setFeatured(false); setActive(true);
    }
  }, [category, open]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>{category ? t("pf-ma-dialog-edit-category") : t("pf-ma-dialog-new-category")}</DialogTitle>
          <DialogDescription>{t("pf-ma-categories-desc")}</DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("name")} *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Metals" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Slug</Label>
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="metals (auto-derived if blank)" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Icon (lucide name)</Label>
            <Input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="Package" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("pf-ma-col-sort")}</Label>
              <Input type="number" value={sortOrder} onChange={(e) => setSortOrder(Number(e.target.value) || 0)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("pf-ma-col-featured")}</Label>
              <Select value={featured ? "yes" : "no"} onValueChange={(v) => setFeatured(v === "yes")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="yes">{t("yes")}</SelectItem>
                  <SelectItem value="no">{t("no")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("status")}</Label>
            <Select value={active ? "active" : "inactive"} onValueChange={(v) => setActive(v === "active")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">{t("active")}</SelectItem>
                <SelectItem value="inactive">{t("inactive")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={onClose}>{t("cancel")}</Button>
          <Button
            disabled={pending || !name.trim()}
            onClick={() => {
              const body: Record<string, unknown> = {
                name: name.trim(),
                icon: icon.trim() || null,
                sort_order: sortOrder,
                is_featured: featured,
                is_active: active,
              };
              if (slug.trim()) body.slug = slug.trim();
              onSubmit(body);
            }}
          >
            {pending ? t("pf-sa-saving") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. BLACKLIST TAB
// ═══════════════════════════════════════════════════════════════════════════
interface BlacklistRow {
  id: string;
  partner_id: string;
  partner_name: string | null;
  reason: string | null;
  blocked_by: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  company_name: string | null;
  company_country: string | null;
  company_email: string | null;
  company_tenant_id: string | null;
}

function BlacklistTab() {
  const t = useT();
  const qc = useQueryClient();
  const [showInactive, setShowInactive] = React.useState(false);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [newPartnerId, setNewPartnerId] = React.useState("");
  const [newReason, setNewReason] = React.useState("");

  const listQ = useQuery<{ items: BlacklistRow[] }>({
    queryKey: ["admin-marketplace-blacklist", showInactive],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (showInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/admin/marketplace/blacklist?${params}`);
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(e.error || "Failed to load blacklist.");
      }
      return r.json();
    },
  });

  const addMut = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/marketplace/blacklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partner_id: newPartnerId, reason: newReason || null }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(e.error || "Add failed.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("pf-ma-toast-blacklist-added"));
      setNewPartnerId(""); setNewReason(""); setDialogOpen(false);
      qc.invalidateQueries({ queryKey: ["admin-marketplace-blacklist"] });
      qc.invalidateQueries({ queryKey: ["admin-marketplace-stats"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/admin/marketplace/blacklist?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(e.error || "Remove failed.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("pf-ma-toast-blacklist-removed"));
      qc.invalidateQueries({ queryKey: ["admin-marketplace-blacklist"] });
      qc.invalidateQueries({ queryKey: ["admin-marketplace-stats"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = listQ.data?.items ?? [];

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="p-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Button size="sm" variant={showInactive ? "default" : "outline"} onClick={() => setShowInactive((v) => !v)}>
              {showInactive ? t("pf-ma-show-active-only") : t("pf-ma-show-inactive")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => listQ.refetch()} disabled={listQ.isFetching}>
              <RefreshCw className={`size-3.5 mr-1 ${listQ.isFetching ? "animate-spin" : ""}`} />
              {t("refresh")}
            </Button>
          </div>
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus className="size-3.5 mr-1" />
            {t("pf-ma-action-add-to-blacklist")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">{t("pf-ma-col-company")}</TableHead>
                  <TableHead className="text-xs">{t("pf-ma-col-country")}</TableHead>
                  <TableHead className="text-xs">{t("email")}</TableHead>
                  <TableHead className="text-xs">{t("pf-ma-col-reason")}</TableHead>
                  <TableHead className="text-xs">{t("pf-ma-col-blocked-by")}</TableHead>
                  <TableHead className="text-xs">{t("status")}</TableHead>
                  <TableHead className="text-xs">{t("pf-ma-col-blocked-at")}</TableHead>
                  <TableHead className="text-xs text-right">{t("actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listQ.isLoading ? (
                  <TableRow><TableCell colSpan={8} className="text-center text-xs text-muted-foreground py-8">
                    <Loader2 className="size-4 animate-spin inline mr-2" />
                    {t("pf-ma-loading")}
                  </TableCell></TableRow>
                ) : rows.length === 0 ? (
                  <TableRow><TableCell colSpan={8} className="text-center text-xs text-muted-foreground py-8">{t("no_results")}</TableCell></TableRow>
                ) : (
                  rows.map((r) => (
                    <TableRow key={r.id} className="hover:bg-muted/40">
                      <TableCell className="text-xs font-medium max-w-[180px] truncate" title={r.company_name ?? r.partner_name ?? ""}>
                        {r.company_name ?? r.partner_name ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs">{r.company_country ?? "—"}</TableCell>
                      <TableCell className="text-xs max-w-[200px] truncate" title={r.company_email ?? ""}>{r.company_email ?? "—"}</TableCell>
                      <TableCell className="text-xs max-w-[240px] truncate" title={r.reason ?? ""}>{r.reason ?? "—"}</TableCell>
                      <TableCell className="text-xs">{r.blocked_by ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-xs ${r.active ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400" : "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300"}`}>
                          {r.active ? t("pf-ma-blocked") : t("pf-ma-removed")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{formatDate(r.created_at)}</TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          {r.active ? (
                            <Button size="sm" variant="outline" onClick={() => removeMut.mutate(r.id)}
                              disabled={removeMut.isPending}>
                              <XCircle className="size-3.5 mr-1 text-emerald-600" />
                              {t("pf-ma-action-unblock")}
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={(o) => !o && setDialogOpen(false)}>
        <DialogContent className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
            <DialogTitle>{t("pf-ma-dialog-blacklist-title")}</DialogTitle>
            <DialogDescription>{t("pf-ma-dialog-blacklist-desc")}</DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("pf-ma-label-partner-id")} *</Label>
              <Input value={newPartnerId} onChange={(e) => setNewPartnerId(e.target.value)}
                placeholder="UUID of the partner to block" />
              <p className="text-xs text-muted-foreground">{t("pf-ma-hint-partner-id")}</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("pf-ma-col-reason")}</Label>
              <Input value={newReason} onChange={(e) => setNewReason(e.target.value)}
                placeholder={t("pf-ma-reason-placeholder")} />
            </div>
          </div>
          <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t("cancel")}</Button>
            <Button disabled={addMut.isPending || !newPartnerId.trim()} onClick={() => addMut.mutate()}>
              <Ban className="size-3.5 mr-1" />
              {t("pf-ma-action-add-to-blacklist")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. STATISTICS TAB — recharts visualisations
// ═══════════════════════════════════════════════════════════════════════════
function StatsTab() {
  const t = useT();
  const statsQ = useQuery<StatsResponse>({
    queryKey: ["admin-marketplace-stats"],
    queryFn: async () => {
      const r = await fetch("/api/admin/marketplace/stats");
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(e.error || "Failed to load stats.");
      }
      return r.json();
    },
  });

  if (statsQ.isLoading) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" />
          {t("pf-ma-loading")}
        </CardContent>
      </Card>
    );
  }
  if (statsQ.error || !statsQ.data) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-destructive">
          {t("pf-ma-load-failed")}: {(statsQ.error as Error)?.message ?? ""}
        </CardContent>
      </Card>
    );
  }

  const data = statsQ.data;
  const pieData = Object.entries(data.posts_by_type).map(([name, value]) => ({ name, value }));
  const catData = data.top_categories;
  const countryData = data.top_countries;
  const companyData = data.top_companies;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button size="sm" variant="outline" onClick={() => statsQ.refetch()} disabled={statsQ.isFetching}>
          <RefreshCw className={`size-3.5 mr-1 ${statsQ.isFetching ? "animate-spin" : ""}`} />
          {t("refresh")}
        </Button>
      </div>

      {/* Posts + responses over time — two line charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingUp className="size-4 text-primary" />
              {t("pf-ma-chart-posts-over-time")}
            </CardTitle>
            <CardDescription className="text-xs">{t("pf-ma-chart-posts-over-time-desc")}</CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.posts_over_time} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
                  <XAxis dataKey="date" tick={AXIS_TICK_STYLE} stroke={GRID_STROKE} tickFormatter={(v: string) => v.slice(5)} />
                  <YAxis tick={AXIS_TICK_STYLE} stroke={GRID_STROKE} allowDecimals={false} width={32} />
                  <Tooltip content={<TimeTooltip label={t("pf-ma-chart-posts-over-time")} />} />
                  <Line type="monotone" dataKey="count" stroke={COPPER.primary} strokeWidth={1.5} dot={false} activeDot={{ r: 3, fill: COPPER.secondary }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <MessageSquare className="size-4 text-primary" />
              {t("pf-ma-chart-responses-over-time")}
            </CardTitle>
            <CardDescription className="text-xs">{t("pf-ma-chart-responses-over-time-desc")}</CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.responses_over_time} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
                  <XAxis dataKey="date" tick={AXIS_TICK_STYLE} stroke={GRID_STROKE} tickFormatter={(v: string) => v.slice(5)} />
                  <YAxis tick={AXIS_TICK_STYLE} stroke={GRID_STROKE} allowDecimals={false} width={32} />
                  <Tooltip content={<TimeTooltip label={t("pf-ma-chart-responses-over-time")} />} />
                  <Line type="monotone" dataKey="count" stroke={COPPER.secondary} strokeWidth={1.5} dot={false} activeDot={{ r: 3, fill: COPPER.tertiary }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Pie + bar */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("pf-ma-chart-by-type")}</CardTitle>
            <CardDescription className="text-xs">{t("pf-ma-chart-by-type-desc")}</CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="h-[260px]">
              {pieData.length === 0 ? (
                <ChartEmpty message={t("no_data")} />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={85} innerRadius={45} paddingAngle={2}>
                      {pieData.map((entry, i) => (
                        <Cell key={entry.name} fill={
                          [COPPER.primary, COPPER.secondary, COPPER.tertiary, COPPER.quaternary, COPPER.light][i % 5]
                        } />
                      ))}
                    </Pie>
                    <Tooltip content={<PieTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
            {pieData.length > 0 && (
              <div className="flex flex-wrap gap-3 justify-center mt-2 text-xs">
                {pieData.map((e, i) => (
                  <span key={e.name} className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm" style={{
                      background: [COPPER.primary, COPPER.secondary, COPPER.tertiary, COPPER.quaternary, COPPER.light][i % 5],
                    }} />
                    <span className="text-muted-foreground capitalize">{e.name}</span>
                    <span className="font-mono font-medium">{e.value}</span>
                  </span>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("pf-ma-chart-top-categories")}</CardTitle>
            <CardDescription className="text-xs">{t("pf-ma-chart-top-categories-desc")}</CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="h-[260px]">
              {catData.length === 0 ? (
                <ChartEmpty message={t("no_data")} />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={catData} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} horizontal={false} />
                    <XAxis type="number" tick={AXIS_TICK_STYLE} stroke={GRID_STROKE} allowDecimals={false} />
                    <YAxis type="category" dataKey="name" tick={AXIS_TICK_STYLE} stroke={GRID_STROKE} width={120} tickFormatter={(v: string) => v.length > 18 ? v.slice(0, 17) + "…" : v} />
                    <Tooltip content={<BarTooltip />} />
                    <Bar dataKey="count" fill={COPPER.secondary} radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Top countries + top companies */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("pf-ma-chart-top-countries")}</CardTitle>
            <CardDescription className="text-xs">{t("pf-ma-chart-top-countries-desc")}</CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="h-[260px]">
              {countryData.length === 0 ? (
                <ChartEmpty message={t("no_data")} />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={countryData} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} horizontal={false} />
                    <XAxis type="number" tick={AXIS_TICK_STYLE} stroke={GRID_STROKE} allowDecimals={false} />
                    <YAxis type="category" dataKey="country" tick={AXIS_TICK_STYLE} stroke={GRID_STROKE} width={60} />
                    <Tooltip content={<BarTooltip />} />
                    <Bar dataKey="count" fill={COPPER.primary} radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("pf-ma-chart-top-companies")}</CardTitle>
            <CardDescription className="text-xs">{t("pf-ma-chart-top-companies-desc")}</CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="h-[260px]">
              {companyData.length === 0 ? (
                <ChartEmpty message={t("no_data")} />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={companyData} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} horizontal={false} />
                    <XAxis type="number" tick={AXIS_TICK_STYLE} stroke={GRID_STROKE} allowDecimals={false} />
                    <YAxis type="category" dataKey="name" tick={AXIS_TICK_STYLE} stroke={GRID_STROKE} width={160} tickFormatter={(v: string) => v.length > 24 ? v.slice(0, 23) + "…" : v} />
                    <Tooltip content={<BarTooltip />} />
                    <Bar dataKey="posts" fill={COPPER.tertiary} radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ChartEmpty({ message }: { message: string }) {
  return (
    <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function TimeTooltip(props: TooltipProps<number, string> & { label?: string }) {
  const { active, payload } = props;
  const label = (props as any).label;
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload as { date: string; count: number };
  return (
    <div style={TOOLTIP_STYLE} className="px-3 py-2 space-y-0.5">
      <div className="text-muted-foreground">{p.date}</div>
      <div>
        <span className="text-muted-foreground">{label || "count"}: </span>
        <span className="font-mono text-foreground">{p.count}</span>
      </div>
    </div>
  );
}

function PieTooltip(props: TooltipProps<number, string>) {
  const { active, payload } = props;
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload as { name: string; value: number };
  return (
    <div style={TOOLTIP_STYLE} className="px-3 py-2 space-y-0.5">
      <div className="font-medium text-foreground capitalize">{p.name}</div>
      <div>
        <span className="text-muted-foreground">count: </span>
        <span className="font-mono text-foreground">{p.value}</span>
      </div>
    </div>
  );
}

function BarTooltip(props: TooltipProps<number, string>) {
  const { active, payload } = props;
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload as Record<string, unknown>;
  const labelKey = Object.keys(p).find((k) => k !== "count" && k !== "value" && k !== "posts");
  const valueKey = (Object.keys(p).find((k) => k === "count" || k === "value" || k === "posts")) || "count";
  return (
    <div style={TOOLTIP_STYLE} className="px-3 py-2 space-y-0.5">
      <div className="text-foreground font-medium">{String(p[labelKey ?? "name"] ?? "—")}</div>
      <div>
        <span className="text-muted-foreground">{valueKey}: </span>
        <span className="font-mono text-foreground">{String(p[valueKey])}</span>
      </div>
    </div>
  );
}
