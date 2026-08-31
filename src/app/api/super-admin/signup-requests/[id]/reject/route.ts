import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit } from "@/lib/api/helpers";
import { sendEmail } from "@/lib/email/service";
import { escapeHtml } from "@/lib/security/escape-html";

export const runtime = "nodejs";

/**
 * POST /api/super-admin/signup-requests/[id]/reject
 *
 * FEAT-1 (Trial approval system): rejects a pending signup request by
 * cascading the tenant + its admin user (and every dependent row
 * migrated by `deleteTenantCascade`). A rejection email is sent to
 * the requesting admin user BEFORE the cascade so the email address
 * is still resolvable. Best-effort — a transient mail provider
 * outage does NOT block the rejection (the tenant is still deleted;
 * the user just doesn't get the courtesy email).
 *
 * Status guard: only `pending_approval` tenants can be rejected.
 * Rejecting an already-active tenant would silently delete a
 * workspace with real data — that's a different operation
 * (`DELETE /api/tenants/[id]` with the countTenantDependencies confirm
 * gate) and not what this route is for.
 */

function rejectionEmail(opts: {
  contactName: string;
  companyName: string;
  loginUrl: string;
}): { subject: string; html: string } {
  const subject = `Your VELOS signup request was not approved`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
      <div style="background: #991b1b; color: white; padding: 30px; border-radius: 12px 12px 0 0;">
        <h1 style="margin: 0; font-size: 22px; font-weight: 600;">Signup request update</h1>
        <p style="margin: 8px 0 0; opacity: 0.9; font-size: 14px;">Your VELOS workspace request could not be approved</p>
      </div>
      <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <p style="color: #333; font-size: 15px; line-height: 1.6;">Hello ${escapeHtml(opts.contactName)},</p>
        <p style="color: #555; font-size: 14px; line-height: 1.6;">
          We're writing about your signup request for <strong>${escapeHtml(opts.companyName)}</strong>.
          After review, we were unable to approve your account at this time.
          If you believe this is in error, please contact the platform administrator
          who invited you, or reply to this email.
        </p>
        <p style="color: #888; font-size: 12px; line-height: 1.5; margin-top: 24px;">
          You're receiving this email because a VELOS signup request was submitted
          with this address.
        </p>
      </div>
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
      | { id: string; name: string; status: string; email: string | null }
      | null;

    if (!tenant) {
      return NextResponse.json({ error: "Signup request not found." }, { status: 404 });
    }

    // Status guard — only pending_approval tenants can be rejected.
    // Rejecting an already-active tenant would silently delete a
    // workspace with real data; that's a different operation
    // (`DELETE /api/tenants/[id]` with the countTenantDependencies
    // confirm gate).
    if (tenant.status !== "pending_approval") {
      return NextResponse.json(
        {
          error: `Cannot reject a signup request in status '${tenant.status}'.`,
        },
        { status: 409 },
      );
    }

    // ── Find the requesting admin user BEFORE deleting the tenant ─────
    // The cascade will wipe the users row, so resolve the email
    // address + contact name first.
    const tenantUsers = (await auth.store.listUsers("")).filter(
      (u) => u.tenant_id === tenant.id,
    );
    const adminUser = tenantUsers.find((u) => u.role === "admin") || tenantUsers[0];

    // ── Send rejection email (best-effort) BEFORE the cascade ─────────
    // The user's email is in the `users` row; once we delete the
    // tenant, the user row is gone too. Send the email now.
    if (adminUser?.email) {
      const baseUrl =
        process.env.NEXT_PUBLIC_APP_URL ||
        process.env.NEXT_PUBLIC_BASE_URL ||
        "";
      const loginUrl = baseUrl ? `${baseUrl}/` : "/";
      try {
        const { subject, html } = rejectionEmail({
          contactName: adminUser.full_name || adminUser.username,
          companyName: tenant.name,
          loginUrl,
        });
        // Fire-and-forget — a transient mail provider outage doesn't
        // block the rejection. The tenant is still deleted below.
        void sendEmail({
          to: adminUser.email,
          subject,
          html,
          // No tenantId — the tenant is about to be gone. The mail
          // queue will still record the row with tenant_id = NULL
          // (mail_queue is one of the nullable-tenant tables per the
          // SEC-AUDIT list).
        }).catch((e) =>
          console.error("[signup-requests.reject] rejection email failed:", e),
        );
      } catch (e) {
        console.error("[signup-requests.reject] rejection email setup failed:", e);
      }
    }

    // ── Cascade delete ─────────────────────────────────────────────────
    // `deleteTenantCascade` walks every dependent table in dependency
    // order (partners, products, deals, offers, invoices, documents,
    // sessions, feature_flags, etc.) and deletes the tenant row last.
    // For a freshly-registered pending_approval tenant the only real
    // dependent rows are the admin user + the feature_flags row
    // seeded by the register route — the cascade handles both.
    try {
      await auth.store.deleteTenantCascade(tenant.id);
    } catch (e) {
      console.error("[signup-requests.reject] deleteTenantCascade failed:", e);
      return NextResponse.json(
        { error: "Failed to delete the pending tenant. Please try again." },
        { status: 500 },
      );
    }

    // ── Audit ───────────────────────────────────────────────────────────
    try {
      await audit(
        auth.store,
        auth.user,
        req,
        "tenant.reject",
        "tenant",
        tenant.id,
        {
          company_name: tenant.name,
          contact_email: adminUser?.email || tenant.email || null,
          cascaded_delete: true,
        },
      );
    } catch (e) {
      console.error("[signup-requests.reject] audit failed:", e);
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[signup-requests.reject]", e);
    return NextResponse.json(
      { error: e?.message || "Internal server error" },
      { status: 500 },
    );
  }
}
