import { NextRequest, NextResponse } from "next/server";
// FIX-ALL-2 / Fix 3 — accept API-key auth on [id] routes so an API-key
// caller fetching /api/invoices/<non-existent-id> gets 404 (not 401).
import { requireAuthOrApiKey, hasPermission, audit, sanitizeError } from "@/lib/api/helpers";
import { validateStatusTransition } from "@/lib/api/status-validator";
import { recomputeDocTotals } from "@/lib/utils/doc-totals";

export const runtime = "nodejs";

/**
 * SEC-M10 (mass-assignment on invoices PUT) — the previous PUT handler
 * spread `...body` raw into `upsertInvoice`, so an invoices:write caller
 * could forge audit-trail columns (approved_by, approved_at, paid_at,
 * sent_by, verified_at, verified_by, created_by, created_at) by sending
 * them in the PUT body. The server's smartUpsert already strips
 * created_at/created_by/updated_at on UPDATE, but paid_at / sent_at /
 * approved_at etc. were going straight through to the DB.
 *
 * Allow only the business-level editable fields. Audit-trail + lifecycle
 * timestamp columns are intentionally NOT in this list — they are set
 * exclusively by their dedicated endpoints (record-payment, send, etc.).
 *
 * NOTE: status is in the allow list because the route still runs
 * `validateStatusTransition` on it (line ~88) before the upsert — the
 * whitelist is a column-shape filter, NOT a value validator.
 *
 * NOTE: `_changeNote` is intentionally NOT in the allow list (it is a
 * per-request meta field used by `recordRevision`, not a DB column).
 * The route captures it into a local var BEFORE the whitelist runs.
 */
function whitelistInvoiceFields(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = new Set([
    "subject",
    "partner_id",
    "items",
    "currency",
    "status",
    "due_date",
    "issue_date",
    "notes",
    "payment_terms",
    "subtotal",
    "discount_total",
    "tax_total",
    "total",
    "offer_id",
    "number",
    "incoterm",
    "pol",
    "pol_country",
    "pod",
    "pod_country",
    "vessel",
    "container_no",
    "lead_time",
    "packaging",
    "delivery_address",
    "delivery_city",
    "delivery_country",
    "specification",
    "origin_country",
    "exchange_rate",
    "exchange_rate_date",
    "exchange_rate_note",
  ]);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (allowed.has(key)) result[key] = value;
  }
  return result;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthOrApiKey(_req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (invoices.read) — session callers use requirePermission,
    // API-key callers use hasPermission (colon format).
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "invoices.read"); if (_d) return _d; } }
    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "invoices:read")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_finance", _isSA); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const item = await auth.store.getInvoice(id);
    // FIX-ALL-2 / Fix 3 — not-found returns 404, not 401.
    if (!item) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!isSuperAdmin && item.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json(item);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (invoices.update) — session callers use requirePermission,
  // API-key callers use hasPermission (colon format).
  { const { requirePermission } = await import("@/lib/permissions/can");
    if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "invoices.update"); if (_d) return _d; } }
  if ("apiKeyId" in auth && !hasPermission(auth.permissions, "invoices:write")) {
    return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
  }
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_finance", _isSA); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const existing = await auth.store.getInvoice(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const body = await req.json();
    // FIX-PRODUCTS-DOCS / Fix 6 — ISO 4217 currency validation (PUT). A
    // direct API caller could set body.currency to any string; reject
    // unknown codes before we mutate the invoice. Skip when currency is
    // absent (the route preserves the existing value).
    if (body.currency !== undefined && body.currency !== null && body.currency !== "") {
      const { CURRENCY_CODES } = await import("@/lib/data/reference");
      if (!CURRENCY_CODES.includes(body.currency)) {
        return NextResponse.json(
          { error: `Invalid currency code: ${body.currency}. Must be one of: ${CURRENCY_CODES.join(", ")}.` },
          { status: 400 },
        );
      }
    }
    // SEC-M10 — capture the per-request `_changeNote` meta field BEFORE
    // the whitelist strips it. It's not a DB column — it's a transient
    // note attached to the audit-trail revision record below.
    const changeNote = (body as any)?._changeNote || null;
    // AUDIT19 / F2 — cross-tenant partner reference injection. `partner_id`
    // is in the PUT whitelist but was only locked on paid/partial invoices,
    // so a tenant-A invoices:write user could point a draft invoice at a
    // tenant-B partner: the PDF route then renders tenant-B partner PII
    // inside a tenant-A document. Same S-FIX shape as deals/[id].
    // Allow null/empty (clearing) without a lookup.
    if (body.partner_id) {
      const partner = await auth.store.getPartner(body.partner_id);
      if (!partner || partner.tenant_id !== existing.tenant_id) {
        return NextResponse.json({ error: "Partner not found." }, { status: 404 });
      }
    }
    // AUDIT19 / F2 — same injection vector via `offer_id`: the invoice's
    // offer link feeds the commission cascade (deal lookup by offer_id) —
    // a foreign offer silently re-routes commissions to another tenant's
    // deal.
    if (body.offer_id) {
      const offer = await auth.store.getOffer(body.offer_id);
      if (!offer || offer.tenant_id !== existing.tenant_id) {
        return NextResponse.json({ error: "Offer not found." }, { status: 404 });
      }
    }
    // CRITICAL FIX (audit F-2): lock financial fields on paid/partial invoices.
    // A user with invoices.update permission should NOT be able to change total,
    // items, partner_id, or currency on a document that's already been paid.
    // `InvoiceStatus` doesn't formally include "partial" (the union is
    // draft|sent|paid|overdue|cancelled) but record-payment.ts writes "partial"
    // at runtime — so we widen the comparison to `string` to avoid TS narrowing
    // away a status the database can actually hold.
    const existingStatus: string = existing.status;
    if (existingStatus === "paid" || existingStatus === "partial") {
      if (!isSuperAdmin) {
        const lockedFields = ["total", "subtotal", "items", "tax_total", "discount_total", "partner_id", "currency", "offer_id"];
        for (const k of lockedFields) {
          if (k in body) {
            return NextResponse.json(
              { error: `Cannot modify ${k} on a ${existingStatus} invoice. Super-admin override required.` },
              { status: 409 },
            );
          }
        }
      }
    }
    // FIX-P1-LOGIC Fix 1: enforce valid status transitions. Super-admins
    // bypass so they can correct bad data.
    if (body.status && body.status !== existing.status && !isSuperAdmin) {
      const transition = validateStatusTransition("invoice", existing.status, body.status);
      if (!transition.valid) {
        return NextResponse.json({ error: transition.error }, { status: 400 });
      }
    }
    // AUDIT2-LOGIC-UX C5 — refuse `status: "paid"` on the generic PUT.
    // Setting an invoice to "paid" must go through POST /api/invoices/[id]/
    // record-payment, which writes the bank transaction, runs the
    // commission cascade, posts the journal entry, and captures the
    // payment method + reference. A generic PUT bypasses all of that,
    // leaving a financial audit-trail hole. Super-admins bypass so they
    // can correct bad data.
    if (body.status === "paid" && existing.status !== "paid" && !isSuperAdmin) {
      return NextResponse.json(
        { error: "Use the record-payment endpoint to mark invoices as paid (records bank transaction + commission cascade)." },
        { status: 400 },
      );
    }
    // FIX-P1-LOGIC Fix 5: recompute totals from line items — never trust
    // client-supplied totals (parity with offers PUT). Always overwrite.
    if (Array.isArray(body.items) && body.items.length > 0) {
      // AUDIT17 / F2 — range-validate percentage fields before recomputing
      // (PUT previously had no line validation: 150% discount / negative
      // tax_rate flowed straight into the stored totals).
      for (let i = 0; i < body.items.length; i++) {
        const it = body.items[i];
        const disc = Number(it.discount);
        if (Number.isFinite(disc) && (disc < 0 || disc > 100)) {
          return NextResponse.json(
            { error: `items[${i}].discount must be between 0 and 100.` },
            { status: 400 },
          );
        }
        const tr = Number(it.tax_rate);
        if (Number.isFinite(tr) && (tr < 0 || tr > 100)) {
          return NextResponse.json(
            { error: `items[${i}].tax_rate must be between 0 and 100.` },
            { status: 400 },
          );
        }
      }
      // AUDIT18 — canonical totals (lib/utils/doc-totals.ts): replaces the
      // inline quantity×price−disc+tax loop that was copy-pasted across 6
      // routes (and drifted from the client views' math on rounding).
      const totals = recomputeDocTotals(body.items);
      body.subtotal = totals.subtotal;
      body.discount_total = totals.discount_total;
      body.tax_total = totals.tax_total;
      body.total = totals.total;
    }
    // SEC-M10 (mass-assignment) — apply the field whitelist AFTER the
    // total recompute (which writes back subtotal/discount_total/tax_total/
    // total — all in the allow list) and BEFORE the upsert. Strips
    // client-supplied values for audit-trail + lifecycle columns
    // (approved_by, approved_at, paid_at, sent_by, sent_at, verified_at,
    // verified_by, created_by, created_at) so an invoices:write caller
    // cannot forge the payment/approval/verification audit trail by
    // sending those keys in the PUT body.
    const safeBody = whitelistInvoiceFields(body);
    const updated = await auth.store.upsertInvoice({ ...safeBody, id, tenant_id: existing.tenant_id });

    // CRITICAL FIX (audit I-1/I-2): when an invoice is cancelled, reverse
    // the financial side effects that were created when it was paid:
    // 1. Reverse the auto-journal entry (if one exists)
    // 2. Reverse the bank transaction (insert a debit row)
    // 3. Un-mark the linked proforma (set back to 'accepted')
    // 4. Void commissions that were marked 'approved' by the payment
    if (body.status === "cancelled" && (existingStatus === "paid" || existingStatus === "partial")) {
      try {
        const { getSupabase } = await import("@/lib/supabase/client");
        const sb = getSupabase();
        const tid = existing.tenant_id;

        // 1. Find and reverse the auto-journal entry for this invoice
        const { data: je } = await sb
          .from("erp_journal_entries")
          .select("id, status")
          .eq("tenant_id", tid)
          .eq("reference_type", "invoice")
          .eq("reference_id", id)
          .in("status", ["posted", "draft"])
          .maybeSingle();
        if (je) {
          try {
            // FIX-ALL-2 / Fix 3 — the JE reversal API takes a user_id
            // for the audit trail. For API-key callers we don't have a
            // real user_id; pass the synthetic api:<id> so the audit
            // column stays populated and the JE reversal still works.
            const reversalUserId = "user" in auth
              ? auth.user.id
              : `api:${auth.apiKeyId}`;
            await auth.store.reverseErpJournalEntry(je.id, reversalUserId);
          } catch (e) {
            console.warn("[invoice.cancel] JE reversal failed:", e);
          }
        }

        // 2. Insert a reversal bank transaction (debit = negative adjustment)
        const { data: bankTxns } = await sb
          .from("erp_bank_transactions")
          .select("id, amount, bank_account_id, invoice_number")
          .eq("tenant_id", tid)
          .eq("invoice_number", existing.number)
          .eq("transaction_type", "credit")
          .eq("category", "invoice_payment");
        if (bankTxns && bankTxns.length > 0) {
          for (const bt of bankTxns) {
            // AUDIT17 / F9 — the erp_bank_transactions column is `date` (see
            // types.ts / migration 073's index); the previous insert used the
            // nonexistent `transaction_date`, so PostgREST returned PGRST204,
            // supabase-js did NOT throw, and the { error } result was never
            // checked — the bank ledger kept the credit payment of a
            // cancelled invoice. Use the right column and surface failures.
            const { error: revTxErr } = await sb.from("erp_bank_transactions").insert({
              tenant_id: tid,
              bank_account_id: bt.bank_account_id,
              transaction_type: "debit",
              category: "invoice_reversal",
              amount: bt.amount,
              description: `Reversal: cancelled invoice ${existing.number}`,
              invoice_number: existing.number,
              reference: `reversal-inv-${id}`,
              date: new Date().toISOString().split("T")[0],
            });
            if (revTxErr) {
              console.error("[invoice.cancel] bank reversal txn insert failed:", revTxErr);
            }
          }
        }

        // 3. Un-mark the linked proforma (set back to 'accepted' if it was auto-paid)
        if (existing.offer_id) {
          const { data: proforma } = await sb
            .from("proformas")
            .select("id, status")
            .eq("tenant_id", tid)
            .eq("offer_id", existing.offer_id)
            .eq("status", "paid")
            .maybeSingle();
          if (proforma) {
            await sb.from("proformas")
              .update({ status: "accepted", paid_at: null })
              .eq("id", proforma.id);
          }
        }

        // 4. Void commissions that were marked 'approved' by the invoice payment.
        //
        // FIX-AUDIT2-CRIT / C5 — the previous implementation used
        // `existing.offer_id` directly as the `deal_id` FK. `offer_id`
        // is the OFFER UUID, NOT the deal UUID — they are different
        // tables with different PKs (offers.id ≠ deals.id). The query
        // silently matched 0 rows, so cancelling a paid invoice never
        // actually voided the linked commissions.
        //
        // Correct path: look up the offer to get its `deal_id` (the
        // FK from offers → deals), then void commissions by THAT id.
        // Handle nulls gracefully:
        //   • `existing.offer_id` is null → invoice is not linked to an
        //     offer → no commissions to void.
        //   • offer row exists but `offer.deal_id` is null → the offer
        //     was never converted into a deal → no commissions to void.
        try {
          let dealId: string | null = null;
          if (existing.offer_id) {
            const { data: offer, error: offerErr } = await sb
              .from("offers")
              .select("deal_id")
              .eq("id", existing.offer_id)
              .maybeSingle();
            if (offerErr) {
              console.warn("[invoice.cancel] offer lookup failed:", offerErr);
            } else if (offer) {
              dealId = offer.deal_id ?? null;
            }
          }
          if (dealId) {
            const { data: commissions, error: commErr } = await sb
              .from("deal_commissions")
              .select("id, status")
              .eq("tenant_id", tid)
              .eq("deal_id", dealId)
              .eq("status", "approved");
            if (commErr) {
              console.warn("[invoice.cancel] commission lookup failed:", commErr);
            } else if (commissions && commissions.length > 0) {
              for (const c of commissions) {
                await sb.from("deal_commissions")
                  .update({ status: "cancelled", notes: `Voided: invoice ${existing.number} cancelled` })
                  .eq("id", c.id);
              }
            }
          }
        } catch (e) {
          console.warn("[invoice.cancel] commission void failed:", e);
        }
      } catch (e) {
        console.error("[invoice.cancel] reversal cascade failed:", e);
      }
    }

    const auditUser = "user" in auth ? auth.user : { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
    try {
      const { recordRevision } = await import("@/lib/api/doc-revisions");
      await recordRevision({
        docType: "invoice", documentId: id, tenantId: existing.tenant_id,
        before: existing as any, after: updated as any,
        userId: auditUser.id, username: auditUser.username,
        changeNote,
      });
    } catch (e) { console.warn("[invoice.update] revision failed:", e); }
    await audit(auth.store, auditUser, req, "invoice.update", "invoice", id, { status: updated.status });
    return NextResponse.json(updated);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (invoices.delete) — session callers use requirePermission,
  // API-key callers use hasPermission (colon format).
  { const { requirePermission } = await import("@/lib/permissions/can");
    if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "invoices.delete"); if (_d) return _d; } }
  if ("apiKeyId" in auth && !hasPermission(auth.permissions, "invoices:write")) {
    return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
  }
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_finance", _isSA); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const existing = await auth.store.getInvoice(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    // Status guard (H-6) — only draft or cancelled invoices can be
    // hard-deleted. Paid/sent/overdue/partial invoices carry an audit
    // trail and must be voided (status=cancelled) instead.
    if (existing.status && !["draft", "cancelled"].includes(existing.status)) {
      return NextResponse.json(
        { error: `Cannot delete a record in status '${existing.status}'.` },
        { status: 409 },
      );
    }
    await auth.store.deleteInvoice(id);
    const auditUser = "user" in auth ? auth.user : { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
    await audit(auth.store, auditUser, req, "invoice.delete", "invoice", id);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
