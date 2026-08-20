// Marketplace types — VELOS B2B commodity marketplace.
//
// Four tables (migration 044_marketplace.sql):
//   • marketplace_posts         — buy / sell / auction / contract offers
//   • marketplace_responses     — counter-offers / quotes on a post
//   • marketplace_negotiations  — private chat rooms between two partners
//   • marketplace_messages      — chat messages inside a negotiation
//
// Privacy model:
//   - Public posts expose product/qty/location but NOT the poster's
//     partner_id, contact details, or company name (sanitised at the API
//     boundary; see marketplace-store.listMarketplacePosts).
//   - The contact fields are revealed only when a negotiation is marked
//     contact_revealed = true (i.e. after both sides accept the deal).
//
// All writes carry tenant_id + partner_id from the auth context so a
// partner from tenant A cannot write rows into tenant B's marketplace.
// Reads are scoped to the caller's tenant via the store filters.

// ─── marketplace_posts ────────────────────────────────────────────────────

export type MarketplacePostType = "buy" | "sell" | "auction" | "contract";
export type MarketplacePriceType = "fixed" | "range" | "on_request";
export type MarketplacePostStatus =
  | "draft"
  | "active"
  | "closed"
  | "expired"
  | "flagged";
export type MarketplaceVisibility = "public" | "private";
export type MarketplaceVerificationLevel =
  | "none"
  | "bronze"
  | "silver"
  | "gold"
  | "platinum";

export interface MarketplacePost {
  id: string;
  tenant_id: string;
  partner_id: string;
  portal_access_id: string | null;
  post_type: MarketplacePostType;
  product_name: string;
  product_category: string | null;
  product_subcategory: string | null;
  quantity: number;
  unit: string;
  target_price: number | null;
  price_visible: boolean;
  currency: string;
  price_type: MarketplacePriceType;
  price_max: number | null;
  delivery_location: string | null;
  delivery_country: string | null;
  delivery_date: string | null; // ISO timestamptz
  incoterm: string | null;
  origin_country: string | null;
  packaging: string | null;
  specifications: Record<string, unknown>;
  quality_specs: unknown[];
  payment_terms: string | null;
  description: string | null;
  status: MarketplacePostStatus;
  visibility: MarketplaceVisibility;
  is_verified: boolean;
  verification_level: MarketplaceVerificationLevel;
  views_count: number;
  responses_count: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Fields a caller MAY supply when creating a post. The store + API layer
 * stamp tenant_id / partner_id / portal_access_id from the auth context so
 * a partner cannot spoof the owner.
 *
 * Required: post_type, product_name, quantity, unit.
 */
export interface MarketplacePostCreate {
  post_type?: MarketplacePostType;
  product_name: string;
  product_category?: string | null;
  product_subcategory?: string | null;
  quantity: number;
  unit?: string;
  target_price?: number | null;
  price_visible?: boolean;
  currency?: string;
  price_type?: MarketplacePriceType;
  price_max?: number | null;
  delivery_location?: string | null;
  delivery_country?: string | null;
  delivery_date?: string | null;
  incoterm?: string | null;
  origin_country?: string | null;
  packaging?: string | null;
  specifications?: Record<string, unknown>;
  quality_specs?: unknown[];
  payment_terms?: string | null;
  description?: string | null;
  status?: MarketplacePostStatus;
  visibility?: MarketplaceVisibility;
  expires_at?: string | null;
}

// ─── marketplace_responses ────────────────────────────────────────────────

export type MarketplaceResponseStatus =
  | "sent"
  | "viewed"
  | "accepted"
  | "rejected"
  | "expired"
  | "countered";

export interface MarketplaceResponse {
  id: string;
  post_id: string;
  tenant_id: string;
  partner_id: string;
  portal_access_id: string | null;
  quantity: number | null;
  unit_price: number | null;
  currency: string;
  delivery_date: string | null;
  delivery_location: string | null;
  incoterm: string | null;
  payment_terms: string | null;
  message: string | null;
  status: MarketplaceResponseStatus;
  contact_revealed: boolean;
  is_counter: boolean;
  parent_response_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface MarketplaceResponseCreate {
  post_id: string;
  quantity?: number | null;
  unit_price?: number | null;
  currency?: string;
  delivery_date?: string | null;
  delivery_location?: string | null;
  incoterm?: string | null;
  payment_terms?: string | null;
  message?: string | null;
  is_counter?: boolean;
  parent_response_id?: string | null;
}

// ─── marketplace_negotiations ──────────────────────────────────────────────

export type MarketplaceNegotiationStatus =
  | "active"
  | "accepted"
  | "rejected"
  | "expired"
  | "cancelled";

/**
 * Phase 2: structured offer terms — used as the `agreed_terms` JSONB
 * payload on a negotiation once both parties have accepted, AND as the
 * `offer_data` payload on a marketplace_message of type
 * 'offer' / 'counter_offer'.
 */
export interface MarketplaceOfferTerms {
  quantity?: number | null;
  unit?: string | null;
  unit_price?: number | null;
  price?: number | null; // alias for unit_price (UI uses 'price', DB uses 'unit_price')
  currency?: string | null;
  incoterm?: string | null;
  payment_terms?: string | null;
  delivery_country?: string | null;
  delivery_location?: string | null;
  delivery_port?: string | null;
  delivery_date?: string | null; // ISO date
}

export interface MarketplaceNegotiation {
  id: string;
  post_id: string;
  response_id: string | null;
  tenant_id_a: string;
  partner_id_a: string;
  tenant_id_b: string;
  partner_id_b: string;
  status: MarketplaceNegotiationStatus;
  contact_revealed: boolean;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;

  // ── Phase 2 fields ─────────────────────────────────────────────────────
  /** 'A' | 'B' | NULL — which partner the latest offer/counter is awaiting
   *  a response from. Set when an offer/counter_offer message is sent;
   *  cleared when the offer is accepted/rejected. Used by the UI's
   *  "Awaiting response" badge + accept-button gating. */
  awaiting_party?: "A" | "B" | null;
  /** Mirrors marketplace_messages.message_type of the most recent message.
   *  Denormalised so the negotiation list can show "Awaiting response"
   *  without a JOIN. */
  last_message_type?: MarketplaceMessageType | null;
  /** last_message_at + 48h, computed at write time. NULL when no messages
   *  have been sent yet (the negotiation was just opened). */
  expires_at?: string | null;
  /** Snapshot of the agreed-upon offer terms — filled in when status
   *  flips to 'accepted'. NULL until then. */
  agreed_terms?: MarketplaceOfferTerms | null;
  /** Per-party accept tracking. `contact_revealed` flips to TRUE only
   *  when BOTH are true. */
  partner_a_accepted?: boolean;
  partner_b_accepted?: boolean;
  partner_a_accepted_at?: string | null;
  partner_b_accepted_at?: string | null;
}

export interface MarketplaceNegotiationCreate {
  post_id: string;
  response_id?: string | null;
  partner_id_b: string;
  tenant_id_b: string;
}

// ─── marketplace_messages ───────────────────────────────────────────────────

export type MarketplaceMessageType =
  | "text"
  | "offer"
  | "counter_offer"
  | "accept"
  | "reject"
  | "document"
  | "system";

export interface MarketplaceMessage {
  id: string;
  negotiation_id: string;
  sender_partner_id: string;
  message: string | null;
  message_type: MarketplaceMessageType;
  offer_data: Record<string, unknown> | null;
  attachment_url: string | null;
  created_at: string;

  // ── Phase 2 field ────────────────────────────────────────────────────
  /** NULL until the recipient opens the negotiation room. Used by the
   *  "unread" badge + the bulk-mark-read path. */
  read_at?: string | null;
}

export interface MarketplaceMessageCreate {
  negotiation_id: string;
  message?: string | null;
  message_type?: MarketplaceMessageType;
  offer_data?: Record<string, unknown> | null;
  attachment_url?: string | null;
}
