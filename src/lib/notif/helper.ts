import { getStore } from "@/lib/data/store";
import type { NotificationType } from "@/lib/supabase/types";

/**
 * Notification helper — creates in-app notifications and optionally sends emails.
 * Called from API routes when events happen (KYC submit, RFQ create, offer send, etc.)
 */

export async function notify(opts: {
  tenantId: string;
  userId?: string | null; // null = broadcast to all tenant admins
  partnerId?: string | null; // null = not partner-specific; for portal notifications
  type: NotificationType;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
  actionUrl?: string;
  actionLabel?: string;
}): Promise<void> {
  try {
    const store = await getStore();
    await store.createNotification({
      tenant_id: opts.tenantId,
      user_id: opts.userId ?? null,
      partner_id: opts.partnerId ?? null,
      type: opts.type,
      title: opts.title,
      message: opts.message,
      entity_type: opts.entityType || null,
      entity_id: opts.entityId || null,
      action_url: opts.actionUrl || null,
      action_label: opts.actionLabel || null,
    });
  } catch (e) {
    console.error("[notify]", e);
  }
}

// ============================================================
// Event-specific helpers
// ============================================================

export async function notifyKycSubmitted(tenantId: string, partnerName: string, submissionId: string) {
  await notify({
    tenantId,
    userId: null,
    type: "kyc_submitted",
    title: "KYC Submission Received",
    message: `${partnerName} submitted KYC for review.`,
    entityType: "kyc_submission",
    entityId: submissionId,
    actionLabel: "Review",
  });
}

export async function notifyKycApproved(tenantId: string, partnerName: string, partnerId: string, portalEmail?: string) {
  await notify({
    tenantId,
    type: "kyc_approved",
    title: "KYC Approved & Transferred",
    message: `${partnerName} KYC approved. All data transferred to partner record.`,
    entityType: "partner",
    entityId: partnerId,
    actionLabel: "View Partner",
  });
}

export async function notifyKycRejected(tenantId: string, partnerName: string, submissionId: string, reason?: string) {
  await notify({
    tenantId,
    type: "kyc_rejected",
    title: "KYC Rejected",
    message: `${partnerName} KYC rejected. ${reason || ""}`.trim(),
    entityType: "kyc_submission",
    entityId: submissionId,
    actionLabel: "View",
  });
}

export async function notifyRfqReceived(tenantId: string, partnerName: string, productName: string, rfqId: string) {
  await notify({
    tenantId,
    userId: null,
    type: "rfq_received",
    title: "New RFQ from " + partnerName,
    message: `${partnerName} requested a quote for ${productName}.`,
    entityType: "portal_rfq",
    entityId: rfqId,
    actionLabel: "View",
  });
}

export async function notifyOfferSent(tenantId: string, partnerName: string, offerNumber: string, offerId: string) {
  await notify({
    tenantId,
    type: "offer_sent",
    title: "Offer Sent",
    message: `Offer ${offerNumber} has been sent to ${partnerName}.`,
    entityType: "offer",
    entityId: offerId,
    actionLabel: "View",
  });
}

export async function notifyOfferAccepted(tenantId: string, partnerName: string, offerNumber: string, offerId: string) {
  await notify({
    tenantId,
    type: "offer_accepted",
    title: "Offer Accepted!",
    message: `${partnerName} accepted offer ${offerNumber}.`,
    entityType: "offer",
    entityId: offerId,
    actionLabel: "View",
  });
}

export async function notifyInvoiceOverdue(tenantId: string, partnerName: string, invoiceNumber: string, invoiceId: string, daysOverdue: number) {
  await notify({
    tenantId,
    type: "invoice_overdue",
    title: "Invoice Overdue",
    message: `Invoice ${invoiceNumber} for ${partnerName} is ${daysOverdue} days overdue.`,
    entityType: "invoice",
    entityId: invoiceId,
    actionLabel: "View",
  });
}

export async function notifyLowStock(tenantId: string, productName: string, sku: string, stock: number, reorderLevel: number, productId: string) {
  await notify({
    tenantId,
    type: "low_stock_alert",
    title: "Low Stock Alert",
    message: `${productName} (${sku}) is below reorder level (${stock} < ${reorderLevel}).`,
    entityType: "product",
    entityId: productId,
    actionLabel: "View",
  });
}

export async function notifyPortalInviteSent(tenantId: string, partnerName: string, email: string, accessId: string) {
  await notify({
    tenantId,
    type: "portal_invite_sent",
    title: "Portal Invite Sent",
    message: `Welcome email sent to ${email} (${partnerName}).`,
    entityType: "portal_access",
    entityId: accessId,
  });
}
