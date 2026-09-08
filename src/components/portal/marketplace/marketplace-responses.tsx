"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { Loader2, Inbox, Send, Check, X, ArrowLeftRight, MessageSquare } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { useAppStore } from "@/lib/store/app-store";
import { toast } from "sonner";
import { fmtMoney, fmtDate, fmtRelative } from "@/lib/utils/format";
import type { MarketplaceResponseStatus } from "@/lib/supabase/marketplace-types";
// 2-b — TYPE-ONLY import from the (server) data store: erased at compile
// time so no server code lands in the client bundle (same pattern as the
// deal-room tabs in negotiation-room.tsx).
import type { MarketplaceNegotiationListItem } from "@/lib/data/marketplace-store";

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

// MARKET-M5 — widened from `Record<MarketplaceResponseStatus, string>` to
// `Record<string, string>` so an unrecognised status string (e.g. a
// future status added by the backend before the i18n keys catch up, or a
// legacy / corrupted row) doesn't crash the render with a TS index error
// at runtime — the call site below now falls back to the raw status
// string when no i18n key is found. The set of known statuses is still
// exhaustively listed here so the common path keeps producing proper
// localised labels.
const STATUS_LABEL_KEY: Record<string, string> = {
  sent: "marketplace-response-status-sent",
  viewed: "marketplace-response-status-viewed",
  accepted: "marketplace-response-status-accepted",
  rejected: "marketplace-response-status-rejected",
  expired: "marketplace-response-status-expired",
  countered: "marketplace-response-status-countered",
};

const STATUS_CLASS: Record<string, string> = {
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
  const setView = useAppStore((s) => s.setView);
  const setSelectedNegotiationId = useAppStore((s) => s.setSelectedNegotiationId);
  const qc = useQueryClient();

  const q = useQuery<{ sent?: ResponseRow[]; received?: ResponseRow[] }>({
    queryKey: ["marketplace-my-responses"],
    queryFn: async () => {
      const r = await fetch("/api/marketplace/my-responses");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });

  // 2-b — the caller's negotiations (shared cache key with the
  // NegotiationsBrowser list — no duplicate request when both views have
  // been visited). Used to (a) deliver counter-offer terms into the room
  // for the post and (b) resolve "Open negotiation" on accepted rows.
  // Fail-soft: on error the counter/open flows simply skip the room
  // lookup instead of breaking the offers view.
  const negsQ = useQuery<{ items: MarketplaceNegotiationListItem[] }>({
    queryKey: ["marketplace-negotiations"],
    queryFn: async () => {
      const r = await fetch("/api/marketplace/negotiations");
      if (!r.ok) return { items: [] };
      return r.json();
    },
    staleTime: 30_000,
  });

  // 2-b — counter-offer dialog state (received rows only; the post owner
  // counters the responder's offer).
  const [counterTarget, setCounterTarget] = useState<ResponseRow | null>(null);
  const [counterForm, setCounterForm] = useState({
    quantity: "",
    unit_price: "",
    message: "",
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

  // ── 2-b — counter-offer on a received response. Two steps, matching the
  // REAL API contract (the PUT route accepts exactly { status }; the
  // response row has no counter-terms columns):
  //   1. PUT /{postId}/responses/{responseId} with { status: "countered" }
  //      — the store's state machine allows sent / viewed / countered →
  //      countered (accepted / rejected / expired are terminal).
  //   2. Best-effort: deliver the revised terms into the negotiation room
  //      for this post as a counter_offer message (the system of record
  //      for offer terms — the same message shape the room's own
  //      counter-offer form posts). When no room exists yet the response
  //      is still marked countered; the toast tells the user to open a room.
  const counterMut = useMutation({
    mutationFn: async (r: ResponseRow) => {
      const put = await fetch(`/api/marketplace/${r.post_id}/responses/${r.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "countered" }),
      });
      if (!put.ok) {
        const e = await put.json().catch(() => ({}));
        throw new Error(e.error || "Failed.");
      }
      const room = (negsQ.data?.items ?? []).find((n) => n.post_id === r.post_id);
      if (!room) return { roomId: null as string | null };
      const offerData: Record<string, unknown> = {};
      if (counterForm.quantity.trim()) offerData.quantity = Number(counterForm.quantity);
      if (counterForm.unit_price.trim()) {
        offerData.unit_price = Number(counterForm.unit_price);
        offerData.price = Number(counterForm.unit_price);
      }
      if (r.currency) offerData.currency = r.currency;
      const msg = await fetch(`/api/marketplace/negotiations/${room.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: counterForm.message.trim() || null,
          message_type: "counter_offer",
          ...(Object.keys(offerData).length > 0 ? { offer_data: offerData } : {}),
        }),
      });
      if (!msg.ok) {
        // Terms delivery failed — the response is still countered; the
        // terms can be re-sent manually from inside the room.
        return { roomId: null as string | null };
      }
      return { roomId: room.id };
    },
    onSuccess: (data) => {
      setCounterTarget(null);
      qc.invalidateQueries({ queryKey: ["marketplace-my-responses"] });
      if (data.roomId) {
        qc.invalidateQueries({ queryKey: ["marketplace-negotiation", data.roomId] });
        qc.invalidateQueries({ queryKey: ["marketplace-negotiations"] });
        toast.success(t("marketplace-counter-offer-terms-sent"));
        // Same room-navigation mechanism as the post-detail contact-seller
        // flow: room drill-down id + the negotiations view key.
        setSelectedId(null);
        setSelectedNegotiationId(data.roomId);
        setView("portal-marketplace-negotiations");
      } else {
        toast.warning(t("marketplace-counter-offer-no-room"));
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── 2-b — "Open negotiation" on accepted rows: find the existing room
  // for the post (shared with the counter flow); when none exists, create
  // one via POST /api/marketplace/negotiations { post_id, response_id }
  // (the responder-side creation path — the route resolves the post owner
  // as the counterparty; an owner-side creation would require the
  // responder's partner_id, which the sanitised received rows strip).
  const openNegotiation = useMutation({
    mutationFn: async (r: ResponseRow) => {
      const existing = (negsQ.data?.items ?? []).find((n) => n.post_id === r.post_id);
      if (existing) return { id: existing.id };
      const res = await fetch("/api/marketplace/negotiations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ post_id: r.post_id, response_id: r.id }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || "Failed to open negotiation.");
      }
      const created = await res.json();
      return { id: created.id as string };
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["marketplace-negotiations"] });
      setSelectedId(null);
      setSelectedNegotiationId(data.id);
      setView("portal-marketplace-negotiations");
      toast.success(t("marketplace-negotiation-room-opened"));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function openCounterDialog(r: ResponseRow) {
    setCounterTarget(r);
    // Prefill the counter terms from the ORIGINAL offer — the owner
    // tweaks the responder's numbers rather than retyping them.
    setCounterForm({
      quantity: r.quantity != null ? String(r.quantity) : "",
      unit_price: r.unit_price != null ? String(r.unit_price) : "",
      message: "",
    });
  }

  const sent = q.data?.sent ?? [];
  const received = q.data?.received ?? [];

  function renderRow(r: ResponseRow, isReceived: boolean) {
    return (
      <Card key={r.id}>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className={STATUS_CLASS[r.status] ?? ""}>
                {/* MARKET-M5 — defensive fallback: if the status isn't in the
                    STATUS_LABEL_KEY map (or t() returns the raw key because
                    the locale lacks the entry), fall back to rendering the
                    raw status string so the badge never shows a missing-
                    translation key like "marketplace-response-status-foo"
                    to the user. The raw status is human-readable enough for
                    an emergency fallback ("sent", "viewed", etc.). */}
                {t(STATUS_LABEL_KEY[r.status] || r.status) || r.status}
              </Badge>
              {r.is_counter && (
                <Badge variant="outline" className="text-xs">
                  {t("marketplace-counter")}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">{fmtRelative(r.created_at)}</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" variant="ghost" onClick={() => setSelectedId(r.post_id)}>
                {t("marketplace-view-post")}
              </Button>
              {/* 2-b — counter-offer: the state machine allows
                  sent / viewed / countered → countered; accepted /
                  rejected / expired are terminal. */}
              {isReceived &&
                (r.status === "sent" || r.status === "viewed" || r.status === "countered") && (
                <Button
                  size="sm"
                  variant="outline"
                  className="border-amber-500/40 text-amber-700 hover:bg-amber-500/10"
                  onClick={() => openCounterDialog(r)}
                  disabled={counterMut.isPending}
                >
                  <ArrowLeftRight className="h-3.5 w-3.5 mr-1" />
                  {t("marketplace-counter")}
                </Button>
              )}
              {/* 2-b — accepted rows get a one-click jump into the deal room. */}
              {r.status === "accepted" && (
                <Button
                  size="sm"
                  variant="outline"
                  className="border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/10"
                  onClick={() => openNegotiation.mutate(r)}
                  disabled={openNegotiation.isPending}
                >
                  {openNegotiation.isPending && openNegotiation.variables === r ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  ) : (
                    <MessageSquare className="h-3.5 w-3.5 mr-1" />
                  )}
                  {t("marketplace-negotiate")}
                </Button>
              )}
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
      ) : q.isError ? (
        // 2-b — previously a failed load fell through to the Tabs with both
        // lists empty, indistinguishable from "no offers". Retry instead.
        <div className="text-center py-16 text-muted-foreground">
          <p>{t("marketplace-responses-load-failed")}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void q.refetch()}
          >
            {t("portal-action-try-again")}
          </Button>
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

      {/* ─── 2-b — Counter-offer dialog ─────────────────────────────────── */}
      <Dialog open={!!counterTarget} onOpenChange={(o) => { if (!o && !counterMut.isPending) setCounterTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowLeftRight className="size-5 text-primary" />
              {t("marketplace-negotiation-counter-offer")}
            </DialogTitle>
            <DialogDescription>
              {t("marketplace-counter-offer-desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="co-qty">{t("marketplace-quantity")}</Label>
                <Input
                  id="co-qty"
                  type="number"
                  min="0"
                  value={counterForm.quantity}
                  onChange={(e) => setCounterForm({ ...counterForm, quantity: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="co-price">
                  {t("marketplace-unit-price")}{counterTarget?.currency ? ` (${counterTarget.currency})` : ""}
                </Label>
                <Input
                  id="co-price"
                  type="number"
                  min="0"
                  step="0.01"
                  value={counterForm.unit_price}
                  onChange={(e) => setCounterForm({ ...counterForm, unit_price: e.target.value })}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="co-msg">{t("marketplace-message")}</Label>
              <Textarea
                id="co-msg"
                rows={4}
                value={counterForm.message}
                onChange={(e) => setCounterForm({ ...counterForm, message: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setCounterTarget(null)}
              disabled={counterMut.isPending}
            >
              {t("portal-action-cancel")}
            </Button>
            <Button
              type="button"
              onClick={() => counterTarget && counterMut.mutate(counterTarget)}
              disabled={counterMut.isPending}
              className="gap-1.5"
            >
              {counterMut.isPending
                ? <Loader2 className="size-4 animate-spin" />
                : <ArrowLeftRight className="size-4" />}
              {t("marketplace-counter-offer-submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
