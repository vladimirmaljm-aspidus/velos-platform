"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Plus, Search, KeyRound, Pencil, Trash2, Lock, ShieldCheck, ShieldAlert, EyeOff, Eye, Database, Mail, CreditCard, Box,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { ModuleInfoTooltip } from "@/components/common/module-info-tooltip";

import { EmptyState } from "@/components/common/empty-state";
import { fmtRelative } from "@/lib/utils/format";
import { useAppStore, isAdmin } from "@/lib/store/app-store";
import type { VaultSecret } from "@/lib/supabase/types";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { useT } from "@/lib/i18n/store";

type SecretCategory = VaultSecret["category"];
type SafeSecret = Omit<VaultSecret, "encrypted_value">;

const CATEGORY_META: Record<SecretCategory, { labelKey: string; icon: typeof KeyRound; className: string }> = {
  api: { labelKey: "admin-vault-cat-api", icon: KeyRound, className: "bg-[var(--chart-1)] text-white" },
  smtp: { labelKey: "admin-vault-cat-smtp", icon: Mail, className: "bg-[var(--chart-4)] text-black" },
  database: { labelKey: "admin-vault-cat-database", icon: Database, className: "bg-[var(--chart-3)] text-black" },
  payment: { labelKey: "admin-vault-cat-payment", icon: CreditCard, className: "bg-emerald-600 text-white" },
  other: { labelKey: "admin-vault-cat-other", icon: Box, className: "bg-secondary text-secondary-foreground" },
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
            {t("admin-vault-admin-only-desc")}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function VaultView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const user = useAppStore((s) => s.user);
  const admin = isAdmin(user);
  const isSuperAdminUser = !!user && user.role === "super_admin";

  // ── Plan gate — TRIAL tenants do NOT get the vault. ─────────────────────
  // The vault stores AES-256-GCM-encrypted tenant secrets (SMTP creds,
  // payment gateway keys, DB DSNs). A trial tenant with vault access is
  // a security risk: trial accounts can be farmed to probe the platform's
  // secret-storage surface for 14 days before anyone notices. The sidebar
  // ALREADY hides this item via the `module_vault` feature flag (default
  // false for every new tenant) AND `/api/vault` enforces the flag
  // server-side via `requireFeature(..., "module_vault", isSA)` — this
  // is the in-view defense for the direct-URL navigation case so a trial
  // admin sees a clean "upgrade your plan" card instead of a fetch error.
  // Mirrors the `planAllowed` gate on api-keys-view.tsx and
  // webhooks-view.tsx.
  const subQ = useQuery({
    queryKey: ["subscription-status-vault"],
    queryFn: async () => {
      const r = await fetch("/api/subscription/status");
      if (!r.ok) return null;
      return r.json() as Promise<{
        subscription: { is_trial?: boolean } | null;
      }>;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  const isTrial = !!subQ.data?.subscription?.is_trial;
  const planAllowed = isSuperAdminUser || !isTrial;

  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [category, setCategory] = useState<string>("all");
  const [editing, setEditing] = useState<SafeSecret | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // ── Reveal state ───────────────────────────────────────────────────────
  // Tracks which vault rows currently have their decrypted value visible.
  // The value is fetched on demand from /api/vault/[id]?reveal=true and is
  // auto-hidden after 30s — defense in depth so a stray tab left open on
  // the vault view doesn't keep the plaintext on-screen indefinitely.
  // Loading state is tracked so the eye icon can show a "decrypting…"
  // affordance while the API round-trips.
  const [revealed, setRevealed] = useState<Record<string, { value: string; loading: boolean; revealedAt: number } | undefined>>({});
  const revealTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [revealTick, setRevealTick] = useState(0); // forces re-render so the "auto-hides in Xs" countdown updates

  const REVEAL_AUTO_HIDE_MS = 30_000;

  const revealSecret = useCallback(async (id: string) => {
    setRevealed((cur) => ({ ...cur, [id]: { value: "", loading: true, revealedAt: Date.now() } }));
    try {
      const r = await fetch(api(`/api/vault/${id}?reveal=true`));
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || t("admin-vault-reveal-failed"));
      }
      const data = await r.json();
      const value = typeof data?.encrypted_value === "string" ? data.encrypted_value : "";
      setRevealed((cur) => ({ ...cur, [id]: { value, loading: false, revealedAt: Date.now() } }));
      // Auto-hide after 30s.
      if (revealTimersRef.current[id]) clearTimeout(revealTimersRef.current[id]);
      revealTimersRef.current[id] = setTimeout(() => {
        setRevealed((cur) => {
          const next = { ...cur };
          delete next[id];
          return next;
        });
        delete revealTimersRef.current[id];
      }, REVEAL_AUTO_HIDE_MS);
      // The reveal API updates `last_accessed_at` server-side; refresh the
      // list so the column reflects the new timestamp.
      qc.invalidateQueries({ queryKey: ["vault", tenantKey] });
    } catch (e: unknown) {
      setRevealed((cur) => {
        const next = { ...cur };
        delete next[id];
        return next;
      });
      const msg = e instanceof Error ? e.message : t("admin-vault-reveal-failed");
      toast.error(msg);
    }
  }, [api, t, qc, tenantKey]);

  const hideSecret = useCallback((id: string) => {
    setRevealed((cur) => {
      const next = { ...cur };
      delete next[id];
      return next;
    });
    if (revealTimersRef.current[id]) {
      clearTimeout(revealTimersRef.current[id]);
      delete revealTimersRef.current[id];
    }
  }, []);

  // Ticking countdown for the "auto-hides in Xs" affordance. We re-render
  // every second while ANY secret is revealed so the remaining-time label
  // stays accurate. Stops when nothing is revealed.
  useEffect(() => {
    if (Object.keys(revealed).length === 0) return;
    const interval = setInterval(() => setRevealTick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, [revealed]);

  // Clear any pending auto-hide timers on unmount so we don't try to
  // setState on an unmounted component (React would warn).
  useEffect(() => {
    const timers = revealTimersRef.current;
    return () => {
      Object.values(timers).forEach((tm) => clearTimeout(tm));
    };
  }, []);

  // Reference revealTick so the linter doesn't flag it as unused — its
  // sole purpose is to force a re-render every second while any secret
  // is revealed, which keeps the per-row "auto-hides in Xs" countdown
  // accurate. Computed remaining seconds are read off `revealedAt`.
  void revealTick;

  const { data, isLoading } = useQuery({
    queryKey: ["vault", tenantKey, debouncedSearch, category],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (category !== "all") params.set("category", category);
      const r = await fetch(api(`/api/vault?${params}`));
      if (!r.ok) throw new Error("Failed to load vault");
      return r.json() as Promise<{ items: SafeSecret[]; total: number }>;
    },
    enabled: admin && planAllowed,
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/vault/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error(t("admin-vault-delete-failed-toast"));
    },
    onSuccess: () => {
      toast.success(t("admin-vault-deleted-toast"));
      qc.invalidateQueries({ queryKey: ["vault", tenantKey] });
      setDeleteId(null);
    },
    onError: () => toast.error(t("admin-vault-delete-failed-toast")),
  });

  if (!admin) {
    return (
      <div>
        <PageHeader title={t("admin-vault-title")} description={t("admin-vault-desc")} />
        <AdminRequired />
      </div>
    );
  }

  if (!planAllowed) {
    return (
      <div>
        <PageHeader title={t("admin-vault-title")} description={t("admin-vault-desc")} />
        <Card className="border-amber-500/40 bg-amber-50/50 dark:bg-amber-950/20 rounded-xl">
          <CardContent className="p-6 flex items-start gap-3">
            <ShieldAlert className="size-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                {t("admin-access-required")}
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                The encrypted vault is a paid-plan integration surface and
                is not available during the trial. Upgrade your workspace to
                store SMTP, payment-gateway, and database secrets securely.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const items = data?.items || [];
  const total = data?.total ?? 0;

  return (
    <div>
      <PageHeader
        title={t("admin-vault-title")}
        description={`${total} ${t("admin-vault-count-suffix")}`}
        actions={
          <Button onClick={() => { setEditing(null); setShowForm(true); }}>
            <Plus className="size-4 mr-1" /> {t("admin-vault-new-secret")}
          </Button>
        }
      />
      <ModuleInfoTooltip
        title="Vault"
        description="Securely store encrypted secrets (API keys, passwords, certificates) with audit-tracked access."
        howToUse={["Add a secret with a key, value, and description", "Secrets are AES-256-GCM encrypted at rest", "Click the eye icon to reveal a value (auto-hides after 30s)", "Every reveal is audit-logged", "Secrets are tenant-scoped"]}
      />

      <Card className="mb-4 border-amber-200 bg-amber-50/50 dark:bg-amber-950/10">
        <CardContent className="p-4 flex items-start gap-3">
          <ShieldCheck className="size-5 text-amber-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">{t("admin-vault-encrypted-at-rest")}</p>
            <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
              {t("admin-vault-encrypted-desc")}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardContent className="p-3 flex flex-col md:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder={t("admin-vault-search-placeholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="w-full md:w-44"><SelectValue placeholder={t("admin-vault-category")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("admin-vault-all-categories")}</SelectItem>
              <SelectItem value="api">{t("admin-vault-cat-api")}</SelectItem>
              <SelectItem value="smtp">{t("admin-vault-cat-smtp")}</SelectItem>
              <SelectItem value="database">{t("admin-vault-cat-database")}</SelectItem>
              <SelectItem value="payment">{t("admin-vault-cat-payment")}</SelectItem>
              <SelectItem value="other">{t("admin-vault-cat-other")}</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card className="border-border/60 shadow-soft">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<KeyRound className="size-6" />}
              title={t("admin-vault-empty-title")}
              description={t("admin-vault-empty-desc")}
              action={
                <Button onClick={() => { setEditing(null); setShowForm(true); }}>
                  <Plus className="size-4 mr-1" /> {t("admin-vault-new-secret")}
                </Button>
              }
            />
          ) : (
            <div className="max-h-[calc(100vh-380px)] overflow-y-auto custom-scroll">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead>{t("admin-col-key")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("description")}</TableHead>
                    <TableHead>{t("admin-vault-category")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t("admin-vault-col-last-accessed")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("admin-vault-col-updated")}</TableHead>
                    <TableHead className="text-right">{t("admin-col-actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((s) => {
                    const meta = CATEGORY_META[s.category];
                    const Icon = meta.icon;
                    const revealState = revealed[s.id];
                    const isRevealed = !!revealState && !revealState.loading;
                    const remainingSec = isRevealed
                      ? Math.max(0, Math.ceil((REVEAL_AUTO_HIDE_MS - (Date.now() - revealState.revealedAt)) / 1000))
                      : 0;
                    return (
                      <TableRow key={s.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <EyeOff className="size-3.5 text-muted-foreground shrink-0" />
                            <code className="text-sm font-semibold font-mono">{s.key}</code>
                          </div>
                          {revealState && (
                            <div className="mt-1.5 rounded-md border border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/10 px-2 py-1.5">
                              {revealState.loading ? (
                                <p className="text-xs text-amber-700 dark:text-amber-300">{t("admin-vault-reveal-loading")}</p>
                              ) : (
                                <div className="space-y-1">
                                  <code className="block font-mono text-sm text-amber-900 dark:text-amber-100 break-all whitespace-pre-wrap">
                                    {revealState.value || "—"}
                                  </code>
                                  <p className="text-[10px] text-amber-600 dark:text-amber-400">
                                    {t("admin-vault-reveal-timer").replace("{s}", String(remainingSec))}
                                  </p>
                                </div>
                              )}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                          {s.description || "—"}
                        </TableCell>
                        <TableCell>
                          <Badge className={meta.className + " gap-1"}>
                            <Icon className="size-3" /> {t(meta.labelKey)}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell text-xs">{fmtRelative(s.last_accessed_at)}</TableCell>
                        <TableCell className="hidden md:table-cell text-xs">{fmtRelative(s.updated_at)}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {isRevealed ? (
                              <Button
                                size="icon"
                                variant="ghost"
                                className="size-8"
                                onClick={() => hideSecret(s.id)}
                                title={t("admin-vault-hide")}
                                aria-label={t("admin-vault-hide")}
                              >
                                <EyeOff className="size-4" />
                              </Button>
                            ) : (
                              <Button
                                size="icon"
                                variant="ghost"
                                className="size-8"
                                onClick={() => revealSecret(s.id)}
                                title={t("admin-vault-reveal")}
                                aria-label={t("admin-vault-reveal")}
                                disabled={!!revealState?.loading}
                              >
                                <Eye className="size-4" />
                              </Button>
                            )}
                            <Button size="icon" variant="ghost" className="size-8" onClick={() => { setEditing(s); setShowForm(true); }} title={t("edit")} aria-label={t("edit")}>
                              <Pencil className="size-4" />
                            </Button>
                            <Button size="icon" variant="ghost" className="size-8 text-destructive" onClick={() => setDeleteId(s.id)} title={t("delete")} aria-label={t("delete")}>
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <VaultFormDialog
        open={showForm}
        onOpenChange={setShowForm}
        secret={editing}
        onSaved={() => {
          setShowForm(false);
          qc.invalidateQueries({ queryKey: ["vault", tenantKey] });
        }}
      />

      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("admin-vault-delete-title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("admin-vault-delete-desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && deleteMut.mutate(deleteId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---- Create/Edit dialog ----
function VaultFormDialog({
  open, onOpenChange, secret, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  secret: SafeSecret | null;
  onSaved: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [cat, setCat] = useState<SecretCategory>("api");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (secret) {
// eslint-disable-next-line react-hooks/set-state-in-effect
      setKey(secret.key);
      setDescription(secret.description || "");
      setCat(secret.category);
      setValue("");
    } else {
      setKey("");
      setDescription("");
      setCat("api");
      setValue("");
    }
  }, [open, secret]);

  async function save() {
    if (!key.trim()) { toast.error(t("admin-vault-key-required")); return; }
    if (!secret && !value) { toast.error(t("admin-vault-value-required")); return; }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        key: key.trim(),
        description: description.trim() || null,
        category: cat,
      };
      if (secret) body.id = secret.id;
      if (value) body.encrypted_value = value;
      const r = await fetch(api("/api/vault"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || t("admin-vault-save-failed"));
      }
      toast.success(secret ? t("admin-vault-updated-toast") : t("admin-vault-created-toast"));
      onSaved();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t("admin-vault-save-failed");
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>{secret ? t("admin-vault-edit-title") : t("admin-vault-new-secret")}</DialogTitle>
          <DialogDescription>
            {secret
              ? t("admin-vault-edit-desc")
              : t("admin-vault-new-desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <Label>{t("admin-col-key")} *</Label>
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="STRIPE_SECRET_KEY"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">{t("admin-vault-form-key-help")}</p>
          </div>

          <div className="space-y-1.5">
            <Label>{t("description")}</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Stripe production secret key"
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t("admin-vault-category")}</Label>
            <Select value={cat} onValueChange={(v) => setCat(v as SecretCategory)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="api">{t("admin-vault-cat-api")}</SelectItem>
                <SelectItem value="smtp">{t("admin-vault-cat-smtp")}</SelectItem>
                <SelectItem value="database">{t("admin-vault-cat-database")}</SelectItem>
                <SelectItem value="payment">{t("admin-vault-cat-payment")}</SelectItem>
                <SelectItem value="other">{t("admin-vault-cat-other")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>{secret ? t("admin-vault-form-new-value") : `${t("admin-vault-form-value")} *`}</Label>
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={4}
              placeholder="sk_live_…"
              className="font-mono [-webkit-text-security:disc]"
            />
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Lock className="size-3" />
              {t("admin-vault-form-value-help")}
            </p>
          </div>
        </div>
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? t("admin-saving") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
