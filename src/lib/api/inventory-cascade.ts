import { getSupabase } from "@/lib/supabase/client";
import { notifyLowStock } from "@/lib/notif/helper";

/**
 * Inventory cascade helpers — shared between admin and portal paths so the
 * behaviour is consistent (Re-Audit-2 N6: previously only the admin PUT
 * path in `offers/[id]/route.ts` decremented stock; portal-accepted offers
 * skipped the cascade entirely).
 *
 * Two public helpers:
 *
 *   1. `deductStockForOffer(opts)` — called when an offer transitions to
 *      "accepted" (admin PUT or portal respond). Decrements `products.stock`
 *      for each line item and inserts an `inventory_movements` audit row.
 *      Idempotent: skipped per-line-item if a NET deduction already exists
 *      for that (offerId, productId) pair — see audit O-1 note below.
 *
 *   2. `restoreStockForOffer(opts)` — called when an offer transitions OUT of
 *      "accepted" (e.g. cancelled). Reverses the deduction by inserting a
 *      positive-delta movement row. Idempotent: skipped if no prior deduction
 *      exists for the offer id (Re-Audit-2 N8: previously no restoration fired
 *      at all).
 *
 * Both helpers are fire-and-forget — callers wrap them in try/catch and log
 * failures; they don't block the primary update.
 *
 * ── Audit O-1 (idempotency for accept → cancel → re-accept) ───────────────
 * The old idempotency check at the top of `deductStockForOffer` filtered
 * `reference = offerId AND delta < 0` and skipped the WHOLE cascade if any
 * prior deduction row existed. After accept → cancel (restore) → re-accept,
 * the original deduction movement (negative delta) still exists — so the
 * second acceptance was skipped entirely, leaving stock un-deducted.
 *
 * The new per-line-item check counts BOTH deductions (delta < 0) AND
 * restorations (delta > 0) for the (offerId, productId) pair, and only
 * skips if `deductions > restorations` — i.e. there is a NET deduction
 * still on the books for that product on that offer.
 */

interface DeductStockOpts {
  tenantId: string;
  offerId: string;
  offerNumber?: string | null;
  partnerId?: string | null;
  items: Array<{
    product_id?: string | null;
    quantity?: number | string | null;
  }>;
  /** Optional label suffix for the inventory_movements.reason column. */
  reasonSuffix?: string;
  /** "admin" | "portal" — used to differentiate the audit reason. */
  source?: "admin" | "portal";
}

/**
 * Decrements stock for each line item of an accepted offer.
 * Returns the list of (productId, newStock) pairs updated — useful for the
 * caller to fire `notifyLowStock` for each product that fell below reorder.
 *
 * ── ATOMICITY (audit 2d2-F1 + 2d2-F5) ──────────────────────────────────
 * Previously this function did a non-atomic 4-step read-modify-write
 * per line item (SELECT products → SELECT inventory_movements → INSERT
 * movement → UPDATE products.stock) across FOUR separate PostgREST
 * calls. Two concurrent offer-acceptances on the SAME product (different
 * offers — F1) both read stock=10, both wrote stock=5 → 5 units silently
 * oversold. Two concurrent acceptances on the SAME offer+product (F5
 * TOCTOU) both saw an empty inventory_movements row set and both
 * inserted a -5 movement → stock decremented twice.
 *
 * Now each line item delegates to the `deduct_product_stock` SECURITY
 * DEFINER RPC (migration 070), which performs all four steps inside ONE
 * Postgres transaction with SELECT FOR UPDATE on the products row. The
 * row lock serialises concurrent callers on the same product; the
 * idempotency SELECT inside the same tx sees any concurrent caller's
 * committed write. The JS loop over line items is preserved — but each
 * iteration is now atomic, and cross-product calls remain independent.
 *
 * Falls back to the legacy non-atomic JS path ONLY if the RPC is
 * unavailable (migration not applied). A warning is logged so ops
 * know the atomicity guarantee is degraded.
 */
export async function deductStockForOffer(opts: DeductStockOpts): Promise<
  Array<{ productId: string; newStock: number; productName: string; sku: string; reorderLevel: number }>
> {
  const sb = getSupabase();
  const tenantId = opts.tenantId;
  const offerId = String(opts.offerId);
  const offerNumber = opts.offerNumber ? String(opts.offerNumber) : offerId;
  const sourceLabel = opts.source === "portal" ? "portal client" : "admin";
  const updatedProducts: Array<{
    productId: string; newStock: number; productName: string; sku: string; reorderLevel: number;
  }> = [];

  // Probe once whether the atomic RPC is available (migration 070 applied).
  // On first call we attempt a no-op probe; if it fails we set a flag and
  // fall back to the legacy path for the rest of this invocation.
  let rpcAvailable = true;

  for (const item of opts.items) {
    const productId = item?.product_id;
    if (!productId) continue;
    const qty = Math.abs(Number(item.quantity) || 0);
    if (qty <= 0) continue;

    if (rpcAvailable) {
      try {
        // ATOMIC PATH — delegate to the SECURITY DEFINER RPC (migration 070).
        // The RPC: SELECT ... FOR UPDATE on products → idempotency check →
        // INSERT movement → UPDATE products.stock, all in one tx.
        const { data: rpcResult, error: rpcErr } = await sb.rpc("deduct_product_stock", {
          p_product_id: productId,
          p_quantity: qty,
          p_tenant_id: tenantId,
          p_offer_id: offerId,
          p_partner_id: opts.partnerId || null,
          p_offer_number: offerNumber,
          p_source_label: sourceLabel,
          p_reason_suffix: opts.reasonSuffix || null,
        });
        if (rpcErr) {
          // PSQL error 42883 = function does not exist → migration not
          // applied yet. Fall back to the legacy non-atomic path for the
          // rest of this invocation (and log prominently so ops notice).
          if (String(rpcErr.code) === "42883" || /could not find|does not exist/i.test(rpcErr.message)) {
            console.warn(
              "[inventory cascade] deduct_product_stock RPC not available — falling back to non-atomic path. Apply migration 070 to close 2d2-F1 + 2d2-F5.",
            );
            rpcAvailable = false;
          } else {
            console.error(
              `[inventory cascade] deduct_product_stock RPC failed for ${productId}:`,
              rpcErr.message,
            );
            continue;
          }
        } else if (rpcResult) {
          const r = rpcResult as {
            deducted?: boolean;
            reason?: string;
            new_stock?: number | string;
            actual_deducted?: number | string;
            product_name?: string;
            sku?: string;
            reorder_level?: number | string;
          };
          if (r.deducted) {
            updatedProducts.push({
              productId,
              newStock: Number(r.new_stock ?? 0),
              productName: r.product_name || "(unnamed)",
              sku: r.sku || "",
              reorderLevel: Number(r.reorder_level ?? 0),
            });
          } else if (r.reason === "product_not_found") {
            console.warn(`[inventory cascade] product ${productId} not found, skipping stock decrement`);
          } else if (r.reason === "already_deducted") {
            console.log(
              `[inventory cascade] net deduction already exists for offer ${offerId} / product ${productId}, skipping`,
            );
          } else if (r.reason === "non_positive_quantity") {
            // skip silently
          }
          // Either way the RPC handled this item — continue to the next.
          continue;
        }
      } catch (e: any) {
        console.error(`[inventory cascade] deduct_product_stock RPC threw for ${productId}:`, e);
        // Don't give up on the RPC entirely for a single throw — but if
        // it's the "function does not exist" class, fall back.
        if (/could not find|does not exist/i.test(String(e?.message || ""))) {
          rpcAvailable = false;
        }
      }
    }

    // ── LEGACY NON-ATOMIC PATH (fallback when the RPC is unavailable) ──
    // Kept for backward compatibility with environments where migration
    // 070 has not yet been applied. The atomic RPC is the canonical path.
    //
    // 1) Fetch current stock + reorder_level + name (for the notifyLowStock
    //    notification that fires after the deduction). Fetched BEFORE the
    //    movement insert so we can record the ACTUAL deducted amount.
    const { data: productRow, error: prodErr } = await sb
      .from("products")
      .select("id, name, sku, stock, reorder_level, unit")
      .eq("id", productId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (prodErr) {
      console.error(`[inventory cascade] product fetch failed for ${productId}:`, prodErr.message);
      continue;
    }
    if (!productRow) {
      // Product may have been deleted between offer save and accept — log + skip.
      console.warn(`[inventory cascade] product ${productId} not found, skipping stock decrement`);
      continue;
    }

    // ── Idempotency check (audit O-1) ────────────────────────────────────
    // CRITICAL FIX (audit O-1): only skip if there are MORE deductions than
    // restorations for this (offer, product) pair. After accept → cancel →
    // re-accept, the original deduction (negative delta) still exists, but so
    // does the restoration (positive delta). We should only skip if the net
    // is negative — i.e. stock is already short for this product on this
    // offer. A net of zero (1 deduction + 1 restoration) means the previous
    // acceptance was fully reversed and we SHOULD re-deduct on re-accept.
    //
    // This also preserves the original Re-Audit-2 N7 guarantee: a double-call
    // (e.g. super-admin re-accepts an already-accepted offer, or a concurrent
    // admin + portal accept) sees deductions > restorations and skips.
    const { data: priorMovements, error: priorErr } = await sb
      .from("inventory_movements")
      .select("delta")
      .eq("tenant_id", tenantId)
      .eq("reference", offerId)
      .eq("product_id", productId);
    if (priorErr) {
      console.warn(`[inventory cascade] idempotency lookup failed for product ${productId}:`, priorErr.message);
      // Bail out for THIS item — we can't safely proceed without the
      // idempotency guarantee. Other items in the loop still get processed.
      continue;
    }
    const deductions = priorMovements?.filter((m: any) => Number(m.delta) < 0).length || 0;
    const restorations = priorMovements?.filter((m: any) => Number(m.delta) > 0).length || 0;
    if (deductions > restorations) {
      console.log(
        `[inventory cascade] net deduction already exists for offer ${offerId} / product ${productId} (deductions=${deductions}, restorations=${restorations}), skipping`,
      );
      continue;
    }

    const currentStock = Number((productRow as any).stock ?? 0) || 0;
    const reorderLevel = Number((productRow as any).reorder_level ?? 0) || 0;
    // CRITICAL FIX (audit P2-13): record actual deducted amount, not requested qty.
    // If stock < qty, only 'currentStock' units are actually removed.
    // Previously the movement recorded delta: -qty (full requested qty) while
    // `products.stock` was clamped via Math.max(0, currentStock - qty) — so a
    // restore (which reads the movement delta) would re-add the full qty,
    // creating phantom stock (e.g. stock=10, qty=15 → movement says -15,
    // restore adds +15 → final stock 15 instead of 10).
    const actualDeducted = Math.min(qty, currentStock);
    const newStock = Math.max(0, currentStock - qty);

    // 2) Log the movement (delta negative = stock out). Records the ACTUAL
    //    units removed so restoreStockForOffer can reverse it correctly.
    const { error: moveErr } = await sb.from("inventory_movements").insert({
      tenant_id: tenantId,
      product_id: productId,
      partner_id: opts.partnerId || null,
      delta: -actualDeducted,
      reason: `Offer ${offerNumber} accepted by ${sourceLabel}${opts.reasonSuffix ? " — " + opts.reasonSuffix : ""}`,
      reference: offerId,
    });
    if (moveErr) {
      console.error(`[inventory cascade] movement insert failed for product ${productId}:`, moveErr.message);
      continue;
    }

    // 3) Update product stock (clamped to 0).
    const { error: updErr } = await sb
      .from("products")
      .update({ stock: newStock, updated_at: new Date().toISOString() })
      .eq("id", productId)
      .eq("tenant_id", tenantId);
    if (updErr) {
      console.error(`[inventory cascade] product update failed for ${productId}:`, updErr.message);
      continue;
    }

    updatedProducts.push({
      productId,
      newStock,
      productName: (productRow as any).name || "(unnamed)",
      sku: (productRow as any).sku || "",
      reorderLevel,
    });
  }

  // ── Fire low-stock notifications for any product that crossed the reorder level ──
  // (Re-Audit-2 LOGIC §8.3: notifyLowStock was defined but never called from
  // any route. We fire it here, after the deduction, when stock falls at or
  // below the reorder_level.)
  for (const p of updatedProducts) {
    if (p.newStock <= p.reorderLevel) {
      try {
        await notifyLowStock(
          tenantId,
          p.productName,
          p.sku,
          p.newStock,
          p.reorderLevel,
          p.productId,
        );
      } catch (e) {
        console.error(`[inventory cascade] notifyLowStock failed for ${p.productId}:`, e);
      }
    }
  }

  return updatedProducts;
}

interface RestoreStockOpts {
  tenantId: string;
  offerId: string;
  offerNumber?: string | null;
  partnerId?: string | null;
  items: Array<{
    product_id?: string | null;
    quantity?: number | string | null;
  }>;
  /** Reason for the restoration (e.g. "Offer cancelled by admin"). */
  reason: string;
}

/**
 * Reverses a prior deduction by inserting a positive-delta movement row for
 * each line item and incrementing `products.stock`. Idempotent: skipped if
 * no prior deduction exists for the offer id (Re-Audit-2 N8).
 *
 * Note: this does NOT delete the original deduction row — both rows stay in
 * the audit trail so the books reconcile (movement out + movement back in).
 */
export async function restoreStockForOffer(opts: RestoreStockOpts): Promise<void> {
  const sb = getSupabase();
  const tenantId = opts.tenantId;
  const offerId = String(opts.offerId);

  // Idempotency check: if no deduction exists for this offer id, there's
  // nothing to restore.
  const { data: priorDeductions, error: lookupErr } = await sb
    .from("inventory_movements")
    .select("id, delta")
    .eq("tenant_id", tenantId)
    .eq("reference", offerId)
    .lt("delta", 0); // only count prior deductions (negative deltas)
  if (lookupErr) {
    console.warn("[inventory restore] lookup failed:", lookupErr.message);
    return;
  }
  if (!priorDeductions || priorDeductions.length === 0) {
    console.log(`[inventory restore] no prior deduction for offer ${offerId}, skipping`);
    return;
  }

  // AUDIT17 / F12 — per-(offer, product) NET idempotency. The previous
  // global check ("any positive movement exists → skip everything") broke
  // the supported re-accept cycle: accept (deduct) → cancel (restore) →
  // re-accept (deduct) → cancel — the second cancel saw the FIRST
  // restoration and skipped, permanently losing stock. Mirroring the
  // deduct side's net semantics: a (offer, product) pair is restored iff
  // its restorations are fewer than its deductions.
  const { data: movementPairs } = await sb
    .from("inventory_movements")
    .select("product_id, delta")
    .eq("tenant_id", tenantId)
    .eq("reference", offerId);
  const netByProduct = new Map<string, number>(); // deductions - restorations
  for (const mv of movementPairs || []) {
    const pid = (mv as any).product_id as string;
    if (!pid) continue;
    const d = Number((mv as any).delta) || 0;
    netByProduct.set(pid, (netByProduct.get(pid) || 0) + (d < 0 ? Math.abs(d) : -d));
  }
  // Products with a positive outstanding deduction balance need restoring.
  const restorable = new Set(
    [...netByProduct.entries()].filter(([, net]) => net > 0.000001).map(([pid]) => pid),
  );
  if (restorable.size === 0) {
    console.log(`[inventory restore] no outstanding deduction for offer ${offerId}, skipping`);
    return;
  }

  for (const item of opts.items) {
    const productId = item?.product_id;
    if (!productId) continue;
    if (!restorable.has(productId)) continue; // AUDIT17 / F12 — net-zero pair
    const qty = Math.abs(Number(item.quantity) || 0);
    if (qty <= 0) continue;

    // 1) Log the restoration movement (delta positive = stock in).
    const { error: moveErr } = await sb.from("inventory_movements").insert({
      tenant_id: tenantId,
      product_id: productId,
      partner_id: opts.partnerId || null,
      delta: qty,
      reason: `Offer ${opts.offerNumber || offerId} cancelled — ${opts.reason}`,
      reference: offerId,
    });
    if (moveErr) {
      console.error(`[inventory restore] movement insert failed for product ${productId}:`, moveErr.message);
      continue;
    }

    // 2) Fetch current stock.
    const { data: productRow } = await sb
      .from("products")
      .select("id, stock")
      .eq("id", productId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!productRow) continue;

    // CRITICAL FIX (audit C-4): restore only the ACTUAL amount that was
    // deducted, not the requested `qty`. `deductStockForOffer` caps stock
    // at 0 via `Math.max(0, currentStock - qty)`, so if stock was 10 and
    // qty was 15, only 10 units were actually removed from `products.stock`
    // (the movement row still records delta = -15). Naively restoring
    // `+qty` (15) would create 5 phantom units.
    //
    // We read the delta from the prior deduction movement (matched by
    // tenant + reference + product_id + delta < 0). The movement delta
    // matches the *requested* qty in the current implementation, so this
    // fix is forward-compatible: if `deductStockForOffer` is later changed
    // to record `actual_delta` (clamped to currentStock), the restore will
    // automatically pick up the correct value without further changes.
    // Falls back to `qty` only if the movement row can't be found (defensive).
    // AUDIT17 / F12 — restore the outstanding NET deduction for this
    // (offer, product) pair (deductions minus prior restorations). After a
    // re-accept the net is the second deduction only — restoring the gross
    // would over-credit stock.
    const actualDeducted = netByProduct.get(productId) || qty;
    const currentStock = Number((productRow as any).stock ?? 0) || 0;
    const newStock = currentStock + actualDeducted;
    const { error: updErr } = await sb
      .from("products")
      .update({ stock: newStock, updated_at: new Date().toISOString() })
      .eq("id", productId)
      .eq("tenant_id", tenantId);
    if (updErr) {
      console.error(`[inventory restore] product update failed for ${productId}:`, updErr.message);
    }
  }
}
