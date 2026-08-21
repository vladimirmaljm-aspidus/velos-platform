"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Loader2, Newspaper, ExternalLink, RefreshCw } from "lucide-react";
import { useT, useI18nStore } from "@/lib/i18n/store";
import { fmtRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

interface NewsItem {
  title: string;
  url: string;
  snippet: string;
  source: string;
  date: string;
}

interface MarketNewsResponse {
  items: NewsItem[];
  fetchedAt: string;
  source: string;
  error?: string;
}

interface MarketNewsPanelProps {
  category?: string;
  num?: number;
}

/**
 * MarketNewsPanel — commodity market news feed, for the
 * market-intelligence dashboard.
 *
 * Calls GET /api/marketplace/intelligence/news?category=... &locale=...
 *
 * The route uses the z-ai-web-dev-sdk web_search function to fetch
 * commodity news. Results are cached server-side for 30 minutes so
 * dashboard refreshes don't re-fire the search.
 *
 * Renders a vertical feed of cards (title, source, date, snippet, link
 * to the original article). When the SDK is unavailable, the route
 * returns `source: 'empty'` and we render an empty state.
 */
export function MarketNewsPanel({ category, num = 10 }: MarketNewsPanelProps) {
  const t = useT();
  const locale = useI18nStore((s) => s.locale);
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  params.set("locale", locale);
  params.set("num", String(num));
  const q = useQuery<MarketNewsResponse>({
    queryKey: ["mkt-intel-news", category ?? "", locale, num],
    queryFn: async () => {
      const r = await fetch(
        `/api/marketplace/intelligence/news?${params}`,
      );
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 30 * 60_000, // matches the server-side cache
    retry: 0,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center justify-between gap-1.5">
          <span className="flex items-center gap-1.5">
            <Newspaper className="h-4 w-4" />
            {t("marketplace-intel-news-title")}
          </span>
          <button
            type="button"
            onClick={() => q.refetch()}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label={t("marketplace-intel-news-refresh")}
            title={t("marketplace-intel-news-refresh")}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", q.isFetching && "animate-spin")}
            />
          </button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 max-h-[600px] overflow-y-auto">
        {q.isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : q.isError || !q.data ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("marketplace-intel-load-error")}
          </p>
        ) : q.data.items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("marketplace-intel-news-empty")}
          </p>
        ) : (
          <>
            {q.data.source === "cache" && (
              <p className="text-xs uppercase tracking-wide text-muted-foreground text-center">
                {t("marketplace-intel-news-cached")}
              </p>
            )}
            {q.data.items.map((item, i) => (
              <article
                key={i}
                className="border rounded-md p-2.5 hover:bg-muted/40 transition-colors"
              >
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block group"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-sm font-medium leading-snug group-hover:text-foreground">
                      {item.title}
                    </h3>
                    <ExternalLink className="h-3 w-3 mt-0.5 text-muted-foreground shrink-0" />
                  </div>
                  {item.snippet && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                      {item.snippet}
                    </p>
                  )}
                  <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                    <span className="font-medium">{item.source}</span>
                    {item.date && (
                      <>
                        <span>·</span>
                        <span>{fmtRelative(item.date)}</span>
                      </>
                    )}
                  </div>
                </a>
              </article>
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}
