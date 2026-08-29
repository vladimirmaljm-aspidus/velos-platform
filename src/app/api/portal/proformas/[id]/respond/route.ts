import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { requireGpsVerified } from "@/lib/portal/require-gps";
import { getStore } from "@/lib/data/store";
import { audit } from "@/lib/api/helpers";
import { notify } from "@/lib/notif/helper";
import { validateStatusTransition } from "@/lib/api/status-validator";

export const runtime = "nodejs";

/**
 * POST /api/portal/proformas/[id]/respond
 *
 * Allows a portal client to accept or reject a proforma that has been sent
 * to them. Mirrors the offer respond flow but WITHOUT inventory deduction
 * or commission cascade (proformas don't trigger those).
 *
 * Body: { decision: "accept" | "reject", note?: string }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await getPortalSessionAccess();
    if (!access) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    if (!access.can_view_invoices) {
      return NextResponse.json({ error: "Not permitted." }, { status: 403 });
    }
    const _kycBlock = await requireKycApproved(access);
    if (_kycBlock) return _kycBlock;
    const _gpsBlock = await requireGpsVerified(access);
    if (_gpsBlock) return _gpsBlock;

    const { id } = await params;

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const { decision, note } = body;
    if (!decision || !["accept", "reject"].includes(decision)) {
      return NextResponse.json({ error: "Decision must be 'accept' or 'reject'." }, { status: 400 });
    }

    const store = await getStore();

    // Fetch the proforma and verify ownership.
    const proforma = await store.getProforma(id);
    if (!proforma) {
      return NextResponse.json({ error: "Proforma not found." }, { status: 404 });
    }
    if (proforma.tenant_id !== access.tenant_id) {
      return NextResponse.json({ error: "Proforma not found." }, { status: 404 });
    }
    if (proforma.partner_id !== access.partner_id) {
      return NextResponse.json({ error: "Access denied." }, { status: 403 });
    }

    // Only allow response when proforma is in "sent" or "viewed" status.
    const currentStatus = proforma.status as string;
    if (currentStatus !== "sent" && currentStatus !== "viewed") {
      return NextResponse.json(
        { error: `This proforma cannot be responded to (current status: ${currentStatus}).` },
        { status: 409 },
      );
    }

    // AUDIT2-LOGIC-UX H1 — use the proper "rejected" status for a Reject
    // decision (was "expired", which conflated an active rejection with
    // a timeout). The state machine in status-validator.ts now allows
    // sent|viewed → rejected.
    const newStatus = decision === "accept" ? "accepted" : "rejected";

    // Validate the status transition.
    const transitionError = validateStatusTransition("proforma", currentStatus, newStatus);
    if (typeof transitionError === "string") {
      return NextResponse.json({ error: transitionError }, { status: 409 });
    }
    if (transitionError && !transitionError.valid) {
      return NextResponse.json(
        { error: transitionError.error || "Invalid status transition." },
        { status: 409 },
      );
    }

    // Update the proforma status.
    const update: any = {
      id,
      status: newStatus,
      responded_at: new Date().toISOString(),
    };
    if (note) {
      update.notes = (proforma.notes || "") + `\n[Client ${decision}]: ${note}`;
    }
    await store.upsertProforma(update);

    // Notify tenant admins.
    try {
      const partner = proforma.partner_id ? await store.getPartner(proforma.partner_id) : null;
      const partnerName = partner?.name || "Portal client";
      await notify({
        tenantId: access.tenant_id,
        userId: null,
        type: decision === "accept" ? "proforma_accepted" : "proforma_rejected",
        title: decision === "accept" ? "Proforma Accepted" : "Proforma Rejected",
        message:
          decision === "accept"
            ? `${partnerName} accepted proforma ${proforma.number}.${note ? " Note: " + note : ""}`
            : `${partnerName} rejected proforma ${proforma.number}.${note ? " Reason: " + note : ""}`,
        entityType: "proforma",
        entityId: id,
        actionUrl: `/proformas?id=${id}`,
        actionLabel: "View Proforma",
      });
    } catch (e) {
      console.error("[portal.proforma.respond] notification failed:", e);
    }

    // Audit log.
    try {
      await audit(
        store,
        {
          id: undefined,
          username: access.portal_email || `portal:${access.id}`,
          tenant_id: access.tenant_id,
        },
        req,
        "portal.proforma_responded",
        "proforma",
        id,
        { decision, note: note || null },
      );
    } catch (e) {
      console.error("[audit]", e);
    }

    return NextResponse.json({ ok: true, status: newStatus });
  } catch (e: any) {
    console.error("[portal.proforma.respond]", e);
    return NextResponse.json({ error: e.message || "Internal server error" }, { status: 500 });
  }
}
