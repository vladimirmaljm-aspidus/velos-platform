"use client";

// Marketplace — Phase 2 negotiation rooms.
//
// This file exports TWO components, both used by the portal:
//
//   1. NegotiationRoom — the chat-like UI for a single negotiation.
//      Renders the message thread (text / offers / counter-offers /
//      accept / reject / document / system), an offer form, accept and
//      reject buttons on received offers, a contact-info card that
//      stays hidden until both parties have accepted the deal, the 48h
//      auto-expire warning banner, and a document-upload button.
//
//   2. NegotiationsBrowser — the list-vs-room router. Reads
//      `selectedNegotiationId` from the app-store (written by the deep
//      link on /portal/marketplace/negotiations/[id] or by a card click
//      inside the list). When set, renders NegotiationRoom. Otherwise
//      renders the list of the caller's negotiations with the four
//      filter tabs (active / accepted / rejected / expired) computed
//      via the negotiation-status helpers.
//
// Both exports live in this single file so the Phase 2 task's
// "create these 6 files only" rule is honoured — the room and the list
// share enough types + helpers that splitting them would either
// duplicate code or pull in a 7th module.

import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
// FIX-AUDIT3-MED-2 #1 — Dialog import for the cancel-negotiation
// confirmation prompt.
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  Loader2,
  Send,
  FileText,
  Check,
  X,
  Mail,
  Phone,
  Building2,
  User,
  Clock,
  AlertTriangle,
  Paperclip,
  MessageSquare,
  Inbox,
  Ban,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { useAppStore } from "@/lib/store/app-store";
import { toast } from "sonner";
import { fmtMoney, fmtDate, fmtRelative } from "@/lib/utils/format";
import {
  CURRENCIES,
  INCOTERMS,
  PAYMENT_TERMS,
  UNITS_OF_MEASURE,
  COUNTRIES,
} from "@/lib/data/reference";
import type {
  MarketplaceMessage,
  MarketplaceMessageType,
  MarketplaceNegotiation,
  MarketplaceOfferTerms,
} from "@/lib/supabase/marketplace-types";
import type { Partner } from "@/lib/supabase/types";
import type { MarketplacePublicPartner } from "@/lib/marketplace/privacy";
import {
  getNegotiationStatus,
  getTimeRemaining,
  type NegotiationDisplayStatus,
} from "@/lib/marketplace/negotiation-status";

// ────────────────────────────────────────────────────────────────────────────
// Shared types + helpers
// ────────────────────────────────────────────────────────────────────────────

/** Shape returned by GET /api/marketplace/negotiations/[id] (Phase 2). */
interface NegotiationDetailResponse {
  negotiation: MarketplaceNegotiation;
  /** Redacted when contact_revealed=false; full Partner when true. */
  counterparty: MarketplacePublicPartner | (Partner & { _full?: boolean }) | null;
  post: {
    id: string;
    product_name: string;
    post_type: string;
    quantity: number;
    unit: string;
    currency: string;
    target_price: number | null;
  } | null;
  callerSide: "A" | "B";
}

/** Shape returned by GET /api/marketplace/negotiations (list). */
type NegotiationListItem = MarketplaceNegotiation;

/** Shape returned by GET /api/marketplace/negotiations/[id]/messages. */
interface MessagesListResponse {
  items: MarketplaceMessage[];
}

const STATUS_LABEL_KEY: Record<NegotiationDisplayStatus, string> = {
  active: "marketplace-negotiation-status-active",
  awaiting: "marketplace-negotiation-status-awaiting",
  accepted: "marketplace-negotiation-status-accepted",
  rejected: "marketplace-negotiation-status-rejected",
  expired: "marketplace-negotiation-status-expired",
};

const STATUS_CLASS: Record<NegotiationDisplayStatus, string> = {
  active: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400",
  awaiting: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
  accepted: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  rejected: "border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-400",
  expired: "border-transparent bg-muted text-muted-foreground",
};

const MESSAGE_TYPE_LABEL_KEY: Record<MarketplaceMessageType, string> = {
  text: "marketplace-negotiation-message-placeholder",
  offer: "marketplace-negotiation-make-offer",
  counter_offer: "marketplace-negotiation-counter-offer",
  accept: "marketplace-negotiation-accept-offer",
  reject: "marketplace-negotiation-reject-offer",
  document: "marketplace-negotiation-upload-document",
  system: "marketplace-negotiation-system-opened",
};

/** Parse the JSON `offer_data` blob on a message into a typed shape.
 *  Returns null when the blob is missing / malformed — the caller falls
 *  back to a plain-text rendering of the message body. */
function parseOfferData(msg: MarketplaceMessage): MarketplaceOfferTerms | null {
  if (!msg.offer_data) return null;
  const d = msg.offer_data as Record<string, unknown>;
  // Be permissive — the form posts `price` (UI label) but the canonical
  // DB field is `unit_price`; accept either.
  const price =
    typeof d.price === "number" ? d.price :
    typeof d.unit_price === "number" ? d.unit_price : null;
  return {
    quantity: typeof d.quantity === "number" ? d.quantity : null,
    unit: typeof d.unit === "string" ? d.unit : null,
    unit_price: price,
    price,
    currency: typeof d.currency === "string" ? d.currency : null,
    incoterm: typeof d.incoterm === "string" ? d.incoterm : null,
    payment_terms: typeof d.payment_terms === "string" ? d.payment_terms : null,
    delivery_country: typeof d.delivery_country === "string" ? d.delivery_country : null,
    delivery_location: typeof d.delivery_location === "string" ? d.delivery_location : null,
    delivery_port: typeof d.delivery_port === "string" ? d.delivery_port : null,
    delivery_date: typeof d.delivery_date === "string" ? d.delivery_date : null,
  };
}

/** Country name lookup helper (null-safe). */
function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  const c = COUNTRIES.find((x) => x.code === code);
  return c ? c.name : code;
}

// ────────────────────────────────────────────────────────────────────────────
// NegotiationRoom — single chat room
// ────────────────────────────────────────────────────────────────────────────

export function NegotiationRoom({ negotiationId }: { negotiationId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const setSelectedNegotiationId = useAppStore((s) => s.setSelectedNegotiationId);

  // ── Data: negotiation + counterparty + post ────────────────────────────
  const detailQ = useQuery<NegotiationDetailResponse>({
    queryKey: ["marketplace-negotiation", negotiationId],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/negotiations/${negotiationId}`);
      if (!r.ok) throw new Error("Failed to load negotiation.");
      return r.json();
    },
    refetchInterval: 20_000,
  });

  // ── Data: messages ──────────────────────────────────────────────────────
  const msgsQ = useQuery<MessagesListResponse>({
    queryKey: ["marketplace-negotiation-messages", negotiationId],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/negotiations/${negotiationId}/messages`);
      if (!r.ok) throw new Error("Failed to load messages.");
      return r.json();
    },
    refetchInterval: 8_000, // poll for new messages from the counterparty
  });

  // ── State: text message input + offer form (collapsible) ───────────────
  const [textMsg, setTextMsg] = useState("");
  const [showOfferForm, setShowOfferForm] = useState(false);
  const [offer, setOffer] = useState({
    quantity: "",
    price: "",
    currency: "USD",
    delivery_date: "",
    incoterm: "",
    payment_terms: "",
  });
  // FIX-AUDIT3-MED-2 #1 — controls the cancel-negotiation confirmation
  // dialog. The dialog is opened by the "Cancel negotiation" button in
  // the room header and closed either by the confirm button (which fires
  // the cancel mutation) or by the cancel button / backdrop / Escape key.
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  // ── Auto-scroll the message thread to the bottom on new messages ──────
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const messages = msgsQ.data?.items ?? [];
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  // ── Mutation: send a text message ───────────────────────────────────────
  const sendText = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/marketplace/negotiations/${negotiationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: textMsg, message_type: "text" }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to send message.");
      }
      return r.json();
    },
    onSuccess: () => {
      setTextMsg("");
      qc.invalidateQueries({ queryKey: ["marketplace-negotiation-messages", negotiationId] });
      qc.invalidateQueries({ queryKey: ["marketplace-negotiation", negotiationId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── Mutation: send an offer / counter-offer ─────────────────────────────
  const sendOffer = useMutation({
    mutationFn: async (vars: { type: "offer" | "counter_offer" }) => {
      const offerData: MarketplaceOfferTerms = {
        quantity: offer.quantity ? Number(offer.quantity) : null,
        unit: null,
        price: offer.price ? Number(offer.price) : null,
        unit_price: offer.price ? Number(offer.price) : null,
        currency: offer.currency || null,
        incoterm: offer.incoterm || null,
        payment_terms: offer.payment_terms || null,
        delivery_date: offer.delivery_date
          ? new Date(offer.delivery_date).toISOString()
          : null,
      };
      const r = await fetch(`/api/marketplace/negotiations/${negotiationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: null,
          message_type: vars.type,
          offer_data: offerData,
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to send offer.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-negotiation-offer-sent-toast"));
      setShowOfferForm(false);
      setOffer({
        quantity: "", price: "", currency: "USD",
        delivery_date: "", incoterm: "", payment_terms: "",
      });
      qc.invalidateQueries({ queryKey: ["marketplace-negotiation-messages", negotiationId] });
      qc.invalidateQueries({ queryKey: ["marketplace-negotiation", negotiationId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── Mutation: accept / reject a received offer ──────────────────────────
  // Implemented as a marketplace_message of type 'accept' / 'reject'.
  // The messages API route flips `contact_revealed = true` on the
  // negotiation when the SECOND accept message arrives — the UI just
  // posts the message and lets the server do the handshake.
  const sendDecision = useMutation({
    mutationFn: async (vars: { type: "accept" | "reject"; messageId: string }) => {
      const r = await fetch(`/api/marketplace/negotiations/${negotiationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: null,
          message_type: vars.type,
          offer_data: { in_reply_to: vars.messageId },
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to send decision.");
      }
      return r.json();
    },
    onSuccess: (_data, vars) => {
      toast.success(t(`marketplace-negotiation-${vars.type === "accept" ? "accept-sent" : "reject-sent"}`));
      qc.invalidateQueries({ queryKey: ["marketplace-negotiation-messages", negotiationId] });
      qc.invalidateQueries({ queryKey: ["marketplace-negotiation", negotiationId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── Mutation: upload a document + post a 'document' message ────────────
  const uploadDoc = useMutation({
    mutationFn: async (file: File) => {
      // Step 1: upload the file to the portal-uploads bucket.
      const fd = new FormData();
      fd.append("file", file);
      fd.append("category", "general");
      fd.append("doc_type", "marketplace_negotiation");
      fd.append("description", `Negotiation ${negotiationId}`);
      const up = await fetch("/api/portal/upload", { method: "POST", body: fd });
      if (!up.ok) {
        const e = await up.json().catch(() => ({}));
        throw new Error(e.error || "Upload failed.");
      }
      const upRow = await up.json();
      // 2b2-F1 — point at the new portal-side download route
      // `/api/portal/attachments/<id>` (handled by
      // `src/app/api/portal/attachments/[id]/route.ts`, which uses
      // `getPortalSessionAccess`). The previous code used
      // `/api/portal-uploads/<id>/download` (plural admin route, gated
      // by `requireAuth` + `requirePermission("portal-uploads.download")`),
      // so a portal_client session cookie would 401 on download — the
      // other party to the negotiation could never retrieve the file.
      // The new route verifies `tenant_id` + (partner_id OR
      // marketplace_negotiation party membership) before signing.
      const attachmentUrl = `/api/portal/attachments/${upRow.id}`;
      // Step 2: post a marketplace_message with type='document'.
      const r = await fetch(`/api/marketplace/negotiations/${negotiationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: file.name,
          message_type: "document",
          attachment_url: attachmentUrl,
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to post document message.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-negotiation-message-sent"));
      qc.invalidateQueries({ queryKey: ["marketplace-negotiation-messages", negotiationId] });
      qc.invalidateQueries({ queryKey: ["marketplace-negotiation", negotiationId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── Mutation: cancel the negotiation (FIX-AUDIT3-MED-2 #1) ────────────
  // Either party can proactively close a negotiation that has gone stale.
  // The backend route gates on accepted-offer / terminal-status and inserts
  // a system message + audit log entry. On success we invalidate the
  // negotiation detail + messages + the negotiations LIST queries so the
  // caller's inbox updates immediately (the cancelled negotiation moves
  // from the "active" tab to the "rejected" tab, since the UI collapses
  // the cancelled + rejected display statuses).
  const cancelNegotiation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/marketplace/negotiations/${negotiationId}/cancel`, {
        method: "POST",
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to cancel negotiation.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-negotiation-cancel-success"));
      setCancelDialogOpen(false);
      qc.invalidateQueries({ queryKey: ["marketplace-negotiation", negotiationId] });
      qc.invalidateQueries({ queryKey: ["marketplace-negotiation-messages", negotiationId] });
      // Invalidate the negotiations LIST query too so the inbox tab
      // (active / accepted / rejected / expired) re-fetches and the
      // cancelled negotiation moves to the right tab.
      qc.invalidateQueries({ queryKey: ["marketplace-negotiations"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── Derived state ────────────────────────────────────────────────────────
  const negotiation = detailQ.data?.negotiation;
  const counterparty = detailQ.data?.counterparty;
  const post = detailQ.data?.post;
  const callerSide = detailQ.data?.callerSide ?? "A";

  const status: NegotiationDisplayStatus = negotiation
    ? getNegotiationStatus(negotiation)
    : "active";
  const timeRemaining = negotiation ? getTimeRemaining(negotiation) : "—";
  const isExpired = status === "expired";
  const isAccepted = status === "accepted";
  const isRejected = status === "rejected";
  // Disable the input + offer form when the negotiation is in a terminal
  // state — no new messages can be sent on an expired / accepted / rejected
  // negotiation.
  const inputDisabled = isExpired || isAccepted || isRejected;

  // The OTHER party's partner_id (so we can identify which messages in the
  // thread belong to the counterparty vs. the caller).
  const otherPartnerId = negotiation
    ? (callerSide === "A" ? negotiation.partner_id_b : negotiation.partner_id_a)
    : null;

  // Whether the LAST received message is an offer/counter_offer — drives
  // the offer-form button label ("Make an offer" vs. "Counter offer") and
  // whether accept/reject buttons appear on it.
  const lastReceivedOffer = useMemo(() => {
    const list = messages;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.sender_partner_id === otherPartnerId &&
          (m.message_type === "offer" || m.message_type === "counter_offer")) {
        return m;
      }
    }
    return null;
  }, [messages, otherPartnerId]);

  // ── Loading / error gates ───────────────────────────────────────────────
  if (detailQ.isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (detailQ.isError || !negotiation) {
    return (
      <div className="text-center py-20">
        <p className="text-muted-foreground">{t("marketplace-negotiation-not-found")}</p>
        <Button variant="outline" className="mt-3" onClick={() => setSelectedNegotiationId(null)}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          {t("marketplace-negotiation-back")}
        </Button>
      </div>
    );
  }

  // Counterparty display name — falls back to a generic label when the
  // redacted shape is missing (e.g. the partner row was hard-deleted).
  const counterpartyName =
    (counterparty as { name?: string } | null)?.name ??
    t("marketplace-negotiation-other-party");
  const counterpartyCountry =
    (counterparty as { country?: string | null } | null)?.country ?? null;

  return (
    <div className="space-y-4">
      {/* Back button + Cancel negotiation action (FIX-AUDIT3-MED-2 #1) */}
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={() => setSelectedNegotiationId(null)}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          {t("marketplace-negotiation-back")}
        </Button>
        {/* The cancel button only shows for non-terminal negotiations —
            `inputDisabled` covers expired / accepted / rejected (and
            cancelled, which the status helper collapses into rejected).
            When the negotiation has an accepted offer, the backend will
            refuse the cancel with a 409 anyway (defence-in-depth), but the
            UI hides the button entirely in that case so the user isn't
            offered an action that will fail. */}
        {!inputDisabled && (
          <Button
            variant="outline"
            size="sm"
            className="text-rose-700 dark:text-rose-400 border-rose-500/40 hover:bg-rose-500/10"
            onClick={() => setCancelDialogOpen(true)}
          >
            <Ban className="h-4 w-4 mr-1" />
            {t("marketplace-negotiation-cancel")}
          </Button>
        )}
      </div>

      {/* Header — counterparty + status + expiry */}
      <Card>
        <CardContent className="p-4 sm:p-6">
          <div className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
                  <MessageSquare className="h-5 w-5 text-muted-foreground" />
                  {t("marketplace-negotiation-room")}
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                  {t("marketplace-negotiation-with")}{" "}
                  <span className="font-medium text-foreground">{counterpartyName}</span>
                  {counterpartyCountry && (
                    <span className="ml-1 text-muted-foreground">
                      ({countryName(counterpartyCountry) ?? counterpartyCountry})
                    </span>
                  )}
                </p>
              </div>
              <Badge variant="outline" className={STATUS_CLASS[status]}>
                {t(STATUS_LABEL_KEY[status])}
              </Badge>
            </div>

            {/* Post chip */}
            {post && (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                <span className="text-xs text-muted-foreground mr-2">
                  {t("marketplace-negotiation-product")}:
                </span>
                <span className="font-medium">{post.product_name}</span>
                <span className="text-xs text-muted-foreground ml-2">
                  · {post.quantity.toLocaleString()} {post.unit}
                  {post.target_price != null && (
                    <> · {fmtMoney(post.target_price, post.currency)}</>
                  )}
                </span>
              </div>
            )}

            {/* Meta row — opened + last activity + time remaining */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm pt-2 border-t">
              <div>
                <p className="text-xs text-muted-foreground">{t("marketplace-negotiation-opened")}</p>
                <p className="font-medium flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  {fmtRelative(negotiation.created_at)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t("marketplace-negotiation-last-activity")}</p>
                <p className="font-medium flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  {fmtRelative(negotiation.last_message_at ?? negotiation.created_at)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t("marketplace-negotiation-expires-in")}</p>
                <p className={`font-medium flex items-center gap-1 ${
                  timeRemaining === "expired" ? "text-rose-600 dark:text-rose-400" : ""
                }`}>
                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  {timeRemaining}
                </p>
              </div>
            </div>

            {/* Auto-expire warning — only when within 8h of expiry AND the
                negotiation is still active / awaiting. The negotiation-status
                helpers' getTimeRemaining() returns "expired" the moment the
                48h window elapses, so we don't need to recompute the cutoff
                here. */}
            {!isAccepted && !isRejected && !isExpired && (() => {
              const m = timeRemaining.match(/^(\d+)([hm]) remaining$/);
              if (!m) return null;
              const value = Number(m[1]);
              const unit = m[2];
              const hoursLeft = unit === "h" ? value : value / 60;
              if (hoursLeft >= 8) return null;
              return (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-amber-700 dark:text-amber-400">
                      {timeRemaining}
                    </p>
                    <p className="text-xs text-amber-700/80 dark:text-amber-400/80">
                      {t("marketplace-negotiation-expired-warning")}
                    </p>
                  </div>
                </div>
              );
            })()}
          </div>
        </CardContent>
      </Card>

      {/* Contact info section — hidden until contact_revealed = true */}
      <ContactInfoCard
        counterparty={counterparty ?? null}
        revealed={negotiation.contact_revealed}
        t={t}
      />

      {/* Message thread */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            {t("marketplace-negotiations-title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {msgsQ.isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : messages.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-8">
              {t("marketplace-negotiation-no-messages")}
            </p>
          ) : (
            <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
              {messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  msg={m}
                  isOwn={m.sender_partner_id !== otherPartnerId}
                  t={t}
                  onAccept={(mid) => sendDecision.mutate({ type: "accept", messageId: mid })}
                  onReject={(mid) => sendDecision.mutate({ type: "reject", messageId: mid })}
                  isPending={sendDecision.isPending}
                  disableActions={inputDisabled}
                />
              ))}
              <div ref={threadEndRef} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Input area — disabled when the negotiation is terminal */}
      <Card>
        <CardContent className="p-4 space-y-3">
          {/* Offer form (collapsible) */}
          {showOfferForm && !inputDisabled && (
            <div className="rounded-md border bg-muted/20 p-3 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="o-qty">{t("marketplace-negotiation-offer-quantity")}</Label>
                  <Input
                    id="o-qty"
                    type="number"
                    value={offer.quantity}
                    onChange={(e) => setOffer({ ...offer, quantity: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="o-price">{t("marketplace-negotiation-offer-price")}</Label>
                  <Input
                    id="o-price"
                    type="number"
                    value={offer.price}
                    onChange={(e) => setOffer({ ...offer, price: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="o-cur">{t("marketplace-negotiation-offer-currency")}</Label>
                  <Select value={offer.currency} onValueChange={(v) => setOffer({ ...offer, currency: v })}>
                    <SelectTrigger id="o-cur"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.slice(0, 12).map((c) => (
                        <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="o-ddate">{t("marketplace-negotiation-offer-delivery-date")}</Label>
                  <Input
                    id="o-ddate"
                    type="date"
                    value={offer.delivery_date}
                    onChange={(e) => setOffer({ ...offer, delivery_date: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="o-inco">{t("marketplace-negotiation-offer-incoterm")}</Label>
                  <Select value={offer.incoterm} onValueChange={(v) => setOffer({ ...offer, incoterm: v })}>
                    <SelectTrigger id="o-inco"><SelectValue placeholder="—" /></SelectTrigger>
                    <SelectContent>
                      {INCOTERMS.map((i) => (
                        <SelectItem key={i.code} value={i.code}>{i.code} — {i.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="o-pay">{t("marketplace-negotiation-offer-payment-terms")}</Label>
                  <Select value={offer.payment_terms} onValueChange={(v) => setOffer({ ...offer, payment_terms: v })}>
                    <SelectTrigger id="o-pay"><SelectValue placeholder="—" /></SelectTrigger>
                    <SelectContent>
                      {PAYMENT_TERMS.map((p) => (
                        <SelectItem key={p.code} value={p.code}>{p.code} — {p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => sendOffer.mutate({ type: lastReceivedOffer ? "counter_offer" : "offer" })}
                  disabled={sendOffer.isPending}
                >
                  {sendOffer.isPending
                    ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    : <Send className="h-4 w-4 mr-1" />}
                  {lastReceivedOffer
                    ? t("marketplace-negotiation-counter-offer")
                    : t("marketplace-negotiation-make-offer")}
                </Button>
                <Button variant="outline" onClick={() => setShowOfferForm(false)}>
                  {t("portal-action-cancel")}
                </Button>
              </div>
            </div>
          )}

          {/* Action row: offer / upload / text input + send */}
          {!inputDisabled && (
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowOfferForm((v) => !v)}
                disabled={sendOffer.isPending}
              >
                {lastReceivedOffer
                  ? t("marketplace-negotiation-counter-offer")
                  : t("marketplace-negotiation-make-offer")}
              </Button>
              <DocumentUploadButton
                disabled={uploadDoc.isPending}
                onFile={(f) => uploadDoc.mutate(f)}
                label={t("marketplace-negotiation-upload-document")}
              />
            </div>
          )}
          {inputDisabled && (
            <p className="text-xs text-muted-foreground italic">
              {isExpired
                ? t("marketplace-negotiation-expired-warning")
                : isAccepted
                  ? t("marketplace-negotiation-both-accepted")
                  : t("marketplace-negotiation-reject-sent")}
            </p>
          )}

          {!inputDisabled && (
            <div className="flex items-end gap-2">
              <Textarea
                value={textMsg}
                onChange={(e) => setTextMsg(e.target.value)}
                placeholder={t("marketplace-negotiation-message-placeholder")}
                rows={2}
                className="flex-1"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (textMsg.trim() && !sendText.isPending) sendText.mutate();
                  }
                }}
              />
              <Button
                onClick={() => sendText.mutate()}
                disabled={!textMsg.trim() || sendText.isPending}
              >
                {sendText.isPending
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Send className="h-4 w-4" />}
                <span className="ml-1 sr-only">{t("marketplace-negotiation-send-message")}</span>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Cancel-negotiation confirmation dialog (FIX-AUDIT3-MED-2 #1).
          Opens when the user clicks the "Cancel negotiation" button in the
          header. The dialog uses the standard shadcn Dialog pattern. The
          confirm button is destructive-styled + shows a spinner while the
          cancel mutation is in flight. */}
      <Dialog open={cancelDialogOpen} onOpenChange={(o) => {
        if (!o && !cancelNegotiation.isPending) setCancelDialogOpen(false);
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Ban className="h-4 w-4 text-rose-600" />
              {t("marketplace-negotiation-cancel-confirm-title")}
            </DialogTitle>
            <DialogDescription>
              {t("marketplace-negotiation-cancel-confirm-desc")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setCancelDialogOpen(false)}
              disabled={cancelNegotiation.isPending}
            >
              {t("portal-action-cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => cancelNegotiation.mutate()}
              disabled={cancelNegotiation.isPending}
            >
              {cancelNegotiation.isPending
                ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                : <Ban className="h-4 w-4 mr-1" />}
              {t("marketplace-negotiation-cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────────

/** A single message bubble. Renders differently per message_type. */
function MessageBubble({
  msg,
  isOwn,
  t,
  onAccept,
  onReject,
  isPending,
  disableActions,
}: {
  msg: MarketplaceMessage;
  isOwn: boolean;
  t: (k: string) => string;
  onAccept: (messageId: string) => void;
  onReject: (messageId: string) => void;
  isPending: boolean;
  disableActions: boolean;
}) {
  // System messages render centered + muted, no bubble.
  if (msg.message_type === "system") {
    return (
      <div className="text-center my-2">
        <span className="text-xs text-muted-foreground italic">
          {msg.message || t("marketplace-negotiation-system-opened")}
        </span>
      </div>
    );
  }

  const offer = parseOfferData(msg);
  const isOffer = msg.message_type === "offer" || msg.message_type === "counter_offer";
  const isAccept = msg.message_type === "accept";
  const isReject = msg.message_type === "reject";
  const isDocument = msg.message_type === "document";

  // Accept/reject bubbles render with a colored background + icon.
  const decisionCls = isAccept
    ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
    : isReject
      ? "bg-rose-500/10 border-rose-500/40 text-rose-700 dark:text-rose-400"
      : "";

  return (
    <div className={`flex ${isOwn ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] sm:max-w-[70%] ${isOwn ? "items-end" : "items-start"} flex flex-col gap-1`}>
        <div className={`rounded-lg px-3 py-2 text-sm ${
          isOffer
            ? (msg.message_type === "counter_offer"
                ? "border border-amber-500/40 bg-amber-500/5"
                : "border border-sky-500/40 bg-sky-500/5")
            : isAccept || isReject
              ? `border ${decisionCls}`
              : isDocument
                ? "border border-violet-500/40 bg-violet-500/5"
                : isOwn
                  ? "bg-primary/10"
                  : "bg-muted"
        }`}>
          {/* Sender + type chip */}
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs text-muted-foreground">
              {isOwn ? t("marketplace-negotiation-you") : t("marketplace-negotiation-other-party")}
            </span>
            {isOffer && (
              <Badge variant="outline" className="text-xs py-0 px-1.5 h-4">
                {msg.message_type === "counter_offer"
                  ? t("marketplace-negotiation-counter-offer")
                  : t("marketplace-negotiation-make-offer")}
              </Badge>
            )}
          </div>

          {/* Offer terms (when present) */}
          {offer && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-1">
              {offer.quantity != null && (
                <div>
                  <span className="text-muted-foreground">{t("marketplace-quantity")}: </span>
                  <span className="font-medium">{offer.quantity.toLocaleString()}</span>
                </div>
              )}
              {offer.unit_price != null && (
                <div>
                  <span className="text-muted-foreground">{t("marketplace-unit-price")}: </span>
                  <span className="font-medium">{fmtMoney(offer.unit_price, offer.currency ?? "USD")}</span>
                </div>
              )}
              {offer.delivery_date && (
                <div>
                  <span className="text-muted-foreground">{t("marketplace-delivery-date")}: </span>
                  <span className="font-medium">{fmtDate(offer.delivery_date)}</span>
                </div>
              )}
              {offer.incoterm && (
                <div>
                  <span className="text-muted-foreground">{t("marketplace-incoterm")}: </span>
                  <span className="font-medium">{offer.incoterm}</span>
                </div>
              )}
              {offer.payment_terms && (
                <div className="col-span-2">
                  <span className="text-muted-foreground">{t("marketplace-payment-terms")}: </span>
                  <span className="font-medium">{offer.payment_terms}</span>
                </div>
              )}
            </div>
          )}

          {/* Document download link */}
          {isDocument && msg.attachment_url && (
            <a
              href={msg.attachment_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-violet-700 dark:text-violet-400 hover:underline"
            >
              <FileText className="h-3.5 w-3.5" />
              {msg.message || t("marketplace-negotiation-document-attached")}
            </a>
          )}

          {/* Plain text body (text + accept + reject + document label) */}
          {msg.message && !isDocument && (
            <p className="whitespace-pre-wrap">{msg.message}</p>
          )}

          {/* Timestamp */}
          <p className="text-xs text-muted-foreground mt-1">
            {fmtRelative(msg.created_at)}
          </p>
        </div>

        {/* Accept / Reject buttons — only on RECEIVED offers (not own,
            not on decisions, not on documents) AND when the negotiation
            is still active / awaiting. */}
        {isOffer && !isOwn && !disableActions && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/10 h-7"
              onClick={() => onAccept(msg.id)}
              disabled={isPending}
            >
              <Check className="h-3 w-3 mr-1" />
              {t("marketplace-negotiation-accept-offer")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="border-rose-500/40 text-rose-700 hover:bg-rose-500/10 h-7"
              onClick={() => onReject(msg.id)}
              disabled={isPending}
            >
              <X className="h-3 w-3 mr-1" />
              {t("marketplace-negotiation-reject-offer")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Document upload button — opens a hidden file input + posts the file. */
function DocumentUploadButton({
  disabled,
  onFile,
  label,
}: {
  disabled: boolean;
  onFile: (f: File) => void;
  label: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {disabled
          ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          : <Paperclip className="h-3.5 w-3.5 mr-1" />}
        {label}
      </Button>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          // Clear so the same file can be re-selected.
          if (inputRef.current) inputRef.current.value = "";
        }}
      />
    </>
  );
}

/** Contact info card — hidden until contact_revealed. Renders the
 *  counterparty's name / email / phone / contact person when revealed,
 *  and a "hidden until accepted" hint otherwise. */
function ContactInfoCard({
  counterparty,
  revealed,
  t,
}: {
  counterparty: MarketplacePublicPartner | (Partner & { _full?: boolean }) | null;
  revealed: boolean;
  t: (k: string) => string;
}) {
  if (!counterparty) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Building2 className="h-4 w-4" />
          {t("marketplace-negotiation-contact-info")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!revealed ? (
          <p className="text-sm text-muted-foreground italic">
            <AlertTriangle className="h-4 w-4 inline mr-1 -mt-0.5 text-amber-600" />
            {t("marketplace-negotiation-contact-hidden")}
          </p>
        ) : (
          <div className="space-y-2 text-sm">
            <p className="text-emerald-700 dark:text-emerald-400 font-medium">
              {t("marketplace-negotiation-contact-revealed-info")}
            </p>
            <Separator />
            <ContactRow
              icon={Building2}
              label={t("marketplace-negotiation-company")}
              value={(counterparty as { name?: string }).name ?? "—"}
            />
            <ContactRow
              icon={Mail}
              label={t("marketplace-negotiation-email")}
              value={(counterparty as { email?: string | null }).email ?? null}
            />
            <ContactRow
              icon={Phone}
              label={t("marketplace-negotiation-phone")}
              value={(counterparty as { phone?: string | null }).phone ?? null}
            />
            <ContactRow
              icon={User}
              label={t("marketplace-negotiation-contact-person")}
              value={(counterparty as { contact_name?: string | null }).contact_name ?? null}
            />
            <ContactRow
              icon={Mail}
              label={`${t("marketplace-negotiation-contact-person")} — ${t("marketplace-negotiation-email")}`}
              value={(counterparty as { contact_email?: string | null }).contact_email ?? null}
            />
            <ContactRow
              icon={Phone}
              label={`${t("marketplace-negotiation-contact-person")} — ${t("marketplace-negotiation-phone")}`}
              value={(counterparty as { contact_phone?: string | null }).contact_phone ?? null}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ContactRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | null;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground inline-flex items-center gap-2">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      <span className="font-medium text-right">{value ?? "—"}</span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// NegotiationsBrowser — list + room router
// ────────────────────────────────────────────────────────────────────────────

export function NegotiationsBrowser() {
  const t = useT();
  const selectedNegotiationId = useAppStore((s) => s.selectedNegotiationId);

  // When a deep-link lands on /portal/marketplace/negotiations/[id],
  // PortalShell writes the id into the store; we render the room.
  if (selectedNegotiationId) {
    return <NegotiationRoom negotiationId={selectedNegotiationId} />;
  }

  // Otherwise — render the list.
  return <NegotiationsList />;
}

/** List view — the caller's negotiations with status filter tabs. */
function NegotiationsList() {
  const t = useT();
  const setSelectedNegotiationId = useAppStore((s) => s.setSelectedNegotiationId);
  const [tab, setTab] = useState<NegotiationDisplayStatus>("active");

  const q = useQuery<{ items: NegotiationListItem[] }>({
    queryKey: ["marketplace-negotiations"],
    queryFn: async () => {
      const r = await fetch("/api/marketplace/negotiations");
      if (!r.ok) throw new Error("Failed to load negotiations.");
      return r.json();
    },
  });

  const all = q.data?.items ?? [];

  // Bucket each negotiation into one of the 4 display-status tabs via
  // the negotiation-status helper. The "active" tab includes both
  // active + awaiting (the helper distinguishes them, but the list view
  // groups them under the same tab — the row badge still surfaces the
  // finer-grained state).
  const buckets = useMemo(() => {
    const out: Record<NegotiationDisplayStatus, NegotiationListItem[]> = {
      active: [],
      awaiting: [],
      accepted: [],
      rejected: [],
      expired: [],
    };
    for (const n of all) {
      const s = getNegotiationStatus(n);
      // Fold "awaiting" into the "active" tab — the badge on the row
      // still shows the awaiting state.
      if (s === "awaiting") out.active.push(n);
      else out[s].push(n);
    }
    return out;
  }, [all]);

  const activeItems = buckets.active;
  const acceptedItems = buckets.accepted;
  const rejectedItems = buckets.rejected;
  const expiredItems = buckets.expired;

  const renderRow = (n: NegotiationListItem) => {
    const status: NegotiationDisplayStatus = getNegotiationStatus(n);
    const timeRemaining = getTimeRemaining(n);
    return (
      <Card
        key={n.id}
        className="cursor-pointer hover:border-primary/40 transition-colors"
        onClick={() => setSelectedNegotiationId(n.id)}
      >
        <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <Badge variant="outline" className={STATUS_CLASS[status]}>
                {t(STATUS_LABEL_KEY[status])}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {fmtRelative(n.last_message_at ?? n.created_at)}
              </span>
            </div>
            <p className="font-medium truncate">
              {t("marketplace-negotiation-room")} #{n.id.slice(0, 8)}
            </p>
            <div className="text-xs text-muted-foreground mt-1 flex items-center gap-3 flex-wrap">
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {t("marketplace-negotiation-expires-in")}: {timeRemaining}
              </span>
              <span>
                {t("marketplace-negotiation-opened")}: {fmtRelative(n.created_at)}
              </span>
            </div>
          </div>
          <Button size="sm" variant="outline">
            {t("marketplace-negotiation-open-room")}
          </Button>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Inbox className="h-6 w-6" />
          {t("marketplace-negotiations-title")}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t("marketplace-negotiations-subtitle")}
        </p>
      </div>

      {q.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(v as NegotiationDisplayStatus)}>
          <TabsList>
            <TabsTrigger value="active" className="gap-1">
              {t("marketplace-negotiations-tab-active")}
              <Badge variant="secondary" className="ml-1 text-xs py-0 px-1.5 h-4">
                {activeItems.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="accepted" className="gap-1">
              {t("marketplace-negotiations-tab-accepted")}
              <Badge variant="secondary" className="ml-1 text-xs py-0 px-1.5 h-4">
                {acceptedItems.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="rejected" className="gap-1">
              {t("marketplace-negotiations-tab-rejected")}
              <Badge variant="secondary" className="ml-1 text-xs py-0 px-1.5 h-4">
                {rejectedItems.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="expired" className="gap-1">
              {t("marketplace-negotiations-tab-expired")}
              <Badge variant="secondary" className="ml-1 text-xs py-0 px-1.5 h-4">
                {expiredItems.length}
              </Badge>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="active" className="mt-4 space-y-3">
            {activeItems.length === 0 ? (
              <EmptyState t={t} />
            ) : (
              activeItems.map(renderRow)
            )}
          </TabsContent>
          <TabsContent value="accepted" className="mt-4 space-y-3">
            {acceptedItems.length === 0 ? (
              <EmptyState t={t} />
            ) : (
              acceptedItems.map(renderRow)
            )}
          </TabsContent>
          <TabsContent value="rejected" className="mt-4 space-y-3">
            {rejectedItems.length === 0 ? (
              <EmptyState t={t} />
            ) : (
              rejectedItems.map(renderRow)
            )}
          </TabsContent>
          <TabsContent value="expired" className="mt-4 space-y-3">
            {expiredItems.length === 0 ? (
              <EmptyState t={t} />
            ) : (
              expiredItems.map(renderRow)
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function EmptyState({ t }: { t: (k: string) => string }) {
  return (
    <div className="text-center py-12">
      <Inbox className="h-10 w-10 text-muted-foreground mx-auto mb-2 opacity-50" />
      <p className="text-muted-foreground">{t("marketplace-negotiations-empty")}</p>
    </div>
  );
}
