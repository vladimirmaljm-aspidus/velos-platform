import { sendEmail, kycStatusEmail } from "@/lib/email/service";
import type { KycSubmission, Partner, PortalAccess, Tenant } from "@/lib/supabase/types";
import { getTierMeta } from "@/lib/portal/tiers";
// AUDIT15 / EMAIL-ADDR — portal_email (and partner contact_email) are
// encrypted at rest with `enc:`-prefixed AES-256-GCM ciphertext (P0-3 /
// Feature 2, applied by the API route layer on write). Store reads return
// the rows AS STORED, so any email address coming out of a store read must
// be decrypted before it is used as a To: address. decryptField is a
// no-op on plaintext (legacy rows) and returns the raw string on failure,
// so the guard in the send path also catches undecryptable values.
import {
  encryptField,
  decryptField,
  hmacField,
  isEncrypted,
} from "@/lib/crypto/field-encryption";

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

/**
 * AUDIT16 / EMAIL-ADDR — resolve the best usable To: address for a
 * partner-facing email. `partner.email` is the legacy plaintext column;
 * `partner.contact_email` (and in some flows `submission.contact_email`)
 * may be encrypted at rest (P0-3). Every value is passed through
 * decryptField (a no-op on plaintext) and rejected if it is still an
 * `enc:` blob after decryption (rotated key) — providers reject ciphertext
 * To: addresses. Used by approved/rejected/resubmit so all three KYC
 * decisions behave identically (audit15 fixed only the approved path).
 */
function resolvePartnerContactEmail(partner: Partner, submission: KycSubmission): string {
  const legacy = partner.email || "";
  if (legacy && !isEncrypted(legacy)) return legacy;
  const contact = decryptField(partner.contact_email || "");
  if (contact && !isEncrypted(contact)) return contact;
  const submissionContact = decryptField(submission.contact_email || "");
  if (submissionContact && !isEncrypted(submissionContact)) return submissionContact;
  // Last resort — a legacy plaintext value that decryptField could not
  // process (returns raw on failure). Still better than dropping the send.
  return legacy || "";
}

/** Send the KYC approved email + auto-provision portal access + welcome email. */
export async function onKycApproved(ctx: KycAutomationContext) {
  const { store, submission, partner, tenant, baseUrl } = ctx;

  // 1. Send the KYC-approved email
  const tier = ctx.preferredTier || "business";
  // AUDIT15/16 / EMAIL-ADDR — see resolvePartnerContactEmail above.
  const emailTarget = resolvePartnerContactEmail(partner, submission);

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
    //
    // AUDIT15 / EMAIL-ADDR — encrypt portal_email + set the HMAC search
    // token at creation, mirroring what the portal-access API route does
    // on write (P0-3 / Feature 2). Previously this path wrote the email in
    // PLAINTEXT (bypassing the API-layer encryption): the row was then
    // readable by the login flow's legacy plaintext-equality fallback, but
    // it was inconsistent with every other portal row and — worse — the
    // in-memory object returned by the upsert carried the plaintext into
    // the welcome-email block below, which assumed DB rows are encrypted.
    // Now both paths see the same shape: stored `enc:` ciphertext, and the
    // send path decrypts explicitly.
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
      portal_email: encryptField(emailTarget),
      portal_email_hmac: hmacField(emailTarget),
      must_set_password: true,
      welcome_email_sent: false,
    } as Partial<PortalAccess> & { id?: string });
  }

  // AUDIT15 / EMAIL-ADDR — `access` may be an EXISTING row read from the
  // store (lines above), whose portal_email is `enc:`-encrypted. The
  // freshly-created row above also carries encrypted portal_email. Decrypt
  // once here; every use below (To: address + the body copy) needs the
  // plaintext. Legacy plaintext rows pass through untouched. If decryption
  // fails (rotated key), skip the welcome email rather than sending to a
  // ciphertext address — the admin can fix the email via Portal Access UI.
  const accessEmail = decryptField(access?.portal_email || "");
  const accessEmailUsable =
    !!access && !!accessEmail && !isEncrypted(accessEmail) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(accessEmail);

  if (access && accessEmailUsable && !access.welcome_email_sent) {
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
      portalEmail: accessEmail,
      accessId: access.id,
      tenantName: tenant?.name || "VELOS",
      baseUrl,
      tier: access.tier,
      setupToken,
    });
    // AUDIT17 / P1-3 — gate welcome_email_sent on ACTUAL delivery.
    // sendEmail resolves { success:true, queued:true } when no provider is
    // configured (mail parked, client got nothing) and { success:false }
    // on provider failure — neither may flip the flag (the invite route
    // and change-email route already apply the same gate).
    let welcomeDelivered = false;
    try {
      const sendResult = await sendEmail({
        to: accessEmail,
        subject: wSub,
        html: wHtml,
        tenantId: submission.tenant_id,
      });
      welcomeDelivered = !!(sendResult.success && !sendResult.queued);
    } catch (e) {
      console.error("[kyc.welcome]", e);
    }

    if (welcomeDelivered) {
      await store.upsertPortalAccess({
        id: access.id,
        welcome_email_sent: true,
      }).catch(() => {});
    }
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
  // AUDIT16 / EMAIL-ADDR — was `partner.email || partner.contact_email ||
  // submission.contact_email` RAW: for partners whose only address is the
  // encrypted contact_email, the rejection email went out To: `enc:…`
  // (rejected by every provider, then retried forever from mail_queue).
  const emailTarget = resolvePartnerContactEmail(partner, submission);
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
  // AUDIT16 / EMAIL-ADDR — same ciphertext-To bug as onKycRejected above.
  const emailTarget = resolvePartnerContactEmail(partner, submission);
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
