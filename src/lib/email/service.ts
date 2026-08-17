import nodemailer from "nodemailer";
import { getStore } from "@/lib/data/store";

/**
 * Escape HTML special characters to prevent XSS in email templates.
 * User-provided values (partnerName, tenantName, docNumber, message body)
 * are interpolated directly into HTML — without escaping, an admin could
 * rename a tenant to `<img src=x onerror=...>` and inject it into every
 * email body. (Audit finding P2-4.)
 */
function escapeHtml(str: string): string {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Email service — multi-provider.
 *
 * Providers (selected per-tenant in Settings → Communications):
 *   1. resend    — HTTP API, recommended. No SMTP port blocks, works on Render free.
 *                  Free tier: 100 emails/day, 3000/month. https://resend.com
 *   2. postmark  — HTTP API by Wildbit. Reliable transactional email.
 *                  Free trial: 100 emails/month. https://postmarkapp.com
 *   3. smtp      — traditional SMTP. Works when the host allows outbound SMTP
 *                  (Render free plan blocks ports 465/587 — use Resend/Postmark instead).
 *
 * If no provider is configured, emails are queued in the mail_queue table
 * (dev mode) so they can be retried once a provider is set up.
 */

interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  tenantId?: string;
  attachments?: EmailAttachment[];
  /**
   * Optional per-message Reply-To address. Overrides the comms blob's
   * `reply_to` field when set — used by the breach-notification
   * dispatcher so the supervisory authority can reply to the DPO contact
   * even if the tenant's comms config has no reply_to set.
   */
  replyTo?: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  fromName: string;
  fromEmail: string;
}

interface ResendConfig {
  apiKey: string;
  fromName: string;
  fromEmail: string;
  /** Optional — reply-to address */
  replyTo?: string;
}

interface PostmarkConfig {
  serverToken: string;
  fromName: string;
  fromEmail: string;
  /** Optional — reply-to address */
  replyTo?: string;
  /** Optional — Postmark message stream (default "outbound") */
  messageStream?: string;
}

export type EmailProvider = "resend" | "postmark" | "smtp" | "none";

interface EmailConfig {
  provider: EmailProvider;
  smtp?: SmtpConfig;
  resend?: ResendConfig;
  postmark?: PostmarkConfig;
  fromName: string;
  fromEmail: string;
}

/**
 * Load the email configuration for a tenant (or the global config).
 * Returns the resolved provider + its credentials.
 */
export async function getEmailConfig(tenantId?: string): Promise<EmailConfig | null> {
  const store = await getStore();
  // Prefer the tenant's own comms config; fall back to platform-level (tenant_id NULL).
  let comms = tenantId ? await store.getSetting<any>("comms", tenantId) : null;
  if (!comms) comms = await store.getSetting<any>("comms", null);
  if (!comms) return null;

  const provider: EmailProvider = comms.email_provider || (comms.smtp_host ? "smtp" : "none");
  const fromName = comms.from_name || "VELOS CRM";
  const fromEmail = comms.from_email || process.env.NOREPLY_EMAIL || "noreply@aspidus.onrender.com";

  const config: EmailConfig = { provider, fromName, fromEmail };

  if (comms.smtp_host && comms.smtp_user) {
    config.smtp = {
      host: comms.smtp_host,
      port: comms.smtp_port || 587,
      user: comms.smtp_user,
      password: comms.smtp_password || "",
      fromName,
      fromEmail,
    };
  }

  if (comms.resend_api_key) {
    config.resend = {
      apiKey: comms.resend_api_key,
      fromName,
      fromEmail: comms.resend_from_email || fromEmail,
      replyTo: comms.reply_to || undefined,
    };
  }

  if (comms.postmark_server_token) {
    config.postmark = {
      serverToken: comms.postmark_server_token,
      fromName,
      fromEmail: comms.postmark_from_email || fromEmail,
      replyTo: comms.reply_to || undefined,
      messageStream: comms.postmark_message_stream || "outbound",
    };
  }

  return config;
}

/**
 * Send an email using the configured provider.
 * Falls back to queueing in mail_queue if no provider is set up.
 */
export async function sendEmail(opts: SendEmailOptions): Promise<{ success: boolean; error?: string; messageId?: string; provider?: EmailProvider }> {
  const config = await getEmailConfig(opts.tenantId);

  // No provider configured — queue for later
  if (
    !config ||
    config.provider === "none" ||
    (config.provider === "smtp" && !config.smtp) ||
    (config.provider === "resend" && !config.resend) ||
    (config.provider === "postmark" && !config.postmark)
  ) {
    console.log(`[email:dev] To: ${opts.to} | Subject: ${opts.subject}`);
    const store = await getStore();
    // P1 mail_queue orphan fix (task C-5 Fix 3): previously this insert
    // omitted `tenant_id`, producing orphaned mail_queue rows that no
    // tenant-scoped listMailQueue query could ever surface — they
    // accumulated forever in the table with status='queued' and no
    // visible owner. The `notifications` table has a NOT NULL constraint
    // on tenant_id, so the in-app notification path (below in the catch
    // block) already required a tenant_id and was silently skipped when
    // it was missing — but the mail_queue insert itself was not gated,
    // which is exactly how the orphans accumulated.
    //
    // Resolution: always set tenant_id. If the caller genuinely has no
    // tenant context (e.g. a system-level cron job that emails a global
    // admin address), fall back to the literal sentinel "SYSTEM" so the
    // row is still visible in a super-admin "all mail queue" listing
    // (filtered as `tenant_id = 'SYSTEM'`) rather than being a NULL
    // orphan that no query surfaces.
    await store.upsertMailQueueEntry({
      to_email: opts.to,
      subject: opts.subject,
      body: opts.html,
      status: "queued",
      tenant_id: opts.tenantId || "SYSTEM",
    } as any);
    return { success: true, messageId: "dev-queued", provider: "none" };
  }

  try {
    let result: { success: boolean; messageId?: string; error?: string };

    if (config.provider === "resend" && config.resend) {
      result = await sendViaResend(opts, config.resend);
    } else if (config.provider === "postmark" && config.postmark) {
      result = await sendViaPostmark(opts, config.postmark);
    } else if (config.provider === "smtp" && config.smtp) {
      result = await sendViaSmtp(opts, config.smtp);
    } else {
      throw new Error("No email provider available");
    }

    if (!result.success) throw new Error(result.error || "Unknown error");
    return { success: true, messageId: result.messageId, provider: config.provider };
  } catch (e: any) {
    console.error("[email:error]", e.message);
    // Queue for manual retry (Re-Audit-2 N9: previously the queue entry was
    // terminal — no worker ever picked it up, no notification fired, no
    // retry endpoint existed). We now keep the queue entry AND emit an
    // in-app notification so the admin can see the failure and hit the
    // Retry button in the Mail Queue view. NO auto-retry (per audit rule).
    const store = await getStore();
    let queueEntryId: string | undefined;
    try {
      const entry = await store.upsertMailQueueEntry({
        to_email: opts.to,
        subject: opts.subject,
        body: opts.html,
        status: "failed",
        attempts: 1,
        error: e.message,
        // P1 mail_queue orphan fix (task C-5 Fix 3): same sentinel
        // pattern as the no-provider branch above — a NULL tenant_id
        // here would create an invisible orphan row. The notification
        // broadcast below only fires when `opts.tenantId` is set (the
        // notifications table has a NOT NULL constraint on tenant_id),
        // but the mail_queue row should NOT silently depend on that
        // same gate.
        tenant_id: opts.tenantId || "SYSTEM",
      } as any);
      queueEntryId = (entry as any)?.id;
    } catch (queueErr) {
      console.error("[email] failed to persist mail_queue entry:", queueErr);
    }

    // Broadcast an in-app notification to all tenant admins (user_id = null)
    // so the failure is visible in the notification dropdown — they can then
    // click through to the Mail Queue and hit Retry. The `notifications` table
    // has `tenant_id NOT NULL`, so we only fire when we have a tenantId.
    if (opts.tenantId) {
      try {
        const { notify } = await import("@/lib/notif/helper");
        await notify({
          tenantId: opts.tenantId,
          userId: null, // broadcast to all admins
          type: "email_failed",
          title: `Email failed: ${opts.subject}`.slice(0, 200),
          message:
            `Recipient: ${opts.to}\n` +
            `Subject: ${opts.subject}\n` +
            `Error: ${e.message}\n\n` +
            `Open the Mail Queue to retry sending.`,
          entityType: "mail_queue",
          entityId: queueEntryId,
          actionUrl: "/mail-queue",
          actionLabel: "Open Mail Queue",
        });
      } catch (notifErr) {
        console.error("[email] notification creation failed:", notifErr);
      }
    }

    return { success: false, error: e.message, provider: config.provider };
  }
}

// ============================================================
// Provider: Resend (HTTP API — recommended)
// ============================================================

async function sendViaResend(opts: SendEmailOptions, cfg: ResendConfig): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const payload: Record<string, unknown> = {
    from: `${cfg.fromName} <${cfg.fromEmail}>`,
    to: [opts.to],
    subject: opts.subject,
    html: opts.html,
  };
  if (opts.text) payload.text = opts.text;
  // Per-message Reply-To takes precedence over the comms-blob reply_to
  // (so the breach-notification dispatcher can route replies to the DPO
  // contact even if the tenant's comms config has no reply_to set).
  const replyTo = opts.replyTo || cfg.replyTo;
  if (replyTo) payload.reply_to = replyTo;

  // Attachments — Resend expects base64 content
  if (opts.attachments && opts.attachments.length > 0) {
    payload.attachments = opts.attachments.map((a) => ({
      filename: a.filename,
      content: a.content.toString("base64"),
      content_type: a.contentType,
    }));
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    let errMsg = `Resend API error ${res.status}`;
    try {
      const errJson = JSON.parse(errText);
      errMsg = errJson.message || errJson.error || errMsg;
    } catch {
      errMsg = errText || errMsg;
    }
    return { success: false, error: errMsg };
  }

  const data = await res.json();
  return { success: true, messageId: data.id };
}

// ============================================================
// Provider: Postmark (HTTP API by Wildbit)
// ============================================================

async function sendViaPostmark(opts: SendEmailOptions, cfg: PostmarkConfig): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const payload: Record<string, unknown> = {
    From: `${cfg.fromName} <${cfg.fromEmail}>`,
    To: opts.to,
    Subject: opts.subject,
    HtmlBody: opts.html,
    MessageStream: cfg.messageStream || "outbound",
  };
  if (opts.text) payload.TextBody = opts.text;
  // Per-message Reply-To takes precedence over the comms-blob reply_to.
  const replyTo = opts.replyTo || cfg.replyTo;
  if (replyTo) payload.ReplyTo = replyTo;

  // Attachments — Postmark expects base64 content
  if (opts.attachments && opts.attachments.length > 0) {
    payload.Attachments = opts.attachments.map((a) => ({
      Name: a.filename,
      Content: a.content.toString("base64"),
      ContentType: a.contentType,
    }));
  }

  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": cfg.serverToken,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    let errMsg = `Postmark API error ${res.status}`;
    try {
      const errJson = JSON.parse(errText);
      errMsg = errJson.Message || errJson.message || errMsg;
    } catch {
      errMsg = errText || errMsg;
    }
    return { success: false, error: errMsg };
  }

  const data = await res.json();
  return { success: true, messageId: data.MessageID };
}

// ============================================================
// Provider: SMTP (traditional)
// ============================================================

async function sendViaSmtp(opts: SendEmailOptions, cfg: SmtpConfig): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });

  // Per-message Reply-To (e.g. the DPO contact for breach notifications)
  // — nodemailer accepts `replyTo` directly on the message object.
  const mailOpts: Record<string, unknown> = {
    from: `"${cfg.fromName}" <${cfg.fromEmail}>`,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text || opts.html.replace(/<[^>]*>/g, ""),
    attachments: opts.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  };
  if (opts.replyTo) mailOpts.replyTo = opts.replyTo;

  const info = await transporter.sendMail(mailOpts);

  return { success: true, messageId: info.messageId };
}

// ============================================================
// Email templates
// ============================================================

export function welcomePortalEmail(opts: {
  partnerName: string;
  portalEmail: string;
  accessId: string;
  tenantName: string;
  baseUrl: string;
  tier: string;
  /**
   * One-time hashed setup token (audit F-6/P1-3 portal invite TTL).
   * When provided, the invite link is `/portal/login?setup_token=xxx`
   * — a single-use, 7-day-expiring token from the `password_resets`
   * table. The previous `?access_id=xxx` link used a permanent UUID
   * that never expired; if the email leaked (forwarded, breach) the
   * recipient could set a password at any future time as long as
   * `must_set_password` was still true.
   *
   * Optional only for backward-compat with callers that haven't been
   * updated yet — all new invites SHOULD pass a setupToken.
   */
  setupToken?: string | null;
}): { subject: string; html: string } {
  // Prefer the token-based URL when a setupToken is available; fall back
  // to the legacy access_id URL only when explicitly missing (older callers).
  const setupUrl = opts.setupToken
    ? `${opts.baseUrl}/portal/login?setup_token=${encodeURIComponent(opts.setupToken)}`
    : `${opts.baseUrl}/portal/login?access_id=${encodeURIComponent(opts.accessId)}`;
  const subject = `Welcome to ${opts.tenantName} Client Portal`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
      <div style="background: #0f766e; color: white; padding: 30px; border-radius: 12px 12px 0 0;">
        <h1 style="margin: 0; font-size: 24px; font-weight: 600;">Welcome to ${escapeHtml(opts.tenantName)}</h1>
        <p style="margin: 8px 0 0; opacity: 0.9; font-size: 14px;">Your client portal account is ready</p>
      </div>
      <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <p style="color: #333; font-size: 15px; line-height: 1.6;">Hello ${escapeHtml(opts.partnerName)},</p>
        <p style="color: #555; font-size: 14px; line-height: 1.6;">
          Your account has been created with <strong style="text-transform: capitalize;">${escapeHtml(opts.tier)}</strong> tier access.
          You can now view your offers, download documents, browse our product catalog, and submit requests.
        </p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${setupUrl}" style="background: #0f766e; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">
            Set Up Your Password
          </a>
        </div>
        <p style="color: #888; font-size: 12px; line-height: 1.5;">
          This link will expire in 7 days. If you didn't expect this email, please ignore it.
        </p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <h3 style="color: #333; font-size: 14px; margin: 0 0 8px;">What you can do in the portal:</h3>
        <ul style="color: #555; font-size: 13px; line-height: 1.8; padding-left: 20px;">
          <li>View and download your offers and invoices</li>
          <li>Browse our product catalog with specifications</li>
          <li>Request quotes for products not in catalog</li>
          <li>Complete your KYC verification (if required)</li>
          <li>Update your profile and company information</li>
        </ul>
      </div>
      <p style="text-align: center; color: #999; font-size: 11px; margin-top: 20px;">
        © ${new Date().getFullYear()} ${escapeHtml(opts.tenantName)}. Powered by Aspidus.
      </p>
    </div>
  `;
  return { subject, html };
}

export function documentEmail(opts: {
  partnerName: string;
  docType: string; // "offer", "invoice", "proforma"
  docNumber: string;
  tenantName: string;
  amount?: string;
  currency?: string;
  dueDate?: string;
}): { subject: string; html: string } {
  const typeLabel = opts.docType.charAt(0).toUpperCase() + opts.docType.slice(1);
  const subject = `${typeLabel} ${opts.docNumber} — ${opts.tenantName}`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
      <div style="background: #0f766e; color: white; padding: 30px; border-radius: 12px 12px 0 0;">
        <h1 style="margin: 0; font-size: 22px; font-weight: 600;">${typeLabel} ${escapeHtml(opts.docNumber)}</h1>
        <p style="margin: 8px 0 0; opacity: 0.9; font-size: 14px;">From ${escapeHtml(opts.tenantName)}</p>
      </div>
      <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <p style="color: #333; font-size: 15px; line-height: 1.6;">Hello ${escapeHtml(opts.partnerName)},</p>
        <p style="color: #555; font-size: 14px; line-height: 1.6;">
          Please find attached your ${typeLabel.toLowerCase()} <strong>${escapeHtml(opts.docNumber)}</strong>.
          ${opts.amount ? `The total amount is <strong>${escapeHtml(opts.currency || "")} ${escapeHtml(opts.amount)}</strong>.` : ''}
          ${opts.dueDate ? `Due date: <strong>${escapeHtml(opts.dueDate)}</strong>.` : ''}
        </p>
        <p style="color: #555; font-size: 14px; line-height: 1.6;">
          The document is attached as a PDF file. Please review it and contact us if you have any questions.
        </p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="color: #888; font-size: 12px; line-height: 1.5;">
          This is an automated message from ${escapeHtml(opts.tenantName)}. Please do not reply to this email.
        </p>
      </div>
      <p style="text-align: center; color: #999; font-size: 11px; margin-top: 20px;">
        © ${new Date().getFullYear()} ${escapeHtml(opts.tenantName)}. Powered by Aspidus.
      </p>
    </div>
  `;
  return { subject, html };
}

export function kycStatusEmail(opts: {
  partnerName: string;
  to: string;
  status: string;
  tenantName: string;
  reason?: string | null;
  portalUrl?: string;
}): { subject: string; html: string } {
  const approved = opts.status === "approved";
  const rejected = opts.status === "rejected";
  const resubmit = opts.status === "resubmit";

  const subject = approved
    ? `KYC Approved — ${opts.tenantName}`
    : rejected
    ? `KYC Rejected — ${opts.tenantName}`
    : `KYC Update Required — ${opts.tenantName}`;

  const headerColor = approved ? "#0f766e" : rejected ? "#dc2626" : "#f59e0b";
  const headerLabel = approved ? "KYC Approved" : rejected ? "KYC Rejected" : "KYC Update Required";
  const noteBlock = opts.reason
    ? `<div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:14px 16px;border-radius:6px;margin:16px 0;">
         <p style="color:#78350f;font-size:13px;font-weight:600;margin:0 0 6px;">${resubmit ? "What we need from you:" : "Reason:"}</p>
         <p style="color:#78350f;font-size:14px;line-height:1.5;margin:0;white-space:pre-wrap;">${escapeHtml(opts.reason)}</p>
       </div>`
    : "";
  const cta = opts.portalUrl && !rejected
    ? `<div style="text-align:center;margin:24px 0;">
         <a href="${opts.portalUrl}" style="background:${headerColor};color:white;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;font-size:14px;">
           ${approved ? "Open Portal" : "Update Submission"}
         </a>
       </div>`
    : "";

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
      <div style="background: ${headerColor}; color: white; padding: 30px; border-radius: 12px 12px 0 0;">
        <h1 style="margin: 0; font-size: 22px;">${headerLabel}</h1>
        <p style="margin: 8px 0 0; opacity: 0.9; font-size: 14px;">${escapeHtml(opts.tenantName)}</p>
      </div>
      <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <p style="color: #333; font-size: 15px;">Hello ${escapeHtml(opts.partnerName)},</p>
        <p style="color: #555; font-size: 14px; line-height: 1.6;">
          ${approved
            ? "Your KYC verification has been approved. Your account is now fully active — you can access offers, invoices and documents in the portal."
            : rejected
            ? "Unfortunately your KYC submission has been rejected."
            : "Your KYC submission needs additional information before we can approve it. Please review the note below and update your submission in the portal."}
        </p>
        ${noteBlock}
        ${cta}
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="color: #888; font-size: 12px; line-height: 1.5;">
          This is an automated notification from ${escapeHtml(opts.tenantName)}. If you have questions, reply to this email or message us in the portal.
        </p>
      </div>
      <p style="text-align: center; color: #999; font-size: 11px; margin-top: 20px;">
        © ${new Date().getFullYear()} ${escapeHtml(opts.tenantName)}. Powered by Aspidus.
      </p>
    </div>
  `;
  return { subject, html };
}

/**
 * Notify a portal partner that a new document has been shared with them
 * (a manually shared PDF, not one of the automatic offer/invoice mails).
 */
export function shareDocumentEmail(opts: {
  partnerName: string;
  documentName: string;
  documentType?: string;
  tenantName: string;
  message?: string | null;
  portalUrl: string;
}): { subject: string; html: string } {
  const subject = `New document shared — ${opts.documentName}`;
  const msgBlock = opts.message
    ? `<div style="background:#f0fdfa;border-left:4px solid #0f766e;padding:14px 16px;border-radius:6px;margin:16px 0;">
         <p style="color:#134e4a;font-size:13px;font-weight:600;margin:0 0 6px;">Message from ${escapeHtml(opts.tenantName)}:</p>
         <p style="color:#134e4a;font-size:14px;line-height:1.5;margin:0;white-space:pre-wrap;">${escapeHtml(opts.message)}</p>
       </div>`
    : "";
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
      <div style="background: #0f766e; color: white; padding: 30px; border-radius: 12px 12px 0 0;">
        <h1 style="margin: 0; font-size: 22px;">New document shared</h1>
        <p style="margin: 8px 0 0; opacity: 0.9; font-size: 14px;">${escapeHtml(opts.tenantName)}</p>
      </div>
      <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <p style="color: #333; font-size: 15px;">Hello ${escapeHtml(opts.partnerName)},</p>
        <p style="color: #555; font-size: 14px; line-height: 1.6;">
          A new ${escapeHtml(opts.documentType || "document")} <strong>${escapeHtml(opts.documentName)}</strong> is now available in your portal.
        </p>
        ${msgBlock}
        <div style="text-align:center;margin:24px 0;">
          <a href="${opts.portalUrl}" style="background:#0f766e;color:white;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;font-size:14px;">
            Open Documents
          </a>
        </div>
      </div>
      <p style="text-align:center;color:#999;font-size:11px;margin-top:20px;">
        © ${new Date().getFullYear()} ${escapeHtml(opts.tenantName)}. Powered by Aspidus.
      </p>
    </div>
  `;
  return { subject, html };
}

/**
 * Notify an admin/portal user that a new message has arrived on the internal
 * portal-chat thread (partner → admin or admin → partner).
 */
export function newMessageEmail(opts: {
  toName: string;
  fromName: string;
  preview: string;
  tenantName: string;
  portalUrl: string;
  direction: "portal_to_admin" | "admin_to_portal";
}): { subject: string; html: string } {
  const subject = opts.direction === "portal_to_admin"
    ? `New portal message from ${opts.fromName}`
    : `New message from ${opts.tenantName}`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
      <div style="background: #0f766e; color: white; padding: 30px; border-radius: 12px 12px 0 0;">
        <h1 style="margin: 0; font-size: 22px;">New message</h1>
        <p style="margin: 8px 0 0; opacity: 0.9; font-size: 14px;">from ${escapeHtml(opts.fromName)}</p>
      </div>
      <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <p style="color: #333; font-size: 15px;">Hello ${escapeHtml(opts.toName)},</p>
        <p style="color: #555; font-size: 14px; line-height: 1.6;">
          <strong>${escapeHtml(opts.fromName)}</strong> sent you a message.
        </p>
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0;">
          <p style="color:#374151;font-size:14px;line-height:1.6;margin:0;white-space:pre-wrap;">${escapeHtml(opts.preview.slice(0, 400))}${opts.preview.length > 400 ? "…" : ""}</p>
        </div>
        <div style="text-align:center;margin:24px 0;">
          <a href="${opts.portalUrl}" style="background:#0f766e;color:white;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;font-size:14px;">
            Open Messages
          </a>
        </div>
      </div>
      <p style="text-align:center;color:#999;font-size:11px;margin-top:20px;">
        © ${new Date().getFullYear()} ${escapeHtml(opts.tenantName)}. Powered by Aspidus.
      </p>
    </div>
  `;
  return { subject, html };
}

export function logisticsQuoteReadyEmail(opts: {
  partnerName: string;
  requestNumber: string;
  route: string;
  mode: string;
  price: number | string;
  currency: string;
  transitDays: number | string;
  notes: string | null;
  tenantName: string;
  portalUrl: string;
}): { subject: string; html: string } {
  const subject = `Freight quote ready — ${opts.requestNumber} · ${opts.route}`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
      <div style="background: #0f766e; color: white; padding: 30px; border-radius: 12px 12px 0 0;">
        <h1 style="margin: 0; font-size: 22px;">Your freight quote is ready</h1>
        <p style="margin: 8px 0 0; opacity: 0.9; font-size: 14px;">${escapeHtml(opts.requestNumber)} · ${escapeHtml(opts.mode.toUpperCase())}</p>
      </div>
      <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <p style="color: #333; font-size: 15px;">Hello ${escapeHtml(opts.partnerName)},</p>
        <p style="color: #555; font-size: 14px; line-height: 1.6;">We've prepared a quote for your shipment <strong>${escapeHtml(opts.route)}</strong>.</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px;">
          <tr><td style="padding:8px 0;color:#6b7280;">Route</td><td style="padding:8px 0;text-align:right;font-weight:600;">${escapeHtml(opts.route)}</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;">Mode</td><td style="padding:8px 0;text-align:right;font-weight:600;">${escapeHtml(opts.mode.toUpperCase())}</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;">Price</td><td style="padding:8px 0;text-align:right;font-weight:600;">${escapeHtml(opts.currency)} ${escapeHtml(String(opts.price))}</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;">Estimated transit</td><td style="padding:8px 0;text-align:right;font-weight:600;">${escapeHtml(String(opts.transitDays))} days</td></tr>
        </table>
        ${opts.notes ? `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0;"><p style="color:#374151;font-size:13px;line-height:1.6;margin:0;white-space:pre-wrap;">${escapeHtml(opts.notes)}</p></div>` : ""}
        <div style="text-align:center;margin:24px 0;">
          <a href="${opts.portalUrl}" style="background:#0f766e;color:white;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;font-size:14px;">Review Quote</a>
        </div>
        <p style="color:#888;font-size:12px;line-height:1.5;">Sign in to your portal to accept, decline, or ask for changes.</p>
      </div>
      <p style="text-align:center;color:#999;font-size:11px;margin-top:20px;">© ${new Date().getFullYear()} ${escapeHtml(opts.tenantName)}. Powered by Aspidus.</p>
    </div>
  `;
  return { subject, html };
}
