import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { requireGpsVerified } from "@/lib/portal/require-gps";
import { getStore } from "@/lib/data/store";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { notify } from "@/lib/notif/helper";
import { validateStatusTransition } from "@/lib/api/status-validator";

export const runtime = "nodejs";

/**
 * POST /api/portal/lois/[id]/respond
 *
 * BUILD-LOI-PORTAL — allows a portal client (the SELLER who received the
 * Letter of Intent) to ACCEPT or REJECT it. Mirrors the proforma respond
 * flow: ownership checks → state-machine validation → status update →
 * notify tenant admins → audit log.
 *
 * Body: { decision: "accept" | "reject", note?: string }
 *
 * State machine (status-validator.ts `loi`):
 *   sent → accepted | rejected   (the partner's decision)
 * accepted/rejected/expired/cancelled are terminal — a 409 is returned if
 * the client tries to respond twice (idempotency by state, not by token).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const access = await getPortalSessionAccess();
    if (!access) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    if (!access.can_view_offers) {
      return NextResponse.json({ error: "Not permitted." }, { status: 403 });
    }
    const kycBlock = await requireKycApproved(access);
    if (kycBlock) return kycBlock;
    const gpsBlock = await requireGpsVerified(access);
    if (gpsBlock) return gpsBlock;

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
    // 8b-6 parity — cap `note` length so a portal client can't POST a
    // 100MB string (the note is appended to the LOI's `notes` column).
    if (note && typeof note === "string" && note.length > 5000) {
      return NextResponse.json({ error: "Note is too long (max 5000 chars)." }, { status: 400 });
    }

    const store = await getStore();

    // Fetch the LOI and verify ownership.
    const loi = await store.getLoi(id);
    if (!loi) {
      return NextResponse.json({ error: "LOI not found." }, { status: 404 });
    }
    if (loi.tenant_id !== access.tenant_id) {
      return NextResponse.json({ error: "LOI not found." }, { status: 404 });
    }
    if (loi.partner_id !== access.partner_id) {
      return NextResponse.json({ error: "Access denied." }, { status: 403 });
    }

    // Only a SENT LOI is respondable. The LOI state machine has no
    // "viewed" status (viewing keeps it "sent"), so this is the single
    // respondable state. Drafts never reach the portal; accepted /
    // rejected / expired / cancelled are terminal.
    const currentStatus = loi.status as string;
    if (currentStatus !== "sent") {
      return NextResponse.json(
        { error: `This LOI cannot be responded to (current status: ${currentStatus}).` },
        { status: 409 },
      );
    }

    const newStatus = decision === "accept" ? "accepted" : "rejected";

    // Validate the transition through the shared state machine.
    const transitionError = validateStatusTransition("loi", currentStatus, newStatus);
    if (typeof transitionError === "string") {
      return NextResponse.json({ error: transitionError }, { status: 409 });
    }
    if (transitionError && !transitionError.valid) {
      return NextResponse.json(
        { error: transitionError.error || "Invalid status transition." },
        { status: 409 },
      );
    }

    // Update the LOI (status + responded_at; optional note appended).
    const update: any = {
      id,
      status: newStatus,
      responded_at: new Date().toISOString(),
    };
    if (note) {
      update.notes = (loi.notes || "") + `\n[Seller ${decision}]: ${note}`;
    }
    await store.upsertLoi(update);

    // Notify tenant admins (broadcast — the buyer needs to know the seller
    // responded). Mirrors the proforma_accepted / proforma_rejected flow.
    try {
      const partner = loi.partner_id ? await store.getPartner(loi.partner_id) : null;
      const partnerName = partner?.name || "Portal client";
      await notify({
        tenantId: access.tenant_id,
        userId: null,
        type: decision === "accept" ? "loi_accepted" : "loi_rejected",
        title: decision === "accept" ? "LOI Accepted" : "LOI Rejected",
        message:
          decision === "accept"
            ? `${partnerName} accepted LOI ${loi.number}.${note ? " Note: " + note : ""}`
            : `${partnerName} rejected LOI ${loi.number}.${note ? " Reason: " + note : ""}`,
        entityType: "loi",
        entityId: id,
        actionUrl: `/lois?id=${id}`,
        actionLabel: "View LOI",
      });
    } catch (e) {
      console.error("[portal.loi.respond] notification failed:", e);
    }

    // Audit log (portal attribution — the audit row records the portal
    // email so the LOI's decision trail survives in the audit view).
    try {
      await audit(
        store,
        {
          id: undefined,
          username: access.portal_email || `portal:${access.id}`,
          tenant_id: access.tenant_id,
        },
        req,
        "portal.loi_responded",
        "loi",
        id,
        { decision, note: note || null, status: newStatus },
      );
    } catch (e) {
      console.error("[audit]", e);
    }

    return NextResponse.json({ ok: true, status: newStatus });
  } catch (e: any) {
    console.error("[portal.loi.respond]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
