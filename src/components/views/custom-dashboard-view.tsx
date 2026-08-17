"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  LayoutDashboard,
  GripVertical,
  X,
  Plus,
  BarChart3,
  Activity,
  Zap,
  GitBranch,
  CheckSquare,
  Newspaper,
  Ship,
  FileSearch,
  DollarSign,
  Handshake,
  TrendingUp,
  Receipt,
  ArrowUpRight,
  ArrowDownRight,
  Clock,
  Plane,
  Anchor,
  Truck,
  Train,
  AlertTriangle,
  Package,
  Users,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Pencil,
} from "lucide-react";
import { useI18nStore } from "@/lib/i18n/store";
import { t } from "@/lib/i18n/dictionaries";
import { useAppStore } from "@/lib/store/app-store";
import { KpiCard } from "@/components/common/kpi-card";
import { fmtMoney, fmtNumber, fmtRelative } from "@/lib/utils/format";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";

// ─── Widget Types ──────────────────────────────────────────────────────────

export type WidgetType =
  | "kpi"
  | "revenue-chart"
  | "recent-activity"
  | "quick-actions"
  | "pipeline"
  | "tasks"
  | "market-news"
  | "customs"
  | "logistics";

export interface DashboardWidget {
  id: string;
  type: WidgetType;
}

const WIDGET_META: Record<
  WidgetType,
  { icon: React.ElementType; labelKey: string; color: string }
> = {
  kpi: { icon: LayoutDashboard, labelKey: "widget-kpi", color: "text-emerald-600 dark:text-emerald-400" },
  "revenue-chart": { icon: BarChart3, labelKey: "widget-revenue", color: "text-teal-600 dark:text-teal-400" },
  "recent-activity": { icon: Activity, labelKey: "widget-recent-activity", color: "text-amber-600 dark:text-amber-400" },
  "quick-actions": { icon: Zap, labelKey: "widget-quick-actions", color: "text-violet-600 dark:text-violet-400" },
  pipeline: { icon: GitBranch, labelKey: "widget-pipeline", color: "text-sky-600 dark:text-sky-400" },
  tasks: { icon: CheckSquare, labelKey: "widget-tasks", color: "text-rose-600 dark:text-rose-400" },
  "market-news": { icon: Newspaper, labelKey: "widget-news", color: "text-orange-600 dark:text-orange-400" },
  customs: { icon: FileSearch, labelKey: "widget-customs", color: "text-cyan-600 dark:text-cyan-400" },
  logistics: { icon: Ship, labelKey: "widget-logistics", color: "text-indigo-600 dark:text-indigo-400" },
};

const DEFAULT_WIDGETS: DashboardWidget[] = [
  { id: "w-kpi", type: "kpi" },
  { id: "w-revenue", type: "revenue-chart" },
  { id: "w-activity", type: "recent-activity" },
  { id: "w-actions", type: "quick-actions" },
  { id: "w-pipeline", type: "pipeline" },
  { id: "w-tasks", type: "tasks" },
];

const STORAGE_KEY = "velos-custom-dashboard";

// ─── API Types ─────────────────────────────────────────────────────────────

interface DashboardInsights {
  kpis: {
    partners_total: number;
    partners_active: number;
    deals_open: number;
    deals_won_value: number;
    pipeline_value: number;
    offers_pending: number;
    low_stock_count: number;
    invoices_outstanding: number;
    inventory_movements_30d: number;
  };
  deals_by_stage: { stage: string; count: number; value: number }[];
  offers_last_30d: { date: string; count: number }[];
  revenue_last_30d: { date: string; value: number }[];
  recent_activity: {
    id: string;
    action: string;
    entity_type: string | null;
    entity_id: string | null;
    username: string | null;
    created_at: string;
    details: Record<string, unknown> | null;
  }[];
  top_partners: { id: string; name: string; deal_value: number }[];
  low_stock_products: { id: string; name: string; sku: string; stock: number; reorder_level: number }[];
}

interface MarketArticle {
  id: string;
  title: string;
  summary: string;
  source: string;
  category: string;
  timestamp: string;
  impact: "positive" | "negative" | "neutral";
}

interface HSCategory {
  code: string;
  description: string;
  dutyRate: string;
  vatRate: string;
  region: string;
}

interface CustomsRegulation {
  id: string;
  title: string;
  country: string;
  effectiveDate: string;
  type: string;
  impact: string;
  description: string;
}

interface Shipment {
  id: string;
  trackingNumber: string;
  status: "in_transit" | "customs" | "delivered" | "loading" | "delayed";
  origin: string;
  destination: string;
  carrier: string;
  mode: "sea" | "air" | "road" | "rail";
  eta: string;
  progress: number;
  currentLocation: string;
  customsStatus: "cleared" | "pending" | "inspection" | "held";
}

// ─── Sortable Widget Wrapper ───────────────────────────────────────────────

function SortableWidget({
  widget,
  editMode,
  onRemove,
  children,
}: {
  widget: DashboardWidget;
  editMode: boolean;
  onRemove: (id: string) => void;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: widget.id, disabled: !editMode });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const meta = WIDGET_META[widget.type];
  const Icon = meta.icon;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative ${isDragging ? "z-50 opacity-80" : ""} ${
        editMode ? "ring-2 ring-primary/20 rounded-xl" : ""
      }`}
    >
      {/* Edit mode overlay controls */}
      {editMode && (
        <div className="absolute -top-2 -right-2 z-10 flex items-center gap-1">
          <button
            onClick={() => onRemove(widget.id)}
            className="size-7 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow-soft-md hover:scale-110 smooth"
            aria-label="Remove widget"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      {editMode && (
        <div
          {...attributes}
          {...listeners}
          className="absolute -top-2 -left-2 z-10 size-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center cursor-grab active:cursor-grabbing shadow-soft-md hover:scale-110 smooth"
          aria-label="Drag handle"
        >
          <GripVertical className="size-4" />
        </div>
      )}
      {children}
    </div>
  );
}

// ─── Individual Widget Content ─────────────────────────────────────────────

function KpiWidgetContent() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const locale = useI18nStore((s) => s.locale);

  const { data, isLoading } = useQuery<DashboardInsights>({
    queryKey: ["dashboard", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/dashboard"));
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
    );
  }

  const kpis = data
    ? [
        {
          label: "Pipeline Value",
          value: fmtMoney(data.kpis.pipeline_value),
          icon: TrendingUp,
          variant: "positive" as const,
        },
        {
          label: "Deals Won",
          value: fmtMoney(data.kpis.deals_won_value),
          icon: DollarSign,
          variant: "positive" as const,
        },
        {
          label: "Open Deals",
          value: fmtNumber(data.kpis.deals_open),
          icon: Handshake,
          variant: "default" as const,
        },
        {
          label: "Pending Offers",
          value: fmtNumber(data.kpis.offers_pending),
          icon: Receipt,
          variant: "warning" as const,
        },
        {
          label: "Active Partners",
          value: fmtNumber(data.kpis.partners_active),
          icon: Users,
          variant: "default" as const,
        },
        {
          label: "Outstanding Invoices",
          value: fmtNumber(data.kpis.invoices_outstanding),
          icon: AlertTriangle,
          variant: "warning" as const,
        },
        {
          label: "Low Stock",
          value: fmtNumber(data.kpis.low_stock_count),
          icon: Package,
          variant: "warning" as const,
        },
        {
          label: "Inventory Movements (30d)",
          value: fmtNumber(data.kpis.inventory_movements_30d),
          icon: Activity,
          variant: "default" as const,
        },
      ]
    : [];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {kpis.map((kpi, i) => (
        <KpiCard
          key={i}
          label={kpi.label}
          value={kpi.value}
          icon={kpi.icon}
          variant={kpi.variant}
        />
      ))}
    </div>
  );
}

function RevenueChartWidgetContent() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const locale = useI18nStore((s) => s.locale);

  const { data, isLoading } = useQuery<DashboardInsights>({
    queryKey: ["dashboard", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/dashboard"));
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  if (isLoading) {
    return <Skeleton className="h-64 w-full rounded-xl" />;
  }

  // Use real revenue_last_30d data from API, fallback to empty
  const chartData = (data?.revenue_last_30d ?? []).map((d) => ({
    month: new Date(d.date).toLocaleDateString("en-US", { day: "numeric", month: "short" }),
    revenue: d.value,
  }));

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="revenueGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.3} />
              <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="month"
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-lg)",
              fontSize: 12,
            }}
            formatter={(value: number) => [fmtMoney(value), t(locale, "total-revenue")]}
          />
          <Area
            type="monotone"
            dataKey="revenue"
            stroke="var(--chart-1)"
            strokeWidth={2.5}
            fill="url(#revenueGrad)"
            dot={false}
            activeDot={{ r: 5, fill: "var(--chart-1)", strokeWidth: 2, stroke: "var(--card)" }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function RecentActivityWidgetContent() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const locale = useI18nStore((s) => s.locale);

  const { data, isLoading } = useQuery<DashboardInsights>({
    queryKey: ["dashboard", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/dashboard"));
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 rounded-lg" />
        ))}
      </div>
    );
  }

  // Map real API recent_activity entries to the widget shape
  const activities = (data?.recent_activity ?? []).map((a) => ({
    id: a.id,
    action: a.action,
    entity: [a.entity_type, a.entity_id].filter(Boolean).join(" ") || "—",
    by: a.username || "system",
    at: a.created_at,
  }));

  function actionTone(action: string): string {
    const a = action.toLowerCase();
    if (a.includes("delete") || a.includes("remove")) return "text-destructive";
    if (a.includes("approve") || a.includes("confirm") || a.includes("complete") || a.includes("won") || a.includes("win"))
      return "text-success";
    if (a.includes("create") || a.includes("add")) return "text-foreground";
    return "text-muted-foreground";
  }

  function actionBg(action: string): string {
    const a = action.toLowerCase();
    if (a.includes("delete") || a.includes("remove")) return "bg-destructive/10";
    if (a.includes("approve") || a.includes("confirm") || a.includes("complete") || a.includes("won") || a.includes("win"))
      return "bg-success/10";
    if (a.includes("create") || a.includes("add")) return "bg-primary/10";
    return "bg-muted/60";
  }

  return (
    <ScrollArea className="max-h-80">
      <div className="space-y-2">
        {activities.map((a) => (
          <div
            key={a.id}
            className="flex items-center gap-3 rounded-lg p-2.5 hover:bg-muted/50 smooth"
          >
            <div
              className={`size-8 rounded-lg flex items-center justify-center shrink-0 ${actionBg(a.action)}`}
            >
              <span className={`text-xs font-semibold ${actionTone(a.action)}`}>
                {a.action.charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">
                <span className={actionTone(a.action)}>{a.action}</span>{" "}
                <span className="text-foreground">{a.entity}</span>
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {a.by} &middot; {fmtRelative(a.at)}
              </p>
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

function QuickActionsWidgetContent() {
  const locale = useI18nStore((s) => s.locale);
  const setView = useAppStore((s) => s.setView);

  const actions = [
    { label: t(locale, "new-offer"), icon: FileSearch, view: "offers" as const, color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20" },
    { label: t(locale, "new-deal"), icon: Handshake, view: "deals" as const, color: "bg-teal-500/10 text-teal-600 dark:text-teal-400 hover:bg-teal-500/20" },
    { label: t(locale, "new-invoice"), icon: Receipt, view: "invoices" as const, color: "bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20" },
    { label: t(locale, "add-partner"), icon: Activity, view: "partners" as const, color: "bg-sky-500/10 text-sky-600 dark:text-sky-400 hover:bg-sky-500/20" },
    { label: t(locale, "import-data"), icon: Package, view: "products" as const, color: "bg-violet-500/10 text-violet-600 dark:text-violet-400 hover:bg-violet-500/20" },
    { label: t(locale, "export-report"), icon: BarChart3, view: "dashboard" as const, color: "bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20" },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {actions.map((a) => {
        const Icon = a.icon;
        return (
          <button
            key={a.label}
            onClick={() => setView(a.view)}
            className={`flex flex-col items-center gap-2 rounded-xl p-4 smooth ${a.color} transition-all`}
          >
            <Icon className="size-5" />
            <span className="text-xs font-semibold text-center leading-tight">{a.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function PipelineWidgetContent() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const locale = useI18nStore((s) => s.locale);

  const { data, isLoading } = useQuery<DashboardInsights>({
    queryKey: ["dashboard", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/dashboard"));
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  if (isLoading) {
    return (
      <div className="flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-20 flex-1 rounded-lg" />
        ))}
      </div>
    );
  }

  // Build pipeline stages from real API data (deals_by_stage)
  const stageData = data?.deals_by_stage ?? [];
  const stages: Record<string, number> = {};
  for (const s of stageData) {
    stages[s.stage] = s.count;
  }
  const total = Object.values(stages).reduce((s, v) => s + v, 0);
  const stageColors = [
    "bg-muted-foreground/25",
    "bg-muted-foreground/50",
    "bg-chart-2/60",
    "bg-chart-2",
    "bg-chart-1",
  ];

  const stageEntries = Object.entries(stages);

  return (
    <div className="space-y-4">
      {/* Horizontal funnel */}
      <div className="flex items-end gap-1 h-28">
        {stageEntries.map(([name, count], i) => {
          const pct = total > 0 ? (count / total) * 100 : 0;
          const height = Math.max(pct, 8);
          return (
            <div key={name} className="flex-1 flex flex-col items-center gap-1.5">
              <div className="w-full flex items-end justify-center" style={{ height: "80px" }}>
                <div
                  className={`w-full rounded-t-lg ${stageColors[i] ?? "bg-chart-1"} smooth`}
                  style={{ height: `${height}%` }}
                />
              </div>
              <span className="text-[10px] font-semibold text-muted-foreground truncate w-full text-center">
                {name}
              </span>
              <span className="text-sm font-bold tabular">{fmtNumber(count)}</span>
            </div>
          );
        })}
      </div>
      <div className="text-center">
        <span className="text-xs text-muted-foreground">
          {t(locale, "active-deals")}: {total}
        </span>
      </div>
    </div>
  );
}

function TasksWidgetContent() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const locale = useI18nStore((s) => s.locale);

  // Fetch real tasks from /api/tasks
  const { data: tasksData, isLoading } = useQuery({
    queryKey: ["dashboard-tasks", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/tasks"));
      if (!r.ok) throw new Error("Failed");
      const d = await r.json();
      return (d.items || d || []) as Array<{ id: string; done: boolean; priority: string; due_date: string | null }>;
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-10 rounded-lg" />
        ))}
      </div>
    );
  }

  const allTasks = tasksData || [];
  const tasks = {
    total: allTasks.length,
    completed: allTasks.filter((t) => t.done).length,
    inProgress: allTasks.filter((t) => !t.done).length,
    overdue: allTasks.filter((t) => !t.done && t.due_date && new Date(t.due_date) < new Date()).length,
  };
  const pct = tasks.total > 0 ? Math.round((tasks.completed / tasks.total) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{t(locale, "completed")}</span>
        <span className="text-sm font-bold tabular">{pct}%</span>
      </div>
      <Progress value={pct} className="h-2.5" />
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg bg-primary/10 p-3 text-center">
          <p className="text-lg font-bold tabular text-primary">{tasks.inProgress}</p>
          <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
            {t(locale, "active")}
          </p>
        </div>
        <div className="rounded-lg bg-success/10 p-3 text-center">
          <p className="text-lg font-bold tabular text-success">{tasks.completed}</p>
          <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
            {t(locale, "completed")}
          </p>
        </div>
        <div className="rounded-lg bg-destructive/10 p-3 text-center">
          <p className="text-lg font-bold tabular text-destructive">{tasks.overdue}</p>
          <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
            {t(locale, "failed")}
          </p>
        </div>
      </div>
    </div>
  );
}

function MarketNewsWidgetContent() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const locale = useI18nStore((s) => s.locale);

  const { data, isLoading } = useQuery<{
    articles: MarketArticle[];
    commodities: { name: string; price: number; change: number; trend: string }[];
  }>({
    queryKey: ["market-news", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/market-news"));
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    );
  }

  const articles = data?.articles?.slice(0, 5) ?? [];

  const impactStyles: Record<string, string> = {
    positive: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    negative: "bg-red-500/10 text-red-600 dark:text-red-400",
    neutral: "bg-muted/60 text-muted-foreground",
  };

  return (
    <ScrollArea className="max-h-80">
      <div className="space-y-2.5">
        {articles.map((a) => (
          <div
            key={a.id}
            className="rounded-lg p-3 hover:bg-muted/50 smooth"
          >
            <div className="flex items-start gap-2">
              <Badge
                variant="secondary"
                className={`text-[10px] font-semibold shrink-0 ${impactStyles[a.impact] ?? impactStyles.neutral}`}
              >
                {a.impact}
              </Badge>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-snug line-clamp-2">{a.title}</p>
                <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{a.summary}</p>
                <div className="flex items-center gap-2 mt-1.5 text-[10px] text-muted-foreground">
                  <span className="font-medium">{a.source}</span>
                  <span>&middot;</span>
                  <span>{fmtRelative(a.timestamp)}</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

function CustomsWidgetContent() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const locale = useI18nStore((s) => s.locale);

  const { data, isLoading } = useQuery<{
    hsCodes: HSCategory[];
    regulations: CustomsRegulation[];
  }>({
    queryKey: ["customs", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/customs"));
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    );
  }

  const hsCodes = data?.hsCodes?.slice(0, 4) ?? [];
  const regulations = data?.regulations?.slice(0, 3) ?? [];

  return (
    <ScrollArea className="max-h-80">
      <div className="space-y-3">
        {/* HS Codes */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            HS Codes
          </p>
          <div className="space-y-1.5">
            {hsCodes.map((hs) => (
              <div
                key={hs.code}
                className="flex items-center justify-between rounded-lg p-2.5 hover:bg-muted/50 smooth"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold tabular text-primary">{hs.code}</p>
                  <p className="text-[11px] text-muted-foreground truncate">{hs.description}</p>
                </div>
                <div className="text-right shrink-0 ml-3">
                  <p className="text-xs font-semibold tabular">{hs.dutyRate}</p>
                  <p className="text-[10px] text-muted-foreground">VAT {hs.vatRate}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
        {/* Regulations */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Regulations
          </p>
          <div className="space-y-1.5">
            {regulations.map((reg) => {
              const impactColor: Record<string, string> = {
                high: "bg-red-500/10 text-red-600 dark:text-red-400",
                medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                low: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
              };
              return (
                <div
                  key={reg.id}
                  className="rounded-lg p-2.5 hover:bg-muted/50 smooth"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Badge
                      variant="secondary"
                      className={`text-[10px] font-semibold ${impactColor[reg.impact] ?? impactColor.low}`}
                    >
                      {reg.impact}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">{reg.country}</span>
                  </div>
                  <p className="text-xs font-medium line-clamp-2">{reg.title}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Effective: {reg.effectiveDate}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}

function LogisticsWidgetContent() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const locale = useI18nStore((s) => s.locale);

  const { data, isLoading } = useQuery<{
    shipments: Shipment[];
    summary: Record<string, number>;
  }>({
    queryKey: ["logistics", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/logistics"));
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-lg" />
        ))}
      </div>
    );
  }

  const shipments = data?.shipments?.slice(0, 4) ?? [];
  const summary = data?.summary ?? {};

  const statusConfig: Record<
    string,
    { icon: React.ElementType; color: string; label: string }
  > = {
    in_transit: { icon: Anchor, color: "text-sky-600 dark:text-sky-400 bg-sky-500/10", label: "In Transit" },
    customs: { icon: FileSearch, color: "text-amber-600 dark:text-amber-400 bg-amber-500/10", label: "Customs" },
    delivered: { icon: CheckCircle2, color: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10", label: "Delivered" },
    loading: { icon: Package, color: "text-violet-600 dark:text-violet-400 bg-violet-500/10", label: "Loading" },
    delayed: { icon: AlertTriangle, color: "text-red-600 dark:text-red-400 bg-red-500/10", label: "Delayed" },
  };

  const modeIcons: Record<string, React.ElementType> = {
    sea: Anchor,
    air: Plane,
    road: Truck,
    rail: Train,
  };

  return (
    <ScrollArea className="max-h-80">
      {/* Summary badges */}
      <div className="flex flex-wrap gap-2 mb-3">
        {Object.entries(summary).map(([status, count]) => {
          const cfg = statusConfig[status];
          if (!cfg || count === 0) return null;
          const Icon = cfg.icon;
          return (
            <Badge
              key={status}
              variant="secondary"
              className={`text-[10px] font-semibold gap-1 ${cfg.color}`}
            >
              <Icon className="size-3" />
              {cfg.label}: {fmtNumber(count)}
            </Badge>
          );
        })}
      </div>
      {/* Shipment list */}
      <div className="space-y-2">
        {shipments.map((s) => {
          const cfg = statusConfig[s.status] ?? statusConfig.in_transit;
          const ModeIcon = modeIcons[s.mode] ?? Anchor;
          return (
            <div
              key={s.id}
              className="rounded-lg p-3 hover:bg-muted/50 smooth"
            >
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <ModeIcon className="size-3.5 text-muted-foreground" />
                  <span className="text-xs font-bold tabular">{s.trackingNumber}</span>
                </div>
                <Badge
                  variant="secondary"
                  className={`text-[10px] font-semibold ${cfg.color}`}
                >
                  {cfg.label}
                </Badge>
              </div>
              <div className="flex items-center gap-1 text-[11px] text-muted-foreground mb-2">
                <span className="truncate">{s.origin}</span>
                <ArrowUpRight className="size-3 shrink-0" />
                <span className="truncate">{s.destination}</span>
              </div>
              <div className="flex items-center gap-2">
                <Progress value={s.progress} className="h-1.5 flex-1" />
                <span className="text-[10px] font-bold tabular text-muted-foreground shrink-0">
                  {s.progress}%
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1.5">
                {s.currentLocation} &middot; ETA: {fmtRelative(s.eta)}
              </p>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

// ─── Widget Content Renderer ───────────────────────────────────────────────

function WidgetContent({ type }: { type: WidgetType }) {
  switch (type) {
    case "kpi":
      return <KpiWidgetContent />;
    case "revenue-chart":
      return <RevenueChartWidgetContent />;
    case "recent-activity":
      return <RecentActivityWidgetContent />;
    case "quick-actions":
      return <QuickActionsWidgetContent />;
    case "pipeline":
      return <PipelineWidgetContent />;
    case "tasks":
      return <TasksWidgetContent />;
    case "market-news":
      return <MarketNewsWidgetContent />;
    case "customs":
      return <CustomsWidgetContent />;
    case "logistics":
      return <LogisticsWidgetContent />;
    default:
      return null;
  }
}

// ─── Main Component ────────────────────────────────────────────────────────

export function CustomDashboardView() {
  const locale = useI18nStore((s) => s.locale);
  const setView = useAppStore((s) => s.setView);

  // ─── State ────────────────────────────────────────────────────────────
  const [editMode, setEditMode] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  // Load widgets from localStorage or use defaults
  const [widgets, setWidgets] = useState<DashboardWidget[]>(() => {
    if (typeof window === "undefined") return DEFAULT_WIDGETS;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as DashboardWidget[];
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // ignore
    }
    return DEFAULT_WIDGETS;
  });

  // Persist to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(widgets));
    } catch {
      // ignore
    }
  }, [widgets]);

  // ─── DnD Setup ────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      setWidgets((prev) => {
        const oldIndex = prev.findIndex((w) => w.id === active.id);
        const newIndex = prev.findIndex((w) => w.id === over.id);
        if (oldIndex === -1 || newIndex === -1) return prev;
        return arrayMove(prev, oldIndex, newIndex);
      });
    },
    []
  );

  // ─── Widget Management ────────────────────────────────────────────────
  const handleRemoveWidget = useCallback((id: string) => {
    setWidgets((prev) => prev.filter((w) => w.id !== id));
  }, []);

  const handleAddWidget = useCallback(
    (type: WidgetType) => {
      const id = `w-${type}-${Date.now()}`;
      setWidgets((prev) => [...prev, { id, type }]);
      setAddDialogOpen(false);
    },
    []
  );

  const handleResetDashboard = useCallback(() => {
    setWidgets(DEFAULT_WIDGETS);
    setEditMode(false);
  }, []);

  // Available widget types to add (not already on dashboard)
  const availableTypes = useMemo(() => {
    const existing = new Set(widgets.map((w) => w.type));
    return (Object.keys(WIDGET_META) as WidgetType[]).filter(
      (type) => !existing.has(type)
    );
  }, [widgets]);

  // Active widget for overlay
  const activeWidget = activeId
    ? widgets.find((w) => w.id === activeId)
    : null;

  return (
    <div className="space-y-6">
      {/* ─── Header ────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t(locale, "custom-dashboard")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {editMode
              ? t(locale, "drag-hint")
              : t(locale, "overview")}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Edit mode toggle */}
          <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-1.5">
            <Pencil className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">
              {t(locale, "edit-dashboard")}
            </span>
            <Switch
              checked={editMode}
              onCheckedChange={setEditMode}
              className="scale-90"
              aria-label={t(locale, "edit-dashboard")}
            />
          </div>

          {/* Add widget button */}
          <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
            <DialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={availableTypes.length === 0}
              >
                <Plus className="size-3.5" />
                {t(locale, "add-widget")}
              </Button>
            </DialogTrigger>
            <DialogContent size="md">
              <DialogHeader>
                <DialogTitle>{t(locale, "add-widget")}</DialogTitle>
                <DialogDescription>
                  {t(locale, "drag-hint")}
                </DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-3 py-4">
                {availableTypes.map((type) => {
                  const meta = WIDGET_META[type];
                  const Icon = meta.icon;
                  return (
                    <button
                      key={type}
                      onClick={() => handleAddWidget(type)}
                      className="flex items-center gap-3 rounded-xl border border-border p-3 hover:bg-muted/50 hover:border-primary/30 smooth text-left"
                    >
                      <div className="size-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                        <Icon className={`size-4 ${meta.color}`} />
                      </div>
                      <span className="text-sm font-medium">
                        {t(locale, meta.labelKey)}
                      </span>
                    </button>
                  );
                })}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAddDialogOpen(false)}
                >
                  {t(locale, "cancel")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Reset button (only in edit mode) */}
          {editMode && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={handleResetDashboard}
            >
              <RotateCcw className="size-3.5" />
              {t(locale, "reset-dashboard")}
            </Button>
          )}
        </div>
      </div>

      {/* ─── Dashboard Grid ────────────────────────────────────────────── */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={widgets.map((w) => w.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {widgets.map((widget) => {
              const meta = WIDGET_META[widget.type];
              const Icon = meta.icon;
              return (
                <SortableWidget
                  key={widget.id}
                  widget={widget}
                  editMode={editMode}
                  onRemove={handleRemoveWidget}
                >
                  <Card className="card-premium h-full overflow-hidden">
                    <CardHeader className="pb-3">
                      <div className="flex items-center gap-2">
                        <div className="size-7 rounded-lg bg-primary/10 flex items-center justify-center">
                          <Icon className={`size-3.5 ${meta.color}`} />
                        </div>
                        <CardTitle className="text-sm font-semibold">
                          {t(locale, meta.labelKey)}
                        </CardTitle>
                      </div>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <WidgetContent type={widget.type} />
                    </CardContent>
                  </Card>
                </SortableWidget>
              );
            })}
          </div>
        </SortableContext>

        {/* Drag overlay */}
        <DragOverlay>
          {activeWidget ? (
            <Card className="card-premium shadow-soft-xl w-80 opacity-90">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <div className="size-7 rounded-lg bg-primary/10 flex items-center justify-center">
                    {(() => {
                      const Icon = WIDGET_META[activeWidget.type].icon;
                      return <Icon className="size-3.5" />;
                    })()}
                  </div>
                  <CardTitle className="text-sm font-semibold">
                    {t(locale, WIDGET_META[activeWidget.type].labelKey)}
                  </CardTitle>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="h-20 flex items-center justify-center text-muted-foreground text-sm">
                  Moving widget...
                </div>
              </CardContent>
            </Card>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* ─── Empty state ───────────────────────────────────────────────── */}
      {widgets.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <LayoutDashboard className="size-12 text-muted-foreground/30 mb-4" />
          <h3 className="text-lg font-semibold text-muted-foreground mb-1">
            {t(locale, "no_data")}
          </h3>
          <p className="text-sm text-muted-foreground/70 mb-4">
            Add widgets to build your custom dashboard
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={handleResetDashboard}
            className="gap-1.5"
          >
            <RotateCcw className="size-3.5" />
            {t(locale, "reset-dashboard")}
          </Button>
        </div>
      )}
    </div>
  );
}
