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
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Plus, Search, Mail, Trash2, Eye, Lock, Inbox, CheckCircle2, XCircle, Clock, Loader2, Send, RotateCcw, AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { KpiCard } from "@/components/common/kpi-card";
import { EmptyState } from "@/components/common/empty-state";
import { fmtRelative, fmtDateTime } from "@/lib/utils/format";
import { useAppStore, isSuperAdmin } from "@/lib/store/app-store";
import type { MailQueueEntry, MailStatus } from "@/lib/supabase/types";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { useT } from "@/lib/i18n/store";

const STATUS_META: Record<MailStatus, { labelKey: string; className: string; icon: typeof Clock }> = {
  queued: { labelKey: "admin-mail-queued", className: "bg-[var(--chart-4)] text-black", icon: Clock },
  sending: { labelKey: "admin-mail-sending", className: "bg-[var(--chart-1)] text-white", icon: Loader2 },
  sent: { labelKey: "admin-mail-sent", className: "bg-emerald-600 text-white", icon: CheckCircle2 },
  failed: { labelKey: "admin-failed", className: "bg-destructive text-white", icon: XCircle },
};

function SuperAdminRequired() {
  const t = useT();
  return (
    <Card className="border-amber-200 bg-amber-50/50 dark:bg-amber-950/10">
      <CardContent className="p-6 flex items-start gap-3">
        <Lock className="size-5 text-amber-600 mt-0.5 shrink-0" />
        <div>
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">{t("admin-access-required")}</p>
          <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
            {t("admin-mail-admin-only-desc")}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function MailQueueView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const user = useAppStore((s) => s.user);
  // SUPER-ADMIN ONLY — the mail queue is a PLATFORM-level concern
  // (cross-tenant delivery observability, system-wide bounce/retry
  // surface). Tenant admins — including trial tenants whose
  // `isAdmin()` returns true via the role check — must not see it.
  const superAdmin = isSuperAdmin(user);
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [status, setStatus] = useState<string>("all");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showCompose, setShowCompose] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["mail-queue", tenantKey, debouncedSearch, status],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (status !== "all") params.set("status", status);
      const r = await fetch(api(`/api/mail-queue?${params}`));
      if (!r.ok) throw new Error("Failed to load mail queue");
      return r.json() as Promise<{ items: MailQueueEntry[]; total: number }>;
    },
    enabled: superAdmin,
  });

  const retryMut = useMutation({
    mutationFn: async (entry: MailQueueEntry) => {
      // FIX (audit P3-3): use the dedicated /retry endpoint instead of
      // upserting via POST /api/mail-queue. The /retry endpoint handles
      // attempt counting, status transitions, and audit logging correctly.
      const r = await fetch(api(`/api/mail-queue/${entry.id}/retry`), {
        method: "POST",
      });
      if (!r.ok) throw new Error(t("admin-mail-retry-failed-toast"));
    },
    onSuccess: () => {
      toast.success(t("admin-mail-retry-toast"));
      qc.invalidateQueries({ queryKey: ["mail-queue", tenantKey] });
    },
    onError: () => toast.error(t("admin-mail-retry-failed-toast")),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/mail-queue/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error(t("admin-mail-delete-failed-toast"));
    },
    onSuccess: () => {
      toast.success(t("admin-mail-deleted-toast"));
      qc.invalidateQueries({ queryKey: ["mail-queue", tenantKey] });
      setDeleteId(null);
    },
    onError: () => toast.error(t("admin-mail-delete-failed-toast")),
  });

  if (!superAdmin) {
    return (
      <div>
        <PageHeader title={t("admin-mail-title")} description={t("admin-mail-desc")} />
        <SuperAdminRequired />
      </div>
    );
  }

  const items = data?.items || [];
  const total = data?.total ?? 0;
  const queued = items.filter((m) => m.status === "queued").length;
  const sent24h = items.filter((m) => {
    if (m.status !== "sent" || !m.sent_at) return false;
    return Date.now() - new Date(m.sent_at).getTime() < 24 * 3600 * 1000;
  }).length;
  const failed = items.filter((m) => m.status === "failed").length;

  const detailItem = detailId ? items.find((m) => m.id === detailId) || null : null;

  return (
    <div>
      <PageHeader
        title={t("admin-mail-title")}
        description={t("admin-mail-desc")}
        actions={
          <Button onClick={() => setShowCompose(true)}>
            <Plus className="size-4 mr-1" /> {t("admin-mail-compose")}
          </Button>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <KpiCard
          label={t("admin-mail-queued")}
          value={queued}
          icon={Inbox}
          sub={t("admin-mail-kpi-queued-sub")}
        />
        <KpiCard
          label={t("admin-mail-kpi-sent24h")}
          value={sent24h}
          icon={CheckCircle2}
          iconClassName="text-success"
          sub={t("admin-mail-kpi-sent24h-sub")}
        />
        <KpiCard
          label={t("admin-failed")}
          value={failed}
          icon={XCircle}
          iconClassName={failed > 0 ? "text-destructive" : undefined}
          sub={t("admin-mail-kpi-failed-sub")}
        />
        <KpiCard
          label={t("total")}
          value={total}
          icon={Mail}
          sub={t("admin-mail-kpi-total-sub")}
        />
      </div>

      <Card className="mb-4">
        <CardContent className="p-3 flex flex-col md:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder={t("admin-mail-search-placeholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-full md:w-40"><SelectValue placeholder={t("admin-col-status")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("admin-mail-all-statuses")}</SelectItem>
              <SelectItem value="queued">{t("admin-mail-queued")}</SelectItem>
              <SelectItem value="sending">{t("admin-mail-sending")}</SelectItem>
              <SelectItem value="sent">{t("admin-mail-sent")}</SelectItem>
              <SelectItem value="failed">{t("admin-failed")}</SelectItem>
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
              icon={<Mail className="size-6" />}
              title={t("admin-mail-empty-title")}
              description={t("admin-mail-empty-desc")}
              action={
                <Button onClick={() => setShowCompose(true)}>
                  <Plus className="size-4 mr-1" /> {t("admin-mail-compose")}
                </Button>
              }
            />
          ) : (
            <div className="max-h-[calc(100vh-440px)] overflow-y-auto custom-scroll">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead>{t("admin-mail-col-to")}</TableHead>
                    <TableHead>{t("admin-mail-subject")}</TableHead>
                    <TableHead>{t("admin-col-status")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("admin-mail-col-attempts")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t("admin-mail-col-error")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("admin-col-created")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t("admin-mail-sent-at")}</TableHead>
                    <TableHead className="text-right">{t("admin-col-actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((m) => {
                    const meta = STATUS_META[m.status];
                    const Icon = meta.icon;
                    return (
                      <TableRow
                        key={m.id}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => setDetailId(m.id)}
                      >
                        <TableCell className="font-medium text-sm truncate max-w-[200px]">{m.to_email}</TableCell>
                        <TableCell className="text-sm truncate max-w-[240px]">{m.subject || "—"}</TableCell>
                        <TableCell>
                          <Badge className={meta.className + " gap-1"}>
                            <Icon className="size-3" /> {t(meta.labelKey)}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden md:table-cell tabular text-sm">{m.attempts}</TableCell>
                        <TableCell className="hidden lg:table-cell text-xs text-destructive truncate max-w-[180px]" title={m.error || ""}>
                          {m.error || "—"}
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-xs">{fmtRelative(m.created_at)}</TableCell>
                        <TableCell className="hidden lg:table-cell text-xs">{fmtRelative(m.sent_at)}</TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            <Button size="icon" variant="ghost" className="size-8" onClick={() => setDetailId(m.id)} title={t("view")}>
                              <Eye className="size-4" />
                            </Button>
                            <Button size="icon" variant="ghost" className="size-8 text-destructive" onClick={() => setDeleteId(m.id)} title={t("delete")}>
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

      {/* Detail sheet */}
      <Sheet open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto custom-scroll">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Mail className="size-5" />
              {detailItem?.subject || t("admin-mail-detail-default-title")}
            </SheetTitle>
            <SheetDescription>{t("admin-mail-detail-desc")}</SheetDescription>
          </SheetHeader>
          {isLoading ? (
            <div className="p-4 space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : detailItem ? (
            <MailDetail entry={detailItem} onRetry={() => retryMut.mutate(detailItem)} retrying={retryMut.isPending} />
          ) : (
            <div className="p-4">
              <EmptyState
                icon={<Mail className="size-6" />}
                title={t("admin-mail-detail-not-found-title")}
                description={t("admin-mail-detail-not-found-desc")}
              />
            </div>
          )}
        </SheetContent>
      </Sheet>

      <ComposeDialog
        open={showCompose}
        onOpenChange={setShowCompose}
        onSaved={() => {
          setShowCompose(false);
          qc.invalidateQueries({ queryKey: ["mail-queue", tenantKey] });
        }}
      />

      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("admin-mail-delete-title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("admin-mail-delete-desc")}
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

// ---- Detail panel ----
function MailDetail({
  entry, onRetry, retrying,
}: {
  entry: MailQueueEntry;
  onRetry: () => void;
  retrying: boolean;
}) {
  const t = useT();
  const meta = STATUS_META[entry.status];
  const Icon = meta.icon;
  return (
    <div className="px-4 pb-6 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={meta.className + " gap-1"}>
          <Icon className="size-3" /> {t(meta.labelKey)}
        </Badge>
        <Badge variant="outline" className="gap-1">
          <RotateCcw className="size-3" /> {entry.attempts} {t("admin-mail-attempt-suffix")}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">{t("admin-mail-recipient")}</p>
          <p className="text-sm font-medium truncate">{entry.to_email}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">{t("admin-col-created")}</p>
          <p className="text-sm">{fmtDateTime(entry.created_at)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">{t("admin-mail-sent-at")}</p>
          <p className="text-sm">{fmtDateTime(entry.sent_at)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">{t("admin-mail-detail-last-error")}</p>
          <p className="text-sm text-destructive truncate" title={entry.error || ""}>{entry.error || "—"}</p>
        </CardContent></Card>
      </div>

      <div>
        <p className="text-xs text-muted-foreground mb-1">{t("admin-mail-detail-body")}</p>
        <pre className="text-xs font-mono whitespace-pre-wrap p-3 rounded-md bg-muted/50 border border-border/60 max-h-[400px] overflow-y-auto custom-scroll">
{entry.body || t("admin-mail-detail-empty-body")}
        </pre>
      </div>

      {entry.status === "failed" && (
        <div className="rounded-md border border-amber-200 bg-amber-50/50 dark:bg-amber-950/10 p-3 flex items-start gap-2">
          <AlertTriangle className="size-4 text-amber-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-xs font-medium text-amber-900 dark:text-amber-200">{t("admin-mail-detail-retry-title")}</p>
            <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">
              {t("admin-mail-detail-retry-desc")}
            </p>
          </div>
        </div>
      )}

      <div className="pt-3 border-t">
        <Button
          variant="outline"
          className="w-full"
          onClick={onRetry}
          disabled={retrying || entry.status === "sending"}
        >
          <RotateCcw className="size-4 mr-1" /> {retrying ? t("admin-mail-detail-retrying") : t("admin-mail-detail-retry-title")}
        </Button>
      </div>
    </div>
  );
}

// ---- Compose dialog ----
function ComposeDialog({
  open, onOpenChange, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setTo("");
      setSubject("");
      setBody("");
    }
  }, [open]);

  async function save() {
    if (!to.trim()) { toast.error(t("admin-mail-recipient-required")); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) { toast.error(t("admin-mail-recipient-invalid")); return; }
    if (!subject.trim()) { toast.error(t("admin-mail-subject-required")); return; }
    setSaving(true);
    try {
      const r = await fetch(api("/api/mail-queue"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to_email: to.trim(),
          subject: subject.trim(),
          body,
          status: "queued",
          attempts: 0,
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || t("admin-mail-save-failed"));
      }
      toast.success(t("admin-mail-queued-toast"));
      onSaved();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t("admin-mail-save-failed");
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2">
            <Send className="size-5" /> {t("admin-mail-compose-title")}
          </DialogTitle>
          <DialogDescription>{t("admin-mail-compose-desc")}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <Label>{t("admin-mail-recipient")} *</Label>
            <Input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder={t("admin-mail-form-to-placeholder")} />
          </div>

          <div className="space-y-1.5">
            <Label>{t("admin-mail-subject")} *</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t("admin-mail-form-subject-placeholder")} />
          </div>

          <div className="space-y-1.5">
            <Label>{t("admin-mail-detail-body")}</Label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              placeholder={t("admin-mail-form-body-placeholder")}
            />
          </div>
        </div>
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? t("admin-mail-queuing") : t("admin-mail-queue-email")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
