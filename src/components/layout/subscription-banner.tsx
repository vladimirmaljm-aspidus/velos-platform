"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/store/app-store";
import { useT } from "@/lib/i18n/store";
import { cn } from "@/lib/utils";

interface SubscriptionInfo {
  plan: string;
  status: string;
  is_trial: boolean;
  is_expired: boolean;
  is_trial_expired?: boolean;
  days_remaining: number | null;
  trial_days_remaining: number | null;
  subscription_end: string | null;
  trial_ends_at: string | null;
  warning_level: "none" | "warning" | "critical" | "expired";
}

/**
 * Persistent bar at the top of every admin/CRM page that shows how much
 * time is left on the tenant's subscription.
 *   - trial + >7 days left → subtle emerald bar with fast-buy button
 *   - trial + ≤7 days      → yellow warning
 *   - trial + ≤3 days      → red critical
 *   - paid + ≤14 days      → yellow warning
 *   - anything expired     → red block, must be resolved
 * Dismissable inside a browser session ONLY for warning level; critical
 * and expired stay pinned.
 */
export function SubscriptionBanner() {
  const setView = useAppStore((s) => s.setView);
  const t = useT();
  const [dismissed, setDismissed] = useState(false);

  const q = useQuery({
    queryKey: ["subscription-status-banner"],
    queryFn: async () => {
      const r = await fetch("/api/subscription/status");
      if (!r.ok) return null;
      return r.json() as Promise<{ subscription: SubscriptionInfo | null }>;
    },
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

  const sub = q.data?.subscription;
  if (!sub || sub.plan === "platform") return null; // super admin — nothing to show

  const isExpired = sub.is_expired || sub.is_trial_expired;
  const days = sub.is_trial ? sub.trial_days_remaining : sub.days_remaining;

  // Silent when there's plenty of time left on a paid plan.
  if (!sub.is_trial && sub.warning_level === "none") return null;

  // Trial always shows the bar so the client always knows where they stand.
  if (sub.warning_level === "warning" && dismissed) return null;

  const styles = isExpired
    ? "bg-destructive text-destructive-foreground"
    : sub.warning_level === "critical"
      ? "bg-red-100 text-red-900 border-b border-red-200 dark:bg-red-950/40 dark:text-red-200 dark:border-red-800"
      : sub.warning_level === "warning"
        ? "bg-amber-100 text-amber-900 border-b border-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-800"
        : "bg-emerald-100 text-emerald-900 border-b border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-800";

  const Icon = isExpired || sub.warning_level === "critical" ? AlertTriangle : Sparkles;

  return (
    <div className={cn("px-4 py-2.5 flex items-center justify-between gap-3 text-sm flex-wrap", styles)}>
      <div className="flex items-center gap-2 min-w-0">
        <Icon className="size-4 shrink-0" />
        <span className="min-w-0">
          {isExpired
            ? sub.is_trial_expired
              ? t("misc-sub-trial-ended")
              : t("misc-sub-expired")
            : sub.is_trial
              ? days === 1
                ? t("misc-sub-trial-tomorrow")
                : days !== null && days > 0
                  ? t("misc-sub-trial-days-left").replace("{days}", String(days))
                  : t("misc-sub-trial-period")
              : days !== null && days > 0
                ? t("misc-sub-renews-in").replace("{days}", String(days)).replace("{s}", days === 1 ? "" : "s")
                : t("misc-sub-active")}
          {sub.plan && sub.plan !== "trial" && (
            <span className="opacity-70 ml-2">· {t("misc-sub-current-plan")}: <strong className="capitalize">{sub.plan}</strong></span>
          )}
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          size="sm"
          variant={isExpired || sub.warning_level === "critical" ? "default" : "outline"}
          onClick={() => setView("plans")}
          className={isExpired ? "bg-white text-destructive hover:bg-white/90" : ""}
        >
          {sub.is_trial ? t("misc-sub-upgrade-now") : t("misc-sub-view-plan")}
        </Button>
        {!isExpired && sub.warning_level === "warning" && (
          <Button size="icon" variant="ghost" className="size-7" onClick={() => setDismissed(true)}>
            <X className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
