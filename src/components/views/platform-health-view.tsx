"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Heart, Database, Building2, Users, TrendingUp, AlertTriangle, CheckCircle2, XCircle, Clock, RefreshCw, ShieldAlert } from "lucide-react";
import { fmtDateTime } from "@/lib/utils/format";
import { useT } from "@/lib/i18n/store";
import { useAppStore, isSuperAdmin } from "@/lib/store/app-store";
import { PageHeader } from "@/components/common/page-header";
import { ModuleInfoTooltip } from "@/components/common/module-info-tooltip";


interface Health {
  db_status: "ok" | "error";
  tenant_count: number;
  user_count: number;
  active_subscriptions: number;
  suspended_tenants: number;
  expiring_within_7d: number;
  permission_consistency_issues: number;
  generated_at: string;
}

export function PlatformHealthView() {
  const t = useT();
  const userObj = useAppStore((s) => s.user);
  const isSuper = isSuperAdmin(userObj);

  const healthQ = useQuery({
    queryKey: ["platform-health"],
    queryFn: async () => {
      const r = await fetch("/api/super-admin/health");
      if (!r.ok) throw new Error("Failed to load health");
      return r.json() as Promise<Health>;
    },
    refetchInterval: 30_000,
    enabled: isSuper,
  });

  // Defense-in-depth: super-admin-only surface. The sidebar hides this
  // view and /api/super-admin/health uses requireSuperAdmin, but if a
  // non-super-admin reaches it via state manipulation we render a clear
  // denial instead of firing 403 fetches. All hooks (above) are called
  // before this early return (Rules of Hooks).
  if (!isSuper) {
    return (
      <div>
        <PageHeader title={t("pf-health-title")} description={t("pf-health-desc")} />
        <Card className="border-amber-500/30 bg-amber-50/40 dark:bg-amber-500/5">
          <CardContent className="p-6 flex items-start gap-3">
            <div className="size-10 rounded-xl bg-amber-500/15 text-amber-600 flex items-center justify-center shrink-0">
              <ShieldAlert className="size-5" />
            </div>
            <div>
              <p className="font-medium">Platform admin access required.</p>
              <p className="text-sm text-muted-foreground mt-1">
                This area is restricted to platform super-administrators. Contact your platform operator if you believe this is an error.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const h = healthQ.data;
  const generated = h?.generated_at ? fmtDateTime(h.generated_at) : "";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base"><Heart className="size-4 text-primary" /> {t("pf-health-title")} <ModuleInfoTooltip title="System Health" description="Monitor platform health — database, API latency, error rates, cron job status, and queue depths." howToUse={["View DB health metrics", "Monitor API latency and error rates", "Check cron job status", "View queue depths (mail, webhooks)"]} /></CardTitle>
              <CardDescription className="text-xs">{t("pf-health-desc")}</CardDescription>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {generated && <span>{t("pf-health-updated").replace("{when}", generated)}</span>}
              <Button size="sm" variant="outline" onClick={() => healthQ.refetch()}><RefreshCw className={`size-3.5 mr-1 ${healthQ.isFetching ? "animate-spin" : ""}`} /> {t("refresh")}</Button>
            </div>
          </div>
        </CardHeader>
      </Card>

      {healthQ.isLoading && <Card><CardContent className="p-6 text-sm text-muted-foreground">{t("pf-health-loading")}</CardContent></Card>}
      {healthQ.error && <Card><CardContent className="p-6 text-sm text-destructive">{t("pf-health-load-failed")}</CardContent></Card>}

      {h && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile
              icon={Database}
              label={t("pf-health-col-database")}
              value={h.db_status === "ok" ? "OK" : "ERROR"}
              tone={h.db_status === "ok" ? "ok" : "critical"}
              hint={h.db_status === "ok" ? t("pf-health-hint-db-ok") : t("pf-health-hint-db-fail")}
            />
            <Tile icon={Building2} label={t("pf-health-col-tenants")} value={h.tenant_count} tone="info" hint={t("pf-health-hint-tenants")} />
            <Tile icon={Users} label={t("pf-health-col-users")} value={h.user_count} tone="info" hint={t("pf-health-hint-users")} />
            <Tile icon={TrendingUp} label={t("pf-health-col-active-subs")} value={h.active_subscriptions} tone={h.active_subscriptions > 0 ? "ok" : "warn"} hint={t("pf-health-hint-active-subs")} />
            <Tile icon={Clock} label={t("pf-health-col-expiring")} value={h.expiring_within_7d} tone={h.expiring_within_7d > 0 ? "warn" : "ok"} hint={t("pf-health-hint-expiring")} />
            <Tile icon={AlertTriangle} label={t("pf-health-col-suspended")} value={h.suspended_tenants} tone={h.suspended_tenants > 0 ? "critical" : "ok"} hint={t("pf-health-hint-suspended")} />
            <Tile icon={AlertTriangle} label={t("pf-health-col-perm-issues")} value={h.permission_consistency_issues} tone={h.permission_consistency_issues > 0 ? "warn" : "ok"} hint={t("pf-health-hint-perm-issues")} />
          </div>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">{t("pf-health-signals-title")}</CardTitle></CardHeader>
            <CardContent className="p-4 space-y-2 text-sm">
              {h.db_status === "ok" ? <Signal ok label={t("pf-health-signal-db-ok")} /> : <Signal error label={t("pf-health-signal-db-fail")} />}
              {h.suspended_tenants > 0
                ? <Signal warn label={t("pf-health-signal-suspended").replace("{n}", String(h.suspended_tenants))} />
                : <Signal ok label={t("pf-health-signal-no-suspended")} />}
              {h.expiring_within_7d > 0
                ? <Signal warn label={t("pf-health-signal-expiring").replace("{n}", String(h.expiring_within_7d))} />
                : <Signal ok label={t("pf-health-signal-no-expiring")} />}
              {h.permission_consistency_issues > 0
                ? <Signal warn label={t("pf-health-signal-perm-issues").replace("{n}", String(h.permission_consistency_issues))} />
                : <Signal ok label={t("pf-health-signal-no-perm-issues")} />}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

const TONE = {
  ok: "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400",
  info: "border-primary/30 bg-primary/5",
  warn: "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400",
  critical: "border-destructive/30 bg-destructive/5 text-destructive",
} as const;
type Tone = keyof typeof TONE;

function Tile({ icon: Icon, label, value, tone, hint }: { icon: React.ComponentType<{ className?: string }>; label: string; value: number | string; tone: Tone; hint?: string }) {
  return (
    <Card className={`rounded-xl ${TONE[tone]}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div><p className="text-xs uppercase tracking-wider">{label}</p><p className="text-2xl font-bold tabular mt-1">{value}</p></div>
          <Icon className="size-4 opacity-60" />
        </div>
        {hint && <p className="text-xs opacity-70 mt-1">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function Signal({ ok, warn, error, label }: { ok?: boolean; warn?: boolean; error?: boolean; label: string }) {
  const Icon = error ? XCircle : warn ? AlertTriangle : CheckCircle2;
  const cls = error ? "text-destructive" : warn ? "text-amber-600" : "text-emerald-600";
  return <div className="flex items-center gap-2"><Icon className={`size-4 ${cls}`} /><span>{label}</span></div>;
}
