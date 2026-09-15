"use client";

/**
 * CreditCollectionsView — the collections workbench (task 11-a, migration 102).
 *
 * One screen over the tenant's receivables:
 *   • 6 KPIs — outstanding, overdue (amount + count), DSO, at-risk, on-hold
 *   • aging bar chart — current / 1-30 / 31-60 / 61-90 / 90+ days overdue
 *   • collections queue — every unpaid sent invoice, most overdue first,
 *     with the dunning ladder (stage 1 gentle → 2 firm → 3 final) inline
 *   • partner exposure — open exposure vs credit limit with utilisation,
 *     pay behaviour (avg days, on-time %) and the hold switch
 *
 * All numbers come from GET /api/credit/report?currency=… — the whole report
 * is computed server-side; the view is pure presentation. Face-value totals
 * stay visible per currency (chips under the KPI row) because the report
 * currency conversion is indicative-only.
 */

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from "recharts";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import {
  Wallet, FileWarning, CalendarClock, LockOpen, StickyNote, Send, Pencil,
  MoreHorizontal, RefreshCw, Loader2, TriangleAlert, Ban,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { QueryError } from "@/components/common/query-error";
import { KpiCard } from "@/components/common/kpi-card";
import { TableScroll } from "@/components/common/table-scroll";
import { fmtMoney, fmtNumber } from "@/lib/utils/format";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useT } from "@/lib/i18n/store";
import {
  REPORT_CURRENCIES, type CreditReport, type CreditQueueItem, type CreditPartnerExposure,
} from "@/lib/credit/report-types";

// ─── Chart styling (mirrors src/components/dashboard/charts.tsx) ─────────────
const TOOLTIP_STYLE = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--popover-foreground)",
} as const;
const AXIS_TICK_STYLE = { fontSize: 11, fill: "var(--muted-foreground)" } as const;
const GRID_STROKE = "var(--border)";

/** Aging severity ramp — green (current) → amber → orange → red (90+). */
const AGING_FILLS = ["#16a34a", "#F59E0B", "#D97706", "#EA580C", "#dc2626"] as const;

// ─── Aging tooltip ─────────────────────────────────────────────────────────
function AgingTooltip({ active, payload }: { active?: boolean; payload?: any[] }) {
  if (!active || !payload || payload.length === 0) return null;
  const b = payload[0].payload as CreditReport["aging"][number];
  return (
    <div style={TOOLTIP_STYLE} className="px-3 py-2 space-y-0.5">
      <p className="font-semibold">{b.key === "current" ? "Current" : `${b.key} d`}</p>
      <p className="tabular">{fmtNumber(b.count)} invoice{b.count === 1 ? "" : "s"}</p>
      {Object.entries(b.per_currency).map(([cur, v]) => (
        <p key={cur} className="tabular">{fmtMoney(v, cur)}</p>
      ))}
    </div>
  );
}

// ─── Collection remind dialog (send + note modes) ───────────────────────────
function CollectionRemindDialog({
  open, onOpenChange, target, mode, onDone, t,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Queue item the reminder/note is logged against (null = partner-level). */
  target: CreditQueueItem | null;
  mode: "send" | "note";
  onDone: () => void;
  t: (k: string) => string;
}) {
  const api = useApiUrl();
  const [stage, setStage] = useState(1);
  const [note, setNote] = useState("");

  const mut = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error("no target");
      const r = await fetch(api("/api/credit/remind"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partner_id: target.partner_id,
          invoice_id: target.invoice_id,
          stage,
          kind: mode === "note" ? "note" : "reminder",
          note: note.trim() || null,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(mode === "note" ? t("credit-note-success") : t("credit-remind-success"));
      setNote("");
      setStage(1);
      onOpenChange(false);
      onDone();
    },
    onError: (e: Error) => toast.error(e.message || t("credit-remind-failed")),
  });

  const isSend = mode === "send";
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setNote(""); setStage(1); } onOpenChange(o); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isSend ? t("credit-remind-title") : t("credit-note-title")}</DialogTitle>
          <DialogDescription>
            {target ? `${target.number} — ${target.partner_name}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {isSend && (
            <div className="space-y-2">
              <Label>{t("credit-stage")}</Label>
              <Select value={String(stage)} onValueChange={(v) => setStage(Number(v))}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">{t("credit-stage-1")}</SelectItem>
                  <SelectItem value="2">{t("credit-stage-2")}</SelectItem>
                  <SelectItem value="3">{t("credit-stage-3")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label>{t("credit-note-label")}</Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("credit-note-ph")}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending && <Loader2 className="size-4 mr-1 animate-spin" />}
            {isSend ? <Send className="size-4 mr-1" /> : <StickyNote className="size-4 mr-1" />}
            {isSend ? t("credit-send") : t("credit-save-note")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main view ─────────────────────────────────────────────────────────────
export function CreditCollectionsView() {
  const t = useT();
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const qc = useQueryClient();

  // ── Report query ──────────────────────────────────────────────────────
  const [currency, setCurrency] = useState<string>("USD");
  const reportKey = ["credit-report", tenantKey, currency];
  const reportQuery = useQuery({
    queryKey: reportKey,
    queryFn: async (): Promise<CreditReport | null> => {
      const r = await fetch(api("/api/credit/report", { currency }));
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      return r.json().catch(() => null);
    },
  });
  const report = reportQuery.data ?? null;

  // Currency selector options: the 6 platform codes ∪ any currency actually
  // present in the data (so a single-currency tenant can report natively).
  const currencyOptions = useMemo(() => {
    const set = new Set<string>(REPORT_CURRENCIES);
    if (report) {
      Object.keys(report.kpis.outstanding_per_currency).forEach((c) => set.add(c));
    }
    return [...set];
  }, [report]);

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ["credit-report", tenantKey] }); };

  // ── Dialog state ──────────────────────────────────────────────────────
  const [remindTarget, setRemindTarget] = useState<CreditQueueItem | null>(null);
  const [remindOpen, setRemindOpen] = useState(false);
  const [noteTarget, setNoteTarget] = useState<CreditQueueItem | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);

  const [limitTarget, setLimitTarget] = useState<CreditPartnerExposure | null>(null);
  const [limitOpen, setLimitOpen] = useState(false);
  const [limitValue, setLimitValue] = useState("");
  const [limitCurrency, setLimitCurrency] = useState("USD");

  const [holdTarget, setHoldTarget] = useState<CreditPartnerExposure | null>(null);
  const [holdOpen, setHoldOpen] = useState(false);
  const [holdMode, setHoldMode] = useState<"apply" | "release">("apply");
  const [holdReason, setHoldReason] = useState("");

  // ── Mutations (partner PUT) ───────────────────────────────────────────
  const limitMut = useMutation({
    mutationFn: async () => {
      if (!limitTarget) throw new Error("no target");
      const body: Record<string, unknown> = {
        credit_currency: limitCurrency,
        credit_limit: limitValue.trim() === "" ? null : Number(limitValue),
      };
      if (typeof body.credit_limit === "number" && (!Number.isFinite(body.credit_limit) || body.credit_limit < 0)) {
        throw new Error(t("credit-limit-invalid"));
      }
      const r = await fetch(api(`/api/partners/${limitTarget.partner_id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("credit-limit-success"));
      setLimitOpen(false);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || t("credit-limit-failed")),
  });

  const holdMut = useMutation({
    mutationFn: async () => {
      if (!holdTarget) throw new Error("no target");
      const applying = holdMode === "apply";
      if (applying && !holdReason.trim()) throw new Error(t("credit-hold-reason-required"));
      const r = await fetch(api(`/api/partners/${holdTarget.partner_id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(applying
          ? { on_hold: true, hold_reason: holdReason.trim() }
          : { on_hold: false, hold_reason: null }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(holdMode === "apply" ? t("credit-hold-success") : t("credit-hold-release-success"));
      setHoldOpen(false);
      setHoldReason("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || t("credit-hold-failed")),
  });

  // ─── Loading / error / empty ─────────────────────────────────────────────
  if (reportQuery.isError) {
    return (
      <div className="space-y-4">
        <PageHeader title={t("credit-title")} description={t("credit-subtitle")} />
        <QueryError onRetry={() => reportQuery.refetch()} label={t("credit-title")} />
      </div>
    );
  }
  if (reportQuery.isLoading || !report) {
    return (
      <div className="space-y-4">
        <PageHeader title={t("credit-title")} description={t("credit-subtitle")} />
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
        <div className="grid gap-4 lg:grid-cols-5">
          <Skeleton className="h-64 lg:col-span-3" />
          <Skeleton className="h-64 lg:col-span-2" />
        </div>
      </div>
    );
  }

  const k = report.kpis;
  const agingTotal = report.aging.reduce((a, b) => a + b.count, 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("credit-title")}
        description={t("credit-subtitle")}
        actions={
          <div className="flex items-center gap-2">
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger className="w-[88px]" aria-label={t("credit-currency-label")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {currencyOptions.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              onClick={() => reportQuery.refetch()}
              disabled={reportQuery.isFetching}
              aria-label={t("credit-refresh")}
            >
              <RefreshCw className={`size-4 ${reportQuery.isFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        }
      />

      {/* ── KPI row ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
        <KpiCard
          label={t("credit-kpi-outstanding")}
          value={fmtMoney(k.outstanding, report.currency)}
          sub={t("credit-kpi-outstanding-sub")}
          icon={Wallet}
        />
        <KpiCard
          label={t("credit-kpi-overdue")}
          value={fmtMoney(k.overdue_amount, report.currency)}
          sub={t("credit-kpi-overdue-sub")}
          icon={FileWarning}
          variant={k.overdue_amount > 0 ? "negative" : "default"}
        />
        <KpiCard
          label={t("credit-aging-count")}
          value={fmtNumber(k.overdue_count)}
          sub={t("credit-aging-count-sub")}
          icon={FileWarning}
          iconClassName={k.overdue_count > 0 ? "text-destructive" : undefined}
        />
        <KpiCard
          label={t("credit-kpi-dso")}
          value={k.dso === null ? "—" : fmtNumber(k.dso)}
          sub={t("credit-kpi-dso-sub")}
          icon={CalendarClock}
        />
        <KpiCard
          label={t("credit-kpi-at-risk")}
          value={fmtMoney(k.at_risk_amount, report.currency)}
          sub={t("credit-kpi-at-risk-sub")}
          icon={TriangleAlert}
          variant={k.at_risk_amount > 0 ? "warning" : "default"}
        />
        <KpiCard
          label={t("credit-kpi-on-hold")}
          value={fmtNumber(k.on_hold_partners)}
          sub={t("credit-kpi-on-hold-sub")}
          icon={Ban}
          variant={k.on_hold_partners > 0 ? "warning" : "default"}
        />
      </div>

      {/* ── Slim info row: reminders + per-currency chips + FX warning ──── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Send className="size-3.5" />
          {t("credit-reminders-30d").replace("{n}", String(report.reminders_sent_30d))}
        </span>
        {Object.entries(k.outstanding_per_currency).length > 0 && (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {Object.entries(k.outstanding_per_currency).map(([cur, v]) => (
              <Badge key={cur} variant="outline" className="text-[11px] tabular font-medium">
                {fmtMoney(v, cur)}
              </Badge>
            ))}
          </span>
        )}
        {!report.fx_available && (
          <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
            <TriangleAlert className="size-3.5" />
            {t("credit-fx-unavailable").replace("{list}", report.fx_unavailable.join(", "))}
          </span>
        )}
      </div>

      {/* ── Aging chart ─────────────────────────────────────────────────── */}
      <Card className="border-border/60 shadow-soft">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("credit-aging-title")}</CardTitle>
          <CardDescription className="text-xs">{t("credit-aging-sub")}</CardDescription>
        </CardHeader>
        <CardContent>
          {agingTotal === 0 ? (
            <EmptyState
              icon={<Wallet className="size-8" />}
              title={t("credit-aging-empty")}
              description={t("credit-aging-empty-sub")}
              className="py-8"
            />
          ) : (
            <div className="h-[220px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={report.aging} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="key"
                    tick={AXIS_TICK_STYLE}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v: string) => (v === "current" ? t("credit-aging-current") : v)}
                  />
                  <YAxis tick={AXIS_TICK_STYLE} axisLine={false} tickLine={false} width={36} />
                  <Tooltip content={<AgingTooltip />} cursor={{ fill: "var(--muted)" , fillOpacity: 0.4 }} />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={64}>
                    {report.aging.map((_, i) => <Cell key={i} fill={AGING_FILLS[i]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Queue + exposure ────────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-5">

        {/* ── Collections queue ── */}
        <Card className="border-border/60 shadow-soft lg:col-span-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t("credit-queue-title")}</CardTitle>
            <CardDescription className="text-xs">{t("credit-queue-sub")}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {report.queue.length === 0 ? (
              <EmptyState
                icon={<Wallet className="size-8" />}
                title={t("credit-queue-empty")}
                description={t("credit-queue-empty-sub")}
                className="py-10"
              />
            ) : (
              <TableScroll label={t("credit-queue-title")}>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("credit-th-partner")}</TableHead>
                      <TableHead>{t("credit-th-invoice")}</TableHead>
                      <TableHead className="text-right">{t("credit-th-amount")}</TableHead>
                      <TableHead>{t("credit-th-due")}</TableHead>
                      <TableHead className="text-right">{t("credit-th-days")}</TableHead>
                      <TableHead>{t("credit-th-ladder")}</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.queue.slice(0, 100).map((q) => {
                      const overdue = q.days_overdue > 0;
                      return (
                        <TableRow key={q.invoice_id}>
                          <TableCell className="max-w-[180px]">
                            <p className="truncate font-medium">{q.partner_name}</p>
                            {q.reminder_count > 0 && q.last_reminder_at && (
                              <p className="text-[11px] text-muted-foreground">
                                {t("credit-last-reminder").replace("{date}", new Date(q.last_reminder_at).toLocaleDateString())}
                              </p>
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{q.number}</TableCell>
                          <TableCell className="text-right tabular whitespace-nowrap">
                            <p className="font-medium">{fmtMoney(q.amount, q.currency)}</p>
                            {q.amount_report !== null && q.currency !== report.currency && (
                              <p className="text-[11px] text-muted-foreground">{fmtMoney(q.amount_report, report.currency)}</p>
                            )}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs">
                            {q.due_date ? new Date(q.due_date).toLocaleDateString() : "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            <Badge
                              variant="outline"
                              className={
                                q.days_overdue > 30 ? "border-transparent bg-destructive/10 text-destructive"
                                : overdue ? "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400"
                                : "text-muted-foreground"
                              }
                            >
                              {overdue
                                ? t("credit-days-overdue").replace("{n}", String(q.days_overdue))
                                : q.days_overdue === 0
                                  ? t("credit-due-today")
                                  : t("credit-days-remaining").replace("{n}", String(Math.abs(q.days_overdue)))}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <div className="flex gap-0.5">
                                {[1, 2, 3].map((s) => {
                                  const sent = q.stage_ladder.some((r) => r.stage === s);
                                  return (
                                    <span
                                      key={s}
                                      title={t(`credit-stage-${s}`)}
                                      className={`size-1.5 rounded-full ${sent ? "bg-primary" : "bg-border"}`}
                                    />
                                  );
                                })}
                              </div>
                              <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                                {q.reminder_count > 0 && `×${q.reminder_count} `}
                                {q.next_stage !== null
                                  ? t("credit-next-stage").replace("{n}", String(q.next_stage))
                                  : t("credit-all-stages-sent")}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="size-8">
                                  <MoreHorizontal className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-44">
                                <DropdownMenuItem
                                  onClick={() => { setRemindTarget(q); setRemindOpen(true); }}
                                  disabled={q.next_stage === null}
                                >
                                  <Send className="size-4 mr-2" /> {t("credit-remind")}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => { setNoteTarget(q); setNoteOpen(true); }}>
                                  <StickyNote className="size-4 mr-2" /> {t("credit-note")}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableScroll>
            )}
          </CardContent>
        </Card>

        {/* ── Partner exposure ── */}
        <Card className="border-border/60 shadow-soft lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t("credit-exposure-title")}</CardTitle>
            <CardDescription className="text-xs">{t("credit-exposure-sub")}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {report.partners.length === 0 ? (
              <EmptyState
                icon={<Wallet className="size-8" />}
                title={t("credit-exposure-empty")}
                description={t("credit-exposure-empty-sub")}
                className="py-10"
              />
            ) : (
              <TableScroll label={t("credit-exposure-title")}>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("credit-th-partner")}</TableHead>
                      <TableHead className="text-right">{t("credit-th-exposure")}</TableHead>
                      <TableHead>{t("credit-th-limit")}</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.partners.slice(0, 60).map((p) => (
                      <TableRow key={p.partner_id}>
                        <TableCell className="max-w-[170px]">
                          <div className="flex items-center gap-1.5">
                            <p className="truncate font-medium">{p.name}</p>
                            {p.on_hold && (
                              <Badge variant="outline" className="shrink-0 border-transparent bg-red-500/10 text-red-600 dark:text-red-400 text-[10px]">
                                {t("credit-on-hold-badge")}
                              </Badge>
                            )}
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            {p.credit_limit !== null
                              ? `${fmtNumber(p.utilization_pct ?? 0)}% · ${t("credit-avg-pay").replace("{n}", p.avg_pay_days === null ? "—" : String(p.avg_pay_days))}`
                              : t("credit-no-history")}
                          </p>
                        </TableCell>
                        <TableCell className="text-right tabular whitespace-nowrap">
                          <p className="font-medium">{p.exposure === null ? "—" : fmtMoney(p.exposure, report.currency)}</p>
                          <p className="text-[11px] text-muted-foreground">{fmtNumber(p.invoice_count)} × invoice</p>
                        </TableCell>
                        <TableCell className="w-[110px]">
                          {p.credit_limit !== null ? (
                            <div className="space-y-1">
                              <p className="text-[11px] text-muted-foreground whitespace-nowrap">
                                {fmtMoney(p.credit_limit, p.credit_currency || report.currency)}
                              </p>
                              <Progress
                                value={Math.min(p.utilization_pct ?? 0, 100)}
                                className="h-1.5"
                                aria-label={t("credit-th-utilization")}
                              />
                              {(p.utilization_pct ?? 0) > 100 && (
                                <p className="text-[10px] text-destructive font-medium">
                                  {fmtNumber(p.utilization_pct ?? 0)}%
                                </p>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">{t("credit-no-limit")}</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="size-8">
                                <MoreHorizontal className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-44">
                              <DropdownMenuItem
                                onClick={() => {
                                  setLimitTarget(p);
                                  setLimitValue(p.credit_limit !== null ? String(p.credit_limit) : "");
                                  setLimitCurrency(p.credit_currency || report.currency);
                                  setLimitOpen(true);
                                }}
                              >
                                <Pencil className="size-4 mr-2" /> {t("credit-edit-limit")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => {
                                  setHoldTarget(p);
                                  setHoldMode(p.on_hold ? "release" : "apply");
                                  setHoldReason("");
                                  setHoldOpen(true);
                                }}
                              >
                                {p.on_hold
                                  ? <><LockOpen className="size-4 mr-2" /> {t("credit-hold-release")}</>
                                  : <><Ban className="size-4 mr-2" /> {t("credit-hold-apply")}</>}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Dialogs ───────────────────────────────────────────────────────── */}
      <CollectionRemindDialog
        open={remindOpen}
        onOpenChange={setRemindOpen}
        target={remindTarget}
        mode="send"
        onDone={invalidate}
        t={t}
      />
      <CollectionRemindDialog
        open={noteOpen}
        onOpenChange={setNoteOpen}
        target={noteTarget}
        mode="note"
        onDone={invalidate}
        t={t}
      />

      {/* ── Limit edit dialog ── */}
      <Dialog open={limitOpen} onOpenChange={setLimitOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("credit-edit-limit")}</DialogTitle>
            <DialogDescription>{limitTarget?.name}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>{t("credit-limit-label")}</Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={limitValue}
                onChange={(e) => setLimitValue(e.target.value)}
                placeholder={t("credit-limit-ph")}
              />
              <p className="text-[11px] text-muted-foreground">{t("credit-limit-hint")}</p>
            </div>
            <div className="space-y-2">
              <Label>{t("credit-limit-currency")}</Label>
              <Select value={limitCurrency} onValueChange={setLimitCurrency}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[...new Set<string>([...REPORT_CURRENCIES, ...(limitTarget?.credit_currency ? [limitTarget.credit_currency] : [])])].map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLimitOpen(false)}>{t("cancel")}</Button>
            <Button onClick={() => limitMut.mutate()} disabled={limitMut.isPending}>
              {limitMut.isPending && <Loader2 className="size-4 mr-1 animate-spin" />}
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Hold confirm ── */}
      <AlertDialog open={holdOpen} onOpenChange={setHoldOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {holdMode === "apply" ? t("credit-hold-title") : t("credit-hold-release-title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {holdMode === "apply"
                ? t("credit-hold-desc").replace("{name}", holdTarget?.name || "")
                : t("credit-hold-release-desc").replace("{name}", holdTarget?.name || "")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {holdMode === "apply" && (
            <div className="space-y-2">
              <Label>{t("credit-hold-reason")}</Label>
              <Textarea
                value={holdReason}
                onChange={(e) => setHoldReason(e.target.value)}
                placeholder={t("credit-hold-reason-ph")}
                rows={3}
              />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); holdMut.mutate(); }}
              disabled={holdMut.isPending || (holdMode === "apply" && !holdReason.trim())}
              className={holdMode === "apply" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
            >
              {holdMut.isPending && <Loader2 className="size-4 mr-1 animate-spin" />}
              {holdMode === "apply" ? t("credit-hold-confirm") : t("credit-hold-release-confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
