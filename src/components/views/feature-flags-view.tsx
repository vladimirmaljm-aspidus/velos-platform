"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Users,
  Calculator,
  Receipt,
  Boxes,
  ExternalLink,
  ShieldCheck,
  FileText,
  ScanLine,
  Lock,
  Key,
  Webhook,
  Mail,
  AlertTriangle,
  Save,
  Loader2,
  Building2,
  Truck,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { ModuleInfoTooltip } from "@/components/common/module-info-tooltip";

import { useAppStore, isSuperAdmin } from "@/lib/store/app-store";
import type { Tenant, TenantFeatureFlags } from "@/lib/supabase/types";
import { cn } from "@/lib/utils";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useT } from "@/lib/i18n/store";

// ---------------------------------------------------------------
// Module catalog — the 13 togglable modules
// ---------------------------------------------------------------
interface ModuleDef {
  key: keyof TenantFeatureFlags;
  name: string;
  description: string;
  icon: LucideIcon;
}

const MODULES: ModuleDef[] = [
  {
    key: "module_crm",
    name: "CRM",
    description: "Partners, deals, offers, demands, documents and tasks.",
    icon: Users,
  },
  {
    key: "module_trade",
    name: "Trade",
    description: "Product catalog, supplier offers and landed cost calculator.",
    icon: Calculator,
  },
  {
    key: "module_finance",
    name: "Finance",
    description: "Invoices, proformas and document register.",
    icon: Receipt,
  },
  {
    key: "module_inventory",
    name: "Inventory",
    description: "Stock movements and warehouse tracking.",
    icon: Boxes,
  },
  {
    key: "module_portal",
    name: "Client Portal",
    description: "Self-service portal for partners and buyers.",
    icon: ExternalLink,
  },
  {
    key: "module_logistics",
    name: "Logistics",
    description: "Portal freight quote requests + admin tracking / packing list PDFs.",
    icon: Truck,
  },
  {
    key: "module_kyc",
    name: "KYC Verification",
    description: "Know-Your-Customer submissions and approval workflow.",
    icon: ShieldCheck,
  },
  {
    key: "module_document_templates",
    name: "Document Templates",
    description: "Custom PDF layouts for offers, invoices and proformas.",
    icon: FileText,
  },
  {
    key: "module_document_verification",
    name: "Document Verification",
    description: "QR codes and forensic hash verification for issued PDFs.",
    icon: ScanLine,
  },
  {
    key: "module_vault",
    name: "Vault",
    description: "Encrypted secrets storage (API tokens, SMTP, etc.).",
    icon: Lock,
  },
  {
    key: "module_api_keys",
    name: "API Keys",
    description: "Issue and rotate programmatic access keys.",
    icon: Key,
  },
  {
    key: "module_webhooks",
    name: "Webhooks",
    description: "Outbound event notifications to external services.",
    icon: Webhook,
  },
  {
    key: "module_mail_queue",
    name: "Mail Queue",
    description: "Transactional email queue with retry tracking.",
    icon: Mail,
  },
  {
    key: "module_security",
    name: "Security Center",
    description: "Sessions, login history, known IPs and trusted devices.",
    icon: ShieldCheck,
  },
];

// ---------------------------------------------------------------
// Default flags used when a tenant has no flags row yet
// ---------------------------------------------------------------
const DEFAULT_FLAGS: Omit<TenantFeatureFlags, "id" | "tenant_id" | "updated_by" | "updated_at"> = {
  module_crm: true,
  module_trade: true,
  module_finance: true,
  module_inventory: true,
  module_portal: true,
  module_logistics: true,
  module_kyc: true,
  module_document_templates: true,
  module_document_verification: true,
  module_vault: true,
  module_api_keys: true,
  module_webhooks: true,
  module_mail_queue: true,
  module_security: true,
  max_partners: 0,
  max_users: 0,
  max_monthly_documents: 0,
  beta_ai_assistant: false,
  beta_advanced_analytics: false,
};

type EditableFlags = Omit<TenantFeatureFlags, "id" | "updated_by" | "updated_at">;

// ---------------------------------------------------------------
// Main view
// ---------------------------------------------------------------
export function FeatureFlagsView({ embedded = false }: { embedded?: boolean } = {}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const user = useAppStore((s) => s.user);
  const qc = useQueryClient();

  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [limitsDraft, setLimitsDraft] = useState<{
    max_partners: number;
    max_users: number;
    max_monthly_documents: number;
  }>({ max_partners: 0, max_users: 0, max_monthly_documents: 0 });

  // ---- Load tenants list ----
  const tenantsQ = useQuery<{ items: Tenant[] }>({
    queryKey: ["tenants", tenantKey, "list"],
    queryFn: async () => {
      const r = await fetch(api("/api/tenants"));
      if (!r.ok) throw new Error("Failed to load tenants");
      return r.json();
    },
  });

  const tenants = tenantsQ.data?.items ?? [];
  const selectedTenant = useMemo(
    () => tenants.find((t) => t.id === selectedTenantId) ?? null,
    [tenants, selectedTenantId]
  );

  // Auto-select first tenant once loaded
  if (!selectedTenantId && tenants.length > 0) {
    setSelectedTenantId(tenants[0].id);
  }

  // ---- Load flags for selected tenant ----
  const flagsQ = useQuery<TenantFeatureFlags | null>({
    queryKey: ["feature-flags", tenantKey, selectedTenantId],
    queryFn: async () => {
      if (!selectedTenantId) return null;
      const r = await fetch(api(`/api/feature-flags?tenant_id=${encodeURIComponent(selectedTenantId)}`));
      if (!r.ok) {
        if (r.status === 404) return null;
        throw new Error("Failed to load feature flags");
      }
      const data = await r.json();
      return (data.flags ?? data.raw ?? data) as TenantFeatureFlags | null;
    },
    enabled: !!selectedTenantId,
  });

  // Sync limits draft when flags load / tenant changes
  const flags = flagsQ.data ?? null;
  const merged: EditableFlags | null = useMemo(() => {
    if (!selectedTenantId) return null;
    return {
      tenant_id: selectedTenantId,
      module_crm: flags?.module_crm ?? DEFAULT_FLAGS.module_crm,
      module_trade: flags?.module_trade ?? DEFAULT_FLAGS.module_trade,
      module_finance: flags?.module_finance ?? DEFAULT_FLAGS.module_finance,
      module_inventory: flags?.module_inventory ?? DEFAULT_FLAGS.module_inventory,
      module_portal: flags?.module_portal ?? DEFAULT_FLAGS.module_portal,
      module_logistics: (flags as any)?.module_logistics ?? DEFAULT_FLAGS.module_logistics,
      module_kyc: flags?.module_kyc ?? DEFAULT_FLAGS.module_kyc,
      module_document_templates:
        flags?.module_document_templates ?? DEFAULT_FLAGS.module_document_templates,
      module_document_verification:
        flags?.module_document_verification ?? DEFAULT_FLAGS.module_document_verification,
      module_vault: flags?.module_vault ?? DEFAULT_FLAGS.module_vault,
      module_api_keys: flags?.module_api_keys ?? DEFAULT_FLAGS.module_api_keys,
      module_webhooks: flags?.module_webhooks ?? DEFAULT_FLAGS.module_webhooks,
      module_mail_queue: flags?.module_mail_queue ?? DEFAULT_FLAGS.module_mail_queue,
      module_security: flags?.module_security ?? DEFAULT_FLAGS.module_security,
      max_partners: flags?.max_partners ?? DEFAULT_FLAGS.max_partners,
      max_users: flags?.max_users ?? DEFAULT_FLAGS.max_users,
      max_monthly_documents: flags?.max_monthly_documents ?? DEFAULT_FLAGS.max_monthly_documents,
      beta_ai_assistant: flags?.beta_ai_assistant ?? DEFAULT_FLAGS.beta_ai_assistant,
      beta_advanced_analytics:
        flags?.beta_advanced_analytics ?? DEFAULT_FLAGS.beta_advanced_analytics,
    };
  }, [flags, selectedTenantId]);

  // Resync limits draft whenever the selected tenant changes or flags first
  // load. Uses the "store previous state" pattern (React docs) instead of
  // useEffect+setState which trips the react-hooks/set-state-in-effect rule.
  const [syncedTenantId, setSyncedTenantId] = useState<string | null>(null);
  if (merged && syncedTenantId !== merged.tenant_id) {
    setSyncedTenantId(merged.tenant_id);
    setLimitsDraft({
      max_partners: merged.max_partners,
      max_users: merged.max_users,
      max_monthly_documents: merged.max_monthly_documents,
    });
  }

  // ---- Save mutation (single source of truth) ----
  const saveMut = useMutation({
    mutationFn: async (body: Partial<EditableFlags> & { tenant_id: string }) => {
      const r = await fetch(api("/api/feature-flags"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err?.error || "Failed to update feature flags");
      }
      return r.json() as Promise<TenantFeatureFlags>;
    },
    onSuccess: (data) => {
      qc.setQueryData(["feature-flags", tenantKey, selectedTenantId], data);
      qc.invalidateQueries({ queryKey: ["feature-flags", tenantKey, selectedTenantId] });
    },
    onError: (e: Error) => toast.error(e.message || "Update failed."),
  });

  // ---- Toggle module ----
  function toggleModule(mod: ModuleDef, next: boolean) {
    if (!merged) return;
    saveMut.mutate(
      { tenant_id: merged.tenant_id, [mod.key]: next },
      {
        onSuccess: () => {
          toast.success(
            `Module ${mod.name} ${next ? "enabled" : "disabled"} for ${
              selectedTenant?.name ?? "tenant"
            }.`
          );
        },
      }
    );
  }

  // ---- Toggle beta feature ----
  function toggleBeta(key: "beta_ai_assistant" | "beta_advanced_analytics", next: boolean) {
    if (!merged) return;
    const label =
      key === "beta_ai_assistant" ? "AI Assistant" : "Advanced Analytics";
    saveMut.mutate(
      { tenant_id: merged.tenant_id, [key]: next },
      {
        onSuccess: () => {
          toast.success(
            `Beta feature ${label} ${next ? "enabled" : "disabled"} for ${
              selectedTenant?.name ?? "tenant"
            }.`
          );
        },
      }
    );
  }

  // ---- Save limits ----
  function saveLimits() {
    if (!merged) return;
    saveMut.mutate(
      {
        tenant_id: merged.tenant_id,
        max_partners: Number(limitsDraft.max_partners) || 0,
        max_users: Number(limitsDraft.max_users) || 0,
        max_monthly_documents: Number(limitsDraft.max_monthly_documents) || 0,
      },
      {
        onSuccess: () => {
          toast.success(
            `Usage limits saved for ${selectedTenant?.name ?? "tenant"}.`
          );
        },
      }
    );
  }

  // ---- Access guard ----
  if (!isSuperAdmin(user)) {
    return (
      <div className="max-w-3xl mx-auto">
        <PageHeader
          title={t("admin-flags-title")}
          description={t("admin-flags-desc")}
        />
        <Card className="card-premium">
          <CardContent className="p-8 flex flex-col items-center text-center">
            <div className="size-14 rounded-2xl bg-destructive/10 flex items-center justify-center mb-4">
              <Lock className="size-6 text-destructive" />
            </div>
            <h2 className="text-lg font-semibold">{t("admin-flags-super-admin-title")}</h2>
            <p className="text-sm text-muted-foreground mt-1 max-w-md">
              {t("admin-flags-super-admin-desc")}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("admin-flags-title")}
        description={t("admin-flags-desc")}
      />
      <ModuleInfoTooltip
        title="Feature Flags"
        description="Enable or disable features per tenant. Control which modules each tenant can access."
        howToUse={["Toggle features on/off per tenant", "Set defaults for new tenants", "Changes take effect immediately (cache invalidated)", "Use to A/B test or gradually roll out features"]}
      />

      {/* Tenant selector */}
      <Card className="card-premium">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="size-4 text-primary" />
            {t("admin-flags-select-tenant")}
          </CardTitle>
          <CardDescription>
            {t("admin-flags-select-tenant-desc")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tenantsQ.isLoading ? (
            <Skeleton className="h-10 w-full sm:w-80" />
          ) : tenantsQ.error ? (
            <p className="text-sm text-destructive">
              {t("admin-flags-failed-tenants")}
            </p>
          ) : tenants.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("admin-flags-no-tenants")}
            </p>
          ) : (
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <Select
                value={selectedTenantId ?? undefined}
                onValueChange={(v) => setSelectedTenantId(v)}
              >
                <SelectTrigger className="w-full sm:w-80 h-10">
                  <SelectValue placeholder={t("admin-flags-choose-tenant")} />
                </SelectTrigger>
                <SelectContent>
                  {tenants.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      <span className="flex items-center gap-2">
                        <Building2 className="size-3.5 text-muted-foreground" />
                        <span className="truncate">{t.name}</span>
                        <Badge variant="outline" className="ml-1 text-xs capitalize">
                          {t.plan}
                        </Badge>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedTenant && (
                <div className="text-sm text-muted-foreground">
                  <span className="tabular">
                    {selectedTenant.country || "—"}
                  </span>
                  <span className="mx-2">·</span>
                  <span className="capitalize">{selectedTenant.status}</span>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {!selectedTenantId ? (
        <Card className="card-premium">
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            {t("admin-flags-select-prompt")}
          </CardContent>
        </Card>
      ) : flagsQ.isLoading ? (
        <FlagsSkeleton />
      ) : flagsQ.error ? (
        <Card className="card-premium">
          <CardContent className="p-8 text-center">
            <p className="text-sm text-destructive mb-2">
              {t("admin-flags-failed-flags")}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => flagsQ.refetch()}
            >
              {t("admin-retry")}
            </Button>
          </CardContent>
        </Card>
      ) : !merged ? null : (
        <>
          {/* ----------------- Module toggles ----------------- */}
          <section className="space-y-3">
            <div className="flex items-baseline justify-between">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">{t("admin-flags-modules-title")}</h2>
                <p className="text-sm text-muted-foreground">
                  {t("admin-flags-modules-desc")}
                </p>
              </div>
              <Badge variant="outline" className="tabular">
                {MODULES.filter((m) => Boolean((merged as any)[m.key])).length}/
                {MODULES.length} {t("admin-flags-modules-active")}
              </Badge>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {MODULES.map((mod) => {
                const enabled = Boolean((merged as any)[mod.key]);
                const Icon = mod.icon;
                const isSaving =
                  saveMut.isPending &&
                  // optimistic check: this mutation is for this module
                  saveMut.variables?.tenant_id === merged.tenant_id &&
                  mod.key in (saveMut.variables ?? {});
                return (
                  <Card
                    key={mod.key}
                    className={cn(
                      "card-premium relative overflow-hidden smooth",
                      enabled ? "border-primary/40" : "border-border/60"
                    )}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div
                          className={cn(
                            "size-10 rounded-xl flex items-center justify-center shrink-0 smooth",
                            enabled
                              ? "bg-primary/10 text-primary"
                              : "bg-muted text-muted-foreground"
                          )}
                        >
                          <Icon className="size-5" />
                        </div>
                        <Switch
                          checked={enabled}
                          disabled={saveMut.isPending}
                          onCheckedChange={(v) => toggleModule(mod, v)}
                          aria-label={`${t("admin-flags-toggle")} ${mod.name}`}
                        />
                      </div>
                      <div className="mt-3">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold text-sm tracking-tight">
                            {mod.name}
                          </h3>
                          {isSaving ? (
                            <Loader2 className="size-3 text-muted-foreground animate-spin" />
                          ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                          {mod.description}
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>

          {/* ----------------- Limits ----------------- */}
          <section className="space-y-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">{t("admin-flags-limits-title")}</h2>
              <p className="text-sm text-muted-foreground">
                {t("admin-flags-limits-desc")}
              </p>
            </div>
            <Card className="card-premium">
              <CardContent className="p-5 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <LimitField
                    label={t("admin-flags-max-partners")}
                    value={limitsDraft.max_partners}
                    onChange={(v) =>
                      setLimitsDraft((s) => ({ ...s, max_partners: v }))
                    }
                  />
                  <LimitField
                    label={t("admin-flags-max-users")}
                    value={limitsDraft.max_users}
                    onChange={(v) =>
                      setLimitsDraft((s) => ({ ...s, max_users: v }))
                    }
                  />
                  <LimitField
                    label={t("admin-flags-max-monthly-documents")}
                    value={limitsDraft.max_monthly_documents}
                    onChange={(v) =>
                      setLimitsDraft((s) => ({ ...s, max_monthly_documents: v }))
                    }
                  />
                </div>
                <div className="flex justify-end">
                  <Button
                    onClick={saveLimits}
                    disabled={saveMut.isPending}
                    className="shadow-soft hover:shadow-soft-md smooth"
                  >
                    {saveMut.isPending ? (
                      <Loader2 className="size-4 mr-2 animate-spin" />
                    ) : (
                      <Save className="size-4 mr-2" />
                    )}
                    {t("admin-flags-save-limits")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </section>

          {/* ----------------- Beta features ----------------- */}
          <section className="space-y-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">{t("admin-flags-beta-title")}</h2>
              <p className="text-sm text-muted-foreground">
                {t("admin-flags-beta-desc")}
              </p>
            </div>
            <Card className="card-premium border-amber-500/30">
              <CardContent className="p-0">
                <div className="flex items-start gap-3 px-5 pt-4 pb-2 bg-amber-500/5 border-b border-amber-500/20">
                  <div className="size-8 rounded-lg bg-amber-500/15 text-amber-600 flex items-center justify-center shrink-0">
                    <AlertTriangle className="size-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                      {t("admin-flags-beta-warning")}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t("admin-flags-beta-warning-desc")}
                    </p>
                  </div>
                </div>
                <div className="divide-y divide-border/60">
                  <BetaRow
                    title={t("admin-flags-beta-ai-title")}
                    description={t("admin-flags-beta-ai-desc")}
                    enabled={merged.beta_ai_assistant}
                    disabled={saveMut.isPending}
                    onToggle={(v) => toggleBeta("beta_ai_assistant", v)}
                  />
                  <BetaRow
                    title={t("admin-flags-beta-analytics-title")}
                    description={t("admin-flags-beta-analytics-desc")}
                    enabled={merged.beta_advanced_analytics}
                    disabled={saveMut.isPending}
                    onToggle={(v) => toggleBeta("beta_advanced_analytics", v)}
                  />
                </div>
              </CardContent>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------
function LimitField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      <Input
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
        className="tabular h-10"
      />
      <p className="text-xs text-muted-foreground">
        {value === 0 ? t("admin-flags-unlimited") : value.toLocaleString()}
      </p>
    </div>
  );
}

function BetaRow({
  title,
  description,
  enabled,
  disabled,
  onToggle,
}: {
  title: string;
  description: string;
  enabled: boolean;
  disabled: boolean;
  onToggle: (v: boolean) => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
          <Badge
            variant="outline"
            className={cn(
              "text-xs capitalize",
              enabled
                ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-400 bg-emerald-500/10"
                : "text-muted-foreground"
            )}
          >
            {enabled ? t("admin-enabled") : t("admin-disabled")}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <Switch checked={enabled} disabled={disabled} onCheckedChange={onToggle} aria-label={`${t("admin-flags-toggle")} ${title}`} />
    </div>
  );
}

function FlagsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 9 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-44 w-full rounded-xl" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}
