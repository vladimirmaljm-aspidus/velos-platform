import { cn } from "@/lib/utils";
"use client";

import { useState, useEffect, useRef, type ComponentType } from "react";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { ModuleInfoTooltip } from "@/components/common/module-info-tooltip";

import { ShieldAlert, Building2, ShieldCheck, Mail, Upload, Loader2, UserCog, X, ImageIcon, Send, CheckCircle2, XCircle, Zap, AlertTriangle, Globe, Info, FileText, Palette, QrCode, Save, Bell, DollarSign, MessageSquare, Store, Clock, UserPlus } from "lucide-react";
import { useAppStore, isAdmin } from "@/lib/store/app-store";
import { useQuery } from "@tanstack/react-query";
import { TwoFactorSetup } from "@/components/auth/two-factor-setup";
import { CURRENCIES } from "@/lib/data/reference";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import type { MemorandumSettings, Tenant } from "@/lib/supabase/types";
import { LOCALE_LABELS, LOCALE_FLAGS, type Locale } from "@/lib/i18n/dictionaries";
import { useT } from "@/lib/i18n/store";

type CompanyForm = {
  name: string;
  address: string;
  pib: string;
  mb: string;
  bank: string;
  account: string;
  phone: string;
  email: string;
  website: string;
  currency: string;
  tax_rate: number;
};

type SecurityForm = {
  min_password_length: number;
  require_uppercase: boolean;
  require_digit: boolean;
  require_symbol: boolean;
  password_expiry_days: number;
  max_failed_attempts: number;
  lockout_minutes: number;
  two_factor_required: boolean;
};

type CommsForm = {
  email_provider: "resend" | "postmark" | "smtp" | "none";
  // SMTP
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_password: string;
  // Resend
  resend_api_key: string;
  resend_from_email: string;
  // Postmark
  postmark_server_token: string;
  postmark_from_email: string;
  postmark_message_stream: string;
  // Common
  from_name: string;
  from_email: string;
  reply_to: string;
};

const DEFAULT_COMPANY: CompanyForm = {
  name: "", address: "", pib: "", mb: "", bank: "", account: "",
  phone: "", email: "", website: "", currency: "USD", tax_rate: 20,
};

const DEFAULT_SECURITY: SecurityForm = {
  min_password_length: 8,
  require_uppercase: true,
  require_digit: true,
  require_symbol: false,
  password_expiry_days: 90,
  max_failed_attempts: 5,
  lockout_minutes: 15,
  two_factor_required: false,
};

const DEFAULT_COMMS: CommsForm = {
  email_provider: "none",
  smtp_host: "", smtp_port: 587, smtp_user: "", smtp_password: "",
  resend_api_key: "", resend_from_email: "",
  postmark_server_token: "", postmark_from_email: "", postmark_message_stream: "",
  from_name: "", from_email: "", reply_to: "",
};

/**
 * Resolve a logo URL for display in the browser.
 * If the URL is a relative Supabase Storage path (e.g. "tenant-id/logo.png"),
 * construct the full public URL using NEXT_PUBLIC_SUPABASE_URL.
 */
function resolveLogoUrlForDisplay(logoUrl: string | null): string | null {
  if (!logoUrl) return null;
  // Already a full URL
  if (logoUrl.startsWith("http")) return logoUrl;
  // Mock URL (dev mode) — can't display
  if (logoUrl.startsWith("mock://")) return null;
  // Relative Supabase Storage path — construct the public URL
  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (sbUrl) {
    return `${sbUrl}/storage/v1/object/public/tenant-logos/${logoUrl}`;
  }
  return null;
}

async function fetchSetting<T>(key: string, fallback: T, api: (path: string) => string): Promise<T> {
  const r = await fetch(api(`/api/settings?key=${key}`));
  if (!r.ok) throw new Error("Failed to load setting");
  const data = await r.json();
  return { ...fallback, ...(data.value || {}) } as T;
}

export function SettingsView() {
  const currentUser = useAppStore((s) => s.user);
  const admin = isAdmin(currentUser);
  const isSuperAdmin = !!currentUser && currentUser.role === "super_admin";
  const activeTenantId = useAppStore((s) => s.activeTenantId);
  const activeTenantName = useAppStore((s) => s.activeTenantName);
  const t = useT();

  // ── Plan-gate for dangerous tabs (security / comms) ─────────────────────
  // The SecurityTab (password policy, 2FA enforcement) and the CommsTab
  // (SMTP / Resend / Postmark credentials) control tenant-wide posture
  // that a TRIAL tenant should not be able to relax — a 14-day trial
  // admin disabling 2FA enforcement, or pointing outbound mail at an
  // attacker-controlled SMTP relay, are both dangerous in a way that
  // survives the trial. Trial tenants therefore don't see these tabs
  // at all; paid-plan tenant admins and super_admin do. (The
  // /api/settings PUT endpoint ALSO rejects trial admins because the
  // trial admin permission set excludes `settings.write` — this UI
  // gate is the UX half of that defense, the API is the security half.)
  const subQ = useQuery({
    queryKey: ["subscription-status-settings"],
    queryFn: async () => {
      const r = await fetch("/api/subscription/status");
      if (!r.ok) return null;
      return r.json() as Promise<{
        subscription: { is_trial?: boolean; plan?: string | null } | null;
      }>;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  const isTrial = !!subQ.data?.subscription?.is_trial;
  // Super-admin bypasses the plan gate (they own the platform and can
  // impersonate any tenant anyway); paid-plan admins pass; trial
  // tenant admins are denied.
  const canManageDangerousSettings = isSuperAdmin || !isTrial;

  if (!admin) {
    return (
      <div>
        <PageHeader title={t("admin-settings-title")} />
        <Card className="border-amber-500/40 bg-amber-50/50 dark:bg-amber-950/20 rounded-xl">
          <CardContent className="p-6 flex items-center gap-3">
            <ShieldAlert className="size-5 text-amber-600 shrink-0" />
            <p className="text-sm text-amber-800 dark:text-amber-300">
              {t("admin-settings-admin-required")}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isPlatformScope = isSuperAdmin && !activeTenantId;

  return (
    <div>
      <PageHeader title={t("admin-settings-title")} description={t("admin-settings-desc")} />
      <ModuleInfoTooltip
        title="Settings"
        description="Configure your tenant settings — company profile, security policy, email (SMTP/Resend), integrations, and more."
        howToUse={["Company tab: set your company name, logo, address", "Security tab: configure password policy, 2FA enforcement", "Communications tab: set up email (Resend or SMTP)", "Integrations tab: connect external services", "Super admin sees a scope banner (Platform vs Tenant)"]}
      />

      {/* Scope indicator — shows whether you're editing PLATFORM or TENANT settings */}
      {isSuperAdmin && (
        <div className={cn(
          "mb-4 rounded-lg border p-3 flex items-center gap-2 text-sm",
          isPlatformScope
            ? "border-amber-500/40 bg-amber-50/50 dark:bg-amber-950/20"
            : "border-blue-500/40 bg-blue-50/50 dark:bg-blue-950/20"
        )}>
          {isPlatformScope ? (
            <>
              <Globe className="size-4 text-amber-600 shrink-0" />
              <span className="text-amber-800 dark:text-amber-300">
                <strong>Platform-level settings</strong> — these are the defaults for ALL tenants. Configure email, security, and integrations that apply platform-wide.
              </span>
            </>
          ) : (
            <>
              <Building2 className="size-4 text-blue-600 shrink-0" />
              <span className="text-blue-800 dark:text-blue-300">
                <strong>Tenant settings: {activeTenantName || "Selected tenant"}</strong> — these override the platform defaults for this tenant only.
              </span>
            </>
          )}
        </div>
      )}

      <Tabs defaultValue="company">
        {/* NOTIF-UX — bumped from sm:grid-cols-7 → 8 to accommodate the new
            Notifications tab. The list still scrolls horizontally on mobile
            (overflow-x-auto) so the 8-tab layout doesn't break small
            viewports. */}
        <TabsList className="flex w-full max-w-2xl overflow-x-auto justify-start sm:grid sm:grid-cols-8">
          <TabsTrigger value="company">{t("admin-settings-tab-company")}</TabsTrigger>
          {canManageDangerousSettings && (
            <TabsTrigger value="security">{t("admin-settings-tab-security")}</TabsTrigger>
          )}
          {canManageDangerousSettings && (
            <TabsTrigger value="comms">{t("admin-settings-tab-comms")}</TabsTrigger>
          )}
          <TabsTrigger value="integrations">{t("admin-settings-tab-integrations")}</TabsTrigger>
          <TabsTrigger value="preferences">{t("admin-settings-tab-preferences")}</TabsTrigger>
          <TabsTrigger value="memorandum">{t("admin-settings-tab-memorandum")}</TabsTrigger>
          {/* FEAT-1 (Password change in Settings): always visible to
              every admin (super_admin + tenant admin). The form posts
              to /api/auth/change-password which is open to any
              authenticated user — non-admins don't reach this view
              because the sidebar gates Settings behind `settings.read`,
              but the API itself is open to all logged-in users so they
              could call it directly. */}
          <TabsTrigger value="password">{t("admin-settings-tab-password")}</TabsTrigger>
          {/* NOTIF-UX — per-type notification preferences. Visible to
              every admin (not gated by canManageDangerousSettings)
              because it only edits the user's own notif_prefs column —
              no tenant-wide posture. The tab posts to
              /api/notifications/prefs which writes the user's
              notif_prefs JSONB column on the users table. */}
          <TabsTrigger value="notifications">{t("admin-settings-tab-notifications")}</TabsTrigger>
        </TabsList>

        <TabsContent value="company" className="mt-4 space-y-4">
          <CompanyTab />
          <DefaultLanguageCard />
        </TabsContent>
        <TabsContent value="security" className="mt-4 space-y-4">
          {canManageDangerousSettings ? (
            <>
              <SecurityTab />
              <TwoFactorSetup isSuperAdmin={isSuperAdmin} />
            </>
          ) : (
            <PlanGateCard />
          )}
        </TabsContent>
        <TabsContent value="comms" className="mt-4">
          {canManageDangerousSettings ? <CommsTab /> : <PlanGateCard />}
        </TabsContent>
        <TabsContent value="integrations" className="mt-4">
          <IntegrationsTab />
        </TabsContent>
        <TabsContent value="preferences" className="mt-4">
          <PreferencesTab />
        </TabsContent>
        <TabsContent value="memorandum" className="mt-4">
          <MemorandumTab />
        </TabsContent>
        <TabsContent value="password" className="mt-4">
          <ChangePasswordTab />
        </TabsContent>
        <TabsContent value="notifications" className="mt-4">
          <NotificationsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * PlanGateCard — placeholder shown in place of the Security/Comms tab when
 * the current caller is on a TRIAL plan (and is not super_admin). The
 * security/comms settings control tenant-wide posture (password policy,
 * 2FA enforcement, outbound SMTP credentials) that a trial tenant should
 * not be able to relax. The /api/settings PUT endpoint ALSO rejects trial
 * admins (the trial permission set excludes `settings.write`) — this card
 * is the UX half of that defense, the API is the security half.
 */
function PlanGateCard() {
  const setView = useAppStore((s) => s.setView);
  const t = useT();
  return (
    <Card className="border-amber-500/40 bg-amber-50/50 dark:bg-amber-950/20 rounded-xl">
      <CardContent className="p-6 flex items-start gap-3">
        <ShieldAlert className="size-5 text-amber-600 shrink-0 mt-0.5" />
        <div className="space-y-2">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            Upgrade to manage security &amp; communications settings
          </p>
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Password policy, two-factor enforcement, and outbound email
            (SMTP / Resend / Postmark) credentials are restricted to paid
            plans. Upgrade your workspace to configure these settings.
          </p>
          <div>
            <Button size="sm" onClick={() => setView("plans")}>
              {t("misc-sub-upgrade-now")}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function useSettingLoader<T>(key: string, fallback: T) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const [value, setValue] = useState<T>(fallback);
  const [loaded, setLoaded] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // FIX-UX #4: dirty flag = local value diverged from the last value the
  // server returned. Drives the beforeunload guard so a tab close / refresh
  // with unsaved settings edits prompts the user.
  const isDirty = loaded !== null && JSON.stringify(value) !== JSON.stringify(loaded);
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  useEffect(() => {
    let active = true;
// eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    fetchSetting<T>(key, fallback, api)
      .then((v) => {
        if (!active) return;
        setValue(v);
        setLoaded(v);
      })
      .catch(() => toast.error("Failed to load settings."))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [key]);
  void fallback;

  async function save(next: T) {
    setSaving(true);
    try {
      const r = await fetch(api("/api/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: next }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to save settings");
      }
      // Mark the saved value as "loaded" so isDirty clears.
      setLoaded(next);
      toast.success("Settings saved.");
    } catch (e: any) {
      toast.error(e.message || "Failed to save settings.");
    } finally {
      setSaving(false);
    }
  }

  return { value, setValue, loading, saving, save, isDirty };
}

function CompanyTab() {
  const { value, setValue, loading, saving, save } = useSettingLoader<CompanyForm>("company", DEFAULT_COMPANY);
  const t = useT();

  function set<K extends keyof CompanyForm>(k: K, v: CompanyForm[K]) {
    setValue((prev) => ({ ...prev, [k]: v }));
  }

  if (loading) {
    return (
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-6 space-y-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/60 shadow-soft rounded-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Building2 className="size-5" /> {t("admin-settings-company-title")}</CardTitle>
        <CardDescription>{t("admin-settings-company-desc")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2 space-y-1.5">
            <Label>{t("common-label-name")}</Label>
            <Input value={value.name} onChange={(e) => set("name", e.target.value)} placeholder="Acme Inc." />
          </div>
          <div className="md:col-span-2 space-y-1.5">
            <Label>{t("common-label-address")}</Label>
            <Input value={value.address} onChange={(e) => set("address", e.target.value)} placeholder="123 Main St, Springfield" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("common-label-tax-id")}</Label>
            <Input value={value.pib} onChange={(e) => set("pib", e.target.value)} placeholder="100000000" className="tabular" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("common-label-company-registration")}</Label>
            <Input value={value.mb} onChange={(e) => set("mb", e.target.value)} placeholder="00000000" className="tabular" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("common-label-bank")}</Label>
            <Input value={value.bank} onChange={(e) => set("bank", e.target.value)} placeholder="Acme Bank" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("common-label-account")}</Label>
            <Input value={value.account} onChange={(e) => set("account", e.target.value)} placeholder="123-4567890123456-78" className="tabular" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("common-label-phone")}</Label>
            <Input value={value.phone} onChange={(e) => set("phone", e.target.value)} placeholder="+1 555 000 0000" className="tabular" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("common-label-email")}</Label>
            <Input type="email" value={value.email} onChange={(e) => set("email", e.target.value)} placeholder="info@company.com" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("common-label-website")}</Label>
            <Input value={value.website} onChange={(e) => set("website", e.target.value)} placeholder="www.company.com" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("common-label-currency")}</Label>
            <Select value={value.currency} onValueChange={(v) => set("currency", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("common-label-tax-rate")}</Label>
            <Input
              type="number"
              min={0}
              max={100}
              step={0.1}
              value={value.tax_rate}
              onChange={(e) => set("tax_rate", Number(e.target.value))}
              className="tabular"
            />
          </div>
        </div>

        {/* Logo Upload */}
        <LogoUpload />

        <div className="mt-4 flex justify-end">
          <Button onClick={() => save(value)} disabled={saving}>
            {saving ? t("admin-saving") : t("save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DefaultLanguageCard() {
  const { value, setValue, loading, saving, save } = useSettingLoader<Locale>("default_locale", "en");
  const t = useT();

  if (loading) {
    return (
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-6">
          <Skeleton className="h-10 w-full max-w-xs" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/60 shadow-soft rounded-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Globe className="size-5" /> {t("admin-settings-default-language")}</CardTitle>
        <CardDescription>
          {t("admin-settings-default-language-desc")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="max-w-xs space-y-1.5">
          <Label>{t("admin-settings-language")}</Label>
          <Select value={value} onValueChange={(v) => setValue(v as Locale)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(LOCALE_LABELS) as Locale[]).map((loc) => (
                <SelectItem key={loc} value={loc}>
                  {LOCALE_FLAGS[loc]} {LOCALE_LABELS[loc]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={() => save(value)} disabled={saving}>
            {saving ? t("admin-saving") : t("save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function LogoUpload() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [uploading, setUploading] = useState(false);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Fetch tenant to get current logo
    fetch(api("/api/auth/me")).then(r => r.json()).then(data => {
      if (data.user?.tenant_id) {
        setTenantId(data.user.tenant_id);
        fetch(api(`/api/tenants`)).then(r => r.json()).then(tenants => {
          const t = tenants.items?.find((x: any) => x.id === data.user.tenant_id);
          if (t?.logo_url) setLogoUrl(t.logo_url);
        });
      }
    });
  }, []);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const me = await fetch(api("/api/auth/me")).then(r => r.json());
      const tid = me.user?.tenant_id;
      if (!tid) { toast.error("No tenant context."); return; }
      setTenantId(tid);
      const formData = new FormData();
      formData.append("logo", file);
      const res = await fetch(api(`/api/tenants/${tid}/logo`), { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || "Upload failed."); return; }
      setLogoUrl(data.url);
      toast.success("Logo uploaded. It will appear on all PDF documents.");
    } catch {
      toast.error("Upload failed.");
    } finally {
      setUploading(false);
      // Reset file input so the same file can be re-selected
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleRemove() {
    if (!tenantId) return;
    setUploading(true);
    try {
      // Update tenant to clear logo_url
      const res = await fetch(api(`/api/tenants`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: tenantId, logo_url: null }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        toast.error(e.error || "Failed to remove logo.");
        return;
      }
      setLogoUrl(null);
      toast.success("Logo removed.");
    } catch {
      toast.error("Failed to remove logo.");
    } finally {
      setUploading(false);
    }
  }

  const displayUrl = resolveLogoUrlForDisplay(logoUrl);

  return (
    <div className="mt-6 pt-6 border-t">
      <Label className="text-sm font-medium flex items-center gap-2">
        <ImageIcon className="size-4" />
        {t("admin-settings-company-logo")}
      </Label>
      <p className="text-xs text-muted-foreground mt-1 mb-4">
        {t("admin-settings-company-desc")}
      </p>
      <div className="flex items-start gap-4">
        <div className="size-24 rounded-lg border-2 border-dashed border-border/60 flex items-center justify-center bg-muted/30 overflow-hidden relative group">
          {displayUrl ? (
            <>
              <img src={displayUrl} alt="Logo" className="w-full h-full object-contain p-1" />
              <button
                onClick={handleRemove}
                disabled={uploading}
                className="absolute top-1 right-1 size-6 rounded-full bg-destructive/90 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive"
                title="Remove logo"
              >
                <X className="size-3.5" />
              </button>
            </>
          ) : (
            <div className="flex flex-col items-center gap-1 text-muted-foreground/40">
              <Building2 className="size-8" />
              <span className="text-xs">{t("admin-settings-no-logo")}</span>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            onChange={handleUpload}
            className="hidden"
          />
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="size-4 mr-1.5 animate-spin" /> : <Upload className="size-4 mr-1.5" />}
            {uploading ? t("admin-settings-uploading") : t("admin-settings-upload-logo")}
          </Button>
          <p className="text-xs text-muted-foreground">PNG, JPEG, WebP or SVG · Max 2MB</p>
          {displayUrl && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
              <ImageIcon className="size-3" /> {t("admin-settings-logo-set")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function SecurityTab() {
  const { value, setValue, loading, saving, save } = useSettingLoader<SecurityForm>("security_policy", DEFAULT_SECURITY);
  const t = useT();

  function set<K extends keyof SecurityForm>(k: K, v: SecurityForm[K]) {
    setValue((prev) => ({ ...prev, [k]: v }));
  }

  if (loading) {
    return (
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-6 space-y-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/60 shadow-soft rounded-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5" /> {t("admin-settings-security-title")}</CardTitle>
        <CardDescription>{t("admin-settings-security-desc")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>{t("common-label-min-password-length")}</Label>
            <Input type="number" min={4} max={128} value={value.min_password_length} onChange={(e) => set("min_password_length", Number(e.target.value))} className="tabular" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("common-label-password-expiry")}</Label>
            <Input type="number" min={0} value={value.password_expiry_days} onChange={(e) => set("password_expiry_days", Number(e.target.value))} className="tabular" />
            <p className="text-xs text-muted-foreground">0 = never expires.</p>
          </div>
          <div className="space-y-1.5">
            <Label>{t("common-label-max-failed-attempts")}</Label>
            <Input type="number" min={1} value={value.max_failed_attempts} onChange={(e) => set("max_failed_attempts", Number(e.target.value))} className="tabular" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("common-label-lockout-minutes")}</Label>
            <Input type="number" min={1} value={value.lockout_minutes} onChange={(e) => set("lockout_minutes", Number(e.target.value))} className="tabular" />
          </div>

          <ToggleRow
            label="Require uppercase"
            checked={value.require_uppercase}
            onCheckedChange={(v) => set("require_uppercase", v)}
          />
          <ToggleRow
            label="Require digit"
            checked={value.require_digit}
            onCheckedChange={(v) => set("require_digit", v)}
          />
          <ToggleRow
            label="Require symbol"
            checked={value.require_symbol}
            onCheckedChange={(v) => set("require_symbol", v)}
          />
          <ToggleRow
            label="Two-factor required"
            checked={value.two_factor_required}
            onCheckedChange={(v) => set("two_factor_required", v)}
          />
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={() => save(value)} disabled={saving}>
            {saving ? t("admin-saving") : t("save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CommsTab() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const { value, setValue, loading, saving, save } = useSettingLoader<CommsForm>("comms", DEFAULT_COMMS);

  function set<K extends keyof CommsForm>(k: K, v: CommsForm[K]) {
    setValue((prev) => ({ ...prev, [k]: v }));
  }

  if (loading) {
    return (
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-6 space-y-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/60 shadow-soft rounded-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Mail className="size-5" /> {t("admin-settings-comms-title")}</CardTitle>
        <CardDescription>{t("admin-settings-comms-desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Provider picker */}
        <div className="space-y-2">
          <Label>{t("common-label-email-provider")}</Label>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            <ProviderCard
              active={value.email_provider === "resend"}
              onClick={() => set("email_provider", "resend")}
              title="Resend"
              subtitle="Recommended"
              description="HTTP API — no SMTP blocks. Free: 100/day."
              badge="BEST"
            />
            <ProviderCard
              active={value.email_provider === "postmark"}
              onClick={() => set("email_provider", "postmark")}
              title="Postmark"
              subtitle="Transactional"
              description="Reliable HTTP API. Trial: 100/month."
            />
            <ProviderCard
              active={value.email_provider === "smtp"}
              onClick={() => set("email_provider", "smtp")}
              title="SMTP"
              subtitle="Traditional"
              description="Standard SMTP. May be blocked on free hosting."
            />
            <ProviderCard
              active={value.email_provider === "none"}
              onClick={() => set("email_provider", "none")}
              title="None"
              subtitle="Disabled"
              description="Queue emails for later (dev mode)."
            />
          </div>
        </div>

        {/* Common fields */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>{t("common-label-from-name")}</Label>
            <Input value={value.from_name} onChange={(e) => set("from_name", e.target.value)} placeholder="VELOS CRM" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("common-label-from-email")}</Label>
            <Input type="email" value={value.from_email} onChange={(e) => set("from_email", e.target.value)} placeholder="noreply@company.com" />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label>{t("common-label-reply-to-email")}</Label>
            <Input type="email" value={value.reply_to} onChange={(e) => set("reply_to", e.target.value)} placeholder="support@company.com" />
          </div>
        </div>

        {/* Resend fields */}
        {value.email_provider === "resend" && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-50/50 dark:bg-emerald-950/20 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Zap className="size-4 text-emerald-600" />
              <h4 className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">Resend Configuration</h4>
            </div>
            <p className="text-xs text-muted-foreground">
              Resend is a modern email API that works reliably from any hosting
              provider (no SMTP port blocks). Free tier: 100 emails/day,
              3,000/month.
            </p>
            <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
              <li>Sign up at <a href="https://resend.com" target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:underline">resend.com</a> (free)</li>
              <li>Go to API Keys → Create API Key → copy it (starts with <code className="bg-muted px-1 rounded">re_</code>)</li>
              <li>{t("common-label-paste-key-below")}</li>
              <li>For production: add &amp; verify your domain in Resend dashboard</li>
              <li>For testing: use <code className="bg-muted px-1 rounded">onboarding@resend.dev</code> as the from email</li>
            </ol>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
              <div className="space-y-1.5 md:col-span-2">
                <Label>{t("common-label-resend-api-key")}</Label>
                <Input
                  type="password"
                  value={value.resend_api_key}
                  onChange={(e) => set("resend_api_key", e.target.value)}
                  placeholder="re_xxxxxxxxxxxxxxxxxxxx"
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label>{t("common-label-resend-from-email")}</Label>
                <Input
                  type="email"
                  value={value.resend_from_email}
                  onChange={(e) => set("resend_from_email", e.target.value)}
                  placeholder="onboarding@resend.dev (testing) or noreply@yourdomain.com (production)"
                />
                <p className="text-xs text-muted-foreground">
                  Use <code className="bg-muted px-1 rounded">onboarding@resend.dev</code> for testing.
                  For production, use an email on a domain you've verified in Resend.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* SMTP fields */}
        {value.email_provider === "smtp" && (
          <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-600" />
              <h4 className="text-sm font-semibold">SMTP Configuration</h4>
            </div>
            <p className="text-xs text-muted-foreground">
              Note: SMTP on ports 465/587 is blocked on Render free plan.
              If your test email times out, switch to Resend or Postmark.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>SMTP host</Label>
                <Input value={value.smtp_host} onChange={(e) => set("smtp_host", e.target.value)} placeholder="smtp.gmail.com" />
              </div>
              <div className="space-y-1.5">
                <Label>SMTP port</Label>
                <Input type="number" min={1} max={65535} value={value.smtp_port} onChange={(e) => set("smtp_port", Number(e.target.value))} placeholder="587" className="tabular" />
              </div>
              <div className="space-y-1.5">
                <Label>SMTP user</Label>
                <Input value={value.smtp_user} onChange={(e) => set("smtp_user", e.target.value)} placeholder="user@company.com" />
              </div>
              <div className="space-y-1.5">
                <Label>SMTP password</Label>
                <Input type="password" value={value.smtp_password} onChange={(e) => set("smtp_password", e.target.value)} placeholder="••••••••" />
              </div>
            </div>
          </div>
        )}

        {/* Postmark fields */}
        {value.email_provider === "postmark" && (
          <div className="rounded-lg border border-sky-500/30 bg-sky-50/50 dark:bg-sky-950/20 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Mail className="size-4 text-sky-600" />
              <h4 className="text-sm font-semibold text-sky-900 dark:text-sky-200">Postmark Configuration</h4>
            </div>
            <p className="text-xs text-muted-foreground">
              Postmark is a reliable transactional email API by Wildbit.
              Excellent deliverability, no SMTP port blocks.
              Trial: 100 emails/month free.
            </p>
            <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
              <li>Sign up at <a href="https://postmarkapp.com" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">postmarkapp.com</a> (free trial)</li>
              <li>Create a Server → go to <strong>API Tokens</strong> → copy the <strong>Server API token</strong></li>
              <li>Go to <strong>Sender Signatures</strong> → add &amp; confirm your sending email</li>
              <li>Paste the server token below</li>
              <li>Use the confirmed email as the from email</li>
            </ol>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
              <div className="space-y-1.5 md:col-span-2">
                <Label>{t("common-label-postmark-server-token")}</Label>
                <Input
                  type="password"
                  value={value.postmark_server_token}
                  onChange={(e) => set("postmark_server_token", e.target.value)}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("common-label-postmark-from-email")}</Label>
                <Input
                  type="email"
                  value={value.postmark_from_email}
                  onChange={(e) => set("postmark_from_email", e.target.value)}
                  placeholder="noreply@yourdomain.com"
                />
                <p className="text-xs text-muted-foreground">
                  Must match a confirmed sender signature in Postmark.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>{t("common-label-message-stream")}</Label>
                <Input
                  value={value.postmark_message_stream}
                  onChange={(e) => set("postmark_message_stream", e.target.value)}
                  placeholder="outbound"
                />
                <p className="text-xs text-muted-foreground">
                  Default is "outbound". Use "broadcast" for bulk emails.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* None */}
        {value.email_provider === "none" && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20 p-4">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="size-4 text-amber-600" />
              <h4 className="text-sm font-semibold text-amber-900 dark:text-amber-200">Email Disabled</h4>
            </div>
            <p className="text-xs text-muted-foreground">
              Emails will be queued in the Mail Queue but not sent. Choose
              Resend or SMTP above to enable sending.
            </p>
          </div>
        )}

        <div className="flex justify-end">
          <Button onClick={() => save(value)} disabled={saving}>
            {saving ? t("admin-saving") : t("save")}
          </Button>
        </div>

        {/* Super-admin only: Allowed From Domains — controls which email
            domains can be used in from_email / postmark_from_email / etc.
            Prevents email spoofing (a tenant setting from: ceo@victim.com). */}
        {isSuperAdmin && (
          <AllowedFromDomainsSection api={api} />
        )}

        <EmailTestSection value={value} />
      </CardContent>
    </Card>
  );
}

/** Provider picker card */
/** Allowed From Domains — super-admin only section to control which email
 *  domains can be used as the From address. Prevents email spoofing. */
function AllowedFromDomainsSection({ api }: { api: (path: string) => string }) {
  const [domains, setDomains] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const t = useT();

  useEffect(() => {
    fetch(api("/api/settings?key=email_allowed_from_domains"))
      .then((r) => r.json())
      .then((d) => {
        setDomains(typeof d.value === "string" ? d.value : "");
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [api]);

  async function saveDomains() {
    setSaving(true);
    try {
      const r = await fetch(api("/api/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "email_allowed_from_domains", value: domains }),
      });
      if (!r.ok) throw new Error("Failed to save");
      toast.success("Allowed from-domains saved.");
    } catch (e: any) {
      toast.error(e.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-6 border-t pt-6">
      <div className="flex items-center gap-2 mb-2">
        <ShieldCheck className="size-4 text-muted-foreground" />
        <h4 className="text-sm font-semibold">Allowed From Domains (Platform-Level)</h4>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Comma-separated list of email domains that can be used as the From address.
        Emails using a domain NOT in this list will be rejected or rewritten.
        This prevents email spoofing (e.g. a tenant setting from: ceo@victim.com).
      </p>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="flex gap-2">
          <Input
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
            placeholder="aspidus.co, example.com, your-domain.com"
            className="flex-1 font-mono text-sm"
          />
          <Button onClick={saveDomains} disabled={saving} size="sm">
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground mt-2">
        Current: {domains || "(empty — all domains blocked)"}
      </p>
    </div>
  );
}

function ProviderCard({
  active, onClick, title, subtitle, description, badge,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
  description: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "relative text-left p-3 rounded-lg border-2 transition-all smooth " +
        (active
          ? "border-primary bg-primary/5 shadow-sm"
          : "border-border/60 hover:border-border hover:bg-muted/30")
      }
    >
      {badge && (
        <span className="absolute -top-2 -right-2 px-1.5 py-0.5 text-[9px] font-bold rounded bg-emerald-600 text-white">
          {badge}
        </span>
      )}
      <div className="flex items-baseline justify-between gap-1">
        <span className="text-sm font-semibold">{title}</span>
        <span className="text-xs text-muted-foreground uppercase tracking-wider">{subtitle}</span>
      </div>
      <p className="text-xs text-muted-foreground mt-1">{description}</p>
    </button>
  );
}

/**
 * Email test panel — sends a real test email using the currently-selected
 * provider. Lets the admin verify the config BEFORE saving.
 */
function EmailTestSection({ value }: { value: CommsForm }) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const [testEmail, setTestEmail] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<
    | { ok: true; messageId?: string; provider?: string; testedAt?: string }
    | { ok: false; error: string; category?: string }
    | null
  >(null);

  async function runTest() {
    if (!testEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail)) {
      setResult({ ok: false, error: "Enter a valid recipient email address." });
      return;
    }
    setTesting(true);
    setResult(null);
    try {
      const res = await fetch(api("/api/settings/test-email"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: testEmail,
          provider: value.email_provider,
          // Resend
          resend_api_key: value.resend_api_key,
          resend_from_email: value.resend_from_email,
          // Postmark
          postmark_server_token: value.postmark_server_token,
          postmark_from_email: value.postmark_from_email,
          postmark_message_stream: value.postmark_message_stream,
          // SMTP
          smtp_host: value.smtp_host,
          smtp_port: value.smtp_port,
          smtp_user: value.smtp_user,
          smtp_password: value.smtp_password,
          // Common
          from_name: value.from_name,
          from_email: value.from_email,
          reply_to: value.reply_to,
        }),
      });
      const data = await res.json();
      setResult(data);
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || "Network error" });
    } finally {
      setTesting(false);
    }
  }

  const canTest =
    value.email_provider === "resend"
      ? !!value.resend_api_key
      : value.email_provider === "postmark"
        ? !!value.postmark_server_token
        : value.email_provider === "smtp"
          ? !!value.smtp_host && !!value.smtp_user
          : false;

  return (
    <div className="mt-2 pt-5 border-t border-border/60">
      <div className="flex items-center gap-2 mb-2">
        <Send className="size-4 text-primary" />
        <h4 className="text-sm font-semibold">Test Email Configuration</h4>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Send a test email to verify your {value.email_provider === "resend" ? "Resend" : value.email_provider === "smtp" ? "SMTP" : ""} settings work.
        Uses the values currently entered above (you can test before saving).
      </p>
      <div className="flex flex-col sm:flex-row gap-2">
        <Input
          type="email"
          value={testEmail}
          onChange={(e) => setTestEmail(e.target.value)}
          placeholder="recipient@example.com"
          className="flex-1"
          disabled={testing}
          onKeyDown={(e) => {
            if (e.key === "Enter") runTest();
          }}
        />
        <Button
          type="button"
          variant="secondary"
          onClick={runTest}
          disabled={testing || !canTest}
          className="gap-2"
        >
          {testing ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Sending test…
            </>
          ) : (
            <>
              <Send className="size-4" />
              Send test email
            </>
          )}
        </Button>
      </div>

      {result && (
        <div
          className={
            "mt-3 p-3 rounded-lg border text-sm " +
            (result.ok
              ? "bg-emerald-50 border-emerald-200 text-emerald-900 dark:bg-emerald-950/40 dark:border-emerald-800 dark:text-emerald-200"
              : "bg-destructive/10 border-destructive/30 text-destructive")
          }
        >
          {result.ok ? (
            <div className="space-y-1">
              <p className="font-medium flex items-center gap-1.5">
                <CheckCircle2 className="size-4" />
                Test email sent successfully via {result.provider || "provider"}
              </p>
              {result.messageId && (
                <p className="text-xs opacity-80 font-mono">
                  Message ID: {result.messageId}
                </p>
              )}
              <p className="text-xs opacity-80">
                Check the recipient inbox (and spam folder) for the test message.
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              <p className="font-medium flex items-center gap-1.5">
                <XCircle className="size-4" />
                Test failed
              </p>
              <p className="text-xs">{result.error}</p>
              {result.category && (
                <p className="text-xs opacity-80">
                  {result.category === "host_unreachable" &&
                    "Hint: check that the SMTP host and port are correct and that your network allows outbound SMTP."}
                  {result.category === "auth_failed" &&
                    "Hint: the username or password / API key is incorrect. For Gmail, use an App Password, not your account password."}
                  {result.category === "timeout" &&
                    "Hint: the server did not respond in time. SMTP on ports 465/587 is blocked on Render free plan — switch to Resend."}
                  {result.category === "tls" &&
                    "Hint: TLS/certificate problem. If you trust the server, try port 587 with STARTTLS."}
                  {result.category === "domain_not_verified" &&
                    "Hint: your Resend sending domain is not verified. Use onboarding@resend.dev for testing, or verify your domain in Resend dashboard."}
                  {result.category === "rate_limit" &&
                    "Hint: Resend free tier allows 100 emails/day. Upgrade or wait until tomorrow."}
                  {result.category === "missing_config" &&
                    "Hint: fill in the provider configuration above first."}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── API Integrations Tab ─────────────────────────────────────────────

type IntegrationsForm = {
  exchangerate_api_key: string;
  alphavantage_api_key: string;
  openweather_api_key: string;
  searates_api_key: string;
  uncomtrade_api_key: string;
};

const DEFAULT_INTEGRATIONS: IntegrationsForm = {
  exchangerate_api_key: "",
  alphavantage_api_key: "",
  openweather_api_key: "",
  searates_api_key: "",
  uncomtrade_api_key: "",
};

function IntegrationsTab() {
  const { value, setValue, loading, saving, save } = useSettingLoader<IntegrationsForm>("integrations", DEFAULT_INTEGRATIONS);
  const t = useT();

  function set<K extends keyof IntegrationsForm>(k: K, v: IntegrationsForm[K]) {
    setValue((prev) => ({ ...prev, [k]: v }));
  }

  if (loading) {
    return (
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-6 space-y-3">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Intro */}
      <Card className="border-blue-500/30 bg-blue-50/50 dark:bg-blue-950/20">
        <CardContent className="p-5">
          <div className="flex items-start gap-3">
            <Globe className="size-5 text-blue-600 shrink-0 mt-0.5" />
            <div>
              <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-200">API Integrations</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Connect external data services to enrich your trade platform. Each integration
                provides different data — currency rates, commodity prices, container tracking,
                weather, sanctions checks, and more. All keys are stored securely and only visible to admins.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 1. ExchangeRate-API */}
      <ApiIntegrationCard
        title="Exchange Rate API"
        description="Live currency conversion for offers, invoices, and trade calculations."
        icon="💱"
        badge="1,500/month FREE"
        badgeColor="emerald"
        apiKey={value.exchangerate_api_key}
        onChange={(v) => set("exchangerate_api_key", v)}
        steps={[
          "Go to https://www.exchangerate-api.com",
          "Click 'Get Free API Key' (no credit card needed)",
          "Sign up with your email",
          "Copy the API key from your dashboard (starts with a hex string)",
          "Paste it below and click Save",
        ]}
        testUrl="/api/integrations/exchange-rates?from=USD&to=EUR&amount=100"
        testLabel="Test: Convert 100 USD → EUR"
        note="Works without API key too (uses free ECB fallback rates, updated daily at 16:00 CET). API key gives real-time rates."
      />

      {/* 2. Alpha Vantage */}
      <ApiIntegrationCard
        title="Alpha Vantage — Commodity Prices"
        description="Live prices for sugar, coffee, cocoa, corn, wheat, copper, oil, cotton, and more."
        icon="📈"
        badge="25/day FREE"
        badgeColor="amber"
        apiKey={value.alphavantage_api_key}
        onChange={(v) => set("alphavantage_api_key", v)}
        steps={[
          "Go to https://www.alphavantage.co/support/#api-key",
          "Fill in the form (name, email)",
          "You'll receive your API key instantly (starts with letters/numbers)",
          "Paste it below and click Save",
        ]}
        testUrl="/api/integrations/commodities?symbol=SUGAR"
        testLabel="Test: Get current sugar price"
        note="25 API calls per day. Data is cached for 12 hours so each commodity only uses 1 call per day."
      />

      {/* 3. OpenWeatherMap */}
      <ApiIntegrationCard
        title="OpenWeatherMap — Port Weather"
        description="Current weather conditions at shipping ports for logistics planning."
        icon="🌤️"
        badge="1,000/day FREE"
        badgeColor="sky"
        apiKey={value.openweather_api_key}
        onChange={(v) => set("openweather_api_key", v)}
        steps={[
          "Go to https://openweathermap.org/api",
          "Click 'Sign Up' (free, no credit card)",
          "After registration, go to your profile → API Keys",
          "Copy the default API key (32-character hex string)",
          "Paste it below and click Save",
        ]}
        testUrl="/api/integrations/weather?lat=25.01&lon=55.06"
        testLabel="Test: Weather at Jebel Ali port (Dubai)"
        note="Weather data is cached for 30 minutes. Shows temperature, wind, humidity, and conditions."
      />

      {/* 4. SeaRates */}
      <ApiIntegrationCard
        title="SeaRates — Container Tracking"
        description="Track shipping containers in real-time across 150+ shipping lines (MAERSK, MSC, CMA CGM, etc.)."
        icon="🚢"
        badge="100/month FREE"
        badgeColor="blue"
        apiKey={value.searates_api_key}
        onChange={(v) => set("searates_api_key", v)}
        steps={[
          "Go to https://www.searates.com",
          "Click 'Sign Up' and create a free account",
          "After login, go to 'My Profile' → 'API Access'",
          "Click 'Generate API Key'",
          "Copy the key and paste it below",
        ]}
        testUrl={null}
        testLabel="Test with a container number in the Logistics module"
        note="100 tracking requests per month. Covers MAERSK, MSC, CMA CGM, COSCO, Hapag-Lloyd, ONE, Yang Ming, and more."
      />

      {/* 5. UN Comtrade */}
      <ApiIntegrationCard
        title="UN Comtrade — Trade Statistics"
        description="Official UN international trade data: import/export values by country pair and HS code."
        icon="🌐"
        badge="500/day FREE"
        badgeColor="violet"
        apiKey={value.uncomtrade_api_key}
        onChange={(v) => set("uncomtrade_api_key", v)}
        steps={[
          "Go to https://comtradeapi.un.org",
          "Click 'Register' and fill in your details",
          "After email verification, log in",
          "Go to 'Profile' → copy your 'Subscription Key' (32-character hex string)",
          "Paste it below and click Save",
        ]}
        testUrl={null}
        testLabel="Test in the Trade module — search import/export data by country"
        note="500 API calls per day. Shows official trade statistics: how much of a product was imported/exported between any two countries."
      />

      {/* Always-on (no key needed) integrations */}
      <Card className="border-emerald-500/30 bg-emerald-50/50 dark:bg-emerald-950/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CheckCircle2 className="size-5 text-emerald-600" />
            Always Active (No Setup Needed)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-start gap-3 p-3 rounded-lg bg-card border border-border/40">
            <span className="text-xl">🌍</span>
            <div>
              <p className="text-sm font-medium">Countries & Cities Database</p>
              <p className="text-xs text-muted-foreground">125 countries with 15+ cities each, flags, currencies, calling codes. Our own embedded data — always works.</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-card border border-border/40">
            <span className="text-xl">⚓</span>
            <div>
              <p className="text-sm font-medium">World Port Index</p>
              <p className="text-xs text-muted-foreground">120+ major ports with UN/LOCODE and coordinates. Auto-completes POL/POD fields.</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-card border border-border/40">
            <span className="text-xl">📍</span>
            <div>
              <p className="text-sm font-medium">Address Autocomplete (Nominatim/OSM)</p>
              <p className="text-xs text-muted-foreground">Free address search via OpenStreetMap. No API key needed — just start typing an address.</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-card border border-border/40">
            <span className="text-xl">⚠️</span>
            <div>
              <p className="text-sm font-medium">OFAC Sanctions Check</p>
              <p className="text-xs text-muted-foreground">Search the US Treasury SDN list. Free public data. Check any partner name before doing business.</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-card border border-border/40">
            <span className="text-xl">📋</span>
            <div>
              <p className="text-sm font-medium">Trade Advisor (FTA + Tariffs)</p>
              <p className="text-xs text-muted-foreground">Checks Free Trade Agreements, tariff rates, and required documents between any two countries. Built-in FTA database.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => save(value)} disabled={saving}>
          {saving ? t("admin-saving") : t("save")}
        </Button>
      </div>
    </div>
  );
}

function ApiIntegrationCard({
  title,
  description,
  icon,
  badge,
  badgeColor,
  apiKey,
  onChange,
  steps,
  testUrl,
  testLabel,
  note,
}: {
  title: string;
  description: string;
  icon: string;
  badge: string;
  badgeColor: "emerald" | "amber" | "sky" | "blue" | "violet";
  apiKey: string;
  onChange: (v: string) => void;
  steps: string[];
  testUrl: string | null;
  testLabel: string;
  note?: string;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const [showSteps, setShowSteps] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  async function runTest() {
    if (!testUrl || !apiKey) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fetch(testUrl);
      const data = await r.json();
      if (data.error) {
        setTestResult(`❌ ${data.error}`);
      } else if (data.rate) {
        setTestResult(`✅ Success! Rate: ${data.rate} (source: ${data.source})`);
      } else if (data.price) {
        setTestResult(`✅ Success! Price: $${data.price} (change: ${data.changePct}%)`);
      } else if (data.temperature !== undefined) {
        setTestResult(`✅ Success! ${data.location}: ${data.temperature}°C, ${data.description}`);
      } else if (data.items) {
        setTestResult(`✅ Success! ${data.items.length || data.total} results`);
      } else {
        setTestResult(`✅ Connected successfully`);
      }
    } catch (e: any) {
      setTestResult(`❌ ${e.message}`);
    } finally {
      setTesting(false);
    }
  }

  const badgeClasses: Record<string, string> = {
    emerald: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30",
    amber: "bg-amber-500/10 text-amber-700 border-amber-500/30",
    sky: "bg-sky-500/10 text-sky-700 border-sky-500/30",
    blue: "bg-blue-500/10 text-blue-700 border-blue-500/30",
    violet: "bg-violet-500/10 text-violet-700 border-violet-500/30",
  };

  return (
    <Card className="border-border/60 shadow-soft rounded-xl">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{icon}</span>
            <div>
              <CardTitle className="text-base">{title}</CardTitle>
              <CardDescription>{description}</CardDescription>
            </div>
          </div>
          <Badge variant="outline" className={badgeClasses[badgeColor]}>{badge}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label>API Key</Label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Paste your API key here…"
            className="font-mono"
          />
        </div>

        {note && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-muted/40 text-xs text-muted-foreground">
            <Info className="size-3.5 shrink-0 mt-0.5" />
            <span>{note}</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          {testUrl && (
            <Button
              variant="secondary"
              size="sm"
              onClick={runTest}
              disabled={testing || !apiKey}
              className="gap-1.5"
            >
              {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
              {testLabel}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowSteps(!showSteps)}
            className="gap-1.5"
          >
            <Info className="size-3.5" />
            {showSteps ? "Hide setup guide" : "How to get API key?"}
          </Button>
        </div>

        {testResult && (
          <div className={`p-2.5 rounded-lg text-xs ${testResult.startsWith("✅") ? "bg-emerald-500/10 text-emerald-700" : "bg-destructive/10 text-destructive"}`}>
            {testResult}
          </div>
        )}

        {showSteps && (
          <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
            <p className="text-xs font-semibold mb-2">Step-by-step setup guide:</p>
            <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal list-inside">
              {steps.map((step, i) => (
                <li key={i} className="leading-relaxed">{step}</li>
              ))}
            </ol>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ToggleRow({
  label, checked, onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between p-3 rounded-md bg-muted/30">
      <p className="text-sm font-medium">{label}</p>
      <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={label} />
    </div>
  );
}

// ─── User Preferences Tab ────────────────────────────────────────────────

const PREF_DEFAULTS: Record<string, string> = {
  ui_language: "en",
  default_view: "dashboard",
  date_format: "YYYY-MM-DD",
  number_format: "1,234.56",
  items_per_page: "25",
  compact_mode: "false",
  email_notifications: "true",
  push_notifications: "true",
  auto_refresh_dashboard: "false",
  auto_refresh_interval: "60",
};

function PreferencesTab() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [prefs, setPrefs] = useState<Record<string, string>>(PREF_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
// eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    fetch(api("/api/user-preferences"))
      .then((r) => r.json())
      .then((data) => {
        if (active && data.map) {
          setPrefs((prev) => {
            const next = { ...prev };
            for (const [k, v] of Object.entries(data.map as Record<string, unknown>)) {
              next[k] = String(v);
            }
            return next;
          });
        }
      })
      .catch(() => toast.error("Failed to load preferences."))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function savePref(key: string, value: string) {
    setSaving(true);
    try {
      const r = await fetch(api("/api/user-preferences"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to save");
      }
      setPrefs((prev) => ({ ...prev, [key]: value }));
      toast.success("Preference saved.");
    } catch (e: any) {
      toast.error(e.message || "Failed to save preference.");
    } finally {
      setSaving(false);
    }
  }

  async function saveAll() {
    setSaving(true);
    try {
      const entries = Object.entries(prefs);
      await Promise.all(
        entries.map(([key, value]) =>
          fetch(api("/api/user-preferences"), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key, value }),
          })
        )
      );
      toast.success("All preferences saved.");
    } catch {
      toast.error("Failed to save some preferences.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-6 space-y-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/60 shadow-soft rounded-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><UserCog className="size-5" /> {t("admin-settings-preferences-title")}</CardTitle>
        <CardDescription>{t("admin-settings-preferences-desc")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Language */}
          <div className="space-y-1.5">
            <Label>{t("common-label-language")}</Label>
            <Select value={prefs.ui_language} onValueChange={(v) => savePref("ui_language", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Default View */}
          <div className="space-y-1.5">
            <Label>{t("common-label-default-view")}</Label>
            <Select value={prefs.default_view} onValueChange={(v) => savePref("default_view", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="dashboard">Dashboard</SelectItem>
                <SelectItem value="partners">Partners</SelectItem>
                <SelectItem value="deals">Deals</SelectItem>
                <SelectItem value="offers">Offers</SelectItem>
                <SelectItem value="invoices">Invoices</SelectItem>
                <SelectItem value="products">Products</SelectItem>
                <SelectItem value="tasks">Tasks</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Date Format */}
          <div className="space-y-1.5">
            <Label>{t("common-label-date-format")}</Label>
            <Select value={prefs.date_format} onValueChange={(v) => savePref("date_format", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="YYYY-MM-DD">YYYY-MM-DD</SelectItem>
                <SelectItem value="DD/MM/YYYY">DD/MM/YYYY</SelectItem>
                <SelectItem value="MM/DD/YYYY">MM/DD/YYYY</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Number Format */}
          <div className="space-y-1.5">
            <Label>{t("common-label-number-format")}</Label>
            <Select value={prefs.number_format} onValueChange={(v) => savePref("number_format", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1,234.56">1,234.56 (comma thousands)</SelectItem>
                <SelectItem value="1.234,56">1.234,56 (dot thousands)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Items Per Page */}
          <div className="space-y-1.5">
            <Label>{t("common-label-items-per-page")}</Label>
            <Select value={prefs.items_per_page} onValueChange={(v) => savePref("items_per_page", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="10">10</SelectItem>
                <SelectItem value="25">25</SelectItem>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Auto-refresh Interval (shown when auto-refresh is on) */}
          <div className="space-y-1.5">
            <Label>{t("common-label-auto-refresh-interval")}</Label>
            <Select
              value={prefs.auto_refresh_interval}
              onValueChange={(v) => savePref("auto_refresh_interval", v)}
              disabled={prefs.auto_refresh_dashboard !== "true"}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="30">30 seconds</SelectItem>
                <SelectItem value="60">60 seconds</SelectItem>
                <SelectItem value="300">5 minutes</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Toggles */}
        <div className="mt-6 pt-4 border-t">
          <p className="text-sm font-medium text-muted-foreground mb-3">Display &amp; Notifications</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ToggleRow
              label="Compact Mode (dense table rows)"
              checked={prefs.compact_mode === "true"}
              onCheckedChange={(v) => savePref("compact_mode", String(v))}
            />
            <ToggleRow
              label="Email Notifications"
              checked={prefs.email_notifications === "true"}
              onCheckedChange={(v) => savePref("email_notifications", String(v))}
            />
            <ToggleRow
              label="Push Notifications"
              checked={prefs.push_notifications === "true"}
              onCheckedChange={(v) => savePref("push_notifications", String(v))}
            />
            <ToggleRow
              label="Auto-refresh Dashboard"
              checked={prefs.auto_refresh_dashboard === "true"}
              onCheckedChange={(v) => savePref("auto_refresh_dashboard", String(v))}
            />
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <Button onClick={saveAll} disabled={saving}>
            {saving ? t("admin-saving") : t("save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Memorandum (PDF header/footer) Tab ────────────────────────────────────
// Per-tenant memorandum config — header (logo + company name) + footer
// (QR + address + page number) + body defaults. The PDF generator reads
// these settings to render the memorandum on every page.

const FONT_FAMILY_OPTIONS: { label: string; value: string; css: string }[] = [
  { label: "Helvetica", value: "Helvetica", css: "Helvetica, Arial, sans-serif" },
  { label: "Times-Roman", value: "Times-Roman", css: "'Times New Roman', Times, serif" },
  { label: "Courier", value: "Courier", css: "'Courier New', Courier, monospace" },
];

const FIT_MODE_OPTIONS = [
  { label: "Contain (no distortion)", value: "contain" },
  { label: "Cover (fills area, crops)", value: "cover" },
  { label: "Fill (stretches)", value: "fill" },
];

const ALIGN_OPTIONS = [
  { label: "Left", value: "left" },
  { label: "Center", value: "center" },
  { label: "Right", value: "right" },
];

/** Map a PDF font family to a CSS-equivalent stack for the live preview. */
function fontCss(pdfFont: string): string {
  return (
    FONT_FAMILY_OPTIONS.find((f) => f.value === pdfFont)?.css ??
    "Helvetica, Arial, sans-serif"
  );
}

/** Convert a CSS alignment string to a literal union type. */
function alignCss(a: string): "left" | "center" | "right" {
  return a === "left" ? "left" : a === "right" ? "right" : "center";
}

// A4 page is 210mm wide × 297mm tall. We render the preview in a container
// with `container-type: inline-size` so we can express any mm measurement as
// `cqw` (1% of container width = 2.1mm). Because the container preserves the
// A4 aspect ratio, this works for BOTH horizontal and vertical sizes — a
// 30mm-tall header is `30 * (100/210) cqw` ≈ 14.3cqw, which renders as 10.1%
// of the page height (correct).
const MM = 100 / 210; // cqw per mm
const mm = (n: number): string => `${n * MM}cqw`;
// 1pt = 0.353mm (PDF points)
const pt = (n: number): string => mm(n * 0.353);

/**
 * NotificationsTab — NOTIF-UX per-type notification preferences.
 *
 * Renders a list of per-type toggles (offers / invoices / messages / KYC /
 * marketplace / trial / system). Stored in the user's `notif_prefs` JSONB
 * column on the users table (Prisma schema already declares the column —
 * see prisma/schema.prisma line ~110).
 *
 * The tab talks to the new /api/notifications/prefs endpoint:
 *   GET  → { prefs: { offers: true, invoices: true, ... } }
 *   PUT  → { offers: false }   (partial update, server merges)
 *
 * Default-on for every key — a fresh user with no row set should still
 * receive all notification types (the API normalizes missing keys to true).
 */
interface NotifPrefs {
  offers: boolean;
  invoices: boolean;
  messages: boolean;
  kyc: boolean;
  marketplace: boolean;
  trial: boolean;
  system: boolean;
}
const DEFAULT_NOTIF_PREFS: NotifPrefs = {
  offers: true, invoices: true, messages: true, kyc: true,
  marketplace: true, trial: true, system: true,
};

const NOTIF_PREF_ROWS: { key: keyof NotifPrefs; icon: ComponentType<{ className?: string }>; titleKey: string; descKey: string }[] = [
  { key: "offers",      icon: FileText,      titleKey: "notif-prefs-offers",      descKey: "notif-prefs-offers-desc" },
  { key: "invoices",    icon: DollarSign,    titleKey: "notif-prefs-invoices",    descKey: "notif-prefs-invoices-desc" },
  { key: "messages",    icon: MessageSquare, titleKey: "notif-prefs-messages",    descKey: "notif-prefs-messages-desc" },
  { key: "kyc",         icon: ShieldCheck,   titleKey: "notif-prefs-kyc",          descKey: "notif-prefs-kyc-desc" },
  { key: "marketplace", icon: Store,         titleKey: "notif-prefs-marketplace", descKey: "notif-prefs-marketplace-desc" },
  { key: "trial",       icon: Clock,         titleKey: "notif-prefs-trial",       descKey: "notif-prefs-trial-desc" },
  { key: "system",      icon: Info,          titleKey: "notif-prefs-system",      descKey: "notif-prefs-system-desc" },
];

function NotificationsTab() {
  const t = useT();
  const [prefs, setPrefs] = useState<NotifPrefs>(DEFAULT_NOTIF_PREFS);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<keyof NotifPrefs | null>(null);

  useEffect(() => {
    let active = true;
// eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    fetch("/api/notifications/prefs")
      .then((r) => r.json())
      .then((data) => {
        if (!active) return;
        // Merge with defaults so missing keys stay on (server default-on
        // semantics mirrored client-side for snappy UI before fetch resolves).
        const next: NotifPrefs = { ...DEFAULT_NOTIF_PREFS };
        const incoming = data?.prefs;
        if (incoming && typeof incoming === "object") {
          for (const k of Object.keys(DEFAULT_NOTIF_PREFS) as (keyof NotifPrefs)[]) {
            if (incoming[k] === false) next[k] = false;
          }
        }
        setPrefs(next);
      })
      .catch(() => toast.error("Failed to load notification preferences."))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function toggle(key: keyof NotifPrefs, value: boolean) {
    // Optimistic update so the toggle flips immediately — the API round
    // trip is fast but the user expects Switch to be instant.
    setPrefs((prev) => ({ ...prev, [key]: value }));
    setSavingKey(key);
    try {
      const r = await fetch("/api/notifications/prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      if (!r.ok) throw new Error("Failed");
      toast.success(t("notif-prefs-saved"));
    } catch {
      // Revert on failure.
      setPrefs((prev) => ({ ...prev, [key]: !value }));
      toast.error(t("notif-prefs-save-failed"));
    } finally {
      setSavingKey(null);
    }
  }

  if (loading) {
    return (
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-6 space-y-3">
          {Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/60 shadow-soft rounded-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Bell className="size-5" /> {t("notif-prefs-title")}</CardTitle>
        <CardDescription>{t("notif-prefs-desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {NOTIF_PREF_ROWS.map((row) => {
          const Icon = row.icon;
          const isSaving = savingKey === row.key;
          return (
            <div
              key={row.key}
              className="flex items-start justify-between gap-3 py-3 border-b border-border/40 last:border-0"
            >
              <div className="flex items-start gap-3 min-w-0">
                <div className="size-8 rounded-lg bg-muted/50 flex items-center justify-center shrink-0 text-muted-foreground">
                  <Icon className="size-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t(row.titleKey)}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t(row.descKey)}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {isSaving && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
                <Switch
                  checked={prefs[row.key]}
                  onCheckedChange={(v) => toggle(row.key, v)}
                  aria-label={t(row.titleKey)}
                />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function MemorandumTab() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [settings, setSettings] = useState<MemorandumSettings | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
// eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    Promise.all([
      fetch(api("/api/memorandum-settings"))
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch(api("/api/tenants"))
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]).then(([s, t]) => {
      if (!active) return;
      if (s) setSettings(s as MemorandumSettings);
      if (t?.items?.length) setTenant(t.items[0] as Tenant);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantKey]);

  function set<K extends keyof MemorandumSettings>(k: K, v: MemorandumSettings[K]) {
    setSettings((prev) => (prev ? { ...prev, [k]: v } : prev));
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      const r = await fetch(api("/api/memorandum-settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to save");
      }
      const updated = await r.json();
      setSettings(updated as MemorandumSettings);
      toast.success("Memorandum settings saved.");
    } catch (e: any) {
      toast.error(e.message || "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-6 space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (!settings) {
    // Super-admin without an active tenant context.
    return (
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-6 flex items-center gap-3">
          <Info className="size-5 text-muted-foreground shrink-0" />
          <p className="text-sm text-muted-foreground">
            Select a tenant context to configure memorandum settings.
          </p>
        </CardContent>
      </Card>
    );
  }

  const colSum =
    settings.footer_left_width_pct +
    settings.footer_center_width_pct +
    settings.footer_right_width_pct;

  return (
    <Card className="border-border/60 shadow-soft rounded-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="size-5" /> {t("admin-settings-memorandum-title")}
        </CardTitle>
        <CardDescription>
          {t("admin-settings-memorandum-desc")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── Left: Settings ─────────────────────────────────────────── */}
          <div className="space-y-4">
            {/* Header */}
            <section className="space-y-3 rounded-lg border border-border/60 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Building2 className="size-4 text-muted-foreground" />
                  <h3 className="text-sm font-semibold">Header</h3>
                </div>
                <Switch
                  checked={settings.header_enabled}
                  onCheckedChange={(v) => set("header_enabled", v)}
                  aria-label="Toggle header section"
                />
              </div>
              {settings.header_enabled && (
                <>
                  <SliderField
                    label={`Height (${settings.header_height_mm}mm)`}
                    min={20} max={50} step={1}
                    value={settings.header_height_mm}
                    onChange={(v) => set("header_height_mm", v)}
                  />
                  <ColorField
                    label="Background"
                    value={settings.header_bg_color}
                    onChange={(v) => set("header_bg_color", v)}
                  />
                  <Separator />
                  <p className="text-xs font-medium text-muted-foreground">
                    Company name (left column)
                  </p>
                  <FontField
                    label="Font"
                    value={settings.header_left_font_family}
                    onChange={(v) => set("header_left_font_family", v)}
                  />
                  <SliderField
                    label={`Size (${settings.header_left_font_size}pt)`}
                    min={10} max={20} step={1}
                    value={settings.header_left_font_size}
                    onChange={(v) => set("header_left_font_size", v)}
                  />
                  <ColorField
                    label="Color"
                    value={settings.header_left_font_color}
                    onChange={(v) => set("header_left_font_color", v)}
                  />
                  <ToggleRow
                    label="Bold"
                    checked={settings.header_left_font_bold}
                    onCheckedChange={(v) => set("header_left_font_bold", v)}
                  />
                </>
              )}
            </section>

            {/* Logo */}
            <section className="space-y-3 rounded-lg border border-border/60 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ImageIcon className="size-4 text-muted-foreground" />
                  <h3 className="text-sm font-semibold">Logo</h3>
                </div>
                <Switch
                  checked={settings.logo_enabled}
                  onCheckedChange={(v) => set("logo_enabled", v)}
                  aria-label="Toggle logo"
                />
              </div>
              {settings.logo_enabled && (
                <>
                  <SliderField
                    label={`Max width (${settings.logo_max_width_mm}mm)`}
                    min={30} max={80} step={1}
                    value={settings.logo_max_width_mm}
                    onChange={(v) => set("logo_max_width_mm", v)}
                  />
                  <SliderField
                    label={`Max height (${settings.logo_max_height_mm}mm)`}
                    min={10} max={30} step={1}
                    value={settings.logo_max_height_mm}
                    onChange={(v) => set("logo_max_height_mm", v)}
                  />
                  <SliderField
                    label={`Position X (${settings.logo_position_x_mm}mm)`}
                    min={-20} max={20} step={1}
                    value={settings.logo_position_x_mm}
                    onChange={(v) => set("logo_position_x_mm", v)}
                  />
                  <SliderField
                    label={`Position Y (${settings.logo_position_y_mm}mm)`}
                    min={-10} max={10} step={1}
                    value={settings.logo_position_y_mm}
                    onChange={(v) => set("logo_position_y_mm", v)}
                  />
                  <SelectField
                    label="Fit mode"
                    value={settings.logo_fit_mode}
                    options={FIT_MODE_OPTIONS}
                    onChange={(v) => set("logo_fit_mode", v)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Use <strong>Contain</strong> to prevent distortion.
                  </p>
                </>
              )}
            </section>

            {/* Footer */}
            <section className="space-y-3 rounded-lg border border-border/60 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText className="size-4 text-muted-foreground" />
                  <h3 className="text-sm font-semibold">Footer</h3>
                </div>
                <Switch
                  checked={settings.footer_enabled}
                  onCheckedChange={(v) => set("footer_enabled", v)}
                  aria-label="Toggle footer section"
                />
              </div>
              {settings.footer_enabled && (
                <>
                  <SliderField
                    label={`Height (${settings.footer_height_mm}mm)`}
                    min={15} max={40} step={1}
                    value={settings.footer_height_mm}
                    onChange={(v) => set("footer_height_mm", v)}
                  />
                  <ColorField
                    label="Background"
                    value={settings.footer_bg_color}
                    onChange={(v) => set("footer_bg_color", v)}
                  />

                  <Separator />
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <QrCode className="size-4 text-muted-foreground" />
                      <p className="text-xs font-medium">QR code (left)</p>
                    </div>
                    <Switch
                      checked={settings.qr_enabled}
                      onCheckedChange={(v) => set("qr_enabled", v)}
                      aria-label="Toggle QR code"
                    />
                  </div>
                  {settings.qr_enabled && (
                    <>
                      <SliderField
                        label={`Size (${settings.qr_size_mm}mm)`}
                        min={10} max={25} step={1}
                        value={settings.qr_size_mm}
                        onChange={(v) => set("qr_size_mm", v)}
                      />
                      <SliderField
                        label={`Position X (${settings.qr_position_x_mm}mm)`}
                        min={-20} max={20} step={1}
                        value={settings.qr_position_x_mm}
                        onChange={(v) => set("qr_position_x_mm", v)}
                      />
                      <SliderField
                        label={`Position Y (${settings.qr_position_y_mm}mm)`}
                        min={-10} max={10} step={1}
                        value={settings.qr_position_y_mm}
                        onChange={(v) => set("qr_position_y_mm", v)}
                      />
                    </>
                  )}

                  <Separator />
                  <p className="text-xs font-medium text-muted-foreground">
                    Address (center column)
                  </p>
                  <FontField
                    label="Font"
                    value={settings.footer_center_font_family}
                    onChange={(v) => set("footer_center_font_family", v)}
                  />
                  <SliderField
                    label={`Size (${settings.footer_center_font_size}pt)`}
                    min={6} max={12} step={1}
                    value={settings.footer_center_font_size}
                    onChange={(v) => set("footer_center_font_size", v)}
                  />
                  <ColorField
                    label="Color"
                    value={settings.footer_center_font_color}
                    onChange={(v) => set("footer_center_font_color", v)}
                  />
                  <SelectField
                    label="Alignment"
                    value={settings.footer_center_alignment}
                    options={ALIGN_OPTIONS}
                    onChange={(v) => set("footer_center_alignment", v)}
                  />

                  <Separator />
                  <p className="text-xs font-medium text-muted-foreground">
                    Page number (right column)
                  </p>
                  <FontField
                    label="Font"
                    value={settings.footer_right_font_family}
                    onChange={(v) => set("footer_right_font_family", v)}
                  />
                  <SliderField
                    label={`Size (${settings.footer_right_font_size}pt)`}
                    min={6} max={12} step={1}
                    value={settings.footer_right_font_size}
                    onChange={(v) => set("footer_right_font_size", v)}
                  />
                  <ColorField
                    label="Color"
                    value={settings.footer_right_font_color}
                    onChange={(v) => set("footer_right_font_color", v)}
                  />

                  <Separator />
                  <p className="text-xs font-medium text-muted-foreground">
                    Column widths
                  </p>
                  <SliderField
                    label={`Left (${settings.footer_left_width_pct}%)`}
                    min={10} max={70} step={5}
                    value={settings.footer_left_width_pct}
                    onChange={(v) => set("footer_left_width_pct", v)}
                  />
                  <SliderField
                    label={`Center (${settings.footer_center_width_pct}%)`}
                    min={10} max={80} step={5}
                    value={settings.footer_center_width_pct}
                    onChange={(v) => set("footer_center_width_pct", v)}
                  />
                  <SliderField
                    label={`Right (${settings.footer_right_width_pct}%)`}
                    min={10} max={70} step={5}
                    value={settings.footer_right_width_pct}
                    onChange={(v) => set("footer_right_width_pct", v)}
                  />
                  <div
                    className={
                      "text-xs font-medium " +
                      (colSum === 100
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-amber-600 dark:text-amber-400")
                    }
                  >
                    Sum: {colSum}% {colSum === 100 ? "✓" : "(should be 100)"}
                  </div>
                </>
              )}
            </section>

            {/* Body */}
            <section className="space-y-3 rounded-lg border border-border/60 p-4">
              <div className="flex items-center gap-2">
                <Palette className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">Body defaults</h3>
              </div>
              <FontField
                label="Font"
                value={settings.body_font_family}
                onChange={(v) => set("body_font_family", v)}
              />
              <SliderField
                label={`Size (${settings.body_font_size}pt)`}
                min={8} max={12} step={1}
                value={settings.body_font_size}
                onChange={(v) => set("body_font_size", v)}
              />
              <SliderField
                label={`Line height (${settings.body_line_height.toFixed(2)})`}
                min={1} max={2} step={0.05}
                value={settings.body_line_height}
                onChange={(v) => set("body_line_height", v)}
              />
              <ColorField
                label="Text color"
                value={settings.body_text_color}
                onChange={(v) => set("body_text_color", v)}
              />
              <ColorField
                label="Primary color (accents)"
                value={settings.primary_color}
                onChange={(v) => set("primary_color", v)}
              />
            </section>

            <div className="flex justify-end">
              <Button onClick={save} disabled={saving}>
                {saving ? (
                  <Loader2 className="size-4 mr-1.5 animate-spin" />
                ) : (
                  <Save className="size-4 mr-1.5" />
                )}
                {saving ? t("admin-saving") : t("save")}
              </Button>
            </div>
          </div>

          {/* ── Right: Live preview (sticky on desktop) ──────────────── */}
          <div className="lg:sticky lg:top-4 h-fit">
            <MemorandumPreview settings={settings} tenant={tenant} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Scaled A4 page showing the configured header (logo + company name),
 * sample body content, and footer (QR + address + page number). Sizes are
 * expressed in `cqw` units (1% of the container's width = 2.1mm of A4 width),
 * so the whole page scales responsively without distorting the logo
 * (objectFit: contain).
 */
function MemorandumPreview({
  settings,
  tenant,
}: {
  settings: MemorandumSettings;
  tenant: Tenant | null;
}) {
  const companyName =
    tenant?.legal_name || tenant?.name || "Acme Trade DMCC";
  const logoUrl = tenant?.logo_url
    ? resolveLogoUrlForDisplay(tenant.logo_url)
    : null;
  const addrLine1 =
    [tenant?.address_line, tenant?.city].filter(Boolean).join(", ") ||
    "Office 1234, DMCC, Dubai";
  const addrLine2 = tenant?.website || "www.example.com";
  const addrLine3 = tenant?.email || "info@example.com";

  const headerLeftFont = fontCss(settings.header_left_font_family);
  const footerCenterFont = fontCss(settings.footer_center_font_family);
  const footerRightFont = fontCss(settings.footer_right_font_family);
  const bodyFont = fontCss(settings.body_font_family);

  const colL = `${settings.footer_left_width_pct}%`;
  const colC = `${settings.footer_center_width_pct}%`;
  const colR = `${settings.footer_right_width_pct}%`;

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
        <FileText className="size-3.5" />
        Live preview — A4 page
      </p>
      <div
        className="relative mx-auto bg-white shadow-soft border border-border/60 rounded-sm overflow-hidden"
        style={{
          aspectRatio: "210 / 297",
          maxWidth: "30rem",
          width: "100%",
          containerType: "inline-size",
        }}
      >
        <div className="absolute inset-0 flex flex-col">
          {/* HEADER */}
          {settings.header_enabled && (
            <div
              className="flex items-stretch border-b border-border/30 shrink-0"
              style={{
                height: mm(settings.header_height_mm),
                backgroundColor: settings.header_bg_color,
              }}
            >
              {/* Left: company name */}
              <div
                className="flex-1 flex items-center"
                style={{ padding: mm(8) }}
              >
                <span
                  style={{
                    fontFamily: headerLeftFont,
                    fontSize: pt(settings.header_left_font_size),
                    color: settings.header_left_font_color,
                    fontWeight: settings.header_left_font_bold ? 700 : 400,
                    lineHeight: 1.1,
                    wordBreak: "break-word",
                  }}
                >
                  {companyName}
                </span>
              </div>
              {/* Right: logo */}
              <div className="flex-1 relative flex items-center justify-center">
                {settings.logo_enabled && logoUrl ? (
                  <img
                    src={logoUrl}
                    alt="Logo"
                    style={{
                      maxWidth: mm(settings.logo_max_width_mm),
                      maxHeight: mm(settings.logo_max_height_mm),
                      objectFit: settings.logo_fit_mode as React.CSSProperties["objectFit"],
                      transform: `translate(${mm(settings.logo_position_x_mm)}, ${mm(settings.logo_position_y_mm)})`,
                    }}
                  />
                ) : settings.logo_enabled ? (
                  <div
                    className="flex items-center justify-center text-muted-foreground/40 border border-dashed border-border/40"
                    style={{
                      width: mm(settings.logo_max_width_mm),
                      height: mm(settings.logo_max_height_mm),
                      fontSize: pt(6),
                    }}
                  >
                    Logo
                  </div>
                ) : null}
              </div>
            </div>
          )}

          {/* BODY */}
          <div
            className="flex-1 overflow-hidden"
            style={{
              padding: mm(10),
              fontFamily: bodyFont,
              fontSize: pt(settings.body_font_size),
              lineHeight: settings.body_line_height,
              color: settings.body_text_color,
            }}
          >
            <div
              className="font-bold mb-1"
              style={{
                fontSize: pt(11),
                color: settings.primary_color,
              }}
            >
              OFFER #ASP-OF26-001
            </div>
            <div
              className="mb-2"
              style={{
                fontSize: pt(7),
                color: settings.body_text_color,
                opacity: 0.7,
              }}
            >
              Date: 2025-11-12 · Valid until: 2025-12-12
            </div>
            <div
              className="mb-1.5"
              style={{ fontWeight: 600 }}
            >
              1. Refined Sunflower Oil — 50 MT
            </div>
            <p style={{ fontSize: pt(7), opacity: 0.85 }}>
              High-oleic refined sunflower oil, packed in 1L PET bottles
              (12 per carton). Origin: Ukraine. Conforms to EU regulations
              for human consumption.
            </p>
            <div
              className="mt-2 grid grid-cols-3 gap-1"
              style={{ fontSize: pt(7) }}
            >
              <div className="font-semibold">Quantity</div>
              <div className="font-semibold">Unit Price</div>
              <div className="font-semibold text-right">Total</div>
              <div>50 MT</div>
              <div>$1,250.00</div>
              <div className="text-right">$62,500.00</div>
            </div>
            <p
              style={{
                fontSize: pt(7),
                marginTop: mm(2),
                opacity: 0.6,
              }}
            >
              Payment: 30% advance, 70% against B/L copy. Delivery: CIF Jebel Ali.
            </p>
          </div>

          {/* FOOTER */}
          {settings.footer_enabled && (
            <div
              className="flex items-stretch border-t border-border/30 shrink-0"
              style={{
                height: mm(settings.footer_height_mm),
                backgroundColor: settings.footer_bg_color,
              }}
            >
              {/* Left: QR */}
              <div
                className="relative flex items-center justify-center"
                style={{ width: colL, padding: mm(3) }}
              >
                {settings.qr_enabled && (
                  <div
                    style={{
                      width: mm(settings.qr_size_mm),
                      height: mm(settings.qr_size_mm),
                      transform: `translate(${mm(settings.qr_position_x_mm)}, ${mm(settings.qr_position_y_mm)})`,
                    }}
                  >
                    <QrPlaceholder />
                  </div>
                )}
              </div>
              {/* Center: address */}
              <div
                className="flex flex-col justify-center"
                style={{
                  width: colC,
                  padding: mm(3),
                  fontFamily: footerCenterFont,
                  fontSize: pt(settings.footer_center_font_size),
                  color: settings.footer_center_font_color,
                  textAlign: alignCss(settings.footer_center_alignment),
                  lineHeight: 1.3,
                }}
              >
                <div>{addrLine1}</div>
                <div>{addrLine2}</div>
                <div>{addrLine3}</div>
              </div>
              {/* Right: page number */}
              <div
                className="flex flex-col justify-center items-end"
                style={{
                  width: colR,
                  padding: mm(3),
                  fontFamily: footerRightFont,
                  fontSize: pt(settings.footer_right_font_size),
                  color: settings.footer_right_font_color,
                  textAlign: "right",
                  lineHeight: 1.3,
                }}
              >
                <div>Page 1 of 1</div>
              </div>
            </div>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground/80 text-center">
        Visual approximation — actual PDF rendering may differ slightly.
      </p>
    </div>
  );
}

/** 5×5 deterministic SVG mock — visual stand-in for the real QR the PDF renders. */
function QrPlaceholder() {
  const pattern = ["11101", "10111", "00010", "11011", "01101"];
  return (
    <svg viewBox="0 0 5 5" className="w-full h-full" preserveAspectRatio="none">
      <rect width="5" height="5" fill="white" />
      {pattern.map((row, y) =>
        row.split("").map((cell, x) =>
          cell === "1" ? (
            <rect
              key={`${x}-${y}`}
              x={x}
              y={y}
              width="1"
              height="1"
              fill="black"
            />
          ) : null
        )
      )}
    </svg>
  );
}

// ─── Small field helpers (MemorandumTab-local) ─────────────────────────────

function SliderField({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(v[0])}
      />
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value || "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="size-8 rounded-md border border-border/60 cursor-pointer bg-card p-0.5"
        />
        <Input
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 font-mono text-xs flex-1"
        />
      </div>
    </div>
  );
}

function FontField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FONT_FAMILY_OPTIONS.map((f) => (
            <SelectItem key={f.value} value={f.value}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { label: string; value: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   FEAT-1 (Password change in Settings) — self-service password rotation.
   ═══════════════════════════════════════════════════════════════════════════ */
/**
 * `ChangePasswordTab` — visible to every admin (super_admin + tenant
 * admin) under the Settings → Password tab. The form posts to
 * `/api/auth/change-password` which is open to any authenticated user
 * (the API doesn't gate on role — non-admins who somehow reach the
 * endpoint can also rotate their own password).
 *
 * UX:
 *   • three password inputs (current / new / confirm) — each with a
 *     show/hide eye toggle (passwords are masked by default but the
 *     user can reveal for typing sanity-check)
 *   • inline validation: new === confirm, new meets platform min
 *     length (8 by default — server is the source of truth and the
 *     toast surfaces the exact policy message on failure)
 *   • on success: toast "Password changed successfully" + reset form
 *   • on failure: surface the API's error message verbatim (the
 *     server returns specific messages for "Current password is
 *     incorrect" / "New password does not meet requirements" / etc.)
 *
 * The current session is re-minted server-side after the change (see
 * the route's header comment), so the user stays logged in — only
 * OTHER sessions (other tabs, stolen cookies) are invalidated.
 */
function ChangePasswordTab() {
  const t = useT();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // FIX-UX #4: warn before closing/refreshing the tab once the user has
  // started typing a password. Avoids losing a half-typed password
  // (especially painful on mobile).
  const pwDirty = current.length > 0 || next.length > 0 || confirm.length > 0;
  useEffect(() => {
    if (!pwDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [pwDirty]);

  // Local validation gates — the server is the source of truth
  // (it loads the platform policy from settings.security_config), so
  // even if these pass, a weak password will be rejected by the API.
  // The min length here is the DEFAULT_POLICY (8) — if the platform
  // policy is stricter, the server's error message will tell the user.
  const MIN_LENGTH = 8;
  const confirmMismatch = confirm.length > 0 && next !== confirm;
  const tooShort = next.length > 0 && next.length < MIN_LENGTH;
  const canSubmit =
    current.length > 0 &&
    next.length >= MIN_LENGTH &&
    next === confirm &&
    !submitting;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const r = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current_password: current,
          new_password: next,
          confirm_password: confirm,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        // Surface the server's specific error message verbatim
        // ("Current password is incorrect." / "New password does not
        // meet requirements." etc.).
        toast.error(data?.error || t("admin-settings-save-failed"));
        return;
      }
      toast.success("Password changed successfully");
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (e) {
      console.error("[change-password]", e);
      toast.error("Network error — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="rounded-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserCog className="size-5" />
          {t("admin-settings-tab-password")}
        </CardTitle>
        <CardDescription>
          Change the password you use to sign in to VELOS. Other active
          sessions on different devices will be signed out.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4 max-w-md">
          {/* Current password */}
          <div className="space-y-1.5">
            <Label htmlFor="chpw-current">{t("common-label-current-password")}</Label>
            <div className="relative">
              <Input
                id="chpw-current"
                type={showCurrent ? "text" : "password"}
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                disabled={submitting}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowCurrent((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
                tabIndex={-1}
                aria-label={showCurrent ? "Hide current password" : "Show current password"}
              >
                {showCurrent ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          {/* New password */}
          <div className="space-y-1.5">
            <Label htmlFor="chpw-new">{t("pf-new-password")}</Label>
            <div className="relative">
              <Input
                id="chpw-new"
                type={showNext ? "text" : "password"}
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                disabled={submitting}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowNext((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
                tabIndex={-1}
                aria-label={showNext ? "Hide new password" : "Show new password"}
              >
                {showNext ? "Hide" : "Show"}
              </button>
            </div>
            {tooShort && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Password must be at least {MIN_LENGTH} characters.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Must meet the platform password policy (min length, uppercase,
              lowercase, number — symbols optional).
            </p>
          </div>

          {/* Confirm new password */}
          <div className="space-y-1.5">
            <Label htmlFor="chpw-confirm">{t("common-label-confirm-new-password")}</Label>
            <div className="relative">
              <Input
                id="chpw-confirm"
                type={showConfirm ? "text" : "password"}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                disabled={submitting}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowConfirm((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
                tabIndex={-1}
                aria-label={showConfirm ? "Hide confirm password" : "Show confirm password"}
              >
                {showConfirm ? "Hide" : "Show"}
              </button>
            </div>
            {confirmMismatch && (
              <p className="text-xs text-red-600 dark:text-red-400">
                Passwords do not match.
              </p>
            )}
          </div>

          <Button type="submit" disabled={!canSubmit}>
            {submitting ? (
              <>
                <Loader2 className="size-4 mr-2 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Save className="size-4 mr-2" />
                Change password
              </>
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
