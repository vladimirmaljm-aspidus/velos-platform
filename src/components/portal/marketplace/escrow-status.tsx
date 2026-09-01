"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
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
  Shield,
  Lock,
  Unlock,
  AlertTriangle,
  Clock,
  Loader2,
  HandCoins,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { toast } from "sonner";
import { fmtDateTime } from "@/lib/utils/format";
import type {
  FinancialInstrument,
  InstrumentStatus,
  EscrowReleaseCondition,
} from "@/lib/supabase/marketplace-finance-types";
import { ESCROW_RELEASE_CONDITION_LABEL_KEY } from "@/lib/supabase/marketplace-finance-types";

interface EscrowStatusProps {
  instrumentId: string;
  /** When true, the caller is the owning partner OR the counterparty —
   *  they see the "Release Funds" + "Dispute" buttons. */
  canRelease: boolean;
}

interface InstrumentDetailResponse {
  instrument: FinancialInstrument;
  milestones: never[];
  is_owner: boolean;
}

const STATUS_BADGE_CLASS: Record<InstrumentStatus, string> = {
  draft: "border-transparent bg-muted text-muted-foreground",
  submitted: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400",
  approved: "border-transparent bg-indigo-500/15 text-indigo-700 dark:text-indigo-400",
  active: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  completed: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  rejected: "border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-400",
  disputed: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
  released: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  refunded: "border-transparent bg-blue-500/15 text-blue-700 dark:text-blue-400",
};

/**
 * EscrowStatus — escrow status widget for an escrow financial instrument.
 *
 * Renders:
 *   • The amount held + currency + release condition (badge).
 *   • The instrument status (active / released / disputed / refunded).
 *   • A countdown to the auto-release date (`escrow_held_until`) — shows
 *     "releases in 3d 4h" / "overdue by 12h" / "no auto-release set".
 *   • The "Release Funds" button (enabled when status is active or disputed
 *     and the caller can release) — calls POST /api/marketplace/finance/
 *     [id]/release.
 *   • The "Dispute" button (enabled when status is active) — calls PUT
 *     /api/marketplace/finance/[id] with { status: "disputed" }.
 *   • When the escrow is already released / refunded, a terminal banner
 *     replaces the action buttons.
 */
export function EscrowStatus({ instrumentId, canRelease }: EscrowStatusProps) {
  const t = useT();
  const qc = useQueryClient();
  const [now, setNow] = useState(Date.now());
  // AUDIT19 (frontend #2) — irreversible money release needs a confirm
  // dialog (one mis-click previously released the full held amount with
  // no way back; `released` is a terminal status).
  const [confirmRelease, setConfirmRelease] = useState(false);

  // Tick every 60s for the auto-release countdown.
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(i);
  }, []);

  const q = useQuery<InstrumentDetailResponse>({
    queryKey: ["marketplace-finance-instrument", instrumentId],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/finance/${instrumentId}`);
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to load escrow.");
      }
      return r.json();
    },
  });

  const release = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/marketplace/finance/${instrumentId}/release`, {
        method: "POST",
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to release escrow.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-finance-escrow-released"));
      qc.invalidateQueries({ queryKey: ["marketplace-finance-instrument", instrumentId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const dispute = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/marketplace/finance/${instrumentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "disputed" }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to dispute escrow.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-finance-escrow-disputed"));
      qc.invalidateQueries({ queryKey: ["marketplace-finance-instrument", instrumentId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const instrument = q.data?.instrument;
  const status = (instrument?.status ?? "draft") as InstrumentStatus;
  const isTerminal = ["released", "refunded"].includes(status);
  const isDisputed = status === "disputed";

  // Auto-release countdown.
  const heldUntilMs = instrument?.escrow_held_until
    ? new Date(instrument.escrow_held_until).getTime() - now
    : null;

  if (q.isLoading) {
    return (
      <Card>
        <CardContent className="py-10 flex justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }
  if (q.isError || !instrument) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          {t("marketplace-finance-escrow-not-found")}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
          <span className="flex items-center gap-2">
            <Lock className="h-4 w-4" />
            {t("marketplace-finance-escrow-title")}
          </span>
          <Badge variant="outline" className={STATUS_BADGE_CLASS[status]}>
            {t(`marketplace-finance-status-${status}` as const)}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Amount held */}
        <div className="flex items-center gap-3 rounded-md bg-gradient-to-br from-amber-500/10 to-emerald-500/10 p-4">
          <Shield className="h-8 w-8 text-amber-600 shrink-0" />
          <div className="flex-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {t("marketplace-finance-escrow-amount-held")}
            </p>
            <p className="text-2xl font-bold tracking-tight">
              {instrument.currency}{" "}
              {Number(instrument.amount).toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </p>
          </div>
        </div>

        {/* Release condition */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <InfoCell
            label={t("marketplace-finance-escrow-release-condition")}
            value={
              instrument.escrow_release_condition
                ? t(ESCROW_RELEASE_CONDITION_LABEL_KEY[instrument.escrow_release_condition as EscrowReleaseCondition])
                : "—"
            }
            icon={HandCoins}
          />
          <InfoCell
            label={t("marketplace-finance-escrow-held-until")}
            value={instrument.escrow_held_until ? fmtDateTime(instrument.escrow_held_until) : "—"}
            icon={Clock}
          />
        </div>

        {/* Auto-release countdown (only when active and a held-until is set) */}
        {status === "active" && heldUntilMs !== null && (
          <div
            className={`flex items-center gap-2 text-sm rounded-md p-3 ${
              heldUntilMs > 0
                ? "bg-blue-500/10"
                : "bg-rose-500/10"
            }`}
          >
            <Clock className={`h-4 w-4 ${heldUntilMs > 0 ? "text-blue-600" : "text-rose-600"}`} />
            {heldUntilMs > 0 ? (
              <span className="text-blue-700 dark:text-blue-400">
                {t("marketplace-finance-escrow-auto-release-in").replace(
                  "{n}",
                  formatDuration(heldUntilMs),
                )}
              </span>
            ) : (
              <span className="text-rose-700 dark:text-rose-400">
                {t("marketplace-finance-escrow-auto-release-overdue").replace(
                  "{n}",
                  formatDuration(-heldUntilMs),
                )}
              </span>
            )}
          </div>
        )}

        {/* Disputed banner */}
        {isDisputed && (
          <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 rounded-md p-3">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{t("marketplace-finance-escrow-disputed-banner")}</span>
          </div>
        )}

        {/* Terminal banner */}
        {isTerminal && (
          <div className="flex items-start gap-2 text-xs text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 rounded-md p-3">
            <Unlock className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              {status === "released"
                ? t("marketplace-finance-escrow-released-banner")
                : t("marketplace-finance-escrow-refunded-banner")}
            </span>
          </div>
        )}

        {/* Actions */}
        {canRelease && !isTerminal && (
          <>
            <Separator />
            <div className="flex items-center justify-end gap-2">
              {status === "active" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => dispute.mutate()}
                  disabled={dispute.isPending}
                >
                  {dispute.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 mr-1" />
                  )}
                  {t("marketplace-finance-escrow-dispute")}
                </Button>
              )}
              <Button
                size="sm"
                onClick={() => setConfirmRelease(true)}
                disabled={release.isPending || isDisputed}
                title={isDisputed ? t("marketplace-finance-escrow-release-blocked-disputed") : undefined}
              >
                {release.isPending ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Unlock className="h-4 w-4 mr-1" />
                )}
                {t("marketplace-finance-escrow-release")}
              </Button>
            </div>
          </>
        )}

        {/* AUDIT19 (frontend #2) — release confirmation dialog */}
        <AlertDialog open={confirmRelease} onOpenChange={setConfirmRelease}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("marketplace-finance-escrow-release-confirm-title")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("marketplace-finance-escrow-release-confirm-desc").replace(
                  "{amount}",
                  `${instrument.currency} ${Number(instrument.amount).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}`,
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common-label-cancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => release.mutate()}
                className="bg-emerald-600 text-white hover:bg-emerald-700"
              >
                {t("marketplace-finance-escrow-release-confirm-yes")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────

function InfoCell({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon?: typeof Clock;
}) {
  return (
    <div className="rounded-md bg-muted/30 p-2">
      <p className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </p>
      <p className="font-medium mt-0.5 truncate" title={value}>
        {value || "—"}
      </p>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Format a millisecond duration into a compact human string:
 *   "3d 4h" / "12h" / "45m".
 */
function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const mins = Math.floor((abs % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
