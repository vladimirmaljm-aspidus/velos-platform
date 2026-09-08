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
import { Checkbox } from "@/components/ui/checkbox";
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
  ArrowRight,
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
  Plus,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Gavel,
  Truck,
  Landmark,
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
// 2-b — deal-room types. `MarketplaceNegotiationListItem` is a TYPE-ONLY
// import from the (server) data store: TypeScript erases it at compile
// time so no server code lands in the client bundle — the same pattern
// the orphaned document-generator.tsx / document-checklist.tsx already
// use for TradeDocument.
import type { MarketplaceNegotiationListItem } from "@/lib/data/marketplace-store";
import type { TradeDocument } from "@/lib/data/marketplace-trade-documents-store";
import type { Shipment } from "@/lib/supabase/marketplace-logistics-types";
import { CONTAINER_TYPE_LABELS, type ContainerType } from "@/lib/supabase/marketplace-logistics-types";
import type {
  FinancialInstrument,
  InstrumentType,
  InstrumentStatus,
  LCType,
  EscrowReleaseCondition,
  TriggerCondition,
} from "@/lib/supabase/marketplace-finance-types";
import {
  INSTRUMENT_TYPE_LABEL_KEY,
  INSTRUMENT_STATUS_LABEL_KEY,
  LC_TYPE_LABEL_KEY,
  ESCROW_RELEASE_CONDITION_LABEL_KEY,
  TRIGGER_CONDITION_LABEL_KEY,
} from "@/lib/supabase/marketplace-finance-types";
import {
  getNegotiationStatus,
  getTimeRemaining,
  type NegotiationDisplayStatus,
} from "@/lib/marketplace/negotiation-status";
import { useMarketplacePermissions } from "@/lib/portal/use-marketplace-permissions";
import { CommunicationLockedCard } from "./communication-locked";
// 2-b — deal-room mounts: the six previously-orphaned deal components.
import { DocumentChecklist } from "./document-checklist";
import { DocumentGenerator } from "./document-generator";
import { ShipmentTracker } from "./shipment-tracker";
import { PaymentSchedule } from "./payment-schedule";
import { EscrowStatus } from "./escrow-status";
import { FinanceCalculators } from "./finance-calculators";

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

/** Shape returned by GET /api/marketplace/negotiations (list).
 *  2-b / API contract 1-a: items are the ENRICHED rows — every raw
 *  MarketplaceNegotiation field plus counterparty_partner_id,
 *  counterparty_name, post_product_name, post_type, post_status. */
type NegotiationListItem = MarketplaceNegotiationListItem;

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

/** 2-b — post-type badge for the enriched negotiations-list rows (same
 *  label keys + palette as the post-detail TYPE_BADGE). */
const POST_TYPE_BADGE: Record<
  string,
  { labelKey: string; icon: React.ComponentType<{ className?: string }>; cls: string }
> = {
  buy: { labelKey: "marketplace-buy", icon: TrendingUp, cls: "border-transparent bg-green-500/15 text-green-700 dark:text-green-400" },
  sell: { labelKey: "marketplace-sell", icon: TrendingDown, cls: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  auction: { labelKey: "marketplace-auction", icon: Gavel, cls: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  contract: { labelKey: "marketplace-contract", icon: FileText, cls: "border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-400" },
};

/** 2-b — instrument-type select options for the deal-room Payments tab
 *  (exact enum values from marketplace-finance-types.ts). */
const FINANCE_TYPE_OPTIONS: { value: InstrumentType; labelKey: string }[] = [
  { value: "escrow", labelKey: "marketplace-finance-type-escrow" },
  { value: "letter_of_credit", labelKey: "marketplace-finance-type-lc" },
  { value: "payment_schedule", labelKey: "marketplace-finance-type-payment-schedule" },
  { value: "factoring", labelKey: "marketplace-finance-type-factoring" },
  { value: "trade_credit_insurance", labelKey: "marketplace-finance-type-insurance" },
];

/** 2-b — status badge classes for the compact instrument cards. */
const FINANCE_STATUS_CLASS: Record<string, string> = {
  draft: "border-transparent bg-muted text-muted-foreground",
  submitted: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400",
  approved: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  active: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  completed: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  rejected: "border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-400",
  disputed: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
  released: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  refunded: "border-transparent bg-muted text-muted-foreground",
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

  // Marketplace communication policy — locked clients can READ the room but
  // cannot send messages / offers (server returns 403 via the gate).
  const { canCommunicate, blockReason } = useMarketplacePermissions();
  const commLocked = !canCommunicate && !!blockReason;
  // Disable the input + offer form when the negotiation is in a terminal
  // state — no new messages can be sent on an expired / accepted / rejected
  // negotiation.
  const inputDisabled = isExpired || isAccepted || isRejected;

  // The OTHER party's partner_id (so we can identify which messages in the
  // thread belong to the counterparty vs. the caller).
  const otherPartnerId = negotiation
    ? (callerSide === "A" ? negotiation.partner_id_b : negotiation.partner_id_a)
    : null;

  // ── 2-b: deal-room state (tabs, identity, module gates) ────────────────
  const setSelectedId = useAppStore((s) => s.setSelectedId);
  const setView = useAppStore((s) => s.setView);
  const moduleAccess = useAppStore((s) => s.moduleAccess);
  const portalAccess = useAppStore((s) => s.portalAccess);
  // The caller's partner id (portal_access row hydrated into the store by
  // PortalShell from GET /api/portal/me) — drives isBookingPartner /
  // isOwner / canRelease on the mounted deal components.
  const callerPartnerId =
    (portalAccess as { partner_id?: string } | null)?.partner_id ?? null;
  // Tab visibility per module permissions — fail-open when the map is
  // absent/null (same evaluator semantics as the sidebar nav filter).
  const showDocumentsTab = moduleAccess?.["marketplace"] !== false;
  const showShipmentsTab = moduleAccess?.["marketplace.logistics"] !== false;
  const showPaymentsTab = moduleAccess?.["marketplace.finance"] !== false;
  // The deal-room tabs exist only for post-backed negotiations — chat-only
  // rooms keep the single conversation view.
  // NOTE: read from detailQ (not the `negotiation` alias) — this block
  // runs before the loading/error gates below, where the alias is still
  // `MarketplaceNegotiation | undefined`.
  const dealPostId = detailQ.data?.negotiation?.post_id ?? null;

  // Resolve the POST OWNER for role computation. Same query key + URL as
  // the post-detail view, so arriving from a post reuses the cache entry.
  // The owner branch carries the raw partner_id; same-tenant non-owners
  // get poster_partner_id (1-a contract).
  const postQ = useQuery<{ post: { partner_id?: string; poster_partner_id?: string | null; post_type?: string } }>({
    queryKey: ["marketplace-post", dealPostId],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/${dealPostId}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: !!dealPostId,
  });
  const postOwnerPartnerId =
    postQ.data?.post?.partner_id ?? postQ.data?.post?.poster_partner_id ?? null;
  // The document issuer is the SELLER on the deal: for buy posts that is
  // the responding party, otherwise the post owner (mirrors the seller
  // resolution in /api/marketplace/documents/auto-generate). Fail-open
  // (true) when the owner can't be resolved — the server routes remain
  // the write authority.
  const isIssuer = postOwnerPartnerId
    ? postQ.data?.post?.post_type === "buy"
      ? postOwnerPartnerId !== callerPartnerId
      : postOwnerPartnerId === callerPartnerId
    : true;

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

  // 2-b — the conversation surface (message thread + input area). Defined
  // once and mounted either directly (chat-only rooms) or as the
  // "Conversation" tab of the deal-room workspace below.
  const conversationSection = (
    <>
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
          {/* Offer form (collapsible) — hidden for communication-locked clients */}
          {showOfferForm && !inputDisabled && !commLocked && (
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

          {/* Action row: offer / upload / text input + send.
              Communication-locked clients (tier < Standard or KYC not yet
              approved) see the locked-card explainer instead. */}
          {!inputDisabled && commLocked && blockReason ? (
            <CommunicationLockedCard reason={blockReason} context="negotiate" />
          ) : !inputDisabled && (
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

          {!inputDisabled && !commLocked && (
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
    </>
  );

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

            {/* Post chip — 2-b: carries a "View post →" link back into the
                marketplace post detail (same store drill-down the post
                cards use: setSelectedId + setView). */}
            {post && (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm flex items-center justify-between gap-2 flex-wrap">
                <div className="min-w-0">
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
                {dealPostId && (
                  <button
                    type="button"
                    className="text-xs font-medium text-primary hover:underline inline-flex items-center gap-1 shrink-0"
                    onClick={() => {
                      setSelectedId(dealPostId);
                      setView("portal-marketplace");
                    }}
                  >
                    {t("marketplace-view-post")}
                    <ArrowRight className="h-3 w-3" aria-hidden="true" />
                  </button>
                )}
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

      {/* 2-b — DEAL ROOM: post-backed negotiations render a tabbed workspace
          (Conversation | Documents | Shipments | Payments) under the room
          header; chat-only rooms keep the current single conversation view.
          Tab visibility follows the module permission map — fail-open when
          the map is absent/null, mirroring the sidebar nav filter. */}
      {dealPostId ? (
        <Tabs defaultValue="conversation">
          <TabsList className="max-w-full overflow-x-auto">
            <TabsTrigger value="conversation" className="gap-1.5">
              <MessageSquare className="h-3.5 w-3.5" />
              {t("marketplace-dealroom-tab-conversation")}
            </TabsTrigger>
            {showDocumentsTab && (
              <TabsTrigger value="documents" className="gap-1.5">
                <FileText className="h-3.5 w-3.5" />
                {t("marketplace-dealroom-tab-documents")}
              </TabsTrigger>
            )}
            {showShipmentsTab && (
              <TabsTrigger value="shipments" className="gap-1.5">
                <Truck className="h-3.5 w-3.5" />
                {t("marketplace-dealroom-tab-shipments")}
              </TabsTrigger>
            )}
            {showPaymentsTab && (
              <TabsTrigger value="payments" className="gap-1.5">
                <Landmark className="h-3.5 w-3.5" />
                {t("marketplace-dealroom-tab-payments")}
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="conversation" className="mt-4 space-y-4">
            <p className="text-xs text-muted-foreground">
              {t("marketplace-dealroom-sub-conversation")}
            </p>
            {conversationSection}
          </TabsContent>

          {showDocumentsTab && (
            <TabsContent value="documents" className="mt-4">
              <DealDocumentsTab
                postId={dealPostId}
                negotiationId={negotiationId}
                isIssuer={isIssuer}
                t={t}
              />
            </TabsContent>
          )}
          {showShipmentsTab && (
            <TabsContent value="shipments" className="mt-4">
              <DealShipmentsTab
                postId={dealPostId}
                negotiationId={negotiationId}
                callerPartnerId={callerPartnerId}
                t={t}
              />
            </TabsContent>
          )}
          {showPaymentsTab && (
            <TabsContent value="payments" className="mt-4">
              <DealPaymentsTab
                postId={dealPostId}
                negotiationId={negotiationId}
                callerPartnerId={callerPartnerId}
                counterpartyPartnerId={otherPartnerId}
                defaultCurrency={post?.currency ?? "USD"}
                t={t}
              />
            </TabsContent>
          )}
        </Tabs>
      ) : (
        conversationSection
      )}

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
// 2-b — DEAL ROOM TABS
// ────────────────────────────────────────────────────────────────────────────
// One tab per deal surface, mounted by NegotiationRoom for post-backed
// negotiations. Each tab owns its query (["marketplace-deal-<x>", postId],
// no refetchInterval — a manual refresh button instead), an error state
// with retry, and a create form whose mutation invalidates its own key.

/** Shared tab chrome: the one-line explainer subtitle + count + refresh. */
function DealTabHeader({
  subtitle,
  countLabel,
  onRefresh,
  refreshing,
  t,
}: {
  subtitle: string;
  countLabel?: string;
  onRefresh: () => void;
  refreshing: boolean;
  t: (k: string) => string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 flex-wrap">
      <p className="text-xs text-muted-foreground flex-1 min-w-[200px]">{subtitle}</p>
      <div className="flex items-center gap-2">
        {countLabel && (
          <Badge variant="secondary" className="text-xs whitespace-nowrap">{countLabel}</Badge>
        )}
        <Button
          size="sm"
          variant="outline"
          className="gap-1"
          onClick={onRefresh}
          disabled={refreshing}
        >
          {refreshing
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <RefreshCw className="h-3.5 w-3.5" />}
          {t("marketplace-dealroom-refresh")}
        </Button>
      </div>
    </div>
  );
}

/** Shared tab error state with retry (same pattern as the list views). */
function DealTabError({
  message,
  onRetry,
  t,
}: {
  message: string;
  onRetry: () => void;
  t: (k: string) => string;
}) {
  return (
    <Card>
      <CardContent className="py-10 text-center space-y-3">
        <p className="text-sm text-muted-foreground">{message}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t("portal-action-try-again")}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Documents tab ───────────────────────────────────────────────────────

/**
 * DealDocumentsTab — the deal's document workspace:
 *   • DocumentChecklist — which required docs exist / are missing, with
 *     one-click "Generate missing".
 *   • DocumentGenerator — generate / preview / download PDF / sign. Its
 *     built-in documents table doubles as the tab's existing-docs list
 *     (type, reference, status, created, per-row actions) — no duplicate
 *     table is rendered on top of it.
 * The tab-level query provides the count + error/retry state and shares
 * the post-detail's cache entry pattern.
 */
function DealDocumentsTab({
  postId,
  negotiationId,
  isIssuer,
  t,
}: {
  postId: string;
  negotiationId: string;
  isIssuer: boolean;
  t: (k: string) => string;
}) {
  const qc = useQueryClient();
  const docsQ = useQuery<{ items: TradeDocument[]; total: number }>({
    queryKey: ["marketplace-deal-documents", postId],
    queryFn: async () => {
      const r = await fetch(
        `/api/marketplace/documents?post_id=${encodeURIComponent(postId)}&limit=100`,
      );
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });
  const items = docsQ.data?.items ?? [];

  return (
    <div className="space-y-4">
      <DealTabHeader
        subtitle={t("marketplace-dealroom-sub-documents")}
        countLabel={docsQ.isSuccess
          ? t("marketplace-dealroom-count-docs").replace("{n}", String(items.length))
          : undefined}
        onRefresh={() => {
          void docsQ.refetch();
          // Also refresh the mounted deal components' own docs queries
          // (keyed ["marketplace-documents", postId, negotiationId, …]).
          void qc.invalidateQueries({ queryKey: ["marketplace-documents", postId] });
        }}
        refreshing={docsQ.isFetching}
        t={t}
      />
      {docsQ.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : docsQ.isError ? (
        <DealTabError
          message={t("marketplace-dealroom-docs-load-failed")}
          onRetry={() => void docsQ.refetch()}
          t={t}
        />
      ) : (
        <>
          <DocumentChecklist
            postId={postId}
            negotiationId={negotiationId}
            isIssuer={isIssuer}
          />
          <DocumentGenerator
            postId={postId}
            negotiationId={negotiationId}
            isIssuer={isIssuer}
          />
        </>
      )}
    </div>
  );
}

// ─── Shipments tab ───────────────────────────────────────────────────────

interface ShipmentFormState {
  carrier_name: string;
  carrier_tracking_number: string;
  container_number: string;
  bill_of_lading_number: string;
  loading_port: string;
  discharge_port: string;
  vessel_name: string;
  container_type: string;
  estimated_departure: string;
  estimated_arrival: string;
  gross_weight: string;
  net_weight: string;
  volume: string;
  packages_count: string;
  temperature_controlled: boolean;
  notes: string;
}

const EMPTY_SHIPMENT_FORM: ShipmentFormState = {
  carrier_name: "",
  carrier_tracking_number: "",
  container_number: "",
  bill_of_lading_number: "",
  loading_port: "",
  discharge_port: "",
  vessel_name: "",
  container_type: "",
  estimated_departure: "",
  estimated_arrival: "",
  gross_weight: "",
  net_weight: "",
  volume: "",
  packages_count: "",
  temperature_controlled: false,
  notes: "",
};

/**
 * DealShipmentsTab — every shipment booked on the post (ShipmentTracker
 * per shipment, booking-partner controls enabled when the caller booked
 * it) + a collapsible "Book shipment" form against
 * POST /api/marketplace/shipments.
 */
function DealShipmentsTab({
  postId,
  negotiationId,
  callerPartnerId,
  t,
}: {
  postId: string;
  negotiationId: string;
  callerPartnerId: string | null;
  t: (k: string) => string;
}) {
  const qc = useQueryClient();
  const q = useQuery<{ items: Shipment[]; total: number }>({
    queryKey: ["marketplace-deal-shipments", postId],
    queryFn: async () => {
      const r = await fetch(
        `/api/marketplace/shipments?post_id=${encodeURIComponent(postId)}`,
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "failed");
      }
      return r.json();
    },
  });

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ShipmentFormState>(EMPTY_SHIPMENT_FORM);

  const createShipment = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        post_id: postId,
        negotiation_id: negotiationId,
        carrier_name: form.carrier_name.trim() || null,
        loading_port: form.loading_port.trim() || null,
        discharge_port: form.discharge_port.trim() || null,
        temperature_controlled: form.temperature_controlled,
      };
      const optStr: [keyof ShipmentFormState, string][] = [
        ["carrier_tracking_number", "carrier_tracking_number"],
        ["container_number", "container_number"],
        ["bill_of_lading_number", "bill_of_lading_number"],
        ["vessel_name", "vessel_name"],
        ["notes", "notes"],
      ];
      for (const [k, field] of optStr) {
        const v = (form[k] as string).trim();
        if (v) payload[field] = v;
      }
      if (form.container_type) payload.container_type = form.container_type;
      if (form.estimated_departure) {
        payload.estimated_departure = new Date(form.estimated_departure).toISOString();
      }
      if (form.estimated_arrival) {
        payload.estimated_arrival = new Date(form.estimated_arrival).toISOString();
      }
      const optNum: [keyof ShipmentFormState, string][] = [
        ["gross_weight", "gross_weight"],
        ["net_weight", "net_weight"],
        ["volume", "volume"],
        ["packages_count", "packages_count"],
      ];
      for (const [k, field] of optNum) {
        const v = (form[k] as string).trim();
        if (v) payload[field] = Number(v);
      }
      const r = await fetch("/api/marketplace/shipments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to book shipment.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-shipment-form-success"));
      setShowForm(false);
      setForm(EMPTY_SHIPMENT_FORM);
      qc.invalidateQueries({ queryKey: ["marketplace-deal-shipments", postId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function submitShipment() {
    // Client-side required fields (the API validates the rest).
    if (!form.carrier_name.trim() || !form.loading_port.trim() || !form.discharge_port.trim()) {
      toast.error(t("marketplace-shipment-form-required"));
      return;
    }
    createShipment.mutate();
  }

  const items = q.data?.items ?? [];

  return (
    <div className="space-y-4">
      <DealTabHeader
        subtitle={t("marketplace-dealroom-sub-shipments")}
        countLabel={q.isSuccess
          ? t("marketplace-dealroom-count-shipments").replace("{n}", String(items.length))
          : undefined}
        onRefresh={() => void q.refetch()}
        refreshing={q.isFetching}
        t={t}
      />
      {q.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : q.isError ? (
        <DealTabError
          message={t("marketplace-dealroom-shipments-load-failed")}
          onRetry={() => void q.refetch()}
          t={t}
        />
      ) : (
        <>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              {t("marketplace-dealroom-shipments-empty")}
            </p>
          ) : (
            items.map((s) => (
              <ShipmentTracker
                key={s.id}
                shipmentId={s.id}
                isBookingPartner={!!callerPartnerId && s.partner_id === callerPartnerId}
              />
            ))
          )}

          {/* Book shipment — collapsible, default closed */}
          <Card>
            <CardContent className="p-4 sm:p-6 space-y-4">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <p className="text-sm font-semibold flex items-center gap-1.5">
                    <Truck className="size-4 text-muted-foreground" />
                    {t("marketplace-shipment-form-title")}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t("marketplace-shipment-form-desc")}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1"
                  onClick={() => setShowForm((v) => !v)}
                >
                  {showForm ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                  {showForm
                    ? t("portal-action-cancel")
                    : t("marketplace-shipment-form-title")}
                </Button>
              </div>
              {showForm && (
                <form
                  className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitShipment();
                  }}
                >
                  <div>
                    <Label htmlFor="sh-carrier">{t("marketplace-shipment-carrier")}</Label>
                    <Input
                      id="sh-carrier"
                      value={form.carrier_name}
                      onChange={(e) => setForm({ ...form, carrier_name: e.target.value })}
                      maxLength={500}
                    />
                  </div>
                  <div>
                    <Label htmlFor="sh-tracking">{t("marketplace-shipment-tracking-number")}</Label>
                    <Input
                      id="sh-tracking"
                      value={form.carrier_tracking_number}
                      onChange={(e) => setForm({ ...form, carrier_tracking_number: e.target.value })}
                      maxLength={500}
                    />
                  </div>
                  <div>
                    <Label htmlFor="sh-vessel">{t("marketplace-shipment-vessel")}</Label>
                    <Input
                      id="sh-vessel"
                      value={form.vessel_name}
                      onChange={(e) => setForm({ ...form, vessel_name: e.target.value })}
                      maxLength={500}
                    />
                  </div>
                  <div>
                    <Label htmlFor="sh-loadport">{t("marketplace-shipment-loading-port")}</Label>
                    <Input
                      id="sh-loadport"
                      value={form.loading_port}
                      onChange={(e) => setForm({ ...form, loading_port: e.target.value })}
                      maxLength={500}
                    />
                  </div>
                  <div>
                    <Label htmlFor="sh-disport">{t("marketplace-shipment-discharge-port")}</Label>
                    <Input
                      id="sh-disport"
                      value={form.discharge_port}
                      onChange={(e) => setForm({ ...form, discharge_port: e.target.value })}
                      maxLength={500}
                    />
                  </div>
                  <div>
                    <Label htmlFor="sh-ctype">{t("marketplace-shipment-container-type")}</Label>
                    <Select
                      value={form.container_type}
                      onValueChange={(v) => setForm({ ...form, container_type: v })}
                    >
                      <SelectTrigger id="sh-ctype"><SelectValue placeholder="—" /></SelectTrigger>
                      <SelectContent>
                        {(Object.keys(CONTAINER_TYPE_LABELS) as ContainerType[]).map((ct) => (
                          <SelectItem key={ct} value={ct}>{CONTAINER_TYPE_LABELS[ct]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="sh-container">{t("marketplace-shipment-container")}</Label>
                    <Input
                      id="sh-container"
                      value={form.container_number}
                      onChange={(e) => setForm({ ...form, container_number: e.target.value })}
                      maxLength={500}
                    />
                  </div>
                  <div>
                    <Label htmlFor="sh-bol">{t("marketplace-shipment-bol")}</Label>
                    <Input
                      id="sh-bol"
                      value={form.bill_of_lading_number}
                      onChange={(e) => setForm({ ...form, bill_of_lading_number: e.target.value })}
                      maxLength={500}
                    />
                  </div>
                  <div>
                    <Label htmlFor="sh-packages">{t("marketplace-shipment-packages")}</Label>
                    <Input
                      id="sh-packages"
                      type="number"
                      min="0"
                      value={form.packages_count}
                      onChange={(e) => setForm({ ...form, packages_count: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor="sh-gross">{t("marketplace-shipment-gross-weight")}</Label>
                    <Input
                      id="sh-gross"
                      type="number"
                      min="0"
                      step="0.01"
                      value={form.gross_weight}
                      onChange={(e) => setForm({ ...form, gross_weight: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor="sh-net">{t("marketplace-shipment-net-weight")}</Label>
                    <Input
                      id="sh-net"
                      type="number"
                      min="0"
                      step="0.01"
                      value={form.net_weight}
                      onChange={(e) => setForm({ ...form, net_weight: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor="sh-volume">{t("marketplace-shipment-volume")}</Label>
                    <Input
                      id="sh-volume"
                      type="number"
                      min="0"
                      step="0.01"
                      value={form.volume}
                      onChange={(e) => setForm({ ...form, volume: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor="sh-etd">{t("marketplace-shipment-est-departure")}</Label>
                    <Input
                      id="sh-etd"
                      type="date"
                      value={form.estimated_departure}
                      onChange={(e) => setForm({ ...form, estimated_departure: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor="sh-eta">{t("marketplace-shipment-est-arrival")}</Label>
                    <Input
                      id="sh-eta"
                      type="date"
                      value={form.estimated_arrival}
                      onChange={(e) => setForm({ ...form, estimated_arrival: e.target.value })}
                    />
                  </div>
                  <div className="flex items-center gap-2 pt-6">
                    <Checkbox
                      id="sh-temp"
                      checked={form.temperature_controlled}
                      onCheckedChange={(v) =>
                        setForm({ ...form, temperature_controlled: v === true })}
                    />
                    <Label htmlFor="sh-temp" className="font-normal cursor-pointer">
                      {t("marketplace-shipment-temperature-controlled")}
                    </Label>
                  </div>
                  <div className="sm:col-span-2 lg:col-span-3">
                    <Label htmlFor="sh-notes">{t("marketplace-shipment-notes")}</Label>
                    <Textarea
                      id="sh-notes"
                      rows={2}
                      value={form.notes}
                      onChange={(e) => setForm({ ...form, notes: e.target.value })}
                      maxLength={500}
                    />
                  </div>
                  <div className="sm:col-span-2 lg:col-span-3 flex gap-2">
                    <Button type="submit" disabled={createShipment.isPending} className="gap-1">
                      {createShipment.isPending
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <Plus className="h-4 w-4" />}
                      {t("marketplace-shipment-form-title")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setShowForm(false)}
                      disabled={createShipment.isPending}
                    >
                      {t("portal-action-cancel")}
                    </Button>
                  </div>
                </form>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ─── Payments tab ────────────────────────────────────────────────────────

interface MilestoneDraft {
  description: string;
  percentage: string;
  trigger_condition: TriggerCondition;
}

/**
 * DealPaymentsTab — the deal's financial instruments:
 *   • payment_schedule rows → PaymentSchedule (milestone timeline).
 *   • escrow rows → EscrowStatus (release / dispute controls).
 *   • LC / factoring / insurance rows → a compact InstrumentCard.
 *   • "New payment instrument" collapsible form → POST /api/marketplace/finance.
 *   • FinanceCalculators as planning tools at the bottom.
 */
function DealPaymentsTab({
  postId,
  negotiationId,
  callerPartnerId,
  counterpartyPartnerId,
  defaultCurrency,
  t,
}: {
  postId: string;
  negotiationId: string;
  callerPartnerId: string | null;
  counterpartyPartnerId: string | null;
  defaultCurrency: string;
  t: (k: string) => string;
}) {
  const qc = useQueryClient();
  const q = useQuery<{ items: FinancialInstrument[]; total: number }>({
    queryKey: ["marketplace-deal-finance", postId],
    queryFn: async () => {
      const r = await fetch(
        `/api/marketplace/finance?post_id=${encodeURIComponent(postId)}`,
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "failed");
      }
      return r.json();
    },
  });

  const [showForm, setShowForm] = useState(false);
  const [instrumentType, setInstrumentType] = useState<InstrumentType>("escrow");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  // Type-specific fields — validated server-side; surfaced via toasts.
  const [escrowCondition, setEscrowCondition] =
    useState<EscrowReleaseCondition>("delivery_confirmation");
  const [lcType, setLcType] = useState<LCType>("irrevocable");
  const [lcBank, setLcBank] = useState("");
  const [lcExpiry, setLcExpiry] = useState("");
  const [factoringCompany, setFactoringCompany] = useState("");
  const [factoringDiscount, setFactoringDiscount] = useState("2.5");
  const [factoringAdvance, setFactoringAdvance] = useState("80");
  const [insuranceProvider, setInsuranceProvider] = useState("");
  const [insuranceCoverage, setInsuranceCoverage] = useState("90");
  const [milestones, setMilestones] = useState<MilestoneDraft[]>([
    { description: "", percentage: "30", trigger_condition: "advance_payment" },
  ]);

  const createInstrument = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        instrument_type: instrumentType,
        amount: Number(amount),
        currency,
        post_id: postId,
        negotiation_id: negotiationId,
      };
      if (counterpartyPartnerId) {
        payload.counterparty_partner_id = counterpartyPartnerId;
      }
      switch (instrumentType) {
        case "escrow":
          payload.escrow_release_condition = escrowCondition;
          break;
        case "letter_of_credit":
          payload.lc_type = lcType;
          payload.lc_issuing_bank = lcBank.trim();
          payload.lc_expiry_date = new Date(lcExpiry).toISOString();
          break;
        case "factoring":
          payload.factoring_discount_rate = Number(factoringDiscount);
          payload.factoring_advance_rate = Number(factoringAdvance);
          if (factoringCompany.trim()) payload.factoring_company = factoringCompany.trim();
          break;
        case "trade_credit_insurance":
          payload.insurance_coverage = Number(insuranceCoverage);
          if (insuranceProvider.trim()) {
            payload.insurance_provider = insuranceProvider.trim();
          }
          break;
        case "payment_schedule":
          payload.milestones = milestones.map((m, i) => ({
            sequence: i + 1,
            description: m.description.trim(),
            percentage: Number(m.percentage),
            trigger_condition: m.trigger_condition,
          }));
          break;
      }
      const r = await fetch("/api/marketplace/finance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to create instrument.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-finance-form-success"));
      setShowForm(false);
      setAmount("");
      setMilestones([
        { description: "", percentage: "30", trigger_condition: "advance_payment" },
      ]);
      qc.invalidateQueries({ queryKey: ["marketplace-deal-finance", postId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function submitInstrument() {
    if (!amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      toast.error(t("marketplace-finance-form-required"));
      return;
    }
    createInstrument.mutate();
  }

  const items = q.data?.items ?? [];

  return (
    <div className="space-y-4">
      <DealTabHeader
        subtitle={t("marketplace-dealroom-sub-payments")}
        countLabel={q.isSuccess
          ? t("marketplace-dealroom-count-finance").replace("{n}", String(items.length))
          : undefined}
        onRefresh={() => void q.refetch()}
        refreshing={q.isFetching}
        t={t}
      />
      {q.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : q.isError ? (
        <DealTabError
          message={t("marketplace-dealroom-finance-load-failed")}
          onRetry={() => void q.refetch()}
          t={t}
        />
      ) : (
        <>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              {t("marketplace-dealroom-finance-empty")}
            </p>
          ) : (
            items.map((inst) => {
              if (inst.instrument_type === "payment_schedule") {
                return (
                  <PaymentSchedule
                    key={inst.id}
                    instrumentId={inst.id}
                    isOwner={!!callerPartnerId && inst.partner_id === callerPartnerId}
                  />
                );
              }
              if (inst.instrument_type === "escrow") {
                return (
                  <EscrowStatus
                    key={inst.id}
                    instrumentId={inst.id}
                    canRelease={
                      !!callerPartnerId &&
                      (inst.partner_id === callerPartnerId ||
                        inst.counterparty_partner_id === callerPartnerId)
                    }
                  />
                );
              }
              return <InstrumentCard key={inst.id} instrument={inst} t={t} />;
            })
          )}

          {/* New payment instrument — collapsible, default closed */}
          <Card>
            <CardContent className="p-4 sm:p-6 space-y-4">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <p className="text-sm font-semibold flex items-center gap-1.5">
                    <Landmark className="size-4 text-muted-foreground" />
                    {t("marketplace-finance-form-title")}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t("marketplace-finance-form-desc")}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1"
                  onClick={() => setShowForm((v) => !v)}
                >
                  {showForm ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                  {showForm
                    ? t("portal-action-cancel")
                    : t("marketplace-finance-form-title")}
                </Button>
              </div>
              {showForm && (
                <form
                  className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitInstrument();
                  }}
                >
                  <div>
                    <Label htmlFor="fin-type">{t("marketplace-finance-form-type")}</Label>
                    <Select
                      value={instrumentType}
                      onValueChange={(v) => setInstrumentType(v as InstrumentType)}
                    >
                      <SelectTrigger id="fin-type"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {FINANCE_TYPE_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>{t(o.labelKey)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="fin-amount">{t("marketplace-finance-form-amount")}</Label>
                    <Input
                      id="fin-amount"
                      type="number"
                      min="0"
                      step="0.01"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="fin-currency">{t("marketplace-finance-currency")}</Label>
                    <Select value={currency} onValueChange={setCurrency}>
                      <SelectTrigger id="fin-currency"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CURRENCIES.slice(0, 12).map((c) => (
                          <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Escrow-specific */}
                  {instrumentType === "escrow" && (
                    <div className="sm:col-span-2 lg:col-span-3">
                      <Label htmlFor="fin-cond">
                        {t("marketplace-finance-escrow-release-condition")}
                      </Label>
                      <Select
                        value={escrowCondition}
                        onValueChange={(v) => setEscrowCondition(v as EscrowReleaseCondition)}
                      >
                        <SelectTrigger id="fin-cond"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {(Object.keys(ESCROW_RELEASE_CONDITION_LABEL_KEY) as EscrowReleaseCondition[]).map((c) => (
                            <SelectItem key={c} value={c}>
                              {t(ESCROW_RELEASE_CONDITION_LABEL_KEY[c])}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* Letter-of-credit-specific */}
                  {instrumentType === "letter_of_credit" && (
                    <>
                      <div>
                        <Label htmlFor="fin-lctype">{t("marketplace-finance-lc-type")}</Label>
                        <Select value={lcType} onValueChange={(v) => setLcType(v as LCType)}>
                          <SelectTrigger id="fin-lctype"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {(Object.keys(LC_TYPE_LABEL_KEY) as LCType[]).map((lt) => (
                              <SelectItem key={lt} value={lt}>{t(LC_TYPE_LABEL_KEY[lt])}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label htmlFor="fin-lcbank">
                          {t("marketplace-finance-form-lc-issuing-bank")}
                        </Label>
                        <Input
                          id="fin-lcbank"
                          value={lcBank}
                          onChange={(e) => setLcBank(e.target.value)}
                          maxLength={200}
                        />
                      </div>
                      <div>
                        <Label htmlFor="fin-lcexp">
                          {t("marketplace-finance-form-lc-expiry")}
                        </Label>
                        <Input
                          id="fin-lcexp"
                          type="date"
                          value={lcExpiry}
                          onChange={(e) => setLcExpiry(e.target.value)}
                        />
                      </div>
                    </>
                  )}

                  {/* Factoring-specific */}
                  {instrumentType === "factoring" && (
                    <>
                      <div>
                        <Label htmlFor="fin-fcompany">
                          {t("marketplace-finance-factoring-company")}
                        </Label>
                        <Input
                          id="fin-fcompany"
                          value={factoringCompany}
                          onChange={(e) => setFactoringCompany(e.target.value)}
                          maxLength={500}
                        />
                      </div>
                      <div>
                        <Label htmlFor="fin-fdisc">
                          {t("marketplace-finance-factoring-discount")}
                        </Label>
                        <Input
                          id="fin-fdisc"
                          type="number"
                          min="0"
                          max="100"
                          step="0.01"
                          value={factoringDiscount}
                          onChange={(e) => setFactoringDiscount(e.target.value)}
                        />
                      </div>
                      <div>
                        <Label htmlFor="fin-fadv">
                          {t("marketplace-finance-factoring-advance")}
                        </Label>
                        <Input
                          id="fin-fadv"
                          type="number"
                          min="0"
                          max="100"
                          step="0.01"
                          value={factoringAdvance}
                          onChange={(e) => setFactoringAdvance(e.target.value)}
                        />
                      </div>
                    </>
                  )}

                  {/* Insurance-specific */}
                  {instrumentType === "trade_credit_insurance" && (
                    <>
                      <div>
                        <Label htmlFor="fin-iprov">
                          {t("marketplace-finance-insurance-provider")}
                        </Label>
                        <Input
                          id="fin-iprov"
                          value={insuranceProvider}
                          onChange={(e) => setInsuranceProvider(e.target.value)}
                          maxLength={500}
                        />
                      </div>
                      <div>
                        <Label htmlFor="fin-icov">
                          {t("marketplace-finance-insurance-coverage")}
                        </Label>
                        <Input
                          id="fin-icov"
                          type="number"
                          min="0"
                          max="100"
                          step="0.1"
                          value={insuranceCoverage}
                          onChange={(e) => setInsuranceCoverage(e.target.value)}
                        />
                      </div>
                    </>
                  )}

                  {/* Payment-schedule milestones */}
                  {instrumentType === "payment_schedule" && (
                    <div className="sm:col-span-2 lg:col-span-3 space-y-3">
                      <p className="text-xs font-medium text-muted-foreground">
                        {t("marketplace-finance-form-milestones")}
                      </p>
                      {milestones.map((m, i) => (
                        <div
                          key={i}
                          className="grid grid-cols-1 sm:grid-cols-[1fr_110px_1fr_auto] gap-3 items-end"
                        >
                          <div>
                            <Label htmlFor={`fin-ms-desc-${i}`}>
                              {t("marketplace-finance-form-milestone-desc")}
                            </Label>
                            <Input
                              id={`fin-ms-desc-${i}`}
                              value={m.description}
                              onChange={(e) => setMilestones(milestones.map((x, j) =>
                                j === i ? { ...x, description: e.target.value } : x))}
                              maxLength={500}
                            />
                          </div>
                          <div>
                            <Label htmlFor={`fin-ms-pct-${i}`}>
                              {t("marketplace-finance-form-milestone-pct")}
                            </Label>
                            <Input
                              id={`fin-ms-pct-${i}`}
                              type="number"
                              min="0"
                              max="100"
                              value={m.percentage}
                              onChange={(e) => setMilestones(milestones.map((x, j) =>
                                j === i ? { ...x, percentage: e.target.value } : x))}
                            />
                          </div>
                          <div>
                            <Label htmlFor={`fin-ms-trig-${i}`}>
                              {t("marketplace-finance-schedule-trigger")}
                            </Label>
                            <Select
                              value={m.trigger_condition}
                              onValueChange={(v) => setMilestones(milestones.map((x, j) =>
                                j === i ? { ...x, trigger_condition: v as TriggerCondition } : x))}
                            >
                              <SelectTrigger id={`fin-ms-trig-${i}`}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {(Object.keys(TRIGGER_CONDITION_LABEL_KEY) as TriggerCondition[]).map((tc) => (
                                  <SelectItem key={tc} value={tc}>
                                    {t(TRIGGER_CONDITION_LABEL_KEY[tc])}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={t("common-label-cancel") || "Remove"}
                            disabled={milestones.length <= 1}
                            onClick={() => setMilestones(milestones.filter((_, j) => j !== i))}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="gap-1"
                        onClick={() => setMilestones([
                          ...milestones,
                          { description: "", percentage: "20", trigger_condition: "manual" },
                        ])}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {t("marketplace-finance-form-add-milestone")}
                      </Button>
                    </div>
                  )}

                  <div className="sm:col-span-2 lg:col-span-3 flex gap-2">
                    <Button type="submit" disabled={createInstrument.isPending} className="gap-1">
                      {createInstrument.isPending
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <Plus className="h-4 w-4" />}
                      {t("marketplace-finance-form-submit")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setShowForm(false)}
                      disabled={createInstrument.isPending}
                    >
                      {t("portal-action-cancel")}
                    </Button>
                  </div>
                </form>
              )}
            </CardContent>
          </Card>

          {/* Planning tools */}
          <FinanceCalculators />
        </>
      )}
    </div>
  );
}

/** Compact read card for LC / factoring / insurance instruments. */
function InstrumentCard({
  instrument,
  t,
}: {
  instrument: FinancialInstrument;
  t: (k: string) => string;
}) {
  const status = instrument.status as InstrumentStatus;
  const cells: { label: string; value: string }[] = [];
  if (instrument.instrument_type === "letter_of_credit") {
    if (instrument.lc_issuing_bank) {
      cells.push({ label: t("marketplace-finance-form-lc-issuing-bank"), value: instrument.lc_issuing_bank });
    }
    if (instrument.lc_type) {
      cells.push({ label: t("marketplace-finance-lc-type"), value: t(LC_TYPE_LABEL_KEY[instrument.lc_type]) });
    }
    if (instrument.lc_expiry_date) {
      cells.push({ label: t("marketplace-finance-form-lc-expiry"), value: fmtDate(instrument.lc_expiry_date) });
    }
  } else if (instrument.instrument_type === "factoring") {
    if (instrument.factoring_company) {
      cells.push({ label: t("marketplace-finance-factoring-company"), value: instrument.factoring_company });
    }
    if (instrument.factoring_advance_rate != null) {
      cells.push({ label: t("marketplace-finance-factoring-advance"), value: `${instrument.factoring_advance_rate}%` });
    }
    if (instrument.factoring_discount_rate != null) {
      cells.push({ label: t("marketplace-finance-factoring-discount"), value: `${instrument.factoring_discount_rate}%` });
    }
  } else if (instrument.instrument_type === "trade_credit_insurance") {
    if (instrument.insurance_provider) {
      cells.push({ label: t("marketplace-finance-insurance-provider"), value: instrument.insurance_provider });
    }
    if (instrument.insurance_coverage != null) {
      cells.push({ label: t("marketplace-finance-insurance-coverage"), value: `${instrument.insurance_coverage}%` });
    }
  }
  cells.push({ label: t("marketplace-negotiation-opened"), value: fmtDate(instrument.created_at) });

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <Landmark className="size-4 text-muted-foreground" />
            <p className="text-sm font-semibold">
              {t(INSTRUMENT_TYPE_LABEL_KEY[instrument.instrument_type])}
            </p>
            <Badge variant="outline" className={FINANCE_STATUS_CLASS[status] ?? ""}>
              {t(INSTRUMENT_STATUS_LABEL_KEY[status] ?? status)}
            </Badge>
          </div>
          <p className="text-sm font-semibold">
            {fmtMoney(Number(instrument.amount), instrument.currency)}
          </p>
        </div>
        {cells.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
            {cells.map((c) => (
              <div key={c.label} className="rounded-md bg-muted/30 p-2">
                <p className="uppercase tracking-wide text-muted-foreground">{c.label}</p>
                <p className="font-medium mt-0.5 truncate" title={c.value}>{c.value}</p>
              </div>
            ))}
          </div>
        )}
        {instrument.terms && (
          <p className="text-xs text-muted-foreground whitespace-pre-wrap">{instrument.terms}</p>
        )}
      </CardContent>
    </Card>
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
    // 2-b / API contract 1-a — the enriched rows carry the counterparty's
    // company name + the negotiated post's summary, so the row can show
    // WHO + WHAT instead of "Negotiation room #a1b2c3d4".
    const typeBadge = n.post_type ? POST_TYPE_BADGE[n.post_type] : null;
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
              {typeBadge && (
                <Badge variant="outline" className={`text-xs gap-1 ${typeBadge.cls}`}>
                  <typeBadge.icon className="h-3 w-3" />
                  {t(typeBadge.labelKey)}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                {fmtRelative(n.last_message_at ?? n.created_at)}
              </span>
            </div>
            <p className="font-medium truncate">
              {n.counterparty_name ?? t("marketplace-negotiation-other-party")}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {n.post_product_name ?? t("marketplace-negotiation-list-direct")}
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
      ) : q.isError ? (
        // 2-b — previously a failed list load rendered the Tabs with zero
        // items in every bucket, which looked identical to "no negotiations".
        // Surface the failure with a retry instead.
        <div className="text-center py-20 text-muted-foreground">
          <p>{t("marketplace-negotiations-load-failed")}</p>
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
