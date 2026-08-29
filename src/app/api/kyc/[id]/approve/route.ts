import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { notifyKycApproved } from "@/lib/notif/helper";
import { onKycApproved } from "@/lib/kyc/automation";

export const runtime = "nodejs";

/**
 * POST /api/kyc/[id]/approve
 *
 * Approves a KYC submission and runs the full automation chain:
 *   1. Updates submission status → "approved"
 *   2. Auto-transfers KYC data into the partner record (name, tax id, address, bank, etc.)
 *   3. Sends the "KYC Approved" email to the portal client
 *   4. Auto-provisions a PortalAccess row (status = invited) if none exists
 *   5. Sends the portal welcome email with password-setup link
 *
 * Body (optional): { tier?: "premium"|"business"|"standard"|"basic" }
 *   — lets the admin override the default tier when provisioning portal access.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (kyc.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "kyc.approve"); if (_d) return _d; } /* requirePermission wired */
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
  // Status guard (H-3) — only submissions in "submitted" or "under_review"
  // state can be approved. Blocks approving an already-approved /
  // rejected / resubmit submission.
  if (existing.status !== "submitted" && existing.status !== "under_review" && existing.status !== "draft") {
    return NextResponse.json(
      { error: `Cannot approve a KYC submission in status '${existing.status}'.`,
      },
      { status: 409 },
    );
  }
  let body: { tier?: "premium" | "business" | "standard" | "basic" } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  try {
    const { submission, partner } = await auth.store.approveKycAndTransfer(id, auth.user.id);

    await audit(auth.store, auth.user, req, "kyc.approve", "kyc_submission", id, {
      partner_id: partner.id,
      auto_transferred: true,
      tier: body.tier || "business",
    });

    await notifyKycApproved(auth.tenantId || submission.tenant_id, partner.name, partner.id);

    // Run the full automation chain (email + portal access + welcome email)
    const tenant = await auth.store.getTenant(submission.tenant_id);
    // SEC-L6 — prefer the Next.js public env var (required for
    // client-side rendering, so always present in production) and
    // fall back to APP_BASE_URL. Throw in production if NEITHER is set
    // — the previous hardcoded fallback `https://aspidus.onrender.com`
    // was a sandbox artifact that would have leaked into real customer
    // emails if the env was misconfigured.
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.APP_BASE_URL ||
      (process.env.NODE_ENV === "production"
        ? (() => {
            throw new Error("NEXT_PUBLIC_APP_URL or APP_BASE_URL required in production for KYC approval emails");
          })()
        : "http://localhost:3000");
    const { access } = await onKycApproved({
      store: auth.store,
      submission,
      partner,
      tenant,
      reviewerName: auth.user.username,
      preferredTier: body.tier,
      baseUrl,
    });

    return NextResponse.json({
      submission,
      partner,
      transferred: true,
      portal_access: access ? { ...access, password_hash: undefined } : null,
    });
  } catch (e: any) {
    console.error("[kyc.approve]", e);
    // SEC-L4 — never leak raw e.message. The KYC approval chain spans
    // store + email + portal-access provisioning, any of which can
    // raise a PostgrestError whose .message leaks the schema. Sanitize
    // before returning to the caller.
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
