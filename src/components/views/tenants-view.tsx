"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Plus, Pencil, Trash2, Building2, ShieldAlert, Users, Globe, CreditCard,
  CheckCircle2, Layers, ChevronDown, ImageIcon, Upload,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { KpiCard } from "@/components/common/kpi-card";
import { fmtDate } from "@/lib/utils/format";
import { Tenant } from "@/lib/supabase/types";
import { useAppStore, isSuperAdmin } from "@/lib/store/app-store";
import { COUNTRIES, CURRENCIES } from "@/lib/data/reference";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useI18nStore } from "@/lib/i18n/store";
import { t } from "@/lib/i18n/dictionaries";

// ---- helpers ----
function flagEmoji(countryCode: string | null | undefined): string {
  if (!countryCode || countryCode.length !== 2) return "";
  const cc = countryCode.toUpperCase();
  const codePoints = [...cc].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65));
  return String.fromCodePoint(...codePoints);
}

function countryLabel(code: string | null | undefined): string {
  if (!code) return "—";
  const c = COUNTRIES.find((x) => x.code === code);
  return c ? c.name : code;
}

type Plan = Tenant["plan"];
type TenantStatus = Tenant["status"];

const PLAN_LABEL_KEYS: Record<Plan, string> = {
  trial: "pf-plan-trial", starter: "pf-plan-starter", business: "pf-plan-business", enterprise: "pf-plan-enterprise", custom: "pf-plan-custom",
};

const PLAN_BADGE: Record<Plan, string> = {
  trial: "bg-secondary text-secondary-foreground",
  starter: "bg-chart-4/15 text-chart-4 border-chart-4/30",
  business: "bg-chart-1/15 text-chart-1 border-chart-1/30",
  enterprise: "bg-primary/10 text-primary border-primary/30",
  custom: "bg-violet-500/15 text-violet-700 dark:text-violet-400 border-violet-500/30",
};

const STATUS_LABEL_KEYS: Record<TenantStatus, string> = {
  active: "active", suspended: "pf-status-suspended", cancelled: "pf-status-cancelled",
};

const STATUS_BADGE: Record<TenantStatus, string> = {
  active: "bg-chart-1/15 text-chart-1 border-chart-1/30",
  suspended: "bg-destructive/10 text-destructive border-destructive/30",
  cancelled: "bg-muted text-muted-foreground border-border",
};

export function TenantsView({ embedded = false }: { embedded?: boolean } = {}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const locale = useI18nStore((s) => s.locale);

  const qc = useQueryClient();
  const user = useAppStore((s) => s.user);
  const [editing, setEditing] = useState<Tenant | null>(null);
  const [showForm, setShowForm] = useState(false);
  // DEL-1: store the full tenant record (not just the id) so the delete
  // confirmation dialog can render the tenant name and gate the "Confirm"
  // button behind a type-to-match input.
  const [deleteTarget, setDeleteTarget] = useState<Tenant | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const isSuper = isSuperAdmin(user);

  const { data, isLoading } = useQuery({
    queryKey: ["tenants", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/tenants"));
      if (!r.ok) throw new Error("Failed to load tenants");
      return r.json() as Promise<{ items: Tenant[] }>;
    },
    enabled: isSuper,
  });

  const deleteMut = useMutation({
    mutationFn: async (tenant: Tenant) => {
      // DEL-1: pass `confirm: true` so the server's hard-delete cascade
      // (deleteTenantCascade) runs unconditionally for super_admin callers.
      // Without this, the server 409s on tenants that have any dependent
      // rows (users, partners, invoices, …).
      const r = await fetch(api(`/api/tenants/${tenant.id}`), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Delete failed");
      }
    },
    onSuccess: () => {
      toast.success("Tenant deleted.");
      qc.invalidateQueries({ queryKey: ["tenants", tenantKey] });
      setDeleteTarget(null);
      setDeleteConfirmText("");
    },
    onError: (e: any) => toast.error(e.message || "Delete failed."),
  });

  // DEL-1: type-to-confirm gate — the operator must type the tenant name
  // verbatim before the destructive action button is enabled. Prevents an
  // accidental click from destroying a tenant with all its data.
  const deleteConfirmMatches =
    deleteTarget !== null &&
    deleteConfirmText.trim().toLowerCase() === (deleteTarget.name || "").trim().toLowerCase();

  if (!isSuper) {
    return (
      <div>
        <PageHeader title="Tenants" description="Platform-wide tenant administration." />
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

  const items = data?.items || [];
  const totalTenants = items.length;
  const activeCount = items.filter((tn) => tn.status === "active").length;
  const planBreakdown: Record<Plan, number> = { trial: 0, starter: 0, business: 0, enterprise: 0, custom: 0 };
  items.forEach((tn) => { planBreakdown[tn.plan]++; });

  return (
    <div>
      <PageHeader
        title={t(locale, "tenants")}
        description={`${totalTenants} ${t(locale, "total").toLowerCase()}`}
        actions={
          <Button onClick={() => { setEditing(null); setShowForm(true); }}>
            <Plus className="size-4 mr-1" /> {t(locale, "pf-new-tenant")}
          </Button>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <KpiCard label={t(locale, "pf-kpi-total-tenants")} value={totalTenants} icon={Building2} sub={t(locale, "pf-kpi-total-tenants-sub")} />
        <KpiCard label={t(locale, "active")} value={activeCount} icon={CheckCircle2} sub={t(locale, "pf-kpi-active-sub").replace("{pct}", String(totalTenants > 0 ? Math.round((activeCount / totalTenants) * 100) : 0))} />
        <KpiCard
          label={t(locale, "pf-kpi-plan-breakdown")}
          value={`${planBreakdown.business}b · ${planBreakdown.enterprise}e`}
          icon={Layers}
          sub={`${t(locale, "pf-plan-trial")} ${planBreakdown.trial} · ${t(locale, "pf-plan-starter")} ${planBreakdown.starter}`}
        />
        <KpiCard label={t(locale, "pf-kpi-total-seats")} value={items.reduce((s, tn) => s + (tn.max_users || 0), 0)} icon={Users} sub={t(locale, "pf-kpi-total-seats-sub")} />
      </div>

      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Building2 className="size-6" />}
              title={t(locale, "pf-no-tenants")}
              description={t(locale, "pf-no-tenants-desc")}
              action={<Button onClick={() => { setEditing(null); setShowForm(true); }}><Plus className="size-4 mr-1" /> {t(locale, "pf-new-tenant")}</Button>}
            />
          ) : (
            <div className="max-h-[calc(100vh-280px)] overflow-y-auto custom-scroll">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead>{t(locale, "name")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t(locale, "pf-country")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t(locale, "pf-currency")}</TableHead>
                    <TableHead>{t(locale, "pf-plan")}</TableHead>
                    <TableHead>{t(locale, "status")}</TableHead>
                    <TableHead className="text-right">{t(locale, "pf-users")}</TableHead>
                    <TableHead className="hidden xl:table-cell">{t(locale, "pf-created")}</TableHead>
                    <TableHead className="text-right">{t(locale, "actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((tn) => (
                    <TableRow key={tn.id} className="hover:bg-muted/50 transition-colors">
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {tn.primary_color && (
                            <span className="size-3 rounded-full border border-border/60 shrink-0" style={{ backgroundColor: tn.primary_color }} />
                          )}
                          <div className="min-w-0">
                            <div className="font-medium truncate">{tn.name}</div>
                            <div className="text-xs text-muted-foreground truncate">{tn.legal_name || "—"}</div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <div className="flex items-center gap-1.5 text-sm">
                          <span className="text-base leading-none">{flagEmoji(tn.country) || "🏳️"}</span>
                          <span>{countryLabel(tn.country)}</span>
                        </div>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <Badge variant="outline" className="font-mono tabular">{tn.currency}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={PLAN_BADGE[tn.plan]}>{t(locale, PLAN_LABEL_KEYS[tn.plan])}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={STATUS_BADGE[tn.status]}>{t(locale, STATUS_LABEL_KEYS[tn.status])}</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular text-sm">{tn.max_users}</TableCell>
                      <TableCell className="hidden xl:table-cell text-sm text-muted-foreground tabular">{fmtDate(tn.created_at)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button size="icon" variant="ghost" className="size-8" onClick={() => { setEditing(tn); setShowForm(true); }} title={t(locale, "edit")}>
                            <Pencil className="size-4" />
                          </Button>
                          <Button size="icon" variant="ghost" className="size-8 text-destructive" onClick={() => { setDeleteTarget(tn); setDeleteConfirmText(""); }} title={t(locale, "delete")}>
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <TenantFormDialog
        open={showForm}
        onOpenChange={setShowForm}
        tenant={editing}
        onSaved={() => {
          setShowForm(false);
          qc.invalidateQueries({ queryKey: ["tenants", tenantKey] });
        }}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) {
            setDeleteTarget(null);
            setDeleteConfirmText("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(locale, "pf-delete-tenant-title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(locale, "pf-delete-tenant-desc")}
              {/* DEL-1: stronger warning — super_admin can now force-delete a
               * tenant even when it has users / subscriptions / data. */}
              <span className="block mt-2 text-destructive font-medium">
                This will permanently delete this tenant AND all associated data
                (users, partners, products, deals, invoices, sessions, etc.).
                This cannot be undone.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* DEL-1: type-to-confirm gate. */}
          <div className="space-y-2">
            <Label htmlFor="delete-confirm-tenant-name" className="text-xs text-muted-foreground">
              Type the tenant name (<span className="font-mono text-foreground">{deleteTarget?.name || "—"}</span>) to confirm:
            </Label>
            <Input
              id="delete-confirm-tenant-name"
              autoComplete="off"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={deleteTarget?.name || ""}
              className="font-mono"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(locale, "cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMut.mutate(deleteTarget)}
              disabled={!deleteConfirmMatches}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t(locale, "delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---- Form dialog ----
function TenantFormDialog({
  open, onOpenChange, tenant, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tenant: Tenant | null;
  onSaved: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const [form, setForm] = useState<Partial<Tenant>>({});
  const [saving, setSaving] = useState(false);
  const [addressOpen, setAddressOpen] = useState(false);
  const [bankingOpen, setBankingOpen] = useState(false);
  const [subscriptionOpen, setSubscriptionOpen] = useState(false);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);

  const isEditing = !!tenant;

  useEffect(() => {
    if (open) {
      setForm(tenant
        ? { ...tenant }
        : ({
            name: "", legal_name: "", country: "", currency: "EUR",
            tax_id: "", vat_number: "", registration_number: "",
            address_line: "", city: "", postal_code: "",
            bank_name: "", bank_iban: "", bank_swift: "",
            plan: "business", status: "active", max_users: 10, primary_color: "",
          } as Partial<Tenant>));
      setLogoFile(null);
      setLogoPreview(tenant?.logo_url || null);
      // When editing, expand sections that have data
      if (tenant) {
        const hasAddress = tenant.address_line || tenant.city || tenant.postal_code;
        const hasBanking = tenant.bank_name || tenant.bank_iban || tenant.bank_swift;
        setAddressOpen(!!hasAddress);
        setBankingOpen(!!hasBanking);
        setSubscriptionOpen(true); // always show subscription when editing
      } else {
        setAddressOpen(false);
        setBankingOpen(false);
        setSubscriptionOpen(false);
      }
    }
  }, [open, tenant]);

  function set<K extends keyof Tenant>(k: K, v: Tenant[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function uploadLogo(tenantId: string, file: File) {
    const formData = new FormData();
    formData.append("logo", file);
    const r = await fetch(api(`/api/tenants/${tenantId}/logo`), {
      method: "POST",
      body: formData,
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || "Logo upload failed");
    }
    return r.json();
  }

  async function save() {
    if (!form.name) { toast.error("Name is required."); return; }
    setSaving(true);
    try {
      const method = tenant ? "PUT" : "POST";
      const url = tenant ? api(`/api/tenants/${tenant.id}`) : api("/api/tenants");
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Request failed");
      }
      const result = await r.json();
      const savedId = tenant?.id || result?.id;

      // Upload logo if a new file was selected
      if (logoFile && savedId) {
        try {
          await uploadLogo(savedId, logoFile);
        } catch (uploadErr: unknown) {
          toast.error(uploadErr instanceof Error ? uploadErr.message : "Logo upload failed.");
          // Still consider the tenant saved, just the logo failed
          onSaved();
          return;
        }
      }

      toast.success(tenant ? "Tenant updated." : `"${form.name}" created successfully!`);
      onSaved();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Saving failed.");
    } finally {
      setSaving(false);
    }
  }

  // Helper: check if a collapsed section has data
  const sectionBadge = (hasData: boolean) =>
    hasData ? <Badge variant="secondary" className="ml-2 text-xs px-1.5 py-0">Filled</Badge> : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>{tenant ? "Edit tenant" : "New tenant"}</DialogTitle>
          <DialogDescription>
            {tenant ? "Update the tenant details." : "Start with the basics — you can add more details later."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
          <div className="space-y-4">

            {/* ── Logo ── */}
            <div className="flex items-start gap-4">
              <div className="shrink-0">
                <div className="size-16 rounded-lg border border-border/60 bg-muted/30 flex items-center justify-center overflow-hidden">
                  {logoPreview ? (
                    <img src={logoPreview} alt="Logo" className="size-full object-contain" />
                  ) : (
                    <ImageIcon className="size-8 text-muted-foreground/40" />
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-1.5 min-w-0">
                <Label className="text-sm">Company Logo</Label>
                <div className="flex items-center gap-2">
                  <label htmlFor="logo-upload" className="cursor-pointer">
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted/50 transition-colors">
                      <Upload className="size-3.5" />
                      Upload Logo
                    </span>
                    <input
                      id="logo-upload"
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/svg+xml"
                      className="sr-only"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) {
                          setLogoFile(f);
                          const reader = new FileReader();
                          reader.onload = (ev) => setLogoPreview(ev.target?.result as string);
                          reader.readAsDataURL(f);
                        }
                      }}
                    />
                  </label>
                </div>
                {logoFile && (
                  <p className="text-xs text-muted-foreground truncate">{logoFile.name}</p>
                )}
                <p className="text-xs text-muted-foreground">PNG, JPEG, WebP or SVG. Max 2MB.</p>
              </div>
            </div>

            <Separator />

            {/* ── Essential fields (always visible) ── */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="md:col-span-2 space-y-1.5">
                <Label>Company Name *</Label>
                <Input value={form.name || ""} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Acme Trading" autoFocus />
              </div>
              <div className="space-y-1.5">
                <Label>Country</Label>
                <Select value={form.country || ""} onValueChange={(v) => set("country", v)}>
                  <SelectTrigger><SelectValue placeholder="Select country" /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {COUNTRIES.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        <span className="mr-2">{flagEmoji(c.code)}</span>{c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Currency</Label>
                <Select value={form.currency || "EUR"} onValueChange={(v) => set("currency", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {CURRENCIES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        <span className="font-mono mr-2">{c.value}</span> {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* ── Legal & Tax (collapsible) ── */}
            <Collapsible open={addressOpen} onOpenChange={setAddressOpen}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className="w-full flex items-center justify-between px-0 hover:bg-transparent">
                  <span className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    Legal & Address
                    {sectionBadge(!!(form.legal_name || form.tax_id || form.vat_number || form.registration_number || form.address_line || form.city || form.postal_code))}
                  </span>
                  <ChevronDown className={`size-4 text-muted-foreground transition-transform ${addressOpen ? "rotate-180" : ""}`} />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
                  <div className="space-y-1.5">
                    <Label>Legal name</Label>
                    <Input value={form.legal_name || ""} onChange={(e) => set("legal_name", e.target.value)} placeholder="Acme Trading Ltd." />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Tax ID</Label>
                    <Input value={form.tax_id || ""} onChange={(e) => set("tax_id", e.target.value)} placeholder="e.g. 123456789" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>VAT number</Label>
                    <Input value={form.vat_number || ""} onChange={(e) => set("vat_number", e.target.value)} placeholder="e.g. RS123456789" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Registration number</Label>
                    <Input value={form.registration_number || ""} onChange={(e) => set("registration_number", e.target.value)} />
                  </div>
                  <div className="md:col-span-2 space-y-1.5">
                    <Label>Address</Label>
                    <Input value={form.address_line || ""} onChange={(e) => set("address_line", e.target.value)} placeholder="Street and number" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>City</Label>
                    <Input value={form.city || ""} onChange={(e) => set("city", e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Postal code</Label>
                    <Input value={form.postal_code || ""} onChange={(e) => set("postal_code", e.target.value)} />
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>

            {/* ── Banking (collapsible) ── */}
            <Collapsible open={bankingOpen} onOpenChange={setBankingOpen}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className="w-full flex items-center justify-between px-0 hover:bg-transparent">
                  <span className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    Bank Details
                    {sectionBadge(!!(form.bank_name || form.bank_iban || form.bank_swift))}
                  </span>
                  <ChevronDown className={`size-4 text-muted-foreground transition-transform ${bankingOpen ? "rotate-180" : ""}`} />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
                  <div className="space-y-1.5">
                    <Label>Bank name</Label>
                    <Input value={form.bank_name || ""} onChange={(e) => set("bank_name", e.target.value)} placeholder="e.g. National Bank" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>IBAN</Label>
                    <Input value={form.bank_iban || ""} onChange={(e) => set("bank_iban", e.target.value)} placeholder="e.g. RS35107007000000123456" className="font-mono" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>SWIFT / BIC</Label>
                    <Input value={form.bank_swift || ""} onChange={(e) => set("bank_swift", e.target.value)} placeholder="e.g. NBORCSBG" className="font-mono" />
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>

            {/* ── Subscription (collapsible) ── */}
            <Collapsible open={subscriptionOpen} onOpenChange={setSubscriptionOpen}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className="w-full flex items-center justify-between px-0 hover:bg-transparent">
                  <span className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    Subscription & Settings
                    {sectionBadge(true)}
                  </span>
                  <ChevronDown className={`size-4 text-muted-foreground transition-transform ${subscriptionOpen ? "rotate-180" : ""}`} />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
                  <div className="space-y-1.5">
                    <Label>Plan</Label>
                    <Select value={form.plan || "business"} onValueChange={(v) => set("plan", v as Plan)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="trial">Trial</SelectItem>
                        <SelectItem value="starter">Starter</SelectItem>
                        <SelectItem value="business">Business</SelectItem>
                        <SelectItem value="enterprise">Enterprise</SelectItem>
                        <SelectItem value="custom">Custom (manage flags manually)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Status</Label>
                    <Select value={form.status || "active"} onValueChange={(v) => set("status", v as TenantStatus)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="suspended">Suspended</SelectItem>
                        <SelectItem value="cancelled">Cancelled</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Max users</Label>
                    <Input type="number" min={1} value={form.max_users ?? 10} onChange={(e) => set("max_users", Number(e.target.value))} className="tabular" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Trial days</Label>
                    <Input
                      type="number" min={0}
                      value={(form as any).trial_days ?? 10}
                      onChange={(e) => set("trial_days" as any, Number(e.target.value) as any)}
                      className="tabular"
                    />
                    <p className="text-xs text-muted-foreground">Default is 10. Set 0 to skip trial entirely.</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Trial ends at</Label>
                    <Input
                      type="date"
                      value={(form as any).trial_ends_at ? String((form as any).trial_ends_at).slice(0, 10) : ""}
                      onChange={(e) => set("trial_ends_at" as any, (e.target.value || null) as any)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Subscription end</Label>
                    <Input
                      type="date"
                      value={(form as any).subscription_end ? String((form as any).subscription_end).slice(0, 10) : ""}
                      onChange={(e) => set("subscription_end" as any, (e.target.value || null) as any)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Primary color (optional)</Label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={form.primary_color || "#0f766e"}
                        onChange={(e) => set("primary_color", e.target.value)}
                        className="size-9 rounded-md border border-border cursor-pointer bg-background p-1"
                        aria-label="Primary color"
                      />
                      <Input
                        value={form.primary_color || ""}
                        onChange={(e) => set("primary_color", e.target.value)}
                        placeholder="#0f766e"
                        className="font-mono"
                      />
                    </div>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>

          </div>
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : tenant ? "Save changes" : "Create tenant"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
