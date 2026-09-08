"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Star, Share2, Flag, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/lib/i18n/store";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/**
 * useWatchlist — shared watchlist state via TanStack Query. One network
 * request serves every star button on the page (query cache dedupes);
 * toggling optimistically flips the star and patches the cache.
 */
export function useWatchlist() {
  const qc = useQueryClient();
  const idsQ = useQuery<string[]>(({
    queryKey: ["marketplace-watchlist"],
    queryFn: async () => {
      const r = await fetch("/api/marketplace/watchlist");
      if (!r.ok) return [];
      const d = await r.json();
      return (d?.post_ids as string[]) ?? [];
    },
    staleTime: 30_000,
  }));

  const toggle = useMutation({
    mutationFn: async (postId: string) => {
      const r = await fetch("/api/marketplace/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ post_id: postId }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to update watchlist.");
      }
      return r.json() as Promise<{ on_watchlist: boolean }>;
    },
    onSuccess: (data, postId) => {
      qc.setQueryData<string[]>(["marketplace-watchlist"], (prev) => {
        const cur = prev ?? [];
        return data.on_watchlist ? [postId, ...cur] : cur.filter((id) => id !== postId);
      });
      // 2-a — the feed lists are now stale: the starred/unstarred post
      // appears in / disappears from the watchlist-only feed. The ROOT
      // ["marketplace-list"] key covers every filter variant (the key is
      // ["marketplace-list", type, category, country, sort, search,
      // watchlistOnly] in MarketplaceList). The old
      // ["marketplace-watchlist-feed"] key was used by NOTHING.
      qc.invalidateQueries({ queryKey: ["marketplace-list"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return {
    ids: idsQ.data ?? [],
    has: (postId: string) => (idsQ.data ?? []).includes(postId),
    toggle: toggle.mutate,
    pending: toggle.isPending,
    loading: idsQ.isLoading,
  };
}

/** WatchlistStarButton — star toggle used on feed cards and the detail view. */
export function WatchlistStarButton({
  postId,
  size = "sm",
  className,
}: {
  postId: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const t = useT();
  const { has, toggle, pending } = useWatchlist();
  const on = has(postId);

  return (
    <Button
      type="button"
      variant="ghost"
      size={size === "sm" ? "icon" : "sm"}
      aria-pressed={on}
      aria-label={on ? t("marketplace-watchlist-remove") : t("marketplace-watchlist-add")}
      title={on ? t("marketplace-watchlist-remove") : t("marketplace-watchlist-add")}
      className={cn(
        "shrink-0",
        size === "sm" ? "h-7 w-7" : "h-9 px-3",
        on && "text-amber-500 hover:text-amber-500",
        className,
      )}
      disabled={pending}
      onClick={(e) => {
        e.stopPropagation();
        toggle(postId);
      }}
    >
      {pending ? (
        <Loader2 className={cn("animate-spin", size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4 mr-1.5")} />
      ) : (
        <Star className={cn(size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4 mr-1.5", on && "fill-current")} />
      )}
      {size === "md" && (
        <span>{on ? t("marketplace-watchlist-remove") : t("marketplace-watchlist-add")}</span>
      )}
    </Button>
  );
}

/** SharePostButton — copies a clean deep link to the post detail. */
export function SharePostButton({ postId }: { postId: string }) {
  const t = useT();

  async function share() {
    const url = `${window.location.origin}/portal/marketplace/${postId}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("marketplace-share-copied"));
    } catch {
      // Clipboard API can fail on non-secure contexts — fall back to a
      // legacy execCommand copy.
      const ta = document.createElement("textarea");
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        toast.success(t("marketplace-share-copied"));
      } catch {
        toast.error(t("marketplace-share-failed"));
      }
      document.body.removeChild(ta);
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={share}>
      <Share2 className="h-3.5 w-3.5" />
      {t("marketplace-share")}
    </Button>
  );
}

const REPORT_REASONS = [
  { value: "scam", labelKey: "marketplace-report-reason-scam" },
  { value: "counterfeit", labelKey: "marketplace-report-reason-counterfeit" },
  { value: "wrong_category", labelKey: "marketplace-report-reason-wrong-category" },
  { value: "prohibited", labelKey: "marketplace-report-reason-prohibited" },
  { value: "misleading", labelKey: "marketplace-report-reason-misleading" },
  { value: "other", labelKey: "marketplace-report-reason-other" },
] as const;

/** ReportPostDialog — flags a post for platform-team review. */
export function ReportPostDialog({ postId }: { postId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>("");
  const [details, setDetails] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/marketplace/${postId}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, details: details.trim() || undefined }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to submit report.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-report-submitted"));
      setOpen(false);
      setReason("");
      setDetails("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <Button type="button" variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={() => setOpen(true)}>
        <Flag className="h-3.5 w-3.5" />
        {t("marketplace-report")}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Flag className="h-4 w-4 text-amber-600" />
              {t("marketplace-report-title")}
            </DialogTitle>
            <DialogDescription>{t("marketplace-report-desc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="report-reason">{t("marketplace-report-reason-label")}</Label>
              <Select value={reason} onValueChange={setReason}>
                <SelectTrigger id="report-reason">
                  <SelectValue placeholder={t("marketplace-report-reason-placeholder")} />
                </SelectTrigger>
                <SelectContent>
                  {REPORT_REASONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {t(r.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="report-details">{t("marketplace-report-details-label")}</Label>
              <Textarea
                id="report-details"
                rows={3}
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder={t("marketplace-report-details-placeholder")}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("portal-action-cancel")}
            </Button>
            <Button
              type="button"
              onClick={() => submit.mutate()}
              disabled={!reason || submit.isPending}
            >
              {submit.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {t("marketplace-report-submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
