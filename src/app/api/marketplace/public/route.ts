import { NextRequest, NextResponse } from "next/server";
import { listPublicMarketplacePosts } from "@/lib/data/marketplace-store";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { getIp } from "@/lib/api/helpers";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// ── Public marketplace listing ────────────────────────────────────────────
//
// GET /api/marketplace/public
//
// Public (unauthenticated) feed of marketplace posts across the platform.
// Used by external integrators + 3rd-party directories that want to
// surface VELOS Marketplace listings without a portal session.
//
// Rate limited: 30 requests per minute per IP. The rate-limit check uses
// the shared `check_rate_limit` Postgres RPC (migration 024) so the cap
// holds across replicas. On Supabase-unconfigured environments the
// limiter fails OPEN (returns allowed:true) — the in-memory middleware
// limiter is still in front as defense-in-depth.
//
// Query params:
//   ?type=buy|sell|auction|contract
//   ?category=<product_category>
//   ?country=<ISO 3166-1 alpha-2>
//   ?search=<free text>
//   ?page=1            (1-indexed, default 1)
//   ?limit=24           (max 100, default 24)
//
// Response shape: { items: PublicMarketplacePostItem[], total, page, limit }
// Each item's `partner` block carries ONLY: company_name, country, city,
// website, verification_level, rating_average, rating_count. No partner_id,
// no tenant_id, no contact email — that's PII we don't expose publicly.
async function _get(req: NextRequest) {
  // ── Rate-limit gate ───────────────────────────────────────────────────
  // 30 req / 60s / IP. The key is namespaced so the public-API counter
  // doesn't collide with login / portal-login / password-reset counters.
  const ip = getIp(req);
  const rl = await checkRateLimit(`mkt:public:ip:${ip}`, 30, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      {
        error: "Too many requests. The public marketplace API is rate-limited to 30 requests per minute per IP.",
        retry_after_seconds: rl.retryAfter ? Math.ceil(rl.retryAfter / 1000) : 60,
      },
      {
        status: 429,
        headers: rl.retryAfter
          ? { "Retry-After": String(Math.ceil(rl.retryAfter / 1000)) }
          : undefined,
      },
    );
  }

  const url = new URL(req.url);
  const postType = (url.searchParams.get("type") || undefined) ?? undefined;
  const allowedTypes = ["buy", "sell", "auction", "contract"];
  if (postType && !allowedTypes.includes(postType)) {
    return NextResponse.json(
      { error: `Invalid type. Must be one of: ${allowedTypes.join(", ")}.` },
      { status: 400 },
    );
  }

  // Pagination — clamp page/limit so a malicious caller can't ask for a
  // million rows. `limit` is capped at 100 (matches the auth-gated
  // listing endpoint); `page` is floored at 1.
  let page = url.searchParams.get("page") ? Number(url.searchParams.get("page")) : 1;
  if (!Number.isFinite(page) || page < 1) page = 1;
  let limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 24;
  if (!Number.isFinite(limit) || limit < 1) limit = 24;
  if (limit > 100) limit = 100;

  try {
    const result = await listPublicMarketplacePosts({
      post_type: postType,
      category: url.searchParams.get("category") || undefined,
      country: url.searchParams.get("country") || undefined,
      search: url.searchParams.get("search") || undefined,
      page,
      limit,
    });
    // Rate-limit info surfaced via response headers so callers can
    // implement back-off without parsing the error body.
    return NextResponse.json(result, {
      headers: {
        "X-RateLimit-Limit": "30",
        "X-RateLimit-Remaining": String(rl.remaining),
        "X-RateLimit-Reset": "60",
      },
    });
  } catch (e: any) {
    console.error("[marketplace.public.list]", e);
    return NextResponse.json({ error: "Failed to load public marketplace feed." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/public");
