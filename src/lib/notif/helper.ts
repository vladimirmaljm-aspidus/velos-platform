import { getStore } from "@/lib/data/store";
import type { NotificationType, User } from "@/lib/supabase/types";
import { escapeHtml } from "@/lib/security/escape-html";

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
  // 8c-10: optional dedup key — when supplied, the helper consults the
  // store's new findRecentNotification() method BEFORE inserting. If a
  // notification with the same (partnerId, type, entityType, entityId)
  // tuple was already created within `dedupWindowMs` (default 5 min), the
  // helper skips the insert entirely. This collapses high-frequency
  // notification storms into a single bell-badge entry — e.g. a partner
  // sending 100 negotiation messages in 60s no longer produces 100 "New
  // marketplace message" notifications; the recipient sees ONE badge
  // bump for the whole burst. The dedup is best-effort: a store impl
  // that doesn't override findRecentNotification() (or one whose lookup
  // errors) falls through to the original insert path so notifications
  // are never SILENTLY dropped on a degraded store.
  dedupKey?: string;
  dedupWindowMs?: number; // default 5 * 60 * 1000 (5 min)
}): Promise<void> {
  try {
    const store = await getStore();

    // 8c-10: dedup pre-check. Only run when the caller supplied a
    // dedupKey AND targeted a specific partner — broadcast notifications
    // (partnerId === null) are NEVER deduped (they go to all admins, who
    // may need every instance). The lookup is scoped by (tenant, partner,
    // type, entityType, entityId) so two distinct negotiations on the
    // same post don't collapse into each other.
    if (opts.dedupKey && opts.partnerId) {
      const windowMs = opts.dedupWindowMs ?? 5 * 60 * 1000;
      try {
        const recent = await store.findRecentNotification(
          opts.tenantId,
          opts.partnerId,
          opts.type,
          opts.entityType ?? null,
          opts.entityId ?? null,
          windowMs,
        );
        if (recent) {
          // A notification for this same (partner, type, entity) tuple
          // was already created within the dedup window. Skip the insert
          // — the bell badge already reflects the prior instance.
          return;
        }
      } catch (dedupErr) {
        // Best-effort: a lookup failure must NOT silently swallow the
        // notification. Fall through to the original insert path so the
        // recipient still gets at least one bell entry.
        console.warn("[notify] dedup lookup failed, falling through to insert:", dedupErr);
      }
    }

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

// ============================================================
// Marketplace Q&A notifications (LOGIC-AUDIT-2 Fix 2)
// ============================================================
// Previously neither questions nor answers fired any notification —
// a question author had to manually poll the page to see whether
// someone had answered, and group members had to browse the group
// feed to see new questions. These helpers close that automation gap
// for the two highest-value events:
//   • New answer on a question → notify the question author
//   • New question in a group → notify each group member
//     (the API route iterates the member list per-recipient)
// Both fire-and-forget — failures are caught in `notify()`.
//
// `partnerId` here is the RECIPIENT (the partner the notification is
// addressed to), not the actor. The actor's name is in the message
// body for context.

export async function notifyMarketplaceAnswerPosted(
  tenantId: string,
  authorPartnerId: string,
  answererName: string,
  questionTitle: string,
  questionId: string,
) {
  await notify({
    tenantId,
    partnerId: authorPartnerId,
    type: "marketplace_message_received",
    title: "New answer to your question",
    message: `${answererName} answered: "${questionTitle.length > 80 ? questionTitle.slice(0, 80) + "…" : questionTitle}"`,
    entityType: "marketplace_questions",
    entityId: questionId,
    actionUrl: `/portal/marketplace/community`,
    actionLabel: "View answer",
  });
}

export async function notifyMarketplaceQuestionAskedToMember(
  tenantId: string,
  recipientPartnerId: string,
  askerName: string,
  questionTitle: string,
  questionId: string,
  groupName?: string | null,
) {
  await notify({
    tenantId,
    partnerId: recipientPartnerId,
    type: "marketplace_message_received",
    title: "New question" + (groupName ? ` in ${groupName}` : ""),
    message: `${askerName} asked: "${questionTitle.length > 100 ? questionTitle.slice(0, 100) + "…" : questionTitle}"`,
    entityType: "marketplace_questions",
    entityId: questionId,
    actionUrl: `/portal/marketplace/community`,
    actionLabel: "View question",
  });
}

// ============================================================
// FIX-NOTIF-A11Y — Marketplace collaboration event notifications
// ============================================================
// 4 long-missing notifications identified in the platform audit:
// contract-created, escrow-released, document-signed, event-registered.
// In each case the API route already wrote an audit log entry but never
// notified the *counterparty* — they had no in-app signal that the other
// side had acted. Each helper below is fire-and-forget (errors logged
// inside `notify()` so a transient DB blip never breaks the caller's
// response). The recipient is addressed by `partner_id` (the same path
// `notifyMarketplaceAnswerPosted` uses) — portal notifications route to
// a partner, not to a platform user.
//
// The route is responsible for resolving the counterparty's partner_id
// (the helpers are intentionally dumb about who "the counterparty" is —
// the route knows the context: which response was accepted, which
// partner is on the other side of the negotiation, which partner owns
// the event).

/**
 * Notify the counterparty that a long-term contract was created on a
 * marketplace post they had an accepted response to. Called from
 * `POST /api/marketplace/[id]/contract` after `createContract()`
 * succeeds — the route queries `marketplace_responses` for the
 * partner with `status='accepted'` on the post and passes their
 * partner_id as `counterpartyPartnerId`.
 */
export async function notifyContractCreated(
  tenantId: string,
  counterpartyPartnerId: string,
  contractId: string,
  postTitle: string,
): Promise<void> {
  await notify({
    tenantId,
    partnerId: counterpartyPartnerId,
    type: "marketplace_message_received",
    title: "A contract has been created",
    message: `A long-term contract for "${postTitle.length > 80 ? postTitle.slice(0, 80) + "…" : postTitle}" has been created. Review the delivery schedule and milestones.`,
    entityType: "marketplace_contract",
    entityId: contractId,
    actionUrl: `/portal/marketplace`,
    actionLabel: "View contract",
  });
}

/**
 * Notify the counterparty that the funds held in an escrow instrument
 * have been released to them. Called from
 * `POST /api/marketplace/finance/[id]/release` after `releaseEscrow()`
 * succeeds — the route reads `counterparty_partner_id` off the
 * instrument (or skips the notify when the escrow has no counterparty
 * recorded, e.g. a standalone instrument).
 */
export async function notifyEscrowReleased(
  tenantId: string,
  counterpartyPartnerId: string,
  escrowId: string,
  amount: number,
  currency: string,
): Promise<void> {
  await notify({
    tenantId,
    partnerId: counterpartyPartnerId,
    type: "marketplace_message_received",
    title: "Escrow funds released",
    message: `Escrow funds of ${Number(amount).toLocaleString()} ${currency} have been released to you.`,
    entityType: "marketplace_financial_instrument",
    entityId: escrowId,
    actionUrl: `/portal/marketplace`,
    actionLabel: "View escrow",
  });
}

/**
 * Notify the non-signing party that a trade document was digitally
 * signed by the issuer. Called from
 * `POST /api/marketplace/documents/[id]/sign` after `signDocument()`
 * succeeds — the route resolves the non-signing party from the doc's
 * `negotiation_id` (preferred) or `post_id` relationships and passes
 * their partner_id. Skips the notify when the doc is a standalone
 * document with no negotiation / post context (no counterparty to
 * notify).
 */
export async function notifyDocumentSigned(
  tenantId: string,
  nonSigningPartyPartnerId: string,
  documentId: string,
  documentTitle: string,
  signedByName?: string,
): Promise<void> {
  const title = "Document signed";
  const signer = signedByName ? `${signedByName} ` : "";
  const message =
    `${signer}signed: "${documentTitle.length > 80 ? documentTitle.slice(0, 80) + "…" : documentTitle}". ` +
    `The digital signature is now recorded on the document.`;
  await notify({
    tenantId,
    partnerId: nonSigningPartyPartnerId,
    type: "marketplace_message_received",
    title,
    message,
    entityType: "marketplace_trade_document",
    entityId: documentId,
    actionUrl: `/portal/documents`,
    actionLabel: "View document",
  });
}

/**
 * Notify the event organiser that a partner registered for their
 * event. Called from `POST /api/marketplace/events/[id]/register`
 * after `registerForEvent()` succeeds with `result.registered=true`
 * (skipped on the idempotent "already registered" path so the
 * organiser isn't spammed). The route looks up the event's
 * `organizer_partner_id` + `title` and the registrant's partner name.
 */
export async function notifyEventRegistered(
  tenantId: string,
  organiserPartnerId: string,
  eventId: string,
  eventTitle: string,
  registrantName: string,
): Promise<void> {
  await notify({
    tenantId,
    partnerId: organiserPartnerId,
    type: "marketplace_message_received",
    title: "New registration for your event",
    message: `${registrantName} registered for "${eventTitle.length > 80 ? eventTitle.slice(0, 80) + "…" : eventTitle}".`,
    entityType: "marketplace_event",
    entityId: eventId,
    actionUrl: `/portal/marketplace/community`,
    actionLabel: "View event",
  });
}

// ============================================================
// FEAT-1 / Trial approval system — super-admin notifications
// ============================================================
// `notifySuperAdminsOfSignupRequest` is called from
// `POST /api/auth/register` when a new tenant self-registers with
// status="pending_approval". It does two things:
//
//   1. Creates an in-app notification (type="signup_request") tied to
//      the PENDING tenant's tenant_id with user_id=null. The
//      notification's `action_url` deep-links into the super-admin
//      signup-requests queue. (Super_admins have tenant_id=NULL in
//      the users table so they can't receive notifications directly —
//      the notifications table has a NOT NULL tenant_id constraint.
//      The notification row is dormant on the pending tenant and the
//      signup-requests queue itself is the polling surface for
//      super_admins.)
//
//   2. Sends an email to every super_admin's registered email so
//      platform owners actually learn about the new signup in real
//      time. This is the only delivery path that reaches super_admins
//      directly — the in-app notification is for record-keeping +
//      the pending tenant's own audit trail.
//
// Both steps are best-effort (caught + logged) so a transient mail
// provider outage or a missing notification row never blocks the
// registration response.

export async function notifySuperAdminsOfSignupRequest(opts: {
  pendingTenantId: string;
  companyName: string;
  contactName: string;
  email: string;
  country: string;
  phone?: string | null;
  baseUrl?: string;
}): Promise<void> {
  const store = await getStore();

  // ── 1. In-app notification tied to the pending tenant ───────────────
  try {
    await store.createNotification({
      tenant_id: opts.pendingTenantId,
      user_id: null,
      partner_id: null,
      type: "signup_request" as NotificationType,
      title: "New signup request pending approval",
      message:
        `${opts.companyName} (${opts.contactName}, ${opts.email})` +
        ` requested access to VELOS.`,
      entity_type: "tenant",
      entity_id: opts.pendingTenantId,
      action_url: "/signup-requests",
      action_label: "Review request",
    });
  } catch (e) {
    console.error("[notifySuperAdminsOfSignupRequest] in-app failed:", e);
  }

  // ── 2. Email every super_admin ─────────────────────────────────────
  try {
    const allUsers = await store.listUsers("");
    const superAdmins = allUsers.filter(
      (u: User) => u.role === "super_admin" && u.active && u.email,
    );
    if (superAdmins.length === 0) return;

    const { sendEmail } = await import("@/lib/email/service");
    const loginUrl = opts.baseUrl ? `${opts.baseUrl}/` : "/";
    const subject = `New VELOS signup request: ${opts.companyName}`;
    const html = signupRequestEmailBody({
      contactName: opts.contactName,
      companyName: opts.companyName,
      email: opts.email,
      country: opts.country,
      phone: opts.phone ?? null,
      loginUrl,
    });

    // Fire-and-forget so a single bad address / SMTP blip doesn't
    // block the registration response. Failures are logged inside.
    void Promise.all(
      superAdmins.map((sa) =>
        sendEmail({
          to: sa.email,
          subject,
          html,
        }).catch((e) =>
          console.error(
            "[notifySuperAdminsOfSignupRequest] email to super_admin",
            sa.email,
            "failed:",
            e,
          ),
        ),
      ),
    );
  } catch (e) {
    console.error("[notifySuperAdminsOfSignupRequest] email batch failed:", e);
  }
}


function signupRequestEmailBody(opts: {
  contactName: string;
  companyName: string;
  email: string;
  country: string;
  phone: string | null;
  loginUrl: string;
}): string {
  // FEAT-2: rows is an array of [label, value] tuples, not string[] —
  // the previous annotation `string[]` failed because each row is a
  // 2-tuple (the .map(([k, v]) => …) below expects a destructurable pair).
  const rows: [string, string][] = [
    ["Company", escapeHtml(opts.companyName)],
    ["Contact", escapeHtml(opts.contactName)],
    ["Email", escapeHtml(opts.email)],
    ["Country", escapeHtml(opts.country)],
  ];
  if (opts.phone) rows.push(["Phone", escapeHtml(opts.phone)]);
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
      <div style="background: #b45309; color: white; padding: 30px; border-radius: 12px 12px 0 0;">
        <h1 style="margin: 0; font-size: 22px; font-weight: 600;">New signup request</h1>
        <p style="margin: 8px 0 0; opacity: 0.9; font-size: 14px;">A new workspace is waiting for approval</p>
      </div>
      <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <table style="width: 100%; font-size: 14px; color: #333; border-collapse: collapse;">
          ${rows
            .map(
              ([k, v]) =>
                `<tr><td style="padding: 6px 0; color: #6b7280; width: 120px;">${k}</td><td style="padding: 6px 0;">${v}</td></tr>`,
            )
            .join("")}
        </table>
        <div style="text-align: center; margin: 30px 0 10px;">
          <a href="${escapeHtml(opts.loginUrl)}" style="background: #b45309; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">
            Review in VELOS
          </a>
        </div>
        <p style="color: #888; font-size: 12px; line-height: 1.5; margin-top: 20px;">
          You are receiving this email because you are a VELOS platform administrator.
        </p>
      </div>
    </div>
  `;
}

// ============================================================
// FEAT-2 (Notifications + audit logs) — Issue 1 additions
// ============================================================
// Two long-missing notification paths the user flagged ("we don't have
// any active notifications visible to see what's new"):
//
//  1. `notifyTrialExpiringSoon` — tenant admins were only notified AFTER
//     their trial had expired (the subscription-sweep cron suspended them
//     with no warning). They had no chance to add a payment method or
//     request an extension before losing access. Now fires 48h before
//     trial_ends_at (queried server-side in the cron route).
//
//  2. `notifySuperAdminsOfSignup` — when a new tenant self-registers,
//     super_admins had no in-app signal (only the audit log entry). The
//     signup flow is now wired to fan out a per-super_admin notification.
//     Each super_admin with a tenant_id in the users table gets their own
//     row (so the bell badge reflects per-user read state); super_admins
//     without a tenant_id are skipped (notifications.tenant_id is NOT NULL
//     in the schema, so there's no platform-bucket to write to).

export async function notifyTrialExpiringSoon(
  tenantId: string,
  tenantName: string,
  trialEndsAt: string,
  daysLeft: number,
) {
  await notify({
    tenantId,
    userId: null, // broadcast to all tenant admins
    type: "system_message",
    title: "Trial expiring soon",
    message: `The trial for ${tenantName} expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"} (${new Date(trialEndsAt).toLocaleDateString()}). Add a payment method to avoid suspension.`,
    entityType: "tenant",
    entityId: tenantId,
    actionLabel: "Manage subscription",
  });
}

// ============================================================
// LOGIC-DEEP §5 — Trial / Subscription EXPIRED notifications
// ============================================================
// The subscription-sweep cron previously suspended expired trials +
// paid subscriptions SILENTLY — the tenant admin only discovered the
// suspension when they tried to log in (the login route returns 402
// with "Your workspace is suspended. Contact the platform
// administrator to reactivate it."). That UX is hostile: the admin
// already missed the 48h warning window (the warning fired at T-48h
// but they may not have been checking notifications), and they had
// no chance to learn about the actual suspension until it bit them.
//
// These helpers fire an in-app notification + email at the moment of
// suspension, so the admin sees both:
//   1. The 48h-pre-expiry "trial expiring soon" warning (still fires).
//   2. The post-suspension "trial expired / workspace suspended"
//      notification + email (new — fires when the cron actually
//      flips the row to `status=suspended`).
//
// Both are best-effort + idempotent at the cron layer (the cron
// counts only newly-suspended rows per run, so re-runs within the
// same minute don't double-fire).
export async function notifyTrialExpired(
  tenantId: string,
  tenantName: string,
  trialEndsAt: string | null,
) {
  const when = trialEndsAt
    ? new Date(trialEndsAt).toLocaleDateString()
    : "recently";
  await notify({
    tenantId,
    userId: null, // broadcast to all tenant admins
    type: "system_message",
    title: "Trial expired — workspace suspended",
    message:
      `The trial for ${tenantName} ended on ${when}. The workspace has been suspended — ` +
      `contact the platform administrator to reactivate it or upgrade to a paid plan.`,
    entityType: "tenant",
    entityId: tenantId,
    actionLabel: "Manage subscription",
  });
}

export async function notifySubscriptionExpired(
  tenantId: string,
  tenantName: string,
  subscriptionEnd: string | null,
) {
  const when = subscriptionEnd
    ? new Date(subscriptionEnd).toLocaleDateString()
    : "recently";
  await notify({
    tenantId,
    userId: null,
    type: "system_message",
    title: "Subscription expired — workspace suspended",
    message:
      `The subscription for ${tenantName} ended on ${when}. The workspace has been suspended — ` +
      `renew your subscription to restore access.`,
    entityType: "tenant",
    entityId: tenantId,
    actionLabel: "Manage subscription",
  });
}

/**
 * Email follow-up for the "trial expired / workspace suspended" event.
 * Same shape as `emailTrialExpiringSoon` — fans out to every active
 * admin of the tenant, best-effort per recipient.
 */
export async function emailTrialExpired(opts: {
  tenantId: string;
  tenantName: string;
  trialEndsAt: string | null;
  baseUrl?: string;
}): Promise<void> {
  const emails = await listTenantAdminEmails(opts.tenantId);
  if (emails.length === 0) return;
  try {
    const { sendEmail } = await import("@/lib/email/service");
    const manageUrl = opts.baseUrl
      ? `${opts.baseUrl.replace(/\/$/, "")}/settings`
      : "/settings";
    const when = opts.trialEndsAt
      ? new Date(opts.trialEndsAt).toLocaleDateString(undefined, {
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : "recently";
    const subject = `Your VELOS trial has ended — workspace suspended`;
    const html = trialExpiredEmailBody({
      tenantName: opts.tenantName,
      trialEndsAt: opts.trialEndsAt,
      when,
      manageUrl,
    });
    void Promise.all(
      emails.map((to) =>
        sendEmail({ tenantId: opts.tenantId, to, subject, html }).catch((e) =>
          console.error("[emailTrialExpired] to", to, "failed:", e),
        ),
      ),
    );
  } catch (e) {
    console.error("[emailTrialExpired] batch failed:", e);
  }
}

function trialExpiredEmailBody(opts: {
  tenantName: string;
  trialEndsAt: string | null;
  when: string;
  manageUrl: string;
}): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
      <div style="background: #b91c1c; color: white; padding: 30px; border-radius: 12px 12px 0 0;">
        <h1 style="margin: 0; font-size: 22px; font-weight: 600;">Trial expired</h1>
        <p style="margin: 8px 0 0; opacity: 0.9; font-size: 14px;">Your workspace has been suspended</p>
      </div>
      <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <p style="font-size: 14px; color: #333; line-height: 1.6;">
          Your VELOS trial for <strong>${escapeHtml(opts.tenantName)}</strong> ended on
          <strong>${escapeHtml(opts.when)}</strong>. The workspace has been automatically
          suspended — your team will not be able to sign in until the workspace is
          reactivated.
        </p>
        <p style="font-size: 14px; color: #333; line-height: 1.6; margin-top: 16px;">
          To restore access, sign in (platform administrators can still log in to a
          suspended workspace) and choose a paid plan under
          <em>Settings &rarr; Subscription</em>, or contact the platform administrator
          to request an extension.
        </p>
        <div style="text-align: center; margin: 30px 0 10px;">
          <a href="${escapeHtml(opts.manageUrl)}" style="background: #b45309; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">
            Manage subscription
          </a>
        </div>
        <p style="color: #888; font-size: 12px; line-height: 1.5; margin-top: 20px;">
          You are receiving this email because you are an administrator of this VELOS workspace.
        </p>
      </div>
    </div>
  `;
}

/**
 * Notify every super_admin user of a platform-level event (new tenant
 * signup, plan-upgrade request, etc.). The notifications table requires
 * a non-null tenant_id, so we look up each super_admin's tenant_id and
 * create a per-user notification addressed to them on their own tenant.
 *
 * Super_admins without a tenant_id (pure platform-level accounts in some
 * deployments) are skipped — there's no bucket to write to. Those users
 * still see the underlying audit log entry in the platform-audit view.
 */
export async function notifySuperAdminsOfEvent(opts: {
  type: NotificationType;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
  actionLabel?: string;
  actionUrl?: string;
}): Promise<void> {
  try {
    const store = await getStore();
    // Fetch all active super_admin users. The store interface doesn't
    // expose a "list by role" method, so we hit Supabase directly via
    // the same service-role client the store uses — defense-in-depth
    // is provided by the requireSuperAdmin gates on every surface that
    // could create these events (the audit log entry for tenant.register
    // is written by the public register route, but the notification is
    // written by this helper invoked from that same route — the caller
    // is therefore already inside an authorized context).
    const sb = (store as any).sb?.();
    if (!sb) return; // MockStore / PrismaStore in tests — no-op gracefully
    const { data, error } = await sb
      .from("users")
      .select("id, tenant_id, username")
      .eq("role", "super_admin")
      .eq("active", true);
    if (error) throw error;
    const admins = (data as { id: string; tenant_id: string | null; username: string | null }[]) || [];
    // Fan out — one notification per super_admin (per-user read state).
    // Fire-and-forget per recipient; one failure shouldn't abort the others.
    await Promise.all(
      admins
        .filter((a) => a.tenant_id) // skip platform-level super_admins (no tenant to write to)
        .map((a) =>
          store.createNotification({
            tenant_id: a.tenant_id as string,
            user_id: a.id,
            partner_id: null,
            type: opts.type,
            title: opts.title,
            message: opts.message,
            entity_type: opts.entityType || null,
            entity_id: opts.entityId || null,
            action_url: opts.actionUrl || null,
            action_label: opts.actionLabel || null,
          }).catch((e) => console.error("[notifySuperAdmins]", a.username, e)),
        ),
    );
  } catch (e) {
    console.error("[notifySuperAdminsOfEvent]", e);
  }
}

/**
 * Convenience wrapper for new-tenant signups. Fire-and-forget from
 * /api/auth/register after the tenant + user + audit row are committed.
 */
export async function notifySuperAdminsOfSignup(opts: {
  companyName: string;
  contactName: string;
  email: string;
  country: string;
  tenantId: string;
}): Promise<void> {
  await notifySuperAdminsOfEvent({
    type: "system_message",
    title: "New tenant signed up",
    message: `${opts.companyName} (${opts.country}) just registered a trial. Contact: ${opts.contactName} <${opts.email}>.`,
    entityType: "tenant",
    entityId: opts.tenantId,
    actionLabel: "View tenant",
  });
}

// ============================================================
// FIX-NOTIF-A11Y — Email follow-ups for time-sensitive notifications
// ============================================================
// The audit found that trial-expiring-soon and invoice-overdue were
// notified IN-APP only — admins had to log in to learn about them,
// which defeats the time-sensitive purpose (a trial expiring in 48h
// needs the admin to add a payment method BEFORE suspension; an
// overdue invoice needs finance to chase payment before it ages
// further). The two helpers below email every active admin user of
// the tenant via `sendEmail` (the multi-provider service that queues
// to mail_queue if no provider is configured, so the email still
// surfaces in the Mail Queue view even when SMTP isn't set up).
//
// Both are best-effort — failures are caught per-recipient so a
// single bad address doesn't abort the batch, and the cron route
// continues regardless (the in-app notification is the source of
// truth; the email is a bonus delivery path).

/**
 * Look up every active admin user for a tenant and return their
 * email addresses. Used by the email-follow-up helpers below so we
 * don't fan out to user-role accounts (only admins can act on trial
 * expiry / overdue invoices). Super_admins are NOT included here —
 * they're notified separately via `notifySuperAdminsOfEvent` and a
 * tenant's billing state is the tenant admin's concern, not the
 * platform operator's.
 */
async function listTenantAdminEmails(tenantId: string): Promise<string[]> {
  try {
    const store = await getStore();
    const users = await store.listUsers(tenantId);
    return (users as User[])
      .filter((u) => u.active && u.email && (u.role === "admin"))
      .map((u) => u.email);
  } catch (e) {
    console.error("[listTenantAdminEmails]", e);
    return [];
  }
}

/**
 * Send the "trial expiring soon" email to every tenant admin. Called
 * by the subscription-sweep cron immediately after the in-app
 * `notifyTrialExpiringSoon` call. The cron's idempotency guard
 * (skip if a "Trial expiring soon" notification row already exists)
 * runs BEFORE this function is reached, so each tenant gets at most
 * one email per trial. Best-effort: per-recipient try/catch so one
 * bad address doesn't block the batch.
 */
export async function emailTrialExpiringSoon(opts: {
  tenantId: string;
  tenantName: string;
  trialEndsAt: string;
  daysLeft: number;
  baseUrl?: string;
}): Promise<void> {
  const emails = await listTenantAdminEmails(opts.tenantId);
  if (emails.length === 0) return;
  try {
    const { sendEmail } = await import("@/lib/email/service");
    const manageUrl = opts.baseUrl
      ? `${opts.baseUrl.replace(/\/$/, "")}/settings`
      : "/settings";
    const subject = `Your VELOS trial expires in ${opts.daysLeft} day${opts.daysLeft === 1 ? "" : "s"}`;
    const html = trialExpiringEmailBody({
      tenantName: opts.tenantName,
      trialEndsAt: opts.trialEndsAt,
      daysLeft: opts.daysLeft,
      manageUrl,
    });
    // Fire-and-forget per recipient — one bad address must not abort
    // the batch. Each failure is logged so the Mail Queue view can
    // surface it.
    void Promise.all(
      emails.map((to) =>
        sendEmail({ tenantId: opts.tenantId, to, subject, html }).catch((e) =>
          console.error("[emailTrialExpiringSoon] to", to, "failed:", e),
        ),
      ),
    );
  } catch (e) {
    console.error("[emailTrialExpiringSoon] batch failed:", e);
  }
}

function trialExpiringEmailBody(opts: {
  tenantName: string;
  trialEndsAt: string;
  daysLeft: number;
  manageUrl: string;
}): string {
  const expiryDate = new Date(opts.trialEndsAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
      <div style="background: #b45309; color: white; padding: 30px; border-radius: 12px 12px 0 0;">
        <h1 style="margin: 0; font-size: 22px; font-weight: 600;">Trial expiring soon</h1>
        <p style="margin: 8px 0 0; opacity: 0.9; font-size: 14px;">Add a payment method to avoid suspension</p>
      </div>
      <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <p style="font-size: 14px; color: #333; line-height: 1.6;">
          Your VELOS trial for <strong>${escapeHtml(opts.tenantName)}</strong> expires in
          <strong>${opts.daysLeft} day${opts.daysLeft === 1 ? "" : "s"}</strong>
          (on ${escapeHtml(expiryDate)}). After that, the workspace will be suspended and your
          team will lose access to the platform until a payment method is added or a plan is
          selected.
        </p>
        <p style="font-size: 14px; color: #333; line-height: 1.6; margin-top: 16px;">
          To keep the workspace active, sign in and add a payment method under
          <em>Settings &rarr; Subscription</em> before the trial ends.
        </p>
        <div style="text-align: center; margin: 30px 0 10px;">
          <a href="${escapeHtml(opts.manageUrl)}" style="background: #b45309; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">
            Manage subscription
          </a>
        </div>
        <p style="color: #888; font-size: 12px; line-height: 1.5; margin-top: 20px;">
          You are receiving this email because you are an administrator of this VELOS workspace.
        </p>
      </div>
    </div>
  `;
}

/**
 * Send an "invoice overdue" email to every tenant admin. Called by
 * the invoice-overdue cron immediately after the in-app `notify`
 * call. Best-effort: per-recipient try/catch.
 */
export async function emailInvoiceOverdue(opts: {
  tenantId: string;
  partnerName: string | null;
  invoiceNumber: string;
  daysOverdue: number;
  invoiceUrl?: string;
  baseUrl?: string;
}): Promise<void> {
  const emails = await listTenantAdminEmails(opts.tenantId);
  if (emails.length === 0) return;
  try {
    const { sendEmail } = await import("@/lib/email/service");
    const viewUrl = opts.invoiceUrl
      ? opts.invoiceUrl
      : opts.baseUrl
        ? `${opts.baseUrl.replace(/\/$/, "")}/invoices`
        : "/invoices";
    const subject = `Invoice ${opts.invoiceNumber} is overdue`;
    const html = invoiceOverdueEmailBody({
      partnerName: opts.partnerName,
      invoiceNumber: opts.invoiceNumber,
      daysOverdue: opts.daysOverdue,
      viewUrl,
    });
    void Promise.all(
      emails.map((to) =>
        sendEmail({ tenantId: opts.tenantId, to, subject, html }).catch((e) =>
          console.error("[emailInvoiceOverdue] to", to, "failed:", e),
        ),
      ),
    );
  } catch (e) {
    console.error("[emailInvoiceOverdue] batch failed:", e);
  }
}

function invoiceOverdueEmailBody(opts: {
  partnerName: string | null;
  invoiceNumber: string;
  daysOverdue: number;
  viewUrl: string;
}): string {
  const partnerLine = opts.partnerName
    ? ` for <strong>${escapeHtml(opts.partnerName)}</strong>`
    : "";
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
      <div style="background: #b91c1c; color: white; padding: 30px; border-radius: 12px 12px 0 0;">
        <h1 style="margin: 0; font-size: 22px; font-weight: 600;">Invoice overdue</h1>
        <p style="margin: 8px 0 0; opacity: 0.9; font-size: 14px;">Action may be needed to chase payment</p>
      </div>
      <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <p style="font-size: 14px; color: #333; line-height: 1.6;">
          Invoice <strong>${escapeHtml(opts.invoiceNumber)}</strong>${partnerLine}
          is now <strong>${opts.daysOverdue} day${opts.daysOverdue === 1 ? "" : "s"}</strong>
          past its due date. The invoice has been automatically marked as overdue in VELOS.
        </p>
        <p style="font-size: 14px; color: #333; line-height: 1.6; margin-top: 16px;">
          Sign in to review the invoice, record a payment, or contact the customer to follow up.
        </p>
        <div style="text-align: center; margin: 30px 0 10px;">
          <a href="${escapeHtml(opts.viewUrl)}" style="background: #b91c1c; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">
            View invoices
          </a>
        </div>
        <p style="color: #888; font-size: 12px; line-height: 1.5; margin-top: 20px;">
          You are receiving this email because you are an administrator of this VELOS workspace.
        </p>
      </div>
    </div>
  `;
}
