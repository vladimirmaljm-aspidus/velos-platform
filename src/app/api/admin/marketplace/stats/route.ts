import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/marketplace/stats
//
// Aggregated marketplace metrics for the super-admin Overview tab +
// Statistics tab. All counts are CROSS-TENANT — the admin sees the whole
// platform at once.
//
// Response shape:
//   {
//     totals: { posts, responses, negotiations, companies, reviews, blacklist, flagged_posts, flagged_reviews },
//     posts_by_status:  { active, expired, flagged, draft, closed },
//     posts_by_type:    { buy, sell, auction, contract },
//     responses_by_status: { sent, viewed, accepted, rejected, countered, expired },
//     recent_activity:  AuditLog[]    — last 20 marketplace.* audit entries
//     posts_over_time:   [{ date: "YYYY-MM-DD", count }]   — last 30 days
//     responses_over_time: [{ date: "YYYY-MM-DD", count }] — last 30 days
//     top_categories:    [{ name, count }]
//     top_countries:     [{ country, count }]
//     top_companies:     [{ partner_id, name, posts, responses }]
//   }
//
// Auth: super_admin only.
// ─────────────────────────────────────────────────────────────────────────────
async function _get(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const sb = getSupabase();

    // ── Totals (head=true count queries — no rows transferred) ──────────────
    const [
      postsC, responsesC, negotiationsC, profilesC, reviewsC, blacklistC,
      flaggedPostsC, flaggedReviewsC,
    ] = await Promise.all([
      sb.from("marketplace_posts").select("id", { count: "exact", head: true }),
      sb.from("marketplace_responses").select("id", { count: "exact", head: true }),
      sb.from("marketplace_negotiations").select("id", { count: "exact", head: true }),
      sb.from("marketplace_company_profiles").select("id", { count: "exact", head: true }),
      sb.from("marketplace_reviews").select("id", { count: "exact", head: true }),
      sb.from("marketplace_blacklist").select("id", { count: "exact", head: true }),
      sb.from("marketplace_posts").select("id", { count: "exact", head: true }).eq("status", "flagged"),
      sb.from("marketplace_reviews").select("id", { count: "exact", head: true }).eq("is_flagged", true),
    ]);

    // ── Distributions — fetch all rows once, aggregate in JS so we make
    // one query per table instead of one per status. Capped at 5000 rows
    // per table to keep the response time bounded on a busy platform. ──────
    const [{ data: posts }, { data: responses }] = await Promise.all([
      sb.from("marketplace_posts").select("id, status, post_type, product_category, delivery_country, partner_id, created_at").limit(5000).order("created_at", { ascending: false }),
      sb.from("marketplace_responses").select("id, status, created_at").limit(5000).order("created_at", { ascending: false }),
    ]);

    const postsByStatus: Record<string, number> = {};
    const postsByType: Record<string, number> = {};
    const responsesByStatus: Record<string, number> = {};
    const catCounts: Record<string, number> = {};
    const countryCounts: Record<string, number> = {};
    const companyCounts: Record<string, number> = {};

    for (const p of (posts as any[]) || []) {
      postsByStatus[p.status] = (postsByStatus[p.status] || 0) + 1;
      postsByType[p.post_type] = (postsByType[p.post_type] || 0) + 1;
      if (p.product_category) catCounts[p.product_category] = (catCounts[p.product_category] || 0) + 1;
      if (p.delivery_country) countryCounts[p.delivery_country] = (countryCounts[p.delivery_country] || 0) + 1;
      if (p.partner_id) companyCounts[p.partner_id] = (companyCounts[p.partner_id] || 0) + 1;
    }
    for (const r of (responses as any[]) || []) {
      responsesByStatus[r.status] = (responsesByStatus[r.status] || 0) + 1;
    }

    // ── Over-time series (last 30 days, bucketed by day) ────────────────────
    const now = new Date();
    const days: { date: string; posts: number; responses: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      days.push({ date: key, posts: 0, responses: 0 });
    }
    const dayByKey = new Map(days.map((d) => [d.date, d]));
    for (const p of (posts as any[]) || []) {
      const k = String(p.created_at || "").slice(0, 10);
      if (dayByKey.has(k)) dayByKey.get(k)!.posts += 1;
    }
    for (const r of (responses as any[]) || []) {
      const k = String(r.created_at || "").slice(0, 10);
      if (dayByKey.has(k)) dayByKey.get(k)!.responses += 1;
    }

    // ── Top companies — hydrate partner_id → name ───────────────────────────
    const topPartnerIds = Object.entries(companyCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id]) => id);
    let topCompanies: { partner_id: string; name: string; posts: number }[] = [];
    if (topPartnerIds.length > 0) {
      const { data: partnerRows } = await sb
        .from("partners")
        .select("id, name")
        .in("id", topPartnerIds);
      const nameById = Object.fromEntries(((partnerRows as any[]) || []).map((p) => [p.id, p.name]));
      topCompanies = topPartnerIds.map((id) => ({
        partner_id: id,
        name: nameById[id] ?? "—",
        posts: companyCounts[id],
      }));
    }

    const topCategories = Object.entries(catCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    const topCountries = Object.entries(countryCounts)
      .map(([country, count]) => ({ country, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // ── Recent activity — last 20 marketplace.* audit entries ───────────────
    let recentActivity: any[] = [];
    try {
      const { data: actRows } = await sb
        .from("audit_logs")
        .select("*")
        .like("action", "marketplace.%")
        .order("created_at", { ascending: false })
        .limit(20);
      recentActivity = actRows ?? [];
    } catch {
      // audit_logs table may not be readable in some configs — degrade
      // gracefully to an empty feed.
      recentActivity = [];
    }

    return NextResponse.json({
      totals: {
        posts: postsC.count ?? 0,
        responses: responsesC.count ?? 0,
        negotiations: negotiationsC.count ?? 0,
        companies: profilesC.count ?? 0,
        reviews: reviewsC.count ?? 0,
        blacklist: blacklistC.count ?? 0,
        flagged_posts: flaggedPostsC.count ?? 0,
        flagged_reviews: flaggedReviewsC.count ?? 0,
      },
      posts_by_status: postsByStatus,
      posts_by_type: postsByType,
      responses_by_status: responsesByStatus,
      recent_activity: recentActivity,
      posts_over_time: days.map((d) => ({ date: d.date, count: d.posts })),
      responses_over_time: days.map((d) => ({ date: d.date, count: d.responses })),
      top_categories: topCategories,
      top_countries: topCountries,
      top_companies: topCompanies,
    });
  } catch (e: any) {
    console.error("[admin.marketplace.stats] GET failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/admin/marketplace/stats");
