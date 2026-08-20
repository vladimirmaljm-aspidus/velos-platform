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
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  CalendarClock,
  CheckCircle2,
  Circle,
  Clock,
  Loader2,
  AlertTriangle,
  ListChecks,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { toast } from "sonner";
import { fmtDateTime } from "@/lib/utils/format";
import type {
  FinancialInstrument,
  PaymentMilestone,
  MilestoneStatus,
  TriggerCondition,
} from "@/lib/supabase/marketplace-finance-types";
import {
  MILESTONE_STATUS_LABEL_KEY,
  TRIGGER_CONDITION_LABEL_KEY,
} from "@/lib/supabase/marketplace-finance-types";

interface PaymentScheduleProps {
  instrumentId: string;
  /** When true, the caller is the owning partner — they see the "Mark as
   *  Paid" controls. */
  isOwner: boolean;
}

interface InstrumentDetailResponse {
  instrument: FinancialInstrument;
  milestones: PaymentMilestone[];
  is_owner: boolean;
}

const STATUS_BADGE_CLASS: Record<MilestoneStatus, string> = {
  pending: "border-transparent bg-muted text-muted-foreground",
  due: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
  paid: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  overdue: "border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-400",
  cancelled: "border-transparent bg-muted text-muted-foreground line-through",
};

/**
 * PaymentSchedule — visual payment-schedule panel for a payment_schedule
 * financial instrument.
 *
 * Renders:
 *   • A progress bar showing the % of total amount paid (sum of paid
 *     milestone percentages).
 *   • A vertical milestone timeline — each milestone is a row with the
 *     sequence number, description, percentage + amount, trigger condition,
 *     due date (with overdue/due-soon warnings), status badge, and a "Mark
 *     as Paid" button (when the caller is the owning partner and the
 *     milestone is not yet paid).
 *   • A summary footer: paid / total amounts + paid / total milestones.
 *
 * Calls GET /api/marketplace/finance/[id] to load the instrument + its
 * milestones, and PUT /api/marketplace/finance/[id]/milestones/[paymentId]
 * with `{ status: "paid" }` to mark a milestone as paid.
 */
export function PaymentSchedule({ instrumentId, isOwner }: PaymentScheduleProps) {
  const t = useT();
  const qc = useQueryClient();
  const [now, setNow] = useState(Date.now());

  // Tick every 60s so due-date warnings stay current (ETA is a date — a
  // per-second tick would be wasteful).
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
        throw new Error(e.error || "Failed to load payment schedule.");
      }
      return r.json();
    },
  });

  const markPaid = useMutation({
    mutationFn: async (milestoneId: string) => {
      const r = await fetch(
        `/api/marketplace/finance/${instrumentId}/milestones/${milestoneId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "paid" }),
        },
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to mark milestone as paid.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-finance-milestone-marked-paid"));
      qc.invalidateQueries({ queryKey: ["marketplace-finance-instrument", instrumentId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const instrument = q.data?.instrument;
  const milestones = q.data?.milestones ?? [];

  // Progress: sum of percentages of paid milestones (capped at 100).
  const paidPct = Math.min(
    100,
    milestones
      .filter((m) => m.status === "paid")
      .reduce((sum, m) => sum + Number(m.percentage), 0),
  );
  const totalMilestones = milestones.length;
  const paidMilestones = milestones.filter((m) => m.status === "paid").length;

  // Compute paid + total amounts (when amount is null on a milestone, fall
  // back to the percentage * instrument.amount).
  const instrumentAmount = instrument ? Number(instrument.amount) : 0;
  const milestoneAmount = (m: PaymentMilestone): number =>
    m.amount != null ? Number(m.amount) : (Number(m.percentage) / 100) * instrumentAmount;
  const paidAmount = milestones
    .filter((m) => m.status === "paid")
    .reduce((sum, m) => sum + milestoneAmount(m), 0);
  const totalAmount = milestones.reduce((sum, m) => sum + milestoneAmount(m), 0);
  const currency = instrument?.currency || "USD";

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
          {t("marketplace-finance-schedule-not-found")}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
          <span className="flex items-center gap-2">
            <ListChecks className="h-4 w-4" />
            {t("marketplace-finance-schedule-title")}
          </span>
          <span className="text-xs font-normal text-muted-foreground">
            {paidMilestones}/{totalMilestones} {t("marketplace-finance-milestones-paid-suffix")}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Progress bar */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {t("marketplace-finance-schedule-progress")}
            </span>
            <span className="font-medium">
              {fmtMoney(paidAmount, currency)} / {fmtMoney(totalAmount, currency)} ({paidPct}%)
            </span>
          </div>
          <Progress value={paidPct} className="h-2.5" />
        </div>

        {/* Milestone timeline */}
        <div className="space-y-2">
          {milestones.map((m, idx) => {
            const dueMs = m.due_date ? new Date(m.due_date).getTime() - now : null;
            const isOverdue =
              m.status !== "paid" &&
              m.status !== "cancelled" &&
              dueMs !== null &&
              dueMs < 0;
            const isDueSoon =
              m.status !== "paid" &&
              m.status !== "cancelled" &&
              dueMs !== null &&
              dueMs > 0 &&
              dueMs < 3 * 24 * 60 * 60 * 1000; // 3 days
            const Icon =
              m.status === "paid" ? CheckCircle2
              : m.status === "cancelled" ? Circle
              : isOverdue ? AlertTriangle
              : Circle;
            return (
              <div
                key={m.id}
                className={`flex items-start gap-3 rounded-md border p-3 ${
                  m.status === "paid"
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : isOverdue
                      ? "border-rose-500/30 bg-rose-500/5"
                      : "border-border"
                }`}
              >
                {/* Sequence + state icon */}
                <div className="flex flex-col items-center gap-1 shrink-0">
                  <Icon
                    className={`h-5 w-5 ${
                      m.status === "paid"
                        ? "text-emerald-600"
                        : isOverdue
                          ? "text-rose-600"
                          : "text-muted-foreground"
                    }`}
                  />
                  <span className="text-[10px] text-muted-foreground">#{m.sequence}</span>
                </div>

                {/* Description + meta */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium truncate">{m.description}</p>
                    <Badge variant="outline" className={`text-[10px] h-5 ${STATUS_BADGE_CLASS[m.status as MilestoneStatus]}`}>
                      {t(MILESTONE_STATUS_LABEL_KEY[m.status as MilestoneStatus])}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground mt-1">
                    <span>
                      {Number(m.percentage)}% · {fmtMoney(milestoneAmount(m), currency)}
                    </span>
                    <span className="flex items-center gap-1">
                      {t("marketplace-finance-schedule-trigger")}
                      {" "}
                      {t(TRIGGER_CONDITION_LABEL_KEY[m.trigger_condition as TriggerCondition])}
                    </span>
                    {m.due_date && (
                      <span className={`flex items-center gap-1 ${isOverdue ? "text-rose-600" : isDueSoon ? "text-amber-600" : ""}`}>
                        <CalendarClock className="h-3 w-3" />
                        {fmtDateTime(m.due_date)}
                      </span>
                    )}
                    {m.paid_date && (
                      <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="h-3 w-3" />
                        {t("marketplace-finance-paid-on").replace("{d}", fmtDateTime(m.paid_date))}
                      </span>
                    )}
                    {m.reference_number && (
                      <span className="text-muted-foreground">
                        {t("marketplace-finance-ref-no")}: {m.reference_number}
                      </span>
                    )}
                  </div>
                  {(isOverdue || isDueSoon) && m.status !== "paid" && m.status !== "cancelled" && (
                    <p className={`text-[11px] mt-1 flex items-center gap-1 ${isOverdue ? "text-rose-600" : "text-amber-600"}`}>
                      <Clock className="h-3 w-3" />
                      {isOverdue
                        ? t("marketplace-finance-overdue-by").replace(
                            "{n}",
                            formatDuration(-dueMs!),
                          )
                        : t("marketplace-finance-due-in").replace(
                            "{n}",
                            formatDuration(dueMs!),
                          )}
                    </p>
                  )}
                </div>

                {/* Action */}
                {isOwner && m.status !== "paid" && m.status !== "cancelled" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => markPaid.mutate(m.id)}
                    disabled={markPaid.isPending}
                    className="shrink-0"
                  >
                    {markPaid.isPending && markPaid.variables === m.id ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                    )}
                    {t("marketplace-finance-mark-paid")}
                  </Button>
                )}
              </div>
            );
          })}
        </div>

        <Separator />

        {/* Summary footer */}
        <div className="grid grid-cols-2 gap-3 text-xs">
          <SummaryCell
            label={t("marketplace-finance-paid-amount")}
            value={fmtMoney(paidAmount, currency)}
            tone="emerald"
          />
          <SummaryCell
            label={t("marketplace-finance-total-amount")}
            value={fmtMoney(totalAmount, currency)}
            tone="muted"
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────

function SummaryCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "emerald" | "muted";
}) {
  return (
    <div className="rounded-md bg-muted/30 p-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={`font-medium mt-0.5 ${
          tone === "emerald" ? "text-emerald-700 dark:text-emerald-400" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function fmtMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

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
