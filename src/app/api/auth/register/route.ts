import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/data/store";
import { hashPassword } from "@/lib/auth/password";
import { validatePasswordWithPlatformPolicy } from "@/lib/auth/password-policy";
import {
  createSession,
  setSessionCookie,
} from "@/lib/auth/session";
import { getIp, sanitizeError } from "@/lib/api/helpers";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { reportSecurityEvent } from "@/lib/monitoring/security-alerts";
import { sendEmail } from "@/lib/email/service";

export const runtime = "nodejs";

/**
 * Self-registration route (UI-1).
 *
 * Creates a brand-new tenant (plan=trial, status=trial, trial_ends_at = now +
 * 14 days) and an admin user scoped to that tenant, then issues a session
 * cookie so the new tenant lands in the app shell with no second sign-in
 * step. A welcome email is sent best-effort (failures do NOT block the
 * registration — the user can still sign in immediately).
 *
 * The username is set to the email (lowercased) — the User model's only
 * unique lookup key — so duplicate detection is a single getUserByUsername
 * lookup. The email is stored verbatim in `email`.
 */

const TRIAL_DAYS = 14;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// F-7: 5 registrations per IP per hour. Tight enough to stop throwaway
// tenant farming + email enumeration, loose enough that a real office
// sharing an IP can sign up several people in a day.
const REGISTER_RATE_LIMIT = {
  maxAttempts: 5,
  windowMs: 60 * 60 * 1000,
};

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
 * Build the welcome email body. Inline-styled HTML so it renders in every
 * mail client (Gmail / Outlook / Apple Mail strip <style> blocks). Uses the
 * VELOS copper accent so the email matches the brand surface the user just
 * came from.
 */
function welcomeRegisterEmail(opts: {
  contactName: string;
  companyName: string;
  email: string;
  loginUrl: string;
}): { subject: string; html: string } {
  const subject = `Welcome to VELOS — your workspace is ready`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
      <div style="background: #b45309; color: white; padding: 30px; border-radius: 12px 12px 0 0;">
        <h1 style="margin: 0; font-size: 24px; font-weight: 600;">Welcome to VELOS</h1>
        <p style="margin: 8px 0 0; opacity: 0.9; font-size: 14px;">Your trade workspace is ready</p>
      </div>
      <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <p style="color: #333; font-size: 15px; line-height: 1.6;">Hello ${escapeHtml(opts.contactName)},</p>
        <p style="color: #555; font-size: 14px; line-height: 1.6;">
          Your VELOS workspace for <strong>${escapeHtml(opts.companyName)}</strong> has been created. You can now sign in with
          <a href="mailto:${escapeHtml(opts.email)}" style="color: #b45309;">${escapeHtml(opts.email)}</a> and the password you just set.
        </p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${opts.loginUrl}" style="background: #b45309; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">
            Open VELOS
          </a>
        </div>
        <h3 style="color: #333; font-size: 14px; margin: 0 0 8px;">Your 14-day trial includes:</h3>
        <ul style="color: #555; font-size: 13px; line-height: 1.8; padding-left: 20px;">
          <li>Multi-tenant CRM, partners, products, and deals</li>
          <li>Landed cost & margin engine</li>
          <li>Invoices, proformas, and document automation</li>
          <li>Client portal with KYC verification</li>
          <li>API keys, webhooks, and integrations</li>
        </ul>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="color: #888; font-size: 12px; line-height: 1.5;">
          You're receiving this email because a VELOS workspace was created with this address.
          If this wasn't you, you can safely ignore this email.
        </p>
      </div>
      <p style="text-align: center; color: #999; font-size: 11px; margin-top: 20px;">
        © ${new Date().getFullYear()} VELOS. Trade Management Platform.
      </p>
    </div>
  `;
  return { subject, html };
}

export async function POST(req: NextRequest) {
  try {
    // ── F-7: per-IP rate limit (defense-in-depth on top of validation) ──
    const ip = getIp(req);
    const rl = await checkRateLimit(
      `register:ip:${ip}`,
      REGISTER_RATE_LIMIT.maxAttempts,
      REGISTER_RATE_LIMIT.windowMs,
    );
    if (!rl.allowed) {
      reportSecurityEvent({
        type: "rate.limit.hit",
        ip,
        details: { scope: "per_ip", key: "register", count: rl.count },
        severity: "warning",
      });
      const retryAfterSec = Math.ceil((rl.retryAfter ?? 60_000) / 1000);
      return NextResponse.json(
        {
          error: "Too many sign-up attempts from this address. Try again later.",
        },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
      );
    }

    // ── Parse + validate body ─────────────────────────────────────────────
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid request body." },
        { status: 400 },
      );
    }

    const companyName = String(body.company_name ?? "").trim();
    const contactName = String(body.contact_name ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const phone = String(body.phone ?? "").trim();
    const password = String(body.password ?? "");
    const country = String(body.country ?? "").trim().toUpperCase();

    if (!companyName) {
      return NextResponse.json(
        { error: "Please enter your company name." },
        { status: 400 },
      );
    }
    if (!contactName) {
      return NextResponse.json(
        { error: "Please enter your name." },
        { status: 400 },
      );
    }
    if (!EMAIL_RE.test(email)) {
      return NextResponse.json(
        { error: "Please enter a valid work email." },
        { status: 400 },
      );
    }
    if (!country || country.length !== 2) {
      return NextResponse.json(
        { error: "Please select your country." },
        { status: 400 },
      );
    }

    // Reuse the platform-wide password policy so registration passwords meet
    // the same bar as every other password surface in the app.
    const pwValidation = await validatePasswordWithPlatformPolicy(password);
    if (!pwValidation.ok) {
      return NextResponse.json(
        { error: pwValidation.errors.join(" ") },
        { status: 400 },
      );
    }

    const store = await getStore();

    // ── Duplicate detection — username === email (lowercased) ──────────────
    // The User model only exposes getUserByUsername (no getUserByEmail), so
    // we set username = email for self-registered accounts and check
    // duplicates via that single lookup.
    const existing = await store.getUserByUsername(email);
    if (existing) {
      // Audit the duplicate attempt so the security pipeline sees
      // enumeration. Do NOT reveal "this email is already registered" to
      // the caller — return the same shape a successful registration would
      // so an attacker can't probe for valid emails.
      try {
        await store.appendAudit({
          user_id: null,
          username: email,
          action: "register.duplicate_email",
          entity_type: "auth",
          entity_id: null,
          details: { email, company_name: companyName },
          ip,
          user_agent: req.headers.get("user-agent") || null,
        });
      } catch {
        // non-critical
      }
      reportSecurityEvent({
        type: "login.failed",
        ip,
        details: { reason: "register_duplicate_email", email },
        severity: "info",
      });
      return NextResponse.json(
        {
          error:
            "An account with this email already exists. Please sign in instead.",
        },
        { status: 409 },
      );
    }

    // ── Create tenant (trial, +14 days) ───────────────────────────────────
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + TRIAL_DAYS);

    // Default currency: pick a sensible default from the country code so a
    // Serbian company doesn't land in USD. Keep it conservative — most
    // international trade happens in EUR / USD.
    const currency = country === "US" ? "USD" : "EUR";

    const tenant = await store.upsertTenant({
      name: companyName,
      legal_name: companyName,
      country,
      currency,
      plan: "trial",
      status: "trial",
      max_users: 5,
      trial_ends_at: trialEnd.toISOString(),
      trial_days: TRIAL_DAYS,
      email,
      phone: phone || null,
    } as any);

    // ── Create admin user (role: admin, active) ───────────────────────────
    // TRIAL tenants get a RESTRICTED permission set — NOT the `["*"]`
    // wildcard. The wildcard would make `isAdmin()` return true (giving
    // them access to vault/api-keys/webhooks/mail-queue/security/audit
    // surfaces they should not have on a trial plan) AND grant them
    // every non-platform permission via `canUser()`'s rule-2 bypass.
    // The list below covers full tenant CRUD for their own data
    // (partners, products, deals, invoices, documents, logistics, KYC
    // review of their own portal, document templates, ERP read, basic
    // marketplace + reports) but EXCLUDES the platform-dangerous
    // features reserved for paid plans or super_admin: vault, api-keys,
    // webhooks, mail-queue, security, audit, settings.write, users.write.
    // When the tenant upgrades to a paid plan, a super_admin can flip
    // their permissions to `["*"]` (or grant the specific additional
    // scopes) via the platform users panel.
    const TRIAL_ADMIN_PERMISSIONS = [
      "partners:read", "partners:write",
      "products:read", "products:write",
      "offers:read", "offers:write",
      "demands:read", "demands:write",
      "deals:read", "deals:write",
      "invoices:read", "invoices:write",
      "proformas:read", "proformas:write",
      "documents:read", "documents:write",
      "commissions:read",
      "inventory:read", "inventory:write",
      "logistics:read",
      "kyc:read",
      "portal:read",
      "portal.rfq_read",
      "portal-uploads:read",
      "document-templates:read", "document-templates:write",
      "erp:read",
      "marketplace:read", "marketplace:write",
      "reports:read",
    ];
    const passwordHash = await hashPassword(password);
    const user = await store.upsertUser({
      tenant_id: tenant.id,
      username: email,
      email,
      full_name: contactName,
      role: "admin",
      password_hash: passwordHash,
      active: true,
      permissions: TRIAL_ADMIN_PERMISSIONS,
      token_version: 1,
      totp_enabled: false,
      totp_secret: null,
      recovery_codes: null,
      must_change_password: false,
      failed_attempts: 0,
      locked_until: null,
    } as any);

    // ── Audit the new tenant + user creation ───────────────────────────────
    try {
      await store.appendAudit({
        user_id: user.id,
        username: user.username,
        tenant_id: tenant.id,
        action: "tenant.register",
        entity_type: "tenant",
        entity_id: tenant.id,
        details: {
          company_name: companyName,
          contact_name: contactName,
          email,
          country,
          plan: "trial",
          trial_ends_at: tenant.trial_ends_at,
        },
        ip,
        user_agent: req.headers.get("user-agent") || null,
      });
    } catch (e) {
      console.error("[register] appendAudit (tenant.register) failed:", e);
    }

    // ── Record initial login history ───────────────────────────────────────
    try {
      await store.updateUserLastLogin(user.id, ip);
    } catch (e) {
      console.error("[register] updateUserLastLogin failed:", e);
    }

    // ── Welcome email (best-effort — never block registration) ─────────────
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_BASE_URL || "";
    const loginUrl = baseUrl ? `${baseUrl}/` : "/";
    try {
      const { subject, html } = welcomeRegisterEmail({
        contactName,
        companyName,
        email,
        loginUrl,
      });
      // fire-and-forget — do not await. A failed email should not block the
      // signup response (the user can still sign in immediately).
      void sendEmail({
        to: email,
        subject,
        html,
        tenantId: tenant.id,
      }).catch((e) =>
        console.error("[register] welcome email failed:", e),
      );
    } catch (e) {
      console.error("[register] welcome email setup failed:", e);
    }

    // ── Create session + set cookie ───────────────────────────────────────
    const token = await createSession({
      sub: user.id,
      username: user.username,
      role: user.role,
      token_version: user.token_version,
      tenant_id: user.tenant_id,
    });
    await setSessionCookie(token);

    // strip sensitive fields before returning
    const {
      password_hash: _p,
      totp_secret: _t,
      recovery_codes: _r,
      ...safeUser
    } = user;
    void _p;
    void _t;
    void _r;

    return NextResponse.json({
      user: safeUser,
      tenant: { id: tenant.id, name: tenant.name, plan: tenant.plan, status: tenant.status, trial_ends_at: tenant.trial_ends_at },
    });
  } catch (e) {
    console.error("[register]", e);
    return NextResponse.json(
      { error: sanitizeError(e) || "Registration failed." },
      { status: 500 },
    );
  }
}
