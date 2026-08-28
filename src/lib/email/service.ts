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
 * Domain allowlist for the `from` envelope header.
 *
 * EMAIL-AUDIT / CRITICAL — spoofing fix. Without this guard, a tenant admin
 * who configures their own comms blob can set `from_email: ceo@victim.com`
 * (or `resend_from_email` / `postmark_from_email`). The email service then
 * emits the `from` header verbatim — and when the tenant uses SMTP to a
 * relay that doesn't enforce SPF/DKIM, the recipient sees a forged
 * `From: "VELOS Trade" <ceo@victim.com>` and trusts it. Resend/Postmark
 * both enforce domain verification at the provider level, so they would
 * reject the send — but SMTP does not, which is the actual attack vector.
 *
 * Defense:
 *   1. The platform super-admin publishes a comma-separated list of
 *      allowed from-domains in the platform-level setting
 *      `email_allowed_from_domains` (tenant_id = NULL). Example:
 *      "aspidus.onrender.com,mycompany.com".
 *   2. At send time, `getEmailConfig` parses the from-email's domain
 *      and checks it against the allowlist. If the domain is NOT on
 *      the list, the from-email is replaced with `noreply@<first-allowed>`
 *      — silently, with a console.warn so the platform operator sees it.
 *   3. At save time, the settings PUT route rejects the comms blob
 *      outright (400) if any of `from_email` / `resend_from_email` /
 *      `postmark_from_email` carries a domain that's not on the
 *      allowlist, so the admin gets an actionable error instead of a
 *      silent rewrite.
 *
 * Default allowlist when no platform setting is configured:
 *   ["aspidus.onrender.com", "resend.dev"]
 * — the platform's deployment domain + the Resend sandbox domain
 * (only `onboarding@resend.dev` is meaningful on resend.dev, but
 * allowing the domain is harmless).
 */
const DEFAULT_ALLOWED_FROM_DOMAINS = ["aspidus.onrender.com", "resend.dev"];

/**
 * Load the platform-level allowed from-domains list. Returns the
 * comma-separated string from the `email_allowed_from_domains`
 * setting (tenant_id = NULL) — falls back to env var
 * `ALLOWED_FROM_DOMAINS` — falls back to the default list above.
 *
 * Always returns a non-empty array; the caller can iterate without
 * a null check.
 */
async function loadAllowedFromDomains(): Promise<string[]> {
  try {
    const store = await getStore();
    const raw = await store.getSetting<string>("email_allowed_from_domains", null);
    if (typeof raw === "string" && raw.trim()) {
      const parsed = raw
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d.length > 0);
      if (parsed.length > 0) return parsed;
    }
  } catch (e) {
    console.error("[email] loadAllowedFromDomains failed:", e);
  }
  const envRaw = process.env.ALLOWED_FROM_DOMAINS;
  if (typeof envRaw === "string" && envRaw.trim()) {
    const parsed = envRaw
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d.length > 0);
    if (parsed.length > 0) return parsed;
  }
  return DEFAULT_ALLOWED_FROM_DOMAINS.slice();
}

/**
 * Validate a `from` email against the platform allowlist.
 * Returns the validated email (if its domain is allowed) or a safe
 * fallback (`noreply@<first-allowed-domain>`). The fallback is
 * intentionally the FIRST entry of the allowlist so the platform
 * operator can control what the rewritten address looks like by
 * reordering the list.
 *
 * Exported so the settings PUT route can use it to reject bad
 * inputs at save time (`validateFromEmailStrict`).
 */
export async function resolveFromEmail(fromEmail: string): Promise<string> {
  const allowed = await loadAllowedFromDomains();
  return validateFromEmailWithList(fromEmail, allowed);
}

/**
 * Pure-function variant of the validator — takes the allowlist
 * explicitly so it can be unit-tested without a DB round-trip.
 * Returns the original email if its domain is on the list, or
 * `noreply@<allowed[0]>` otherwise.
 */
export function validateFromEmailWithList(fromEmail: string, allowed: string[]): string {
  const email = String(fromEmail || "").trim().toLowerCase();
  // Reject obviously malformed emails entirely — the safe fallback
  // is still a valid email so downstream SMTP/HTTP APIs don't blow up.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return `noreply@${allowed[0] || "aspidus.onrender.com"}`;
  }
  const domain = email.split("@")[1] || "";
  if (allowed.includes(domain)) return email;
  // Rewrite to the safe default. We deliberately do NOT preserve the
  // local-part — a tenant setting `from_email=ceo@victim.com` must NOT
  // get `ceo@aspidus.onrender.com` back (which would still read as
  // "ceo" and could mislead the recipient). The neutral `noreply` local-
  // part makes it obvious this is an automated system address.
  return `noreply@${allowed[0] || "aspidus.onrender.com"}`;
}

/**
 * Strict variant for the settings PUT route — returns `null` if the
 * from-email's domain is on the allowlist (valid), or the safe fallback
 * if it isn't (invalid). The caller can distinguish the two cases and
 * surface a 400 to the admin when invalid. Returns the original email
 * when valid, so the route can store it verbatim.
 */
export async function validateFromEmailStrict(fromEmail: string): Promise<{ valid: boolean; value: string; fallback: string }> {
  const allowed = await loadAllowedFromDomains();
  const email = String(fromEmail || "").trim().toLowerCase();
  const fallback = `noreply@${allowed[0] || "aspidus.onrender.com"}`;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { valid: false, value: fromEmail, fallback };
  }
  const domain = email.split("@")[1] || "";
  if (allowed.includes(domain)) return { valid: true, value: fromEmail, fallback };
  return { valid: false, value: fromEmail, fallback };
}

/**
 * Load the email configuration for a tenant (or the global config).
 * Returns the resolved provider + its credentials.
 *
 * EMAIL-AUDIT / CRITICAL — the `from_email` (and provider-specific
 * `resend_from_email` / `postmark_from_email`) are validated against
 * the platform allowlist at load time. A tenant that configured
 * `from_email=ceo@victim.com` before this fix silently gets the
 * platform default `noreply@<allowed-domain>` instead — defense-in-
 * depth on top of the save-time rejection in the settings PUT route.
 */
export async function getEmailConfig(tenantId?: string): Promise<EmailConfig | null> {
  const store = await getStore();
  // Tenant email config is STRICTLY separate from platform email config.
  // - If tenantId is provided: load TENANT comms. If tenant has NO comms
  //   config (null), return null (no email sent). DO NOT fall back to
  //   platform comms — platform comms is only for super-admin → tenant
  //   communication, not for tenant → client communication.
  // - If tenantId is null/undefined: load PLATFORM comms (super-admin
  //   level communication).
  let comms: any = null;
  if (tenantId) {
    // Tenant-level email — STRICTLY tenant comms, NO platform fallback.
    comms = await store.getSetting<any>("comms", tenantId);
    if (!comms || (comms.email_provider === "none" && !comms.smtp_host)) return null;
  } else {
    // Platform-level email (super-admin communication).
    comms = await store.getSetting<any>("comms", null);
    if (!comms) return null;
  }

  const provider: EmailProvider = comms.email_provider || (comms.smtp_host ? "smtp" : "none");
  const fromName = comms.from_name || "VELOS CRM";
  // Validate the base from-email against the platform allowlist. This
  // value is what SMTP uses directly AND what Resend/Postmark fall back
  // to when their provider-specific from-email is missing.
  const rawFromEmail = comms.from_email || process.env.NOREPLY_EMAIL || "noreply@aspidus.onrender.com";
  const fromEmail = await resolveFromEmail(rawFromEmail);
  if (fromEmail !== rawFromEmail.toLowerCase()) {
    // The rawFromEmail was rewritten — log it so the platform operator
    // can see the spoofing attempt in their logs. The send still goes
    // through (with the safe fallback); we don't break the user-facing
    // flow, we just refuse to use the spoofed address.
    console.warn(
      `[email] from_email "${rawFromEmail}" is not on the platform allowlist; falling back to "${fromEmail}". ` +
      `Set the platform setting "email_allowed_from_domains" to allow this domain.`,
    );
  }

  const config: EmailConfig = { provider, fromName, fromEmail };

  if (comms.smtp_host && comms.smtp_user) {
    config.smtp = {
      host: comms.smtp_host,
      port: comms.smtp_port || 587,
      user: comms.smtp_user,
      password: comms.smtp_password || "",
      fromName,
      // SMTP uses config.fromEmail directly — already validated above.
      fromEmail,
    };
  }

  if (comms.resend_api_key) {
    // Validate the provider-specific from-email too — a tenant could
    // set `from_email=noreply@aspidus.onrender.com` (allowed) but
    // `resend_from_email=ceo@victim.com` (not allowed). The provider-
    // specific value goes into the `from` header, so it must be
    // validated independently.
    const rawResendFrom = comms.resend_from_email || fromEmail;
    const resendFromEmail = await resolveFromEmail(rawResendFrom);
    if (resendFromEmail !== String(rawResendFrom).toLowerCase() && comms.resend_from_email) {
      console.warn(
        `[email] resend_from_email "${comms.resend_from_email}" is not on the platform allowlist; falling back to "${resendFromEmail}".`,
      );
    }
    config.resend = {
      apiKey: comms.resend_api_key,
      fromName,
      fromEmail: resendFromEmail,
      replyTo: comms.reply_to || undefined,
    };
  }

  if (comms.postmark_server_token) {
    const rawPostmarkFrom = comms.postmark_from_email || fromEmail;
    const postmarkFromEmail = await resolveFromEmail(rawPostmarkFrom);
    if (postmarkFromEmail !== String(rawPostmarkFrom).toLowerCase() && comms.postmark_from_email) {
      console.warn(
        `[email] postmark_from_email "${comms.postmark_from_email}" is not on the platform allowlist; falling back to "${postmarkFromEmail}".`,
      );
    }
    config.postmark = {
      serverToken: comms.postmark_server_token,
      fromName,
      fromEmail: postmarkFromEmail,
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

  // No provider configured — DON'T queue, just log and return.
  // Previously this created a mail_queue entry with status='queued',
  // which accumulated forever because there's no worker to send them.
  // Now we just log and return success:false — the caller can handle
  // the failure (e.g. show a toast) without polluting the queue.
  if (
    !config ||
    config.provider === "none" ||
    (config.provider === "smtp" && !config.smtp) ||
    (config.provider === "resend" && !config.resend) ||
    (config.provider === "postmark" && !config.postmark)
  ) {
    console.log(`[email] No provider configured for tenant ${opts.tenantId || "platform"} — email to ${opts.to} not sent.`);
    return { success: false, error: "No email provider configured. Set up Postmark/SMTP in Settings → Communications.", provider: "none" };
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
    // Queue for manual retry. But DON'T create duplicate entries —
    // check if there's already a failed entry for the same to+subject
    // within the last hour. If so, just update the error/attempts
    // instead of creating a new row. This prevents the mail_queue
    // from accumulating dozens of identical failed entries when an
    // action retries (e.g. a cron fires, a user clicks retry, etc.).
    const store = await getStore();
    let queueEntryId: string | undefined;
    try {
      // Check for existing failed entry (same to_email + subject)
      const sb = (store as any).sb?.() || null;
      if (sb) {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { data: existing } = await sb
          .from("mail_queue")
          .select("id, attempts")
          .eq("to_email", opts.to)
          .eq("subject", opts.subject)
          .eq("status", "failed")
          .gte("created_at", oneHourAgo)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (existing) {
          // Update existing entry — bump attempts, update error
          await sb.from("mail_queue").update({
            error: e.message,
            attempts: (existing.attempts || 0) + 1,
          }).eq("id", existing.id);
          queueEntryId = existing.id;
        } else {
          // Create new failed entry
          const entry = await store.upsertMailQueueEntry({
            to_email: opts.to,
            subject: opts.subject,
            body: opts.html,
            status: "failed",
            attempts: 1,
            error: e.message,
            tenant_id: opts.tenantId || "SYSTEM",
          } as any);
          queueEntryId = (entry as any)?.id;
        }
      } else {
        // No Supabase client — fallback to insert
        const entry = await store.upsertMailQueueEntry({
          to_email: opts.to,
          subject: opts.subject,
          body: opts.html,
          status: "failed",
          attempts: 1,
          error: e.message,
          tenant_id: opts.tenantId || "SYSTEM",
        } as any);
        queueEntryId = (entry as any)?.id;
      }
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

/**
 * 2FA activation notification — EMAIL-AUDIT (HIGH).
 *
 * Sent to the user's registered email the moment their 2FA is activated
 * (POST /api/auth/2fa/verify success). This is a defense-in-depth
 * notification: if an attacker briefly holds the user's session and
 * silently rotates the TOTP secret + recovery codes, the legitimate
 * user gets an email at their real inbox saying "2FA was just turned
 * on — was that you?". Without this notification, the user would have
 * no signal until they next tried to log in and were prompted for a
 * TOTP code they don't have.
 *
 * The email deliberately includes:
 *   - The actor's username (so the user can verify it's them)
 *   - The IP and user-agent of the activation request (so a user who
 *     didn't activate can see where it came from)
 *   - A "disable 2FA" link to the user's security settings
 *
 * It does NOT include the recovery codes (those were shown exactly
 * once in the API response) — re-sending them in an email would
 * massively widen the surface for a single-use credential.
 */
export function twoFactorActivatedEmail(opts: {
  username: string;
  tenantName: string;
  activatedAt: string;
  ip: string | null;
  userAgent: string | null;
  securityUrl: string;
}): { subject: string; html: string } {
  const subject = `2FA enabled on your VELOS account`;
  const actorLine = opts.ip
    ? `<tr><td style="padding:6px 0;color:#888;width:140px;">IP address</td><td style="padding:6px 0;font-family:monospace;font-size:13px;">${escapeHtml(opts.ip)}</td></tr>`
    : "";
  const uaLine = opts.userAgent
    ? `<tr><td style="padding:6px 0;color:#888;width:140px;">Device</td><td style="padding:6px 0;font-family:monospace;font-size:13px;">${escapeHtml(opts.userAgent.slice(0, 120))}</td></tr>`
    : "";
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:32px 20px;">
      <div style="background:#0f766e;color:white;padding:24px 28px;border-radius:12px 12px 0 0;">
        <h1 style="margin:0;font-size:18px;font-weight:600;">Two-factor authentication enabled</h1>
        <p style="margin:6px 0 0;opacity:0.9;font-size:13px;">${escapeHtml(opts.tenantName)} · ${escapeHtml(opts.activatedAt)}</p>
      </div>
      <div style="background:white;padding:28px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
        <p style="color:#333;font-size:14px;">Hi ${escapeHtml(opts.username)},</p>
        <p style="color:#555;font-size:14px;line-height:1.6;">
          Two-factor authentication was just enabled on your VELOS account.
          From now on, you'll be asked for a code from your authenticator
          app every time you sign in.
        </p>
        <table style="width:100%;font-size:13px;color:#555;margin:16px 0;border-collapse:collapse;">
          <tr><td style="padding:6px 0;color:#888;width:140px;">Account</td><td style="padding:6px 0;font-family:monospace;font-size:13px;">${escapeHtml(opts.username)}</td></tr>
          ${actorLine}
          ${uaLine}
        </table>
        <p style="color:#555;font-size:14px;line-height:1.6;">
          If this was you, no further action is needed. If you did NOT
          enable 2FA, your session may have been compromised — sign in,
          change your password, and disable 2FA from your security
          settings, then re-enable it from a trusted device.
        </p>
        <div style="text-align:center;margin:24px 0;">
          <a href="${escapeHtml(opts.securityUrl)}" style="background:#0f766e;color:white;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;font-size:14px;">Security settings</a>
        </div>
        <p style="color:#888;font-size:12px;line-height:1.5;">
          This is an automated security notification from ${escapeHtml(opts.tenantName)}.
        </p>
      </div>
    </div>
  `;
  return { subject, html };
}
