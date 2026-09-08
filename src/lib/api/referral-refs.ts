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
