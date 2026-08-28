import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { requireAdmin, audit, sanitizeError, resolveTenantId } from "@/lib/api/helpers";
import { getStore, getStoreSync } from "@/lib/data/store";
import type { EmailProvider } from "@/lib/email/service";

export const runtime = "nodejs";

/**
 * HTML-escape a string before interpolating into the test email HTML body.
 * EMAIL-AUDIT (MEDIUM) — `fromName`, `fromEmail`, `resendFromEmail`,
 * `postmarkFromEmail`, `smtp.fromName`, `smtp.fromEmail`, `smtp.user`,
 * and `messageStream` are all admin-settable fields interpolated into
 * the test email HTML body. Without escaping, an admin who set
 * `fromName = '<img src=x onerror=alert(1)>'` would inject script into
 * the test email they themselves receive. Self-XSS, but the same
 * shared table-row is also what shows up in the Mail Queue — so an
 * admin who has been socially engineered to paste a "weird from-name"
 * could end up logging an XSS payload into the audit trail.
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
 * POST /api/settings/test-email
 *
 * Sends a test email using either Resend or SMTP (whichever is currently
 * selected in the form). Lets the admin verify their email configuration
 * before saving.
 *
 * Body:
 *   {
 *     "to": "recipient@example.com",
 *     "provider": "resend" | "smtp",
 *     // Resend fields:
 *     "resend_api_key"?: "re_...",
 *     "resend_from_email"?: "noreply@yourdomain.com",
 *     // SMTP fields:
 *     "smtp_host"?: "...",
 *     "smtp_port"?: 587,
 *     "smtp_user"?: "...",
 *     "smtp_password"?: "...",
 *     // Common:
 *     "from_name"?: "...",
 *     "from_email"?: "...",
 *     "reply_to"?: "..."
 *   }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (settings.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "settings.test"); if (_d) return _d; } /* requirePermission wired */


  let body: {
    to?: string;
    provider?: EmailProvider;
    resend_api_key?: string;
    resend_from_email?: string;
    postmark_server_token?: string;
    postmark_from_email?: string;
    postmark_message_stream?: string;
    smtp_host?: string;
    smtp_port?: number;
    smtp_user?: string;
    smtp_password?: string;
    from_name?: string;
    from_email?: string;
    reply_to?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.to)) {
    return NextResponse.json(
      { ok: false, error: "A valid recipient email is required." },
      { status: 400 }
    );
  }

  // Load saved config — TENANT comms first, then platform-level fallback.
  // This is CRITICAL: a tenant admin who configured Postmark in their
  // tenant comms must be able to test it. Previously, getSetting("comms")
  // without a tenantId read the PLATFORM comms (which is "none"), so the
  // test always failed for tenant admins.
  let saved: Record<string, any> = {};
  const store = getStoreSync() ?? (await getStore());
  const tid = resolveTenantId(auth, req);
  let comms = tid ? await store.getSetting<any>("comms", tid) : null;
  if (!comms) comms = await store.getSetting<any>("comms", null);
  if (comms) saved = comms;

  const provider: EmailProvider = body.provider || saved.email_provider || "smtp";
  const fromName = body.from_name || saved.from_name || "VELOS CRM";
  const fromEmail = body.from_email || saved.from_email || "noreply@velos.trade";

  // ── RESEND ───────────────────────────────────────────────────────────
  if (provider === "resend") {
    const apiKey = body.resend_api_key || saved.resend_api_key;
    const resendFromEmail = body.resend_from_email || saved.resend_from_email || fromEmail;

    if (!apiKey) {
      return NextResponse.json(
        {
          ok: false,
          error: "Resend API key is required. Get one at https://resend.com/api-keys",
          category: "missing_config",
        },
        { status: 200 }
      );
    }

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          from: `${fromName} <${resendFromEmail}>`,
          to: [body.to],
          subject: `[VELOS] Email test — ${new Date().toISOString()}`,
          html: `
            <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:32px 20px;">
              <div style="background:#0f766e;color:white;padding:24px 28px;border-radius:12px 12px 0 0;">
                <h1 style="margin:0;font-size:18px;font-weight:600;">Email Configuration Test</h1>
                <p style="margin:6px 0 0;opacity:0.9;font-size:13px;">VELOS CRM · Resend · ${new Date().toISOString()}</p>
              </div>
              <div style="background:white;padding:28px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
                <p style="color:#333;font-size:14px;line-height:1.6;">Hi,</p>
                <p style="color:#555;font-size:14px;line-height:1.6;">
                  This is a test email sent from your VELOS CRM settings panel via <strong>Resend</strong>.
                  If you are reading this, your Resend integration is working correctly.
                </p>
                <table style="width:100%;font-size:13px;color:#555;margin:16px 0;border-collapse:collapse;">
                  <tr><td style="padding:6px 0;color:#888;width:140px;">Provider</td><td style="padding:6px 0;">Resend (HTTP API)</td></tr>
                  <tr><td style="padding:6px 0;color:#888;">From</td><td style="padding:6px 0;font-family:monospace;">${escapeHtml(fromName)} &lt;${escapeHtml(resendFromEmail)}&gt;</td></tr>
                  <tr><td style="padding:6px 0;color:#888;">Sent at</td><td style="padding:6px 0;">${escapeHtml(new Date().toLocaleString())}</td></tr>
                </table>
                <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;" />
                <p style="color:#888;font-size:12px;line-height:1.5;">
                  This is an automated test message. Please do not reply.
                </p>
              </div>
            </div>
          `,
          ...(body.reply_to || saved.reply_to ? { reply_to: body.reply_to || saved.reply_to } : {}),
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        let errMsg = `Resend API error ${res.status}`;
        let category = "resend_error";
        try {
          const errJson = JSON.parse(errText);
          errMsg = errJson.message || errJson.error || errMsg;
          if (res.status === 401) {
            category = "auth_failed";
            errMsg = "Invalid Resend API key. Check that you copied the full key (starts with re_).";
          } else if (res.status === 403) {
            category = "domain_not_verified";
            errMsg = "Sending domain not verified. In Resend dashboard, add and verify your domain (or use onboarding@resend.dev for testing).";
          } else if (res.status === 429) {
            category = "rate_limit";
            errMsg = "Rate limit exceeded. Resend free tier allows 100 emails/day.";
          }
        } catch {
          errMsg = errText || errMsg;
        }
        return NextResponse.json({ ok: false, error: errMsg, category }, { status: 200 });
      }

      const data = await res.json();
      try {
        await audit(auth.store, auth.user, req, "settings.test_email", "setting", undefined, { provider: body.provider, to: body.to });
      } catch (e) { console.error("[audit]", e); }
      return NextResponse.json({
        ok: true,
        messageId: data.id,
        provider: "resend",
        testedAt: new Date().toISOString(),
      });
    } catch (e: any) {
      return NextResponse.json(
        { ok: false, error: sanitizeError(e), category: "network" },
        { status: 200 }
      );
    }
  }

  // ── POSTMARK ─────────────────────────────────────────────────────────
  if (provider === "postmark") {
    const serverToken = body.postmark_server_token || saved.postmark_server_token;
    const postmarkFromEmail = body.postmark_from_email || saved.postmark_from_email || fromEmail;
    const messageStream = body.postmark_message_stream || saved.postmark_message_stream || "outbound";

    if (!serverToken) {
      return NextResponse.json(
        {
          ok: false,
          error: "Postmark server token is required. Get one at https://postmarkapp.com/servers",
          category: "missing_config",
        },
        { status: 200 }
      );
    }

    try {
      const res = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": serverToken,
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          From: `${fromName} <${postmarkFromEmail}>`,
          To: body.to,
          Subject: `[VELOS] Email test — ${new Date().toISOString()}`,
          HtmlBody: `
            <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:32px 20px;">
              <div style="background:#0f766e;color:white;padding:24px 28px;border-radius:12px 12px 0 0;">
                <h1 style="margin:0;font-size:18px;font-weight:600;">Email Configuration Test</h1>
                <p style="margin:6px 0 0;opacity:0.9;font-size:13px;">VELOS CRM · Postmark · ${new Date().toISOString()}</p>
              </div>
              <div style="background:white;padding:28px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
                <p style="color:#333;font-size:14px;line-height:1.6;">Hi,</p>
                <p style="color:#555;font-size:14px;line-height:1.6;">
                  This is a test email sent from your VELOS CRM settings panel via <strong>Postmark</strong>.
                  If you are reading this, your Postmark integration is working correctly.
                </p>
                <table style="width:100%;font-size:13px;color:#555;margin:16px 0;border-collapse:collapse;">
                  <tr><td style="padding:6px 0;color:#888;width:140px;">Provider</td><td style="padding:6px 0;">Postmark (HTTP API)</td></tr>
                  <tr><td style="padding:6px 0;color:#888;">From</td><td style="padding:6px 0;font-family:monospace;">${escapeHtml(fromName)} &lt;${escapeHtml(postmarkFromEmail)}&gt;</td></tr>
                  <tr><td style="padding:6px 0;color:#888;">Message stream</td><td style="padding:6px 0;font-family:monospace;">${escapeHtml(messageStream)}</td></tr>
                  <tr><td style="padding:6px 0;color:#888;">Sent at</td><td style="padding:6px 0;">${escapeHtml(new Date().toLocaleString())}</td></tr>
                </table>
                <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;" />
                <p style="color:#888;font-size:12px;line-height:1.5;">
                  This is an automated test message. Please do not reply.
                </p>
              </div>
            </div>
          `,
          MessageStream: messageStream,
          ...(body.reply_to || saved.reply_to ? { ReplyTo: body.reply_to || saved.reply_to } : {}),
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        let errMsg = `Postmark API error ${res.status}`;
        let category = "postmark_error";
        try {
          const errJson = JSON.parse(errText);
          errMsg = errJson.Message || errJson.message || errMsg;
          if (res.status === 401) {
            category = "auth_failed";
            errMsg = "Invalid Postmark server token. Check that you copied the full token from your Postmark server settings.";
          } else if (res.status === 422) {
            category = "domain_not_verified";
            errMsg = "Sender signature not confirmed. In Postmark dashboard, add and confirm your sender signature (domain or email).";
          } else if (res.status === 429) {
            category = "rate_limit";
            errMsg = "Rate limit exceeded. Postmark trial allows 100 emails/month.";
          }
        } catch {
          errMsg = errText || errMsg;
        }
        return NextResponse.json({ ok: false, error: errMsg, category }, { status: 200 });
      }

      const data = await res.json();
      try {
        await audit(auth.store, auth.user, req, "settings.test_email", "setting", undefined, { provider: body.provider, to: body.to });
      } catch (e) { console.error("[audit]", e); }
      return NextResponse.json({
        ok: true,
        messageId: data.MessageID,
        provider: "postmark",
        testedAt: new Date().toISOString(),
      });
    } catch (e: any) {
      return NextResponse.json(
        { ok: false, error: sanitizeError(e), category: "network" },
        { status: 200 }
      );
    }
  }

  // ── SMTP ─────────────────────────────────────────────────────────────
  if (provider === "smtp") {
    const smtp = {
      host: body.smtp_host || saved.smtp_host || "",
      port: body.smtp_port || saved.smtp_port || 587,
      user: body.smtp_user || saved.smtp_user || "",
      password: body.smtp_password || saved.smtp_password || "",
      fromName,
      fromEmail,
    };

    if (!smtp.host || !smtp.user) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "SMTP is not configured. Fill in the SMTP host and user, or switch to Resend (recommended for Render free plan).",
          category: "missing_config",
        },
        { status: 200 }
      );
    }

    try {
      const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.port === 465,
        auth: { user: smtp.user, pass: smtp.password },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      });

      await transporter.verify();

      const info = await transporter.sendMail({
        from: `"${smtp.fromName}" <${smtp.fromEmail}>`,
        to: body.to,
        subject: `[VELOS] SMTP test — ${new Date().toISOString()}`,
        text: `This is a test email from VELOS CRM.\n\nSMTP server: ${smtp.host}:${smtp.port}\nUser: ${smtp.user}\nSent at: ${new Date().toISOString()}\n\nIf you received this message, your SMTP configuration is working correctly.`,
        html: `
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:32px 20px;">
            <div style="background:#0f766e;color:white;padding:24px 28px;border-radius:12px 12px 0 0;">
              <h1 style="margin:0;font-size:18px;font-weight:600;">SMTP Configuration Test</h1>
              <p style="margin:6px 0 0;opacity:0.9;font-size:13px;">VELOS CRM · ${new Date().toISOString()}</p>
            </div>
            <div style="background:white;padding:28px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
              <p style="color:#333;font-size:14px;line-height:1.6;">Hi,</p>
              <p style="color:#555;font-size:14px;line-height:1.6;">
                This is a test email sent from your VELOS CRM settings panel.
                If you are reading this, your SMTP configuration is working correctly.
              </p>
              <table style="width:100%;font-size:13px;color:#555;margin:16px 0;border-collapse:collapse;">
                <tr><td style="padding:6px 0;color:#888;width:120px;">SMTP server</td><td style="padding:6px 0;font-family:monospace;">${escapeHtml(smtp.host)}:${escapeHtml(String(smtp.port))}</td></tr>
                <tr><td style="padding:6px 0;color:#888;">Username</td><td style="padding:6px 0;font-family:monospace;">${escapeHtml(smtp.user)}</td></tr>
                <tr><td style="padding:6px 0;color:#888;">From</td><td style="padding:6px 0;font-family:monospace;">${escapeHtml(smtp.fromName)} &lt;${escapeHtml(smtp.fromEmail)}&gt;</td></tr>
                <tr><td style="padding:6px 0;color:#888;">Sent at</td><td style="padding:6px 0;">${escapeHtml(new Date().toLocaleString())}</td></tr>
              </table>
              <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;" />
              <p style="color:#888;font-size:12px;line-height:1.5;">
                This is an automated test message. Please do not reply.
              </p>
            </div>
          </div>
        `,
      });

      try {
        await audit(auth.store, auth.user, req, "settings.test_email", "setting", undefined, { provider: body.provider, to: body.to });
      } catch (e) { console.error("[audit]", e); }
      return NextResponse.json({
        ok: true,
        messageId: info.messageId,
        provider: "smtp",
        testedAt: new Date().toISOString(),
      });
    } catch (e: any) {
      let category = "unknown";
      const msg = (e?.message || "").toLowerCase();
      if (msg.includes("connect ei") || msg.includes("getaddrinfo") || msg.includes("enotfound")) {
        category = "host_unreachable";
      } else if (msg.includes("auth") || msg.includes("invalid login") || msg.includes("credentials")) {
        category = "auth_failed";
      } else if (msg.includes("timeout")) {
        category = "timeout";
      } else if (msg.includes("self-signed") || msg.includes("certificate") || msg.includes("tls")) {
        category = "tls";
      }
      return NextResponse.json(
        { ok: false, error: sanitizeError(e), category },
        { status: 200 }
      );
    }
  }

  return NextResponse.json(
    { ok: false, error: "Unknown provider. Use 'resend' or 'smtp'." },
    { status: 400 }
  );
}
