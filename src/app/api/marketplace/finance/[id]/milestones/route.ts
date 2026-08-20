import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getInstrumentIfAuthorised, addMilestone } from "@/lib/data/marketplace-finance-store";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";
import type { TriggerCondition } from "@/lib/supabase/marketplace-finance-types";

export const runtime = "nodejs";

const VALID_TRIGGERS: TriggerCondition[] = [
  "contract_signed", "advance_payment", "on_loading",
  "on_departure", "on_arrival", "on_inspection_pass",
  "on_delivery", "manual",
];

// GET /api/marketplace/finance/[id]/milestones — list the milestones for a
// payment-schedule instrument. Auth: any authorised caller (the milestones
// are the agreed payment plan — visible to both sides of the deal).
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
    if (auth.instrument.instrument_type !== "payment_schedule") {
      return NextResponse.json(
        { error: "Milestones are only available for payment_schedule instruments." },
        { status: 400 },
      );
    }
    const sb = (await import("@/lib/supabase/client")).getSupabase();
    const { data, error } = await sb
      .from("marketplace_payment_milestones")
      .select("*")
      .eq("instrument_id", id)
      .order("sequence", { ascending: true });
    if (error) throw error;
    return NextResponse.json({ items: data || [] });
  } catch (e: any) {
    console.error("[marketplace.finance.milestones.list]", e);
    return NextResponse.json({ error: "Failed to load milestones." }, { status: 500 });
  }
}

// POST /api/marketplace/finance/[id]/milestones — append a milestone to a
// payment-schedule instrument. Owning partner only.
// Body: { sequence, description, percentage, amount?, trigger_condition,
//         due_date?, reference_number? }
async function _post(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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

  if (typeof body.sequence !== "number" || body.sequence < 1) {
    return NextResponse.json({ error: "sequence must be a positive integer." }, { status: 400 });
  }
  if (typeof body.description !== "string" || body.description.length === 0 || body.description.length > 500) {
    return NextResponse.json({ error: "description must be 1–500 chars." }, { status: 400 });
  }
  if (typeof body.percentage !== "number" || body.percentage < 0 || body.percentage > 100) {
    return NextResponse.json({ error: "percentage must be in [0, 100]." }, { status: 400 });
  }
  if (!VALID_TRIGGERS.includes(body.trigger_condition)) {
    return NextResponse.json({ error: "trigger_condition is invalid." }, { status: 400 });
  }
  if (body.amount !== undefined && body.amount !== null && (typeof body.amount !== "number" || !Number.isFinite(body.amount) || body.amount < 0)) {
    return NextResponse.json({ error: "amount must be a non-negative number." }, { status: 400 });
  }

  try {
    const created = await addMilestone(id, access.tenant_id, access.partner_id, body);
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.milestone_added",
        "marketplace_payment_milestones",
        created.id,
        { instrument_id: id, sequence: created.sequence, percentage: created.percentage },
      );
    } catch (e) {
      console.error("[marketplace.finance.milestones.create] audit failed:", e);
    }
    return NextResponse.json(created, { status: 201 });
  } catch (e: any) {
    console.error("[marketplace.finance.milestones.create]", e);
    const msg = e?.message || "Failed to add milestone.";
    const status = /not found/i.test(msg) ? 404 : /invalid|must be|can only/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/finance/[id]/milestones");
export const POST = withApm(_post, "POST /api/marketplace/finance/[id]/milestones");
