import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getSupabase } from "@/lib/supabase/client";
import { getMarketPriceStats } from "@/lib/data/marketplace-auction-store";
import { assessPostRisk, type RiskAssessment } from "@/lib/marketplace/risk-scoring";
import { withApm } from "@/lib/monitoring/apm";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";

export const runtime = "nodejs";

/**
 * GET /api/marketplace/[id]/risk — AI fraud / risk assessment for a post.
 *
 * Returns `{ assessment: RiskAssessment }` containing the 0–100 score, the
 * low/medium/high/critical band, the list of evaluated factors, and the
 * recommended action (approve / review / flag / block).
 *
 * The route first fetches the raw post + the partner + the market price
 * statistics for the post's product_name (so the price-outlier factors
 * can compare against a real average) + the partner's recent post count
 * (the spam-velocity signal) + the partner's company profile row +
 * rating. All of those values are passed to `assessPostRisk` as fields
 * on the `post` + `partner` objects — the scoring function is pure and
 * does not touch the DB itself.
 *
 * Auth: any active portal session in the same tenant as the post may
 * read the risk score — partners benefit from seeing which listings the
 * AI flags as risky. The score is read-only; it does NOT change the
 * post's status (that is a manual ops action, or the cron's job).
 */
async function _get(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;

  const sb = getSupabase();

  // Fetch the raw post row. We do NOT use the sanitised store helper
  // because we need partner_id + tenant_id for the lookups below; the
  // returned risk score is the public shape (no partner_id leak).
  const { data: postRow, error: postErr } = await sb
    .from("marketplace_posts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (postErr) {
    console.error("[marketplace.risk] post lookup failed:", postErr);
    return NextResponse.json({ error: "Failed to load post." }, { status: 500 });
  }
  if (!postRow) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const post = postRow as Record<string, any>;
  if (post.tenant_id !== access.tenant_id) {
    // Don't leak the existence of cross-tenant posts.
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  // Fetch the partner (the post owner) for KYC / country / type / age.
  const { data: partnerRow } = await sb
    .from("partners")
    .select("*")
    .eq("id", post.partner_id)
    .maybeSingle();
  const partner = (partnerRow ?? {}) as Record<string, any>;

  // Fetch the partner's company profile (for the no_company_profile factor
  // + the rating_average / rating_count denormalised counters).
  const { data: profileRow } = await sb
    .from("marketplace_company_profiles")
    .select("rating_average, rating_count")
    .eq("partner_id", post.partner_id)
    .maybeSingle();
  const profile = (profileRow ?? {}) as Record<string, any>;

  // Fetch the partner's lifetime post count (for the
  // large_quantity_no_history factor) + their last-24h post count (for
  // the spam_velocity factor). Two COUNT queries, both indexed by
  // partner_id + tenant_id + created_at.
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: lifetimeCount } = await sb
    .from("marketplace_posts")
    .select("id", { count: "exact", head: true })
    .eq("partner_id", post.partner_id)
    .eq("tenant_id", access.tenant_id);
  const { count: recentCount } = await sb
    .from("marketplace_posts")
    .select("id", { count: "exact", head: true })
    .eq("partner_id", post.partner_id)
    .eq("tenant_id", access.tenant_id)
    .gte("created_at", since24h);

  // Market price stats for the price-outlier factors. Falls back to
  // empty stats when there's not enough data — the scoring function
  // treats missing stats as a no-signal.
  let marketStats: {
    average_price: number | null;
    sample_size: number;
    min_price: number | null;
    max_price: number | null;
  } | null = null;
  try {
    marketStats = await getMarketPriceStats(
      access.tenant_id,
      String(post.product_name ?? ""),
      String(post.currency ?? "USD"),
      null,
    );
  } catch (e) {
    // Non-fatal — the price-outlier factors will simply not trigger.
    console.error("[marketplace.risk] market stats fetch failed:", e);
  }

  // Decorate the post + partner with the context the scoring function
  // reads. We do NOT mutate the database rows; this is a local
  // decoration in-memory only.
  const decoratedPost: Record<string, any> = {
    ...post,
    market_average: marketStats?.average_price ?? null,
    market_min: marketStats?.min_price ?? null,
    market_max: marketStats?.max_price ?? null,
    market_sample_size: marketStats?.sample_size ?? 0,
    partner_recent_post_count_24h: recentCount ?? 0,
  };
  const decoratedPartner: Record<string, any> = {
    ...partner,
    posts_count: lifetimeCount ?? 0,
    has_company_profile: !!profileRow,
    rating: profile.rating_average ?? partner.rating ?? null,
    rating_count: profile.rating_count ?? 0,
  };

  const assessment: RiskAssessment = assessPostRisk(decoratedPost, decoratedPartner);

  // Audit-log the assessment so an ops reviewer can see when / why a post
  // was flagged. Non-fatal — the assessment is the source of truth.
  try {
    const store = await getStore();
    await audit(
      store,
      {
        id: undefined,
        username: access.portal_email || `portal:${access.id}`,
        tenant_id: access.tenant_id,
      },
      req,
      "marketplace.risk_assessed",
      "marketplace_post",
      id,
      {
        score: assessment.score,
        level: assessment.level,
        recommendation: assessment.recommendation,
        triggered_factors: assessment.factors
          .filter((f) => f.triggered)
          .map((f) => f.factor),
      },
    );
  } catch (e) {
    console.error("[marketplace.risk] audit failed:", e);
  }

  return NextResponse.json({ assessment });
}

export const GET = withApm(_get, "GET /api/marketplace/[id]/risk");
