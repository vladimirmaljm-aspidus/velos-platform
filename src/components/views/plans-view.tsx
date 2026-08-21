"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Sparkles, Zap, Crown, Star, Check, X, TrendingUp, AlertTriangle, Clock, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { fmtMoney, fmtNumber } from "@/lib/utils/format";
import { useAppStore, isSuperAdmin } from "@/lib/store/app-store";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format } from "date-fns";
import { useT } from "@/lib/i18n/store";

interface Plan {
  id: string; name: string; description: string;
  price_monthly: number; price_yearly: number; currency: string;
  max_users: number; max_partners: number; max_monthly_documents: number;
  storage_mb: number; trial_days: number; included_modules: string;
  custom_branding: boolean; api_access: boolean; priority_support: boolean; white_label: boolean;
}

const PLAN_ICONS: Record<string, React.ComponentType<{ className?: string }>> = { trial: Sparkles, starter: Zap, business: Crown, enterprise: Star };

interface TenantSubscription {
  id: string; name: string; plan: string; status: string;
  is_trial: boolean; is_expired: boolean;
  subscription_start: string | null; subscription_end: string | null; trial_ends_at: string | null;
  days_remaining: number | null; billing_cycle: string | null;
  amount_paid: number; currency_paid: string; max_users: number;
  warning_level: "none" | "warning" | "critical" | "expired";
}

function StatusBadge({ level, isExpired, isTrial }: { level: string; isExpired: boolean; isTrial: boolean }) {
  const t = useT();
  if (isExpired) return <Badge className="bg-destructive/15 text-destructive border-destructive/30"><XCircle className="size-3 mr-1" />{t("admin-plans-status-expired")}</Badge>;
  if (level === "critical") return <Badge className="bg-red-500/15 text-red-600 border-red-500/30"><AlertTriangle className="size-3 mr-1" />{t("admin-plans-status-critical")}</Badge>;
  if (level === "warning") return <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30"><Clock className="size-3 mr-1" />{t("admin-plans-status-warning")}</Badge>;
  if (isTrial) return <Badge className="bg-blue-500/15 text-blue-600 border-blue-500/30"><Sparkles className="size-3 mr-1" />{t("admin-plans-status-trial")}</Badge>;
  return <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30"><CheckCircle2 className="size-3 mr-1" />{t("admin-active-badge")}</Badge>;
}

function SuperAdminSubscriptionsPanel() {
  const t = useT();
  const { data, isLoading, error } = useQuery({
    queryKey: ["super-admin-subscriptions"],
    queryFn: async () => {
      const r = await fetch("/api/super-admin/subscriptions");
      if (!r.ok) throw new Error("Failed to load subscriptions");
      return r.json() as Promise<{ items: TenantSubscription[]; totals: any }>;
    },
    refetchInterval: 60_000,
  });

  if (isLoading) return <Card className="mb-6"><CardContent className="p-6 text-sm text-muted-foreground">{t("admin-plans-loading")}</CardContent></Card>;
  if (error || !data) return <Card className="mb-6"><CardContent className="p-6 text-sm text-destructive">{t("admin-plans-load-failed")}</CardContent></Card>;

  const { items, totals } = data;
  return (
    <div className="mb-6 space-y-4">
      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <div className="rounded-xl border border-border/60 p-3 bg-card"><p className="text-xs uppercase tracking-wider text-muted-foreground">{t("admin-plans-summary-tenants")}</p><p className="text-xl font-bold tabular mt-0.5">{fmtNumber(totals.total_tenants)}</p></div>
        <div className="rounded-xl border border-emerald-500/30 p-3 bg-emerald-500/5"><p className="text-xs uppercase tracking-wider text-emerald-700 dark:text-emerald-400">{t("admin-active-badge")}</p><p className="text-xl font-bold tabular mt-0.5 text-emerald-700 dark:text-emerald-400">{fmtNumber(totals.active)}</p></div>
        <div className="rounded-xl border border-blue-500/30 p-3 bg-blue-500/5"><p className="text-xs uppercase tracking-wider text-blue-700 dark:text-blue-400">{t("admin-plans-status-trial")}</p><p className="text-xl font-bold tabular mt-0.5 text-blue-700 dark:text-blue-400">{fmtNumber(totals.trial)}</p></div>
        <div className="rounded-xl border border-amber-500/30 p-3 bg-amber-500/5"><p className="text-xs uppercase tracking-wider text-amber-700 dark:text-amber-400">{t("admin-plans-summary-expiring-7d")}</p><p className="text-xl font-bold tabular mt-0.5 text-amber-700 dark:text-amber-400">{fmtNumber(totals.expiring_within_7d)}</p></div>
        <div className="rounded-xl border border-destructive/30 p-3 bg-destructive/5"><p className="text-xs uppercase tracking-wider text-destructive">{t("admin-plans-status-expired")}</p><p className="text-xl font-bold tabular mt-0.5 text-destructive">{fmtNumber(totals.expired)}</p></div>
        <div className="rounded-xl border border-border/60 p-3 bg-card"><p className="text-xs uppercase tracking-wider text-muted-foreground">{t("admin-plans-summary-mrr")}</p><p className="text-xl font-bold tabular mt-0.5">{fmtMoney(totals.monthly_recurring_revenue, "EUR")}</p></div>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{t("admin-plans-super-panel-title")}</CardTitle><CardDescription className="text-xs">{t("admin-plans-super-panel-desc")}</CardDescription></CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("admin-col-tenant")}</TableHead>
                  <TableHead>{t("admin-plans-col-plan")}</TableHead>
                  <TableHead>{t("admin-col-status")}</TableHead>
                  <TableHead className="text-right">{t("admin-plans-col-paid")}</TableHead>
                  <TableHead>{t("admin-plans-col-billing")}</TableHead>
                  <TableHead>{t("admin-plans-col-starts")}</TableHead>
                  <TableHead>{t("admin-plans-col-ends")}</TableHead>
                  <TableHead className="text-right">{t("admin-plans-col-days-left")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-6">
                      {t("admin-plans-no-tenants")}
                    </TableCell>
                  </TableRow>
                )}
                {items.map((t_item) => {
                  const endDate = t_item.is_trial ? t_item.trial_ends_at : t_item.subscription_end;
                  return (
                    <TableRow key={t_item.id}>
                      <TableCell className="font-medium">{t_item.name}</TableCell>
                      <TableCell><Badge variant="outline" className="capitalize">{t_item.plan}</Badge></TableCell>
                      <TableCell><StatusBadge level={t_item.warning_level} isExpired={t_item.is_expired} isTrial={t_item.is_trial} /></TableCell>
                      <TableCell className="text-right tabular">{fmtMoney(t_item.amount_paid, t_item.currency_paid)}</TableCell>
                      <TableCell className="capitalize text-sm text-muted-foreground">{t_item.billing_cycle || "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{t_item.subscription_start ? format(new Date(t_item.subscription_start), "yyyy-MM-dd") : "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{endDate ? format(new Date(endDate), "yyyy-MM-dd") : "—"}</TableCell>
                      <TableCell className={`text-right tabular font-semibold ${t_item.warning_level === "expired" ? "text-destructive" : t_item.warning_level === "critical" ? "text-red-600" : t_item.warning_level === "warning" ? "text-amber-600" : ""}`}>
                        {t_item.days_remaining !== null ? (t_item.days_remaining < 0 ? `${t_item.days_remaining}` : t_item.days_remaining) : "∞"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function PlansView() {
  const api = useApiUrl(); const tenantKey = useTenantKey();
  const t = useT();
  const [upgradeDialog, setUpgradeDialog] = useState<Plan | null>(null);
  const [message, setMessage] = useState("");
  const currentUser = useAppStore((s) => s.user);
  const isSA = isSuperAdmin(currentUser);

  const { data: plansData } = useQuery({
    queryKey: ["plans", tenantKey],
    queryFn: async () => { const r = await fetch(api("/api/plans")); if (!r.ok) throw new Error("Failed"); return r.json() as Promise<{ items: Plan[] }>; },
  });
  const { data: subData } = useQuery({
    queryKey: ["subscription-status", tenantKey],
    queryFn: async () => { const r = await fetch("/api/subscription/status"); if (!r.ok) return null; return r.json(); },
  });
  const upgradeMut = useMutation({
    mutationFn: async (plan: Plan) => {
      const r = await fetch("/api/plan-upgrade-requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requested_plan: plan.name, message: message || undefined }) });
      if (!r.ok) throw new Error("Failed"); return r.json();
    },
    onSuccess: () => { toast.success(t("admin-plans-upgrade-toast")); setUpgradeDialog(null); setMessage(""); },
    onError: () => toast.error(t("admin-plans-upgrade-failed-toast")),
  });

  const plans = plansData?.items || [];
  const currentPlan = (subData?.subscription?.plan || "").toLowerCase();
  const isTrial = subData?.subscription?.is_trial;

  return (
    <div>
      <PageHeader title={t("admin-plans-title")} description={isSA ? t("admin-plans-desc-super") : t("admin-plans-desc-tenant")} />
      {isSA && <SuperAdminSubscriptionsPanel />}
      {subData?.subscription && !isSA && (
        <Card className={`mb-6 border-2 ${isTrial ? "border-amber-500/40 bg-amber-50/30 dark:bg-amber-950/10" : "border-primary/30 bg-primary/5"}`}>
          <CardContent className="p-4 flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">{t("admin-plans-current-plan")}</p>
              <div className="flex items-center gap-2 mt-1">
                <p className="text-xl font-bold capitalize">{currentPlan || "—"}</p>
                {isTrial && <Badge className="bg-amber-500/20 text-amber-600 border-amber-500/30">{t("admin-plans-status-trial")}</Badge>}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {isTrial
                  ? (subData.subscription.trial_days_remaining != null
                      ? t("admin-plans-trial-days-left").replace("${n}", String(subData.subscription.trial_days_remaining))
                      : t("admin-plans-trial-period"))
                  : (subData.subscription.days_remaining != null
                      ? t("admin-plans-days-remaining").replace("${n}", String(subData.subscription.days_remaining))
                      : t("admin-plans-no-expiry"))}
              </p>
            </div>
            {isTrial && <div className="text-right"><p className="text-sm font-medium text-amber-600">{t("admin-plans-upgrade-cta")}</p></div>}
          </CardContent>
        </Card>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {plans.map((plan) => {
          const Icon = PLAN_ICONS[plan.name.toLowerCase()] || Star;
          const isCurrent = plan.name.toLowerCase() === currentPlan;
          const isFeatured = plan.name.toLowerCase() === "business";
          const included = (() => { try { return JSON.parse(plan.included_modules || "[]"); } catch { return []; } })();
          return (
            <Card key={plan.id} className={`relative rounded-xl overflow-hidden flex flex-col ${isFeatured ? "border-primary/50 shadow-soft-md ring-1 ring-primary/30" : "border-border/60"} ${isCurrent ? "ring-2 ring-emerald-500/40" : ""}`}>
              {(isFeatured || isCurrent) && <div className={`absolute top-0 inset-x-0 text-center py-1 text-xs font-semibold uppercase tracking-wider ${isCurrent ? "bg-emerald-500 text-white" : "bg-primary text-primary-foreground"}`}>{isCurrent ? t("admin-plans-current-plan") : t("admin-plans-most-popular")}</div>}
              <CardHeader className={isFeatured || isCurrent ? "pt-8 pb-3" : "pb-3"}>
                <div className="flex items-center justify-between"><CardTitle className="text-lg flex items-center gap-2"><Icon className="size-4" />{plan.name}</CardTitle><Badge variant="outline" className="text-xs">{plan.currency}</Badge></div>
                {plan.description && <CardDescription className="text-xs">{plan.description}</CardDescription>}
              </CardHeader>
              <CardContent className="flex-1 flex flex-col gap-4">
                <div><div className="flex items-baseline gap-1"><span className="text-2xl font-bold">{fmtMoney(plan.price_monthly, plan.currency)}</span><span className="text-xs text-muted-foreground">{t("admin-plans-per-month")}</span></div><p className="text-xs text-muted-foreground mt-0.5">{t("admin-plans-or")} {fmtMoney(plan.price_yearly, plan.currency)}{t("admin-plans-per-year")}</p></div>
                <div className="space-y-1.5 text-xs">
                  <div className="flex items-center gap-2"><Check className="size-3 text-emerald-500 shrink-0" /><span>{plan.max_users} {t("admin-col-name").toLowerCase()}</span></div>
                  <div className="flex items-center gap-2"><Check className="size-3 text-emerald-500 shrink-0" /><span>{plan.max_partners === 0 ? t("admin-plans-unlimited") : plan.max_partners} partners</span></div>
                  <div className="flex items-center gap-2"><Check className="size-3 text-emerald-500 shrink-0" /><span>{plan.max_monthly_documents === 0 ? t("admin-plans-unlimited") : plan.max_monthly_documents} {t("admin-plans-docs-per-month")}</span></div>
                  <div className="flex items-center gap-2"><Check className="size-3 text-emerald-500 shrink-0" /><span>{plan.storage_mb >= 1000 ? `${plan.storage_mb / 1000}GB` : `${plan.storage_mb}MB`} {t("admin-plans-storage")}</span></div>
                  <div className="flex items-center gap-2"><Check className="size-3 text-emerald-500 shrink-0" /><span>{t("admin-plans-day-trial").replace("${n}", String(plan.trial_days))}</span></div>
                  {plan.custom_branding && <div className="flex items-center gap-2"><Check className="size-3 text-emerald-500 shrink-0" /><span>{t("admin-plans-custom-branding")}</span></div>}
                  {plan.api_access && <div className="flex items-center gap-2"><Check className="size-3 text-emerald-500 shrink-0" /><span>{t("admin-plans-api-access")}</span></div>}
                  {plan.priority_support && <div className="flex items-center gap-2"><Check className="size-3 text-emerald-500 shrink-0" /><span>{t("admin-plans-priority-support")}</span></div>}
                  {plan.white_label && <div className="flex items-center gap-2"><Check className="size-3 text-emerald-500 shrink-0" /><span>{t("admin-plans-white-label")}</span></div>}
                  {!plan.custom_branding && <div className="flex items-center gap-2"><X className="size-3 text-muted-foreground shrink-0" /><span className="text-muted-foreground">{t("admin-plans-no-custom-branding")}</span></div>}
                  {!plan.api_access && <div className="flex items-center gap-2"><X className="size-3 text-muted-foreground shrink-0" /><span className="text-muted-foreground">{t("admin-plans-no-api-access")}</span></div>}
                </div>
                <div className="border-t border-border/40 pt-2"><p className="text-xs font-semibold text-muted-foreground uppercase mb-1.5">{t("admin-plans-modules")}</p><div className="flex flex-wrap gap-1">{included.map((code: string, i: number) => <Badge key={i} variant="outline" className="text-xs py-0">{code}</Badge>)}</div></div>
              </CardContent>
              <CardFooter className="pt-0">
                {isCurrent ? (
                  <Button className="w-full" variant="outline" disabled>{t("admin-plans-current-plan")}</Button>
                ) : plan.price_monthly === 0 ? (
                  // Never offer "Start Free Trial" to an existing tenant — trials only apply at fresh sign-up.
                  <Button className="w-full" variant="outline" disabled>{t("admin-plans-trial-only-new")}</Button>
                ) : (
                  <Button className="w-full" variant={isFeatured ? "default" : "outline"} onClick={() => setUpgradeDialog(plan)}>
                    <TrendingUp className="size-4 mr-1.5" />{t("admin-plans-request-upgrade")}
                  </Button>
                )}
              </CardFooter>
            </Card>
          );
        })}
      </div>
      {upgradeDialog && (
        <Dialog open={!!upgradeDialog} onOpenChange={(o) => !o && setUpgradeDialog(null)}>
          <DialogContent className="w-[95vw] sm:max-w-lg max-h-[88vh] flex flex-col gap-0 overflow-hidden p-0">
            <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60"><DialogTitle className="flex items-center gap-2"><TrendingUp className="size-5 text-primary" />{t("admin-plans-upgrade-dialog-title").replace("${plan}", upgradeDialog.name)}</DialogTitle><DialogDescription>{t("admin-plans-upgrade-dialog-desc")}</DialogDescription></DialogHeader>
            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-3">
              <div className="rounded-lg bg-muted/40 border border-border/60 p-3"><div className="flex items-center justify-between mb-2"><span className="text-sm font-medium">{upgradeDialog.name}</span><span className="text-sm font-bold">{fmtMoney(upgradeDialog.price_monthly, upgradeDialog.currency)}/mo</span></div><div className="text-xs text-muted-foreground">{upgradeDialog.max_users} users · {upgradeDialog.max_partners === 0 ? t("admin-plans-unlimited") : upgradeDialog.max_partners} partners · {upgradeDialog.storage_mb >= 1000 ? `${upgradeDialog.storage_mb / 1000}GB` : `${upgradeDialog.storage_mb}MB`} storage</div></div>
              <div><label className="text-sm font-medium">{t("admin-plans-upgrade-message-label")}</label><Textarea placeholder={t("admin-plans-upgrade-message-placeholder")} value={message} onChange={(e) => setMessage(e.target.value)} rows={3} className="mt-1" /></div>
            </div>
            <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4"><Button variant="outline" onClick={() => setUpgradeDialog(null)}>{t("cancel")}</Button><Button onClick={() => upgradeMut.mutate(upgradeDialog)} disabled={upgradeMut.isPending}>{upgradeMut.isPending ? t("admin-plans-upgrade-sending") : t("admin-plans-upgrade-send")}</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
