"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, Plus, Search, Users, Lock } from "lucide-react";
import { toast } from "sonner";
import { useT } from "@/lib/i18n/store";
import type { CommunityGroup } from "@/lib/supabase/marketplace-community-types";

interface ListResponse {
  items: CommunityGroup[];
  total: number;
}

/**
 * Group cards. Each card surfaces: name, description, member_count,
 * is_private badge, category, and a Join/Leave button. Clicking a card
 * could expand to show members in a future iteration; for v1 the Join
 * action is the primary affordance.
 *
 * The component fetches its own data via react-query and refetches after
 * a Join/Leave so the member_count reflects the new state immediately.
 *
 * The "Create group" affordance is exposed via the `onCreateClick` prop —
 * the parent (CommunityHub) owns the create dialog so the group-list
 * stays presentational + data-fetching only.
 */
export function GroupList({ onCreateClick }: { onCreateClick?: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");

  const qp = new URLSearchParams({ limit: "24" });
  if (search.trim()) qp.set("search", search.trim());

  const q = useQuery<ListResponse>({
    queryKey: ["community-groups", search],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/groups?${qp}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });

  const joinMut = useMutation({
    mutationFn: async (groupId: string) => {
      const r = await fetch(`/api/marketplace/groups/${groupId}/join`, { method: "POST" });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: "Failed." }));
        throw new Error(err?.error || "Failed.");
      }
      return r.json();
    },
    onSuccess: (data, _id) => {
      toast.success(data?.joined ? t("marketplace-community-joined") : t("marketplace-community-already-member"));
      qc.invalidateQueries({ queryKey: ["community-groups", search] });
    },
    onError: (e: any) => toast.error(e?.message || t("marketplace-community-join-failed")),
  });

  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("marketplace-community-groups-search-placeholder")}
            className="pl-9"
          />
        </div>
        {onCreateClick && (
          <Button onClick={onCreateClick} className="gap-1.5">
            <Plus className="h-4 w-4" />
            {t("marketplace-community-create-group")}
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
          {t("marketplace-community-groups-empty")}
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {t("marketplace-community-results-count").replace("{n}", String(total))}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {items.map((g) => (
              <Card key={g.id} className="overflow-hidden">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="font-medium text-sm truncate">{g.name}</h3>
                      {g.category && (
                        <p className="text-xs text-muted-foreground truncate">{g.category}</p>
                      )}
                    </div>
                    {g.is_private && (
                      <Badge variant="secondary" className="gap-1 shrink-0">
                        <Lock className="h-3 w-3" />
                        {t("marketplace-community-private")}
                      </Badge>
                    )}
                  </div>
                  {g.description && (
                    <p className="text-sm text-muted-foreground line-clamp-3">{g.description}</p>
                  )}
                  <div className="flex items-center justify-between pt-1">
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Users className="h-3.5 w-3.5" />
                      {t("marketplace-community-members-count").replace("{n}", String(g.member_count))}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={joinMut.isPending}
                      onClick={() => joinMut.mutate(g.id)}
                    >
                      {t("marketplace-community-join")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
