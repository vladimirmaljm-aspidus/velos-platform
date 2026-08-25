import { NextRequest, NextResponse } from "next/server";
// FIX-ALL-2 / Fix 3 — accept API-key auth on [id] routes so an API-key
// caller fetching /api/offers/<non-existent-id> gets 404 (not 401).
import { requireAuthOrApiKey, hasPermission, resolveTenantId, audit, sanitizeError } from "@/lib/api/helpers";
// FIX-ALL-2 / Fix 1 — strip bank_details from offer responses for API-key callers.
import { redactOfferFields } from "@/lib/api/redact";
// FIX-ALL-2 / Fix 6 — XSS prevention on free-text fields (parity with offers/route.ts POST).
import { sanitizeFields } from "@/lib/security/sanitize-input";
import { validateStatusTransition } from "@/lib/api/status-validator";
import { triggerWebhooks } from "@/lib/webhooks/deliver";
import { notifyOfferUpdate } from "@/lib/realtime/notify";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthOrApiKey(_req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (offers.read) — session callers use requirePermission,
    // API-key callers use hasPermission (colon format).
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "offers.read"); if (_d) return _d; } }
    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "offers:read")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }

    const { id } = await params;
    const item = await auth.store.getOffer(id);
    // FIX-ALL-2 / Fix 3 — not-found returns 404, not 401 (see partners/[id] for full rationale).
    if (!item) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!isSuperAdmin && item.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    // FIX-ALL-2 / Fix 1 — strip bank_details from API-key responses.
    const redactedItem = redactOfferFields(item as any, auth);
    return NextResponse.json(redactedItem);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (offers.update) — session callers use requirePermission,
  // API-key callers use hasPermission (colon format).
  { const { requirePermission } = await import("@/lib/permissions/can");
    if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "offers.update"); if (_d) return _d; } }
  if ("apiKeyId" in auth && !hasPermission(auth.permissions, "offers:write")) {
    return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
  }
  // Feature gate (module_trade)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_trade", _isSA); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const tid = resolveTenantId(auth, req);
    // Tenant ownership check
    const existing = await auth.store.getOffer(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const body = await req.json();
    // FIX-ALL-2 / Fix 6 — XSS prevention on free-text fields (parity with POST).
    const sanitizedBody = sanitizeFields(body, [
      "subject",
      "notes",
      "payment_terms",
      "packaging",
      "vessel",
      "container_no",
      "pol",
      "pod",
      "incoterm",
      "lead_time",
      "delivery_terms",
      "valid_until_note",
      "shipping_terms",
    ]);
    if (Array.isArray(sanitizedBody.items)) {
      sanitizedBody.items = sanitizedBody.items.map((it: any) => sanitizeFields(it, [
        "description", "detailed_spec", "brand", "sku", "hs_code",
        "origin_country", "notes", "subject", "unit",
      ]));
    }
    // Preserve the entity's tenant_id
    sanitizedBody.tenant_id = existing.tenant_id;
    // CRITICAL FIX (audit F-2): lock financial fields on accepted offers.
    // A user with offers.update permission should NOT be able to change total,
    // items, partner_id, or currency on an offer the customer has already
    // accepted — that would silently rewrite a binding commercial commitment.
    if (existing.status === "accepted") {
      if (!isSuperAdmin) {
        const lockedFields = ["total", "subtotal", "items", "tax_total", "discount_total", "partner_id", "currency", "offer_id"];
        for (const k of lockedFields) {
          if (k in sanitizedBody) {
            return NextResponse.json(
              { error: `Cannot modify ${k} on an accepted offer. Super-admin override required.` },
              { status: 409 },
            );
          }
        }
      }
    }
    // FIX-MED-1 / Fix 2 — server-side expiry check on accept. A user could
    // accept an offer whose `valid_until` has passed (the status-validator
    // only checks the transition graph, not the date). Block it here at
    // the server: when the request transitions the offer TO "accepted"
    // (case-insensitive) and `existing.valid_until` is in the past, refuse
    // with 400. Super-admins bypass so they can correct legacy data.
    //
    // The check uses the EXISTING offer's valid_until (not the body's) —
    // a caller cannot extend the deadline by sending a new valid_until in
    // the same PUT that accepts the offer, because `valid_until` is not
    // in the locked-fields list above and would otherwise be writable.
    // (Even if it were, evaluating against the existing snapshot is the
    // correct semantic: "the offer as the customer saw it has expired".)
    const targetStatusNorm = String(sanitizedBody.status || "").toLowerCase();
    const isAccepting = targetStatusNorm === "accepted"
      && String(existing.status || "").toLowerCase() !== "accepted";
    if (isAccepting && !isSuperAdmin
        && existing.valid_until
        && new Date(existing.valid_until).getTime() < Date.now()) {
      return NextResponse.json(
        { error: "Cannot accept an expired offer." },
        { status: 400 },
      );
    }
    // FIX-P1-LOGIC Fix 1: enforce valid status transitions. Super-admins
    // bypass so they can correct bad data.
    if (sanitizedBody.status && sanitizedBody.status !== existing.status && !isSuperAdmin) {
      const transition = validateStatusTransition("offer", existing.status, sanitizedBody.status);
      if (!transition.valid) {
        return NextResponse.json({ error: transition.error }, { status: 400 });
      }
    }
    // Always recompute totals from items when items are provided — never trust
    // client-supplied totals (FLOW-7: previously skipped when body.total was
    // present, allowing tampered totals to disagree with line items).
    if (Array.isArray(sanitizedBody.items) && sanitizedBody.items.length > 0) {
      let subtotal = 0, discountTotal = 0, taxTotal = 0;
      for (const it of sanitizedBody.items) {
        // CRITICAL FIX (audit P2-15): coerce line item fields with Number() to
        // prevent NaN propagation when the client sends strings (e.g. "10"
        // instead of 10) or omits fields. Previously `it.quantity * it.unit_price`
        // would yield NaN if either was a string, silently zeroing the line.
        const line = (Number(it.quantity) || 0) * (Number(it.unit_price) || 0);
        const disc = line * (Number(it.discount) || 0) / 100;
        const net = line - disc;
        const tax = net * (Number(it.tax_rate) || 0) / 100;
        subtotal += line;
        discountTotal += disc;
        taxTotal += tax;
        it.total = Math.round((net + tax) * 100) / 100;
      }
      sanitizedBody.subtotal = Math.round(subtotal * 100) / 100;
      sanitizedBody.discount_total = Math.round(discountTotal * 100) / 100;
      sanitizedBody.tax_total = Math.round(taxTotal * 100) / 100;
      sanitizedBody.total = Math.round((subtotal - discountTotal + taxTotal) * 100) / 100;
    }
    const updated = await auth.store.upsertOffer({ ...sanitizedBody, id });
    // FIX-ALL-2 / Fix 3 — audit identity for API-key callers.
    const auditUser = "user" in auth ? auth.user : { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
    // Record revision with per-field diff so we always know WHO changed WHAT.
    try {
      const { recordRevision } = await import("@/lib/api/doc-revisions");
      await recordRevision({
        docType: "offer", documentId: id, tenantId: existing.tenant_id,
        before: existing as any, after: updated as any,
        userId: auditUser.id, username: auditUser.username,
        changeNote: (sanitizedBody as any)?._changeNote || null,
      });
    } catch (e) { console.warn("[offer.update] revision failed:", e); }
    // If this update transitioned the offer to a cancelling status, void
    // any commissions computed from its deal.
    if ((updated as any).deal_id && updated.status !== existing.status) {
      const { cascadeCommissionOnStatusChange, createCommissionOnOfferAccepted } = await import("@/lib/api/commission-cascade");
      cascadeCommissionOnStatusChange((updated as any).deal_id, existing.tenant_id, updated.status, `offer ${id} status→${updated.status}`).catch(() => {});
      // Issue #7: when an offer transitions to "accepted", auto-create a
      // pending DealCommission row for the linked deal's commission agent
      // (if the deal has one and no active commission already exists).
      if (updated.status.toLowerCase() === "accepted") {
        createCommissionOnOfferAccepted(auth.store, (updated as any).deal_id, existing.tenant_id)
          .then((res) => {
            if (res.created) {
              console.info(`[offer.update] auto-created commission for deal ${(updated as any).deal_id}`);
            }
          })
          .catch(() => {});
      }
    }
    // ── Inventory movement on offer acceptance ───────────────────────────
    // When the offer transitions to "accepted", decrement stock for each line
    // item and log a stock-out `inventory_movements` row so the audit trail
    // reflects *why* the stock changed.
    //
    // Re-Audit-2 N6/N7/N8: extracted into a shared helper
    // (`deductStockForOffer` / `restoreStockForOffer` in
    // `lib/api/inventory-cascade.ts`) so the portal-respond route can call
    // the same code, and so the helper enforces:
    //   • Idempotency — skip if a movement already exists for the offer id
    //     (prevents double-deduction on super-admin re-accept or concurrent
    //     calls). [N7]
    //   • Stock restoration — when the offer transitions OUT of "accepted"
    //     (e.g. cancelled), `restoreStockForOffer` inserts a positive-delta
    //     movement row reversing the deduction. [N8]
    //   • notifyLowStock — fires a low-stock notification when the new stock
    //     is at/below reorder_level. [LOGIC §8.3]
    const newStatusNorm = String(sanitizedBody.status || "").toLowerCase();
    const oldStatusNorm = String(existing.status || "").toLowerCase();
    if (newStatusNorm === "accepted" && oldStatusNorm !== "accepted") {
      try {
        const { deductStockForOffer } = await import("@/lib/api/inventory-cascade");
        const items = Array.isArray((updated as any).items) ? (updated as any).items : [];
        await deductStockForOffer({
          tenantId: existing.tenant_id,
          offerId: String(updated.id || id),
          offerNumber: (updated as any).number || null,
          partnerId: (updated as any).partner_id || existing.partner_id || null,
          items,
          source: "admin",
        });
      } catch (e) {
        console.error("[offers] inventory movement failed:", e);
      }
    } else if (
      oldStatusNorm === "accepted" &&
      newStatusNorm &&
      newStatusNorm !== "accepted" &&
      sanitizedBody.status // explicit status change requested
    ) {
      // Offer transitioning OUT of accepted (e.g. → cancelled). Restore stock.
      try {
        const { restoreStockForOffer } = await import("@/lib/api/inventory-cascade");
        const items = Array.isArray((updated as any).items) ? (updated as any).items : [];
        await restoreStockForOffer({
          tenantId: existing.tenant_id,
          offerId: String(updated.id || id),
          offerNumber: (updated as any).number || null,
          partnerId: (updated as any).partner_id || existing.partner_id || null,
          items,
          reason: `Status changed ${oldStatusNorm} → ${newStatusNorm} by admin`,
        });
      } catch (e) {
        console.error("[offers] inventory restore failed:", e);
      }
    }
    await audit(auth.store, auditUser, req, "offer.update", "offer", id, { status: updated.status });

    // ── F-4: fire outbound webhooks (offer.updated) ────────────────────────
    // Fire-and-forget — webhook delivery failures must NEVER block the offer
    // mutation. We pass the AFTER snapshot so receivers get the new state.
    void triggerWebhooks(
      auth.store,
      existing.tenant_id,
      "offer.updated",
      "offer",
      id,
      updated as unknown as Record<string, unknown>,
    ).catch((e) => console.error("[offers.put] webhook trigger failed:", e));

    // ── D-4: real-time push to tenant admins ───────────────────────────────
    // Only emit when the status actually changed — a pure line-item edit
    // (e.g. typos, qty tweak) doesn't warrant a bell-badge ping. The push is
    // fire-and-forget so a gateway outage doesn't block the response.
    if (updated.status !== existing.status) {
      void notifyOfferUpdate(existing.tenant_id, {
        offerId: id,
        offerNumber: (updated as any).number || null,
        oldStatus: existing.status,
        newStatus: updated.status,
        partnerId: (updated as any).partner_id || existing.partner_id || null,
        total: (updated as any).total ?? null,
      });
    }

    // FIX-ALL-2 / Fix 1 — strip bank_details from API-key responses (parity with GET).
    const redactedUpdated = redactOfferFields(updated as any, auth);
    return NextResponse.json(redactedUpdated);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (offers.delete) — session callers use requirePermission,
  // API-key callers use hasPermission (colon format).
  { const { requirePermission } = await import("@/lib/permissions/can");
    if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "offers.delete"); if (_d) return _d; } }
  if ("apiKeyId" in auth && !hasPermission(auth.permissions, "offers:write")) {
    return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
  }
  // Feature gate (module_trade)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_trade", _isSA); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const existing = await auth.store.getOffer(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    // Status guard (H-6) — only draft/cancelled/rejected offers can be
    // hard-deleted. Accepted/sent offers carry an audit trail.
    if (existing.status && !["draft", "cancelled", "rejected"].includes(existing.status)) {
      return NextResponse.json(
        { error: `Cannot delete a record in status '${existing.status}'.` },
        { status: 409 },
      );
    }
    // FIX-P1: dependency check (O-2, PT-1, PR-1) — refuse delete when linked
    // proformas or invoices exist. Cancel the offer instead.
    try {
      const { getSupabase } = await import("@/lib/supabase/client");
      const sb = getSupabase();
      const { data: linkedProformas } = await sb
        .from("proformas").select("id").eq("offer_id", id).neq("status", "cancelled").limit(1).maybeSingle();
      const { data: linkedInvoices } = await sb
        .from("invoices").select("id").eq("offer_id", id).neq("status", "cancelled").limit(1).maybeSingle();
      if (linkedProformas || linkedInvoices) {
        return NextResponse.json(
          { error: "Cannot delete offer — linked proformas or invoices exist. Cancel the offer instead." },
          { status: 409 },
        );
      }
    } catch (depErr) {
      console.warn("[offers DELETE] dependency check failed:", depErr);
    }
    // Void commissions tied to this offer's deal before we hard-delete.
    if ((existing as any).deal_id) {
      const { cascadeCommissionOnDelete } = await import("@/lib/api/commission-cascade");
      await cascadeCommissionOnDelete((existing as any).deal_id, existing.tenant_id, `offer ${id} deleted`);
    }
    await auth.store.deleteOffer(id);
    const auditUser = "user" in auth ? auth.user : { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
    await audit(auth.store, auditUser, req, "offer.delete", "offer", id);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
