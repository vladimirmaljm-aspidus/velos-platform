"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Eye, MessageSquare, Plus, Trash2, Package } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { useAppStore } from "@/lib/store/app-store";
import { toast } from "sonner";
import { fmtMoney, fmtRelative } from "@/lib/utils/format";
import type { MarketplacePostType } from "@/lib/supabase/marketplace-types";

interface MyPost {
  id: string;
  post_type: MarketplacePostType;
  product_name: string;
  product_category: string | null;
  quantity: number;
  unit: string;
  target_price: number | null;
  currency: string;
  status: string;
  visibility: string;
  views_count: number;
  responses_count: number;
  created_at: string;
}

const TYPE_LABEL_KEY: Record<string, string> = {
  buy: "marketplace-buy",
  sell: "marketplace-sell",
  auction: "marketplace-auction",
  contract: "marketplace-contract",
};

const STATUS_LABEL_KEY: Record<string, string> = {
  draft: "marketplace-status-draft",
  active: "marketplace-status-active",
  closed: "marketplace-status-closed",
  expired: "marketplace-status-expired",
  flagged: "marketplace-status-flagged",
};

export function MarketplaceMyPosts({
  onCreateClick,
}: {
  onCreateClick?: () => void;
}) {
  const t = useT();
  const setSelectedId = useAppStore((s) => s.setSelectedId);
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const q = useQuery<{ items: MyPost[] }>({
    queryKey: ["marketplace-my-posts"],
    queryFn: async () => {
      const r = await fetch("/api/marketplace/my-posts");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/marketplace/${id}`, { method: "DELETE" });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed.");
      }
    },
    onSuccess: () => {
      toast.success(t("marketplace-post-deleted"));
      qc.invalidateQueries({ queryKey: ["marketplace-my-posts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const closePost = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/marketplace/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "closed" }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed.");
      }
    },
    onSuccess: () => {
      toast.success(t("marketplace-post-closed"));
      qc.invalidateQueries({ queryKey: ["marketplace-my-posts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const allItems = q.data?.items ?? [];
  const items = statusFilter === "all"
    ? allItems
    : allItems.filter((p) => p.status === statusFilter);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h2 className="text-xl font-bold">{t("marketplace-my-posts")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("marketplace-my-posts-count").replace("{n}", String(allItems.length))}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("marketplace-status-all")}</SelectItem>
              <SelectItem value="active">{t("marketplace-status-active")}</SelectItem>
              <SelectItem value="draft">{t("marketplace-status-draft")}</SelectItem>
              <SelectItem value="closed">{t("marketplace-status-closed")}</SelectItem>
              <SelectItem value="expired">{t("marketplace-status-expired")}</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={onCreateClick}>
            <Plus className="h-4 w-4 mr-1" />
            {t("marketplace-create-post")}
          </Button>
        </div>
      </div>

      {q.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12">
          <Package className="h-10 w-10 text-muted-foreground mx-auto mb-2 opacity-50" />
          <p className="text-muted-foreground">{t("marketplace-no-my-posts")}</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {items.map((p) => (
            <Card key={p.id}>
              <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <Badge variant="outline" className="text-xs">
                      {t(TYPE_LABEL_KEY[p.post_type] || "marketplace-sell")}
                    </Badge>
                    <Badge variant="outline" className="text-xs">
                      {t(STATUS_LABEL_KEY[p.status] || `marketplace-status-${p.status}`)}
                    </Badge>
                    {p.visibility === "private" && (
                      <Badge variant="outline" className="text-xs">
                        {t("marketplace-visibility-private")}
                      </Badge>
                    )}
                  </div>
                  <p className="font-medium truncate">{p.product_name}</p>
                  <div className="text-xs text-muted-foreground mt-1 flex items-center gap-3 flex-wrap">
                    <span>{p.quantity.toLocaleString()} {p.unit}</span>
                    {p.target_price != null && (
                      <span>{fmtMoney(p.target_price, p.currency)}</span>
                    )}
                    <span className="inline-flex items-center gap-1">
                      <Eye className="h-3 w-3" />{p.views_count}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <MessageSquare className="h-3 w-3" />{p.responses_count}
                    </span>
                    <span>{fmtRelative(p.created_at)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button size="sm" variant="outline" onClick={() => setSelectedId(p.id)}>
                    <Eye className="h-3.5 w-3.5 mr-1" />
                    {t("portal-action-view")}
                  </Button>
                  {p.status === "active" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => closePost.mutate(p.id)}
                      disabled={closePost.isPending}
                    >
                      {t("marketplace-close")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (confirm(t("marketplace-confirm-delete"))) del.mutate(p.id);
                    }}
                    disabled={del.isPending}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
