import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import {
  getInstrumentIfAuthorised,
  sanitisePublicInstrument,
  updateInstrument,
  updateInstrumentStatus,
} from "@/lib/data/marketplace-finance-store";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";
import type {
  InstrumentStatus,
  EscrowReleaseCondition,
} from "@/lib/supabase/marketplace-finance-types";

export const runtime = "nodejs";

const VALID_STATUSES: InstrumentStatus[] = [
  "draft", "submitted", "approved", "active",
  "completed", "rejected", "disputed", "released", "refunded",
];
const VALID_ESCROW_CONDITIONS: EscrowReleaseCondition[] = [
  "delivery_confirmation", "inspection_pass",
  "both_parties_confirm", "manual",
];

// GET /api/marketplace/finance/[id] — fetch an instrument + its milestones.
// Auth: owning partner, counterparty, post owner, or negotiation party
// (see store). Owning partner sees the full row; others get the sanitised
// shape (partner_id stripped).
async function _get(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const auth = await getInstrumentIfAuthorised(id, access.tenant_id, access.partner_id);
    if (!auth) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const instrumentShape = auth.is_owner
      ? (auth.instrument as unknown as Record<string, unknown>)
      : sanitisePublicInstrument(auth.instrument);

    // Fetch the milestones (one extra round-trip — kept separate from the
    // auth check so the auth check stays simple). Empty for non-schedule
    // instruments.
    const milestones = await (async () => {
      const sb = (await import("@/lib/supabase/client")).getSupabase();
      const { data, error } = await sb
        .from("marketplace_payment_milestones")
        .select("*")
        .eq("instrument_id", id)
        .order("sequence", { ascending: true });
      if (error) throw error;
      return data || [];
    })();

    return NextResponse.json({
      instrument: instrumentShape,
      milestones,
      is_owner: auth.is_owner,
    });
  } catch (e: any) {
    console.error("[marketplace.finance.get]", e);
    return NextResponse.json({ error: "Failed to load instrument." }, { status: 500 });
  }
}

// PUT /api/marketplace/finance/[id] — update an instrument. Owning partner
// only (the store filters by tenant_id + partner_id).
//
// Body shape (any subset):
//   { status?: InstrumentStatus, terms?, lc_issuing_bank?, lc_advising_bank?,
//     lc_expiry_date?, lc_documents_required?, escrow_release_condition?,
//     escrow_held_until?, factoring_company?, factoring_discount_rate?,
//     factoring_advance_rate?, insurance_provider?, insurance_coverage?,
//     insurance_premium? }
//
// When `status` is present and differs from the current status, the store
// validates the transition against ALLOWED_INSTRUMENT_TRANSITIONS.
async function _put(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Validate status when supplied.
  if (body.status !== undefined && body.status !== null && !VALID_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: "Invalid status." }, { status: 400 });
  }
  // Validate escrow_release_condition when supplied.
  if (body.escrow_release_condition !== undefined && body.escrow_release_condition !== null) {
    if (!VALID_ESCROW_CONDITIONS.includes(body.escrow_release_condition)) {
      return NextResponse.json({ error: "Invalid escrow_release_condition." }, { status: 400 });
    }
  }
  // Numeric field validations.
  for (const k of ["factoring_discount_rate", "factoring_advance_rate", "insurance_coverage", "insurance_premium"] as const) {
    const v = body[k];
    if (v !== undefined && v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
      return NextResponse.json({ error: `${k} must be a non-negative number.` }, { status: 400 });
    }
  }
  // Length cap on free-text fields.
  for (const k of ["terms", "lc_issuing_bank", "lc_advising_bank", "factoring_company", "insurance_provider"] as const) {
    const v = body[k];
    if (typeof v === "string" && v.length > 500) {
      return NextResponse.json({ error: `${k} is too long (max 500 chars).` }, { status: 400 });
    }
  }
  // lc_documents_required must be an array of strings.
  if (body.lc_documents_required !== undefined) {
    if (!Array.isArray(body.lc_documents_required) || body.lc_documents_required.some((d: unknown) => typeof d !== "string")) {
      return NextResponse.json({ error: "lc_documents_required must be an array of strings." }, { status: 400 });
    }
  }

  try {
    let updated: Awaited<ReturnType<typeof updateInstrument>> = null;
    // Status update goes through updateInstrumentStatus (which validates the
    // transition graph); other fields go through updateInstrument.
    if (body.status !== undefined) {
      updated = await updateInstrumentStatus(id, access.tenant_id, access.partner_id, body.status);
      if (!updated) {
        return NextResponse.json({ error: "Not found or not authorised." }, { status: 404 });
      }
    }
    // Strip status; pass the remaining fields to updateInstrument (no-op when
    // the body only carried status).
    const { status: _s, ...rest } = body as Record<string, unknown>;
    void _s;
    const hasOtherFields = Object.keys(rest).length > 0;
    if (hasOtherFields) {
      updated = await updateInstrument(id, access.tenant_id, access.partner_id, rest);
      if (!updated) {
        return NextResponse.json({ error: "Not found or not authorised." }, { status: 404 });
      }
    }
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.instrument_updated",
        "marketplace_financial_instruments",
        id,
        { status: updated?.status, instrument_type: updated?.instrument_type },
      );
    } catch (e) {
      console.error("[marketplace.finance.update] audit failed:", e);
    }
    return NextResponse.json(updated);
  } catch (e: any) {
    console.error("[marketplace.finance.update]", e);
    const msg = sanitizeError(e);
    const status = /cannot transition/i.test(msg) ? 400 : /invalid|must be/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/finance/[id]");
export const PUT = withApm(_put, "PUT /api/marketplace/finance/[id]");
