import { getStore } from "@/lib/data/store";
import type { NotificationType, User } from "@/lib/supabase/types";

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

function escapeHtml(str: string): string {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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
