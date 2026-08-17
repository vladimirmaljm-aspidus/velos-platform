"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, CardContent,
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
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Plus, KeyRound, Trash2, Lock, ShieldAlert, Copy, Check, AlertTriangle, Calendar,
  Zap, Shield, Eye, BookOpen, Banknote, Truck,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { fmtRelative, fmtDate } from "@/lib/utils/format";
import { useAppStore, isAdmin } from "@/lib/store/app-store";
import type { ApiKey } from "@/lib/supabase/types";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useT } from "@/lib/i18n/store";

type SafeApiKey = Omit<ApiKey, "key_hash">;

// --- Permission presets with icons and descriptions in user-friendly language ---
// `labelKey` and `descKey` are translated via t() at render time.
const PERMISSION_PRESETS: Record<string, {
  labelKey: string;
  descKey: string;
  icon: React.ReactNode;
  perms: string[];
  color: string;
}> = {
  full_access: {
    labelKey: "admin-api-keys-preset-full",
    descKey: "admin-api-keys-preset-full-desc",
    icon: <Zap className="size-5" />,
    perms: ["*"],
    color: "bg-amber-50 border-amber-300 text-amber-900 dark:bg-amber-950/30 dark:border-amber-700 dark:text-amber-200",
  },
  read_only: {
    labelKey: "admin-api-keys-preset-readonly",
    descKey: "admin-api-keys-preset-readonly-desc",
    icon: <Eye className="size-5" />,
    perms: ["partners:read", "products:read", "offers:read", "deals:read", "invoices:read", "proformas:read", "documents:read"],
    color: "bg-blue-50 border-blue-300 text-blue-900 dark:bg-blue-950/30 dark:border-blue-700 dark:text-blue-200",
  },
  sales: {
    labelKey: "admin-api-keys-preset-sales",
    descKey: "admin-api-keys-preset-sales-desc",
    icon: <BookOpen className="size-5" />,
    perms: ["partners:*", "offers:*", "deals:*", "products:read"],
    color: "bg-emerald-50 border-emerald-300 text-emerald-900 dark:bg-emerald-950/30 dark:border-emerald-700 dark:text-emerald-200",
  },
  finance: {
    labelKey: "admin-api-keys-preset-finance",
    descKey: "admin-api-keys-preset-finance-desc",
    icon: <Banknote className="size-5" />,
    perms: ["invoices:*", "proformas:*", "erp:*", "partners:read", "offers:read"],
    color: "bg-violet-50 border-violet-300 text-violet-900 dark:bg-violet-950/30 dark:border-violet-700 dark:text-violet-200",
  },
  logistics: {
    labelKey: "admin-api-keys-preset-logistics",
    descKey: "admin-api-keys-preset-logistics-desc",
    icon: <Truck className="size-5" />,
    perms: ["inventory:*", "documents:*", "products:read", "partners:read"],
    color: "bg-orange-50 border-orange-300 text-orange-900 dark:bg-orange-950/30 dark:border-orange-700 dark:text-orange-200",
  },
  api_tester: {
    labelKey: "admin-api-keys-preset-tester",
    descKey: "admin-api-keys-preset-tester-desc",
    icon: <Shield className="size-5" />,
    perms: ["partners:read", "products:read", "offers:read", "deals:read"],
    color: "bg-slate-50 border-slate-300 text-slate-900 dark:bg-slate-950/30 dark:border-slate-700 dark:text-slate-200",
  },
};

function AdminRequired() {
  const t = useT();
  return (
    <Card className="border-amber-200 bg-amber-50/50 dark:bg-amber-950/10">
      <CardContent className="p-6 flex items-start gap-3">
        <Lock className="size-5 text-amber-600 mt-0.5 shrink-0" />
        <div>
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">{t("admin-access-required")}</p>
          <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
            {t("admin-api-keys-admin-only-desc")}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function ApiKeysView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const user = useAppStore((s) => s.user);
  const admin = isAdmin(user);
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["api-keys", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/api-keys"));
      if (!r.ok) throw new Error("Neuspešno učitavanje API ključeva");
      return r.json() as Promise<{ items: SafeApiKey[] }>;
    },
    enabled: admin,
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/api-keys/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error("Neuspešno brisanje ključa");
    },
    onSuccess: () => {
      toast.success("API ključ je opozvan.");
      qc.invalidateQueries({ queryKey: ["api-keys", tenantKey] });
      setDeleteId(null);
    },
    onError: () => toast.error("Neuspešno brisanje ključa."),
  });

  if (!admin) {
    return (
      <div>
        <PageHeader title={t("api-keys")} description={t("admin-api-keys-desc")} />
        <AdminRequired />
      </div>
    );
  }

  const items = data?.items || [];

  return (
    <div>
      <PageHeader
        title={t("api-keys")}
        description={`${items.length} ${t("admin-api-keys-count")}`}
        actions={
          <Button onClick={() => setShowForm(true)}>
            <Plus className="size-4 mr-1" /> {t("admin-api-keys-new")}
          </Button>
        }
      />

      <Card className="mb-4 border-amber-200 bg-amber-50/50 dark:bg-amber-950/10">
        <CardContent className="p-4 flex items-start gap-3">
          <ShieldAlert className="size-5 text-amber-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">{t("admin-api-keys-keep-safe")}</p>
            <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
              {t("admin-api-keys-keep-safe-desc")}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/60 shadow-soft">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<KeyRound className="size-6" />}
              title={t("admin-api-keys-empty-title")}
              description={t("admin-api-keys-empty-desc")}
              action={
                <Button onClick={() => setShowForm(true)}>
                  <Plus className="size-4 mr-1" /> {t("admin-api-keys-new")}
                </Button>
              }
            />
          ) : (
            <div className="max-h-[calc(100vh-320px)] overflow-y-auto custom-scroll">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead>{t("admin-col-name")}</TableHead>
                    <TableHead>{t("admin-col-key")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t("admin-col-permissions")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("admin-col-last-used")}</TableHead>
                    <TableHead>{t("admin-col-status")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t("admin-col-expires")}</TableHead>
                    <TableHead className="text-right">{t("admin-col-actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((k) => (
                    <TableRow key={k.id}>
                      <TableCell className="font-medium">{k.name}</TableCell>
                      <TableCell>
                        <code className="text-xs font-mono tabular bg-muted px-1.5 py-0.5 rounded">{k.key_prefix}…</code>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <div className="flex flex-wrap gap-1 max-w-[260px]">
                          {k.permissions && k.permissions.length > 0 ? (
                            k.permissions.map((p) => (
                              <Badge key={p} variant="secondary" className="text-[10px]">{p}</Badge>
                            ))
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs">{fmtRelative(k.last_used_at)}</TableCell>
                      <TableCell>
                        {k.active ? (
                          <Badge className="bg-emerald-600 text-white">{t("admin-active-badge")}</Badge>
                        ) : (
                          <Badge variant="secondary">{t("admin-inactive-badge")}</Badge>
                        )}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-xs">
                        {k.expires_at ? fmtDate(k.expires_at) : t("admin-never")}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-8 text-destructive"
                          onClick={() => setDeleteId(k.id)}
                          title={t("admin-revoke")} aria-label={t("admin-revoke")}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <CreateKeyDialog
        open={showForm}
        onOpenChange={setShowForm}
        onCreated={(fullKey) => {
          setShowForm(false);
          setNewKey(fullKey);
          qc.invalidateQueries({ queryKey: ["api-keys", tenantKey] });
        }}
      />

      <KeyRevealDialog
        fullKey={newKey}
        onClose={() => setNewKey(null)}
      />

      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("admin-api-keys-revoke-confirm")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("admin-api-keys-revoke-desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && deleteMut.mutate(deleteId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("admin-revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---- Create dialog - simplified with visual preset selection ----
function CreateKeyDialog({
  open, onOpenChange, onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (fullKey: string) => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [name, setName] = useState("");
  const [selectedPreset, setSelectedPreset] = useState<string>("");
  const [expiresAt, setExpiresAt] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setName("");
      setSelectedPreset("");
      setExpiresAt("");
    }
  }, [open]);

  // Get the permissions for the selected preset
  const permissions = selectedPreset && PERMISSION_PRESETS[selectedPreset]
    ? PERMISSION_PRESETS[selectedPreset].perms
    : [];

  async function save() {
    if (!name.trim()) { toast.error("Naziv je obavezan."); return; }
    if (!selectedPreset) { toast.error("Izaberite nivo pristupa."); return; }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        permissions,
        active: true,
      };
      if (expiresAt) body.expires_at = new Date(expiresAt).toISOString();
      const r = await fetch(api("/api/api-keys"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Neuspešno kreiranje ključa");
      }
      const data = await r.json();
      if (!data.full_key) throw new Error("Server nije vratio ključ.");
      toast.success("API ključ kreiran!");
      onCreated(data.full_key as string);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Neuspešno kreiranje ključa";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-5" />
            {t("admin-api-keys-new")}
          </DialogTitle>
          <DialogDescription>
            {t("admin-api-keys-create-desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 py-2">
          {/* Name */}
          <div className="space-y-1.5">
            <Label>{t("admin-api-keys-name-label")}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("admin-api-keys-name-placeholder")}
            />
            <p className="text-xs text-muted-foreground">{t("admin-api-keys-name-help")}</p>
          </div>

          {/* Access Level - Visual Cards */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t("admin-api-keys-access-level")}</Label>
            <p className="text-xs text-muted-foreground">{t("admin-api-keys-access-level-help")}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {Object.entries(PERMISSION_PRESETS).map(([key, preset]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedPreset(key)}
                  className={`text-left p-4 rounded-xl border-2 transition-all ${
                    selectedPreset === key
                      ? "ring-2 ring-primary ring-offset-2 " + preset.color
                      : "border-border hover:border-primary/30 bg-background"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <div className={`shrink-0 ${selectedPreset === key ? "text-primary" : "text-muted-foreground"}`}>
                      {preset.icon}
                    </div>
                    <span className="font-semibold text-sm">{t(preset.labelKey)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">{t(preset.descKey)}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Expires */}
          <div className="space-y-1.5">
            <Label>{t("admin-api-keys-expiry-label")}</Label>
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="pl-9"
              />
            </div>
            <p className="text-xs text-muted-foreground">{t("admin-api-keys-expiry-help")}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={save} disabled={saving || !name.trim() || !selectedPreset}>
            {saving ? t("admin-api-keys-generating") : t("admin-api-keys-generate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- One-time key reveal dialog ----
function KeyRevealDialog({ fullKey, onClose }: { fullKey: string | null; onClose: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(fullKey || "");
      setCopied(true);
      toast.success("Ključ kopiran u clipboard.");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Clipboard nije dostupan. Kopirajte ručno.");
    }
  }

  return (
    <Dialog open={!!fullKey} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-amber-600" />
            {t("admin-api-keys-copy-title")}
          </DialogTitle>
          <DialogDescription>
            {t("admin-api-keys-copy-desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="py-2 space-y-3">
          <div className="rounded-md border border-border/60 bg-muted/50 p-3">
            <code className="text-xs font-mono break-all block text-foreground">{fullKey}</code>
          </div>

          <Button onClick={copy} variant="outline" className="w-full">
            {copied ? <Check className="size-4 mr-1 text-emerald-600" /> : <Copy className="size-4 mr-1" />}
            {copied ? t("admin-api-keys-copied") : t("admin-api-keys-copy")}
          </Button>

          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
            <Lock className="size-3 mt-0.5 shrink-0" />
            {t("admin-api-keys-treat-as-password")}
          </p>
        </div>

        <DialogFooter>
          <Button onClick={onClose}>{t("admin-api-keys-saved-key")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
