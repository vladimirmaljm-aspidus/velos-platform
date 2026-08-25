import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, getIp } from "@/lib/api/helpers";
import { sendEmail } from "@/lib/email/service";
import { notify } from "@/lib/notif/helper";

export const runtime = "nodejs";

const TRIAL_DAYS = 14;

/**
 * POST /api/super-admin/signup-requests/[id]/approve
 *
 * FEAT-1 (Trial approval system): flips a tenant from
 * `pending_approval` → `trial`, sets `trial_ends_at = now + 14 days`,
 * sends the welcome email to the requesting admin user, and posts an
 * in-app notification to that user announcing the approval.
 *
 * The 14-day trial clock starts NOW (not at signup time) so the user
 * gets the full trial window from the moment they actually gain
 * access. The welcome email reuses the same inline-styled body the
 * register route used to send pre-approval.
 *
 * Idempotency: if the tenant is already in `trial` (already approved),
 * the route returns 409 "Already approved" — it does NOT re-send the
 * email or extend the trial. Rejecting a request after approval
 * requires the reject route (which cascades the delete).
 *
 * This route does NOT issue a session cookie for the approved user —
 * they still have to log in via `/api/auth/login`. (The login flow
 * previously also created sessions; for an approved trial tenant the
 * status gate now passes and they get a regular session.)
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
          Your VELOS workspace for <strong>${escapeHtml(opts.companyName)}</strong> has been approved. You can now sign in with
          <a href="mailto:${escapeHtml(opts.email)}" style="color: #b45309;">${escapeHtml(opts.email)}</a> and the password you set at registration.
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
          You're receiving this email because your VELOS workspace request was approved.
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

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireSuperAdmin(req);
    if (auth instanceof NextResponse) return auth;

    const { id } = await params;
    const tenant = (await auth.store.getTenant(id)) as
      | { id: string; name: string; status: string; plan: string; country: string | null; email: string | null; phone: string | null; currency: string; created_at: string }
      | null;

    if (!tenant) {
      return NextResponse.json({ error: "Signup request not found." }, { status: 404 });
    }

    // Status guard — only pending_approval tenants can be approved.
    // Re-approving an already-active tenant would silently re-extend
    // the trial, which is dangerous (an admin could bump their own
    // trial indefinitely by re-hitting the route). 409 surfaces the
    // double-approval attempt to the reviewer.
    if (tenant.status !== "pending_approval") {
      return NextResponse.json(
        {
          error: `Cannot approve a signup request in status '${tenant.status}'.`,
        },
        { status: 409 },
      );
    }

    // ── Set trial_ends_at = now + 14 days + flip status to "trial" ──────
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + TRIAL_DAYS);

    const updated = await auth.store.upsertTenant({
      id: tenant.id,
      status: "trial",
      trial_ends_at: trialEnd.toISOString(),
      // Keep plan / max_users / currency / country as they were.
    } as any);

    // ── Find the requesting admin user (to send them the welcome email) ─
    const tenantUsers = (await auth.store.listUsers("")).filter(
      (u) => u.tenant_id === tenant.id,
    );
    const adminUser = tenantUsers.find((u) => u.role === "admin") || tenantUsers[0];

    if (adminUser) {
      // Record initial login history — moved here from the register
      // route (which no longer records it because the user can't log
      // in until approved). Best-effort.
      try {
        await auth.store.updateUserLastLogin(adminUser.id, getIp(req));
      } catch (e) {
        console.error("[signup-requests.approve] updateUserLastLogin failed:", e);
      }

      // ── Welcome email (best-effort — never block approval) ───────────
      const baseUrl =
        process.env.NEXT_PUBLIC_APP_URL ||
        process.env.NEXT_PUBLIC_BASE_URL ||
        "";
      const loginUrl = baseUrl ? `${baseUrl}/` : "/";
      try {
        const { subject, html } = welcomeRegisterEmail({
          contactName: adminUser.full_name || adminUser.username,
          companyName: tenant.name,
          email: adminUser.email,
          loginUrl,
        });
        // Fire-and-forget — a transient mail provider outage doesn't
        // block the approval response. The user can still log in
        // immediately (the tenant is now in "trial" status).
        void sendEmail({
          to: adminUser.email,
          subject,
          html,
          tenantId: tenant.id,
        }).catch((e) =>
          console.error("[signup-requests.approve] welcome email failed:", e),
        );
      } catch (e) {
        console.error("[signup-requests.approve] welcome email setup failed:", e);
      }

      // ── In-app notification to the approved user ─────────────────────
      // Tied to the now-active tenant_id; user_id points at the admin
      // so it shows up in their bell badge on first login. Best-effort.
      try {
        await notify({
          tenantId: tenant.id,
          userId: adminUser.id,
          type: "system_message",
          title: "Your account has been approved",
          message:
            `Your VELOS workspace "${tenant.name}" has been approved. ` +
            `Your 14-day trial ends on ${trialEnd.toLocaleDateString()}. ` +
            `Sign in to get started.`,
          entityType: "tenant",
          entityId: tenant.id,
          actionLabel: "Open VELOS",
        });
      } catch (e) {
        console.error("[signup-requests.approve] notify failed:", e);
      }
    }

    // ── Audit ───────────────────────────────────────────────────────────
    try {
      await audit(
        auth.store,
        auth.user,
        req,
        "tenant.approve",
        "tenant",
        tenant.id,
        {
          company_name: tenant.name,
          plan: updated.plan,
          trial_ends_at: updated.trial_ends_at,
        },
      );
    } catch (e) {
      console.error("[signup-requests.approve] audit failed:", e);
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[signup-requests.approve]", e);
    return NextResponse.json(
      { error: e?.message || "Internal server error" },
      { status: 500 },
    );
  }
}
