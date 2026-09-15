// ─────────────────────────────────────────────────────────────────────────────
// Credit & Collections — shared report types (task 11-a).
//
// GET /api/credit/report computes the whole payload server-side from
// store.listInvoices + store.listPartners + store.listCollectionReminders.
// The exact response shape lives HERE (not inside the route) so the view
// (src/components/views/credit-view.tsx) imports the same type it renders —
// no drifting `any` casts between producer and consumer.
// ─────────────────────────────────────────────────────────────────────────────

/** Currencies the report selector offers + the static indicative rate map covers. */
export const REPORT_CURRENCIES = ["USD", "EUR", "AED", "GBP", "TRY", "SAR"] as const;
export type ReportCurrency = (typeof REPORT_CURRENCIES)[number];

/** Aging bucket keys — ordered current → 90+ days overdue. */
export type CreditAgingKey = "current" | "1-30" | "31-60" | "61-90" | "90+";

export interface CreditAgingBucket {
  key: CreditAgingKey;
  /** Number of unpaid invoices in the bucket. */
  count: number;
  /** Sum of unpaid invoice amounts, in the report currency (unconvertible
   *  currencies are excluded here but still visible in per_currency). */
  amount: number;
  /** Face-value totals per invoice currency — always complete. */
  per_currency: Record<string, number>;
}

/** One rung of the dunning ladder for a queue invoice. */
export interface CreditStageRung {
  stage: number;        // 1 | 2 | 3
  sent_at: string;      // ISO timestamp of the latest reminder at this stage
}

/** Collections queue row — one unpaid sent/overdue invoice. */
export interface CreditQueueItem {
  invoice_id: string;
  number: string;
  partner_id: string;
  partner_name: string;
  amount: number;                 // face value, invoice currency
  currency: string;
  amount_report: number | null;   // report currency; NULL when not convertible
  due_date: string | null;
  /** Floor days between due_date and today. Negative = not yet due. */
  days_overdue: number;
  /** Reminder rungs already sent for THIS invoice (kind='reminder'). */
  stage_ladder: CreditStageRung[];
  /** First stage (1-3) not yet sent, or NULL when the whole ladder is done. */
  next_stage: number | null;
  last_reminder_at: string | null;
  /** Reminder count (kind='reminder') tied to this invoice. */
  reminder_count: number;
}

/** Partner exposure row — every partner with unpaid invoices or a credit limit. */
export interface CreditPartnerExposure {
  partner_id: string;
  name: string;
  status: "active" | "inactive" | "blacklisted";
  on_hold: boolean;
  credit_limit: number | null;    // face value, credit_currency
  credit_currency: string | null;
  /** Sum of unpaid invoice amounts, report currency (NULL when not computable). */
  exposure: number | null;
  /** exposure / converted limit * 100. NULL when no limit or unconvertible. */
  utilization_pct: number | null;
  /** Avg days from issue_date to paid_at over the partner's paid invoices. */
  avg_pay_days: number | null;
  /** Share of paid invoices settled on/before due_date, 0-100. */
  on_time_pct: number | null;
  /** Count of the partner's unpaid (sent/overdue) invoices. */
  invoice_count: number;
}

export interface CreditKpis {
  /** Sum of unpaid issued-invoice amounts (status sent|overdue), report currency. */
  outstanding: number;
  /** Face-value outstanding totals per invoice currency. */
  outstanding_per_currency: Record<string, number>;
  /** Unpaid invoices with due_date < today — report currency amount + count. */
  overdue_amount: number;
  overdue_count: number;
  /** Avg days from issue to paid over paid invoices in the last 90 days. */
  dso: number | null;
  /** Unpaid invoices due within the next 7 days — amount + count. */
  at_risk_amount: number;
  at_risk_count: number;
  /** Partners currently flagged on_hold. */
  on_hold_partners: number;
}

/** Full GET /api/credit/report response. */
export interface CreditReport {
  /** The report currency the aggregates are expressed in. */
  currency: string;
  /**
   * false when at least one relevant currency could not be converted to the
   * report currency — those amounts are excluded from the report-currency
   * aggregates but remain visible in the per_currency records.
   */
  fx_available: boolean;
  /** Currencies with no conversion path to the report currency. */
  fx_unavailable: string[];
  kpis: CreditKpis;
  /** 5 buckets, current → 90+. */
  aging: CreditAgingBucket[];
  /** Reminders (kind='reminder') sent in the last 30 days. */
  reminders_sent_30d: number;
  /** Unpaid sent invoices, most overdue first. */
  queue: CreditQueueItem[];
  /** Partners with unpaid invoices or a credit limit, exposure DESC. */
  partners: CreditPartnerExposure[];
  generated_at: string;
}
