"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Building2, ToggleRight, TrendingUp, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useApiUrl } from "@/lib/hooks/use-api-url";
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "@/lib/i18n/store";
import {
  SettingsCardHeader, SectionLabel, LoadingCard, ErrorCard,
} from "./_shared";
import { fmtDate } from "@/lib/utils/format";

interface TenantRow {
  id: string;
  name: string;
  legal_name: string | null;
  country: string | null;
  currency: string;
  plan: string;
  status: "active" | "suspended" | "cancelled";
  created_at: string;
  subscription_end?: string | null;
  flags: Record<string, any> | null;
  counts: Record<string, number>;
}

interface PlatformData {
  tenants: TenantRow[];
  plans: any[];
  feature_flag_keys: Array<{ key: string; label: string; group: string }>;
  plan_options: string[];
  status_options: string[];
}

const PLAN_BADGE: Record<string, string> = {
  trial: "bg-secondary text-secondary-foreground border-border",
  starter: "bg-chart-4/15 text-chart-4 border-chart-4/30",
  business: "bg-chart-1/15 text-chart-1 border-chart-1/30",
  enterprise: "bg-primary/10 text-primary border-primary/30",
  custom: "bg-primary/10 text-primary border-primary/30",
};

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  suspended: "bg-destructive/10 text-destructive border-destructive/30",
  cancelled: "bg-muted text-muted-foreground border-border",
};

export function PlatformConfig() {
  const api = useApiUrl();
  const qc = useQueryClient();
  const t = useT();

  const [data, setData] = React.useState<PlatformData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [flagsFilter, setFlagsFilter] = React.useState<string>("module_crm");
  const [manageId, setManageId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(api("/api/admin/platform-config"), { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setData(d);
    } catch (e: any) {
      setError(e?.message || "Failed to load platform config");
    } finally {
      setLoading(false);
    }
  }, [api]);

  React.useEffect(() => { void load(); }, [load]);

  async function toggleFlag(tenantId: string, flag: string, value: boolean) {
    try {
      const r = await fetch(api("/api/admin/platform-config"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant_id: tenantId, flag, value }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast.success(`${flag} ${value ? "enabled" : "disabled"}`);
      qc.invalidateQueries({ queryKey: ["platform-config"] });
      void load();
    } catch (e: any) {
      toast.error("Failed to toggle flag", { description: e?.message });
    }
  }

  async function changeTenantField(tenantId: string, field: "plan" | "status", value: string) {
    // Forward to the existing /api/tenants/[id] route — the canonical
    // tenant CRUD endpoint that already handles atomic status
    // transitions + session kill cascade on suspend.
    try {
      const r = await fetch(api(`/api/tenants/${tenantId}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: tenantId, [field]: value }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast.success(`${field} updated`, { description: `Tenant is now ${value}.` });
      qc.invalidateQueries({ queryKey: ["platform-config"] });
      qc.invalidateQueries({ queryKey: ["super-admin-overview"] });
      void load();
    } catch (e: any) {
      toast.error(`Failed to update ${field}`, { description: e?.message });
    }
  }

  if (loading) return <LoadingCard title={t("pf-sa-sys-tenants-title")} />;
  if (error || !data) return <ErrorCard title={t("pf-sa-sys-tenants-title")} message={error || "No data"} />;

  const filtered = data.tenants.filter((tenant) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      tenant.name.toLowerCase().includes(q) ||
      tenant.id.toLowerCase().includes(q) ||
      (tenant.legal_name || "").toLowerCase().includes(q)
    );
  });

  const manageTenant = data.tenants.find((tenant) => tenant.id === manageId) || null;

  return (
    <div className="space-y-6">
      {/* Feature flags matrix */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <SettingsCardHeader
          title={t("pf-sa-ac-flags-title")}
          description={`${t("pf-sa-ac-flags-desc")} ${data.tenants.length} tenants × ${data.feature_flag_keys.length} flags.`}
          dirty={false}
          saving={false}
        />
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Select value={flagsFilter} onValueChange={setFlagsFilter}>
              <SelectTrigger className="w-56 h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {data.feature_flag_keys.map((f) => (
                  <SelectItem key={f.key} value={f.key}>
                    {f.group} · {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tenant</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-center">Flag: {data.feature_flag_keys.find((f) => f.key === flagsFilter)?.label}</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead className="text-right">Partners</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((t) => {
                const flagVal = t.flags?.[flagsFilter];
                const hasFlagRow = !!t.flags;
                return (
                  <TableRow key={t.id}>
                    <TableCell>
                      <div className="font-medium truncate">{t.name}</div>
                      <div className="text-[11px] text-muted-foreground truncate">{t.id.slice(0, 8)}…</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`text-xs ${PLAN_BADGE[t.plan] || ""}`}>{t.plan}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`text-xs ${STATUS_BADGE[t.status]}`}>{t.status}</Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      {hasFlagRow ? (
                        <Switch
                          checked={!!flagVal}
                          onCheckedChange={(v) => toggleFlag(t.id, flagsFilter, v)}
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">no row</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular text-sm">{t.counts.users ?? 0}</TableCell>
                    <TableCell className="text-right tabular text-sm">{t.counts.partners ?? 0}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Tenant management */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <SettingsCardHeader
          title={t("pf-sa-sys-tenants-title")}
          description={t("pf-sa-sys-tenants-desc")}
          dirty={false}
          saving={false}
        />
        <CardContent className="space-y-3">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              placeholder="Search tenants by name / ID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-7 max-w-md"
            />
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tenant</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Subscription End</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <div className="font-medium truncate">{t.name}</div>
                    <div className="text-[11px] text-muted-foreground truncate">{t.legal_name || "—"}</div>
                  </TableCell>
                  <TableCell>
                    <Select value={t.plan} onValueChange={(v) => changeTenantField(t.id, "plan", v)}>
                      <SelectTrigger className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {data.plan_options.map((p) => (
                          <SelectItem key={p} value={p}>{p}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Select value={t.status} onValueChange={(v) => changeTenantField(t.id, "status", v)}>
                      <SelectTrigger className="h-8 w-28 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {data.status_options.map((s) => (
                          <SelectItem key={s} value={s}>{s}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular">{fmtDate(t.created_at)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular">
                    {t.subscription_end ? fmtDate(t.subscription_end) : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => setManageId(t.id)}>
                      Manage
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Plans management */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <SettingsCardHeader
          title="Plan / Subscription Management"
          description="Plan definitions from the plans table. Editing plans requires a DB change — this table is read-only for visibility."
          dirty={false}
          saving={false}
        />
        <CardContent className="p-0">
          {data.plans.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 px-4 text-center">
              No plans table configured in this env. Plan options are: {data.plan_options.join(", ")}.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Monthly</TableHead>
                  <TableHead>Annual</TableHead>
                  <TableHead>Trial Days</TableHead>
                  <TableHead>Active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.plans.map((p: any) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="tabular">${p.price_monthly}</TableCell>
                    <TableCell className="tabular">${p.price_annual}</TableCell>
                    <TableCell className="tabular">{p.trial_days}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`text-xs ${p.active ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30" : "bg-muted text-muted-foreground"}`}>
                        {p.active ? "active" : "inactive"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Tenant management dialog (quick links) */}
      {manageTenant && (
        <Dialog open={!!manageTenant} onOpenChange={(v) => { if (!v) setManageId(null); }}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Manage {manageTenant.name}</DialogTitle>
              <DialogDescription>
                Quick actions. Each forwards to the canonical /api/tenants/[id] route.
              </DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3">
              <Button
                variant="outline"
                className={manageTenant.status === "suspended" ? "bg-destructive/10 text-destructive border-destructive/30" : ""}
                onClick={() => { void changeTenantField(manageTenant.id, "status", manageTenant.status === "suspended" ? "active" : "suspended"); }}
              >
                {manageTenant.status === "suspended" ? "Activate" : "Suspend"}
              </Button>
              <Button
                variant="outline"
                onClick={() => { void changeTenantField(manageTenant.id, "status", manageTenant.status === "cancelled" ? "active" : "cancelled"); }}
                className={manageTenant.status === "cancelled" ? "bg-destructive/10 text-destructive border-destructive/30" : ""}
              >
                {manageTenant.status === "cancelled" ? "Reactivate" : "Cancel"}
              </Button>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span>Plan:</span><Badge variant="outline" className={PLAN_BADGE[manageTenant.plan]}>{manageTenant.plan}</Badge></div>
              <div className="flex justify-between"><span>Status:</span><Badge variant="outline" className={STATUS_BADGE[manageTenant.status]}>{manageTenant.status}</Badge></div>
              <div className="flex justify-between"><span>Users:</span><span className="tabular">{manageTenant.counts.users ?? 0}</span></div>
              <div className="flex justify-between"><span>Partners:</span><span className="tabular">{manageTenant.counts.partners ?? 0}</span></div>
              <div className="flex justify-between"><span>Deals:</span><span className="tabular">{manageTenant.counts.deals ?? 0}</span></div>
              <div className="flex justify-between"><span>Offers:</span><span className="tabular">{manageTenant.counts.offers ?? 0}</span></div>
              <div className="flex justify-between"><span>Invoices:</span><span className="tabular">{manageTenant.counts.invoices ?? 0}</span></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setManageId(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
