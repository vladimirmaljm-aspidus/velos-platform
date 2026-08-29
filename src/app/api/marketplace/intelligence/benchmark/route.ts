import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getSupabase } from "@/lib/supabase/client";
import { benchmarkUser, type UserStats, type MarketStats } from "@/lib/marketplace/intelligence";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

/**
 * GET /api/marketplace/intelligence/benchmark — user's performance vs
 * the market average, for the market-intelligence dashboard.
 *
 * Returns `{ benchmark, user, market }`:
 *   • benchmark — the BenchmarkResult (response time percentile, price
 *                 competitiveness, success rate percentile).
 *   • user      — the underlying UserStats used for the comparison.
 *   • market    — the underlying MarketStats.
 *
 * Three metrics:
 *   1. Response time (hours) — the median time between a response being
 *      received and the user (or market) acting on it (accept/reject/
 *      counter). For the user, this is THEIR median across their posts.
 *      For the market, this is the tenant-wide median across all posts.
 *   2. Avg price (sell-side unit_price) — the user's average ask price
 *      vs the tenant's average ask price.
 *   3. Success rate — the % of the user's responses (as responder) that
 *      ended in `accepted` (vs the market's overall accept rate).
 *
 * Query params:
 *   ?days=<7..365>                  window size (default 90).
 *   ?category=<product_category>   filter to a single category.
 *
 * Auth: any active portal session — the comparison is the signed-in
 * partner vs the rest of the tenant's partners.
 */
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const url = new URL(req.url);
  const daysRaw = Number(url.searchParams.get("days")) || 90;
  const days = Math.max(7, Math.min(365, Math.floor(daysRaw)));
  const category = url.searchParams.get("category") || undefined;
  const since = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000,
  ).toISOString();

  const sb = getSupabase();

  const tenantId = access.tenant_id;
  const callerPartnerId = access.partner_id;
  // Helper: list responses + their post's created_at so we can compute
  // response time (response.created_at - post.created_at). We also
  // fetch the response status to compute the success rate.
  //
  // MARKET-H28(a): the response time must be computed PER POST —
  // (earliest response on that post) - (post.created_at) — and then
  // the median taken across all posts where the caller is the
  // responder. The previous implementation grouped by
  // `post_partner_id` (the post OWNER), which conflated multiple
  // posts owned by the same partner into one bucket and paired the
  // earliest response with the earliest post — sometimes on
  // completely different posts. We now select the post's `id` so
  // the median function can group by `post_id` directly.
  //
  // MARKET-H28(b): the market baseline MUST exclude the user's own
  // responses — otherwise the "market average" includes the user,
  // which makes the comparison meaningless. `fetchResponses(null)`
  // (the market path) now applies `.neq("partner_id", access.partner_id)`.
  async function fetchResponses(
    partnerId: string | null,
  ): Promise<
    Array<{
      post_id: string;
      unit_price: number | null;
      status: string;
      created_at: string;
      post_created_at: string;
      post_partner_id: string;
    }>
  > {
    // The PostgREST join fetches the response + the parent post's
    // id + created_at + partner_id in one query.
    let q = sb
      .from("marketplace_responses")
      .select(
        "id, unit_price, status, created_at, post:marketplace_posts!inner(id, created_at, partner_id, product_category, tenant_id)",
      )
      .eq("tenant_id", tenantId)
      .gte("created_at", since);
    if (partnerId) {
      q = q.eq("partner_id", partnerId);
    } else {
      // Market baseline — exclude the signed-in partner's own responses
      // so the comparison is "user vs the REST of the tenant".
      q = q.neq("partner_id", callerPartnerId);
    }
    if (category) q = q.ilike("post.product_category", category);
    const { data, error } = await q.limit(5000);
    if (error) throw error;
    return ((data as any[]) || []).map((r) => {
      const post = r.post ?? {};
      return {
        post_id: post.id,
        unit_price: r.unit_price,
        status: r.status,
        created_at: r.created_at,
        post_created_at: post.created_at,
        post_partner_id: post.partner_id,
      };
    });
  }

  let userResponses: Awaited<ReturnType<typeof fetchResponses>> = [];
  let marketResponses: Awaited<ReturnType<typeof fetchResponses>> = [];
  try {
    [userResponses, marketResponses] = await Promise.all([
      fetchResponses(access.partner_id),
      fetchResponses(null),
    ]);
  } catch (e) {
    console.error("[marketplace.intelligence.benchmark] fetch failed:", e);
    return NextResponse.json(
      { error: "Failed to compute benchmark." },
      { status: 500 },
    );
  }

  // Response time = time between post created_at and the FIRST response
  // received on that post (median across all the user's / market's
  // posts). The "first response" is the earliest created_at among the
  // responses for a given post.
  //
  // MARKET-H28(a) fix: group by `post_id` (not `post_partner_id`).
  // Each post contributes exactly one data point — (earliest response
  // on that post) - (post.created_at) — and the median is taken across
  // those per-post response times. The previous implementation grouped
  // by the post owner's partner_id, which conflated every post the
  // owner had into a single bucket and paired the earliest response
  // with the earliest post (potentially on a DIFFERENT post), producing
  // a meaningless "median".
  function medianResponseTimeHours(
    responses: Array<{
      post_id: string;
      created_at: string;
      post_created_at: string;
      post_partner_id: string;
    }>,
  ): number {
    // For each post, find the earliest response time on that post.
    const earliestResponsePerPost = new Map<string, number>();
    const postCreatedAtPerPost = new Map<string, number>();
    for (const r of responses) {
      const postT = new Date(r.post_created_at).getTime();
      const respT = new Date(r.created_at).getTime();
      if (!Number.isFinite(postT) || !Number.isFinite(respT)) continue;
      const key = r.post_id;
      const cur = earliestResponsePerPost.get(key);
      if (cur === undefined || respT < cur) {
        earliestResponsePerPost.set(key, respT);
        postCreatedAtPerPost.set(key, postT);
      }
    }
    // Per-post response time = earliest_response - post.created_at.
    const times: number[] = [];
    for (const [postId, earliestT] of earliestResponsePerPost) {
      const postT = postCreatedAtPerPost.get(postId);
      if (postT === undefined) continue;
      const hours = (earliestT - postT) / (1000 * 60 * 60);
      if (Number.isFinite(hours) && hours >= 0) times.push(hours);
    }
    if (times.length === 0) return 0;
    times.sort((a, b) => a - b);
    const mid = Math.floor(times.length / 2);
    return times.length % 2 === 0
      ? (times[mid - 1] + times[mid]) / 2
      : times[mid];
  }

  function avgPrice(
    responses: Array<{ unit_price: number | null }>,
  ): number {
    const prices = responses
      .map((r) => r.unit_price)
      .filter((p): p is number => typeof p === "number" && p > 0);
    if (prices.length === 0) return 0;
    return prices.reduce((a, b) => a + b, 0) / prices.length;
  }

  function successRate(
    responses: Array<{ status: string }>,
  ): number {
    if (responses.length === 0) return 0;
    const accepted = responses.filter((r) => r.status === "accepted").length;
    return (accepted / responses.length) * 100;
  }

  const userStats: UserStats = {
    responseTimeHours: medianResponseTimeHours(userResponses),
    avgPrice: avgPrice(userResponses),
    successRate: successRate(userResponses),
  };
  const marketStats: MarketStats = {
    responseTimeHours: medianResponseTimeHours(marketResponses),
    avgPrice: avgPrice(marketResponses),
    successRate: successRate(marketResponses),
  };

  const benchmark = benchmarkUser(userStats, marketStats);
  return NextResponse.json({
    benchmark,
    user: userStats,
    market: marketStats,
    userSampleSize: userResponses.length,
    marketSampleSize: marketResponses.length,
  });
}

export const GET = withApm(_get, "GET /api/marketplace/intelligence/benchmark");
