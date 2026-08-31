import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { notify } from "@/lib/notif/helper";
import { validateStatusTransition } from "@/lib/api/status-validator";
import { triggerWebhooks } from "@/lib/webhooks/deliver";
import { notifyInvoicePayment } from "@/lib/realtime/notify";

export const runtime = "nodejs";

/**
 * POST /api/invoices/[id]/record-payment
 *
 * Records a payment against an invoice. The actual write cascade —
 * INSERT bank_transaction + UPDATE invoice status + bulk UPDATE
 * deal_commissions + UPDATE proforma + INSERT journal_entry (header +
 * lines) — is performed atomically by the `record_invoice_payment`
 * SECURITY DEFINER RPC (migration 071). The route is now THIN: it
 * validates input + resolves the bank_account_id (tenant-checked) +
 * computes the FX rate (F19) + calls the RPC + fires the
 * side-effects (notification, audit, webhook) that stay
 * fire-and-forget OUTSIDE the atomic transaction.
 *
 * WHY THE RPC (audit 2d2-F2 + F4 + F19 + F20):
 *   Previously this route performed 5+ separate PostgREST writes in
 *   their own try/catch blocks. If step 1 (bank_txn INSERT) succeeded
 *   but step 2 (invoice status UPDATE) failed, the bank had a credit
 *   row but the invoice still showed "sent" → phantom credit (F4).
 *   If the JE header INSERT succeeded but the lines INSERT failed,
 *   the JE was committed with ZERO lines → GL corruption (F2). The
 *   commission cascade was a per-row JS loop — mid-loop failure left
 *   some commissions "approved" and some "pending" (F20). The
 *   auto-journal hardcoded `exchange_rate: 1` (F19).
 *
 *   All five writes are now inside one Postgres transaction in the
 *   RPC. Postgres auto-rollbacks on any error. Side-effects (audit,
 *   notification, webhook) stay fire-and-forget OUTSIDE the
 *   transaction (per the task brief — they're not part of the GL).
 *
 * Body:
 *   {
 *     amount: number,                // required, > 0
 *     method:  string,               // required — bank_transfer | cash | check | card | other
 *     reference?: string,            // optional — txn reference / cheque no.
 *     payment_date?: string,         // optional — ISO date (YYYY-MM-DD); defaults to today
 *     bank_account_id?: string       // optional — defaults to first active account
 *   }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;

    // Permission gate (invoices.update)
    {
      const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "invoices.update");
      if (_d) return _d;
    }
    // Feature gate (module_finance)
    {
      const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin);
      if (_f) return _f;
    }

    const { resolveTenantId } = await import("@/lib/api/helpers");
    const tid = resolveTenantId(auth, req);
    if (!tid) {
      return NextResponse.json({ error: "No tenant context. Select a tenant or provide ?tenant_id=." }, { status: 400 });
    }

    const { id } = await params;

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const { amount, method, reference, payment_date, bank_account_id } = body;

    // ── Validate input ───────────────────────────────────────────────────
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return NextResponse.json({ error: "A valid payment amount greater than zero is required." }, { status: 400 });
    }
    if (!method || typeof method !== "string") {
      return NextResponse.json({ error: "Payment method is required." }, { status: 400 });
    }
    const allowedMethods = new Set(["bank_transfer", "cash", "check", "card", "other"]);
    if (!allowedMethods.has(String(method).toLowerCase())) {
      return NextResponse.json({ error: `Unknown payment method: ${method}.` }, { status: 400 });
    }
    const paymentDateRaw = payment_date
      ? String(payment_date)
      : new Date().toISOString().slice(0, 10);
    // Accept either "YYYY-MM-DD" or full ISO; we store as timestamptz.
    const paymentDateIso = new Date(paymentDateRaw).toISOString();

    // ── Fetch invoice (early bail before calling the RPC) ───────────────
    const invoice = await auth.store.getInvoice(id);
    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found." }, { status: 404 });
    }
    if (!auth.isSuperAdmin && invoice.tenant_id !== tid) {
      return NextResponse.json({ error: "Invoice not found." }, { status: 404 });
    }
    if (invoice.status === "paid" || invoice.status === "cancelled") {
      return NextResponse.json(
        { error: `Invoice is already ${invoice.status} — no further payments can be recorded.` },
        { status: 409 },
      );
    }

    // ── Resolve bank account (tenant-scoped; F-3 cross-tenant guard) ──
    let bankAccountId: string | null = bank_account_id || null;
    if (!bankAccountId) {
      try {
        const accounts = await auth.store.listErpBankAccounts(tid);
        const active = accounts.find((a) => a.is_active) || accounts[0];
        if (active) bankAccountId = active.id;
      } catch (e) {
        console.warn("[record-payment] listErpBankAccounts failed:", e);
      }
    }
    // F-3 guard: validate user-supplied bank_account_id belongs to caller's tenant.
    // The fallback above is already tenant-scoped via listErpBankAccounts(tid),
    // but the user-supplied value is NOT. The RPC also enforces this (defense
    // in depth), but we do the early reject here so we return a 404 instead of
    // a 500 from the RPC raising inside the transaction.
    if (bankAccountId) {
      try {
        const { getSupabase } = await import("@/lib/supabase/client");
        const sb = getSupabase();
        const { data: bankAccount, error: baError } = await sb
          .from("erp_bank_accounts")
          .select("id, tenant_id, currency")
          .eq("id", bankAccountId)
          .eq("tenant_id", tid)
          .maybeSingle();
        if (baError) {
          console.warn("[record-payment] bank account tenant check failed:", baError.message);
        }
        if (!bankAccount) {
          return NextResponse.json({ error: "Bank account not found." }, { status: 404 });
        }
      } catch (e: any) {
        console.error("[record-payment] bank account validation threw:", e);
        return NextResponse.json(
          { error: `Bank account validation failed: ${sanitizeError(e)}` },
          { status: 500 },
        );
      }
    }

    // ── Validate status transition (P1-6) BEFORE calling the RPC ──────────
    // The RPC computes the new status (paid/partial) based on the cumulative
    // paid sum. We validate the transition here so we can return 409 before
    // touching the DB. (The RPC's invoice SELECT FOR UPDATE also implicitly
    // rejects the "already paid/cancelled" case by raising — but we already
    // early-bail above for those statuses.)
    // We optimistically validate BOTH possible transitions ("partial" and
    // "paid") — the actual one is determined inside the RPC.
    {
      const targetStatuses = ["partial", "paid"];
      for (const target of targetStatuses) {
        if (target !== invoice.status) {
          const transitionError = validateStatusTransition("invoice", invoice.status, target);
          if (typeof transitionError === "string") {
            return NextResponse.json({ error: transitionError }, { status: 409 });
          }
          if (transitionError && !transitionError.valid) {
            return NextResponse.json(
              { error: transitionError.error || "Invalid status transition." },
              { status: 409 },
            );
          }
        }
      }
    }

    // ── Compute exchange rate (audit 2d2-F19) ────────────────────────────
    // The RPC accepts p_exchange_rate and stores it on the JE row. When the
    // bank_account.currency differs from the invoice.currency, we fetch the
    // live rate via getExchangeRate(). When they match (or no bank_account),
    // the rate is 1. The RPC persists this HISTORICAL rate on the JE so
    // future revaluations use the rate-at-payment, not a re-fetched live rate
    // (compounds 2d2-F22).
    let exchangeRate = 1;
    try {
      const invoiceCurrency = (invoice.currency as string) || "USD";
      let bankCurrency: string | null = null;
      if (bankAccountId) {
        const { getSupabase } = await import("@/lib/supabase/client");
        const sb = getSupabase();
        const { data: ba } = await sb
          .from("erp_bank_accounts")
          .select("currency")
          .eq("id", bankAccountId)
          .eq("tenant_id", tid)
          .maybeSingle();
        bankCurrency = (ba as any)?.currency || null;
      }
      if (bankCurrency && bankCurrency.toUpperCase() !== invoiceCurrency.toUpperCase()) {
        const { getExchangeRate } = await import("@/lib/utils/exchange-rates");
        const rate = await getExchangeRate(invoiceCurrency.toUpperCase(), bankCurrency.toUpperCase());
        exchangeRate = rate || 1; // fallback to 1 if rate fetch fails (matches existing behavior)
      }
    } catch (e) {
      console.warn("[record-payment] exchange rate lookup failed, defaulting to 1:", e);
      exchangeRate = 1;
    }

    // ── Call the atomic RPC (migration 071) ──────────────────────────────
    // The RPC: SELECT invoice FOR UPDATE → INSERT bank_txn → UPDATE invoice
    // status → bulk UPDATE deal_commissions (F20 fix) → UPDATE proforma →
    // INSERT JE header + lines (F2 fix). All in one Postgres transaction.
    // On any error the whole thing rolls back — no phantom credit, no JE
    // without lines.
    type RpcResult = {
      bank_transaction_id?: string | null;
      invoice_status?: string;
      is_full_payment?: boolean;
      cumulative_paid?: number | string;
      invoice_total?: number | string;
      commissions_marked_approved?: number;
      commission_deal_id?: string | null;
      proforma_id?: string | null;
      proforma_updated?: boolean;
      journal_entry_id?: string | null;
      journal_skipped?: boolean;
      journal_error?: string | null;
    };
    let rpcResult: RpcResult | null = null;
    let rpcError: string | null = null;
    try {
      const { getSupabase } = await import("@/lib/supabase/client");
      const sb = getSupabase();
      const { data, error } = await sb.rpc("record_invoice_payment", {
        p_invoice_id: id,
        p_tenant_id: tid,
        p_amount: numericAmount,
        p_currency: (invoice.currency as string) || "USD",
        p_bank_account_id: bankAccountId || null,
        p_reference: reference ? String(reference) : null,
        p_paid_at: paymentDateIso,
        p_created_by: auth.user.id,
        p_payment_method: String(method).toLowerCase(),
        p_exchange_rate: exchangeRate,
      });
      if (error) {
        rpcError = sanitizeError(error);
      } else {
        rpcResult = (data ?? null) as RpcResult | null;
      }
    } catch (e: any) {
      rpcError = sanitizeError(e);
    }

    // ── RPC unavailable → fall back to legacy non-atomic cascade ──────
    // (mirrors the inventory-cascade fallback pattern). Only fires when
    // the migration 071 RPC has not been applied. A warning is logged.
    if (rpcError && /could not find|does not exist|function/i.test(rpcError) && rpcResult === null) {
      console.warn(
        "[record-payment] record_invoice_payment RPC not available — falling back to legacy non-atomic cascade. Apply migration 071 to close 2d2-F2 + F4 + F19 + F20.",
      );
      const legacy = await legacyNonAtomicCascade({
        auth,
        req,
        tid,
        id,
        invoice,
        numericAmount,
        method,
        reference,
        paymentDateIso,
        bankAccountId,
        exchangeRate,
      });
      return legacy;
    }

    if (rpcError) {
      console.error("[record-payment] RPC failed:", rpcError);
      return NextResponse.json(
        { error: `Failed to record payment: ${sanitizeError(rpcError)}` },
        { status: 500 },
      );
    }

    const newStatus = rpcResult?.invoice_status || "paid";
    const isFullPayment = !!rpcResult?.is_full_payment;
    const transactionId = rpcResult?.bank_transaction_id || null;
    const totalPaid = Number(rpcResult?.cumulative_paid ?? numericAmount);

    // Build cascade_results so the audit trail + response surface what the
    // RPC actually did (commission, proforma, journal). Mirrors the shape
    // the legacy route returned so the UI / ops dashboard see the same
    // fields.
    const cascadeResults: {
      commission?: { ok: boolean; updated?: number; error?: string };
      proforma?: { ok: boolean; updated?: boolean; error?: string };
      journal?: { ok: boolean; skipped?: boolean; error?: string; journal_entry_id?: string | null };
    } = {};
    if (rpcResult?.commissions_marked_approved !== undefined) {
      cascadeResults.commission = { ok: true, updated: rpcResult.commissions_marked_approved };
    }
    if (rpcResult?.proforma_id) {
      cascadeResults.proforma = { ok: true, updated: !!rpcResult.proforma_updated };
    }
    cascadeResults.journal = {
      ok: !rpcResult?.journal_error,
      skipped: !!rpcResult?.journal_skipped,
      error: rpcResult?.journal_error || undefined,
      journal_entry_id: rpcResult?.journal_entry_id || null,
    };

    // ── Side-effects (fire-and-forget OUTSIDE the transaction) ──────────
    // Notification
    try {
      const partner = invoice.partner_id ? await auth.store.getPartner(invoice.partner_id) : null;
      const partnerName = partner?.name || "Client";
      await notify({
        tenantId: tid,
        userId: null,
        type: "invoice_paid",
        title: isFullPayment ? "Invoice Paid" : "Partial Payment Recorded",
        message:
          (isFullPayment ? "Payment recorded in full" : "Partial payment recorded") +
          ` for invoice ${invoice.number} (${partnerName}).` +
          (reference ? ` Ref: ${reference}.` : ""),
        entityType: "invoice",
        entityId: id,
        actionUrl: `/invoices?id=${id}`,
        actionLabel: "View Invoice",
      });
    } catch (e) {
      console.error("[record-payment] notification failed:", e);
    }

    // Audit (always — payment was recorded)
    try {
      await audit(auth.store, auth.user, req, "invoice.payment_recorded", "invoice", id, {
        amount: numericAmount,
        method,
        reference: reference || null,
        payment_date: paymentDateIso,
        transaction_id: transactionId,
        bank_account_id: bankAccountId,
        new_status: newStatus,
        exchange_rate: exchangeRate,
        cascade_results: cascadeResults,
        // P1 Fix 2: include the cascade results in the audit trail so
        // ops can see at a glance whether the downstream consistency
        // writes (commission, proforma, journal) succeeded or failed
        // for this payment. Failed cascades require manual follow-up.
      });
    } catch (e) {
      console.error("[audit]", e);
    }

    // ── F-4: fire outbound webhook (invoice.paid) on full payment ─────
    // Fire-and-forget — webhook delivery failures must NEVER block the
    // payment recording.
    if (isFullPayment && newStatus === "paid") {
      void triggerWebhooks(
        auth.store,
        tid,
        "invoice.paid",
        "invoice",
        id,
        {
          id: invoice.id,
          number: invoice.number,
          total: invoice.total,
          currency: invoice.currency,
          partner_id: invoice.partner_id,
          paid_at: paymentDateIso,
          payment_amount: numericAmount,
          payment_method: method,
          payment_reference: reference || null,
          cumulative_paid: totalPaid,
          transaction_id: transactionId,
        },
      ).catch((e) => console.error("[record-payment] webhook trigger failed:", e));
    }

    // ── D-4: real-time push to tenant admins ────────────────────────────
    void notifyInvoicePayment(tid, {
      invoiceId: id,
      invoiceNumber: invoice.number,
      amount: numericAmount,
      method,
      reference: reference || null,
      status: newStatus,
      isFullPayment,
      partnerId: invoice.partner_id || null,
      paidAt: paymentDateIso,
    });

    return NextResponse.json({
      ok: true,
      status: newStatus,
      transaction_id: transactionId,
      bank_account_id: bankAccountId,
      cascade_results: cascadeResults,
    });
  } catch (e: any) {
    console.error("[invoice.record-payment]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

/**
 * Legacy non-atomic cascade — used ONLY when migration 071's
 * `record_invoice_payment` RPC is not yet deployed. Mirrors the
 * original implementation (lines 152-795 of the original route) so the
 * payment flow keeps working in pre-migration environments.
 *
 * NOTE: this path retains the 2d2-F2/F4/F19/F20 bugs the RPC fixes.
 * Apply migration 071 to close them.
 */
async function legacyNonAtomicCascade(opts: {
  auth: any;
  req: NextRequest;
  tid: string;
  id: string;
  invoice: any;
  numericAmount: number;
  method: string;
  reference?: string;
  paymentDateIso: string;
  bankAccountId: string | null;
  exchangeRate: number;
}): Promise<NextResponse> {
  const { auth, req, tid, id, invoice, numericAmount, method, reference, paymentDateIso, bankAccountId, exchangeRate } = opts;

  // ── Insert ERP bank transaction ──────────────────────────────────────
  let transactionId: string | null = null;
  if (bankAccountId) {
    try {
      const txn = await auth.store.upsertErpBankTransaction({
        tenant_id: tid,
        bank_account_id: bankAccountId,
        date: paymentDateIso,
        amount: numericAmount,
        transaction_type: "credit",
        description: `Payment for invoice ${invoice.number}`,
        reference: reference ? String(reference) : null,
        counterparty: invoice.partner_id || null,
        is_reconciled: false,
        reconciled_with: invoice.id,
        invoice_number: invoice.number,
        category: "invoice_payment",
        is_auto_generated: true,
      } as any);
      transactionId = (txn as any)?.id || null;
    } catch (e: any) {
      console.error("[record-payment:legacy] bank txn insert failed:", e);
      return NextResponse.json(
        { error: `Failed to record bank transaction: ${sanitizeError(e)}` },
        { status: 500 },
      );
    }
  } else {
    console.warn(
      `[record-payment:legacy] tenant ${tid} has no erp_bank_accounts — invoice ${invoice.number} marked paid without a bank txn.`,
    );
  }

  // ── Cumulative paid lookup + atomic invoice status update ──────────
  const invoiceTotal = Number(invoice.total ?? 0);
  let totalPaid = numericAmount;
  try {
    const { getSupabase } = await import("@/lib/supabase/client");
    const sb = getSupabase();
    const { data: priorTxns } = await sb
      .from("erp_bank_transactions")
      .select("amount")
      .eq("invoice_number", invoice.number)
      .eq("tenant_id", tid)
      .eq("transaction_type", "credit")
      .eq("category", "invoice_payment");
    if (priorTxns && priorTxns.length > 0) {
      totalPaid = (priorTxns as Array<{ amount: number | string }>).reduce(
        (sum, t) => sum + Number(t.amount || 0),
        0,
      );
    }
  } catch (e) {
    console.warn("[record-payment:legacy] cumulative lookup threw:", e);
  }

  let isFullPayment = totalPaid >= invoiceTotal - 0.01;
  let newStatus: string = isFullPayment ? "paid" : "partial";
  try {
    const { getSupabase } = await import("@/lib/supabase/client");
    const sbRpc = getSupabase();
    const { data: rpcResult, error: rpcError } = await sbRpc.rpc("atomic_update_invoice_payment_status", {
      p_invoice_id: id,
      p_tenant_id: tid,
    });
    if (!rpcError && rpcResult) {
      newStatus = rpcResult as string;
      isFullPayment = newStatus === "paid";
    }
  } catch (e) {
    console.warn("[record-payment:legacy] atomic status RPC failed, using JS fallback:", e);
  }

  const nowIso = new Date().toISOString();
  try {
    const patch: { id: string; status: any; paid_at?: string; updated_at: string } = {
      id,
      status: newStatus as any,
      updated_at: nowIso,
    };
    if (isFullPayment) patch.paid_at = nowIso;
    await auth.store.upsertInvoice(patch as any);
  } catch (e: any) {
    console.error("[record-payment:legacy] invoice update failed:", e);
    return NextResponse.json(
      { error: `Failed to update invoice: ${sanitizeError(e)}` },
      { status: 500 },
    );
  }

  // ── Notification + audit ─────────────────────────────────────────────
  try {
    const partner = invoice.partner_id ? await auth.store.getPartner(invoice.partner_id) : null;
    const partnerName = partner?.name || "Client";
    await notify({
      tenantId: tid,
      userId: null,
      type: "invoice_paid",
      title: isFullPayment ? "Invoice Paid" : "Partial Payment Recorded",
      message:
        (isFullPayment ? "Payment recorded in full" : "Partial payment recorded") +
        ` for invoice ${invoice.number} (${partnerName}).` +
        (reference ? ` Ref: ${reference}.` : ""),
      entityType: "invoice",
      entityId: id,
      actionUrl: `/invoices?id=${id}`,
      actionLabel: "View Invoice",
    });
  } catch (e) {
    console.error("[record-payment:legacy] notification failed:", e);
  }

  const cascadeResults: {
    commission?: { ok: boolean; updated?: number; error?: string };
    proforma?: { ok: boolean; updated?: boolean; error?: string };
    journal?: { ok: boolean; skipped?: boolean; error?: string };
  } = {};

  if (isFullPayment && invoice.offer_id) {
    try {
      const offer = await auth.store.getOffer(invoice.offer_id);
      const dealId = (offer as any)?.deal_id;
      if (dealId) {
        const { markCommissionsEarnedOnInvoicePaid } = await import("@/lib/api/commission-cascade");
        const result = await markCommissionsEarnedOnInvoicePaid(dealId, tid);
        cascadeResults.commission = { ok: true, updated: result.updated };
      }
    } catch (e: any) {
      console.error(
        `[record-payment:legacy] commission cascade FAILED for invoice ${invoice.number}:`,
        e,
      );
      cascadeResults.commission = { ok: false, error: sanitizeError(e) };
    }
  }

  // Legacy proforma cascade (simplified).
  if (isFullPayment) {
    try {
      const { getSupabase } = await import("@/lib/supabase/client");
      const sb = getSupabase();
      let proformaId: string | null = (invoice as any).proforma_id || null;
      if (!proformaId && invoice.offer_id) {
        const { data: linked } = await sb
          .from("proformas")
          .select("id, status, tenant_id")
          .eq("offer_id", invoice.offer_id)
          .eq("tenant_id", tid)
          .order("created_at", { ascending: false })
          .limit(5);
        if (linked && linked.length > 0) {
          const target = (linked as any[]).find((p) => p.status !== "paid" && p.status !== "expired") || (linked as any[])[0];
          proformaId = target?.id || null;
        }
      }
      if (proformaId) {
        const { data: updatedRows } = await sb
          .from("proformas")
          .update({ status: "paid", paid_at: nowIso, updated_at: nowIso })
          .eq("id", proformaId)
          .eq("tenant_id", tid)
          .neq("status", "paid")
          .select("id");
        if (updatedRows && updatedRows.length > 0) {
          cascadeResults.proforma = { ok: true, updated: true };
        } else {
          cascadeResults.proforma = { ok: true, updated: false };
        }
      }
    } catch (e: any) {
      console.error(`[record-payment:legacy] proforma cascade FAILED:`, e);
      cascadeResults.proforma = { ok: false, error: sanitizeError(e) };
    }
  }

  // Legacy auto-journal (simplified — uses exchangeRate param for F19).
  if (newStatus === "paid") {
    try {
      const { getSupabase } = await import("@/lib/supabase/client");
      const sb = getSupabase();
      const { data: existingJE } = await sb
        .from("erp_journal_entries")
        .select("id, entry_number")
        .eq("reference_type", "invoice")
        .eq("reference_id", id)
        .eq("tenant_id", tid)
        .eq("status", "posted")
        .maybeSingle();
      if (existingJE) {
        cascadeResults.journal = { ok: true, skipped: true };
      } else {
        const { data: settings } = await sb
          .from("erp_settings")
          .select("cash_account_id, revenue_account_id, auto_post_journal, default_currency")
          .eq("tenant_id", tid)
          .maybeSingle();
        let bankAccountIdResolved: string | null = (settings as any)?.cash_account_id || null;
        if (!bankAccountIdResolved && bankAccountId) {
          const { data: ba } = await sb
            .from("erp_bank_accounts")
            .select("account_id")
            .eq("id", bankAccountId)
            .eq("tenant_id", tid)
            .maybeSingle();
          if (ba?.account_id) bankAccountIdResolved = (ba as any).account_id;
        }
        const revenueAccountId: string | null = (settings as any)?.revenue_account_id || null;
        let bankAccountValid = false;
        let revenueAccountValid = false;
        if (bankAccountIdResolved) {
          const { data: ba2 } = await sb.from("erp_accounts").select("id").eq("id", bankAccountIdResolved).eq("tenant_id", tid).maybeSingle();
          bankAccountValid = !!ba2;
        }
        if (revenueAccountId) {
          const { data: ra } = await sb.from("erp_accounts").select("id").eq("id", revenueAccountId).eq("tenant_id", tid).maybeSingle();
          revenueAccountValid = !!ra;
        }
        if (bankAccountIdResolved && revenueAccountId && bankAccountValid && revenueAccountValid) {
          const { randomUUID } = await import("node:crypto");
          const jeNumber = `PMT-${invoice.number}-${randomUUID().slice(0, 8)}`;
          const todayIso = new Date().toISOString().slice(0, 10);
          const jeCurrency = (invoice.currency as string) || (settings as any)?.default_currency || "USD";
          const shouldPost = Boolean((settings as any)?.auto_post_journal);
          const jeAmount = totalPaid;
          const { data: je, error: jeError } = await sb
            .from("erp_journal_entries")
            .insert({
              tenant_id: tid,
              entry_number: jeNumber,
              date: todayIso,
              description: `Auto-journal for invoice ${invoice.number} payment`,
              reference_type: "invoice",
              reference_id: id,
              status: shouldPost ? "posted" : "draft",
              source_type: "auto",
              debit_total: jeAmount,
              credit_total: jeAmount,
              currency: jeCurrency,
              exchange_rate: exchangeRate, // F19 fix — pass through the computed rate
              created_by: auth.user.id,
              posted_by: shouldPost ? auth.user.id : null,
              posted_at: shouldPost ? new Date().toISOString() : null,
            })
            .select()
            .maybeSingle();
          if (jeError) {
            cascadeResults.journal = { ok: false, error: jeError.message };
          } else if (je) {
            const jeLines: any[] = [
              {
                journal_entry_id: (je as any).id,
                tenant_id: tid,
                account_id: bankAccountIdResolved,
                description: `Payment received - ${invoice.number}`,
                debit: jeAmount,
                credit: 0,
                line_number: 1,
                currency: jeCurrency,
                partner_id: invoice.partner_id || null,
              },
              {
                journal_entry_id: (je as any).id,
                tenant_id: tid,
                account_id: revenueAccountId,
                description: `Revenue - ${invoice.number}`,
                debit: 0,
                credit: jeAmount,
                line_number: 2,
                currency: jeCurrency,
                partner_id: invoice.partner_id || null,
              },
            ];
            const { error: linesError } = await sb.from("erp_journal_lines").insert(jeLines);
            if (linesError) {
              console.error(`[record-payment:legacy] JE lines insert FAILED:`, linesError.message);
              cascadeResults.journal = { ok: false, error: `lines insert failed: ${linesError.message}` };
            } else {
              cascadeResults.journal = { ok: true };
            }
          }
        } else {
          cascadeResults.journal = { ok: true, skipped: true };
        }
      }
    } catch (e: any) {
      console.error(`[record-payment:legacy] auto journal cascade FAILED:`, e);
      cascadeResults.journal = { ok: false, error: sanitizeError(e) };
    }
  }

  try {
    await audit(auth.store, auth.user, req, "invoice.payment_recorded", "invoice", id, {
      amount: numericAmount,
      method,
      reference: reference || null,
      payment_date: paymentDateIso,
      transaction_id: transactionId,
      bank_account_id: bankAccountId,
      new_status: newStatus,
      exchange_rate: exchangeRate,
      cascade_results: cascadeResults,
      legacy_path: true, // marker — atomic RPC was not applied
    });
  } catch (e) {
    console.error("[audit]", e);
  }

  if (isFullPayment && newStatus === "paid") {
    void triggerWebhooks(
      auth.store, tid, "invoice.paid", "invoice", id,
      {
        id: invoice.id, number: invoice.number, total: invoice.total, currency: invoice.currency,
        partner_id: invoice.partner_id, paid_at: nowIso, payment_amount: numericAmount,
        payment_method: method, payment_reference: reference || null,
        cumulative_paid: totalPaid, transaction_id: transactionId,
      },
    ).catch((e) => console.error("[record-payment:legacy] webhook trigger failed:", e));
  }

  void notifyInvoicePayment(tid, {
    invoiceId: id,
    invoiceNumber: invoice.number,
    amount: numericAmount,
    method,
    reference: reference || null,
    status: newStatus,
    isFullPayment,
    partnerId: invoice.partner_id || null,
    paidAt: nowIso,
  });

  return NextResponse.json({
    ok: true,
    status: newStatus,
    transaction_id: transactionId,
    bank_account_id: bankAccountId,
    cascade_results: cascadeResults,
    legacy_path: true,
  });
}
