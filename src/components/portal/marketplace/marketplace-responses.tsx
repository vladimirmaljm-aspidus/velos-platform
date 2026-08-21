"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { Loader2, Inbox, Send, Check, X } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { useAppStore } from "@/lib/store/app-store";
import { toast } from "sonner";
import { fmtMoney, fmtDate, fmtRelative } from "@/lib/utils/format";
import type { MarketplaceResponseStatus } from "@/lib/supabase/marketplace-types";

interface ResponseRow {
  id: string;
  post_id: string;
  quantity: number | null;
  unit_price: number | null;
  currency: string;
  delivery_date: string | null;
  delivery_location: string | null;
  incoterm: string | null;
  payment_terms: string | null;
  message: string | null;
  status: MarketplaceResponseStatus;
  is_counter: boolean;
  created_at: string;
}

const STATUS_LABEL_KEY: Record<MarketplaceResponseStatus, string> = {
  sent: "marketplace-response-status-sent",
  viewed: "marketplace-response-status-viewed",
  accepted: "marketplace-response-status-accepted",
  rejected: "marketplace-response-status-rejected",
  expired: "marketplace-response-status-expired",
  countered: "marketplace-response-status-countered",
};

const STATUS_CLASS: Record<MarketplaceResponseStatus, string> = {
  sent: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400",
  viewed: "border-transparent bg-muted text-muted-foreground",
  accepted: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  rejected: "border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-400",
  expired: "border-transparent bg-muted text-muted-foreground",
  countered: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
};

export function MarketplaceResponses() {
  const t = useT();
  const setSelectedId = useAppStore((s) => s.setSelectedId);
  const qc = useQueryClient();

  const q = useQuery<{ sent?: ResponseRow[]; received?: ResponseRow[] }>({
    queryKey: ["marketplace-my-responses"],
    queryFn: async () => {
      const r = await fetch("/api/marketplace/my-responses");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });

  const updateStatus = useMutation({
    mutationFn: async ({ postId, responseId, status }: { postId: string; responseId: string; status: MarketplaceResponseStatus }) => {
      const r = await fetch(`/api/marketplace/${postId}/responses/${responseId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed.");
      }
      return r.json();
    },
    onSuccess: (_data, vars) => {
      toast.success(t(`marketplace-response-${vars.status}`));
      qc.invalidateQueries({ queryKey: ["marketplace-my-responses"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const sent = q.data?.sent ?? [];
  const received = q.data?.received ?? [];

  function renderRow(r: ResponseRow, isReceived: boolean) {
    return (
      <Card key={r.id}>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className={STATUS_CLASS[r.status]}>
                {t(STATUS_LABEL_KEY[r.status])}
              </Badge>
              {r.is_counter && (
                <Badge variant="outline" className="text-xs">
                  {t("marketplace-counter")}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">{fmtRelative(r.created_at)}</span>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setSelectedId(r.post_id)}>
                {t("marketplace-view-post")}
              </Button>
              {isReceived && (r.status === "sent" || r.status === "viewed") && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/10"
                    onClick={() => updateStatus.mutate({ postId: r.post_id, responseId: r.id, status: "accepted" })}
                    disabled={updateStatus.isPending}
                  >
                    <Check className="h-3.5 w-3.5 mr-1" />
                    {t("marketplace-accept")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-rose-500/40 text-rose-700 hover:bg-rose-500/10"
                    onClick={() => updateStatus.mutate({ postId: r.post_id, responseId: r.id, status: "rejected" })}
                    disabled={updateStatus.isPending}
                  >
                    <X className="h-3.5 w-3.5 mr-1" />
                    {t("marketplace-reject")}
                  </Button>
                </>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">{t("marketplace-quantity")}</p>
              <p className="font-medium">{r.quantity ? r.quantity.toLocaleString() : "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t("marketplace-unit-price")}</p>
              <p className="font-medium">{r.unit_price != null ? fmtMoney(r.unit_price, r.currency) : "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t("marketplace-delivery-date")}</p>
              <p className="font-medium">{r.delivery_date ? fmtDate(r.delivery_date) : "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t("marketplace-incoterm")}</p>
              <p className="font-medium">{r.incoterm || "—"}</p>
            </div>
          </div>

          {(r.delivery_location || r.payment_terms) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">{t("marketplace-delivery-location")}</p>
                <p className="font-medium">{r.delivery_location || "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t("marketplace-payment-terms")}</p>
                <p className="font-medium">{r.payment_terms || "—"}</p>
              </div>
            </div>
          )}

          {r.message && (
            <div className="bg-muted/30 rounded p-3">
              <p className="text-xs text-muted-foreground mb-1">{t("marketplace-message")}</p>
              <p className="text-sm whitespace-pre-wrap">{r.message}</p>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">{t("marketplace-responses-title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("marketplace-responses-desc")}
        </p>
      </div>

      {q.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <Tabs defaultValue="received">
          <TabsList>
            <TabsTrigger value="received" className="gap-1">
              <Inbox className="h-3.5 w-3.5" />
              {t("marketplace-received-offers")}
              {received.length > 0 && (
                <Badge variant="secondary" className="ml-1 h-4 px-1 text-xs">{received.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="sent" className="gap-1">
              <Send className="h-3.5 w-3.5" />
              {t("marketplace-sent-offers")}
              {sent.length > 0 && (
                <Badge variant="secondary" className="ml-1 h-4 px-1 text-xs">{sent.length}</Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="received" className="mt-4 space-y-3">
            {received.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Inbox className="h-10 w-10 mx-auto mb-2 opacity-50" />
                {t("marketplace-no-received")}
              </div>
            ) : (
              received.map((r) => renderRow(r, true))
            )}
          </TabsContent>

          <TabsContent value="sent" className="mt-4 space-y-3">
            {sent.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Send className="h-10 w-10 mx-auto mb-2 opacity-50" />
                {t("marketplace-no-sent")}
              </div>
            ) : (
              sent.map((r) => renderRow(r, false))
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
