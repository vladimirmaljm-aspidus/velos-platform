import { sendEmail, kycStatusEmail } from "@/lib/email/service";
import type { KycSubmission, Partner, PortalAccess, Tenant } from "@/lib/supabase/types";
import { getTierMeta } from "@/lib/portal/tiers";

/**
 * Automated actions that fire after a KYC decision.
 *
 * - On APPROVE: transfer data to partner (already done in store), then send
 *   the "KYC Approved" email to the portal client, create a PortalAccess row
 *   if one doesn't exist yet (status=invited), and fire the welcome email.
 *
 * - On REJECT: send the "KYC Rejected" email with the reason.
 *
 * - ON RESUBMIT (admin requests more info): send the "Update Required" email.
 *
 * All email sends are best-effort — failures are logged but do not block the
 * API response, because the mail_queue table will retry later.
 */

export interface KycAutomationContext {
  store: import("@/lib/data/store").Store;
  submission: KycSubmission;
  partner: Partner;
  tenant: Tenant | null;
  reviewerName: string;
  /** Set when the admin picked a specific tier for the new portal access. */
  preferredTier?: PortalAccess["tier"];
  baseUrl: string;
}

/** Send the KYC approved email + auto-provision portal access + welcome email. */
export async function onKycApproved(ctx: KycAutomationContext) {
  const { store, submission, partner, tenant, baseUrl } = ctx;

  // 1. Send the KYC-approved email
  const tier = ctx.preferredTier || "business";
  const emailTarget = partner.email || partner.contact_email || submission.contact_email || "";

  if (emailTarget) {
    const { subject, html } = kycStatusEmail({
      partnerName: partner.name,
      to: emailTarget,
      status: "approved",
      tenantName: tenant?.name || "VELOS",
      portalUrl: `${baseUrl || process.env.APP_BASE_URL || ""}/portal/login`,
    });
    await sendEmail({
      to: emailTarget,
      subject,
      html,
      tenantId: submission.tenant_id,
    }).catch((e) => console.error("[kyc.email]", e));
  }

  // 2. Auto-provision portal access if not already present
  let access: PortalAccess | null = null;
  if (submission.portal_access_id) {
    access = await store.getPortalAccessById(submission.portal_access_id);
  }
  if (!access) {
    // Look up by partner
    access = await store.getPortalAccessByPartner(partner.id);
  }
  if (!access && emailTarget) {
    // Create a new PortalAccess row in "invited" status — admin can still
    // adjust the tier / send the welcome email later.
    access = await store.upsertPortalAccess({
      tenant_id: submission.tenant_id,
      partner_id: partner.id,
      tier,
      // Sensible defaults — admin can change later
      can_view_offers: true,
      can_view_documents: true,
      can_view_catalog: true,
      can_view_invoices: true,
      can_view_profile: true,
      can_view_company_info: tier === "premium" || tier === "business",
      can_submit_rfq: getTierMeta(tier).canSubmitRfq,
      can_download_pdf: getTierMeta(tier).canDownloadPdf,
      // Compliance exemptions — premium clients skip KYC/docs/location
      exempt_kyc: !getTierMeta(tier).requiresKyc,
      exempt_document_upload: !getTierMeta(tier).requiresDocuments,
      exempt_location_share: !getTierMeta(tier).requiresLocation,
      status: "invited",
      invited_at: new Date().toISOString(),
      portal_email: emailTarget,
      must_set_password: true,
      welcome_email_sent: false,
    } as Partial<PortalAccess> & { id?: string });
  }

  if (access && !access.welcome_email_sent && access.portal_email) {
    // 3. Send the portal welcome email with password-setup link
    // Audit F-6/P1-3: mint a single-use, 7-day-expiring setup token instead
    // of embedding the permanent `access_id` UUID in the email link. Same
    // pattern as /api/portal-access/[id]/invite. Best-effort: if token
    // minting fails, we still send the welcome email but with the legacy
    // access_id link (which the setup-password route will honour for 7
    // days based on invited_at, then reject).
    const { welcomePortalEmail } = await import("@/lib/email/service");
    let setupToken: string | null = null;
    try {
      const { createPasswordReset } = await import("@/lib/auth/password-reset");
      const issued = await createPasswordReset({
        targetType: "portal_access",
        targetId: access.id,
        tenantId: access.tenant_id,
        ttlMs: 7 * 24 * 60 * 60 * 1000,
      });
      setupToken = issued.token;
    } catch (e) {
      console.error("[kyc.welcome] createPasswordReset failed, falling back to access_id link:", e);
    }
    const { subject: wSub, html: wHtml } = welcomePortalEmail({
      partnerName: partner.name,
      portalEmail: access.portal_email,
      accessId: access.id,
      tenantName: tenant?.name || "VELOS",
      baseUrl,
      tier: access.tier,
      setupToken,
    });
    await sendEmail({
      to: access.portal_email,
      subject: wSub,
      html: wHtml,
      tenantId: submission.tenant_id,
    }).catch((e) => console.error("[kyc.welcome]", e));

    await store.upsertPortalAccess({
      id: access.id,
      welcome_email_sent: true,
    }).catch(() => {});
  }

  return { access };
}

/** Send the KYC rejected email. */
export async function onKycRejected(
  ctx: Pick<KycAutomationContext, "store" | "submission" | "partner" | "tenant"> & {
    reason: string | null;
  }
) {
  const { submission, partner, tenant, reason } = ctx;
  const emailTarget = partner.email || partner.contact_email || submission.contact_email;
  if (!emailTarget) return;

  const { subject, html } = kycStatusEmail({
    partnerName: partner.name,
    to: emailTarget,
    status: "rejected",
    tenantName: tenant?.name || "VELOS",
    reason,
  });
  await sendEmail({
    to: emailTarget,
    subject,
    html,
    tenantId: submission.tenant_id,
  }).catch((e) => console.error("[kyc.reject.email]", e));
}

/** Send the "KYC update required" email (admin requested resubmission). */
export async function onKycResubmit(
  ctx: Pick<KycAutomationContext, "store" | "submission" | "partner" | "tenant"> & {
    note: string | null;
  }
) {
  const { submission, partner, tenant, note } = ctx;
  const emailTarget = partner.email || partner.contact_email || submission.contact_email;
  if (!emailTarget) return;

  const { subject, html } = kycStatusEmail({
    partnerName: partner.name,
    to: emailTarget,
    status: "resubmit",
    tenantName: tenant?.name || "VELOS",
    reason: note,
    portalUrl: `${process.env.APP_BASE_URL || ""}/portal/login`,
  });
  await sendEmail({
    to: emailTarget,
    subject,
    html,
    tenantId: submission.tenant_id,
  }).catch((e) => console.error("[kyc.resubmit.email]", e));
}
