// Marketplace profile types — VELOS B2B commodity marketplace Phase 3.
//
// Three tables (migration 045_marketplace_profiles.sql):
//   • marketplace_company_profiles — public company page per partner
//   • marketplace_reviews          — 1–5 star ratings + company response
//   • marketplace_follows          — follower/followed relationships
//
// Privacy model:
//   - Public company profiles expose marketing copy + denormalised counters
//     but NEVER the tenant_id of the company (kept in the row for the JOIN
//     to partners.name in the store, stripped before returning to the
//     browser).
//   - Reviews expose the reviewer's partner_id only when the viewer is the
//     reviewed company itself (so the company can see who rated them). The
//     public list sanitises the reviewer_partner_id — the reviewer's
//     company name is fetched separately via a JOIN at the API layer.
//   - Follows are visible to the followed company (they can see who
//     follows them) and to the follower (their own follow list). The store
//     enforces this by filtering on caller_partner_id in either column.

// Re-export the verification level type for convenience — it was first
// defined for marketplace_posts in 044 and is reused verbatim here.
export type MarketplaceVerificationLevel =
  | "none"
  | "bronze"
  | "silver"
  | "gold"
  | "platinum";

// ─── marketplace_company_profiles ─────────────────────────────────────────

/** Shape of a single entry inside `main_products` JSONB column. */
export interface CompanyMainProduct {
  name?: string;
  category?: string;
}

/** Shape of a single entry inside `certifications` JSONB column. */
export interface CompanyCertification {
  name?: string;
  issuer?: string;
  year?: number | string;
}

/**
 * Raw row in marketplace_company_profiles.
 * `tenant_id` is NEVER returned to the browser — the store strips it
 * before serialising. The sanitised public shape is `CompanyProfilePublic`.
 */
export interface CompanyProfile {
  id: string;
  tenant_id: string;
  partner_id: string;
  company_description: string | null;
  year_established: number | null;
  number_of_employees: string | null;
  website: string | null;
  linkedin_url: string | null;
  certifications: CompanyCertification[] | null;
  export_markets: string[] | null;
  main_products: CompanyMainProduct[] | null;
  verification_level: MarketplaceVerificationLevel;
  verified_at: string | null;
  verified_by: string | null;
  total_posts: number;
  total_responses: number;
  successful_deals: number;
  rating_average: number;
  rating_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * Fields a partner MAY supply when creating/updating their own profile.
 * `tenant_id` / `partner_id` / counters / verification_* are stamped by
 * the store — body-supplied values are ignored.
 */
export interface CompanyProfileUpsert {
  company_description?: string | null;
  year_established?: number | null;
  number_of_employees?: string | null;
  website?: string | null;
  linkedin_url?: string | null;
  certifications?: CompanyCertification[] | null;
  export_markets?: string[] | null;
  main_products?: CompanyMainProduct[] | null;
}

// ─── marketplace_reviews ───────────────────────────────────────────────────

export interface MarketplaceReview {
  id: string;
  reviewer_partner_id: string;
  reviewed_partner_id: string;
  post_id: string | null;
  rating: number; // 1–5
  review_text: string | null;
  response_text: string | null;
  response_at: string | null;
  is_public: boolean;
  created_at: string;
}

/** Fields a partner supplies when writing a review. */
export interface MarketplaceReviewCreate {
  reviewed_partner_id: string;
  post_id?: string | null;
  rating: number; // 1–5
  review_text?: string | null;
}

/** Patch shape for the company's response to a review. */
export interface MarketplaceReviewResponse {
  response_text: string;
}

// ─── marketplace_follows ──────────────────────────────────────────────────

export interface MarketplaceFollow {
  id: string;
  follower_partner_id: string;
  followed_partner_id: string;
  created_at: string;
}
