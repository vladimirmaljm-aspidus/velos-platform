"use client";

import * as React from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ShieldCheck, Users, Lock, Activity, ShieldAlert, Gauge } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { useAppStore, isSuperAdmin } from "@/lib/store/app-store";
import { useT } from "@/lib/i18n/store";
import { SecuritySettings } from "@/components/super-admin/security-settings";
import { RoleManagement } from "@/components/super-admin/role-management";
import { DataProtection } from "@/components/super-admin/data-protection";
import { MonitoringSettings } from "@/components/super-admin/monitoring-settings";
import { IncidentManagement } from "@/components/super-admin/incident-management";
import { SystemHealth } from "@/components/super-admin/system-health";
import { PlatformConfig } from "@/components/super-admin/platform-config";
import { WhiteLabelConfig } from "@/components/super-admin/white-label-config";

/**
 * SuperAdminSettingsView — D-AUDIT-3 redesign.
 *
 * Six tabs (consolidated from the previous seven — "Platform Config"
 * and "System Health" merged into a single "System" tab).
 *
 *   1. Security            — login protection, session duration, 2FA info,
 *                            password requirements, CSRF info
 *   2. Access Control      — per-tenant role overrides, SoD matrix,
 *                            permission catalog (feature-flags moved here
 *                            conceptually; the underlying component is
 *                            rendered in the System tab alongside tenant
 *                            roster because both surface per-tenant data)
 *   3. Data Protection     — vault key mgmt, encrypted fields, retention,
 *                            GDPR compliance
 *   4. Monitoring & Alerts — Sentry status, security webhook, anomaly
 *                            thresholds, alert routing
 *   5. Incident Response   — security incident register + breach workflow
 *                            + runbooks
 *   6. System              — APM, memory, DB status, scheduled tasks,
 *                            tenant roster, feature flags per tenant,
 *                            plan mgmt
 *
 * The super-admin has NO limitations — every setting that exists on the
 * platform is visible and editable here (modulo the few that require an
 * env-var change — those are surfaced as read-only badges with a hint
 * about which env var to set).
 *
 * Every label, description, impact line, tooltip, and section header is
 * i18n-keyed via the `pf-sa-*` namespace in
 * `src/lib/i18n/domains/platform.ts`. Five locales (en, sr, tr, de, ru)
 * are shipped. Missing keys fall back to English.
 */
export function SuperAdminSettingsView() {
  const t = useT();
  const user = useAppStore((s) => s.user);
  const isSuper = isSuperAdmin(user);

  if (!isSuper) {
    return (
      <div>
        <PageHeader
          title={t("pf-sa-title")}
          description={t("pf-sa-desc")}
        />
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-6 text-amber-800 dark:text-amber-300">
          <div className="flex items-center gap-3">
            <ShieldAlert className="size-5 shrink-0" />
            <div>
              <p className="font-medium">{t("pf-sa-access-required")}</p>
              <p className="text-sm mt-1 opacity-80">{t("pf-sa-access-desc")}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t("pf-sa-title")}
        description={t("pf-sa-desc")}
      />

      <Tabs defaultValue="security" className="w-full">
        <TabsList className="flex flex-wrap h-auto bg-muted/40 p-1 rounded-xl gap-1 mb-6">
          <TabTrigger value="security" icon={ShieldCheck} label={t("pf-sa-tab-security")} />
          <TabTrigger value="access" icon={Users} label={t("pf-sa-tab-access")} />
          <TabTrigger value="data" icon={Lock} label={t("pf-sa-tab-data")} />
          <TabTrigger value="monitoring" icon={Activity} label={t("pf-sa-tab-monitoring")} />
          <TabTrigger value="incidents" icon={ShieldAlert} label={t("pf-sa-tab-incidents")} />
          <TabTrigger value="system" icon={Gauge} label={t("pf-sa-tab-system")} />
        </TabsList>

        <TabsContent value="security" className="mt-0">
          <SecuritySettings />
        </TabsContent>
        <TabsContent value="access" className="mt-0">
          <RoleManagement />
        </TabsContent>
        <TabsContent value="data" className="mt-0">
          <DataProtection />
        </TabsContent>
        <TabsContent value="monitoring" className="mt-0">
          <MonitoringSettings />
        </TabsContent>
        <TabsContent value="incidents" className="mt-0">
          <IncidentManagement />
        </TabsContent>
        <TabsContent value="system" className="mt-0">
          {/* D-AUDIT-3: consolidated — tenant roster + feature flags
              (formerly the "Platform" tab) now live alongside the
              system-health metrics. Both surface per-instance + per-tenant
              operational state, so they belong together.
              UI-SUPER-AUDIT: white-label config card added on top so
              super-admins can finally set per-tenant branding without
              hitting the API directly. */}
          <div className="space-y-6">
            <WhiteLabelConfig />
            <SystemHealth />
            <PlatformConfig />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function TabTrigger({
  value, icon: Icon, label,
}: {
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <TabsTrigger
      value={value}
      className="data-[state=active]:bg-gradient-emerald data-[state=active]:text-white data-[state=active]:shadow-soft rounded-lg px-3 py-1.5 text-xs font-medium flex items-center gap-1.5 transition-all"
    >
      <Icon className="size-3.5" />
      {label}
    </TabsTrigger>
  );
}

export default SuperAdminSettingsView;
