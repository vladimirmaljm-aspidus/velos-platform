"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Eye,
  MessageSquare,
  Plus,
  Trash2,
  Package,
  Send,
  Clock,
  Pencil,
  Flag,
  AlertTriangle,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { useAppStore } from "@/lib/store/app-store";
import { toast } from "sonner";
import { fmtMoney, fmtRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type {
  MarketplacePostType,
  MarketplaceVisibility,
} from "@/lib/supabase/marketplace-types";
import type { MarketplaceEditPost } from "./marketplace-create-post";

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
  visibility: MarketplaceVisibility;
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
  pending: "marketplace-status-pending",
  active: "marketplace-status-active",
  closed: "marketplace-status-closed",
  expired: "marketplace-status-expired",
  flagged: "marketplace-status-flagged",
};

export function MarketplaceMyPosts({
  onCreateClick,
  onEditClick,
}: {
  onCreateClick?: () => void;
  /** 2-a — opens the create-post wizard in EDIT mode with this post
   *  (threaded up to MarketplaceBrowser, which owns the dialog). */
  onEditClick?: (post: MarketplaceEditPost) => void;
}) {
  const t = useT();
  const setSelectedId = useAppStore((s) => s.setSelectedId);
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  // 2-a — the post pending delete-confirmation (shadcn AlertDialog
  // replaces the native confirm()).
  const [deleteId, setDeleteId] = useState<string | null>(null);

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

  // 099 — draft publishing. PUT status:"active"; when the tenant requires
  // approval the server converts draft→pending and answers with
  // `pending_approval: true` so we toast "awaiting approval" instead of the
  // plain published message. Without this button drafts were a dead end.
  const publishPost = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/marketplace/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed.");
      }
      return r.json() as Promise<{ pending_approval?: boolean } | null>;
    },
    onSuccess: (data) => {
      toast.success(
        data?.pending_approval
          ? t("marketplace-publish-pending")
          : t("marketplace-published"),
      );
      qc.invalidateQueries({ queryKey: ["marketplace-my-posts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const allItems = q.data?.items ?? [];
  const items = statusFilter === "all"
    ? allItems
    : allItems.filter((p) => p.status === statusFilter);
  // 2-a — editable while the post is still live/awaiting review; closed,
  // cancelled, expired and flagged posts are read-only rows (the edit
  // button renders disabled so the layout doesn't jump).
  const isEditable = (p: MyPost) =>
    p.status === "draft" || p.status === "active" || p.status === "pending";
  const deleteTarget = allItems.find((p) => p.id === deleteId) ?? null;

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
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("marketplace-status-all")}</SelectItem>
              <SelectItem value="active">{t("marketplace-status-active")}</SelectItem>
              <SelectItem value="draft">{t("marketplace-status-draft")}</SelectItem>
              <SelectItem value="pending">{t("marketplace-status-pending")}</SelectItem>
              <SelectItem value="flagged">{t("marketplace-status-flagged")}</SelectItem>
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
      ) : q.isError ? (
        // 2-a — failed load: error card with retry, matching the lock-card
        // styling pattern MarketplaceList renders for its failures.
        <div className="text-center py-16 rounded-xl border border-dashed border-border/60 bg-muted/10">
          <div className="size-12 mx-auto rounded-xl bg-muted flex items-center justify-center mb-3">
            <AlertTriangle className="h-6 w-6 text-muted-foreground" />
          </div>
          <p className="font-medium">{t("marketplace-load-error")}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => q.refetch()}>
            {t("portal-action-try-again")}
          </Button>
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
                    {/* 2-a — distinct amber Flagged badge next to the status
                        badge (mirrors the pending "awaiting approval"
                        hint-badge pattern). */}
                    {p.status === "flagged" && (
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-xs gap-1 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
                        )}
                      >
                        <Flag className="h-3 w-3" />
                        {t("marketplace-status-flagged")}
                      </Badge>
                    )}
                    {p.status === "pending" && (
                      <Badge
                        variant="outline"
                        className="text-xs gap-1 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                      >
                        <Clock className="h-3 w-3" />
                        {t("marketplace-pending-hint")}
                      </Badge>
                    )}
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
                  {/* 2-a — open the wizard in edit mode (threaded up to the
                      browser, which owns the dialog). Enabled while the post
                      is still editable; disabled for closed/cancelled/
                      expired/flagged rows. */}
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1"
                    disabled={!isEditable(p)}
                    title={
                      isEditable(p)
                        ? t("marketplace-edit")
                        : t(STATUS_LABEL_KEY[p.status] || `marketplace-status-${p.status}`)
                    }
                    onClick={() => onEditClick?.(p)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    {t("marketplace-edit")}
                  </Button>
                  {p.status === "draft" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => publishPost.mutate(p.id)}
                      disabled={publishPost.isPending}
                      className="gap-1"
                    >
                      {publishPost.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Send className="h-3.5 w-3.5" />
                      )}
                      {t("marketplace-publish")}
                    </Button>
                  )}
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
                    onClick={() => setDeleteId(p.id)}
                    disabled={del.isPending}
                    aria-label={t("marketplace-confirm-delete")}
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

      {/* 2-a — destructive delete confirmation (shadcn AlertDialog,
          replacing the native confirm()). */}
      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("marketplace-confirm-delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? deleteTarget.product_name : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteId(null)}>
              {t("portal-action-cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteId) del.mutate(deleteId);
                setDeleteId(null);
              }}
            >
              {t("marketplace-delete-cta")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
