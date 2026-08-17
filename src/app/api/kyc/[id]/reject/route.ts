import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";
import { notifyKycRejected } from "@/lib/notif/helper";
import { onKycRejected } from "@/lib/kyc/automation";

export const runtime = "nodejs";

/**
 * POST /api/kyc/[id]/reject
 *
 * Rejects a KYC submission and sends the "KYC Rejected" email to the portal
 * client with the admin-provided reason.
 *
 * Body: { reason?: string }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (kyc.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "kyc.reject"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_kyc)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_kyc", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  const { id } = await params;
  // Tenant ownership check
  const existing = await auth.store.getKycSubmission(id);
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  // Status guard (H-3) — only submissions in "submitted" or "pending"
  // state can be rejected. Blocks rejecting an already-rejected /
  // approved submission.
  if (existing.status !== "submitted" && existing.status !== "under_review" && existing.status !== "draft") {
    return NextResponse.json(
      { error: `Cannot reject a KYC submission in status '${existing.status}'.` },
      { status: 409 },
    );
  }
  let body: { reason?: string } = {};
  try { body = await req.json(); } catch { /* ok */ }

  const updated = await auth.store.upsertKycSubmission({
    id, status: "rejected", rejection_reason: body.reason || null,
    reviewed_by: auth.user.id, reviewed_at: new Date().toISOString(),
  });
  await audit(auth.store, auth.user, req, "kyc.reject", "kyc_submission", id, { reason: body.reason });

  // Update partner.kyc_status to "rejected" to keep partner record in sync
  const partner = await auth.store.getPartner(updated.partner_id);
  if (partner && partner.kyc_status !== "rejected") {
    await auth.store.upsertPartner({
      id: partner.id,
      kyc_status: "rejected",
    } as any);
  }

  await notifyKycRejected(auth.tenantId || updated.tenant_id, partner?.name || "Client", id, body.reason);

  // Send the rejection email
  const tenant = await auth.store.getTenant(updated.tenant_id);
  await onKycRejected({
    store: auth.store,
    submission: updated,
    partner: partner as any,
    tenant,
    reason: body.reason || null,
  });

  return NextResponse.json(updated);
}
