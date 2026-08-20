// Marketplace Phase 11 — ESG (Environmental, Social, Governance) types.
//
// Backs the three tables added in migration 052_marketplace_esg.sql:
//   • marketplace_esg_scores            — one row per company with the ESG
//                                          subscores + an overall letter
//                                          rating (AAA → CCC, S&P/MSCI-style)
//   • marketplace_sustainability_certs  — sustainability certification
//                                          ledger (FSC, RSPO, ISO 14001,
//                                          SA8000, Fairtrade, etc.) with
//                                          verification status
//   • marketplace_carbon_offsets        — carbon-offset purchases linked to a
//                                          shipment (tree planting, renewable
//                                          energy, methane capture, DAC)
//
// SECURITY MODEL
//   • `partner_id` is the canonical "who" — same convention as the rest of
//     the marketplace. The API route stamps it from the auth context; the
//     store never trusts a body-supplied partner_id.
//   • ESG scores are admin-set (super-admin only — POST /api/admin/esg-score).
//     `calculateESGScore()` is a public helper that auto-derives a
//     provisional score from the partner's verified certifications + a few
//     simple practices signals; the super-admin can confirm/override it.
//   • Sustainability certs: the owning partner can add their own certs
//     (POST /api/marketplace/esg/certs), but only super-admins can flip
//     `verified = true` (PUT /api/marketplace/esg/certs/[id] with
//     `verified: true`). Unverified certs are visible on the public profile
//     but flagged so the viewer can distinguish them.
//   • Carbon offsets: the owning partner creates them (POST
//     /api/marketplace/esg/offsets). The `status` lifecycle is
//     pending → purchased → retired (with `cancelled` as an off-ramp).
//     The certificate_url is stamped when the offset is retired.

// ─── ESG rating scale (letter grade) ────────────────────────────────────────

/**
 * Letter-grade ESG rating. Ordered from best (aaa) to worst (ccc), mirroring
 * the S&P Global / MSCI ESG rating scale. `unrated` is the default before
 * any assessment has been made.
 */
export type ESGRating =
  | "unrated"
  | "ccc"
  | "b"
  | "bb"
  | "bbb"
  | "a"
  | "aa"
  | "aaa";

/** Display order (best → worst), used by the ESG rating badge + bucket logic. */
export const ESG_RATING_ORDER: ESGRating[] = [
  "aaa", "aa", "a", "bbb", "bb", "b", "ccc", "unrated",
];

/** i18n key suffix per rating (the component prepends `marketplace-esg-rating-`). */
export const ESG_RATING_LABEL_KEY: Record<ESGRating, string> = {
  aaa: "marketplace-esg-rating-aaa",
  aa: "marketplace-esg-rating-aa",
  a: "marketplace-esg-rating-a",
  bbb: "marketplace-esg-rating-bbb",
  bb: "marketplace-esg-rating-bb",
  b: "marketplace-esg-rating-b",
  ccc: "marketplace-esg-rating-ccc",
  unrated: "marketplace-esg-rating-unrated",
};

// ─── Sustainability certification types ────────────────────────────────────

/**
 * Discriminator for the cert_type column. Each value maps to a recognisable
 * sustainability standard. The set is closed (DB CHECK constraint) so adding
 * a new cert type requires a migration — by design, to keep the labels
 * consistent across the UI.
 */
export type CertType =
  | "fsc"
  | "rspo"
  | "msc"
  | "iso14001"
  | "iso45001"
  | "iso50001"
  | "sa8000"
  | "fairtrade"
  | "organic"
  | "global_gap"
  | "rainforest_alliance"
  | "carbon_neutral"
  | "b_corp";

/**
 * i18n key suffix per cert type. The component prepends
 * `marketplace-esg-cert-` to render a human-readable label.
 */
export const CERT_TYPE_LABEL_KEY: Record<CertType, string> = {
  fsc: "marketplace-esg-cert-fsc",
  rspo: "marketplace-esg-cert-rspo",
  msc: "marketplace-esg-cert-msc",
  iso14001: "marketplace-esg-cert-iso14001",
  iso45001: "marketplace-esg-cert-iso45001",
  iso50001: "marketplace-esg-cert-iso50001",
  sa8000: "marketplace-esg-cert-sa8000",
  fairtrade: "marketplace-esg-cert-fairtrade",
  organic: "marketplace-esg-cert-organic",
  global_gap: "marketplace-esg-cert-global-gap",
  rainforest_alliance: "marketplace-esg-cert-rainforest-alliance",
  carbon_neutral: "marketplace-esg-cert-carbon-neutral",
  b_corp: "marketplace-esg-cert-b-corp",
};

/**
 * The ESG pillar (E/S/G) that a given cert type most strongly supports. Used
 * by `calculateESGScore()` to weight certifications into the three
 * subscores. A cert may inform more than one pillar; this is the primary
 * mapping only.
 */
export const CERT_TYPE_PILLAR: Record<CertType, "e" | "s" | "g"> = {
  fsc: "e", // Forest Stewardship Council — sustainable forestry (Environmental)
  rspo: "e", // Roundtable on Sustainable Palm Oil
  msc: "e", // Marine Stewardship Council — sustainable fisheries
  iso14001: "e", // Environmental management systems
  iso45001: "s", // Occupational health & safety
  iso50001: "e", // Energy management
  sa8000: "s", // Social accountability
  fairtrade: "s", // Fair trade — producer welfare
  organic: "e", // Organic production
  global_gap: "e", // Good agricultural practice
  rainforest_alliance: "e", // Conservation
  carbon_neutral: "e", // Carbon neutral certification
  b_corp: "g", // B Corp — governance + overall sustainability
};

// ─── Carbon offset types ────────────────────────────────────────────────────

/**
 * The mechanism used to offset the CO2. Drives the icon + the per-tonne
 * cost estimate used by `estimateOffsetCost()` in the store.
 */
export type CarbonOffsetType =
  | "tree_planting"
  | "renewable_energy"
  | "methane_capture"
  | "direct_air_capture";

/** i18n key suffix per offset type. */
export const OFFSET_TYPE_LABEL_KEY: Record<CarbonOffsetType, string> = {
  tree_planting: "marketplace-esg-offset-type-tree-planting",
  renewable_energy: "marketplace-esg-offset-type-renewable-energy",
  methane_capture: "marketplace-esg-offset-type-methane-capture",
  direct_air_capture: "marketplace-esg-offset-type-direct-air-capture",
};

/**
 * Lifecycle of a carbon offset:
 *   pending → purchased → retired
 * with `cancelled` as an off-ramp from `pending` / `purchased`.
 */
export type CarbonOffsetStatus =
  | "pending"
  | "purchased"
  | "retired"
  | "cancelled";

export const OFFSET_STATUS_LABEL_KEY: Record<CarbonOffsetStatus, string> = {
  pending: "marketplace-esg-offset-status-pending",
  purchased: "marketplace-esg-offset-status-purchased",
  retired: "marketplace-esg-offset-status-retired",
  cancelled: "marketplace-esg-offset-status-cancelled",
};

// ─── marketplace_esg_scores ─────────────────────────────────────────────────

/**
 * Raw row in marketplace_esg_scores. Each subscore is a number in [0, 100];
 * `overall_score` is the rounded mean of the three (kept denormalised so the
 * public profile can render it without recomputing).
 *
 * `rating` is the letter-grade bucket derived from `overall_score` —
 * the store recomputes it on every upsert so it never drifts out of sync.
 */
export interface ESGScore {
  id: string;
  partner_id: string;
  environmental_score: number;
  social_score: number;
  governance_score: number;
  overall_score: number;
  rating: ESGRating;
  assessment_date: string | null;
  assessed_by: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Shape a super-admin supplies when setting an ESG score (POST
 * /api/admin/esg-score). The store stamps `overall_score` + `rating`
 * from the three subscores; the body may optionally override
 * `assessment_date` (defaults to now) and `notes`.
 */
export interface ESGScoreUpsert {
  partner_id: string;
  environmental_score: number;
  social_score: number;
  governance_score: number;
  assessment_date?: string | null;
  notes?: string | null;
}

// ─── marketplace_sustainability_certs ──────────────────────────────────────

export interface SustainabilityCert {
  id: string;
  partner_id: string;
  cert_type: CertType;
  cert_number: string | null;
  cert_issuer: string | null;
  valid_from: string | null;
  valid_until: string | null;
  verified: boolean;
  verified_at: string | null;
  document_url: string | null;
  created_at: string;
}

/**
 * Shape a partner supplies when adding their own certification (POST
 * /api/marketplace/esg/certs). `partner_id` is stamped from the auth
 * context, never trusted from the body.
 */
export interface SustainabilityCertCreate {
  cert_type: CertType;
  cert_number?: string | null;
  cert_issuer?: string | null;
  valid_from?: string | null;
  valid_until?: string | null;
  document_url?: string | null;
}

/**
 * Patch shape used by the super-admin verify route (PUT
 * /api/marketplace/esg/certs/[id]). `verified: true` flips the cert to
 * verified and stamps `verified_at`; `verified: false` clears both.
 */
export interface SustainabilityCertPatch {
  verified?: boolean;
  cert_number?: string | null;
  cert_issuer?: string | null;
  valid_until?: string | null;
  document_url?: string | null;
}

// ─── marketplace_carbon_offsets ─────────────────────────────────────────────

export interface CarbonOffset {
  id: string;
  partner_id: string;
  shipment_id: string | null;
  co2_tons: number;
  offset_cost: number | null;
  currency: string;
  offset_type: CarbonOffsetType | null;
  status: CarbonOffsetStatus;
  certificate_url: string | null;
  created_at: string;
}

/**
 * Shape a partner supplies when creating a carbon offset (POST
 * /api/marketplace/esg/offsets). `partner_id` is stamped from the auth
 * context. `offset_cost` is optional — the store can auto-derive it from
 * the offset_type + co2_tons when not supplied (see `estimateOffsetCost()`).
 */
export interface CarbonOffsetCreate {
  shipment_id?: string | null;
  co2_tons: number;
  offset_cost?: number | null;
  currency?: string;
  offset_type?: CarbonOffsetType | null;
  certificate_url?: string | null;
}
