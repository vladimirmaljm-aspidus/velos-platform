import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { requireAdmin, audit, sanitizeError, getIp } from "@/lib/api/helpers";
import { getStore, getStoreSync } from "@/lib/data/store";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import {
  decryptSensitiveFields,
  COMMS_SENSITIVE_KEYS,
} from "@/lib/crypto/field-encryption";
import { escapeHtml } from "@/lib/security/escape-html";
import { isValidEmail } from "@/lib/validation/email";

export const runtime = "nodejs";

/**
 * HTML-escape a string before interpolating into the test email HTML body.
 * EMAIL-AUDIT (MEDIUM) — same discipline as test-email/route.ts. The
 * `fromName`, `fromEmail`, `smtp.user`, `smtp.host` are admin-settable
 * fields interpolated into the test email HTML body.
 */

/**
 * POST /api/settings/test-smtp
 *
 * Sends a small test email to a recipient address using the SMTP config that
 * is currently saved for the tenant (or a one-off override supplied in the
 * body, so the admin can try a config BEFORE saving it).
 *
 * Body:
 *   {
 *     "to": "recipient@example.com",        // required
 *     "smtp_host"?: "...",                  // optional override
 *     "smtp_port"?: 587,
 *     "smtp_user"?: "...",
 *     "smtp_password"?: "...",
 *     "from_email"?: "...",
 *     "from_name"?: "..."
 *   }
 *
 * Returns { ok: true, messageId } on success, or
 *         { ok: false, error: "..." } with a 200 status on failure
 *         (so the UI can show a friendly error message).
 */
export async function POST(req: NextRequest) {
  // 9b-N7: per-IP rate limit — sending SMTP test emails is a spam vector
  // (admin can send unlimited emails to arbitrary external addresses).
  // 10 sends per IP per 10 minutes matches interactive "try a config then
  // wait for it to land" patterns.
  const _rl = await checkRateLimit(`smtp:ip:${getIp(req)}`, 10, 10 * 60_000);
  if (!_rl.allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many SMTP test requests. Please wait a few minutes." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((_rl.retryAfter ?? 600_000) / 1000)) } },
    );
  }
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (settings.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "settings.test"); if (_d) return _d; } /* requirePermission wired */


  let body: {
    to?: string;
    smtp_host?: string;
    smtp_port?: number;
    smtp_user?: string;
    smtp_password?: string;
    from_email?: string;
    from_name?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.to || !isValidEmail(body.to)) {
    return NextResponse.json(
      { ok: false, error: "A valid recipient email is required." },
      { status: 400 }
    );
  }

  // Load saved config
  let smtp: {
    host: string;
    port: number;
    user: string;
    password: string;
    fromName: string;
    fromEmail: string;
  } | null = null;

  const store = getStoreSync() ?? (await getStore());
  // AUDIT17 / P1-4 — load the TENANT's comms blob (auth.tenantId), not the
  // platform-level one. The previous call omitted the tenantId argument, so
  // getSetting fell back to the platform blob (tenant_id IS NULL) — a tenant
  // admin "testing the saved settings" was actually testing platform-level
  // credentials: misleading "not configured" / wrong-credential results that
  // masked the real per-tenant state. Super-admins (tenantId null) keep the
  // platform-level read.
  let comms = await store.getSetting<any>("comms", auth.tenantId ?? undefined);
  if (!comms) comms = await store.getSetting<any>("comms");
  // EMAIL-FIX: decrypt the at-rest secrets (`enc:` …) before using them —
  // the settings PUT encrypts smtp_password on save. Without this the
  // verify() call authenticates with the ciphertext and fails.
  if (comms) {
    comms = decryptSensitiveFields(comms as Record<string, unknown>, COMMS_SENSITIVE_KEYS) as typeof comms;
  }

  if (comms) {
    smtp = {
      host: comms.smtp_host || "",
      port: comms.smtp_port || 587,
      user: comms.smtp_user || "",
      password: comms.smtp_password || "",
      fromName: comms.from_name || "VELOS CRM",
      fromEmail: comms.from_email || "noreply@velos.trade",
    };
  }

  // Apply overrides
  if (body.smtp_host) smtp = { ...smtp!, host: body.smtp_host };
  if (body.smtp_port) smtp = { ...smtp!, port: body.smtp_port };
  if (body.smtp_user) smtp = { ...smtp!, user: body.smtp_user };
  if (body.smtp_password) smtp = { ...smtp!, password: body.smtp_password };
  if (body.from_email) smtp = { ...smtp!, fromEmail: body.from_email };
  if (body.from_name) smtp = { ...smtp!, fromName: body.from_name };

  if (!smtp || !smtp.host || !smtp.user) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "SMTP is not configured. Fill in the SMTP host, port, username, and password in Settings → Communication, then test again.",
      },
      { status: 200 }
    );
  }

  // 9b-N3: SSRF validation on smtp_host. The host is admin-supplied via
  // body override OR loaded from settings; both paths land in smtp.host.
  // An admin with `settings.test` can pass `smtp_host: "169.254.169.254"`
  // to hit AWS metadata via SMTP banner, or `127.0.0.1` to port-scan
  // internal services. We re-use assertSafeWebhookUrl (generic URL
  // validator with IP-range blocklist + scheme allowlist + DNS resolution).
  // The validator expects a URL with a scheme — synthesize `smtp://` if missing.
  const { assertSafeWebhookUrl } = await import("@/lib/webhooks/url-validation");
  const hostForCheck = /^[a-z][a-z0-9+.-]*:\/\//i.test(smtp.host) ? smtp.host : `smtp://${smtp.host}:${smtp.port}`;
  const hostCheck = await assertSafeWebhookUrl(hostForCheck);
  if (!hostCheck.ok) {
    return NextResponse.json(
      { ok: false, error: `SMTP host rejected: ${hostCheck.error}` },
      { status: 400 }
    );
  }

  // Verify connection first (fast-fail without sending)
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

    // 1) verify() opens a connection and authenticates — catches 90% of
    //    misconfigurations (wrong host/port/credentials) without sending mail.
    await transporter.verify();

    // 2) Actually send a tiny test message so the admin can confirm
    //    deliverability, not just SMTP connectivity.
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
      // 9b-N6: include `to` recipient in audit log so spam complaints can
      // be traced back to the specific admin + recipient (parity with
      // /api/settings/test-email which logs `to`).
      await audit(auth.store, auth.user, req, "settings.test_smtp", "setting", undefined, { host: body.smtp_host, port: body.smtp_port, to: body.to });
    } catch (e) { console.error("[audit]", e); }
    return NextResponse.json({
      ok: true,
      messageId: info.messageId,
      response: info.response,
      testedAt: new Date().toISOString(),
    });
  } catch (e: any) {
    // Distinguish common error categories so the UI can show actionable hints
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
      {
        ok: false,
        error: sanitizeError(e),
        category,
      },
      { status: 200 }
    );
  }
}
