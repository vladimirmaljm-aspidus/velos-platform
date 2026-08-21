"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Loader2,
  Plus,
  Search,
  MessageSquare,
  CheckCircle2,
  Eye,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { useAppStore } from "@/lib/store/app-store";
import type { Question } from "@/lib/supabase/marketplace-community-types";

interface ListResponse {
  items: Question[];
  total: number;
}

/**
 * Q&A list. Each card surfaces: title, snippet of body, tags, view count,
 * answer count, and an "answered" indicator (CheckCircle2) when an
 * accepted answer exists. Clicking a card opens the question detail —
 * for v1 the detail is left to a future iteration; the card surfaces a
 * "View answers" button that could expand inline.
 *
 * Filter bar: search (title/body), tag filter (typed free-text),
 * unanswered toggle.
 */
export function QuestionList({ onCreateClick }: { onCreateClick?: () => void }) {
  const t = useT();
  const setSelectedId = useAppStore((s) => s.setSelectedId);
  const setView = useAppStore((s) => s.setView);
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState("");
  const [unanswered, setUnanswered] = useState(false);

  const qp = new URLSearchParams({ limit: "24" });
  if (search.trim()) qp.set("search", search.trim());
  if (tag.trim()) qp.set("tag", tag.trim());
  if (unanswered) qp.set("unanswered", "1");

  const q = useQuery<ListResponse>({
    queryKey: ["community-questions", search, tag, unanswered],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/questions?${qp}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });

  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;

  function onOpen(q: Question) {
    // For v1 we surface the question body inline by routing to the
    // community page with a selectedId; the detail UI is left for a
    // future iteration. Click still records the selection so a future
    // detail component can pick it up.
    setSelectedId(q.id);
    void setView; // no-op for v1 — the community page is the active view
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("marketplace-community-questions-search-placeholder")}
            className="pl-9"
          />
        </div>
        <Input
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder={t("marketplace-community-tag-placeholder")}
          className="sm:w-44"
        />
        <Button
          variant={unanswered ? "default" : "outline"}
          onClick={() => setUnanswered((v) => !v)}
          className="gap-1.5"
        >
          <MessageSquare className="h-4 w-4" />
          {t("marketplace-community-unanswered")}
        </Button>
        {onCreateClick && (
          <Button onClick={onCreateClick} className="gap-1.5">
            <Plus className="h-4 w-4" />
            {t("marketplace-community-ask-question")}
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
          {t("marketplace-community-questions-empty")}
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {t("marketplace-community-results-count").replace("{n}", String(total))}
          </p>
          <div className="space-y-3">
            {items.map((q) => (
              <Card key={q.id} className="hover:shadow-soft transition-shadow cursor-pointer" onClick={() => onOpen(q)}>
                <CardContent className="p-4 space-y-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {q.is_answered && (
                          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                        )}
                        <h3 className="font-medium text-sm truncate">{q.title}</h3>
                      </div>
                      {q.body && (
                        <p className="text-sm text-muted-foreground line-clamp-2">{q.body}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                      <span className="inline-flex items-center gap-1">
                        <Eye className="h-3.5 w-3.5" />
                        {q.views_count}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <MessageSquare className="h-3.5 w-3.5" />
                        {q.answers_count}
                      </span>
                    </div>
                  </div>
                  {Array.isArray(q.tags) && q.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      {q.tags.slice(0, 8).map((tag) => (
                        <Badge key={tag} variant="outline" className="text-xs py-0.5">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
