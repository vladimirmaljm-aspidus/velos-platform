// Marketplace Phase 5 — AI fraud / risk scoring.
//
// `assessPostRisk(post, partner)` is a PURE, DETERMINISTIC, synchronous
// scoring function. It takes a post + a partner (both already fetched by
// the API route) and returns a 0–100 risk score with a band
// (low / medium / high / critical) + a list of triggered factors and a
// recommendation (approve / review / flag / block).
//
// The score is built from 10 weighted factors. Each factor is evaluated
// independently; the function adds its weight to the running score when
// the trigger condition holds. Scores are clamped to [0, 100] before
// being bucketed into the four bands:
//
//   ┌───────────────────────────────────────────────────────────────────┐
//   │  score  │  band     │  recommendation  │  meaning                  │
//   ├─────────┼───────────┼──────────────────┼───────────────────────────┤
//   │  0–20   │  low      │  approve         │  safe — auto-approve      │
//   │  21–45  │  medium   │  review          │  ok but human-eyeball     │
//   │  46–70  │  high     │  flag            │  suspicious — freeze     │
//   │  71–100 │  critical │  block           │  almost certainly fraud  │
//   └───────────────────────────────────────────────────────────────────┘
//
// INPUT CONTRACT
//   The function accepts `any` shapes (per the task spec) so the API route
//   can decorate the raw row + partner + market aggregates with extra
//   context fields without forcing a tight type. The fields the function
//   actually reads are:
//
//   post:
//     • created_at        — ISO timestamptz (for the "new account" + "spam"
//                           check; falls back to partner.created_at)
//     • description      — free-text body (for suspicious-keyword scan)
//     • target_price     — numeric
//     • price_max        — numeric (range posts)
//     • price_type       — 'fixed' | 'range' | 'on_request'
//     • quantity         — numeric
//     • product_name     — string
//     • post_type        — 'buy' | 'sell' | 'auction' | 'contract'
//     • currency         — ISO 4217
//     • market_average   — OPTIONAL pre-computed avg (otherwise skipped)
//     • market_min       — OPTIONAL pre-computed min
//     • market_max       — OPTIONAL pre-computed max
//     • market_sample_size — OPTIONAL pre-computed sample count
//     • partner_recent_post_count_24h — OPTIONAL spam signal
//
//   partner:
//     • kyc_status       — 'not_submitted' | 'pending' | 'approved' | 'rejected'
//     • country          — ISO 3166-1 alpha-2
//     • type             — PartnerType
//     • entity_type      — 'company' | 'individual'
//     • created_at       — ISO timestamptz (account age)
//     • rating           — OPTIONAL 0–5 average rating (poor < 3)
//     • has_company_profile — OPTIONAL boolean
//     • posts_count      — OPTIONAL lifetime post count (history signal)
//
// All optional fields default to "no signal" — when missing, the
// corresponding factor is silently skipped (NOT triggered). This keeps the
// scoring function total: any subset of inputs produces a sensible score.
//
// SECURITY NOTE
//   The factors + weights were tuned by hand based on common B2B fraud
//   patterns (account age, no KYC, price outliers, quantity spikes,
//   sanctions geography, keyword red flags, spam velocity, missing
//   company profile, poor reputation). The function is INTENTIONALLY
//   server-side only — the weights are not a public API contract and the
//   API route must enforce auth before invoking it.

export interface RiskFactor {
  /** Stable slug used as the i18n key suffix + audit-trail identifier. */
  factor: string;
  /** How many points this factor contributes to the 0–100 score when triggered. */
  weight: number;
  /** Whether the trigger condition held for THIS (post, partner) pair. */
  triggered: boolean;
  /** Human-readable description (English; the UI re-translates via i18n). */
  description: string;
}

export interface RiskAssessment {
  /** 0–100, higher = more risky. Clamped before bucketing. */
  score: number;
  /** Coarse bucket for the UI badge colour. */
  level: "low" | "medium" | "high" | "critical";
  /** All evaluated factors (triggered AND not-triggered) — the UI's tooltip
   *  lists each so an ops reviewer can see what drove the score. */
  factors: RiskFactor[];
  /** Action the marketplace should take on this post. */
  recommendation: "approve" | "review" | "flag" | "block";
}

// ─── Sanctions list ──────────────────────────────────────────────────────
// A conservative, hard-coded subset of OFAC + EU + UK + UN sanctioned
// jurisdictions (as of 2024). The integrations/sanctions route does a
// live OFAC SDN search for partner NAME; this list is a fast, offline
// geography filter that catches sanctioned COUNTRIES before any
// third-party call. A partner whose `country` is in this set is
// auto-flagged high-risk regardless of other signals.
//
// The list is intentionally short — adding countries is a policy decision
// that should be deliberate (false positives block legitimate trade).
// Update the comment with the source + date when you amend it.
const SANCTIONED_COUNTRIES = new Set<string>([
  "KP", // North Korea — UN Security Council Res. 1718 / 2397
  "IR", // Iran — OFAC IEEPA / EU 2015/1863
  "SY", // Syria — EU 36/2012 / OFAC
  "CU", // Cuba — OFAC Cuban Assets Control Regulations
  "BY", // Belarus — EU 765/2006 (extended 2022)
  "RU", // Russia — sectoral sanctions (since 2022 invasion of Ukraine)
  "MM", // Myanmar (Burma) — OFAC / EU 2021/1006
  "AF", // Afghanistan — Taliban-related sanctions
  "YE", // Yemen — selected individuals / entities
  "VE", // Venezuela — OFAC E.O. 13884 (sectoral)
]);

// ─── Suspicious keyword dictionary ────────────────────────────────────────
// Lowercased substrings scanned for in `post.description`. The list is
// deliberately small + obvious — false positives would damage the user
// experience more than a missed flag. Each hit adds a flat 12-point
// contribution (capped at one hit per factor; we don't double-count).
const SUSPICIOUS_KEYWORDS: string[] = [
  "urgent",
  "asap",
  "advance payment",
  "wire transfer only",
  "western union",
  "moneygram",
  "bitcoin",
  "crypto only",
  "no escrow",
  "no inspection",
  "below market",
  "first come",
  "non-refundable deposit",
  "send your bank details",
  "verify your account",
  "lottery",
  "prize",
];

// ─── Helpers ──────────────────────────────────────────────────────────────

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (Date.now() - t) / (24 * 60 * 60 * 1000));
}

/**
 * Map a 0–100 score onto the four risk bands. Pure + exported so a unit
 * test can verify the bucket boundaries without spinning up the full
 * scoring pipeline.
 */
export function riskLevelForScore(score: number):
  | "low"
  | "medium"
  | "high"
  | "critical" {
  const s = Math.max(0, Math.min(100, score));
  if (s <= 20) return "low";
  if (s <= 45) return "medium";
  if (s <= 70) return "high";
  return "critical";
}

/**
 * Map a risk band onto the recommended marketplace action. The bands are
 * aligned with the score thresholds above.
 */
export function recommendationForLevel(
  level: "low" | "medium" | "high" | "critical",
): "approve" | "review" | "flag" | "block" {
  switch (level) {
    case "low":
      return "approve";
    case "medium":
      return "review";
    case "high":
      return "flag";
    case "critical":
      return "block";
  }
}

// ─── Main scoring function ────────────────────────────────────────────────

/**
 * Assess the fraud / risk profile of a marketplace post.
 *
 * Pure + synchronous. See the file header for the input contract. The
 * function reads `post` and `partner` defensively — every access is
 * null-checked so a missing field degrades to "no signal" rather than a
 * thrown exception.
 */
export function assessPostRisk(post: any, partner: any): RiskAssessment {
  const factors: RiskFactor[] = [];
  let score = 0;

  const postObj = (post ?? {}) as Record<string, any>;
  const partnerObj = (partner ?? {}) as Record<string, any>;

  // Resolve the "creator" timestamp — posts have their own created_at but
  // the "new account" signal really wants the partner's created_at. The
  // post timestamp is used as a fallback so the function stays total when
  // a partner row wasn't passed through.
  const partnerCreatedIso = partnerObj.created_at ?? null;
  const partnerAgeDays = daysSince(partnerCreatedIso);

  // ── Factor 1: New account (< 7 days old) ─────────────────────────────
  // A brand-new account posting a high-value commodity offer is the single
  // strongest fraud signal in B2B marketplaces. Weight: 18 (heaviest).
  {
    const triggered = partnerAgeDays !== null && partnerAgeDays < 7;
    factors.push({
      factor: "new_account",
      weight: 18,
      triggered,
      description:
        "Partner account is less than 7 days old — the strongest single fraud signal in B2B marketplaces.",
    });
    if (triggered) score += 18;
  }

  // ── Factor 2: No KYC verification ─────────────────────────────────────
  // `approved` is the only "verified" KYC state; anything else means the
  // partner hasn't cleared the identity check. Weight: 14.
  {
    const kyc = partnerObj.kyc_status ?? null;
    const triggered = kyc !== "approved";
    factors.push({
      factor: "no_kyc",
      weight: 14,
      triggered,
      description:
        "Partner has not completed KYC verification — identity unverified.",
    });
    if (triggered) score += 14;
  }

  // ── Factor 3: Price significantly below market average (>30% below) ───
  // A "too good to be true" sell price is the classic bait-and-switch
  // pattern. Only triggers when we have a market average with ≥3 samples
  // AND the post is a SELL with a visible, fixed/range price. Weight: 16.
  {
    const marketAvg = toNumber(postObj.market_average);
    const sampleSize = toNumber(postObj.market_sample_size);
    const price =
      toNumber(postObj.target_price) ?? toNumber(postObj.price_max);
    const postType = postObj.post_type ?? null;
    const priceType = postObj.price_type ?? null;
    const triggered =
      marketAvg !== null &&
      marketAvg > 0 &&
      sampleSize !== null &&
      sampleSize >= 3 &&
      price !== null &&
      price > 0 &&
      postType === "sell" &&
      priceType !== "on_request" &&
      price < marketAvg * 0.7;
    factors.push({
      factor: "price_below_market",
      weight: 16,
      triggered,
      description:
        "Target price is more than 30% below the recent market average — a classic bait-and-switch signal.",
    });
    if (triggered) score += 16;
  }

  // ── Factor 4: Price significantly above market (>50% above) ────────────
  // The flip side: a buy post offering far above market is a money-laundering
  // pattern (the buyer doesn't care about price; they care about moving
  // cash). Weight: 12 — lower than the below-market weight because the
  // legitimate "premium for speed" case is more common.
  {
    const marketAvg = toNumber(postObj.market_average);
    const sampleSize = toNumber(postObj.market_sample_size);
    const price = toNumber(postObj.target_price);
    const postType = postObj.post_type ?? null;
    const priceType = postObj.price_type ?? null;
    const triggered =
      marketAvg !== null &&
      marketAvg > 0 &&
      sampleSize !== null &&
      sampleSize >= 3 &&
      price !== null &&
      price > 0 &&
      postType === "buy" &&
      priceType !== "on_request" &&
      price > marketAvg * 1.5;
    factors.push({
      factor: "price_above_market",
      weight: 12,
      triggered,
      description:
        "Offered price is more than 50% above the recent market average — a possible money-laundering pattern.",
    });
    if (triggered) score += 12;
  }

  // ── Factor 5: Large quantity with no history ──────────────────────────
  // A first-time poster offering 100,000 MT of anything is suspicious;
  // established traders ramp volume gradually. Triggers when quantity is
  // above 1,000 (any unit) AND the partner's lifetime post count is 0 or 1.
  // Weight: 10.
  {
    const qty = toNumber(postObj.quantity);
    const partnerPostsCount = toNumber(partnerObj.posts_count);
    const triggered =
      qty !== null &&
      qty >= 1000 &&
      (partnerPostsCount === null || partnerPostsCount <= 1);
    factors.push({
      factor: "large_quantity_no_history",
      weight: 10,
      triggered,
      description:
        "Large quantity (≥1,000 units) listed by a partner with no prior posting history.",
    });
    if (triggered) score += 10;
  }

  // ── Factor 6: Suspicious keywords in description ───────────────────────
  // Lowercased substring scan. ONE hit triggers; we don't double-count
  // multiple keywords (the description's overall tone, not its word count,
  // is what matters). Weight: 12.
  {
    const desc = String(postObj.description ?? "").toLowerCase();
    const hit = SUSPICIOUS_KEYWORDS.find((k) => desc.includes(k));
    const triggered = !!hit;
    factors.push({
      factor: "suspicious_keywords",
      weight: 12,
      triggered,
      description: hit
        ? `Description contains a suspicious keyword ("${hit}") commonly used in advance-fee fraud.`
        : "Description scanned for advance-fee / wire-fraud keywords — none found.",
    });
    if (triggered) score += 12;
  }

  // ── Factor 7: Multiple posts in short time (spam) ─────────────────────
  // Three or more posts in the last 24h by the same partner is the spam
  // velocity signal — legitimate B2B sellers post a handful per week, not
  // a flood. Weight: 8.
  {
    const recentCount = toNumber(postObj.partner_recent_post_count_24h);
    const triggered = recentCount !== null && recentCount >= 3;
    factors.push({
      factor: "spam_velocity",
      weight: 8,
      triggered,
      description:
        "Partner posted three or more offers in the last 24 hours — a spam velocity pattern.",
    });
    if (triggered) score += 8;
  }

  // ── Factor 8: Country on sanctions list ───────────────────────────────
  // Hard geography block — overrides the score floor to 50 (high band)
  // when triggered so the post is always at least flagged. Weight: 30.
  {
    const country = String(partnerObj.country ?? "").toUpperCase();
    const triggered = !!country && SANCTIONED_COUNTRIES.has(country);
    factors.push({
      factor: "sanctions_country",
      weight: 30,
      triggered,
      description: triggered
        ? `Partner's country (${country}) appears on the OFAC / EU / UK / UN sanctions list.`
        : "Partner's country is not on the sanctions watchlist.",
    });
    if (triggered) {
      score += 30;
      // Floor at 50 — sanctions geography on its own is enough for a flag.
      if (score < 50) score = 50;
    }
  }

  // ── Factor 9: No company profile ──────────────────────────────────────
  // An individual entity_type with no marketplace_company_profile row is
  // a red flag for commodity trading (B2B is overwhelmingly companies).
  // Weight: 6.
  {
    const hasProfile =
      partnerObj.has_company_profile === true ||
      partnerObj.entity_type === "company" ||
      partnerObj.entity_type === "Company";
    const triggered = !hasProfile;
    factors.push({
      factor: "no_company_profile",
      weight: 6,
      triggered,
      description:
        "Partner has no company profile / is registered as an individual — unusual for B2B commodity trade.",
    });
    if (triggered) score += 6;
  }

  // ── Factor 10: Poor rating (< 3 stars) ────────────────────────────────
  // A sub-3-star average rating from at least 2 reviews means counterparties
  // have had bad experiences. Weight: 8. Skipped when there is no rating
  // (a new partner isn't penalised for not having been reviewed yet).
  {
    const rating = toNumber(partnerObj.rating);
    const ratingCount = toNumber(partnerObj.rating_count);
    const triggered =
      rating !== null && rating < 3 && (ratingCount === null || ratingCount >= 2);
    factors.push({
      factor: "poor_rating",
      weight: 8,
      triggered,
      description:
        "Partner's average rating is below 3 stars — counterparties have reported bad experiences.",
    });
    if (triggered) score += 8;
  }

  // Clamp to [0, 100] before bucketing. The sum of all weights is 134, so
  // a worst-case post can saturate the score easily; the clamp keeps the
  // number meaningful (100 = "as risky as it gets").
  const clampedScore = Math.max(0, Math.min(100, Math.round(score)));
  const level = riskLevelForScore(clampedScore);
  const recommendation = recommendationForLevel(level);

  return {
    score: clampedScore,
    level,
    factors,
    recommendation,
  };
}

// ─── Sanctions list export (route re-uses for the geography filter) ───────

/**
 * Read-only accessor for the sanctions country set. Used by the
 * marketplace risk API route to ALSO stamp the assessment onto the post
 * row (denormalised) so a future cron can sweep all flagged posts without
 * re-running the scoring pipeline.
 */
export function isSanctionedCountry(code: string | null | undefined): boolean {
  if (!code) return false;
  return SANCTIONED_COUNTRIES.has(String(code).toUpperCase());
}
