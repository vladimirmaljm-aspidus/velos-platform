"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  Building2, Users, Handshake, FileText, ShieldAlert, Globe, ArrowRight,
  Activity, Server, Heart, CircleDot, Clock, Plus, Pencil, Trash2,
  ShieldCheck, Eye, Repeat, Loader2, HardDrive, PieChart,
  Pause, Play, CalendarPlus,
} from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { ModuleInfoTooltip } from "@/components/common/module-info-tooltip";

import { KpiCard } from "@/components/common/kpi-card";
import { EmptyState } from "@/components/common/empty-state";
import { fmtDate, fmtDateTime, fmtNumber, fmtRelative } from "@/lib/utils/format";
import { Tenant, AuditLog } from "@/lib/supabase/types";
import { useAppStore, isSuperAdmin } from "@/lib/store/app-store";
import { CURRENCIES, COUNTRIES } from "@/lib/data/reference";
import { toast } from "sonner";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useT } from "@/lib/i18n/store";
import { RateLimitsCard } from "@/components/views/rate-limits-card";

type Plan = Tenant["plan"];
type TenantStatus = Tenant["status"];

interface TenantStats {
  tenant: Tenant;
  partner_count: number;
  deal_count: number;
  offer_count: number;
  invoice_count: number;
  user_count: number;
}

interface OverviewData {
  total_tenants: number;
  total_users: number;
  total_partners: number;
  total_offers: number;
  total_invoices: number;
  active_tenants: number;
  tenants: TenantStats[];
  recent_activity: AuditLog[];
}

const PLAN_LABEL_KEYS: Record<string, string> = {
  trial: "pf-plan-trial", starter: "pf-plan-starter", business: "pf-plan-business", enterprise: "pf-plan-enterprise",
};

const PLAN_BADGE: Record<string, string> = {
  trial: "bg-secondary text-secondary-foreground border-border",
  starter: "bg-chart-4/15 text-chart-4 border-chart-4/30",
  business: "bg-chart-1/15 text-chart-1 border-chart-1/30",
  enterprise: "bg-primary/10 text-primary border-primary/30",
};

const STATUS_LABEL_KEYS: Record<string, string> = {
  active: "active", suspended: "pf-status-suspended", cancelled: "pf-status-cancelled",
};

const STATUS_BADGE: Record<string, string> = {
  active: "bg-chart-1/15 text-chart-1 border-chart-1/30",
  suspended: "bg-destructive/10 text-destructive border-destructive/30",
  cancelled: "bg-muted text-muted-foreground border-border",
};

const PLAN_OPTIONS = ["trial", "starter", "business", "enterprise"] as const;
const STATUS_OPTIONS = ["active", "suspended", "cancelled"] as const;

function flagEmoji(countryCode: string | null | undefined): string {
  if (!countryCode || countryCode.length !== 2) return "🏳️";
  const cc = countryCode.toUpperCase();
  const codePoints = [...cc].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65));
  return String.fromCodePoint(...codePoints);
}

function countryLabel(code: string | null | undefined): string {
  if (!code) return "—";
  const c = COUNTRIES.find((x) => x.code === code);
  return c ? c.name : code;
}

// ─── Company Form Dialog ────────────────────────────────────────────────

interface CompanyForm {
  name: string;
  legal_name: string;
  country: string;
  currency: string;
  plan: string;
  status: string;
}

const EMPTY_COMPANY: CompanyForm = {
  name: "", legal_name: "", country: "", currency: "USD", plan: "trial", status: "active",
};

function CompanyDialog({
  open, onOpenChange, initial, onSubmit, title,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial: CompanyForm;
  onSubmit: (f: CompanyForm) => Promise<void>;
  title: string;
}) {
  const [form, setForm] = useState<CompanyForm>(initial);
  const [saving, setSaving] = useState(false);
  const t = useT();

  // Reset form when dialog opens
  useState(() => { setForm(initial); });

  function set<K extends keyof CompanyForm>(k: K, v: CompanyForm[K]) {
    setForm((prev) => ({ ...prev, [k]: v }));
  }

  async function handleSave() {
    if (!form.name.trim()) { toast.error(t("pf-name-required")); return; }
    setSaving(true);
    try {
      await onSubmit(form);
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e.message || t("pf-save-failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] sm:max-w-2xl max-h-[88vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t("pf-enter-company-details")}</DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2 space-y-1.5">
            <Label>{t("pf-name-label")}</Label>
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder={t("pf-name-placeholder")} />
          </div>
          <div className="md:col-span-2 space-y-1.5">
            <Label>{t("pf-legal-name-label")}</Label>
            <Input value={form.legal_name} onChange={(e) => set("legal_name", e.target.value)} placeholder={t("pf-company-legal-placeholder")} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("pf-country")}</Label>
            <Select value={form.country || "_none"} onValueChange={(v) => set("country", v === "_none" ? "" : v)}>
              <SelectTrigger><SelectValue placeholder={t("pf-select-ellipsis")} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">—</SelectItem>
                {COUNTRIES.map((c) => <SelectItem key={c.code} value={c.code}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("pf-currency")}</Label>
            <Select value={form.currency} onValueChange={(v) => set("currency", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("pf-plan")}</Label>
            <Select value={form.plan} onValueChange={(v) => set("plan", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {PLAN_OPTIONS.map((p) => <SelectItem key={p} value={p}>{t(PLAN_LABEL_KEYS[p])}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("status")}</Label>
            <Select value={form.status} onValueChange={(v) => set("status", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((s) => <SelectItem key={s} value={s}>{t(STATUS_LABEL_KEYS[s])}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="size-4 mr-1.5 animate-spin" />}
            {saving ? t("pf-saving") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── View Users Dialog ──────────────────────────────────────────────────

function ViewUsersDialog({
  open, onOpenChange, tenantId, tenantName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tenantId: string;
  tenantName: string;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const { data: users, isLoading } = useQuery({
    queryKey: ["tenant-users", tenantKey, tenantId],
    queryFn: async () => {
      const r = await fetch(api(`/api/users?tenant_id=${tenantId}`));
      if (!r.ok) throw new Error("Failed to load users");
      const d = await r.json();
      return (d.items || []) as Array<{ id: string; username: string; email: string; full_name: string | null; role: string; active: boolean }>;
    },
    enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] sm:max-w-2xl max-h-[88vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>{t("pf-users-of-tenant").replace("{tenant}", tenantName)}</DialogTitle>
          <DialogDescription>{t("pf-users-of-tenant-desc")}</DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
          {isLoading ? (
            <div className="space-y-2 p-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : !users || users.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">{t("pf-no-users-found")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("name")}</TableHead>
                  <TableHead>{t("pf-role")}</TableHead>
                  <TableHead>{t("status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>
                      <div className="font-medium">{u.full_name || u.username}</div>
                      <div className="text-xs text-muted-foreground">{u.email}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize text-xs">{u.role}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={u.active ? "bg-chart-1/15 text-chart-1 border-chart-1/30" : "bg-muted text-muted-foreground"}>
                        {u.active ? t("active") : t("inactive")}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Assign Admin Dialog ────────────────────────────────────────────────

function AssignAdminDialog({
  open, onOpenChange, tenantId, tenantName, onAssigned,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tenantId: string;
  tenantName: string;
  onAssigned: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [userId, setUserId] = useState("");
  const [saving, setSaving] = useState(false);

  // Fetch all users for assignment
  const { data: allUsers } = useQuery({
    queryKey: ["super-admin-all-users", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/super-admin/users"));
      if (!r.ok) return [];
      const d = await r.json();
      return (d.items || []) as Array<{ id: string; username: string; email: string; full_name: string | null; role: string; tenant_id: string | null }>;
    },
    enabled: open,
  });

  const availableUsers = useMemo(() => {
    if (!allUsers) return [];
    // Users without a tenant or already in this tenant (non-admin)
    return allUsers.filter((u) => !u.tenant_id || u.tenant_id === tenantId);
  }, [allUsers, tenantId]);

  async function handleAssign() {
    if (!userId) { toast.error(t("pf-user-select-required")); return; }
    setSaving(true);
    try {
      const r = await fetch(api("/api/users"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: userId, tenant_id: tenantId, role: "admin" }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || t("pf-assign-admin-failed"));
      }
      toast.success(t("pf-admin-assigned"));
      onAssigned();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e.message || t("pf-assign-admin-failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] sm:max-w-lg max-h-[88vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>{t("pf-assign-admin-title").replace("{tenant}", tenantName)}</DialogTitle>
          <DialogDescription>{t("pf-assign-admin-desc")}</DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          <div className="space-y-1.5">
            <Label>{t("pf-select-user")}</Label>
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger><SelectValue placeholder={t("pf-choose-user-placeholder")} /></SelectTrigger>
              <SelectContent>
                {availableUsers.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.full_name || u.username} ({u.email})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={handleAssign} disabled={saving || !userId}>
            {saving && <Loader2 className="size-4 mr-1.5 animate-spin" />}
            {t("pf-assign-admin-btn")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────

export function SuperAdminOverviewView({ embedded = false }: { embedded?: boolean } = {}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const user = useAppStore((s) => s.user);
  const setView = useAppStore((s) => s.setView);
  const isSuper = isSuperAdmin(user);
  const queryClient = useQueryClient();

  // Dialogs state
  const [createOpen, setCreateOpen] = useState(false);
  const [editTenant, setEditTenant] = useState<TenantStats | null>(null);
  const [deleteTenant, setDeleteTenant] = useState<TenantStats | null>(null);
  // DEL-1: super_admin force-deleting a tenant with users / subscriptions
  // is a high-impact irreversible cascade. Gate the "Confirm" button behind
  // a type-to-match input that requires the operator to type the tenant's
  // name verbatim. Cleared on dialog close.
  const [deleteTenantConfirmText, setDeleteTenantConfirmText] = useState("");
  const [viewUsersTenant, setViewUsersTenant] = useState<TenantStats | null>(null);
  const [assignAdminTenant, setAssignAdminTenant] = useState<TenantStats | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["super-admin-overview", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/super-admin/overview"));
      if (!r.ok) throw new Error("Failed to load overview");
      return r.json() as Promise<OverviewData>;
    },
    enabled: isSuper,
  });

  const recentActivity = useMemo(() => (data?.recent_activity || []).slice(0, 10), [data]);

  // Plan distribution for platform health
  const planDistribution = useMemo(() => {
    if (!data) return [];
    const counts: Record<string, number> = {};
    for (const ts of data.tenants) {
      counts[ts.tenant.plan] = (counts[ts.tenant.plan] || 0) + 1;
    }
    return Object.entries(counts).map(([plan, count]) => ({ plan, count, label: plan }));
  }, [data]);

  // Storage estimate (rough: partners + offers + invoices × average size)
  const storageEstimate = useMemo(() => {
    if (!data) return "0 MB";
    const totalEntities = data.total_partners + data.total_offers + data.total_invoices + data.total_users;
    const mb = Math.max(totalEntities * 0.05, 0.1); // ~50KB per entity estimate
    return mb < 1 ? `${Math.round(mb * 1000)} KB` : `${mb.toFixed(1)} MB`;
  }, [data]);

  async function handleCreateCompany(form: CompanyForm) {
    const r = await fetch(api("/api/tenants"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || t("pf-tenant-create-failed"));
    }
    toast.success(t("pf-company-created"));
    queryClient.invalidateQueries({ queryKey: ["super-admin-overview", tenantKey] });
  }

  async function handleEditCompany(form: CompanyForm) {
    if (!editTenant) return;
    const r = await fetch(api(`/api/tenants/${editTenant.tenant.id}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, id: editTenant.tenant.id }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || t("pf-tenant-update-failed"));
    }
    toast.success(t("pf-company-updated"));
    setEditTenant(null);
    queryClient.invalidateQueries({ queryKey: ["super-admin-overview", tenantKey] });
  }

  async function handleDeleteTenant() {
    if (!deleteTenant) return;
    // DEL-1: pass `confirm: true` so the server's hard-delete path runs
    // unconditionally. Super_admin is the platform owner — they have
    // explicitly confirmed via the type-to-match input above.
    const r = await fetch(api(`/api/tenants/${deleteTenant.tenant.id}`), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || t("pf-tenant-delete-failed"));
    }
    toast.success(t("pf-company-deleted"));
    setDeleteTenant(null);
    setDeleteTenantConfirmText("");
    queryClient.invalidateQueries({ queryKey: ["super-admin-overview", tenantKey] });
  }

  function handleSwitchTenant(tnt: Tenant) {
    // Store tenant context via query param — the URL and resolveTenantId will pick it up
    const url = new URL(window.location.href);
    url.searchParams.set("tenant_id", tnt.id);
    window.history.pushState({}, "", url.toString());
    toast.success(t("pf-switch-context").replace("{name}", tnt.name));
  }

  if (!isSuper) {
    return (
      <div>
        <PageHeader title={t("pf-system-overview")} description={t("pf-system-overview-desc")} />
        <Card className="border-amber-500/30 bg-amber-50/40 dark:bg-amber-500/5">
          <CardContent className="p-6 flex items-start gap-3">
            <div className="size-10 rounded-xl bg-amber-500/15 text-amber-600 flex items-center justify-center shrink-0">
              <ShieldAlert className="size-5" />
            </div>
            <div>
              <p className="font-medium">{t("pf-superadmin-required")}</p>
              <p className="text-sm text-muted-foreground mt-1">
                {t("pf-superadmin-required-desc")}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div>
        <PageHeader title={t("pf-system-overview")} description={t("pf-system-overview-desc")} />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
        <Skeleton className="h-80 w-full rounded-xl" />
      </div>
    );
  }

  const activeRate = data.total_tenants > 0 ? Math.round((data.active_tenants / data.total_tenants) * 100) : 0;
  const inactiveTenants = data.total_tenants - data.active_tenants;

  return (
    <div>
      {!embedded ? <PageHeader
        title={t("pf-system-overview")}
        description={t("pf-system-overview-desc")}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4 mr-1" /> {t("pf-create-company")}
            </Button>
            <Button variant="outline" onClick={() => setView("platform-dashboard")}>
              <Building2 className="size-4 mr-1" /> {t("pf-manage-tenants")}
            </Button>
          </div>
        }
      /> : null}
      <ModuleInfoTooltip
        title="Tenants"
        description="Manage all tenants on the platform. Create, edit, suspend, delete, and manage plans."
        howToUse={["View all tenants with stats (users, partners, deals)", "Edit tenant details (name, plan, features)", "Suspend a tenant (blocks all users)", "Activate a suspended tenant", "Extend trial by 7 days", "Delete (type-to-confirm)", "Impersonate a tenant to see their view"]}
      />

      {/* Create Company Dialog */}
      <CompanyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initial={EMPTY_COMPANY}
        onSubmit={handleCreateCompany}
        title={t("pf-create-company")}
      />

      {/* Edit Company Dialog */}
      {editTenant && (
        <CompanyDialog
          open={!!editTenant}
          onOpenChange={(v) => { if (!v) setEditTenant(null); }}
          initial={{
            name: editTenant.tenant.name,
            legal_name: editTenant.tenant.legal_name || "",
            country: editTenant.tenant.country || "",
            currency: editTenant.tenant.currency,
            plan: editTenant.tenant.plan,
            status: editTenant.tenant.status,
          }}
          onSubmit={handleEditCompany}
          title={t("pf-edit-company")}
        />
      )}

      {/* Delete Confirmation */}
      <AlertDialog
        open={!!deleteTenant}
        onOpenChange={(v) => {
          if (!v) {
            setDeleteTenant(null);
            setDeleteTenantConfirmText("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("pf-delete-company")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("pf-delete-company-confirm").replace("{name}", deleteTenant?.tenant.name || "")}
              {/* DEL-1: stronger warning — super_admin can now force-delete
               * a tenant even when it has users / subscriptions / data. */}
              <span className="block mt-2 text-destructive font-medium">
                This will permanently delete this tenant AND all associated data
                (users, partners, products, deals, invoices, sessions, etc.).
                This cannot be undone.
              </span>
              {deleteTenant && deleteTenant.user_count > 0 && (
                <span className="block mt-2 text-destructive font-medium">
                  {t("pf-delete-company-user-warning").replace("{n}", String(deleteTenant.user_count))}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* DEL-1: type-to-confirm gate. The operator must type the
           * tenant's name verbatim before the destructive action button
           * becomes enabled. Prevents an accidental click from destroying
           * a tenant with thousands of users / invoices. */}
          <div className="space-y-2">
            <Label htmlFor="delete-confirm-tenant-name" className="text-xs text-muted-foreground">
              Type the tenant name (<span className="font-mono text-foreground">{deleteTenant?.tenant.name || "—"}</span>) to confirm:
            </Label>
            <Input
              id="delete-confirm-tenant-name"
              autoComplete="off"
              value={deleteTenantConfirmText}
              onChange={(e) => setDeleteTenantConfirmText(e.target.value)}
              placeholder={deleteTenant?.tenant.name || ""}
              className="font-mono"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteTenant}
              disabled={
                !deleteTenant ||
                deleteTenantConfirmText.trim().toLowerCase() !==
                  (deleteTenant?.tenant.name || "").trim().toLowerCase()
              }
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* View Users Dialog */}
      {viewUsersTenant && (
        <ViewUsersDialog
          open={!!viewUsersTenant}
          onOpenChange={(v) => { if (!v) setViewUsersTenant(null); }}
          tenantId={viewUsersTenant.tenant.id}
          tenantName={viewUsersTenant.tenant.name}
        />
      )}

      {/* Assign Admin Dialog */}
      {assignAdminTenant && (
        <AssignAdminDialog
          open={!!assignAdminTenant}
          onOpenChange={(v) => { if (!v) setAssignAdminTenant(null); }}
          tenantId={assignAdminTenant.tenant.id}
          tenantName={assignAdminTenant.tenant.name}
          onAssigned={() => queryClient.invalidateQueries({ queryKey: ["super-admin-overview", tenantKey] })}
        />
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <KpiCard
          label={t("pf-total-tenants")}
          value={fmtNumber(data.total_tenants)}
          sub={t("pf-total-tenants-sub").replace("{n}", String(data.active_tenants)).replace("{pct}", String(activeRate))}
          icon={Building2}
        />
        <KpiCard
          label={t("pf-total-users")}
          value={fmtNumber(data.total_users)}
          sub={t("pf-across-all-tenants")}
          icon={Users}
        />
        <KpiCard
          label={t("pf-total-partners")}
          value={fmtNumber(data.total_partners)}
          sub={t("pf-total-partners-sub")}
          icon={Handshake}
        />
        <KpiCard
          label={t("pf-total-offers")}
          value={fmtNumber(data.total_offers)}
          sub={t("pf-total-offers-sub").replace("{n}", fmtNumber(data.total_invoices))}
          icon={FileText}
        />
      </div>

      {/* Tenant table */}
      <Card className="border-border/60 shadow-soft rounded-xl mb-6">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Server className="size-4 text-primary" /> {t("pf-tenant-registry")}
              </CardTitle>
              <CardDescription className="text-xs mt-1">
                {t("pf-tenant-registry-desc")}
              </CardDescription>
            </div>
            <Badge variant="outline" className="tabular">{t("pf-tenants-count-badge").replace("{n}", String(data.tenants.length))}</Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[420px] overflow-y-auto custom-scroll">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10">
                <TableRow>
                  <TableHead>{t("name")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("pf-country")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("pf-currency")}</TableHead>
                  <TableHead>{t("pf-plan")}</TableHead>
                  <TableHead>{t("status")}</TableHead>
                  <TableHead className="text-right">{t("pf-users")}</TableHead>
                  <TableHead className="text-right hidden sm:table-cell">{t("pf-partners")}</TableHead>
                  <TableHead className="hidden xl:table-cell">{t("pf-created")}</TableHead>
                  <TableHead className="text-right">{t("actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.tenants.map((ts) => (
                  <TableRow key={ts.tenant.id} className="hover:bg-muted/50 transition-colors">
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {ts.tenant.primary_color && (
                          <span
                            className="size-2.5 rounded-full border border-border/60 shrink-0"
                            style={{ backgroundColor: ts.tenant.primary_color }}
                          />
                        )}
                        <div className="min-w-0">
                          <div className="font-medium truncate">{ts.tenant.name}</div>
                          <div className="text-xs text-muted-foreground truncate">
                            {ts.tenant.legal_name || "—"}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <div className="flex items-center gap-1.5 text-sm">
                        <span className="text-base leading-none">{flagEmoji(ts.tenant.country)}</span>
                        <span className="truncate max-w-[140px]">{countryLabel(ts.tenant.country)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <Badge variant="outline" className="font-mono tabular text-xs">{ts.tenant.currency}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={PLAN_BADGE[ts.tenant.plan] || ""}>
                        {t(PLAN_LABEL_KEYS[ts.tenant.plan] || "pf-plan")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={STATUS_BADGE[ts.tenant.status] || ""}>
                        <CircleDot className="size-3 mr-1" />
                        {t(STATUS_LABEL_KEYS[ts.tenant.status] || "status")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular text-sm">{ts.user_count}</TableCell>
                    <TableCell className="text-right tabular text-sm hidden sm:table-cell">{ts.partner_count}</TableCell>
                    <TableCell className="hidden xl:table-cell text-sm text-muted-foreground tabular">
                      {fmtDate(ts.tenant.created_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setEditTenant(ts)} title={t("edit")}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setViewUsersTenant(ts)} title={t("pf-view-users")}>
                          <Eye className="size-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setAssignAdminTenant(ts)} title={t("pf-assign-admin")}>
                          <ShieldCheck className="size-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => handleSwitchTenant(ts.tenant)} title={t("pf-switch-tenant")}>
                          <Repeat className="size-3.5" />
                        </Button>
                        {/* Quick actions: Suspend / Activate / Extend Trial */}
                        {ts.tenant.status !== "suspended" && ts.tenant.status !== "cancelled" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-amber-600 hover:text-amber-700"
                            onClick={async () => {
                              if (!confirm(`Suspend tenant "${ts.tenant.name}"? All users in this tenant will be blocked from logging in.`)) return;
                              // AUDIT19 (frontend #7) — try/catch: a network-level
                              // fetch rejection (offline / DNS / proxy 502) previously
                              // became an unhandled promise with ZERO user feedback.
                              try {
                                const r = await fetch(api(`/api/tenants/${ts.tenant.id}`), {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ id: ts.tenant.id, status: "suspended" }),
                                });
                                if (r.ok) { toast.success("Tenant suspended"); queryClient.invalidateQueries({ queryKey: ["super-admin-overview", tenantKey] }); }
                                else { toast.error("Failed to suspend"); }
                              } catch { toast.error("Network error — tenant not suspended."); }
                            }}
                            title="Suspend"
                          >
                            <Pause className="size-3.5" />
                          </Button>
                        )}
                        {ts.tenant.status === "suspended" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-emerald-600 hover:text-emerald-700"
                            onClick={async () => {
                              // AUDIT19 (frontend #7) — try/catch (see suspend button).
                              try {
                                const r = await fetch(api(`/api/tenants/${ts.tenant.id}`), {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ id: ts.tenant.id, status: "active" }),
                                });
                                if (r.ok) { toast.success("Tenant activated"); queryClient.invalidateQueries({ queryKey: ["super-admin-overview", tenantKey] }); }
                                else { toast.error("Failed to activate"); }
                              } catch { toast.error("Network error — tenant not activated."); }
                            }}
                            title="Activate"
                          >
                            <Play className="size-3.5" />
                          </Button>
                        )}
                        {ts.tenant.status === "trial" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-blue-600 hover:text-blue-700"
                            onClick={async () => {
                              // AUDIT19 (frontend #7) — try/catch (see suspend button).
                              const newEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
                              try {
                                const r = await fetch(api(`/api/tenants/${ts.tenant.id}`), {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ id: ts.tenant.id, trial_ends_at: newEnd }),
                                });
                                if (r.ok) { toast.success("Trial extended +7 days"); queryClient.invalidateQueries({ queryKey: ["super-admin-overview", tenantKey] }); }
                                else { toast.error("Failed to extend trial"); }
                              } catch { toast.error("Network error — trial not extended."); }
                            }}
                            title="Extend Trial +7 days"
                          >
                            <CalendarPlus className="size-3.5" />
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive hover:text-destructive" onClick={() => setDeleteTenant(ts)} title={t("delete")}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Deep-dive shortcuts — the full audit trail lives in the dedicated
          Platform Audit view, and full health metrics live in Platform Health.
          Keeping just link cards here to avoid duplicating those pages. */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card
          className="border-border/60 shadow-soft rounded-xl cursor-pointer hover:border-primary/40 smooth"
          onClick={() => setView("platform-audit")}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="size-4 text-primary" /> {t("pf-platform-activity")}
            </CardTitle>
            <CardDescription className="text-xs">{t("pf-platform-activity-desc")}</CardDescription>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">{t("pf-open-platform-audit")}</CardContent>
        </Card>

        <Card
          className="border-border/60 shadow-soft rounded-xl cursor-pointer hover:border-primary/40 smooth"
          onClick={() => setView("platform-health")}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Heart className="size-4 text-primary" /> {t("pf-platform-health-card")}
            </CardTitle>
            <CardDescription className="text-xs">{t("pf-platform-health-card-desc")}</CardDescription>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">{t("pf-open-platform-health")}</CardContent>
        </Card>
      </div>

      {/* Platform-wide rate-limit configuration (super-admin only).
          Lets the platform owner tune login / forgot-password / setup-password
          rate limits without a redeploy. Backed by the settings table. */}
      <div className="mt-4">
        <RateLimitsCard />
      </div>

      {/* Footer note */}
      <div className="mt-6 flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <Clock className="size-3" />
        <span>{t("pf-snapshot-loaded")} <span className="tabular">{fmtDateTime(new Date().toISOString())}</span></span>
      </div>
    </div>
  );
}
