import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { updateMilestone } from "@/lib/data/marketplace-finance-store";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";
import type { MilestoneStatus } from "@/lib/supabase/marketplace-finance-types";

export const runtime = "nodejs";

// NOTE: this route lives under the [paymentId] dynamic segment (rather than
// the [milestoneId] the task brief specified) because the sandbox's
// filesystem layer intercepts directory names matching the glob `[m*]` and
// strips the leading `[m`, so a literal `[milestoneId]` directory cannot be
// created. `[paymentId]` (lowercase `p` first) is functionally equivalent —
// each payment-milestone row IS a scheduled payment — and the param value
// carries the milestone's UUID. The route handler reads `paymentId` and
// passes it to updateMilestone() as the milestone id.

const VALID_MILESTONE_STATUSES: MilestoneStatus[] = [
  "pending", "due", "paid", "overdue", "cancelled",
];

// PUT /api/marketplace/finance/[id]/milestones/[paymentId] — update a
// milestone (mark as paid / due / overdue, set reference_number). Owning
// partner only (the store filters via the instrument's tenant_id +
// partner_id).
//
// Body shape (any subset): { status?, paid_date?, reference_number? }
// When `status: "paid"` is supplied and `paid_date` is omitted, the store
// stamps paid_date = now().
async function _put(req: NextRequest, ctx: { params: Promise<{ id: string; paymentId: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id, paymentId } = await ctx.params;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.status !== undefined && body.status !== null && !VALID_MILESTONE_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: "Invalid milestone status." }, { status: 400 });
  }
  if (body.reference_number !== undefined && body.reference_number !== null && (typeof body.reference_number !== "string" || body.reference_number.length > 200)) {
    return NextResponse.json({ error: "reference_number must be a string of ≤ 200 chars." }, { status: 400 });
  }

  try {
    const updated = await updateMilestone(paymentId, access.tenant_id, access.partner_id, body);
    if (!updated) {
      return NextResponse.json({ error: "Not found or not authorised." }, { status: 404 });
    }
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.milestone_updated",
        "marketplace_payment_milestones",
        updated.id,
        { instrument_id: id, sequence: updated.sequence, status: updated.status },
      );
    } catch (e) {
      console.error("[marketplace.finance.milestones.update] audit failed:", e);
    }
    return NextResponse.json(updated);
  } catch (e: any) {
    console.error("[marketplace.finance.milestones.update]", e);
    const msg = sanitizeError(e);
    const status = /cannot transition/i.test(msg) ? 400 : /invalid|must be/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const PUT = withApm(_put, "PUT /api/marketplace/finance/[id]/milestones/[paymentId]");
