"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  FileText,
  Loader2,
  Truck,
  Calendar,
  CheckCircle2,
  AlertTriangle,
  Clock,
  TrendingUp,
} from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { useT } from "@/lib/i18n/store";
import { toast } from "sonner";
import { fmtDate } from "@/lib/utils/format";
import type {
  Contract,
  ContractDelivery,
  ContractDeliveryStatus,
} from "@/lib/supabase/marketplace-auction-types";

interface ContractWidgetProps {
  postId: string;
  currency: string;
  unit: string;
  isOwner: boolean;
}

interface ContractResponse {
  contract: Contract | null;
}

interface DeliveriesResponse {
  items: ContractDelivery[];
  is_owner: boolean;
}

/**
 * ContractWidget — long-term supply contract management panel.
 *
 * Shown on a marketplace_posts detail view whose post_type='contract'.
 *
 * Layout:
 *   1. Header: status badge + total / delivered / remaining summary.
 *   2. Progress bar: delivered_quantity / total_quantity.
 *   3. Delivery schedule table: date / qty / delivered qty / status / actions.
 *   4. (Owner only) "Mark Delivered" / "Edit" buttons per row.
 *   5. (Owner only) "Create contract" button when no contract exists yet.
 */
export function ContractWidget({ postId, currency, unit, isOwner }: ContractWidgetProps) {
  const t = useT();
  const qc = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    total_quantity: "",
    frequency: "monthly" as "monthly" | "quarterly" | "weekly" | "custom",
    start_date: "",
    end_date: "",
    price_type: "fixed" as "fixed" | "floating" | "indexed",
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    status: "pending" as ContractDeliveryStatus,
    delivered_quantity: "",
    notes: "",
  });

  const contractQ = useQuery<ContractResponse>({
    queryKey: ["marketplace-contract", postId],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/${postId}/contract`);
      if (!r.ok) throw new Error("Failed to load contract.");
      return r.json();
    },
  });

  const deliveriesQ = useQuery<DeliveriesResponse>({
    queryKey: ["marketplace-contract-deliveries", postId],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/${postId}/contract/deliveries`);
      if (!r.ok) throw new Error("Failed to load deliveries.");
      return r.json();
    },
    enabled: !!contractQ.data?.contract,
  });

  const createContract = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/marketplace/${postId}/contract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          total_quantity: Number(createForm.total_quantity),
          frequency: createForm.frequency,
          start_date: new Date(createForm.start_date).toISOString(),
          end_date: new Date(createForm.end_date).toISOString(),
          price_type: createForm.price_type,
          auto_generate_schedule: true,
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to create contract.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-contract-created"));
      setCreateOpen(false);
      qc.invalidateQueries({ queryKey: ["marketplace-contract", postId] });
      qc.invalidateQueries({ queryKey: ["marketplace-contract-deliveries", postId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateDelivery = useMutation({
    mutationFn: async ({ deliveryId }: { deliveryId: string }) => {
      const r = await fetch(`/api/marketplace/${postId}/contract/deliveries/${deliveryId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: editForm.status,
          delivered_quantity: editForm.delivered_quantity
            ? Number(editForm.delivered_quantity)
            : editForm.status === "delivered"
              ? undefined // server defaults to scheduled qty
              : 0,
          notes: editForm.notes || null,
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to update delivery.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-delivery-updated"));
      setEditingId(null);
      qc.invalidateQueries({ queryKey: ["marketplace-contract-deliveries", postId] });
      qc.invalidateQueries({ queryKey: ["marketplace-contract", postId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const markDelivered = useMutation({
    mutationFn: async (deliveryId: string) => {
      const r = await fetch(`/api/marketplace/${postId}/contract/deliveries/${deliveryId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "delivered" }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to mark delivered.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-delivery-marked"));
      qc.invalidateQueries({ queryKey: ["marketplace-contract-deliveries", postId] });
      qc.invalidateQueries({ queryKey: ["marketplace-contract", postId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const contract = contractQ.data?.contract ?? null;
  const deliveries = deliveriesQ.data?.items ?? [];
  const totalDelivered = Number(contract?.delivered_quantity ?? 0);
  const totalQty = Number(contract?.total_quantity ?? 0);
  const progressPct = useMemo(() => {
    if (!totalQty || totalQty <= 0) return 0;
    return Math.min(100, Math.round((totalDelivered / totalQty) * 100));
  }, [totalDelivered, totalQty]);

  const statusMeta = (s: string) => {
    switch (s) {
      case "active":
        return { label: t("marketplace-contract-status-active"), cls: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" };
      case "completed":
        return { label: t("marketplace-contract-status-completed"), cls: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400" };
      case "cancelled":
        return { label: t("marketplace-contract-status-cancelled"), cls: "border-transparent bg-muted text-muted-foreground" };
      case "breached":
        return { label: t("marketplace-contract-status-breached"), cls: "border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-400" };
      default:
        return { label: s, cls: "" };
    }
  };

  const deliveryStatusMeta = (s: string) => {
    switch (s) {
      case "delivered":
        return { label: t("marketplace-delivery-status-delivered"), icon: CheckCircle2, cls: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" };
      case "partial":
        return { label: t("marketplace-delivery-status-partial"), icon: TrendingUp, cls: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400" };
      case "missed":
        return { label: t("marketplace-delivery-status-missed"), icon: AlertTriangle, cls: "border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-400" };
      case "pending":
      default:
        return { label: t("marketplace-delivery-status-pending"), icon: Clock, cls: "border-transparent bg-muted text-muted-foreground" };
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="h-4 w-4" />
          {t("marketplace-contract-title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {contractQ.isLoading && (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* No contract yet — owner can create one */}
        {!contractQ.isLoading && !contract && isOwner && (
          <div className="text-center py-6 space-y-3">
            <p className="text-sm text-muted-foreground">{t("marketplace-contract-none")}</p>
            <Button onClick={() => setCreateOpen(true)}>
              <FileText className="h-4 w-4 mr-1" />
              {t("marketplace-contract-create")}
            </Button>
          </div>
        )}

        {/* No contract + non-owner */}
        {!contractQ.isLoading && !contract && !isOwner && (
          <p className="text-sm text-muted-foreground py-4 text-center">
            {t("marketplace-contract-none-non-owner")}
          </p>
        )}

        {/* Contract details */}
        {contract && (
          <>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <Badge variant="outline" className={statusMeta(contract.status ?? "active").cls}>
                {statusMeta(contract.status ?? "active").label}
              </Badge>
              {contract.frequency && (
                <span className="text-xs text-muted-foreground">
                  {t(`marketplace-contract-frequency-${contract.frequency}`)}
                </span>
              )}
              {contract.price_type && (
                <span className="text-xs text-muted-foreground">
                  {t(`marketplace-contract-price-${contract.price_type}`)}
                </span>
              )}
            </div>

            <div className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">{t("marketplace-contract-total")}</p>
                <p className="font-medium mt-0.5">{totalQty.toLocaleString()} {unit}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t("marketplace-contract-delivered")}</p>
                <p className="font-medium mt-0.5">{totalDelivered.toLocaleString()} {unit}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t("marketplace-contract-remaining")}</p>
                <p className="font-medium mt-0.5">{Math.max(0, totalQty - totalDelivered).toLocaleString()} {unit}</p>
              </div>
            </div>

            {/* Progress bar */}
            <div className="space-y-1.5">
              <Progress value={progressPct} />
              <p className="text-xs text-muted-foreground text-right">
                {progressPct}% {t("marketplace-contract-progress-complete")}
              </p>
            </div>

            {/* Date range */}
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {fmtDate(contract.start_date)}
              </span>
              <span>→</span>
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {fmtDate(contract.end_date)}
              </span>
            </div>

            <Separator />
          </>
        )}

        {/* Delivery schedule */}
        {contract && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <Truck className="h-3 w-3" />
              {t("marketplace-contract-deliveries")}
            </p>
            {deliveriesQ.isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : deliveries.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">
                {t("marketplace-contract-no-deliveries")}
              </p>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">{t("marketplace-col-scheduled-date")}</TableHead>
                      <TableHead className="text-xs">{t("marketplace-col-quantity")}</TableHead>
                      <TableHead className="text-xs">{t("marketplace-col-delivered-qty")}</TableHead>
                      <TableHead className="text-xs">{t("marketplace-col-status")}</TableHead>
                      {isOwner && <TableHead className="text-xs text-right">{t("portal-col-actions")}</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {deliveries.map((d) => {
                      const sm = deliveryStatusMeta(d.status ?? "pending");
                      const StatusIcon = sm.icon;
                      const isEditing = editingId === d.id;
                      return (
                        <TableRow key={d.id}>
                          <TableCell className="text-xs">{fmtDate(d.scheduled_date)}</TableCell>
                          <TableCell className="text-xs font-medium">
                            {Number(d.quantity).toLocaleString()} {unit}
                          </TableCell>
                          <TableCell className="text-xs">
                            {Number(d.delivered_quantity || 0).toLocaleString()} {unit}
                          </TableCell>
                          <TableCell>
                            {isEditing ? null : (
                              <Badge variant="outline" className={`text-xs ${sm.cls}`}>
                                <StatusIcon className="h-3 w-3 mr-1" />
                                {sm.label}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {isOwner && !isEditing && (
                              <div className="flex gap-1 justify-end">
                                {d.status !== "delivered" && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 px-2 text-xs"
                                    onClick={() => markDelivered.mutate(d.id)}
                                    disabled={markDelivered.isPending}
                                  >
                                    {t("marketplace-delivery-mark-delivered")}
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => {
                                    setEditingId(d.id);
                                    setEditForm({
                                      status: d.status,
                                      delivered_quantity: String(d.delivered_quantity || ""),
                                      notes: d.notes || "",
                                    });
                                  }}
                                >
                                  {t("portal-action-view")}
                                </Button>
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}
      </CardContent>

      {/* Create contract dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
            <DialogTitle>{t("marketplace-contract-create-title")}</DialogTitle>
            <DialogDescription>{t("marketplace-contract-create-desc")}</DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
            <div>
              <Label htmlFor="c-total">{t("marketplace-contract-total")} *</Label>
              <Input
                id="c-total"
                type="number"
                value={createForm.total_quantity}
                onChange={(e) => setCreateForm({ ...createForm, total_quantity: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="c-freq">{t("marketplace-contract-frequency-label")}</Label>
                <select
                  id="c-freq"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={createForm.frequency}
                  onChange={(e) => setCreateForm({ ...createForm, frequency: e.target.value as "monthly" | "quarterly" | "weekly" | "custom" })}
                >
                  <option value="weekly">{t("marketplace-contract-frequency-weekly")}</option>
                  <option value="monthly">{t("marketplace-contract-frequency-monthly")}</option>
                  <option value="quarterly">{t("marketplace-contract-frequency-quarterly")}</option>
                  <option value="custom">{t("marketplace-contract-frequency-custom")}</option>
                </select>
              </div>
              <div>
                <Label htmlFor="c-price">{t("marketplace-contract-price-label")}</Label>
                <select
                  id="c-price"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={createForm.price_type}
                  onChange={(e) => setCreateForm({ ...createForm, price_type: e.target.value as "fixed" | "floating" | "indexed" })}
                >
                  <option value="fixed">{t("marketplace-contract-price-fixed")}</option>
                  <option value="floating">{t("marketplace-contract-price-floating")}</option>
                  <option value="indexed">{t("marketplace-contract-price-indexed")}</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="c-start">{t("marketplace-contract-start-date")}</Label>
                <Input
                  id="c-start"
                  type="date"
                  value={createForm.start_date}
                  onChange={(e) => setCreateForm({ ...createForm, start_date: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="c-end">{t("marketplace-contract-end-date")}</Label>
                <Input
                  id="c-end"
                  type="date"
                  value={createForm.end_date}
                  onChange={(e) => setCreateForm({ ...createForm, end_date: e.target.value })}
                />
              </div>
            </div>
          </div>
          <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t("portal-action-cancel")}</Button>
            <Button
              onClick={() => createContract.mutate()}
              disabled={
                createContract.isPending ||
                !createForm.total_quantity ||
                !createForm.start_date ||
                !createForm.end_date
              }
            >
              {createContract.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FileText className="h-4 w-4 mr-1" />}
              {t("marketplace-contract-create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit delivery dialog */}
      <Dialog open={!!editingId} onOpenChange={(o) => !o && setEditingId(null)}>
        <DialogContent className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
            <DialogTitle>{t("marketplace-delivery-edit-title")}</DialogTitle>
            <DialogDescription>{t("marketplace-delivery-edit-desc")}</DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
            <div>
              <Label htmlFor="d-status">{t("marketplace-col-status")}</Label>
              <select
                id="d-status"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={editForm.status}
                onChange={(e) => setEditForm({ ...editForm, status: e.target.value as ContractDeliveryStatus })}
              >
                <option value="pending">{t("marketplace-delivery-status-pending")}</option>
                <option value="delivered">{t("marketplace-delivery-status-delivered")}</option>
                <option value="partial">{t("marketplace-delivery-status-partial")}</option>
                <option value="missed">{t("marketplace-delivery-status-missed")}</option>
              </select>
            </div>
            <div>
              <Label htmlFor="d-dqty">{t("marketplace-col-delivered-qty")}</Label>
              <Input
                id="d-dqty"
                type="number"
                step="0.0001"
                value={editForm.delivered_quantity}
                onChange={(e) => setEditForm({ ...editForm, delivered_quantity: e.target.value })}
                placeholder={editForm.status === "delivered" ? t("marketplace-delivery-auto-fill") : "0"}
              />
            </div>
            <div>
              <Label htmlFor="d-notes">{t("marketplace-delivery-notes")}</Label>
              <Textarea
                id="d-notes"
                rows={3}
                value={editForm.notes}
                onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                maxLength={5000}
              />
            </div>
          </div>
          <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
            <Button variant="outline" onClick={() => setEditingId(null)}>{t("portal-action-cancel")}</Button>
            <Button onClick={() => editingId && updateDelivery.mutate({ deliveryId: editingId })}>
              {updateDelivery.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              {t("portal-action-save-changes")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
