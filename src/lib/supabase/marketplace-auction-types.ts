// Marketplace Phase 4 — auction + contract + smart-pricing types.
//
// Backs the columns/tables added in migration 046_marketplace_auctions_contracts.sql:
//   • marketplace_posts.auction_* — auction metadata on a 'auction' post.
//   • marketplace_auction_bids    — one row per bid placed on an auction post.
//   • marketplace_contracts       — long-term supply agreement (parent).
//   • marketplace_contract_deliveries — scheduled delivery milestones.
//
// Auction model:
//   english  — ascending bids, highest at end wins, each bid ≥ current + min.
//   dutch    — descending price, first bid wins (current_price drops on a timer).
//   sealed   — one bid per partner, hidden until auction_ends_at.
//
// Contract model:
//   The contract row stores the master agreement (total_quantity, frequency,
//   start/end dates, price_type). marketplace_contract_deliveries holds the
//   individual scheduled shipments — generated from (frequency, start_date,
//   end_date) at contract creation time. `delivered_quantity` on the parent
//   is re-aggregated from deliveries whenever a delivery's status changes.

// ─── Auctions ────────────────────────────────────────────────────────────

export type AuctionType = "english" | "dutch" | "sealed";

/**
 * Auction metadata stamped onto a marketplace_posts row whose
 * post_type = 'auction'. NULL on non-auction posts.
 *
 * Stored as flat columns on marketplace_posts (migration 046), not a
 * separate table — the auction lifecycle is 1:1 with the post and
 * a separate table would force an extra JOIN on every marketplace list.
 */
export interface AuctionSettings {
  auction_type: AuctionType;
  auction_start_price: number | null;
  auction_current_price: number | null;
  auction_reserve_price: number | null;
  /** ISO timestamptz — when the auction closes (server-side cron + on-demand
   *  processAuctionEnd() settle the winner). NULL while the auction is being
   *  set up (no bids accepted yet). */
  auction_ends_at: string | null;
  /** Partner id of the winner — NULL until processAuctionEnd() runs. */
  auction_winner_id: string | null;
  /** Minimum increment between successive bids in an english auction. */
  auction_min_increment: number | null;
}

/**
 * Subset of MarketplacePost fields that the auction widget / store needs.
 * The full MarketplacePost type is in marketplace-types.ts; we re-declare
 * only the auction-relevant fields here to avoid a circular import
 * (marketplace-types.ts does not import from this file).
 */
export interface AuctionPostSummary {
  id: string;
  post_type: "auction";
  target_price: number | null;
  currency: string;
  quantity: number;
  unit: string;
  product_name: string;
  status: string;
  expires_at: string | null;
  auction_type: AuctionType | null;
  auction_start_price: number | null;
  auction_current_price: number | null;
  auction_reserve_price: number | null;
  auction_ends_at: string | null;
  auction_winner_id: string | null;
  auction_min_increment: number | null;
}

// ─── Auction bids ──────────────────────────────────────────────────────────

export interface AuctionBid {
  id: string;
  post_id: string;
  partner_id: string;
  bid_amount: number;
  currency: string;
  is_winning: boolean;
  created_at: string;
}

export interface AuctionBidCreate {
  post_id: string;
  bid_amount: number;
  currency?: string;
}

// ─── Contracts ────────────────────────────────────────────────────────────

export type ContractFrequency = "monthly" | "quarterly" | "weekly" | "custom";
export type ContractPriceType = "fixed" | "floating" | "indexed";
export type ContractStatus = "active" | "completed" | "cancelled" | "breached";

export interface Contract {
  id: string;
  post_id: string;
  total_quantity: number;
  delivered_quantity: number;
  frequency: ContractFrequency | null;
  start_date: string;
  end_date: string;
  price_type: ContractPriceType | null;
  status: ContractStatus;
  created_at: string;
  updated_at: string;
}

export interface ContractCreate {
  post_id: string;
  total_quantity: number;
  frequency?: ContractFrequency;
  start_date: string;
  end_date: string;
  price_type?: ContractPriceType;
  /** Optional — when true, generate the delivery schedule from
   *  (frequency, start_date, end_date) at contract creation. */
  auto_generate_schedule?: boolean;
}

// ─── Contract deliveries ──────────────────────────────────────────────────

export type ContractDeliveryStatus = "pending" | "delivered" | "partial" | "missed";

export interface ContractDelivery {
  id: string;
  contract_id: string;
  scheduled_date: string;
  quantity: number;
  status: ContractDeliveryStatus;
  delivered_quantity: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContractDeliveryUpdate {
  status?: ContractDeliveryStatus;
  delivered_quantity?: number;
  notes?: string | null;
  scheduled_date?: string;
  quantity?: number;
}

// ─── Smart pricing ────────────────────────────────────────────────────────

/**
 * Market price reference for a product (computed from historical posts +
 * responses in the same tenant). Used by the smart-pricing component to
 * warn the poster when their target_price is far above / below the market.
 *
 * The `sample_size` field surfaces how many historical rows were used — the
 * UI hides the warning when sample_size < 3 (too little data to be useful).
 */
export interface MarketPriceStats {
  product_name: string;
  average_price: number | null;
  median_price: number | null;
  min_price: number | null;
  max_price: number | null;
  sample_size: number;
  currency: string;
  /** 'high' | 'low' | 'fair' | 'unknown' — bucket the caller's target_price
   *  falls into, relative to the average ± a 15% band. */
  assessment: "high" | "low" | "fair" | "unknown";
  /** Suggested price for the next post — `average_price` rounded to the
   *  nearest whole unit. NULL when sample_size < 3. */
  suggested_price: number | null;
}
