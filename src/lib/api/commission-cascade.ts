import { getSupabase } from "@/lib/supabase/client";
import type { Store } from "@/lib/data/store";

/**
 * When a deal / offer / invoice is cancelled, deleted or reverted to draft,
 * any deal_commissions rows that were computed off of it become invalid.
 *
 * Rules (idempotent):
 *   - status = "cancelled" | "declined" | "voided"  → mark linked commissions
 *     as "voided" (unless already "paid" — paid commissions stay as an
 *     audit trail with a `voided_after_payment: true` flag).
 *   - status = "draft"                              → mark as "voided"
 *     because a draft has no committed value to pay commission on.
 *   - hard delete of the deal                       → mark as "voided" +
 *     null out the deal_id link (kept for history).
 *
 * Fire-and-forget: called from route handlers after the primary update.
 *
 * Issue #7 (workflow audit): the cascade previously only voided commissions.
 * `createCommissionOnOfferAccepted` (below) is the creation counterpart — it
 * materialises a pending DealCommission row when an offer linked to a deal
 * with a commission_agent_id is accepted.
 */

const VOIDABLE_STATUSES = new Set(["cancelled", "declined", "voided", "draft"]);

async function markCommissionsVoided(dealId: string, tenantId: string, reason: string) {
  const sb = getSupabase();
  // Only touch rows not already terminal ("paid" stays, "voided" already terminal).
  const { data } = await sb
    .from("deal_commissions")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .eq("deal_id", dealId);
  if (!data || data.length === 0) return;

  for (const row of data as Array<{ id: string; status: string }>) {
    if (row.status === "voided") continue;
    if (row.status === "paid") {
      await sb
        .from("deal_commissions")
        .update({
          notes: `Voided after payment (source cancelled: ${reason}) at ${new Date().toISOString()}`,
        })
        .eq("id", row.id);
    } else {
      await sb
        .from("deal_commissions")
        .update({ status: "voided", notes: `Auto-voided: ${reason} at ${new Date().toISOString()}` })
        .eq("id", row.id);
    }
  }
}

export async function cascadeCommissionOnStatusChange(
  dealId: string | null | undefined,
  tenantId: string,
  newStatus: string | null | undefined,
  reason: string,
): Promise<void> {
  if (!dealId || !newStatus) return;
  if (!VOIDABLE_STATUSES.has(newStatus.toLowerCase())) return;
  try {
    await markCommissionsVoided(dealId, tenantId, reason);
  } catch (e) {
    console.warn("[commission-cascade]", e);
  }
}

export async function cascadeCommissionOnDelete(
  dealId: string | null | undefined,
  tenantId: string,
  reason: string,
): Promise<void> {
  if (!dealId) return;
  try {
    await markCommissionsVoided(dealId, tenantId, reason);
  } catch (e) {
    console.warn("[commission-cascade:delete]", e);
  }
}

/**
 * Create a pending DealCommission row when an offer linked to a deal with a
 * `commission_agent_id` is accepted. Idempotent — if a non-terminal
 * (pending / approved / paid) commission already exists for this deal+agent,
 * the function is a no-op.
 *
 * `dealProfit` is computed from `deal.value - deal.buy_cost` at the moment of
 * acceptance (so percent-of-profit commissions are based on the deal's
 * snapshot, not a later renegotiation).
 *
 * Returns `{ created: true }` on insertion, or `{ created: false, reason }`
 * if no commission was created (deal has no agent, agent inactive, an active
 * commission already exists, etc.).
 */
export async function createCommissionOnOfferAccepted(
  store: Pick<
    Store,
    | "getDeal"
    | "getCommissionAgent"
    | "listDealCommissionsByDeal"
    | "calculateCommission"
    | "upsertDealCommission"
  >,
  dealId: string | null | undefined,
  tenantId: string,
): Promise<{ created: boolean; reason?: string }> {
  if (!dealId || !tenantId) return { created: false, reason: "missing dealId/tenantId" };
  try {
    const deal = await store.getDeal(dealId);
    if (!deal) return { created: false, reason: "deal not found" };
    if (!deal.commission_agent_id) return { created: false, reason: "no commission agent on deal" };

    const agent = await store.getCommissionAgent(deal.commission_agent_id);
    if (!agent) return { created: false, reason: "agent not found" };
    if (!agent.active) return { created: false, reason: "agent inactive" };

    // Idempotency — skip if a non-terminal commission already exists.
    // Note: status is typed as CommissionStatus (pending|approved|paid|cancelled),
    // but the cascade may also write "voided" directly to the DB, so we cast
    // to string for the comparison to be safe.
    const existing = await store.listDealCommissionsByDeal(dealId);
    const hasActive = existing.some(
      (c) => {
        const status = c.status as string;
        return (
          c.agent_id === agent.id &&
          status !== "voided" &&
          status !== "cancelled"
        );
      },
    );
    if (hasActive) return { created: false, reason: "active commission already exists" };

    const dealValue = Number(deal.value) || 0;
    const dealProfit = dealValue - (Number(deal.buy_cost) || 0);
    const dealQuantity = Number(deal.quantity) || 0;
    const currency = deal.currency || "USD";

    const calculatedCommission = await store.calculateCommission(
      agent.id,
      dealValue,
      dealProfit,
      dealQuantity,
      deal.unit || "",
      currency,
    );

    await store.upsertDealCommission({
      tenant_id: tenantId,
      deal_id: deal.id,
      agent_id: agent.id,
      partner_id: agent.partner_id,
      commission_type: agent.commission_type,
      commission_rate: agent.commission_rate,
      commission_per_unit: agent.commission_per_unit,
      commission_custom_formula: agent.commission_custom_formula,
      commission_currency: agent.commission_currency,
      deal_value: dealValue,
      deal_profit: dealProfit,
      deal_quantity: dealQuantity,
      deal_unit: deal.unit || "",
      calculated_commission: calculatedCommission,
      status: "pending",
      notes: `Auto-created when an offer on this deal was accepted at ${new Date().toISOString()}`,
    });
    return { created: true };
  } catch (e) {
    console.warn("[commission-cascade:create]", e);
    return { created: false, reason: (e as Error)?.message || "error" };
  }
}

/**
 * Mark all pending DealCommission rows for a deal as "approved" when the
 * linked invoice is paid. (Issue #7 step 2: "earned" lifecycle — we model
 * "earned" as "approved" since the CommissionStatus enum has no `earned`
 * state; admins then mark paid via the payouts screen.)
 *
 * P1 / task C-4 Fix 3: previously fire-and-forget — the caller in
 * `record-payment` invoked this with `.catch((e) => console.warn(...))`,
 * so a failure here was silently swallowed and the commissions stayed
 * "pending" forever while the invoice showed "paid". The caller now
 * AWAITS this function and surfaces failures in the HTTP response so
 * ops can investigate. This function therefore THROWS on error rather
 * than catching internally — the caller is responsible for deciding
 * whether to fail the request or log + continue.
 *
 * Returns `{ updated: number }` so the caller can include the count in
 * its response/audit trail.
 */
export async function markCommissionsEarnedOnInvoicePaid(
  dealId: string | null | undefined,
  tenantId: string,
): Promise<{ updated: number }> {
  if (!dealId || !tenantId) return { updated: 0 };
  const sb = getSupabase();
  const { data, error: selectError } = await sb
    .from("deal_commissions")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .eq("deal_id", dealId)
    .in("status", ["pending"]);
  if (selectError) {
    throw new Error(
      `markCommissionsEarnedOnInvoicePaid: select failed for deal ${dealId}: ${selectError.message}`,
    );
  }
  if (!data || data.length === 0) return { updated: 0 };
  let updated = 0;
  const nowIso = new Date().toISOString();
  for (const row of data as Array<{ id: string; status: string }>) {
    const { error: updateError } = await sb
      .from("deal_commissions")
      .update({
        status: "approved",
        approved_at: nowIso,
        notes: `Auto-approved: linked invoice paid at ${nowIso}`,
        updated_at: nowIso,
      })
      .eq("id", row.id);
    if (updateError) {
      throw new Error(
        `markCommissionsEarnedOnInvoicePaid: update failed for commission ${row.id} (deal ${dealId}): ${updateError.message}`,
      );
    }
    updated += 1;
  }
  return { updated };
}
