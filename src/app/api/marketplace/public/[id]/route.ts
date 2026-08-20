import { NextRequest, NextResponse } from "next/server";
import { getPublicMarketplacePost } from "@/lib/data/marketplace-store";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { getIp } from "@/lib/api/helpers";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// ── Public marketplace single-post detail ─────────────────────────────────
//
// GET /api/marketplace/public/[id]
//
// Public (unauthenticated) view of a single marketplace post. Bumps
// views_count (fire-and-forget). The returned shape is the same
// `PublicMarketplacePostItem` used by the listing — the `partner` block
// carries the verification_level (the "verification badge") + the
// rating_average + rating_count.
//
// Returns 404 when:
//   • the post doesn't exist
//   • status is not 'active'/'expired'
//   • visibility is 'private'
// (We never leak the existence of a private/draft post.)
//
// Rate limited: 30 requests per minute per IP (shared counter with the
// listing endpoint, so a heavy crawler hitting both surfaces is bounded
// by a single cap).
async function _get(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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

  const { id } = await ctx.params;
  try {
    const post = await getPublicMarketplacePost(id);
    if (!post) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json({ post }, {
      headers: {
        "X-RateLimit-Limit": "30",
        "X-RateLimit-Remaining": String(rl.remaining),
        "X-RateLimit-Reset": "60",
      },
    });
  } catch (e: any) {
    console.error("[marketplace.public.get]", e);
    return NextResponse.json({ error: "Failed to load post." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/public/[id]");
