import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// In-process cache for the news feed. The web-search SDK call is rate-
// limited (and slow) — cache for 30 minutes per (category, locale) so a
// dashboard refresh doesn't re-fire the search.
interface NewsCacheEntry {
  items: NewsItem[];
  fetchedAt: number;
}
const NEWS_CACHE = new Map<string, NewsCacheEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface NewsItem {
  title: string;
  url: string;
  snippet: string;
  source: string;
  date: string;
}

/**
 * GET /api/marketplace/intelligence/news — commodity market news feed.
 *
 * Uses the z-ai-web-dev-sdk web_search function to fetch news for the
 * selected category + locale. The results are cached in-process for 30
 * minutes so dashboard refreshes don't re-fire the search.
 *
 * Returns `{ items, fetchedAt, source }`:
 *   • items     — NewsItem[] (title, url, snippet, source, date).
 *   • fetchedAt — ISO timestamp of the last refresh.
 *   • source    — 'web-search' or 'cache' or 'empty' (when the SDK is
 *                 unavailable or returned no results).
 *
 * Query params:
 *   ?category=<product_category>   the commodity to search news for
 *                                  (default: "commodity").
 *   ?locale=<en|sr|tr|de|ru>        language for the news query (default
 *                                  en).
 *   ?num=<1..20>                    number of results (default 10).
 *
 * Auth: any active portal session.
 *
 * ENVIRONMENT REQUIREMENT
 *   The z-ai-web-dev-sdk auto-loads `./.z-ai-config` or
 *   `~/.z-ai-config`. When that file is missing, ZAI.create() throws —
 *   we catch that and return an empty list with `source: 'empty'` so
 *   the dashboard renders an empty state instead of a 500.
 */
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const url = new URL(req.url);
  const category = url.searchParams.get("category") || "commodity";
  const locale = url.searchParams.get("locale") || "en";
  const numRaw = Number(url.searchParams.get("num")) || 10;
  const num = Math.max(1, Math.min(20, Math.floor(numRaw)));

  const cacheKey = `${category}|${locale}|${num}`;
  const cached = NEWS_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json({
      items: cached.items,
      fetchedAt: new Date(cached.fetchedAt).toISOString(),
      source: "cache",
    });
  }

  // Build a search query tailored to the locale. The query is the
  // commodity name + a market-news suffix in the locale's language so
  // the search engine prefers results in that language.
  const suffixByLocale: Record<string, string> = {
    en: "commodity market news",
    sr: "berza roba vesti",
    tr: "emtia piyasası haberleri",
    de: "rohstoffmarktnachrichten",
    ru: "новости товарного рынка",
  };
  const suffix = suffixByLocale[locale] || suffixByLocale.en;
  const query = `${category} ${suffix}`;

  try {
    // Use the shared client factory which falls back to ZAI_BASE_URL +
    // ZAI_API_KEY env vars when .z-ai-config is absent (Vercel/serverless).
    const { getZaiClient } = await import("@/lib/ai/zai-client");
    const zai = await getZaiClient();
    const results = await zai.functions.invoke("web_search", {
      query,
      num,
    });
    const items: NewsItem[] = (results || []).map((r: any, i: number) => ({
      title: r.name || r.title || `Result ${i + 1}`,
      url: r.url || "",
      snippet: r.snippet || "",
      source: r.host_name || new URL(r.url || "https://example.com").hostname,
      date: r.date || "",
    }));
    NEWS_CACHE.set(cacheKey, { items, fetchedAt: Date.now() });
    return NextResponse.json({
      items,
      fetchedAt: new Date().toISOString(),
      source: items.length > 0 ? "web-search" : "empty",
    });
  } catch (e: any) {
    console.error("[marketplace.intelligence.news] web_search failed:", e);
    // Return an empty feed with source 'empty' rather than a 500 — the
    // dashboard panel can render the empty state gracefully.
    return NextResponse.json({
      items: [],
      fetchedAt: new Date().toISOString(),
      source: "empty",
      error:
        "Web search unavailable — the z-ai-web-dev-sdk is not configured or returned no results.",
    });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/intelligence/news");
