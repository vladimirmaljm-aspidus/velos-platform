"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckCircle2, XCircle, RefreshCw, TrendingUp, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { fmtDateTime, fmtRelative } from "@/lib/utils/format";
import { useT } from "@/lib/i18n/store";
import { useAppStore, isSuperAdmin } from "@/lib/store/app-store";

interface UpgradeRequest {
  id: string;
  tenant_id: string;
  requested_by: string | null;
  requested_plan: string;
  current_plan: string | null;
  message: string | null;
  status: "pending" | "approved" | "rejected";
  reviewed_by: string | null;
  reviewed_at: string | null;
  admin_note: string | null;
  created_at: string;
}

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  approved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  rejected: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
};

interface Tenant { id: string; name: string; plan?: string }

export function PlanUpgradeQueueView() {
  const qc = useQueryClient();
  const t = useT();
  const [statusFilter, setStatusFilter] = React.useState<string>("pending");
  const [reviewing, setReviewing] = React.useState<UpgradeRequest | null>(null);
  const [decision, setDecision] = React.useState<"approve" | "reject">("approve");
  const [months, setMonths] = React.useState<number>(12);
  const [note, setNote] = React.useState("");
  const userObj = useAppStore((s) => s.user);
  const isSuper = isSuperAdmin(userObj);

  const listQ = useQuery({
    queryKey: ["plan-upgrade-queue", statusFilter],
    queryFn: async () => {
      const q = new URLSearchParams();
      if (statusFilter !== "all") q.set("status", statusFilter);
      const r = await fetch(`/api/plan-upgrade-requests?${q.toString()}`);
      if (!r.ok) throw new Error("Failed to load queue");
      return r.json() as Promise<{ items: UpgradeRequest[]; total: number }>;
    },
    enabled: isSuper,
  });
  const tenantsQ = useQuery({
    queryKey: ["plan-upgrade-tenants"],
    queryFn: async () => {
      const r = await fetch("/api/tenants");
      return r.ok ? (r.json() as Promise<{ items: Tenant[] }>) : { items: [] };
    },
    enabled: isSuper,
  });
  const tenantName = React.useMemo(() => new Map((tenantsQ.data?.items || []).map((t) => [t.id, t.name])), [tenantsQ.data]);
  const items = listQ.data?.items || [];

  const reviewMut = useMutation({
    mutationFn: async () => {
      if (!reviewing) return;
      const r = await fetch(`/api/plan-upgrade-requests/${reviewing.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, months, admin_note: note || undefined }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || t("failed"));
    },
    onSuccess: () => {
      toast.success(decision === "approve" ? t("pf-plan-upgraded") : t("pf-request-rejected"));
      qc.invalidateQueries({ queryKey: ["plan-upgrade-queue"] });
      setReviewing(null); setNote(""); setMonths(12);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Defense-in-depth: super-admin-only review queue. The sidebar item
  // carries `permission: "platform.plans.write"` (super-admin only after
  // the canUser fix), and PATCH /api/plan-upgrade-requests/[id] uses
  // requireSuperAdmin, but if a non-super-admin reaches this view via
  // state manipulation we render a clear denial instead of firing 403
  // fetches. Hooks above are declared before this return (Rules of Hooks).
  if (!isSuper) {
    return (
      <div className="space-y-4">
        <PageHeader
          title={t("plan-upgrade-queue")}
          description={t("pf-upgrade-queue-desc")}
        />
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

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("plan-upgrade-queue")}
        description={t("pf-upgrade-queue-desc")}
      />
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base flex items-center gap-2"><TrendingUp className="size-4 text-primary" /> {t("pf-requests")}</CardTitle>
            <div className="flex items-center gap-2">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("all")}</SelectItem>
                  <SelectItem value="pending">{t("pending")}</SelectItem>
                  <SelectItem value="approved">{t("pf-status-approved")}</SelectItem>
                  <SelectItem value="rejected">{t("pf-status-rejected")}</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" onClick={() => listQ.refetch()}>
                <RefreshCw className="size-3.5 mr-1" /> {t("refresh")}
              </Button>
            </div>
          </div>
          <CardDescription className="text-xs">{t("pf-click-row-hint")}</CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="border rounded-lg overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("pf-tenant")}</TableHead>
                  <TableHead>{t("pf-from-to")}</TableHead>
                  <TableHead>{t("status")}</TableHead>
                  <TableHead>{t("pf-message")}</TableHead>
                  <TableHead>{t("pf-requested")}</TableHead>
                  <TableHead>{t("pf-reviewed")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listQ.isLoading && <TableRow><TableCell colSpan={6} className="text-center py-6 text-muted-foreground">{t("loading")}</TableCell></TableRow>}
                {!listQ.isLoading && items.length === 0 && <TableRow><TableCell colSpan={6} className="text-center py-6 text-muted-foreground">{t("pf-nothing-here")}</TableCell></TableRow>}
                {items.map((r) => (
                  <TableRow key={r.id} className={r.status === "pending" ? "cursor-pointer hover:bg-accent/40" : "opacity-70"} onClick={() => r.status === "pending" && setReviewing(r)}>
                    <TableCell className="font-medium">{tenantName.get(r.tenant_id) || r.tenant_id.slice(0, 8)}</TableCell>
                    <TableCell className="text-xs">
                      <span className="text-muted-foreground">{r.current_plan || "—"}</span>
                      <span className="mx-1.5">→</span>
                      <strong className="capitalize">{r.requested_plan}</strong>
                    </TableCell>
                    <TableCell><Badge variant="outline" className={STATUS_STYLE[r.status]}>{r.status}</Badge></TableCell>
                    <TableCell className="text-xs max-w-[240px] truncate" title={r.message || ""}>{r.message || "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground" title={fmtDateTime(r.created_at)}>{fmtRelative(r.created_at)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground" title={r.reviewed_at ? fmtDateTime(r.reviewed_at) : ""}>{r.reviewed_at ? fmtRelative(r.reviewed_at) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!reviewing} onOpenChange={(o) => !o && setReviewing(null)}>
        <DialogContent size="md" className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
            <DialogTitle>{t("pf-review-upgrade")}</DialogTitle>
            <DialogDescription>
              {reviewing && `${tenantName.get(reviewing.tenant_id) || t("pf-tenant")} — ${reviewing.current_plan || "—"} → ${reviewing.requested_plan}`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-3">
          {reviewing?.message && (
            <div className="rounded-lg bg-muted/40 p-3 text-sm">
              <p className="text-xs text-muted-foreground mb-1">{t("pf-client-message")}</p>
              <p>{reviewing.message}</p>
            </div>
          )}
          <div className="space-y-3">
            <div>
              <Label className="text-xs">{t("pf-decision")}</Label>
              <div className="flex gap-2 mt-1">
                <Button size="sm" variant={decision === "approve" ? "default" : "outline"} onClick={() => setDecision("approve")}>
                  <CheckCircle2 className="size-4 mr-1" /> {t("approve")}
                </Button>
                <Button size="sm" variant={decision === "reject" ? "default" : "outline"} className={decision === "reject" ? "bg-destructive" : ""} onClick={() => setDecision("reject")}>
                  <XCircle className="size-4 mr-1" /> {t("reject")}
                </Button>
              </div>
            </div>
            {decision === "approve" && (
              <div>
                <Label className="text-xs">{t("pf-subscription-length")}</Label>
                <Input type="number" min={1} value={months} onChange={(e) => setMonths(Number(e.target.value) || 12)} />
                <p className="text-xs text-muted-foreground mt-1">{t("pf-subscription-stamp-hint").replace("{n}", String(months))}</p>
              </div>
            )}
            <div>
              <Label className="text-xs">{t("pf-note-optional")}</Label>
              <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("pf-note-placeholder")} />
            </div>
          </div>
          </div>
          <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
            <Button variant="outline" onClick={() => setReviewing(null)}>{t("cancel")}</Button>
            <Button onClick={() => reviewMut.mutate()} disabled={reviewMut.isPending}>
              {reviewMut.isPending ? t("pf-saving") : decision === "approve" ? t("pf-approve-upgrade") : t("reject")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
