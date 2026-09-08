import { NextResponse } from "next/server";
import type { Store } from "@/lib/data/store";

/**
 * Cross-entity reference validation for referral commissions (097).
 * A commission entry may link an existing deal / offer / invoice /
 * proforma / LOI / RFQ for traceability — this helper asserts the entity
 * EXISTS and belongs to the caller's tenant, so a row from another tenant
 * can never be attached (cross-tenant IDOR via ref_id).
 */

type StoreLike = Pick<Store,
  | "getDeal" | "getOffer" | "getInvoice" | "getProforma" | "getLoi" | "getPortalRfq"
>;

// ─── 46-b: live linked-entity resolution ───────────────────────────────────
//
// The admin detail sheet shows a "Linked business" card with LIVE data from
// the referenced record (title/number, current status, partner name, value,
// currency, date) — so the admin sees what the commission is actually tied
// to TODAY, not the stale snapshot typed at creation time. The resolver
// lives here next to assertRefEntity (both speak the same (ref_type,
// ref_id) contract); assertRefEntity itself stays untouched.

/** Store surface needed to resolve a linked entity + its partner name. */
export type RefResolverStoreLike = Pick<Store,
  | "getDeal" | "getOffer" | "getInvoice" | "getProforma" | "getLoi" | "getPortalRfq" | "getPartner"
>;

/** The live business card for a referral commission's linked record. */
export interface ReferralLinkedEntity {
  kind: "deal" | "offer" | "invoice" | "proforma" | "loi" | "rfq";
  /** Title (deal) or document number (everything else). */
  label: string;
  /** Current status/stage, as the source record reports it today. */
  status: string | null;
  /** Resolved partner/client name via store.getPartner. */
  partner_name: string | null;
  /** Live deal/doc value, when the record carries one. */
  value: number | null;
  currency: string | null;
  /** Business date (expected_close / created / issue / validity). */
  date: string | null;
}

/** Best-effort partner name — never throws, degrades to null. */
async function refPartnerName(store: RefResolverStoreLike, partnerId: string | null | undefined): Promise<string | null> {
  if (!partnerId) return null;
  try {
    const p = await store.getPartner(partnerId);
    return p?.name || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the LIVE entity behind a referral commission's (ref_type, ref_id)
 * link. Returns null whenever there is nothing to resolve (manual entry, no
 * ref_id), the record vanished, lives in another tenant, or any store
 * getter throws — the caller (GET [id]) must never 500 because an optional
 * linked record is unreadable.
 */
export async function resolveReferralLinkedEntity(
  store: RefResolverStoreLike,
  tenantId: string,
  entry: { ref_type: string; ref_id: string | null },
): Promise<ReferralLinkedEntity | null> {
  if (!entry.ref_id || entry.ref_type === "manual") return null;
  try {
    switch (entry.ref_type) {
      case "deal": {
        const d = await store.getDeal(entry.ref_id);
        if (!d || d.tenant_id !== tenantId) return null;
        return {
          kind: "deal", label: d.title, status: d.stage,
          partner_name: await refPartnerName(store, d.partner_id),
          value: d.value ?? null, currency: d.currency || null, date: d.expected_close || null,
        };
      }
      case "offer": {
        const o = await store.getOffer(entry.ref_id);
        if (!o || o.tenant_id !== tenantId) return null;
        // Offer.total is authoritative; sum the line items when a legacy
        // row carries a null/undefined total.
        const total = typeof o.total === "number"
          ? o.total
          : (o.items || []).reduce((s, it) => s + (Number(it.total) || 0), 0);
        return {
          kind: "offer", label: o.number, status: o.status,
          partner_name: await refPartnerName(store, o.partner_id),
          value: total, currency: o.currency || null, date: o.created_at || null,
        };
      }
      case "invoice": {
        const i = await store.getInvoice(entry.ref_id);
        if (!i || i.tenant_id !== tenantId) return null;
        return {
          kind: "invoice", label: i.number, status: i.status,
          partner_name: await refPartnerName(store, i.partner_id),
          value: i.total ?? null, currency: i.currency || null, date: i.issue_date || i.created_at || null,
        };
      }
      case "proforma": {
        const p = await store.getProforma(entry.ref_id);
        if (!p || p.tenant_id !== tenantId) return null;
        return {
          kind: "proforma", label: p.number, status: p.status,
          partner_name: await refPartnerName(store, p.partner_id),
          value: p.total ?? null, currency: p.currency || null, date: p.issue_date || p.created_at || null,
        };
      }
      case "loi": {
        const l = await store.getLoi(entry.ref_id);
        if (!l || l.tenant_id !== tenantId) return null;
        return {
          kind: "loi", label: l.number, status: l.status,
          partner_name: await refPartnerName(store, l.partner_id),
          value: l.total_value ?? null, currency: l.currency || null, date: l.validity_until || l.created_at || null,
        };
      }
      case "rfq": {
        const r = await store.getPortalRfq(entry.ref_id);
        if (!r || r.tenant_id !== tenantId) return null;
        return {
          kind: "rfq", label: r.number || r.product_name, status: r.status,
          partner_name: await refPartnerName(store, r.partner_id),
          value: r.target_price ?? null, currency: r.currency || null, date: r.created_at || null,
        };
      }
      default:
        return null;
    }
  } catch {
    // Optional linked record unreadable — degrade to "not linked" rather
    // than failing the whole commission detail.
    return null;
  }
}

/** Returns a NextResponse (404) when the entity is missing or cross-tenant, else null. */
export async function assertRefEntity(
  store: StoreLike,
  tenantId: string,
  refType: string,
  refId: string,
): Promise<NextResponse | null> {
  const fail = () =>
    NextResponse.json({ error: `The referenced ${refType} does not exist in this tenant.` }, { status: 404 });

  try {
    switch (refType) {
      case "deal": {
        const row = await store.getDeal(refId);
        if (!row || row.tenant_id !== tenantId) return fail();
        return null;
      }
      case "offer": {
        const row = await store.getOffer(refId);
        if (!row || row.tenant_id !== tenantId) return fail();
        return null;
      }
      case "invoice": {
        const row = await store.getInvoice(refId);
        if (!row || row.tenant_id !== tenantId) return fail();
        return null;
      }
      case "proforma": {
        const row = await store.getProforma(refId);
        if (!row || row.tenant_id !== tenantId) return fail();
        return null;
      }
      case "loi": {
        const row = await store.getLoi(refId);
        if (!row || row.tenant_id !== tenantId) return fail();
        return null;
      }
      case "rfq": {
        const row = await store.getPortalRfq(refId);
        if (!row || row.tenant_id !== tenantId) return fail();
        return null;
      }
      default:
        return NextResponse.json({ error: "Invalid ref_type." }, { status: 400 });
    }
  } catch {
    // Store methods for an optional table may degrade — treat as not found.
    return fail();
  }
}
