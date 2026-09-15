import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey, resolveTenantId, hasPermission, sanitizeError } from "@/lib/api/helpers";
import { withApm } from "@/lib/monitoring/apm";
import type { Invoice, Partner, CollectionReminder } from "@/lib/supabase/types";
import type {
  CreditReport, CreditAgingBucket, CreditQueueItem, CreditPartnerExposure,
} from "@/lib/credit/report-types";

export const runtime = "nodejs";

/* ─────────────────────────────────────────────────────────────────────────────
 * INDICATIVE STATIC FX RATES — units of currency per 1 USD.
 *
 * No live FX feed is available on the server (the /api/exchange-rates helper
 * is client-facing and rate-limited), so report-currency aggregates convert
 * through this small static cross-rate table covering the six platform
 * reporting currencies. These are APPROXIMATE REFERENCE RATES — good enough
 * for a collections dashboard, NOT for accounting. Exact face-value totals
 * are always exposed per currency in `per_currency` records so the numbers
 * stay auditable. Any currency outside the table (and different from the
 * report currency) is flagged via fx_available=false + fx_unavailable[] and
 * excluded from the converted aggregates.
 * ──────────────────────────────────────────────────────────────────────────── */
const UNITS_PER_USD: Record<string, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  AED: 3.6725,
  SAR: 3.75,
  TRY: 34.5,
};

/** Convert `amount` from `from` to `to`. Returns null when no rate exists. */
function convertToReport(amount: number, from: string, to: string): number | null {
  if (!from || !to) return null;
  if (from === to) return amount;
  const f = UNITS_PER_USD[from];
  const t = UNITS_PER_USD[to];
  if (!f || !t) return null;
  return (amount / f) * t;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC-day-normalised timestamp — keeps day math stable across TZs. */
function dayStart(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

async function _get(req: NextRequest) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (invoices.read — the collections workbench reads the
    // same invoice data as the invoices view).
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "invoices.read"); if (_d) return _d; } } /* requirePermission wired */
    // Feature gate (module_finance)
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
      const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
      const _f = await requireFeature(_tid, "module_finance", _isSA); if (_f) return _f; } /* requireFeature wired */

    const tid = resolveTenantId(auth, req);
    if (!tid) return NextResponse.json({ error: "Tenant context required." }, { status: 400 });

    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "invoices:read")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }

    const url = new URL(req.url);
    const currency = (url.searchParams.get("currency") || "USD").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      return NextResponse.json({ error: "Invalid currency code — expected ISO 4217 (e.g. USD)." }, { status: 400 });
    }

    // ── Load the three source datasets (store-layer cap is 10k, matching
    //    the export ceiling; the collections report needs the full history
    //    for DSO / pay-behaviour stats, not a UI page).
    const [invoicesRes, partnersRes, reminders] = await Promise.all([
      auth.store.listInvoices(tid, { limit: 10000 }),
      auth.store.listPartners(tid, { limit: 10000 }),
      auth.store.listCollectionReminders(tid, 365),
    ]);
    // Defense-in-depth tenant scoping (parity with /api/invoices GET).
    const shouldFilter = "apiKeyId" in auth || !auth.isSuperAdmin;
    const invoices: Invoice[] = shouldFilter && auth.tenantId
      ? invoicesRes.items.filter((i) => i.tenant_id === auth.tenantId)
      : invoicesRes.items;
    const partners: Partner[] = shouldFilter && auth.tenantId
      ? partnersRes.items.filter((p) => p.tenant_id === auth.tenantId)
      : partnersRes.items;

    const partnerById = new Map(partners.map((p) => [p.id, p]));
    const now = Date.now();
    const today = dayStart(new Date().toISOString()) ?? now;

    // Unpaid = issued and not settled. InvoiceStatus has no "partially_paid"
    // value — sent + overdue are the two open, issued statuses.
    const unpaid = invoices.filter((i) => i.status === "sent" || i.status === "overdue");

    const unavailable = new Set<string>();
    /** Face-value accumulation + converted total; flags unknown currencies. */
    const addAmount = (perCurrency: Record<string, number>, inv: Invoice): number => {
      perCurrency[inv.currency] = (perCurrency[inv.currency] || 0) + (inv.total || 0);
      const conv = convertToReport(inv.total || 0, inv.currency, currency);
      if (conv === null) {
        if (inv.currency !== currency) unavailable.add(inv.currency);
        return 0;
      }
      return conv;
    };

    // ── KPIs ──────────────────────────────────────────────────────────────
    const outstandingPerCurrency: Record<string, number> = {};
    let outstanding = 0;
    let overdueAmount = 0, overdueCount = 0;
    let atRiskAmount = 0, atRiskCount = 0;

    for (const inv of unpaid) {
      outstanding += addAmount(outstandingPerCurrency, inv);
      const due = dayStart(inv.due_date);
      const daysOverdue = due === null ? null : Math.floor((today - due) / DAY_MS);
      if (daysOverdue !== null && daysOverdue > 0) {
        overdueCount++;
        const conv = convertToReport(inv.total || 0, inv.currency, currency);
        if (conv !== null) overdueAmount += conv;
      } else if (daysOverdue !== null && daysOverdue >= -7) {
        // Due within the next 7 days (incl. today) — at-risk, not yet overdue.
        atRiskCount++;
        const conv = convertToReport(inv.total || 0, inv.currency, currency);
        if (conv !== null) atRiskAmount += conv;
      }
    }

    // DSO — avg days from issue to paid over paid invoices in the last 90d.
    const dsoCutoff = now - 90 * DAY_MS;
    const payDurations = invoices
      .filter((i) => i.status === "paid" && i.paid_at && new Date(i.paid_at).getTime() >= dsoCutoff && i.issue_date)
      .map((i) => (new Date(i.paid_at!).getTime() - new Date(i.issue_date).getTime()) / DAY_MS)
      .filter((d) => Number.isFinite(d) && d >= 0);
    const dso = payDurations.length > 0
      ? Math.round((payDurations.reduce((a, b) => a + b, 0) / payDurations.length) * 10) / 10
      : null;

    // ── Aging buckets ─────────────────────────────────────────────────────
    const agingDefs: { key: CreditAgingBucket["key"]; test: (d: number | null) => boolean }[] = [
      { key: "current", test: (d) => d === null || d <= 0 },
      { key: "1-30", test: (d) => d !== null && d >= 1 && d <= 30 },
      { key: "31-60", test: (d) => d !== null && d >= 31 && d <= 60 },
      { key: "61-90", test: (d) => d !== null && d >= 61 && d <= 90 },
      { key: "90+", test: (d) => d !== null && d > 90 },
    ];
    const agingEntries = agingDefs.map((def) => ({
      def,
      bucket: { key: def.key, count: 0, amount: 0, per_currency: {} } as CreditAgingBucket,
    }));
    for (const inv of unpaid) {
      const due = dayStart(inv.due_date);
      const daysOverdue = due === null ? null : Math.floor((today - due) / DAY_MS);
      const entry = agingEntries.find((b) => b.def.test(daysOverdue));
      if (!entry) continue;
      entry.bucket.count++;
      entry.bucket.amount += addAmount(entry.bucket.per_currency, inv);
    }
    const aging: CreditAgingBucket[] = agingEntries.map((e) => e.bucket);

    // ── Reminders KPI (last 30 days) ──────────────────────────────────────
    const remindCutoff = now - 30 * DAY_MS;
    const remindersSent30d = reminders.filter(
      (r) => r.kind === "reminder" && new Date(r.sent_at).getTime() >= remindCutoff,
    ).length;

    // ── Collections queue ─────────────────────────────────────────────────
    // Reminders tied to a specific invoice build that invoice's ladder.
    const remindersByInvoice = new Map<string, CollectionReminder[]>();
    for (const r of reminders) {
      if (!r.invoice_id) continue;
      const list = remindersByInvoice.get(r.invoice_id) || [];
      list.push(r);
      remindersByInvoice.set(r.invoice_id, list);
    }

    const queue: CreditQueueItem[] = unpaid
      .map((inv): CreditQueueItem => {
        const due = dayStart(inv.due_date);
        const daysOverdue = due === null ? 0 : Math.floor((today - due) / DAY_MS);
        const invReminders = (remindersByInvoice.get(inv.id) || [])
          .filter((r) => r.kind === "reminder");
        const stageLadder = [1, 2, 3]
          .map((stage) => {
            const atStage = invReminders
              .filter((r) => r.stage === stage)
              .sort((a, b) => b.sent_at.localeCompare(a.sent_at));
            return atStage.length > 0 ? { stage, sent_at: atStage[0].sent_at } : null;
          })
          .filter((x): x is { stage: number; sent_at: string } => x !== null);
        const nextStage = [1, 2, 3].find((s) => !stageLadder.some((r) => r.stage === s)) ?? null;
        const lastReminderAt = invReminders
          .map((r) => r.sent_at)
          .sort((a, b) => b.localeCompare(a))[0] ?? null;
        const partner = partnerById.get(inv.partner_id);
        return {
          invoice_id: inv.id,
          number: inv.number,
          partner_id: inv.partner_id,
          partner_name: partner?.name || "—",
          amount: inv.total || 0,
          currency: inv.currency,
          amount_report: convertToReport(inv.total || 0, inv.currency, currency),
          due_date: inv.due_date || null,
          days_overdue: daysOverdue,
          stage_ladder: stageLadder,
          next_stage: nextStage,
          last_reminder_at: lastReminderAt,
          reminder_count: invReminders.length,
        };
      })
      .sort((a, b) => b.days_overdue - a.days_overdue || b.amount - a.amount);

    // ── Partner exposure ──────────────────────────────────────────────────
    const unpaidByPartner = new Map<string, Invoice[]>();
    for (const inv of unpaid) {
      const list = unpaidByPartner.get(inv.partner_id) || [];
      list.push(inv);
      unpaidByPartner.set(inv.partner_id, list);
    }
    const paidByPartner = new Map<string, Invoice[]>();
    for (const inv of invoices) {
      if (inv.status !== "paid") continue;
      const list = paidByPartner.get(inv.partner_id) || [];
      list.push(inv);
      paidByPartner.set(inv.partner_id, list);
    }

    const exposure: CreditPartnerExposure[] = [];
    for (const p of partners) {
      const openInvoices = unpaidByPartner.get(p.id) || [];
      const hasLimit = p.credit_limit != null && p.credit_limit > 0;
      if (openInvoices.length === 0 && !hasLimit) continue;

      let exposureSum = 0;
      for (const inv of openInvoices) {
        const conv = convertToReport(inv.total || 0, inv.currency, currency);
        if (conv === null) {
          if (inv.currency !== currency) unavailable.add(inv.currency);
          continue;
        }
        exposureSum += conv;
      }

      // Utilisation needs the limit in the report currency too.
      let utilization: number | null = null;
      if (hasLimit && p.credit_currency) {
        const limitReport = convertToReport(p.credit_limit!, p.credit_currency, currency);
        if (limitReport !== null && limitReport > 0) {
          utilization = Math.round((exposureSum / limitReport) * 1000) / 10;
        } else if (p.credit_currency !== currency) {
          unavailable.add(p.credit_currency);
        }
      }

      const paidInvoices = paidByPartner.get(p.id) || [];
      let avgPayDays: number | null = null;
      let onTimePct: number | null = null;
      const durations: number[] = [];
      let onTime = 0;
      for (const inv of paidInvoices) {
        if (!inv.paid_at || !inv.issue_date) continue;
        const dur = (new Date(inv.paid_at).getTime() - new Date(inv.issue_date).getTime()) / DAY_MS;
        if (Number.isFinite(dur) && dur >= 0) durations.push(dur);
        const paidDay = dayStart(inv.paid_at);
        const dueDay = dayStart(inv.due_date);
        if (paidDay !== null && dueDay !== null && paidDay <= dueDay) onTime++;
      }
      if (durations.length > 0) {
        avgPayDays = Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10;
      }
      if (paidInvoices.length > 0) {
        onTimePct = Math.round((onTime / paidInvoices.length) * 1000) / 10;
      }

      exposure.push({
        partner_id: p.id,
        name: p.name,
        status: p.status,
        on_hold: !!p.on_hold,
        credit_limit: p.credit_limit ?? null,
        credit_currency: p.credit_currency ?? null,
        exposure: openInvoices.length > 0 ? Math.round(exposureSum * 100) / 100 : 0,
        utilization_pct: utilization,
        avg_pay_days: avgPayDays,
        on_time_pct: onTimePct,
        invoice_count: openInvoices.length,
      });
    }
    exposure.sort((a, b) => (b.exposure ?? 0) - (a.exposure ?? 0) || a.name.localeCompare(b.name));

    const report: CreditReport = {
      currency,
      fx_available: unavailable.size === 0,
      fx_unavailable: [...unavailable].sort(),
      kpis: {
        outstanding: Math.round(outstanding * 100) / 100,
        outstanding_per_currency: outstandingPerCurrency,
        overdue_amount: Math.round(overdueAmount * 100) / 100,
        overdue_count: overdueCount,
        dso,
        at_risk_amount: Math.round(atRiskAmount * 100) / 100,
        at_risk_count: atRiskCount,
        on_hold_partners: partners.filter((p) => p.on_hold).length,
      },
      aging,
      reminders_sent_30d: remindersSent30d,
      queue,
      partners: exposure,
      generated_at: new Date().toISOString(),
    };
    return NextResponse.json(report);
  } catch (error: any) {
    console.error("[credit.report]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

// ── APM wrappers (task D-8) ──────────────────────────────────────────────
export const GET = withApm(_get, "GET /api/credit/report");
