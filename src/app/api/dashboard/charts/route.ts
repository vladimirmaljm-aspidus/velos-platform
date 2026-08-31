import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthOrApiKey,
  requireAuthOrApiKeyPermission,
  resolveTenantId,
  getIp,
  sanitizeError,
} from "@/lib/api/helpers";
import { withApm } from "@/lib/monitoring/apm";
// 9b-N13 — dashboard routes had no rate limit. A caller with a valid
// session OR API key could spam getDashboardCharts() (multi-join
// aggregations + Top-N ordering) without any per-IP cap. The DB-backed
// rate limiter (migration 024) is shared across instances — the cap
// holds even on multi-replica deploys. 60 req/min/IP is generous (a
// legit dashboard polls at 30s × 1 tab = 2 req/min) but blocks a
// single attacker from saturating the dashboard endpoints.
import { checkRateLimit } from "@/lib/security/rate-limiter";

export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/dashboard/charts?period=12m&topN=5
//
// Returns the FIVE aggregated datasets powering the dashboard analytics
// charts (task D-2), in a single round-trip:
//
//   • salesData         — monthly revenue (invoices issued, excl. cancelled)
//   • topProducts       — top-N products by offer line-item revenue
//   • offerStatus       — count + total value grouped by OfferStatus
//   • marginByCategory  — avg (price-cost)/price % by Product.category
//   • paymentTrend      — monthly payments received (paid invoices)
//
// Query params:
//   • period — "12m" (default) or "6m". Any other value falls back to 12m.
//   • topN   — caps the TopProducts series (1–20, default 5).
//
// Auth: session cookie OR API key (matches the existing /api/dashboard
// route). Permission gate is `dashboard.read` for session-auth callers;
// API-key callers must hold `dashboard:read` (or `*`).
//
// The aggregation runs ENTIRELY server-side via Store.getDashboardCharts
// — the wire payload is a few KB at most (12 monthly buckets × 5 series +
// up to 20 product rows). The client just renders.
// ─────────────────────────────────────────────────────────────────────────────

async function _get(req: NextRequest) {
  try {
    // 9b-N13 — per-IP rate limit, runs BEFORE auth so unauthenticated
    // probes are also capped. 429 + Retry-After on limit exceeded.
    const rl = await checkRateLimit(`dashboard:ip:${getIp(req)}`, 60, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many dashboard requests. Try again later." },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil((rl.retryAfter ?? 60_000) / 1000)) },
        },
      );
    }

    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;

    // U-FIX (RBAC audit D-1 / P1): the permission check was previously
    // commented out — meaning BOTH session and API-key callers skipped
    // it. Re-enabled using the new helper which checks permissions for
    // BOTH auth modes. API-key callers MUST hold `dashboard:read` (or
    // `*`); session callers are gated via `can()` → `dashboard.read`.
    // Until this fix, any API key (even with `permissions: []`) could
    // read the full charts payload: monthly revenue, top products by
    // revenue, offer-status distribution, margin-by-category, payment
    // trend — the most sensitive financial KPIs the dashboard surfaces.
    const denied = requireAuthOrApiKeyPermission(auth, "dashboard.read");
    if (denied) return denied;

    const tid = resolveTenantId(auth, req);

    // ── Parse + clamp query params ────────────────────────────────────────
    const url = new URL(req.url);
    const periodRaw = url.searchParams.get("period") || "12m";
    // Only honour "12m" and "6m" — anything else falls back to 12m so a
    // mistyped `?period=24m` doesn't blow up the bucket generator.
    const period: string = periodRaw === "6m" ? "6m" : "12m";

    const topNRaw = Number(url.searchParams.get("topN"));
    // Clamp topN to [1, 20] — negative / NaN / huge values get the default
    // of 5. The SupabaseStore implementation re-clamps defensively too.
    const topN: number = Number.isFinite(topNRaw) && topNRaw > 0
      ? Math.min(Math.max(Math.floor(topNRaw), 1), 20)
      : 5;

    const charts = await auth.store.getDashboardCharts(tid ?? null, period, topN);

    return NextResponse.json(charts);
  } catch (e: unknown) {
    console.error("[dashboard/charts GET]", e);
    return NextResponse.json(
      { error: sanitizeError(e) },
      { status: 500 },
    );
  }
}

// ── APM wrapper (task D-8) ───────────────────────────────────────────────
// Wraps GET with response-time, slow-request, and error-rate metrics.
// See src/lib/monitoring/apm.ts for the buffer + dashboard wiring.
export const GET = withApm(_get, "GET /api/dashboard/charts");
