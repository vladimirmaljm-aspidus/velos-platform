import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import {
  createInstrument,
  listInstruments,
} from "@/lib/data/marketplace-finance-store";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";
import type {
  InstrumentStatus,
  InstrumentType,
  LCType,
  EscrowReleaseCondition,
  TriggerCondition,
} from "@/lib/supabase/marketplace-finance-types";

export const runtime = "nodejs";

const VALID_INSTRUMENT_TYPES: InstrumentType[] = [
  "letter_of_credit", "escrow", "factoring",
  "trade_credit_insurance", "payment_schedule",
];
const VALID_LC_TYPES: LCType[] = [
  "irrevocable", "revocable", "confirmed", "unconfirmed",
  "transferable", "back_to_back", "standby",
];
const VALID_ESCROW_CONDITIONS: EscrowReleaseCondition[] = [
  "delivery_confirmation", "inspection_pass",
  "both_parties_confirm", "manual",
];
const VALID_TRIGGERS: TriggerCondition[] = [
  "contract_signed", "advance_payment", "on_loading",
  "on_departure", "on_arrival", "on_inspection_pass",
  "on_delivery", "manual",
];
const VALID_STATUSES: InstrumentStatus[] = [
  "draft", "submitted", "approved", "active",
  "completed", "rejected", "disputed", "released", "refunded",
];

// GET /api/marketplace/finance — list the caller's instruments.
// Optional query: ?type=<lc|escrow|factoring|…>&limit=50&offset=0
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    const url = new URL(req.url);
    const type = url.searchParams.get("type") || undefined;
    const limit = url.searchParams.get("limit");
    const offset = url.searchParams.get("offset");
    const items = await listInstruments(access.tenant_id, access.partner_id, {
      type,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return NextResponse.json(items);
  } catch (e: any) {
    console.error("[marketplace.finance.list]", e);
    return NextResponse.json({ error: "Failed to load instruments." }, { status: 500 });
  }
}

// POST /api/marketplace/finance — create a new financial instrument.
// Body: see InstrumentCreate in marketplace-finance-types.ts. tenant_id +
// partner_id are stamped from the auth context — never trust a body-
// supplied partner_id.
async function _post(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Validate instrument_type.
  if (!VALID_INSTRUMENT_TYPES.includes(body.instrument_type)) {
    return NextResponse.json({ error: "Invalid or missing instrument_type." }, { status: 400 });
  }
  // Validate amount.
  if (typeof body.amount !== "number" || !Number.isFinite(body.amount) || body.amount <= 0) {
    return NextResponse.json({ error: "amount must be a positive number." }, { status: 400 });
  }
  // Validate optional status.
  if (body.status && !VALID_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: "Invalid status." }, { status: 400 });
  }
  // Validate optional currency (3-letter ISO).
  if (body.currency && (typeof body.currency !== "string" || body.currency.length !== 3)) {
    return NextResponse.json({ error: "currency must be a 3-letter ISO code." }, { status: 400 });
  }
  // Type-specific validations.
  if (body.instrument_type === "letter_of_credit") {
    if (!VALID_LC_TYPES.includes(body.lc_type)) {
      return NextResponse.json({ error: "Invalid or missing lc_type." }, { status: 400 });
    }
  }
  if (body.instrument_type === "escrow") {
    if (!VALID_ESCROW_CONDITIONS.includes(body.escrow_release_condition)) {
      return NextResponse.json({ error: "Invalid or missing escrow_release_condition." }, { status: 400 });
    }
  }
  if (body.instrument_type === "factoring") {
    for (const k of ["factoring_discount_rate", "factoring_advance_rate"] as const) {
      const v = body[k];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
        return NextResponse.json({ error: `${k} must be a number in [0, 100].` }, { status: 400 });
      }
    }
  }
  if (body.instrument_type === "trade_credit_insurance") {
    if (typeof body.insurance_coverage !== "number" || !Number.isFinite(body.insurance_coverage) || body.insurance_coverage < 0 || body.insurance_coverage > 100) {
      return NextResponse.json({ error: "insurance_coverage must be a number in [0, 100]." }, { status: 400 });
    }
  }
  if (body.instrument_type === "payment_schedule") {
    if (!Array.isArray(body.milestones) || body.milestones.length === 0) {
      return NextResponse.json({ error: "payment_schedule requires at least one milestone." }, { status: 400 });
    }
    for (const m of body.milestones) {
      if (typeof m.sequence !== "number" || m.sequence < 1) {
        return NextResponse.json({ error: "milestone.sequence must be a positive integer." }, { status: 400 });
      }
      if (typeof m.description !== "string" || m.description.length === 0 || m.description.length > 500) {
        return NextResponse.json({ error: "milestone.description must be 1–500 chars." }, { status: 400 });
      }
      if (typeof m.percentage !== "number" || m.percentage < 0 || m.percentage > 100) {
        return NextResponse.json({ error: "milestone.percentage must be in [0, 100]." }, { status: 400 });
      }
      if (!VALID_TRIGGERS.includes(m.trigger_condition)) {
        return NextResponse.json({ error: "milestone.trigger_condition is invalid." }, { status: 400 });
      }
    }
  }
  // Length cap on free-text fields.
  for (const k of ["terms", "lc_issuing_bank", "lc_advising_bank", "factoring_company", "insurance_provider", "counterparty_partner_id"] as const) {
    const v = body[k];
    if (typeof v === "string" && v.length > 500) {
      return NextResponse.json({ error: `${k} is too long (max 500 chars).` }, { status: 400 });
    }
  }

  try {
    const created = await createInstrument(access.tenant_id, access.partner_id, body);
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.instrument_created",
        "marketplace_financial_instruments",
        created.id,
        { instrument_type: created.instrument_type, amount: created.amount, currency: created.currency },
      );
    } catch (e) {
      console.error("[marketplace.finance.create] audit failed:", e);
    }
    return NextResponse.json(created, { status: 201 });
  } catch (e: any) {
    console.error("[marketplace.finance.create]", e);
    const msg = e?.message || "Failed to create instrument.";
    const status = /not found/i.test(msg) ? 404 : /invalid/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/finance");
export const POST = withApm(_post, "POST /api/marketplace/finance");
