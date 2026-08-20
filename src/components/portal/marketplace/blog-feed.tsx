"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, Plus, Search, Eye, Pencil, ImageIcon } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import type { BlogPost } from "@/lib/supabase/marketplace-community-types";

interface ListResponse {
  items: BlogPost[];
  total: number;
}

/**
 * Blog feed. Each card surfaces the cover image (when present), title,
 * excerpt (or a truncated body slice), tags, author (when present), and
 * published date / view count.
 *
 * v1 surfaces the post in a read-only inline expandable; the click
 * action opens the post in a new browser tab at /portal/marketplace/
 * community/blog/[slug] (TODO — separate page deferred to a later
 * iteration). For v1 the card is the entire surface.
 */
export function BlogFeed({ onCreateClick }: { onCreateClick?: () => void }) {
  const t = useT();
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState("");

  const qp = new URLSearchParams({ limit: "24" });
  if (search.trim()) qp.set("search", search.trim());
  if (tag.trim()) qp.set("tag", tag.trim());

  const q = useQuery<ListResponse>({
    queryKey: ["community-blog", search, tag],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/blog?${qp}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });

  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;

  function fmtDate(s: string | null): string {
    if (!s) return "";
    const d = new Date(s);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("marketplace-community-blog-search-placeholder")}
            className="pl-9"
          />
        </div>
        <Input
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder={t("marketplace-community-tag-placeholder")}
          className="sm:w-44"
        />
        {onCreateClick && (
          <Button onClick={onCreateClick} className="gap-1.5">
            <Plus className="h-4 w-4" />
            {t("marketplace-community-write-post")}
          </Button>
        )}
      </div>

      {q.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : q.isError ? (
        <div className="text-center py-12 text-sm text-muted-foreground">
          {t("marketplace-community-load-error")}
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-sm text-muted-foreground">
          {t("marketplace-community-blog-empty")}
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {t("marketplace-community-results-count").replace("{n}", String(total))}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {items.map((p) => (
              <Card key={p.id} className="overflow-hidden flex flex-col">
                {p.cover_image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.cover_image_url}
                    alt={p.title}
                    className="w-full h-40 object-cover"
                  />
                ) : (
                  <div className="w-full h-40 bg-muted/40 flex items-center justify-center text-muted-foreground">
                    <ImageIcon className="h-8 w-8" />
                  </div>
                )}
                <CardContent className="p-4 space-y-2.5 flex-1 flex flex-col">
                  <div className="space-y-1 flex-1">
                    <h3 className="font-medium text-sm line-clamp-2">{p.title}</h3>
                    {p.excerpt && (
                      <p className="text-sm text-muted-foreground line-clamp-3">{p.excerpt}</p>
                    )}
                  </div>
                  {Array.isArray(p.tags) && p.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {p.tags.slice(0, 5).map((tag) => (
                        <Badge key={tag} variant="outline" className="text-xs py-0.5">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t border-border/40">
                    <span>{fmtDate(p.published_at)}</span>
                    <span className="inline-flex items-center gap-1">
                      <Eye className="h-3.5 w-3.5" />
                      {p.views_count}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          {/* Editor affordance — only when the parent passes onCreateClick. */}
          {onCreateClick && (
            <div className="text-center text-xs text-muted-foreground pt-2 inline-flex items-center justify-center gap-1">
              <Pencil className="h-3.5 w-3.5" />
              {t("marketplace-community-blog-edit-hint")}
            </div>
          )}
        </>
      )}
    </div>
  );
}
