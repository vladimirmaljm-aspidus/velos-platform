"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Leaf,
  Loader2,
  Sprout,
  Sun,
  Recycle,
  Wind,
  Plus,
  ExternalLink,
  TrendingDown,
} from "lucide-react";
import { toast } from "sonner";
import { useT } from "@/lib/i18n/store";
import { fmtDateTime, fmtMoney } from "@/lib/utils/format";
import type {
  CarbonOffset,
  CarbonOffsetType,
  CarbonOffsetStatus,
} from "@/lib/supabase/marketplace-esg-types";
import {
  OFFSET_STATUS_LABEL_KEY,
  OFFSET_TYPE_LABEL_KEY,
} from "@/lib/supabase/marketplace-esg-types";
import { estimateOffsetCost } from "@/lib/data/marketplace-esg-store";
import { cn } from "@/lib/utils";

interface ListResponse {
  items: CarbonOffset[];
}

const OFFSET_TYPES: CarbonOffsetType[] = [
  "tree_planting",
  "renewable_energy",
  "methane_capture",
  "direct_air_capture",
];

const OFFSET_TYPE_ICON: Record<CarbonOffsetType, React.ComponentType<{ className?: string }>> = {
  tree_planting: Sprout,
  renewable_energy: Sun,
  methane_capture: Recycle,
  direct_air_capture: Wind,
};

const STATUS_BADGE_CLS: Record<CarbonOffsetStatus, string> = {
  pending:   "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
  purchased: "border-transparent bg-blue-500/15 text-blue-700 dark:text-blue-400",
  retired:   "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  cancelled: "border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-400",
};

/**
 * CarbonOffsetWidget — the company-level carbon-offset dashboard.
 *
 * Three sections:
 *   1. Headline — total CO2 offset (sum of retired offsets' co2_tons).
 *   2. "Offset Now" CTA — opens a small dialog where the partner picks an
 *      offset type, the tonnes of CO2 to offset, and (optionally) links
 *      the offset to a shipment_id. The widget previews the auto-derived
 *      cost before the partner confirms the purchase.
 *   3. Offset history — chronological list of the partner's offsets with
 *      status badges + certificate links.
 *
 * NOTE: the CO2 input is FREE-FORM (the partner types the tonnage). The
 * widget intentionally does NOT auto-pull the CO2 from a specific shipment
 * because a partner may want to bundle emissions from several shipments
 * into a single offset purchase — the shipment_id is an OPTIONAL context
 * field, not the source of truth for the tonnage.
 */
export function CarbonOffsetWidget({
  partnerId,
  isSelf = false,
  presetCo2Tons,
  presetShipmentId,
}: {
  partnerId: string;
  /** When false, the widget is read-only (public view of someone else's profile). */
  isSelf?: boolean;
  /** When supplied, the "Offset Now" dialog pre-fills the tonnage (e.g.
   * the carbon-footprint calculator can deep-link here with its result). */
  presetCo2Tons?: number;
  /** When supplied, the dialog pre-fills the shipment_id context. */
  presetShipmentId?: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);

  const q = useQuery<ListResponse>({
    queryKey: ["marketplace-esg-offsets", partnerId],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/esg/offsets?partnerId=${encodeURIComponent(partnerId)}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: isSelf, // offset list is private to the owning partner
    staleTime: 30_000,
  });

  const items = q.data?.items ?? [];
  // Total retired CO2 — only retired offsets count towards the "real"
  // cancelled tonnage; pending / purchased are not yet cancelled.
  const totalRetired = items
    .filter((o) => o.status === "retired")
    .reduce((sum, o) => sum + Number(o.co2_tons || 0), 0);
  const totalAll = items.reduce((sum, o) => sum + Number(o.co2_tons || 0), 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Leaf className="h-4 w-4 text-emerald-600" />
            {t("marketplace-esg-offsets-title")}
          </CardTitle>
          {isSelf && (
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-1" />
              {t("marketplace-esg-offsets-cta")}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Headline */}
        <div className="rounded-md bg-gradient-to-br from-emerald-500/10 to-blue-500/10 p-4 flex items-center gap-3">
          <TrendingDown className="h-8 w-8 text-emerald-600 shrink-0" />
          <div className="flex-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {t("marketplace-esg-offsets-retired-total")}
            </p>
            <p className="text-2xl font-bold tracking-tight">
              {totalRetired.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              <span className="text-sm font-normal text-muted-foreground ml-1">tCO₂e</span>
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("marketplace-esg-offsets-including-pending")
                .replace("{n}", totalAll.toLocaleString(undefined, { maximumFractionDigits: 2 }))}
            </p>
          </div>
        </div>

        {/* Offset history (own profile only) */}
        {isSelf && (
          <>
            {q.isLoading ? (
              <div className="flex justify-center py-4">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : q.isError ? (
              <p className="text-sm text-rose-600">{t("marketplace-esg-offsets-load-error")}</p>
            ) : items.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("marketplace-esg-offsets-empty")}</p>
            ) : (
              <ul className="space-y-2">
                {items.map((o) => (
                  <OffsetRow key={o.id} offset={o} t={t} />
                ))}
              </ul>
            )}
          </>
        )}

        {!isSelf && (
          <p className="text-xs text-muted-foreground">
            {t("marketplace-esg-offsets-private-note")}
          </p>
        )}

        {showCreate && isSelf && (
          <CreateOffsetDialog
            partnerId={partnerId}
            presetCo2Tons={presetCo2Tons}
            presetShipmentId={presetShipmentId}
            onClose={() => setShowCreate(false)}
            onCreated={() => {
              setShowCreate(false);
              qc.invalidateQueries({ queryKey: ["marketplace-esg-offsets", partnerId] });
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ─── Offset row ─────────────────────────────────────────────────────────────

function OffsetRow({
  offset,
  t,
}: {
  offset: CarbonOffset;
  t: (key: string) => string;
}) {
  const typeKey = offset.offset_type ? OFFSET_TYPE_LABEL_KEY[offset.offset_type] : null;
  const Icon = offset.offset_type ? OFFSET_TYPE_ICON[offset.offset_type] : Leaf;
  const statusCls = STATUS_BADGE_CLS[offset.status as CarbonOffsetStatus] ?? "";

  return (
    <li className="rounded-md border p-3 space-y-1.5">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex items-start gap-2 min-w-0">
          <div className="size-7 rounded-md bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 flex items-center justify-center shrink-0">
            <Icon className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {offset.co2_tons.toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
              <span className="text-xs font-normal text-muted-foreground">tCO₂e</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {typeKey ? t(typeKey) : t("marketplace-esg-offset-type-na")}
              {offset.shipment_id && (
                <span className="ml-1.5 font-mono">· {offset.shipment_id.slice(0, 8)}…</span>
              )}
            </p>
          </div>
        </div>
        <Badge variant="outline" className={cn("text-xs", statusCls)}>
          {t(OFFSET_STATUS_LABEL_KEY[offset.status as CarbonOffsetStatus])}
        </Badge>
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{fmtDateTime(offset.created_at)}</span>
        {offset.offset_cost !== null && offset.offset_cost !== undefined && (
          <span className="font-medium">
            {fmtMoney(Number(offset.offset_cost), offset.currency || "USD")}
          </span>
        )}
      </div>
      {offset.certificate_url && (
        <a
          href={offset.certificate_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <ExternalLink className="h-3 w-3" />
          {t("marketplace-esg-offsets-certificate")}
        </a>
      )}
    </li>
  );
}

// ─── Create offset dialog ──────────────────────────────────────────────────

function CreateOffsetDialog({
  partnerId: _partnerId,
  presetCo2Tons,
  presetShipmentId,
  onClose,
  onCreated,
}: {
  partnerId: string;
  presetCo2Tons?: number;
  presetShipmentId?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useT();
  const [form, setForm] = useState<{
    co2_tons: string;
    offset_type: CarbonOffsetType;
    shipment_id: string;
    currency: string;
  }>({
    co2_tons: presetCo2Tons ? String(presetCo2Tons) : "",
    offset_type: "tree_planting",
    shipment_id: presetShipmentId ?? "",
    currency: "USD",
  });

  const previewCost = estimateOffsetCost(
    Number(form.co2_tons) || 0,
    form.offset_type,
  );

  const createMut = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/marketplace/esg/offsets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          co2_tons: Number(form.co2_tons),
          offset_type: form.offset_type,
          shipment_id: form.shipment_id || null,
          currency: form.currency,
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: "Failed." }));
        throw new Error(e?.error || "Failed.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-esg-offsets-created"));
      onCreated();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setField = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const valid = Number(form.co2_tons) > 0;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>{t("marketplace-esg-offsets-create-title")}</DialogTitle>
          <DialogDescription>{t("marketplace-esg-offsets-create-desc")}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-3">
          <div>
            <Label htmlFor="oc-co2">{t("marketplace-esg-offsets-co2-label")}</Label>
            <Input
              id="oc-co2"
              type="number"
              min="0"
              step="0.001"
              value={form.co2_tons}
              onChange={(e) => setField("co2_tons", e.target.value)}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t("marketplace-esg-offsets-co2-hint")}
            </p>
          </div>

          <div>
            <Label htmlFor="oc-type">{t("marketplace-esg-offsets-type-label")}</Label>
            <Select
              value={form.offset_type}
              onValueChange={(v) => setField("offset_type", v as CarbonOffsetType)}
            >
              <SelectTrigger id="oc-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OFFSET_TYPES.map((ot) => {
                  const Icon = OFFSET_TYPE_ICON[ot];
                  return (
                    <SelectItem key={ot} value={ot}>
                      <span className="inline-flex items-center gap-2">
                        <Icon className="h-3.5 w-3.5" />
                        {t(OFFSET_TYPE_LABEL_KEY[ot])}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="oc-ship">{t("marketplace-esg-offsets-shipment-label")}</Label>
            <Input
              id="oc-ship"
              value={form.shipment_id}
              onChange={(e) => setField("shipment_id", e.target.value)}
              placeholder="optional UUID"
            />
          </div>

          {/* Cost preview */}
          <div className="rounded-md bg-muted/30 p-3 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {t("marketplace-esg-offsets-cost-preview")}
            </span>
            <span className="text-sm font-semibold">
              {previewCost !== null
                ? fmtMoney(previewCost, form.currency)
                : "—"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("marketplace-esg-offsets-cost-disclaimer")}
          </p>
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={onClose}>{t("portal-action-cancel")}</Button>
          <Button
            onClick={() => createMut.mutate()}
            disabled={createMut.isPending || !valid}
          >
            {createMut.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            {t("marketplace-esg-offsets-create-cta")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
