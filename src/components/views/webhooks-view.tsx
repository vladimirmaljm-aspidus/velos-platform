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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Plus, Webhook, Trash2, Pencil, Lock, ShieldCheck, Link2, Zap, Clock, Activity, Send,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { fmtRelative } from "@/lib/utils/format";
import { useAppStore, isAdmin } from "@/lib/store/app-store";
import type { Webhook as WebhookType, WebhookDelivery } from "@/lib/supabase/types";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useT } from "@/lib/i18n/store";

const EVENT_COLORS = [
  "bg-[var(--chart-1)] text-white",
  "bg-[var(--chart-2)] text-white",
  "bg-[var(--chart-3)] text-black",
  "bg-[var(--chart-4)] text-black",
  "bg-emerald-600 text-white",
  "bg-[var(--chart-5)] text-white",
];

function eventColor(event: string): string {
  let hash = 0;
  for (let i = 0; i < event.length; i++) hash = (hash * 31 + event.charCodeAt(i)) | 0;
  return EVENT_COLORS[Math.abs(hash) % EVENT_COLORS.length];
}

function statusBadge(status: number | null) {
  if (status === null) return <Badge variant="secondary">Never</Badge>;
  if (status >= 200 && status < 300) {
    return <Badge className="bg-emerald-600 text-white">{status}</Badge>;
  }
  return <Badge variant="destructive">{status}</Badge>;
}

function truncateUrl(url: string, max = 60): string {
  if (url.length <= max) return url;
  return url.slice(0, max - 1) + "…";
}

function AdminRequired() {
  const t = useT();
  return (
    <Card className="border-amber-200 bg-amber-50/50 dark:bg-amber-950/10">
      <CardContent className="p-6 flex items-start gap-3">
        <Lock className="size-5 text-amber-600 mt-0.5 shrink-0" />
        <div>
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">{t("admin-access-required")}</p>
          <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
            {t("admin-webhooks-admin-only-desc")}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function WebhooksView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const user = useAppStore((s) => s.user);
  const admin = isAdmin(user);
  const isSuperAdminUser = !!user && user.role === "super_admin";

  // ── Plan gate — TRIAL tenants do NOT get webhooks. ──────────────────────
  // Webhooks are a paid-tier automation surface (outbound delivery to
  // arbitrary URLs on tenant events). A trial tenant registering
  // webhooks is a security risk: trial accounts can be farmed to probe
  // the platform's event-delivery surface (and to exfiltrate tenant
  // data via delivery payloads to attacker-controlled endpoints) for 14
  // days before anyone notices. The sidebar ALREADY hides this item via
  // the `module_webhooks` feature flag (default false for every new
  // tenant) — this is the in-view defense for the direct-URL navigation.
  const subQ = useQuery({
    queryKey: ["subscription-status-webhooks"],
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
  const [editing, setEditing] = useState<WebhookType | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<WebhookType | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["webhooks", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/webhooks"));
      if (!r.ok) throw new Error("Failed to load webhooks");
      return r.json() as Promise<{ items: WebhookType[] }>;
    },
    enabled: admin && planAllowed,
  });

  const toggleMut = useMutation({
    mutationFn: async (wh: WebhookType) => {
      const r = await fetch(api("/api/webhooks"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...wh, active: !wh.active }),
      });
      if (!r.ok) throw new Error("Failed to toggle webhook");
    },
    onSuccess: (_v, vars) => {
      toast.success(vars.active ? "Webhook disabled." : "Webhook enabled.");
      qc.invalidateQueries({ queryKey: ["webhooks", tenantKey] });
    },
    onError: () => toast.error("Failed to update webhook."),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/webhooks/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error("Failed to delete webhook");
    },
    onSuccess: () => {
      toast.success("Webhook deleted.");
      qc.invalidateQueries({ queryKey: ["webhooks", tenantKey] });
      setDeleteId(null);
    },
    onError: () => toast.error("Failed to delete webhook."),
  });

  if (!admin) {
    return (
      <div>
        <PageHeader title={t("admin-webhooks-title")} description={t("admin-webhooks-desc")} />
        <AdminRequired />
      </div>
    );
  }

  if (!planAllowed) {
    return (
      <div>
        <PageHeader title={t("admin-webhooks-title")} description={t("admin-webhooks-desc")} />
        <Card className="border-amber-500/40 bg-amber-50/50 dark:bg-amber-950/20 rounded-xl">
          <CardContent className="p-6 flex items-start gap-3">
            <ShieldCheck className="size-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                {t("admin-access-required")}
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Webhooks are a paid-plan automation surface and are not
                available during the trial. Upgrade your workspace to
                register outbound webhook deliveries.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const items = data?.items || [];

  return (
    <div>
      <PageHeader
        title={t("admin-webhooks-title")}
        description={`${items.length} ${t("admin-webhooks-count")}`}
        actions={
          <Button onClick={() => { setEditing(null); setShowForm(true); }}>
            <Plus className="size-4 mr-1" /> {t("admin-webhooks-new")}
          </Button>
        }
      />

      <Card className="mb-4 border-amber-200 bg-amber-50/50 dark:bg-amber-950/10">
        <CardContent className="p-4 flex items-start gap-3">
          <ShieldCheck className="size-5 text-amber-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">{t("admin-webhooks-signed-payloads")}</p>
            <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
              {t("admin-webhooks-signed-payloads-desc")}
            </p>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="grid gap-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 w-full" />)}
        </div>
      ) : items.length === 0 ? (
        <Card className="border-border/60 shadow-soft">
          <EmptyState
            icon={<Webhook className="size-6" />}
            title={t("admin-webhooks-empty-title")}
            description={t("admin-webhooks-empty-desc")}
            action={
              <Button onClick={() => { setEditing(null); setShowForm(true); }}>
                <Plus className="size-4 mr-1" /> {t("admin-webhooks-new")}
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 max-h-[calc(100vh-320px)] overflow-y-auto custom-scroll pr-1">
          {items.map((wh) => (
            <Card key={wh.id} className="border-border/60 shadow-soft hover:shadow-soft-md transition-shadow">
              <CardContent className="p-4">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <Zap className="size-4 text-primary shrink-0" />
                      <p className="font-semibold truncate">{wh.name}</p>
                      {!wh.active && <Badge variant="secondary">Disabled</Badge>}
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Link2 className="size-3 shrink-0" />
                      <code className="font-mono truncate" title={wh.url}>{truncateUrl(wh.url)}</code>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex flex-wrap gap-1 max-w-full">
                      {wh.events && wh.events.length > 0 ? (
                        wh.events.map((e) => (
                          <Badge key={e} className={eventColor(e) + " text-xs"}>{e}</Badge>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground">{t("admin-webhooks-no-events")}</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-3 pt-3 border-t border-border/60 text-xs">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Clock className="size-3" />
                    <span>{t("admin-col-last-triggered")}:</span>
                    <span className="text-foreground">{fmtRelative(wh.last_triggered_at)}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Activity className="size-3" />
                    <span>{t("admin-col-last-status")}:</span>
                    {statusBadge(wh.last_status)}
                  </div>
                  <div className="flex items-center gap-2 ml-auto">
                    <Label htmlFor={`wh-active-${wh.id}`} className="text-xs text-muted-foreground cursor-pointer">
                      {t("admin-webhooks-form-active")}
                    </Label>
                    <Switch
                      id={`wh-active-${wh.id}`}
                      checked={wh.active}
                      onCheckedChange={() => toggleMut.mutate(wh)}
                      disabled={toggleMut.isPending}
                      aria-label={t("admin-webhooks-form-active")}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => setDeliveriesFor(wh)}
                      title={t("admin-webhooks-deliveries")}
                    >
                      <Send className="size-3.5 mr-1" /> {t("admin-webhooks-deliveries")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => { setEditing(wh); setShowForm(true); }}
                    >
                      <Pencil className="size-3.5 mr-1" /> {t("edit")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-destructive hover:text-destructive"
                      onClick={() => setDeleteId(wh.id)}
                    >
                      <Trash2 className="size-3.5 mr-1" /> {t("delete")}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <WebhookFormDialog
        open={showForm}
        onOpenChange={setShowForm}
        webhook={editing}
        onSaved={() => {
          setShowForm(false);
          qc.invalidateQueries({ queryKey: ["webhooks", tenantKey] });
        }}
      />

      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("admin-webhooks-delete-confirm")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("admin-webhooks-delete-desc")}
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

      <WebhookDeliveriesDialog
        webhook={deliveriesFor}
        onOpenChange={(o) => !o && setDeliveriesFor(null)}
      />
    </div>
  );
}

// ---- Create/Edit dialog ----
function WebhookFormDialog({
  open, onOpenChange, webhook, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  webhook: WebhookType | null;
  onSaved: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState("");
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (webhook) {
// eslint-disable-next-line react-hooks/set-state-in-effect
      setName(webhook.name);
      setUrl(webhook.url);
      setEvents((webhook.events || []).join(", "));
      setActive(webhook.active);
    } else {
      setName("");
      setUrl("");
      setEvents("");
      setActive(true);
    }
  }, [open, webhook]);

  async function save() {
    if (!name.trim()) { toast.error("Name is required."); return; }
    if (!url.trim()) { toast.error("URL is required."); return; }
    try { new URL(url); } catch { toast.error("URL is not valid."); return; }
    setSaving(true);
    try {
      const eventList = events.split(",").map((s) => s.trim()).filter(Boolean);
      const body: Record<string, unknown> = {
        name: name.trim(),
        url: url.trim(),
        events: eventList,
        active,
      };
      if (webhook) body.id = webhook.id;
      const r = await fetch(api("/api/webhooks"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to save webhook");
      }
      toast.success(webhook ? "Webhook updated." : "Webhook created.");
      onSaved();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to save webhook";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>{webhook ? t("admin-webhooks-form-title-edit") : t("admin-webhooks-form-title-new")}</DialogTitle>
          <DialogDescription>
            {t("admin-webhooks-form-desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <Label>{t("admin-webhooks-form-name")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Slack notifications" />
          </div>

          <div className="space-y-1.5">
            <Label>{t("admin-webhooks-form-url")}</Label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/webhooks/crm" />
          </div>

          <div className="space-y-1.5">
            <Label>{t("admin-webhooks-form-events")}</Label>
            <Textarea
              value={events}
              onChange={(e) => setEvents(e.target.value)}
              rows={3}
              placeholder="offer.sent, deal.won, deal.lost, invoice.overdue, partner.create, security.*"
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              {t("admin-webhooks-form-events-help")} Suggestions: <code className="font-mono">offer.sent</code>,{" "}
              <code className="font-mono">deal.won</code>, <code className="font-mono">deal.lost</code>,{" "}
              <code className="font-mono">invoice.overdue</code>, <code className="font-mono">partner.create</code>.
            </p>
            {/* P0-2 (Monitoring) — Security Events preset chips. */}
            <div className="flex flex-wrap gap-1.5 pt-1">
              <span className="text-xs text-muted-foreground self-center">Security events:</span>
              <button
                type="button"
                onClick={() => {
                  const list = events
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  if (!list.includes("security.*")) list.push("security.*");
                  setEvents(list.join(", "));
                }}
                className="px-2 py-0.5 rounded-md bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 text-xs font-mono hover:bg-amber-200 dark:hover:bg-amber-900/60 transition-colors"
                title="Fire on every security event (login failures, CSRF blocks, impersonation, IDOR probes, IDS escalations, …)"
              >
                security.*
              </button>
              {(
                [
                  "security.login.failed",
                  "security.login.blocked",
                  "security.rate.limit.hit",
                  "security.csrf.blocked",
                  "security.permission.denied",
                  "security.role.escalation",
                  "security.impersonate.start",
                  "security.impersonate.stop",
                  "security.vault.read",
                  "security.cross.tenant.attempt",
                  "security.2fa.disabled",
                  "security.suspicious.activity",
                ] as const
              ).map((ev) => (
                <button
                  key={ev}
                  type="button"
                  onClick={() => {
                    const list = events
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean);
                    if (!list.includes(ev)) list.push(ev);
                    setEvents(list.join(", "));
                  }}
                  className="px-2 py-0.5 rounded-md bg-muted text-foreground/80 dark:text-foreground/70 text-xs font-mono hover:bg-muted/70 transition-colors"
                  title={`Fire only on ${ev}`}
                >
                  {ev}
                </button>
              ))}
            </div>

            {/* Phase 12 — Marketplace lifecycle event chips. Lets a
                partner subscribe to the marketplace events fired by the
                marketplace API routes + the auction-sweep cron. The
                response_rejected + shipment_updated events were added in
                the Phase 12 public-API follow-up: rejected fires from
                the [responseId] PUT handler when the owner rejects a
                response, shipment_updated fires from the shipments PUT
                handler on every status change. */}
            <div className="flex flex-wrap gap-1.5 pt-1">
              <span className="text-xs text-muted-foreground self-center">Marketplace events:</span>
              {(
                [
                  "marketplace.post_created",
                  "marketplace.response_sent",
                  "marketplace.response_accepted",
                  "marketplace.response_rejected",
                  "marketplace.message_sent",
                  "marketplace.bid_placed",
                  "marketplace.auction_won",
                  "marketplace.shipment_updated",
                  "marketplace.document_signed",
                  "marketplace.api_key_created",
                  "marketplace.api_key_revoked",
                ] as const
              ).map((ev) => (
                <button
                  key={ev}
                  type="button"
                  onClick={() => {
                    const list = events
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean);
                    if (!list.includes(ev)) list.push(ev);
                    setEvents(list.join(", "));
                  }}
                  className="px-2 py-0.5 rounded-md bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 text-xs font-mono hover:bg-amber-200 dark:hover:bg-amber-900/60 transition-colors"
                  title={`Fire only on ${ev}`}
                >
                  {ev}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between p-3 rounded-md bg-muted/30">
            <div>
              <p className="text-sm font-medium">{t("admin-webhooks-form-active")}</p>
              <p className="text-xs text-muted-foreground">{t("admin-webhooks-form-active-desc")}</p>
            </div>
            <Switch checked={active} onCheckedChange={setActive} aria-label={t("admin-webhooks-form-active")} />
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

// ---- Delivery history dialog ----
//
// Shows the most recent delivery attempts for a webhook with status, HTTP
// response code, attempts count, and a "Retry" button for failed deliveries.
// The Retry button POSTs to /api/webhooks/[id]/deliveries/[deliveryId]/retry
// — see src/app/api/webhooks/[id]/deliveries/[deliveryId]/retry/route.ts.
function WebhookDeliveriesDialog({
  webhook,
  onOpenChange,
}: {
  webhook: WebhookType | null;
  onOpenChange: (o: boolean) => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();
  const qc = useQueryClient();
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const open = !!webhook;

  const { data, isLoading } = useQuery({
    queryKey: ["webhook-deliveries", webhook?.id, tenantKey],
    queryFn: async () => {
      const r = await fetch(api(`/api/webhooks/${webhook!.id}/deliveries?limit=50`));
      if (!r.ok) throw new Error("Failed to load deliveries");
      return r.json() as Promise<{ items: WebhookDelivery[] }>;
    },
    enabled: !!webhook,
  });

  const retryMut = useMutation({
    mutationFn: async (deliveryId: string) => {
      setRetryingId(deliveryId);
      const r = await fetch(
        api(`/api/webhooks/${webhook!.id}/deliveries/${deliveryId}/retry`),
        { method: "POST" },
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Retry failed");
      }
      return r.json();
    },
    onSuccess: (_v, vars) => {
      toast.success(`Delivery retried (${vars.slice(0, 8)}…)`);
      qc.invalidateQueries({ queryKey: ["webhook-deliveries", webhook?.id, tenantKey] });
      qc.invalidateQueries({ queryKey: ["webhooks", tenantKey] });
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : "Retry failed";
      toast.error(msg);
    },
    onSettled: () => setRetryingId(null),
  });

  const items = data?.items || [];

  function deliveryStatusBadge(d: WebhookDelivery) {
    if (d.status === "delivered") {
      return <Badge className="bg-emerald-600 text-white">{t("admin-webhooks-deliveries-status-delivered")}</Badge>;
    }
    if (d.status === "failed") {
      return <Badge variant="destructive">{t("admin-webhooks-deliveries-status-failed")}</Badge>;
    }
    return <Badge variant="secondary">{t("admin-webhooks-deliveries-status-pending")}</Badge>;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>
            {t("admin-webhooks-deliveries-title")}
            {webhook ? ` — ${webhook.name}` : ""}
          </DialogTitle>
          <DialogDescription>
            {t("admin-webhooks-deliveries-desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
          {isLoading ? (
            <div className="grid gap-2 py-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {t("admin-webhooks-deliveries-empty")}
            </div>
          ) : (
            <div className="grid gap-2 py-2">
              {/* Header row (hidden on mobile — table is too wide) */}
              <div className="hidden md:grid grid-cols-[1.5fr_1fr_0.7fr_0.7fr_1fr_0.7fr] gap-2 px-2 text-xs uppercase tracking-wide text-muted-foreground">
                <div>{t("admin-webhooks-deliveries-col-event")}</div>
                <div>{t("admin-webhooks-deliveries-col-status")}</div>
                <div>{t("admin-webhooks-deliveries-col-attempts")}</div>
                <div>{t("admin-webhooks-deliveries-col-response")}</div>
                <div className="truncate">{t("admin-webhooks-deliveries-col-time")}</div>
                <div></div>
              </div>
              {items.map((d) => (
                <div
                  key={d.id}
                  className="grid grid-cols-1 md:grid-cols-[1.5fr_1fr_0.7fr_0.7fr_1fr_0.7fr] gap-2 items-center p-2 rounded-md bg-muted/30 hover:bg-muted/50 transition-colors text-xs"
                >
                  <div className="font-mono truncate" title={d.event}>{d.event}</div>
                  <div>{deliveryStatusBadge(d)}</div>
                  <div className="text-muted-foreground">{d.attempts}</div>
                  <div>{statusBadge(d.response_status)}</div>
                  <div className="text-muted-foreground truncate" title={d.response_body || ""}>
                    {fmtRelative(d.created_at)}
                  </div>
                  <div className="flex justify-end">
                    {d.status === "failed" && (d.attempts ?? 0) < 5 && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        disabled={retryingId === d.id}
                        onClick={() => retryMut.mutate(d.id)}
                      >
                        {retryingId === d.id
                          ? t("admin-webhooks-deliveries-retrying")
                          : t("admin-webhooks-deliveries-retry")}
                      </Button>
                    )}
                  </div>
                  {d.response_body && (
                    <div className="col-span-full mt-1 px-2 py-1 rounded bg-background/60 font-mono text-xs text-muted-foreground whitespace-pre-wrap break-all max-h-24 overflow-y-auto custom-scroll">
                      {d.response_body}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
