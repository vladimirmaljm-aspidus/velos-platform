import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";
import { onKycResubmit } from "@/lib/kyc/automation";

export const runtime = "nodejs";

/**
 * POST /api/kyc/[id]/resubmit
 *
 * Admin requests additional information from the client. Sets the submission
 * status back to "resubmit" and sends the "Update Required" email with the
 * admin's note (which fields/documents need attention).
 *
 * Body: { note?: string }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (kyc.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "kyc.resubmit"); if (_d) return _d; } /* requirePermission wired */
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
  // state can be sent back for resubmission. Blocks bouncing an already-
  // rejected / approved submission back to "resubmit".
  if (existing.status !== "submitted" && existing.status !== "under_review" && existing.status !== "draft") {
    return NextResponse.json(
      { error: `Cannot resubmit a KYC submission in status '${existing.status}'.` },
      { status: 409 },
    );
  }
  let body: { note?: string } = {};
  try { body = await req.json(); } catch { /* ok */ }

  const updated = await auth.store.upsertKycSubmission({
    id,
    status: "resubmit",
    review_notes: body.note || null,
    reviewed_by: auth.user.id,
    reviewed_at: new Date().toISOString(),
  } as any);

  // Update partner.kyc_status to "pending" so the client is unblocked
  // and can edit & re-submit their KYC data.
  const partner = await auth.store.getPartner(updated.partner_id);
  if (partner && partner.kyc_status !== "pending") {
    await auth.store.upsertPartner({
      id: partner.id,
      kyc_status: "pending",
    } as any);
  }

  await audit(auth.store, auth.user, req, "kyc.resubmit", "kyc_submission", id, { note: body.note });

  const tenant = await auth.store.getTenant(updated.tenant_id);
  await onKycResubmit({
    store: auth.store,
    submission: updated,
    partner: partner as any,
    tenant,
    note: body.note || null,
  });

  return NextResponse.json(updated);
}
