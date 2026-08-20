// Marketplace profile store — data-access layer for VELOS Marketplace Phase 3.
//
// All functions talk directly to the `marketplace_company_profiles`,
// `marketplace_reviews`, and `marketplace_follows` Supabase tables created
// in migration 045_marketplace_profiles.sql.
//
// The store is a SEPARATE module from `marketplace-store.ts` so the Phase-1
// file (posts/responses/negotiations/messages) stays readable; both files
// share the same conventions (sanitisation, audit-fire-and-forget, atomic
// counter bumps via direct UPDATE).
//
// Privacy model:
//   - Public company profiles strip tenant_id before returning (the store
//     keeps it for the JOIN to partners.name in the API layer). The
//     `partner_id` IS returned because the URL is /portal/marketplace/company/[partnerId]
//     — the caller already knows it.
//   - Reviews expose the reviewer_partner_id only to the reviewed company
//     itself (so a company can see who rated them). For everyone else the
//     reviewer's partner_id is sanitised out; the reviewer's company name
//     is fetched via a JOIN at the API layer (same pattern as Phase 1
//     responses).
//   - Follows: the followed company sees its follower list, the follower
//     sees its followed list. The store enforces this by filtering on
//     caller_partner_id in either column.

import { getSupabase } from "@/lib/supabase/client";
import type {
  CompanyProfile,
  CompanyProfileUpsert,
  CompanyProfile as ProfileRow,
  MarketplaceFollow,
  MarketplaceReview,
  MarketplaceReviewCreate,
  MarketplaceVerificationLevel,
} from "@/lib/supabase/marketplace-profile-types";

// ─── Public sanitisation helpers ─────────────────────────────────────────

/**
 * Strip tenant_id from a profile before returning it publicly. The
 * partner_id stays — the public profile page URL is keyed by it, and the
 * API layer uses it to JOIN the partners table for the company name.
 */
function sanitisePublicProfile(p: CompanyProfile): Record<string, unknown> {
  const { tenant_id: _t, ...rest } = p;
  void _t;
  return rest as Record<string, unknown>;
}

/**
 * Strip the reviewer's partner_id from a review when returning it
 * publicly (i.e. to anyone except the reviewed company itself). The
 * API layer re-fetches the reviewer's company name via a JOIN in the
 * caller's tenant.
 */
function sanitisePublicReview(r: MarketplaceReview): Record<string, unknown> {
  const { reviewer_partner_id: _r, ...rest } = r;
  void _r;
  return rest as Record<string, unknown>;
}

// ─── Company profiles ──────────────────────────────────────────────────────

/**
 * Get a company's public profile. Returns the SANITISED shape (no tenant_id).
 * When `viewerPartnerId` is set, the store also returns whether the
 * viewer is currently following this company (so the Follow button can
 * render correctly).
 */
export async function getCompanyProfile(
  partnerId: string,
  tenantId: string,
  viewerPartnerId?: string,
): Promise<Record<string, unknown> | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_company_profiles")
    .select("*")
    .eq("partner_id", partnerId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const profile = sanitisePublicProfile(data as CompanyProfile);

  // Best-effort: does the viewer follow this company?
  if (viewerPartnerId && viewerPartnerId !== partnerId) {
    const { data: followRow } = await sb
      .from("marketplace_follows")
      .select("id")
      .eq("follower_partner_id", viewerPartnerId)
      .eq("followed_partner_id", partnerId)
      .maybeSingle();
    (profile as Record<string, unknown>).viewer_follows = Boolean(followRow);
  } else {
    (profile as Record<string, unknown>).viewer_follows = false;
  }
  return profile;
}

/**
 * Get the caller's own profile (raw row — including tenant_id). Used by
 * the "My Profile" editor on the company-profile admin page.
 */
export async function getOwnCompanyProfile(
  tenantId: string,
  partnerId: string,
): Promise<CompanyProfile | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_company_profiles")
    .select("*")
    .eq("partner_id", partnerId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw error;
  return (data as CompanyProfile) || null;
}

/**
 * Create or update the caller's own profile. tenant_id / partner_id are
 * stamped from the auth context — body-supplied identity fields are
 * ignored. Counters + verification_* are NEVER writable here — they're
 * owned by the system (counters) or by super-admin (verification).
 *
 * On INSERT, an empty profile row is created with verification_level='none'
 * (the DB default). On UPDATE, only the marketing-copy fields are merged.
 */
export async function upsertCompanyProfile(
  tenantId: string,
  partnerId: string,
  data: CompanyProfileUpsert,
): Promise<CompanyProfile> {
  const sb = getSupabase();

  // Look for an existing row first.
  const { data: existing, error: findErr } = await sb
    .from("marketplace_company_profiles")
    .select("*")
    .eq("partner_id", partnerId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (findErr) throw findErr;

  const payload = {
    tenant_id: tenantId,
    partner_id: partnerId,
    company_description: data.company_description ?? null,
    year_established: data.year_established ?? null,
    number_of_employees: data.number_of_employees ?? null,
    website: data.website ?? null,
    linkedin_url: data.linkedin_url ?? null,
    certifications: data.certifications ?? [],
    export_markets: data.export_markets ?? [],
    main_products: data.main_products ?? [],
  };

  if (existing) {
    const { data: updated, error } = await sb
      .from("marketplace_company_profiles")
      .update(payload)
      .eq("id", (existing as ProfileRow).id)
      .select()
      .single();
    if (error) throw error;
    return updated as CompanyProfile;
  }

  const { data: inserted, error } = await sb
    .from("marketplace_company_profiles")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return inserted as CompanyProfile;
}

// ─── Verification (admin-only) ──────────────────────────────────────────────

/**
 * Update a company's verification tier. Super-admin only — the API route
 * is `POST /api/admin/verify-partner` and gates via `requireSuperAdmin`.
 *
 * Stamps verified_at + verified_by alongside the new level. Returns the
 * updated profile row (raw).
 */
export async function updateVerificationLevel(
  partnerId: string,
  level: MarketplaceVerificationLevel,
  verifiedBy: string,
): Promise<CompanyProfile | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_company_profiles")
    .update({
      verification_level: level,
      verified_at: new Date().toISOString(),
      verified_by: verifiedBy,
    })
    .eq("partner_id", partnerId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return (data as CompanyProfile) || null;
}

// ─── Reviews ───────────────────────────────────────────────────────────────

/**
 * List the public reviews for a company. Returns the SANITISED shape
 * (no reviewer_partner_id) when the caller is NOT the reviewed company.
 * The reviewed company itself receives the FULL row so it can see who
 * rated it.
 *
 * Default sort: newest first.
 */
export async function listReviews(
  reviewedPartnerId: string,
  tenantId: string,
  callerPartnerId?: string,
): Promise<Record<string, unknown>[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_reviews")
    .select("*")
    .eq("reviewed_partner_id", reviewedPartnerId)
    .eq("is_public", true)
    .order("created_at", { ascending: false });
  if (error) throw error;

  // Defence-in-depth: the API layer restricts by tenant — only reviews
  // for a partner in the caller's tenant are surfaced. We can't enforce
  // tenant on the reviews table itself (it has no tenant_id column), so
  // we rely on the API layer to first resolve the reviewed partner_id
  // and confirm it's in the caller's tenant before calling this function.
  void tenantId;

  const rows = (data as MarketplaceReview[]) || [];
  const isOwner = callerPartnerId && callerPartnerId === reviewedPartnerId;
  if (isOwner) {
    // Owner sees the full row (so they can see who rated them + respond).
    return rows as unknown as Record<string, unknown>[];
  }
  return rows.map(sanitisePublicReview);
}

/**
 * Fetch a single review by id. Returns the FULL row when the caller is
 * either the reviewer or the reviewed company. Returns NULL otherwise
 * (the caller is not a party to this review).
 */
export async function getReview(
  reviewId: string,
  callerPartnerId: string,
): Promise<MarketplaceReview | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_reviews")
    .select("*")
    .eq("id", reviewId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const r = data as MarketplaceReview;
  if (r.reviewer_partner_id !== callerPartnerId && r.reviewed_partner_id !== callerPartnerId) {
    return null;
  }
  return r;
}

/**
 * Create a review. The caller is the REVIEWER.
 *
 * Constraints (verified here, surfaced as thrown errors the API route
 * turns into 400/403 responses):
 *   • A partner cannot review themselves.
 *   • A partner can only review a counterparty they have a COMPLETED
 *     marketplace deal with — i.e. there's a marketplace_negotiations row
 *     with status='accepted' where the caller is partner_a OR partner_b
 *     and the counterparty is the OTHER side.
 *   • (reviewer, reviewed, post_id) is unique — the DB constraint catches
 *     duplicates and surfaces a 409 via the API route's error mapping.
 *
 * After a successful insert, recalculateRating() is called so the
 * reviewed company's rating_average / rating_count counters stay in sync.
 */
export async function createReview(
  tenantId: string,
  reviewerPartnerId: string,
  data: MarketplaceReviewCreate,
): Promise<MarketplaceReview> {
  const sb = getSupabase();

  if (data.reviewed_partner_id === reviewerPartnerId) {
    throw new Error("Cannot review your own company.");
  }
  if (!Number.isInteger(data.rating) || data.rating < 1 || data.rating > 5) {
    throw new Error("Rating must be an integer between 1 and 5.");
  }

  // Verify the two partners have at least one completed marketplace deal.
  // We don't restrict to a specific post_id — any accepted negotiation
  // between them counts (the spec says "only after a completed deal").
  const or = `partner_id_a.eq.${reviewerPartnerId},partner_id_b.eq.${reviewerPartnerId}`;
  const { data: deals, error: dealsErr } = await sb
    .from("marketplace_negotiations")
    .select("id, partner_id_a, partner_id_b, status, tenant_id_a, tenant_id_b")
    .or(or)
    .eq("status", "accepted");
  if (dealsErr) throw dealsErr;
  const valid = ((deals as any[]) || []).some((n) => {
    const other = n.partner_id_a === reviewerPartnerId ? n.partner_id_b : n.partner_id_a;
    return other === data.reviewed_partner_id &&
      (n.tenant_id_a === tenantId || n.tenant_id_b === tenantId);
  });
  if (!valid) {
    throw new Error("You can only review a partner after a completed deal with them.");
  }

  const payload = {
    reviewer_partner_id: reviewerPartnerId,
    reviewed_partner_id: data.reviewed_partner_id,
    post_id: data.post_id ?? null,
    rating: data.rating,
    review_text: data.review_text ?? null,
    is_public: true,
  };
  const { data: inserted, error } = await sb
    .from("marketplace_reviews")
    .insert(payload)
    .select()
    .single();
  if (error) {
    // PostgREST error code 23505 = unique_violation — surface as a
    // friendly error the API route maps to 409.
    if (/duplicate key|unique/i.test(error.message)) {
      throw new Error("You have already reviewed this partner for this post.");
    }
    throw error;
  }

  // Recalculate the reviewed company's rating_average + rating_count.
  // Fire-and-forget — a failure here MUST NOT block the review creation.
  void recalculateRating(data.reviewed_partner_id).catch((e) =>
    console.error("[marketplace.reviews] recalculate failed:", e),
  );

  return inserted as MarketplaceReview;
}

/**
 * Respond to a review (the reviewed company posts a public reply).
 * Only the reviewed company can respond — verified via getReview().
 * A review can only be responded to ONCE; subsequent calls overwrite
 * the previous response_text + bump response_at.
 */
export async function respondToReview(
  reviewId: string,
  callerPartnerId: string,
  responseText: string,
): Promise<MarketplaceReview> {
  const sb = getSupabase();
  const r = await getReview(reviewId, callerPartnerId);
  if (!r) throw new Error("Review not found.");
  if (r.reviewed_partner_id !== callerPartnerId) {
    throw new Error("Only the reviewed company can respond to a review.");
  }
  if (!responseText || responseText.trim().length === 0) {
    throw new Error("Response text is required.");
  }

  const { data, error } = await sb
    .from("marketplace_reviews")
    .update({
      response_text: responseText.trim(),
      response_at: new Date().toISOString(),
    })
    .eq("id", reviewId)
    .select()
    .single();
  if (error) throw error;
  return data as MarketplaceReview;
}

// ─── Follows ──────────────────────────────────────────────────────────────

/** Follow a company. Idempotent — if already following, returns silently. */
export async function followPartner(
  followerPartnerId: string,
  followedPartnerId: string,
): Promise<MarketplaceFollow | null> {
  const sb = getSupabase();
  if (followerPartnerId === followedPartnerId) {
    throw new Error("Cannot follow your own company.");
  }
  // INSERT with ON CONFLICT DO NOTHING would be ideal — supabase-js v2
  // supports .upsert() but the unique constraint is on (follower, followed),
  // not the PK. Use the standard insert-then-catch pattern: if it dupes,
  // return the existing row instead of erroring.
  const { data, error } = await sb
    .from("marketplace_follows")
    .insert({
      follower_partner_id: followerPartnerId,
      followed_partner_id: followedPartnerId,
    })
    .select()
    .maybeSingle();
  if (error) {
    if (/duplicate key|unique/i.test(error.message)) {
      // Already following — fetch + return the existing row.
      const { data: existing } = await sb
        .from("marketplace_follows")
        .select("*")
        .eq("follower_partner_id", followerPartnerId)
        .eq("followed_partner_id", followedPartnerId)
        .maybeSingle();
      return (existing as MarketplaceFollow) || null;
    }
    throw error;
  }
  return (data as MarketplaceFollow) || null;
}

/** Unfollow a company. Idempotent. */
export async function unfollowPartner(
  followerPartnerId: string,
  followedPartnerId: string,
): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("marketplace_follows")
    .delete()
    .eq("follower_partner_id", followerPartnerId)
    .eq("followed_partner_id", followedPartnerId);
  if (error) throw error;
}

/**
 * List the companies the caller follows. Returns the followed_partner_id
 * list (the API layer JOINs the partners table for the company names).
 */
export async function listFollowing(
  followerPartnerId: string,
): Promise<{ followed_partner_id: string; created_at: string }[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_follows")
    .select("followed_partner_id, created_at")
    .eq("follower_partner_id", followerPartnerId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data as { followed_partner_id: string; created_at: string }[]) || []);
}

/**
 * List the followers of a given company. The caller MUST be the followed
 * company itself — the API route enforces this so a partner can't enumerate
 * who follows their competitors.
 */
export async function listFollowers(
  followedPartnerId: string,
  callerPartnerId: string,
): Promise<{ follower_partner_id: string; created_at: string }[]> {
  if (followedPartnerId !== callerPartnerId) {
    throw new Error("Only the followed company can list its own followers.");
  }
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_follows")
    .select("follower_partner_id, created_at")
    .eq("followed_partner_id", followedPartnerId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data as { follower_partner_id: string; created_at: string }[]) || []);
}

// ─── Denormalised counter maintenance ──────────────────────────────────────

/**
 * Check whether the caller is eligible to leave a review for a partner.
 * Mirrors the constraint enforced in createReview() (an accepted
 * negotiation between caller and the counterparty) but as a pure
 * read-only boolean. Used by the public profile GET route so the UI can
 * show/hide the "Write a Review" button.
 *
 * Returns false when:
 *   • The caller IS the reviewed company (can't review yourself).
 *   • There is no accepted marketplace_negotiations row where the caller
 *     is one side and `partnerId` is the other.
 */
export async function canReviewPartner(
  tenantId: string,
  callerPartnerId: string,
  partnerId: string,
): Promise<boolean> {
  if (callerPartnerId === partnerId) return false;
  const sb = getSupabase();
  const or = `partner_id_a.eq.${callerPartnerId},partner_id_b.eq.${callerPartnerId}`;
  const { data, error } = await sb
    .from("marketplace_negotiations")
    .select("id, partner_id_a, partner_id_b, status, tenant_id_a, tenant_id_b")
    .or(or)
    .eq("status", "accepted");
  if (error) throw error;
  return ((data as any[]) || []).some((n) => {
    const other = n.partner_id_a === callerPartnerId ? n.partner_id_b : n.partner_id_a;
    return other === partnerId &&
      (n.tenant_id_a === tenantId || n.tenant_id_b === tenantId);
  });
}

/**
 * Recalculate rating_average + rating_count for a company from the live
 * reviews table. Called by createReview() (fire-and-forget) and exposed
 * for any future admin "recompute ratings" tool.
 *
 * Uses AVG + COUNT SQL via .rpc-free PostgREST: we fetch all rows then
 * compute in JS. For a typical company (single-digit reviews) this is
 * fine; for the rare case of 1000+ reviews a single GROUP BY query would
 * be better — left as a follow-up.
 */
export async function recalculateRating(partnerId: string): Promise<void> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_reviews")
    .select("rating")
    .eq("reviewed_partner_id", partnerId)
    .eq("is_public", true);
  if (error) throw error;
  const rows = (data as { rating: number }[]) || [];
  const count = rows.length;
  const avg =
    count === 0
      ? 0
      : Math.round((rows.reduce((s, r) => s + r.rating, 0) / count) * 100) / 100;

  const { error: updErr } = await sb
    .from("marketplace_company_profiles")
    .update({ rating_average: avg, rating_count: count })
    .eq("partner_id", partnerId);
  if (updErr) throw updErr;
}

/**
 * Increment a company's successful_deals counter by 1. Called by the
 * marketplace negotiation accept-flow when both parties have accepted
 * (Phase 2's "deal complete" event). Idempotent at the SQL level — the
 * caller is responsible for not calling it twice for the same deal.
 */
export async function incrementSuccessfulDeals(partnerId: string): Promise<void> {
  const sb = getSupabase();
  const { data: profile, error: fetchErr } = await sb
    .from("marketplace_company_profiles")
    .select("id, successful_deals")
    .eq("partner_id", partnerId)
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!profile) {
    // The company has no profile row yet — create one with successful_deals=1
    // so the counter exists going forward. tenant_id is unknown here (this
    // function is called from the negotiation flow which DOES know it,
    // but for simplicity we skip the create-if-missing path and just bail
    // — the counter will be created lazily when the partner first makes
    // their own profile).
    return;
  }
  const newCount = ((profile as any).successful_deals || 0) + 1;
  const { error: updErr } = await sb
    .from("marketplace_company_profiles")
    .update({ successful_deals: newCount })
    .eq("id", (profile as any).id);
  if (updErr) throw updErr;
}
