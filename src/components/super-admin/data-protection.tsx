"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { RotateCw, Key, Database, Shield, FileCheck, Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import { useApiUrl } from "@/lib/hooks/use-api-url";
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "@/lib/i18n/store";
import {
  SettingsCardHeader, SectionLabel, SettingRow, LoadingCard, ErrorCard,
} from "./_shared";

interface DataProtectionData {
  vault: {
    current_version: string;
    total_secrets: number;
    legacy_count: number;
    by_version: Record<string, number>;
    needs_rotation: boolean;
  };
  encrypted_fields: Array<{
    category: string;
    field: string;
    description: string;
  }>;
  retention_policy: Array<{
    table: string;
    description: string;
    kind: "delete_after" | "delete_after_status" | "regulatory" | "indefinite";
    days?: number;
    column?: string;
    statusColumn?: string;
    statusValue?: string;
  }>;
  gdpr: {
    rightToErasure: boolean;
    dataExportEnabled: boolean;
    breachNotificationTracking: boolean;
    dpoEmail: string;
    dataResidency: string;
  };
  defaults: { gdpr: typeof DEFAULT_GDPR };
}

const DEFAULT_GDPR = {
  rightToErasure: true,
  dataExportEnabled: true,
  breachNotificationTracking: true,
  dpoEmail: "dpo@example.com",
  dataResidency: "EU",
};

const KIND_BADGE: Record<string, string> = {
  delete_after: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  delete_after_status: "bg-chart-4/15 text-chart-4 border-chart-4/30",
  regulatory: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
  indefinite: "bg-primary/10 text-primary border-primary/30",
};

export function DataProtection() {
  const api = useApiUrl();
  const qc = useQueryClient();
  const t = useT();

  const [data, setData] = React.useState<DataProtectionData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [rotateOpen, setRotateOpen] = React.useState(false);
  const [rotating, setRotating] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(api("/api/admin/data-protection"), { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setData(d);
    } catch (e: any) {
      setError(e?.message || "Failed to load data-protection");
    } finally {
      setLoading(false);
    }
  }, [api]);

  React.useEffect(() => { void load(); }, [load]);

  function patchGdpr<K extends keyof DataProtectionData["gdpr"]>(key: K, value: any) {
    setData((d) => d ? { ...d, gdpr: { ...d.gdpr, [key]: value } } : d);
  }

  const dirtyGdpr = data ? JSON.stringify(data.gdpr) !== JSON.stringify(data.defaults?.gdpr) : false;

  async function saveGdpr() {
    if (!data) return;
    setSaving(true);
    try {
      const r = await fetch(api("/api/admin/data-protection"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gdpr: data.gdpr }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setData((prev) => prev ? { ...prev, gdpr: d.gdpr } : prev);
      toast.success("GDPR settings saved");
      qc.invalidateQueries({ queryKey: ["data-protection"] });
    } catch (e: any) {
      toast.error("Failed to save GDPR settings", { description: e?.message });
    } finally {
      setSaving(false);
    }
  }

  async function rotateKeys() {
    setRotating(true);
    try {
      const r = await fetch(api("/api/admin/vault-management"), { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast.success("Vault rotation complete", {
        description: `${d.rotated} rotated, ${d.skipped} skipped, ${d.errors?.length || 0} errors`,
      });
      setRotateOpen(false);
      void load();
      qc.invalidateQueries({ queryKey: ["vault"] });
    } catch (e: any) {
      toast.error("Vault rotation failed", { description: e?.message });
    } finally {
      setRotating(false);
    }
  }

  if (loading) return <LoadingCard title={t("pf-sa-dp-title")} />;
  if (error || !data) return <ErrorCard title={t("pf-sa-dp-title")} message={error || "No data"} />;

  return (
    <div className="space-y-6">
      {/* Vault key management */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <SettingsCardHeader
          title={t("pf-sa-dp-vault-title")}
          description={`${t("pf-sa-dp-vault-desc")} Current key version: ${data.vault.current_version}. Set VAULT_KEY_VERSION in env first, deploy, then click Rotate.`}
          dirty={false}
          saving={rotating}
        />
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile label="Current Version" value={data.vault.current_version} tone="ok" />
            <Tile label="Total Secrets" value={String(data.vault.total_secrets)} tone="info" />
            <Tile
              label="On Legacy (no key_version)"
              value={String(data.vault.legacy_count)}
              tone={data.vault.legacy_count > 0 ? "warn" : "ok"}
            />
            <Tile
              label="Needs Rotation?"
              value={data.vault.needs_rotation ? "YES" : "NO"}
              tone={data.vault.needs_rotation ? "warn" : "ok"}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">{t("pf-sa-dp-vault-desc")}</p>

          {Object.keys(data.vault.by_version).length > 0 && (
            <div>
              <SectionLabel hint="rows per key version">Distribution</SectionLabel>
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.vault.by_version).map(([k, v]) => (
                  <Badge key={k} variant="outline" className="tabular">
                    v{k}: <span className="font-mono">{v}</span>
                  </Badge>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center justify-end">
            <Button onClick={() => setRotateOpen(true)} disabled={rotating}>
              <RotateCw className="size-4 mr-1.5" /> Rotate Vault Keys
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Encrypted fields */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <SettingsCardHeader
          title={t("pf-sa-dp-encrypted-title")}
          description={t("pf-sa-dp-encrypted-desc")}
          dirty={false}
          saving={false}
        />
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Category</TableHead>
                <TableHead>Field</TableHead>
                <TableHead>Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.encrypted_fields.map((f) => (
                <TableRow key={f.category}>
                  <TableCell>
                    <Badge variant="outline" className="capitalize text-xs">{f.category}</Badge>
                  </TableCell>
                  <TableCell>
                    <code className="text-[11px] font-mono">{f.field}</code>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{f.description}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Retention policy */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <SettingsCardHeader
          title={t("pf-sa-dp-retention-title")}
          description={t("pf-sa-dp-retention-desc")}
          dirty={false}
          saving={false}
        />
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Table</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Window</TableHead>
                <TableHead>Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.retention_policy.map((r) => (
                <TableRow key={r.table}>
                  <TableCell><code className="text-[11px] font-mono">{r.table}</code></TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`text-[10px] uppercase tracking-wider ${KIND_BADGE[r.kind] || ""}`}>
                      {r.kind}
                    </Badge>
                  </TableCell>
                  <TableCell className="tabular text-xs">
                    {r.kind === "delete_after" || r.kind === "delete_after_status"
                      ? `${r.days} days`
                      : r.kind === "regulatory"
                      ? `${Math.round((r.days || 0) / 365)} years (no auto-delete)`
                      : "lifetime of account"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.description}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* GDPR */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <SettingsCardHeader
          title={t("pf-sa-dp-gdpr-title")}
          description={t("pf-sa-dp-gdpr-desc")}
          dirty={!!dirtyGdpr}
          saving={saving}
          onSave={saveGdpr}
          onReset={() => data.defaults && setData((d) => d ? { ...d, gdpr: { ...d.defaults.gdpr } } : d)}
        />
        <CardContent className="space-y-3">
          <SettingRow
            label={t("pf-sa-dp-gdpr-erasure-label")}
            description={t("pf-sa-dp-gdpr-erasure-desc")}
            tooltip={t("pf-sa-dp-gdpr-erasure-desc")}
          >
            <Switch checked={data.gdpr.rightToErasure} onCheckedChange={(v) => patchGdpr("rightToErasure", v)} />
          </SettingRow>
          <SettingRow
            label={t("pf-sa-dp-gdpr-export-label")}
            description={t("pf-sa-dp-gdpr-export-desc")}
            tooltip={t("pf-sa-dp-gdpr-export-desc")}
          >
            <Switch checked={data.gdpr.dataExportEnabled} onCheckedChange={(v) => patchGdpr("dataExportEnabled", v)} />
          </SettingRow>
          <SettingRow
            label={t("pf-sa-dp-gdpr-breach-label")}
            description={t("pf-sa-dp-gdpr-breach-desc")}
            tooltip={t("pf-sa-dp-gdpr-breach-desc")}
          >
            <Switch checked={data.gdpr.breachNotificationTracking} onCheckedChange={(v) => patchGdpr("breachNotificationTracking", v)} />
          </SettingRow>
          <SettingRow
            label={t("pf-sa-dp-gdpr-dpo-label")}
            description={t("pf-sa-dp-gdpr-dpo-desc")}
            tooltip={t("pf-sa-dp-gdpr-dpo-desc")}
          >
            <Input value={data.gdpr.dpoEmail} onChange={(e) => patchGdpr("dpoEmail", e.target.value)} className="w-64" />
          </SettingRow>
          <SettingRow
            label={t("pf-sa-dp-gdpr-residency-label")}
            description={t("pf-sa-dp-gdpr-residency-desc")}
            tooltip={t("pf-sa-dp-gdpr-residency-desc")}
          >
            <Input value={data.gdpr.dataResidency} onChange={(e) => patchGdpr("dataResidency", e.target.value)} className="w-32" />
          </SettingRow>
        </CardContent>
      </Card>

      {/* Rotation confirmation dialog */}
      <Dialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rotate Vault Keys?</DialogTitle>
            <DialogDescription>
              This re-encrypts every <code>vault_secrets</code> row with the CURRENT key version
              (<code>{data.vault.current_version}</code>). If you haven't set the new VAULT_KEY_VERSION
              in env yet, this is a no-op. Legacy rows: <strong>{data.vault.legacy_count}</strong>.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRotateOpen(false)}>Cancel</Button>
            <Button onClick={rotateKeys} disabled={rotating} className="bg-gradient-emerald text-white">
              {rotating ? <Loader2 className="size-4 mr-1.5 animate-spin" /> : <RotateCw className="size-4 mr-1.5" />}
              Rotate Now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" | "info" | "critical" }) {
  const cls = {
    ok: "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400",
    warn: "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400",
    info: "border-primary/30 bg-primary/5",
    critical: "border-destructive/30 bg-destructive/5 text-destructive",
  }[tone];
  return (
    <div className={`rounded-xl border ${cls} p-3`}>
      <p className="text-[10px] uppercase tracking-wider opacity-70">{label}</p>
      <p className="text-xl font-bold tabular mt-1">{value}</p>
    </div>
  );
}
