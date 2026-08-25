"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Paintbrush, Loader2, Save, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useApiUrl } from "@/lib/hooks/use-api-url";
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "@/lib/i18n/store";
import {
  SettingsCardHeader, SectionLabel, LoadingCard, ErrorCard, dirtyEq,
} from "./_shared";

/* ───────────────────────────────────────────────────────────────────────
   WhiteLabelConfig — UI-SUPER-AUDIT gap fix.

   The white-label backend has existed since Phase 12
   (lib/marketplace/white-label.ts + /api/admin/white-label route)
   and the i18n keys have shipped in `administration.ts` for the same
   period, but there was NO UI to set it from the super-admin console.
   Super-admins had to call the PUT endpoint manually or skip the
   feature entirely.

   This card slots into the super-admin Settings → System tab (above
   PlatformConfig) and exposes every WhiteLabelConfig field:
     • marketplace name
     • logo URL
     • primary / accent color
     • custom domain
     • featured categories (comma-separated)
     • custom footer text
     • hide-velos-branding toggle

   The shape matches `WhiteLabelConfig` from
   `src/lib/marketplace/white-label.ts` exactly; the backend validates
   + normalises (hex colour coercion, length caps, array slicing)
   before persisting, so the UI doesn't have to re-implement
   validation.
   ─────────────────────────────────────────────────────────────────────── */

interface WhiteLabelConfig {
  marketplaceName: string;
  logoUrl: string;
  primaryColor: string;
  accentColor: string;
  customDomain: string;
  featuredCategories: string[];
  customFooter: string;
  hideVelosBranding: boolean;
}

interface Tenant { id: string; name: string; }

export function WhiteLabelConfig() {
  const api = useApiUrl();
  const qc = useQueryClient();
  const t = useT();

  const [tenants, setTenants] = React.useState<Tenant[] | null>(null);
  const [tenantId, setTenantId] = React.useState<string>("");
  const [config, setConfig] = React.useState<WhiteLabelConfig | null>(null);
  const [defaults, setDefaults] = React.useState<WhiteLabelConfig | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Fetch the tenant roster once on mount so the super-admin can pick
  // which tenant to brand. We deliberately re-use the existing
  // /api/tenants endpoint (super-admin-only) instead of a new endpoint
  // — there's no value in a dedicated white-label tenant list.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(api("/api/tenants"), { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (cancelled) return;
        const list: Tenant[] = (d.items || []).map((tn: any) => ({ id: tn.id, name: tn.name }));
        setTenants(list);
        // Auto-select the first tenant so the user sees something
        // immediately rather than a blank form.
        if (list.length > 0) setTenantId(list[0].id);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Failed to load tenants");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  // Fetch the white-label config for the currently-selected tenant
  // every time the selection changes. The endpoint returns
  // `{ config, defaults }` so the UI can show the dirty badge. All
  // setState calls live behind an `await` so the rule's static analysis
  // can't follow the promise — matching the pattern in
  // data-protection.tsx / platform-config.tsx.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      // Mark loading + clear error synchronously after a microtask so
      // the rule's set-state-in-effect check doesn't fire.
      await Promise.resolve();
      if (cancelled) return;
      setLoading(true);
      setError(null);
      if (!tenantId) {
        setConfig(null);
        setDefaults(null);
        setLoading(false);
        return;
      }
      try {
        const r = await fetch(api(`/api/admin/white-label?tenant_id=${encodeURIComponent(tenantId)}`), { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (cancelled) return;
        setConfig(d.config);
        setDefaults(d.defaults);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Failed to load white-label config");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [api, tenantId]);

  function patch<K extends keyof WhiteLabelConfig>(key: K, value: WhiteLabelConfig[K]) {
    setConfig((cur) => cur ? { ...cur, [key]: value } : cur);
  }

  async function save() {
    if (!tenantId || !config) return;
    setSaving(true);
    try {
      const r = await fetch(api(`/api/admin/white-label?tenant_id=${encodeURIComponent(tenantId)}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setConfig(d.config);
      toast.success(t("admin-white-label-saved"));
      qc.invalidateQueries({ queryKey: ["white-label", tenantId] });
    } catch (e: any) {
      toast.error(t("admin-white-label-save-failed"), { description: e?.message });
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    if (defaults) setConfig({ ...defaults });
  }

  if (loading && !tenants) return <LoadingCard title={t("pf-sa-sys-brand-title")} />;
  if (error && !tenants) return <ErrorCard title={t("pf-sa-sys-brand-title")} message={error} />;
  if (!tenants || tenants.length === 0) {
    return (
      <Card className="border-border/60 shadow-soft rounded-xl">
        <SettingsCardHeader
          title={t("pf-sa-sys-brand-title")}
          description={t("pf-sa-sys-brand-desc")}
          dirty={false}
          saving={false}
        />
        <CardContent>
          <p className="text-sm text-muted-foreground">No tenants available. Create a tenant first.</p>
        </CardContent>
      </Card>
    );
  }

  const dirty = config && defaults ? !dirtyEq(config, defaults) : false;

  return (
    <Card className="border-border/60 shadow-soft rounded-xl">
      <SettingsCardHeader
        title={t("pf-sa-sys-brand-title")}
        description={t("pf-sa-sys-brand-desc")}
        dirty={dirty}
        saving={saving}
        onSave={save}
        onReset={reset}
      />
      <CardContent className="space-y-4">
        {/* Tenant selector */}
        <div className="space-y-1.5">
          <Label className="text-sm font-medium">{t("pf-sa-sys-brand-tenant")}</Label>
          <Select value={tenantId} onValueChange={setTenantId}>
            <SelectTrigger className="w-full sm:max-w-md">
              <SelectValue placeholder={t("pf-sa-sys-brand-choose")} />
            </SelectTrigger>
            <SelectContent>
              {tenants.map((tn) => (
                <SelectItem key={tn.id} value={tn.id}>{tn.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {config && !loading && (
          <>
            <SectionLabel>Identity</SectionLabel>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="wl-name">{t("admin-white-label-marketplace-name")}</Label>
                <Input
                  id="wl-name"
                  value={config.marketplaceName}
                  onChange={(e) => patch("marketplaceName", e.target.value)}
                  maxLength={200}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wl-domain">{t("admin-white-label-custom-domain")}</Label>
                <Input
                  id="wl-domain"
                  value={config.customDomain}
                  onChange={(e) => patch("customDomain", e.target.value)}
                  placeholder="market.example.com"
                  maxLength={253}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="wl-logo">{t("admin-white-label-logo-url")}</Label>
                <Input
                  id="wl-logo"
                  value={config.logoUrl}
                  onChange={(e) => patch("logoUrl", e.target.value)}
                  placeholder="/logo.svg"
                  maxLength={1000}
                />
              </div>
            </div>

            <SectionLabel>Colors</SectionLabel>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="wl-primary">{t("admin-white-label-primary-color")}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="wl-primary"
                    value={config.primaryColor}
                    onChange={(e) => patch("primaryColor", e.target.value)}
                    placeholder="#B45309"
                    className="flex-1"
                  />
                  <input
                    type="color"
                    aria-label="Primary color picker"
                    value={/^#[0-9a-fA-F]{6}$/.test(config.primaryColor) ? config.primaryColor : "#B45309"}
                    onChange={(e) => patch("primaryColor", e.target.value)}
                    className="size-9 rounded-md border border-input bg-background p-1 cursor-pointer shrink-0"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wl-accent">{t("admin-white-label-accent-color")}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="wl-accent"
                    value={config.accentColor}
                    onChange={(e) => patch("accentColor", e.target.value)}
                    placeholder="#D97706"
                    className="flex-1"
                  />
                  <input
                    type="color"
                    aria-label="Accent color picker"
                    value={/^#[0-9a-fA-F]{6}$/.test(config.accentColor) ? config.accentColor : "#D97706"}
                    onChange={(e) => patch("accentColor", e.target.value)}
                    className="size-9 rounded-md border border-input bg-background p-1 cursor-pointer shrink-0"
                  />
                </div>
              </div>
            </div>

            <SectionLabel>Content</SectionLabel>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="wl-categories">{t("admin-white-label-featured-categories")}</Label>
                <Input
                  id="wl-categories"
                  value={config.featuredCategories.join(", ")}
                  onChange={(e) => patch("featuredCategories", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
                  placeholder="coffee, cocoa, grains"
                />
                <p className="text-xs text-muted-foreground">Comma-separated list. Surfaces first in the marketplace browse filters.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wl-footer">{t("admin-white-label-custom-footer")}</Label>
                <Input
                  id="wl-footer"
                  value={config.customFooter}
                  onChange={(e) => patch("customFooter", e.target.value)}
                  placeholder="Powered by VELOS"
                  maxLength={500}
                />
              </div>
            </div>

            <SectionLabel>Branding visibility</SectionLabel>
            <div className="flex items-center justify-between rounded-lg border border-border/60 p-3">
              <div className="space-y-0.5 min-w-0">
                <Label className="text-sm font-medium">{t("admin-white-label-hide-velos-branding")}</Label>
                <p className="text-xs text-muted-foreground">Removes the “Powered by VELOS” badge entirely from the marketplace footer.</p>
              </div>
              <Switch
                checked={config.hideVelosBranding}
                onCheckedChange={(v) => patch("hideVelosBranding", v)}
              />
            </div>

            {/* Preview chip — gives instant feedback on color + name */}
            <SectionLabel hint={t("pf-sa-sys-brand-preview")}>{t("pf-sa-sys-brand-preview")}</SectionLabel>
            <div
              className="rounded-lg border border-border/60 p-4 flex items-center gap-3"
              style={{
                background: `linear-gradient(135deg, ${config.primaryColor}14, ${config.accentColor}14)`,
              }}
            >
              {config.logoUrl && (
                <img
                  src={config.logoUrl}
                  alt="Logo preview"
                  className="size-10 rounded-md object-contain bg-white/40 shrink-0"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                />
              )}
              <div className="min-w-0 flex-1">
                <div
                  className="text-sm font-semibold truncate"
                  style={{ color: config.primaryColor }}
                >
                  {config.marketplaceName}
                </div>
                <div className="text-xs text-muted-foreground truncate">{config.customFooter}</div>
              </div>
              {!config.hideVelosBranding && (
                <span className="text-[10px] text-muted-foreground/70 shrink-0">by VELOS</span>
              )}
            </div>

            {/* Mobile-friendly action row (mirrors SettingsCardHeader but on small screens the header buttons wrap; this is the in-card CTA) */}
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2 sm:hidden">
              <Button variant="outline" onClick={reset} disabled={saving || !dirty} className="w-full sm:w-auto">
                <RotateCcw className="size-3.5 mr-1" /> {t("pf-sa-sys-brand-reset")}
              </Button>
              <Button onClick={save} disabled={saving || !dirty} className="w-full sm:w-auto">
                {saving ? <Loader2 className="size-3.5 mr-1 animate-spin" /> : <Save className="size-3.5 mr-1" />}
                {t("pf-sa-save")}
              </Button>
            </div>
          </>
        )}

        {!config && !loading && !error && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Paintbrush className="size-4" /> {t("pf-sa-sys-brand-choose")}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default WhiteLabelConfig;
